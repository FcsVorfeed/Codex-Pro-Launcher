import assert from "node:assert/strict";
import { readFile } from "node:fs/promises";
import vm from "node:vm";
import { buildInjectionModulePaths } from "../src/launcher/injection-manifest.mjs";

// 这一段读取真实模块；测试只替换动态 import 的宿主加载能力，不复制请求逻辑。
// Read production modules; replace only the host import mechanism instead of copying request logic.
const read = (path) => readFile(new URL(`../${path}`, import.meta.url), "utf8");
const fetchSource = (await read("src/inject/core/fetch-bridge.js")).replace("import(url)", "loadOfficialModule(url)");
const nativeSource = await read("src/inject/core/native-bridge.js");
const runtimeSource = await read("src/inject/core/runtime.js");
const cloudSource = await read("src/inject/systems/settings-menu/cloud-sync.js");
const cloudSectionSource = await read("src/inject/systems/settings-menu/sections/cloud-sync.js");

// 构造新版模块缓存宿主，验证真实发现逻辑及请求生命周期。
// Build a current module-cache host to exercise production discovery and request lifecycles.
function createHttpHarness({ failImport = false, delayImport = false, missingClient = false, ambiguous = false } = {}) {
  // 这一段使用无语义文件名和任意模块 ID，记录导入、单例访问、响应流释放与取消。
  // Use opaque filenames and arbitrary module IDs, recording imports, singleton access, stream disposal, and cancellation.
  const stats = { imports: 0, instances: 0, calls: 0, cancelled: 0, lastSignal: null, missingClient, ambiguous };
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
  // 这一段仅允许唯一符合官方接口的类获取实例，歧义类不能被调用。
  // Allow singleton access only for the unique official interface; ambiguous classes must never be invoked.
  class OfficialClient {
    static getInstance() { stats.instances += 1; return client; }
    fetch() {}
    fetchJson() {}
    cancelStream() {}
  }
  class OtherClient {
    static getInstance() { assert.fail("Ambiguous client invoked"); }
    fetch() {}
    fetchJson() {}
    cancelStream() {}
  }
  // 这些工厂只提供可观察特征；执行任何工厂或模块加载器都意味着错误初始化。
  // Factories provide observable signatures only; invoking a factory or loader would wrongly initialize modules.
  function httpFactory() { const signature = "fetchJson cancelStream getInstance"; assert.fail(signature); }
  function unrelatedFactory() { assert.fail("Unrelated factory invoked"); }
  function loader() { assert.fail("Module loader invoked"); }
  loader.m = { current: httpFactory, alias: httpFactory, uncached: httpFactory, unrelated: unrelatedFactory, failed: httpFactory, partial: httpFactory };
  loader.c = {
    current: { exports: { renamed: OfficialClient } },
    alias: { exports: { anotherName: OfficialClient } },
    unrelated: { get exports() { assert.fail("Unrelated exports inspected"); } },
    failed: { error: new Error("fixture"), get exports() { assert.fail("Failed module inspected"); } },
    partial: { exports: { unrelated: { getInstance() { assert.fail("Unrelated export invoked"); } } } },
  };
  const context = vm.createContext({
    window: { __codexProRuntime: runtime },
    document: { scripts: [
      { type: "module", src: "https://example.test/external.js" },
      { type: "text/javascript", src: "app://-/assets/classic.js" },
      { type: "module", src: "app://-/assets/101.changed.js" },
      { type: "module", src: "app://-/assets/202.changed.js" },
      { type: "module", src: "app://-/assets/202.changed.js" },
      { type: "module", src: "app://-/assets/303.changed.js" },
    ] },
    AbortController, AbortSignal, URL, console,
    loadOfficialModule: async (url) => {
      stats.imports += 1;
      assert.match(url, /^app:\/\/-\/assets\/(101|202|303)\.changed\.js$/);
      if (failImport) throw new Error("Module import unavailable");
      if (delayImport) return new Promise(() => {});
      if (url.endsWith("101.changed.js")) return { __webpack_modules__: { untouched: unrelatedFactory } };
      // 这一段模拟客户端尚未初始化和第二个匹配类；同一 loader 的重复导出不重复扫描。
      // Model an uninitialized client and a second matching class; repeated loader exports must not rescan it.
      loader.c.current.exports = stats.missingClient ? {} : { renamed: OfficialClient };
      loader.c.alias.exports = stats.missingClient ? {} : { anotherName: OfficialClient };
      if (stats.ambiguous) {
        loader.m.second = httpFactory;
        loader.c.second = { exports: { renamedAgain: OtherClient } };
      }
      return { __webpack_require__: loader };
    },
  });
  vm.runInContext(fetchSource, context);
  return { runtime, stats, context };
}

