import { join } from "node:path";

export interface ApplicationPaths {
  root: string;
  data: string;
  backups: string;
  logs: string;
  browsers: string;
  database: string;
}

export function applicationRoot(environment: NodeJS.ProcessEnv): string {
  const localAppData = environment.LOCALAPPDATA;
  if (localAppData === undefined || localAppData.trim() === "") {
    throw new Error("LOCALAPPDATA не определён; локальные данные недоступны.");
  }
  return join(localAppData, "WebsiteChangeMonitor");
}

export function applicationPaths(root: string): ApplicationPaths {
  const data = join(root, "data");
  return {
    root,
    data,
    backups: join(root, "backups"),
    logs: join(root, "logs"),
    browsers: join(root, "browsers"),
    database: join(data, "website-change-monitor.sqlite3"),
  };
}
