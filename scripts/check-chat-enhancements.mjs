import assert from "node:assert/strict";
import { readFile } from "node:fs/promises";
import vm from "node:vm";
import { buildInjectionModulePaths } from "../src/launcher/injection-manifest.mjs";

// 这一段执行真实额度源，用可控时钟和请求覆盖共享订阅及迟到响应。
// Execute the real quota source with controlled timers and requests to cover shared subscriptions and late responses.
const source = await readFile(new URL("../src/inject/systems/usage-data/quota-source.js", import.meta.url), "utf8");
const requests = [];
const timers = new Map();
const settingsListeners = new Set();
let nextTimer = 0;
let seconds = 30;
let lifetime;
const runtime = {
  lifecycle: { replaceController: (_name, controller) => { lifetime?.abort(); lifetime = controller; } },
  systemModules: { settingsMenu: { settings: {
    getSettings: () => ({ usageRefreshSeconds: seconds }),
    subscribe: (listener) => { settingsListeners.add(listener); return () => settingsListeners.delete(listener); },
  } } },
  fetchBridge: { requestJson: (url, options) => new Promise((resolve, reject) => requests.push({ url, ...options, resolve, reject })) },
};
const context = vm.createContext({ AbortController, window: {
  __codexProRuntime: runtime,
  setTimeout: (callback, delay) => { timers.set(++nextTimer, { callback, delay }); return nextTimer; },
  clearTimeout: (id) => timers.delete(id),
} });
vm.runInContext(source, context);
const api = runtime.systemModules.usageData;
const panel = new AbortController();
const inline = new AbortController();
const panelValues = [];
const inlineValues = [];
api.subscribe((value) => panelValues.push(value), panel.signal);
api.subscribe((value) => inlineValues.push(value), inline.signal);
assert.equal(requests.length, 1, "two consumers share one request");
assert.equal(requests[0].url, "/wham/usage");
requests[0].resolve({ email: "redacted@example.invalid", rate_limit: { primary_window: {
  used_percent: 30, limit_window_seconds: 604800, reset_at: 123,
} } });
await new Promise(setImmediate);
assert.equal(api.weeklyRemaining(inlineValues.at(-1)).text, "70%");
assert.equal(panelValues.at(-1), inlineValues.at(-1));
assert.equal(JSON.stringify(inlineValues.at(-1)).includes("email"), false);
assert.equal(timers.size, 1);
panel.abort();
assert.equal(timers.size, 1, "inline keeps polling when panel is disabled");
seconds = 10;
for (const listener of settingsListeners) listener();
assert.equal([...timers.values()][0].delay, 10_000);
const tick = [...timers.values()][0];
timers.clear();
tick.callback();
assert.equal(requests.length, 2);
inline.abort();
assert.equal(requests[1].signal.aborted, true);
assert.equal(timers.size, 0);
assert.equal(settingsListeners.size, 0);
const restarted = new AbortController();
const values = [];
api.subscribe((value) => values.push(value), restarted.signal);
requests[1].resolve({ rate_limit: { primary_window: { used_percent: 99, limit_window_seconds: 604800 } } });
await new Promise(setImmediate);
assert.equal(values.length, 1, "late cancelled response never enters new subscription");
requests[2].reject(new Error("offline"));
await new Promise(setImmediate);
assert.equal(api.weeklyRemaining(values.at(-1)).text, "--%");

// 这一段覆盖窗口换位、缺失周窗口和未知数值，禁止误用五小时额度。
// Cover reordered windows, absent weeks and unknown values without substituting five-hour quota.
assert.equal(api.weeklyRemaining({ rate_limit: { primary_window: { used_percent: 9, limit_window_seconds: 18000 } } }).visible, false);
assert.equal(api.weeklyRemaining({ rate_limit: { secondary_window: { used_percent: 100, limit_window_seconds: 604800 } } }).text, "0%");
for (const used_percent of [null, undefined, "", NaN]) {
  assert.equal(api.weeklyRemaining({ rate_limit: { primary_window: { used_percent, limit_window_seconds: 604800 } } }).text, "--%");
}
vm.runInContext(source, context);
assert.equal(timers.size, 0, "reinjection stops old polling");
assert.equal(settingsListeners.size, 0);
restarted.abort();

// 这一段验证任一显示系统被硬屏蔽时仍有共享源，同时避免重复加载。
// Check that either display can be hard-disabled while retaining one shared source.
for (const disabled of [[], ["usage-panel"], ["context-usage-inline"]]) {
  const paths = buildInjectionModulePaths(disabled).map((parts) => parts.join("/"));
  assert.equal(paths.filter((path) => path.endsWith("usage-data/quota-source.js")).length, 1);
}
console.log("chat enhancement quota lifecycle checks passed");
