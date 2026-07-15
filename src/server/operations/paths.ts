import { join } from "node:path";

export function applicationRoot(environment: NodeJS.ProcessEnv): string {
  const localAppData = environment.LOCALAPPDATA;
  if (localAppData === undefined || localAppData.trim() === "") {
    throw new Error("LOCALAPPDATA не определён; локальные данные недоступны.");
  }
  return join(localAppData, "WebsiteChangeMonitor");
}
