import assert from "node:assert/strict";
import { readFile } from "node:fs/promises";
import vm from "node:vm";
import { buildInjectionModulePaths } from "../src/launcher/injection-manifest.mjs";

// 这一段读取真实模块；测试只替换动态 import 的宿主加载能力，不复制请求逻辑。
// Read production modules; replace only the host import mechanism instead of copying request logic.
const read = (path) => readFile(new URL(`../${path}`, import.meta.url), "utf8");
const fetchSource = (await read("src/inject/core/fetch-bridge.js")).replace("await import(url)", "await loadOfficialModule(url)");
const nativeSource = await read("src/inject/core/native-bridge.js");
const runtimeSource = await read("src/inject/core/runtime.js");
const cloudSource = await read("src/inject/systems/settings-menu/cloud-sync.js");
const cloudSectionSource = await read("src/inject/systems/settings-menu/sections/cloud-sync.js");

// 构造官方请求客户端宿主，验证真实发现逻辑及请求生命周期。
// Build the official-client host to exercise production discovery and request lifecycles.
function createHttpHarness({ failDiscovery = false, delayDiscovery = false, legacyEntry = false } = {}) {
  // 这一段模拟改过 hash 和导出名的官方模块，记录发现次数、响应流释放和取消信号。
  // Simulate changed hashes and export names, recording discovery, stream disposal, and cancellation.
  const stats = { discoveries: 0, calls: 0, cancelled: 0, lastSignal: null, entrySource: legacyEntry ? 'import "./app-shared-old-hash.js";' : 'const deps = ["./app-shared-new-hash.js", "./other-app-initial-decoy.js", "./app-initial-new-hash.js"];' };
  const runtime = { controllers: {} };
  const client = {
    async fetch(url, options) {
      stats.calls += 1;
      stats.lastSignal = options.signal;
      if (url === "/pending") return new Promise((resolve, reject) => {
        options.signal.addEventListener("abort", () => reject(options.signal.reason), { once: true });
      });
      if (url === "/failure") throw new Error("HTTP 503");
      return {
        ok: true,
        status: 200,
        json: async () => ({ result: 42 }),
        body: { cancel: async () => { stats.cancelled += 1; } },
      };
    },
  };
  // 这一段只让符合官方接口的类被调用，其他导出若被误调用立即失败。
  // Permit only the class matching the official interface; unrelated exports fail if invoked.
  class OfficialClient {
    static getInstance() { return client; }
    fetch() {}
    fetchJson() {}
    cancelStream() {}
  }
  const context = vm.createContext({
    window: { __codexProRuntime: runtime },
    document: { scripts: [{ src: "app://-/assets/index-fixture-next.js" }] },
    AbortController, AbortSignal, URL, console,
    fetch: async (url, { signal }) => {
      stats.discoveries += 1;
      if (delayDiscovery) return new Promise((resolve, reject) => {
        signal.addEventListener("abort", () => reject(signal.reason), { once: true });
      });
      return { ok: !failDiscovery, text: async () => stats.entrySource };
    },
    loadOfficialModule: async (url) => {
      assert.equal(url, "app://-/assets/app-initial-new-hash.js");
      return { changedExportName: OfficialClient, unrelated: { getInstance() { throw new Error("Unrelated export invoked"); } } };
    },
  });
  vm.runInContext(fetchSource, context);
  return { runtime, stats, context };
}

// 这一段验证并发发现、JSON、无正文检测和错误传播，避免源码字符串检查掩盖协议失效。
// Exercise concurrent discovery, JSON, status-only checks, and errors instead of relying on source-string assertions.
const http = createHttpHarness();
const responses = await Promise.all([http.runtime.fetchBridge.requestJson("/data"), http.runtime.fetchBridge.requestOk("/status")]);
assert.equal(responses[0].result, 42);
assert.equal(responses[1].status, 200);
assert.equal(http.stats.discoveries, 1);
assert.equal(http.stats.cancelled, 2);
await assert.rejects(http.runtime.fetchBridge.requestOk("/failure"), /HTTP 503/);
const pending = http.runtime.fetchBridge.requestOk("/pending");
await new Promise((resolve) => setTimeout(resolve, 0));
vm.runInContext(fetchSource, http.context);
await assert.rejects(pending, { name: "AbortError" });
assert.equal(http.stats.lastSignal.aborted, true);
const failed = createHttpHarness({ failDiscovery: true });
await assert.rejects(failed.runtime.fetchBridge.requestOk("/data"), /entry is unavailable/);
await assert.rejects(failed.runtime.fetchBridge.requestOk("/data"), /entry is unavailable/);
assert.equal(failed.stats.discoveries, 2);
// 这一段拒绝旧版入口，并确认模块缺失后的下一次刷新能重新发现新版入口。
// Reject legacy entries and allow discovery to recover on the next refresh after a missing module.
const legacy = createHttpHarness({ legacyEntry: true });
await assert.rejects(legacy.runtime.fetchBridge.requestOk("/data"), /client is unavailable/);
assert.equal(legacy.stats.calls, 0);
legacy.stats.entrySource = 'import "./app-initial-new-hash.js";';
assert.equal((await legacy.runtime.fetchBridge.requestJson("/data")).result, 42);
assert.equal(legacy.stats.discoveries, 2);
const slow = createHttpHarness({ delayDiscovery: true });
// 这一段保留短期事件循环句柄，确保 Node 的非引用超时信号也能被验证。
// Keep a short event-loop handle alive so Node's unreferenced timeout signal can be tested.
const keepAlive = setTimeout(() => {}, 1000);
await assert.rejects(slow.runtime.fetchBridge.requestOk("/data", { timeoutMs: 20 }), { name: "TimeoutError" });
slow.runtime.controllers["http-fetch"].abort();
clearTimeout(keepAlive);

