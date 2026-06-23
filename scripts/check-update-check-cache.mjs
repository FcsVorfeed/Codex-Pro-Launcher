import { readFile } from "node:fs/promises";
import path from "node:path";
import vm from "node:vm";

const rootDir = path.resolve(import.meta.dirname, "..");
const updateCheckPath = path.join(rootDir, "src", "inject", "systems", "update-check", "index.js");

function assert(condition, message) {
  // 这一段用明确错误终止检查，方便定位更新缓存回归。
  // Fail with explicit errors so update-cache regressions are easy to locate.
  if (!condition) throw new Error(message);
}

function createFakeWindow(cachedValue) {
  // 这一段构造 update-check 需要的最小浏览器环境，避免测试依赖真实 Codex 页面。
  // Build the minimal browser environment needed by update-check without depending on a real Codex page.
  const storage = new Map();
  if (cachedValue) storage.set("codex-pro:update-check", JSON.stringify(cachedValue));
  let requestCount = 0;
  const fakeWindow = {
    CustomEvent: class CustomEvent {
      // 这一段保留事件 detail，供状态通知路径正常执行。
      // Keep event details so the status notification path can run normally.
      constructor(name, options = {}) {
        this.name = name;
        this.detail = options.detail;
      }
    },
    __codexProRuntime: {
      i18n: { t: (key) => key },
      lifecycle: {
        replaceController() {},
      },
      nativeBridge: {
        supportsUpdateCheck: () => true,
        requestUpdateCheck: async () => {
          requestCount += 1;
          return {
            data: {
              checkedAt: "2026-06-24T00:10:00.000Z",
              currentVersion: "1.0.2",
              latestVersion: "1.0.2",
              updateAvailable: false,
            },
            ok: true,
          };
        },
      },
      registerSystem(name, start) {
        this.registeredSystem = { name, start };
      },
      systemModules: {
        settingsMenu: {
          view: {
            setUpdateCheckState() {},
          },
        },
      },
      version: "1.0.2",
    },
    dispatchEvent() {},
    localStorage: {
      getItem(key) {
        return storage.get(key) || null;
      },
      setItem(key, value) {
        storage.set(key, value);
      },
    },
    setInterval() {
      return 1;
    },
    setTimeout(callback) {
      callback();
      return 1;
    },
    clearInterval() {},
    clearTimeout() {},
  };
  fakeWindow.getUpdateCheckRequestCount = () => requestCount;
  return fakeWindow;
}

async function runUpdateCheckModule(cachedValue) {
  // 这一段在 VM 中执行真实注入模块，验证缓存策略本身而不是字符串探针。
  // Execute the real injected module in a VM so the cache strategy is behavior-tested, not string-tested.
  const source = await readFile(updateCheckPath, "utf8");
  const fakeWindow = createFakeWindow(cachedValue);
  const context = vm.createContext({
    AbortController,
    CustomEvent: fakeWindow.CustomEvent,
    URL,
    console,
    window: fakeWindow,
  });
  vm.runInContext(source, context, { filename: updateCheckPath });
  fakeWindow.__codexProRuntime.registeredSystem.start();
  await Promise.resolve();
  return {
    requestCount: fakeWindow.getUpdateCheckRequestCount(),
    state: fakeWindow.__codexProRuntime.systemModules.updateCheck.getState(),
  };
}

const staleCachedState = {
  checkedAt: new Date().toISOString(),
  currentVersion: "1.0.1",
  latestVersion: "1.0.2",
  updateAvailable: true,
};
const refreshedResult = await runUpdateCheckModule(staleCachedState);

assert(
  refreshedResult.requestCount === 1,
  "stale version cache must trigger a refresh request",
);
assert(
  refreshedResult.state.currentVersion === "1.0.2",
  "stale cache must refresh to the current runtime version",
);
assert(
  refreshedResult.state.updateAvailable === false,
  "stale cache must not keep an old available-update badge lit",
);

const missingVersionCachedState = {
  checkedAt: new Date().toISOString(),
  latestVersion: "1.0.2",
  updateAvailable: true,
};
const missingVersionResult = await runUpdateCheckModule(missingVersionCachedState);

assert(
  missingVersionResult.requestCount === 1,
  "cache without currentVersion must trigger a refresh request",
);
assert(
  missingVersionResult.state.updateAvailable === false,
  "cache without currentVersion must not keep an old available-update badge lit",
);

const freshCachedState = {
  checkedAt: new Date().toISOString(),
  currentVersion: "1.0.2",
  latestVersion: "1.0.2",
  updateAvailable: false,
};
const freshResult = await runUpdateCheckModule(freshCachedState);

assert(
  freshResult.requestCount === 0,
  "fresh same-version cache must not trigger a startup refresh request",
);
assert(
  freshResult.state.currentVersion === "1.0.2",
  "fresh same-version cache must keep the current runtime version",
);

console.log("update-check cache invalidation checks passed");
