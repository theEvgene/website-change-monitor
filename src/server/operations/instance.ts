export async function isWebsiteChangeMonitorAtPort(
  port: number,
): Promise<boolean> {
  try {
    const response = await fetch(`http://127.0.0.1:${port}/api/health`, {
      signal: AbortSignal.timeout(1500),
    });
    const body = (await response.json()) as { application?: string };
    return response.ok && body.application === "website-change-monitor";
  } catch {
    return false;
  }
}