// 这一段使用真实运行时确认四个暂停系统不启动，并确认归档 helper 仍在加载清单中。
// Verify the real runtime prevents suspended systems from starting while retaining archive helpers in the bundle.
const window = new EventTarget();
Object.assign(window, { setTimeout, clearTimeout, setInterval, clearInterval });
const context = vm.createContext({ window, AbortController, console, crypto, CustomEvent });
vm.runInContext(runtimeSource, context);
const runtime = window.__codexProRuntime;
for (const name of ["startup-sidebar", "chat-line-hover", "conversation-archive", "conversation-archive-sidebar"]) {
  runtime.registerSystem(name, () => assert.fail(`${name} must not start`));
}
runtime.start();
const modules = buildInjectionModulePaths([]).map((parts) => parts.join("/"));
assert(modules.includes("src/inject/systems/conversation-archive/index.js"));
assert(!modules.some((path) => /systems\/(startup-sidebar|chat-line-hover)\//.test(path)));

// 这一段记录原生桥实际派发，证明远端同步被阻断而本地导出仍能收发。
// Record actual native-bridge dispatch to prove remote sync is blocked while local export still works.
const requests = [];
window.__codexProNativeBridgeConfig = { bridgeId: "fixture", bindingName: "nativeFixture", protocolVersion: 99 };
window.__codexProNativeBridgeStatus = { bridgeId: "fixture", updatedAt: Date.now() };
window.nativeFixture = (raw) => {
  const request = JSON.parse(raw);
  requests.push(request);
  queueMicrotask(() => window.dispatchEvent(new CustomEvent("codex-pro:native-bridge-response", {
    detail: { type: request.type, requestId: request.requestId, response: { ok: true } },
  })));
};
vm.runInContext(nativeSource, context);
const remoteParams = { endpoint: "https://sync.example.test", syncKey: "fixture-sync-key-01234567" };
assert.equal(await runtime.nativeBridge.requestCloudSync({ endpoint: remoteParams.endpoint, body: { action: "pull", syncKey: remoteParams.syncKey } }), null);
assert.equal(await runtime.nativeBridge.requestPetSync({ ...remoteParams, action: "pull" }), null);
for (const action of ["push", "list", "get-file", "prepare-file", "reset", "delete-device"]) {
  assert.equal(await runtime.nativeBridge.requestConversationArchive({ ...remoteParams, action }), null);
}
assert.equal(requests.length, 0);
assert.equal((await runtime.nativeBridge.requestConversationArchive({ action: "prepare-local-file", threadId: "fixture-thread" })).ok, true);
assert.equal(requests.length, 1);

// 这一段验证暂停分页不安装任何表单回调或授权心跳，并明确保留不可操作的原有表单。
// Verify the suspended page installs no form callbacks or license heartbeat and preserves its disabled form.
let oldHeartbeatAborted = false;
runtime.controllers["settings-menu-sync-license"] = { abort() { oldHeartbeatAborted = true; } };
runtime.i18n = Object.fromEntries(["t", "html", "attr", "escapeHtml"].map((name) => [name, (value) => value]));
let section;
runtime.lifecycle = { replaceController() { assert.fail("Suspended license controller restarted"); } };
runtime.systemModules.settingsMenu = {
  settings: { getSettings: () => ({ cloudSyncKey: remoteParams.syncKey, cloudSyncEndpoint: remoteParams.endpoint }), subscribe() { assert.fail("Suspended license watcher subscribed"); } },
  registerSection(value) { section = value; },
};
window.setInterval = () => assert.fail("Suspended license heartbeat started");
window.setTimeout = () => assert.fail("Suspended license validation started");
vm.runInContext(cloudSource, context);
assert(oldHeartbeatAborted);
assert.equal(runtime.systemModules.settingsMenu.cloudSync.getSyncLicenseGate("fixture").status, "suspended");
vm.runInContext(cloudSectionSource, context);
assert.match(section.render({ maxCloudSyncKeyLength: 160 }), /<fieldset disabled inert/);
section.bind(new Proxy({}, { get() { assert.fail("Suspended cloud page bound a callback"); } }));
console.log("current client compatibility checks passed");
