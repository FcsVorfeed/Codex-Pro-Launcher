import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import vm from "node:vm";

const source = readFileSync(new URL("../src/inject/systems/usage-panel/usage-api.js", import.meta.url), "utf8");

// 这一段创建最小 DOM 节点替身，只暴露 usage-api 当前测试需要的结构化属性读取。
// Create a minimal DOM-node stand-in that exposes only the structured attribute reads needed by usage-api.
function createElement(attributes = {}) {
  return {
    attributes,
    getAttribute(name) {
      // 这一段模拟 DOM getAttribute 的空字符串兜底，避免测试依赖真实浏览器。
      // Simulate DOM getAttribute with an empty-string fallback so the test does not need a real browser.
      return this.attributes[name] ?? "";
    },
    querySelector() {
      // 这一段不提供子节点搜索，让测试只覆盖当前节点上的结构化数据。
      // Skip child searching so the test covers only structured data on the current node.
      return null;
    },
  };
}

// 这一段构造带 React fiber 私有指针的页面 host，用来模拟 Codex 当前线程 route scope。
// Build a page host with React's private fiber pointer to simulate Codex's current thread route scope.
function createRouteHost(threadId) {
  const host = createElement();
  const routeScope = {
    chain: [],
    get() {
      return this.value;
    },
    node: {},
    queryClient: {},
    set() {},
    value: {
      conversationId: threadId,
      routeKind: "local-thread",
    },
  };
  Object.defineProperty(host, "__reactFiber$routeScope", {
    configurable: true,
    value: {
      dependencies: null,
      memoizedProps: null,
      memoizedState: { routeScope },
      pendingProps: null,
      return: null,
      updateQueue: null,
    },
  });
  return host;
}

// 这一段构造一个没有 route scope 但 props 读取会失败的 host，验证隐私敏感 props 不会被触碰。
// Build a host without route scope whose props throw on read, proving privacy-sensitive props are not touched.
function createPropsTrapHost() {
  const host = createElement();
  const fiber = {
    dependencies: null,
    memoizedState: null,
    return: null,
    updateQueue: null,
  };
  Object.defineProperty(fiber, "memoizedProps", {
    configurable: true,
    get() {
      throw new Error("memoizedProps should not be read");
    },
  });
  Object.defineProperty(fiber, "pendingProps", {
    configurable: true,
    get() {
      throw new Error("pendingProps should not be read");
    },
  });
  Object.defineProperty(host, "__reactFiber$propsTrap", {
    configurable: true,
    value: fiber,
  });
  return host;
}

// 这一段构造 route scope 结构访问会抛错的 host，模拟 React 父链里遇到跨域 Window 等受保护对象。
// Build a host whose route-scope structure access throws, simulating protected objects such as cross-origin Windows in the React parent chain.
function createRouteScopeTrapHost() {
  const host = createElement();
  const routeScopeTrap = new Proxy({}, {
    get(target, property, receiver) {
      // 这一段模拟 route scope 结构属性受保护，验证初始结构探测处于安全边界内。
      // Simulate a protected route-scope property so the initial structure probe stays inside a safety boundary.
      if (property === "get") throw new Error("route scope properties should be read inside a safety boundary");
      return Reflect.get(target, property, receiver);
    },
    getPrototypeOf() {
      // 这一段模拟 instanceof 触发的受保护原型读取，验证扫描会继续到页面骨架。
      // Simulate protected prototype access from instanceof so scanning must continue to the page shell.
      throw new Error("route scope prototype should be read inside a safety boundary");
    },
    ownKeys() {
      // 这一段模拟 Object.keys 触发的受保护键读取，验证扫描会跳过当前对象。
      // Simulate protected key enumeration from Object.keys so scanning must skip the current object.
      throw new Error("route scope keys should be read inside a safety boundary");
    },
  });
  Object.defineProperty(host, "__reactFiber$routeScopeTrap", {
    configurable: true,
    value: {
      dependencies: null,
      memoizedProps: null,
      memoizedState: { routeScopeTrap },
      pendingProps: null,
      return: null,
      updateQueue: null,
    },
  });
  return host;
}

