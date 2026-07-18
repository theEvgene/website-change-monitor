import { spawn } from "node:child_process";
import { resolve } from "node:path";

import { applicationPaths, applicationRoot } from "./operations/paths.js";

const browsers = applicationPaths(applicationRoot(process.env)).browsers;
const cli = resolve(process.cwd(), "node_modules", "playwright", "cli.js");
const child = spawn(process.execPath, [cli, "install", "chromium"], {
  env: { ...process.env, PLAYWRIGHT_BROWSERS_PATH: browsers },
  stdio: "inherit",
  windowsHide: true,
});
child.once("error", (error) => { process.stderr.write(`${error.message}\n`); process.exitCode = 1; });
child.once("exit", (code) => { process.exitCode = code ?? 1; });
