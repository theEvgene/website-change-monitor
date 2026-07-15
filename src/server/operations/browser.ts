import { spawn } from "node:child_process";

export async function openInDefaultBrowser(url: string): Promise<void> {
  await new Promise<void>((resolve, reject) => {
    const child = spawn("explorer.exe", [url], {
      detached: true,
      stdio: "ignore",
      windowsHide: true,
    });
    child.once("error", reject);
    child.once("spawn", () => {
      child.unref();
      resolve();
    });
  });
}
