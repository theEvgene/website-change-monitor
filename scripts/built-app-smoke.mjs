import { spawn } from "node:child_process";

const base = "http://127.0.0.1:43117";
const environment = {
  ...process.env,
  WEBSITE_CHANGE_MONITOR_SKIP_OPEN_BROWSER: "1",
  WEBSITE_CHANGE_MONITOR_SMOKE_CONTROL: "1",
};
const application = spawn(process.execPath, ["dist/server/cli.js", "start"], {
  env: environment,
  stdio: ["pipe", "pipe", "pipe"],
  windowsHide: true,
});
let output = "";
application.stdout.setEncoding("utf8"); application.stderr.setEncoding("utf8");
application.stdout.on("data", (chunk) => { output += chunk; });
application.stderr.on("data", (chunk) => { output += chunk; });

try {
  await waitForHealth();
  const second = await runSecondStart();
  assert(second.code === 0 && second.output.includes("уже работает"), "Повторный start не распознал работающий экземпляр.");
  const openapi = await request("/openapi.json");
  assert(openapi.openapi === "3.1.0", "OpenAPI 3.1 недоступен.");
  const url = "https://example.com/";
  const preview = await request("/api/preview", {
    method: "POST",
    body: JSON.stringify({ url, targetSelectors: ["body"], exclusionSelectors: [] }),
  });
  assert(preview.targetCount >= 1, "Preview не нашёл body.");
  const monitor = await request("/api/monitors", {
    method: "POST",
    body: JSON.stringify({ name: `Release smoke ${Date.now()}`, url, targetSelectors: ["body"], exclusionSelectors: [], intervalHours: 6 }),
  });
  assert(monitor.history?.[0]?.result === "baseline", "Не создан Базовый снимок.");
  const checked = await request(`/api/monitors/${monitor.id}/checks`, { method: "POST", body: "{}" });
  const latest = checked.history?.[0];
  assert(latest?.result === "no_change" || latest?.result === "change", "Ручная проверка не завершилась.");
  await request("/api/checks");
  await request(`/api/checks/${latest.id}/comparison`);
  await request("/api/telegram");
  await request("/api/settings/notifications", {
    method: "PUT",
    body: JSON.stringify({ notifyWhenUnchanged: true }),
  });
  process.stdout.write("Built-app API smoke завершён.\n");
} finally {
  application.stdin.end("shutdown\n");
  const code = await waitForExit(application, 15_000);
  assert(code === 0 && output.includes("остановлен"), `Приложение не завершилось штатно: ${output}`);
}

async function waitForHealth() {
  const deadline = Date.now() + 30_000;
  while (Date.now() < deadline) {
    try { await request("/api/health"); return; } catch { await delay(250); }
  }
  throw new Error(`Приложение не запустилось: ${output}`);
}

async function runSecondStart() {
  const child = spawn(process.execPath, ["dist/server/cli.js", "start"], { env: environment, stdio: ["ignore", "pipe", "pipe"], windowsHide: true });
  let text = "";
  child.stdout.setEncoding("utf8"); child.stderr.setEncoding("utf8");
  child.stdout.on("data", (chunk) => { text += chunk; }); child.stderr.on("data", (chunk) => { text += chunk; });
  return { code: await waitForExit(child, 15_000), output: text };
}

async function request(path, init = {}) {
  const response = await fetch(`${base}${path}`, { ...init, headers: { "content-type": "application/json", ...(init.headers ?? {}) }, signal: AbortSignal.timeout(70_000) });
  const body = await response.text();
  if (!response.ok) throw new Error(`${path}: HTTP ${response.status} ${body}`);
  return body === "" ? undefined : JSON.parse(body);
}

function waitForExit(child, timeout) {
  return Promise.race([
    new Promise((resolve, reject) => { child.once("error", reject); child.once("exit", (code) => resolve(code ?? 1)); }),
    delay(timeout).then(() => { child.kill(); throw new Error("Процесс не завершился вовремя."); }),
  ]);
}
function delay(ms) { return new Promise((resolve) => setTimeout(resolve, ms)); }
function assert(condition, message) { if (!condition) throw new Error(message); }
