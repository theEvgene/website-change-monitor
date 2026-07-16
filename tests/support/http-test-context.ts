import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";

import { buildHttpServer } from "../../src/server/http/server.js";
import type { PageProbe } from "../../src/server/application/page-probe.js";
import {
  openApplicationDatabase,
  type ApplicationDatabase,
} from "../../src/server/persistence/database.js";

export function createHttpTestContext() {
  const roots: string[] = [];
  const databases: ApplicationDatabase[] = [];
  const servers: Array<ReturnType<typeof buildHttpServer>> = [];

  return {
    async applicationServer(
      options: number | { pageProbe?: PageProbe; port?: number } = 43117,
    ) {
      const port = typeof options === "number" ? options : (options.port ?? 43117);
      const root = await mkdtemp(join(tmpdir(), "website-change-monitor-"));
      roots.push(root);
      const database = openApplicationDatabase({ rootDirectory: root });
      databases.push(database);
      const server = buildHttpServer({
        database,
        version: "0.1.0",
        port,
        ...(typeof options === "number" || options.pageProbe === undefined
          ? {}
          : { pageProbe: options.pageProbe }),
      });
      servers.push(server);
      return server;
    },

    async cleanup() {
      for (const server of servers.splice(0)) {
        await server.close();
      }
      for (const database of databases.splice(0)) {
        database.close();
      }
      for (const root of roots.splice(0)) {
        await rm(root, { recursive: true, force: true });
      }
    },
  };
}
