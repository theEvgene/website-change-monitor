import { lookup } from "node:dns/promises";
import { BlockList, isIP } from "node:net";

import type { NetworkAccess, NetworkTarget } from "./playwright-page-probe.js";
import { PageProbeAbort } from "./page-probe-abort.js";

export type HostLookup = (
  hostname: string,
  options: { all: true; verbatim: true },
) => Promise<Array<{ address: string; family: number }>>;

const blockedIpv4 = new BlockList();
for (const [network, prefix] of [
  ["0.0.0.0", 8],
  ["10.0.0.0", 8],
  ["100.64.0.0", 10],
  ["127.0.0.0", 8],
  ["169.254.0.0", 16],
  ["172.16.0.0", 12],
  ["192.0.0.0", 24],
  ["192.0.2.0", 24],
  ["192.88.99.0", 24],
  ["192.168.0.0", 16],
  ["198.18.0.0", 15],
  ["198.51.100.0", 24],
  ["203.0.113.0", 24],
  ["224.0.0.0", 4],
  ["240.0.0.0", 4],
] as const) {
  blockedIpv4.addSubnet(network, prefix, "ipv4");
}

const blockedIpv6 = new BlockList();
for (const [network, prefix] of [
  ["::", 128],
  ["::1", 128],
  ["::ffff:0:0", 96],
  ["64:ff9b::", 96],
  ["64:ff9b:1::", 48],
  ["100::", 64],
  ["100:0:0:1::", 64],
  ["2001::", 23],
  ["2001:db8::", 32],
  ["2002::", 16],
  ["3fff::", 20],
  ["5f00::", 16],
  ["fc00::", 7],
  ["fec0::", 10],
  ["fe80::", 10],
  ["ff00::", 8],
] as const) {
  blockedIpv6.addSubnet(network, prefix, "ipv6");
}

const publicIpv6 = new BlockList();
publicIpv6.addSubnet("2000::", 3, "ipv6");

export function createPublicNetworkAccess(
  hostLookup: HostLookup = lookup,
): NetworkAccess {
  return {
    async resolve(url) {
      validateNetworkUrl(url);
      const hostname = url.hostname.replace(/^\[|\]$/gu, "").toLowerCase();
      if (
        hostname === "localhost" ||
        hostname.endsWith(".localhost") ||
        hostname.endsWith(".local")
      ) {
        throw blockedAddress();
      }

      const literalFamily = isIP(hostname);
      const addresses =
        literalFamily === 0
          ? await resolveHostname(hostname, hostLookup)
          : [{ address: hostname, family: literalFamily }];
      if (
        addresses.length === 0 ||
        addresses.some(
          ({ address, family }) => !isPublicAddress(address, family),
        )
      ) {
        throw blockedAddress();
      }
      const first = addresses[0];
      if (first === undefined || (first.family !== 4 && first.family !== 6)) {
        throw blockedAddress();
      }
      return {
        address: first.address,
        family: first.family,
      } satisfies NetworkTarget;
    },
  };
}

export const publicNetworkAccess = createPublicNetworkAccess();

function validateNetworkUrl(url: URL): void {
  if (
    (url.protocol !== "http:" && url.protocol !== "https:") ||
    url.hostname === "" ||
    url.username !== "" ||
    url.password !== ""
  ) {
    throw new PageProbeAbort(
      "invalid_url",
      "Разрешены только HTTP(S) URL без встроенных учётных данных.",
    );
  }
}

async function resolveHostname(hostname: string, hostLookup: HostLookup) {
  try {
    return await hostLookup(hostname, { all: true, verbatim: true });
  } catch {
    throw new PageProbeAbort(
      "navigation_failed",
      "Не удалось определить сетевой адрес страницы.",
    );
  }
}

function isPublicAddress(address: string, family: number): boolean {
  if (family === 4) {
    return !blockedIpv4.check(address, "ipv4");
  }
  if (family === 6) {
    return (
      publicIpv6.check(address, "ipv6") && !blockedIpv6.check(address, "ipv6")
    );
  }
  return false;
}

function blockedAddress() {
  return new PageProbeAbort(
    "address_blocked",
    "Адрес страницы относится к запрещённой локальной или служебной сети.",
  );
}
