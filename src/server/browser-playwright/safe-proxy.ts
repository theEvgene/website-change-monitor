import {
  createServer,
  request as requestHttp,
  type OutgoingHttpHeaders,
} from "node:http";
import { connect, type LookupFunction, type Socket } from "node:net";

import type { NetworkAccess } from "./playwright-page-probe.js";

export interface SafeProxy {
  url: string;
  close(): Promise<void>;
}

export function destroyTrackedSocketOnError(socket: Socket): void {
  // Every tracked socket needs an error listener: an unhandled Socket error
  // terminates the Node.js process. Request-level failures are reported by the
  // upstream request/tunnel handlers; this listener owns socket cleanup only.
  socket.on("error", () => {
    socket.destroy();
  });
}

export async function startSafeProxy(
  networkAccess: NetworkAccess,
  onBlocked: (error: unknown) => void,
): Promise<SafeProxy> {
  const sockets = new Set<Socket>();
  let closed = false;
  const trackSocket = (socket: Socket) => {
    sockets.add(socket);
    destroyTrackedSocketOnError(socket);
    socket.once("close", () => sockets.delete(socket));
  };
  const server = createServer((incoming, outgoing) => {
    void (async () => {
      try {
        if (incoming.url === undefined) {
          throw new Error("Proxy request URL is missing");
        }
        const url = new URL(incoming.url);
        if (url.protocol !== "http:") {
          throw new Error("Only HTTP proxy requests are supported");
        }
        const target = await networkAccess.resolve(url);
        if (closed) {
          outgoing.destroy();
          return;
        }
        const headers: OutgoingHttpHeaders = {
          ...incoming.headers,
          host: url.host,
        };
        delete headers["proxy-connection"];
        const upstream = requestHttp(
          {
            protocol: "http:",
            hostname: url.hostname,
            port: url.port === "" ? 80 : Number(url.port),
            path: `${url.pathname}${url.search}`,
            method: incoming.method,
            headers,
            lookup: pinnedLookup(target),
          },
          (response) => {
            outgoing.writeHead(response.statusCode ?? 502, response.headers);
            response.pipe(outgoing);
          },
        );
        upstream.once("error", (error) => {
          onBlocked(error);
          if (!outgoing.headersSent) {
            outgoing.writeHead(502, { "content-type": "text/plain" });
          }
          outgoing.end("Blocked upstream request");
        });
        upstream.once("socket", trackSocket);
        incoming.pipe(upstream);
      } catch (error: unknown) {
        onBlocked(error);
        outgoing.writeHead(502, { "content-type": "text/plain" });
        outgoing.end("Blocked upstream request");
      }
    })();
  });

  server.on("connection", (socket) => {
    trackSocket(socket);
  });

  server.on("connect", (incoming, clientSocket, head) => {
    void (async () => {
      try {
        if (incoming.url === undefined) {
          throw new Error("Proxy tunnel target is missing");
        }
        const url = new URL(`https://${incoming.url}`);
        const target = await networkAccess.resolve(url);
        if (closed) {
          clientSocket.destroy();
          return;
        }
        const port = url.port === "" ? 443 : Number(url.port);
        const upstream = connect({
          host: target.address,
          port,
          family: target.family,
        });
        trackSocket(upstream);
        upstream.once("connect", () => {
          clientSocket.write("HTTP/1.1 200 Connection Established\r\n\r\n");
          if (head.length > 0) {
            upstream.write(head);
          }
          clientSocket.pipe(upstream);
          upstream.pipe(clientSocket);
        });
        upstream.once("error", (error) => {
          onBlocked(error);
          clientSocket.destroy();
        });
      } catch (error: unknown) {
        onBlocked(error);
        clientSocket.destroy();
      }
    })();
  });

  await new Promise<void>((resolve, reject) => {
    server.once("error", reject);
    server.listen(0, "127.0.0.1", resolve);
  });
  const address = server.address();
  if (address === null || typeof address === "string") {
    throw new Error("Unable to start the safe browser proxy");
  }

  return {
    url: `http://127.0.0.1:${address.port}`,
    async close() {
      closed = true;
      for (const socket of sockets) {
        socket.destroy();
      }
      await new Promise<void>((resolve, reject) => {
        server.close((error) =>
          error === undefined ? resolve() : reject(error),
        );
      });
    },
  };
}

function pinnedLookup(
  target: Awaited<ReturnType<NetworkAccess["resolve"]>>,
): LookupFunction {
  return (_hostname, options, callback) => {
    if (options.all === true) {
      callback(null, [{ address: target.address, family: target.family }]);
      return;
    }
    callback(null, target.address, target.family);
  };
}