// 这一段构造 instanceof Map 成功但迭代器读取失败的 host，单独覆盖代理 Map 的迭代安全边界。
// Build a host that passes instanceof Map but fails iterator access, covering the proxied-Map iteration boundary independently.
function createMapIterationTrapHost() {
  const host = createElement();
  const mapIterationTrap = new Proxy(new Map(), {
    get(target, property, receiver) {
      // 这一段只阻断 Map 迭代器，其它结构读取保持正常，让测试准确进入 Map 迭代分支。
      // Block only the Map iterator while keeping other structure reads normal so the test reaches the Map iteration branch.
      if (property === Symbol.iterator) throw new Error("map iteration should be read inside a safety boundary");
      return Reflect.get(target, property, receiver);
    },
  });
  Object.defineProperty(host, "__reactFiber$mapIterationTrap", {
    configurable: true,
    value: {
      dependencies: null,
      memoizedProps: null,
      memoizedState: { mapIterationTrap },
      pendingProps: null,
      return: null,
      updateQueue: null,
    },
  });
  return host;
}

// 这一段在隔离 VM 中加载 usage-api，并用可控 document/window 模拟侧栏和 route scope 场景。
// Load usage-api in an isolated VM and simulate sidebar plus route-scope scenarios with controlled document/window objects.
function loadUsageApi({
  anchorMapIterationTrap = false,
  anchorPropsTrap = false,
  anchorRouteScopeTrap = false,
  anchorRouteThreadId = "",
  fallbackRouteThreadId = "",
  sidebarRows = [],
} = {}) {
  const anchorHosts = anchorRouteThreadId ? [createRouteHost(anchorRouteThreadId)] : [];
  if (anchorMapIterationTrap) anchorHosts.push(createMapIterationTrapHost());
  if (anchorPropsTrap) anchorHosts.push(createPropsTrapHost());
  if (anchorRouteScopeTrap) anchorHosts.push(createRouteScopeTrapHost());
  const fallbackHosts = fallbackRouteThreadId ? [createRouteHost(fallbackRouteThreadId)] : [];
  const context = {
    console,
    document: {
      querySelectorAll(selector) {
        // 这一段按 usage-api 的选择器返回对应测试节点，避免引入完整 DOM 实现。
        // Return nodes by usage-api selector without pulling in a full DOM implementation.
        if (selector === "[data-app-action-sidebar-thread-id]") return sidebarRows;
        if ([
          '[data-testid="app-shell-header-context-menu-surface"]',
          "header[data-app-shell-header-edge-scroll]",
          "header",
        ].includes(selector)) {
          return anchorHosts;
        }
        if (["main", "#root"].includes(selector)) return fallbackHosts;
        return [];
      },
    },
    Map,
    Object,
    Set,
    URL,
    WeakSet,
    window: {
      __codexProRuntime: {
        fetchBridge: {
          requestJson() {
            // 这一段提供额度接口占位；当前测试只验证当前线程 token 缓存读取。
            // Provide a quota endpoint placeholder while this test focuses on current-thread token cache reads.
            return Promise.resolve({});
          },
        },
        systemModules: {},
      },
      location: {
        hash: "",
        href: "app://-/index.html",
        pathname: "/index.html",
        search: "",
      },
      removeEventListener() {},
      addEventListener() {},
      requestAnimationFrame(callback) {
        // 这一段同步执行动画帧回调，让线程切换监听测试保持确定性。
        // Run animation-frame callbacks synchronously so thread-change observer tests stay deterministic.
        callback();
        return 1;
      },
      cancelAnimationFrame() {},
    },
  };
  vm.runInNewContext(source, context, { filename: "usage-api.js" });
  return context.window.__codexProRuntime.systemModules.usagePanel;
}

// 这一段直接写入标准化后的 token 快照，验证 readConversationTokenUsage 的线程选择结果。
// Write a normalized token snapshot directly to verify which thread readConversationTokenUsage selects.
function rememberTokenUsage(usagePanel, threadId, outputTokens) {
  usagePanel.conversationTokenUsageByThreadId.set(threadId, {
    total: {
      cachedInputTokens: 0,
      inputTokens: 1,
      outputTokens,
      reasoningOutputTokens: 0,
      totalTokens: outputTokens + 1,
    },
  });
}

const routeOnlyUsagePanel = loadUsageApi({ anchorRouteThreadId: "thread-route-1234" });
rememberTokenUsage(routeOnlyUsagePanel, "thread-route-1234", 42);
assert.equal(
  routeOnlyUsagePanel.api.readConversationTokenUsage()?.total.outputTokens,
  42,
  "usage panel should read token cache through the top-left route-scope anchor when sidebar rows are unavailable",
);