// 这一段验证并发发现、别名去重、JSON、响应释放及错误传播，执行实际生产发现代码。
// Exercise production discovery for concurrent calls, aliases, JSON, response disposal, and errors.
const http = createHttpHarness();
const responses = await Promise.all([http.runtime.fetchBridge.requestJson("/data"), http.runtime.fetchBridge.requestOk("/status")]);
assert.equal(responses[0].result, 42);
assert.equal(responses[1].status, 200);
assert.equal(http.stats.imports, 3);
assert.equal(http.stats.instances, 1);
assert.equal(http.stats.cancelled, 2);
await assert.rejects(http.runtime.fetchBridge.requestOk("/failure"), /HTTP 503/);
assert.equal(http.stats.imports, 3);
const pending = http.runtime.fetchBridge.requestOk("/pending");
await new Promise((resolve) => setTimeout(resolve, 0));
vm.runInContext(fetchSource, http.context);
await assert.rejects(pending, { name: "AbortError" });
assert.equal(http.stats.lastSignal.aborted, true);

// 这一段覆盖导入失败重试、未初始化客户端后续恢复，以及歧义时拒绝调用任一单例。
// Cover import retries, later initialization, and rejection of ambiguous singleton candidates.
const failed = createHttpHarness({ failImport: true });
await assert.rejects(failed.runtime.fetchBridge.requestOk("/data"), /import unavailable/);
await assert.rejects(failed.runtime.fetchBridge.requestOk("/data"), /import unavailable/);
assert.equal(failed.stats.imports, 2);
const missing = createHttpHarness({ missingClient: true });
await assert.rejects(missing.runtime.fetchBridge.requestOk("/data"), /client is unavailable/);
assert.equal(missing.stats.instances, 0);
missing.stats.missingClient = false;
assert.equal((await missing.runtime.fetchBridge.requestJson("/data")).result, 42);
assert.equal(missing.stats.imports, 6);
const ambiguous = createHttpHarness({ ambiguous: true });
await assert.rejects(ambiguous.runtime.fetchBridge.requestOk("/data"), /client is unavailable/);
assert.equal(ambiguous.stats.instances, 0);
assert.equal(ambiguous.stats.calls, 0);

// 这一段确认导入未完成时仍可超时和热注入取消，迟到模块不会启动 HTTP 请求。
// Ensure pending imports permit timeouts and reinjection cancellation without starting a late HTTP request.
const slow = createHttpHarness({ delayImport: true });
const keepAlive = setTimeout(() => {}, 1000);
await assert.rejects(slow.runtime.fetchBridge.requestOk("/data", { timeoutMs: 20 }), { name: "TimeoutError" });
slow.runtime.controllers["http-fetch"].abort();
clearTimeout(keepAlive);
const aborted = createHttpHarness({ delayImport: true });
const abortedRequest = aborted.runtime.fetchBridge.requestOk("/data");
aborted.runtime.controllers["http-fetch"].abort();
await assert.rejects(abortedRequest, { name: "AbortError" });
assert.equal(aborted.stats.calls, 0);

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
