(() => {
  const runtime = window.__codexProRuntime;
  if (!runtime) return;
  const usagePanel = runtime.systemModules.usagePanel ??= {};
  const conversationTokenUsageByThreadId = usagePanel.conversationTokenUsageByThreadId ??= new Map();
  const maxConversationTokenUsageEntries = 120;
  const sidebarThreadSelector = "[data-app-action-sidebar-thread-id]";
  const routeScopeAnchorSelectors = [
    '[data-testid="app-shell-header-context-menu-surface"]',
    "header[data-app-shell-header-edge-scroll]",
    "header",
  ];
  const routeScopeFallbackSelectors = ["main", "#root"];
  const routeScopeFiberDepth = 80;
  const routeScopeObjectDepth = 5;
  const routeScopeObjectKeys = 40;
  const routeScopeAnchorHostLimit = 4;
  const routeScopeFallbackHostLimit = 2;
  const defaultStatusPingEndpoint = "https://status.openai.com/api/v2/status.json";
  const resetCreditsEndpoint = "/wham/rate-limit-reset-credits";
  const statusPingTimeoutMs = 4500;
  const todayTokenSources = new Set(["hidden", "observer", "official"]);

  function isLocalHttpPingUrl(url) {
    // 这一段只允许本机 HTTP 作为调试目标，避免把明文远端地址作为网络检测目标。
    // Allow HTTP only for local debug targets so remote latency checks do not use cleartext URLs.
    const hostname = url.hostname.toLowerCase();
    return url.protocol === "http:" && ["127.0.0.1", "::1", "[::1]", "localhost"].includes(hostname);
  }

  function normalizeStatusPingEndpoint(value) {
    // 这一段对设置值做执行前兜底校验，防止异常配置把 Ping 请求发到不受控协议。
    // Re-validate the setting before execution so malformed config cannot request uncontrolled protocols.
    const rawValue = typeof value === "string" ? value.trim() : "";
    if (!rawValue) return defaultStatusPingEndpoint;
    try {
      const url = new URL(rawValue);
      url.hash = "";
      if (url.protocol !== "https:" && !isLocalHttpPingUrl(url)) return defaultStatusPingEndpoint;
      return url.href;
    } catch {
      return defaultStatusPingEndpoint;
    }
  }

  function withPingCacheBuster(endpoint) {
    // 这一段给检测地址追加短缓存参数，保留用户原本的查询参数。
    // Add a small cache-busting parameter while preserving the user's existing query string.
    const separator = endpoint.includes("?") ? "&" : "?";
    return `${endpoint}${separator}codexProPing=${Date.now()}`;
  }

  function padDatePart(value) {
    // 这一段把本地日期片段补齐为两位，供 profile bucket 和本机日志按同一日期匹配。
    // Pad local date parts to two digits so profile buckets and local logs match the same date.
    return String(value).padStart(2, "0");
  }

  function getTodayWindow() {
    // 这一段计算本地 Today 的日期和 UTC 时间窗，observer 只接收这个受控窗口。
    // Compute the local Today date and UTC window; observer receives only this constrained window.
    const now = new Date();
    const start = new Date(now.getFullYear(), now.getMonth(), now.getDate());
    const end = new Date(now.getFullYear(), now.getMonth(), now.getDate() + 1);
    return {
      date: `${start.getFullYear()}-${padDatePart(start.getMonth() + 1)}-${padDatePart(start.getDate())}`,
      endIso: end.toISOString(),
      endMs: end.getTime(),
      startIso: start.toISOString(),
      startMs: start.getTime(),
    };
  }

  function fetchUsage(signal) {
    // 这一段只封装用量系统需要的内部接口，避免业务代码直接关心 fetch bridge 细节。
    // Wrap only the internal endpoint needed by the usage system so feature code stays focused.
    return runtime.fetchBridge.requestJson("/wham/usage", { signal });
  }

  function normalizeResetCreditExpiresAt(value) {
    // 这一段只接受可解析的过期时间，并统一成 ISO 字符串供展示层格式化。
    // Accept only parseable expiry values and normalize them to ISO strings for the display layer.
    const rawValue = typeof value === "string" ? value.trim() : "";
    if (!rawValue) return "";
    const expiresAt = new Date(rawValue);
    return Number.isNaN(expiresAt.getTime()) ? "" : expiresAt.toISOString();
  }

  function fetchResetCredits(signal) {
    // 这一段只调用只读 GET 端点，并只返回面板展示需要的安全字段。
    // Call only the read-only GET endpoint and return only safe fields needed by the panel.
    return runtime.fetchBridge.requestJson(resetCreditsEndpoint, { method: "GET", signal }).then((payload) => {
      const availableCount = finiteTokenCount(payload?.available_count ?? payload?.availableCount);
      const credits = Array.isArray(payload?.credits) ? payload.credits : [];
      const expiresAtList = credits
        .map((credit) => normalizeResetCreditExpiresAt(credit?.expires_at ?? credit?.expiresAt))
        .filter(Boolean)
        .sort();
      return {
        available: availableCount != null,
        availableCount,
        nearestExpiresAt: expiresAtList[0] || "",
      };
    });
  }

  function fetchStatusPing(endpoint, signal) {
    // 这一段请求用户配置的受控 HTTP(S) 地址，只把请求成功的往返耗时作为 Ping 读数。
    // Request the configured controlled HTTP(S) endpoint and use only successful round-trip time as the Ping reading.
    const pingEndpoint = normalizeStatusPingEndpoint(endpoint);
    const startedAt = performance.now();
    const requestUrl = withPingCacheBuster(pingEndpoint);
    const requestPing = typeof runtime.fetchBridge.requestOk === "function"
      ? runtime.fetchBridge.requestOk
      : runtime.fetchBridge.requestJson;
    return requestPing(requestUrl, { signal, timeoutMs: statusPingTimeoutMs })
      .then(() => ({
        endpoint: pingEndpoint,
        latencyMs: Math.max(0, Math.round(performance.now() - startedAt)),
      }));
  }

  function fetchOfficialTodayTokenUsage(signal) {
    // 这一段读取官方 profile daily bucket；今日未同步时返回空值，不用其它日期冒充 Today。
    // Read the official profile daily bucket; when today is not synced, return empty instead of substituting another day.
    const windowInfo = getTodayWindow();
    return runtime.fetchBridge.requestJson("/wham/profiles/me", { signal }).then((profile) => {
      const buckets = Array.isArray(profile?.stats?.daily_usage_buckets)
        ? profile.stats.daily_usage_buckets
        : [];
      const bucket = buckets.find((item) => String(item?.start_date || "").trim() === windowInfo.date);
      return {
        available: bucket != null,
        date: windowInfo.date,
        source: "official",
        totalTokens: finiteTokenCount(bucket?.tokens),
      };
    });
  }

  function fetchObserverTodayTokenUsage() {
    // 这一段请求 native bridge 聚合本机 token_count，只返回数值诊断，不读取正文到页面。
    // Ask native bridge to aggregate local token_count data and return only numeric diagnostics to the page.
    const windowInfo = getTodayWindow();
    const bridge = runtime.nativeBridge;
    if (!bridge?.supportsTodayTokenUsage?.() || typeof bridge.requestTodayTokenUsage !== "function") {
      return Promise.resolve({
        available: false,
        date: windowInfo.date,
        source: "observer",
        totalTokens: null,
      });
    }
    return bridge.requestTodayTokenUsage(windowInfo).then((response) => {
      const data = response?.ok === true && response.data && typeof response.data === "object"
        ? response.data
        : null;
      return {
        available: Boolean(data),
        cachedInputTokens: finiteTokenCount(data?.cachedInputTokens),
        date: windowInfo.date,
        eventCount: finiteTokenCount(data?.eventCount),
        inputTokens: finiteTokenCount(data?.inputTokens),
        outputTokens: finiteTokenCount(data?.outputTokens),
        reasoningOutputTokens: finiteTokenCount(data?.reasoningOutputTokens),
        scannedFiles: finiteTokenCount(data?.scannedFiles),
        skippedEvents: finiteTokenCount(data?.skippedEvents),
        source: "observer",
        totalTokens: finiteTokenCount(data?.totalTokens),
      };
    });
  }

  function fetchTodayTokenUsage(source, signal) {
    // 这一段按设置选择 Today token 数据源，未知值回到默认隐藏，避免默认多发本机扫描请求。
    // Select the Today-token source from settings, falling back to hidden so unknown values do not trigger local scans.
    const normalizedSource = todayTokenSources.has(source) ? source : "hidden";
    if (normalizedSource === "hidden") {
      return Promise.resolve({
        available: false,
        date: getTodayWindow().date,
        source: "hidden",
        totalTokens: null,
      });
    }
    if (normalizedSource === "official") return fetchOfficialTodayTokenUsage(signal);
    return fetchObserverTodayTokenUsage();
  }

  function validThreadId(threadId) {
    // 这一段统一去掉侧边栏 data id 的 local/remote 前缀，再校验官方线程标识。
    // Strip local/remote prefixes from sidebar data ids before validating the official thread identifier.
    const key = String(threadId || "").trim().replace(/^(?:local|remote):/iu, "");
    if (!key || key === "__proto__" || key === "prototype" || key === "constructor") return "";
    return /^[A-Za-z0-9_.:-]{8,180}$/u.test(key) ? key : "";
  }

  function sessionIdFromRow(row) {
    // 这一段复用侧边栏结构化 thread id，并归一化为 token 通知使用的裸线程 id。
    // Reuse the structured sidebar thread id and normalize it to the bare id used by token notifications.
    const dataId = row?.getAttribute?.("data-app-action-sidebar-thread-id") || "";
    const href = row?.getAttribute?.("href") || row?.querySelector?.("a[href]")?.getAttribute("href") || "";
    const hrefMatch = href.match(/(?:session|conversation|thread)[=/:-]([A-Za-z0-9_.:-]+)/iu) ||
      href.match(/([A-Za-z0-9_.:-]{8,180})(?:[/?#]|$)/u);
    return validThreadId(dataId || hrefMatch?.[1] || "");
  }

  function isCurrentThreadRow(row, sessionId) {
    // 这一段优先使用 Codex 的 aria-current 状态识别当前线程，不读取标题文案。
    // Prefer Codex's aria-current state to identify the active thread without reading title text.
    if (!row) return false;
    if (row.getAttribute("aria-current") === "page" || row.getAttribute("aria-current") === "true") return true;
    if (row.querySelector?.('[aria-current="page"], [aria-current="true"]')) return true;
    const href = row.getAttribute("href") || row.querySelector?.("a[href]")?.getAttribute("href") || "";
    if (!href || !sessionId) return false;
    try {
      const url = new URL(href, window.location.href);
      return url.href === window.location.href || url.href.includes(sessionId);
    } catch {
      return window.location.href.includes(href) || window.location.href.includes(sessionId);
    }
  }

  function locationThreadId() {
    // 这一段只在侧边栏状态不可用时解析路由里的线程 id。
    // Parse the route thread id only when the sidebar state is unavailable.
    const source = `${window.location.pathname}${window.location.search}${window.location.hash}`;
    const match = source.match(/(?:session|conversation|thread)(?:\/|=|:|-)([A-Za-z0-9_.:-]+)/iu) ||
      source.match(/\/([0-9a-fA-F]{8}-[0-9a-fA-F]{4}-[0-9a-fA-F]{4}-[0-9a-fA-F]{12})(?:[/?#]|$)/u) ||
      source.match(/\/([A-Za-z0-9_.:-]{24,180})(?:[/?#]|$)/u);
    return validThreadId(match?.[1] || "");
  }

  function getReactFiber(element) {
    // 这一段只读取 DOM 节点自带的 React fiber 指针，用于定位当前官方路由。
    // Read only the React fiber pointer owned by the DOM node so the current official route can be found.
    if (!element || typeof element !== "object") return null;
    const key = Object.getOwnPropertyNames(element).find((name) =>
      name.startsWith("__reactFiber$") || name.startsWith("__reactInternalInstance$"));
    return key ? element[key] : null;
  }

  function readRouteScopeValue(scope) {
    // 这一段优先读取 route scope 的公开 value；缺失时只做无参数 get() 读取，不写入状态。
    // Prefer the route scope's public value and fall back to a parameterless get() read without mutating state.
    if (!scope || typeof scope !== "object") return null;
    if (scope.value && typeof scope.value === "object") return scope.value;
    try {
      const value = typeof scope.get === "function" ? scope.get() : null;
      return value && typeof value === "object" ? value : null;
    } catch {
      return null;
    }
  }

  function routeScopeThreadId(scope) {
    // 这一段只接受 Codex 官方线程路由，避免首页、新建页或其它 scope 误绑定 token 缓存。
    // Accept only Codex's official thread routes so home, new-thread, or unrelated scopes do not bind token cache.
    if (!scope || typeof scope !== "object") return "";
    if (typeof scope.get !== "function" || typeof scope.set !== "function") return "";
    if (!scope.node || !scope.chain) return "";
    try {
      if (!scope.queryClient) return "";
    } catch {
      return "";
    }
    const route = readRouteScopeValue(scope);
    if (!route || typeof route !== "object") return "";
    if (route.routeKind !== "local-thread" && route.routeKind !== "remote-thread") return "";
    return validThreadId(route.conversationId || route.threadId || route.sessionId || "");
  }

  function scanRouteScopeObject(value, seenObjects, depth = 0) {
    // 这一段在 React fiber 局部对象里有界查找 route scope，避免全局深扫造成性能风险。
    // Search bounded React fiber-local objects for a route scope to avoid expensive global deep scans.
    if (!value || (typeof value !== "object" && typeof value !== "function")) return "";
    if (depth > routeScopeObjectDepth) return "";
    if (typeof value === "object") {
      if (seenObjects.has(value)) return "";
      seenObjects.add(value);
    }
    const ownThreadId = routeScopeThreadId(value);
    if (ownThreadId) return ownThreadId;
    if (typeof value !== "object") return "";

    if (value instanceof Map && depth < 3) {
      let index = 0;
      for (const [key, child] of value) {
        const keyThreadId = scanRouteScopeObject(key, seenObjects, depth + 1);
        if (keyThreadId) return keyThreadId;
        const childThreadId = scanRouteScopeObject(child, seenObjects, depth + 1);
        if (childThreadId) return childThreadId;
        index += 1;
        if (index >= routeScopeObjectKeys) break;
      }
    }

    for (const key of Object.keys(value).slice(0, routeScopeObjectKeys)) {
      let child = null;
      try {
        child = value[key];
      } catch {
        continue;
      }
      const childThreadId = scanRouteScopeObject(child, seenObjects, depth + 1);
      if (childThreadId) return childThreadId;
    }
    return "";
  }

  function routeScopeThreadIdFromHost(host) {
    // 这一段沿页面结构 host 的 React fiber 父链找当前线程 scope，不依赖左侧栏是否展开。
    // Walk the page host's React fiber chain to find the current thread scope without depending on an expanded sidebar.
    let fiber = getReactFiber(host);
    for (let depth = 0; fiber && depth < routeScopeFiberDepth; depth += 1) {
      const seenObjects = new WeakSet();
      const threadId = scanRouteScopeObject(fiber.memoizedState, seenObjects) ||
        scanRouteScopeObject(fiber.updateQueue, seenObjects) ||
        scanRouteScopeObject(fiber.dependencies, seenObjects);
      if (threadId) return threadId;
      fiber = fiber.return;
    }
    return "";
  }

  function routeScopeThreadIdFromSelectors(selectors, hostLimit) {
    // 这一段按调用方给出的少量结构锚点查找 route scope，避免扩大到消息正文区域。
    // Search route scope from a few caller-provided structure anchors without expanding into message content.
    const hosts = [];
    const seenHosts = new Set();
    const safeHostLimit = Math.max(1, Math.min(8, Math.round(Number(hostLimit)) || 1));
    for (const selector of selectors) {
      for (const host of Array.from(document.querySelectorAll(selector)).slice(0, safeHostLimit)) {
        if (!host || seenHosts.has(host)) continue;
        seenHosts.add(host);
        hosts.push(host);
        if (hosts.length >= safeHostLimit) break;
      }
      if (hosts.length >= safeHostLimit) break;
    }
    for (const host of hosts) {
      const threadId = routeScopeThreadIdFromHost(host);
      if (threadId) return threadId;
    }
    return "";
  }

  function routeScopeThreadIdFromPage() {
    // 这一段优先从左上角标题栏附近查找当前线程；只有标题栏结构不可用时才退到页面骨架。
    // Prefer the top-left header area for the current thread and fall back to page shell hosts only when unavailable.
    return routeScopeThreadIdFromSelectors(routeScopeAnchorSelectors, routeScopeAnchorHostLimit) ||
      routeScopeThreadIdFromSelectors(routeScopeFallbackSelectors, routeScopeFallbackHostLimit);
  }

  function sidebarThreadId() {
    // 这一段从当前高亮侧边栏行读取线程 id，避免用多语言标题或正文推断当前对话。
    // Read the active thread id from the highlighted sidebar row, avoiding localized titles or message text.
    const rows = Array.from(document.querySelectorAll(sidebarThreadSelector));
    for (const row of rows) {
      const sessionId = sessionIdFromRow(row);
      if (sessionId && isCurrentThreadRow(row, sessionId)) return sessionId;
    }
    return "";
  }

  function currentThreadId() {
    // 这一段按可靠性从结构化侧栏、官方 route scope、URL 路由依次识别当前线程。
    // Identify the current thread by reliability order: structured sidebar, official route scope, then URL route.
    return sidebarThreadId() || routeScopeThreadIdFromPage() || locationThreadId();
  }

  function finiteTokenCount(value) {
    // 这一段把官方 token 数值收敛成非负整数，异常字段直接视为缺失。
    // Normalize official token counts into non-negative integers and treat invalid fields as missing.
    const count = Number(value);
    return Number.isFinite(count) && count >= 0 ? Math.round(count) : null;
  }

  function normalizeTokenBreakdown(value) {
    // 这一段只保留展示需要的 token breakdown 数值，不缓存原始通知对象。
    // Keep only the token breakdown numbers needed for display instead of caching the raw notification object.
    if (!value || typeof value !== "object" || Array.isArray(value)) return null;
    const totalTokens = finiteTokenCount(value.totalTokens ?? value.total_tokens);
    const inputTokens = finiteTokenCount(value.inputTokens ?? value.input_tokens);
    const cachedInputTokens = finiteTokenCount(value.cachedInputTokens ?? value.cached_input_tokens);
    const outputTokens = finiteTokenCount(value.outputTokens ?? value.output_tokens);
    const reasoningOutputTokens = finiteTokenCount(value.reasoningOutputTokens ?? value.reasoning_output_tokens);
    if (
      totalTokens == null &&
      inputTokens == null &&
      cachedInputTokens == null &&
      outputTokens == null &&
      reasoningOutputTokens == null
    ) {
      return null;
    }
    return {
      cachedInputTokens: cachedInputTokens ?? 0,
      inputTokens: inputTokens ?? 0,
      outputTokens: outputTokens ?? 0,
      reasoningOutputTokens: reasoningOutputTokens ?? 0,
      totalTokens: totalTokens ?? ((inputTokens ?? 0) + (outputTokens ?? 0)),
    };
  }

  function normalizeConversationTokenUsage(value) {
    // 这一段兼容 app-server 的 tokenUsage.total/last 结构，缺少 total 时拒绝展示。
    // Support the app-server tokenUsage.total/last shape and refuse display when total is absent.
    if (!value || typeof value !== "object" || Array.isArray(value)) return null;
    const total = normalizeTokenBreakdown(value.total || value.totalTokenUsage || value.total_token_usage);
    const last = normalizeTokenBreakdown(value.last || value.lastTokenUsage || value.last_token_usage);
    if (!total) return null;
    const modelContextWindow = finiteTokenCount(value.modelContextWindow || value.model_context_window);
    return {
      last,
      modelContextWindow: modelContextWindow ?? null,
      total,
    };
  }

  function rememberConversationTokenUsage(threadId, tokenUsage) {
    // 这一段按线程缓存最近 token 快照，并限制条目数量避免长时间运行后内存增长。
    // Cache recent token snapshots by thread and cap entries so long sessions cannot grow memory unbounded.
    const safeThreadId = validThreadId(threadId);
    const normalizedUsage = normalizeConversationTokenUsage(tokenUsage);
    if (!safeThreadId || !normalizedUsage) return false;
    conversationTokenUsageByThreadId.delete(safeThreadId);
    conversationTokenUsageByThreadId.set(safeThreadId, normalizedUsage);
    while (conversationTokenUsageByThreadId.size > maxConversationTokenUsageEntries) {
      const oldestKey = conversationTokenUsageByThreadId.keys().next().value;
      conversationTokenUsageByThreadId.delete(oldestKey);
    }
    return true;
  }

  function readNotificationShape(message) {
    // 这一段兼容 Codex host 消息和少量内部转发形态，只读取 method/params。
    // Support Codex host messages and a few internal forwarding shapes while reading only method/params.
    if (!message || typeof message !== "object") return null;
    if (typeof message.method === "string") {
      return { hostId: message.hostId || "", method: message.method, params: message.params };
    }
    const nested = message.notification || message.message || message.event;
    if (nested && typeof nested === "object" && typeof nested.method === "string") {
      return { hostId: message.hostId || nested.hostId || "", method: nested.method, params: nested.params };
    }
    return null;
  }

  function readTokenUsageRecordFromMessage(message) {
    // 这一段只接受官方 thread/tokenUsage/updated 通知，其它 app-server 消息一律忽略。
    // Accept only the official thread/tokenUsage/updated notification and ignore all other app-server messages.
    if (!message || typeof message !== "object") return null;
    const notification = message.type === "mcp-notification" || message.type === "handle-app-server-notification-for-host"
      ? readNotificationShape(message)
      : null;
    if (notification?.method !== "thread/tokenUsage/updated") return null;
    const params = notification.params;
    const threadId = validThreadId(params?.threadId);
    return threadId && params?.tokenUsage ? { threadId, tokenUsage: params.tokenUsage } : null;
  }

  function readTokenUsageRecordFromStreamSnapshot(message) {
    // 这一段兼容同窗口线程流快照，重新注入后如果官方广播快照也能补到 token。
    // Support same-window thread stream snapshots so reinjection can recover token data when Codex broadcasts one.
    if (!message || typeof message !== "object" || message.type !== "thread-stream-state-changed") return null;
    const conversationId = validThreadId(message.conversationId || message.params?.conversationId);
    const change = message.change || message.params?.change;
    const conversationState = change?.conversationState;
    const tokenUsage = conversationState?.latestTokenUsageInfo;
    return conversationId && tokenUsage ? { threadId: conversationId, tokenUsage } : null;
  }

  function readTokenUsageRecord(message) {
    // 这一段集中提取可能出现的 token 快照，调用方只处理标准化记录。
    // Centralize token snapshot extraction so callers handle only normalized records.
    return readTokenUsageRecordFromMessage(message) || readTokenUsageRecordFromStreamSnapshot(message);
  }

  function bindConversationTokenUsageUpdates(onChange, signal) {
    // 这一段监听官方 app-server token 通知；只缓存数值字段，不改写官方消息。
    // Listen for official app-server token notifications; cache only numeric fields and do not rewrite messages.
    const onMessage = (event) => {
      const record = readTokenUsageRecord(event.data);
      if (!record || !rememberConversationTokenUsage(record.threadId, record.tokenUsage)) return;
      onChange?.();
    };
    window.addEventListener("message", onMessage, { capture: true, signal });
    return () => window.removeEventListener("message", onMessage, { capture: true });
  }

  function bindCurrentThreadChange(onChange, signal) {
    // 这一段监听当前线程切换，让 token 明细立即切到对应线程缓存，避免沿用上一对话数值。
    // Observe current-thread changes so token details immediately use that thread's cache instead of stale rows.
    let currentId = currentThreadId();
    let frameId = 0;

    const checkThreadChange = () => {
      frameId = 0;
      const nextId = currentThreadId();
      if (nextId === currentId) return;
      currentId = nextId;
      onChange?.();
    };

    const scheduleCheck = () => {
      if (frameId) return;
      frameId = window.requestAnimationFrame(checkThreadChange);
    };

    const observer = new MutationObserver(scheduleCheck);
    observer.observe(document.body, {
      attributeFilter: ["aria-current", "class", "data-app-action-sidebar-thread-id"],
      attributes: true,
      childList: true,
      subtree: true,
    });
    window.addEventListener("popstate", scheduleCheck, { signal });
    window.addEventListener("hashchange", scheduleCheck, { signal });
    signal.addEventListener(
      "abort",
      () => {
        if (frameId) window.cancelAnimationFrame(frameId);
        observer.disconnect();
      },
      { once: true },
    );

    return () => {
      if (frameId) window.cancelAnimationFrame(frameId);
      observer.disconnect();
      window.removeEventListener("popstate", scheduleCheck);
      window.removeEventListener("hashchange", scheduleCheck);
    };
  }

  function readConversationTokenUsage() {
    // 这一段读取当前线程的累计 token 快照；没有收到官方通知时返回 null 由 UI 显示同步中。
    // Read the active thread's total token snapshot; return null until an official notification arrives.
    const threadId = currentThreadId();
    return threadId ? conversationTokenUsageByThreadId.get(threadId) ?? null : null;
  }

  usagePanel.api = {
    bindCurrentThreadChange,
    bindConversationTokenUsageUpdates,
    fetchResetCredits,
    fetchStatusPing,
    fetchTodayTokenUsage,
    fetchUsage,
    readConversationTokenUsage,
  };
})();