const anchorPriorityUsagePanel = loadUsageApi({
  anchorRouteThreadId: "thread-anchor-1234",
  fallbackRouteThreadId: "thread-fallback-1234",
});
rememberTokenUsage(anchorPriorityUsagePanel, "thread-anchor-1234", 43);
rememberTokenUsage(anchorPriorityUsagePanel, "thread-fallback-1234", 44);
assert.equal(
  anchorPriorityUsagePanel.api.readConversationTokenUsage()?.total.outputTokens,
  43,
  "usage panel should prefer the top-left route-scope anchor over broad page-shell fallbacks",
);

const fallbackUsagePanel = loadUsageApi({ fallbackRouteThreadId: "thread-fallback-1234" });
rememberTokenUsage(fallbackUsagePanel, "thread-fallback-1234", 44);
assert.equal(
  fallbackUsagePanel.api.readConversationTokenUsage()?.total.outputTokens,
  44,
  "usage panel should keep a page-shell route-scope fallback when the top-left anchor is unavailable",
);

const propsSafeUsagePanel = loadUsageApi({
  anchorPropsTrap: true,
  fallbackRouteThreadId: "thread-fallback-1234",
});
rememberTokenUsage(propsSafeUsagePanel, "thread-fallback-1234", 45);
assert.equal(
  propsSafeUsagePanel.api.readConversationTokenUsage()?.total.outputTokens,
  45,
  "usage panel should not read React props while probing header anchors",
);

const routeScopeTrapUsagePanel = loadUsageApi({
  anchorRouteScopeTrap: true,
  fallbackRouteThreadId: "thread-fallback-1234",
});
rememberTokenUsage(routeScopeTrapUsagePanel, "thread-fallback-1234", 46);
assert.equal(
  routeScopeTrapUsagePanel.api.readConversationTokenUsage()?.total.outputTokens,
  46,
  "usage panel should skip protected route-scope objects and continue to the page-shell fallback",
);

const mapIterationTrapUsagePanel = loadUsageApi({
  anchorMapIterationTrap: true,
  fallbackRouteThreadId: "thread-fallback-1234",
});
rememberTokenUsage(mapIterationTrapUsagePanel, "thread-fallback-1234", 48);
assert.equal(
  mapIterationTrapUsagePanel.api.readConversationTokenUsage()?.total.outputTokens,
  48,
  "usage panel should skip a proxied Map with a failing iterator and continue to the page-shell fallback",
);

const sidebarRow = createElement({
  "aria-current": "page",
  "data-app-action-sidebar-thread-id": "remote:thread-sidebar-1234",
});
const sidebarPriorityUsagePanel = loadUsageApi({
  anchorRouteThreadId: "thread-route-1234",
  sidebarRows: [sidebarRow],
});
rememberTokenUsage(sidebarPriorityUsagePanel, "thread-route-1234", 42);
rememberTokenUsage(sidebarPriorityUsagePanel, "thread-sidebar-1234", 99);
assert.equal(
  sidebarPriorityUsagePanel.api.readConversationTokenUsage()?.total.outputTokens,
  99,
  "usage panel should keep the highlighted structured sidebar id as the first current-thread source",
);

const provisionalSidebarRow = createElement({
  "aria-current": "page",
  "data-app-action-sidebar-thread-id": "local:client-new-thread:temporary-1234",
});
const provisionalSidebarUsagePanel = loadUsageApi({
  anchorRouteThreadId: "thread-route-1234",
  sidebarRows: [provisionalSidebarRow],
});
rememberTokenUsage(provisionalSidebarUsagePanel, "client-new-thread:temporary-1234", 100);
rememberTokenUsage(provisionalSidebarUsagePanel, "thread-route-1234", 47);
assert.equal(
  provisionalSidebarUsagePanel.api.readConversationTokenUsage()?.total.outputTokens,
  47,
  "usage panel should ignore a provisional client-new-thread sidebar id and read the canonical route-scope cache",
);

assert.match(
  source,
  /sidebarThreadId\(\) \|\| routeScopeThreadIdFromPage\(\) \|\| locationThreadId\(\)/u,
  "current-thread fallback order should remain sidebar, route scope, URL",
);

assert.match(
  source,
  /routeScopeThreadIdFromSelectors\(routeScopeAnchorSelectors, routeScopeAnchorHostLimit\) \|\|\s*routeScopeThreadIdFromSelectors\(routeScopeFallbackSelectors, routeScopeFallbackHostLimit\)/u,
  "route-scope lookup should prefer the top-left header anchor before broad page-shell hosts",
);

console.log("usage panel route-scope current-thread checks passed");
