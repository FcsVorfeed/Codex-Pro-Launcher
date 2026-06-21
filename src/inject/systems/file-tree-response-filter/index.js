(() => {
  const runtime = window.__codexProRuntime;
  if (!runtime) return;

  const requestRecordTtlMs = 30000;
  const trackedMethod = "workspace-directory-entries";
  const trackedFetchUrl = `vscode://codex/${trackedMethod}`;

  function escapeRegex(value) {
    // 这一段转义正则特殊字符，保证用户输入的普通文件名不会改变匹配语义。
    // Escape regex metacharacters so plain user-entered filenames do not change matching semantics.
    return value.replace(/[|\\{}()[\]^$+?.]/g, "\\$&");
  }

  function splitPatternList(value) {
    // 这一段把设置里的逗号或换行规则拆成稳定列表，空规则不参与匹配。
    // Split comma or newline separated settings into a stable list, excluding empty rules.
    return String(value || "")
      .split(/[,\n]/)
      .map((pattern) => pattern.trim())
      .filter(Boolean);
  }

  function normalizePattern(pattern) {
    // 这一段统一路径分隔符并兼容只填写扩展名的快捷写法，例如 .meta。
    // Normalize path separators and support the shorthand of entering only an extension, such as .meta.
    let normalized = pattern.replace(/\\/g, "/").replace(/^\.\//, "").trim();
    if (normalized.startsWith(".")) normalized = `*${normalized}`;
    return normalized;
  }

  function globToRegexSource(pattern) {
    // 这一段把常见 Glob 规则转成正则片段，支持 *、** 和 ? 的文件路径匹配。
    // Convert common glob rules into a regex source, supporting *, **, and ? for file path matching.
    let source = "";
    for (let index = 0; index < pattern.length; index += 1) {
      const char = pattern[index];
      const next = pattern[index + 1];
      if (char === "*" && next === "*") {
        if (pattern[index + 2] === "/") {
          source += "(?:.*\\/)?";
          index += 2;
        } else {
          source += ".*";
          index += 1;
        }
      } else if (char === "*") {
        source += "[^/]*";
      } else if (char === "?") {
        source += "[^/]";
      } else {
        source += escapeRegex(char);
      }
    }
    return source;
  }

  function compilePattern(rawPattern) {
    // 这一段预编译单条规则，区分“只匹配文件名”和“匹配路径”的两类规则。
    // Precompile one rule, separating basename-only rules from path-aware rules.
    const pattern = normalizePattern(rawPattern);
    if (!pattern) return null;

    // 这一段让 Library/** 这类目录规则也能过滤根目录里的 Library 行。
    // Let directory rules like Library/** also filter the top-level Library row.
    const directoryPrefix = pattern.endsWith("/**") ? pattern.slice(0, -3).replace(/\/+$/, "") : "";
    const hasSlash = pattern.includes("/");
    const regexSource = directoryPrefix
      ? `${escapeRegex(directoryPrefix)}(?:/.*)?`
      : globToRegexSource(pattern);

    return {
      directoryPrefix: directoryPrefix.toLowerCase(),
      hasSlash: hasSlash || Boolean(directoryPrefix),
      regex: new RegExp(`^${regexSource}$`, "i"),
      rawPattern,
    };
  }

  function compilePatterns(value) {
    // 这一段把所有规则预编译，失败的规则会被跳过以免影响 Codex 主界面。
    // Precompile all rules and skip invalid ones so Codex's main UI remains unaffected.
    return splitPatternList(value)
      .map((pattern) => {
        try {
          return compilePattern(pattern);
        } catch (error) {
          console.warn("[Codex-Pro] invalid file tree response filter pattern", pattern, error);
          return null;
        }
      })
      .filter(Boolean);
  }

  function compactText(value) {
    // 这一段压缩路径文本空白，避免异常输入产生不可预测匹配。
    // Compact path text whitespace so unusual input cannot produce unpredictable matches.
    return String(value || "").replace(/\s+/g, " ").trim();
  }

  function normalizeCandidatePath(value) {
    // 这一段把候选路径规整成 Codex 文件列表响应使用的相对路径格式。
    // Normalize candidate paths into the relative path format used by Codex file-list responses.
    const text = compactText(value);
    if (!text || text.length > 1000) return "";
    return text.replace(/\\/g, "/").replace(/^\.\//, "").replace(/\/+$/, "");
  }

  function getBasename(path) {
    // 这一段提取文件名，供没有斜杠的 Glob 规则做 basename 匹配。
    // Extract the basename so slashless glob rules can match only file names.
    return path.split("/").filter(Boolean).at(-1) || path;
  }

  function matcherMatchesPath(matcher, path) {
    // 这一段执行规则匹配，目录前缀规则同时兼容顶层目录行。
    // Run rule matching, allowing directory-prefix rules to match top-level folder rows.
    const normalizedPath = path.toLowerCase();
    const basename = getBasename(path);
    if (matcher.directoryPrefix) {
      const prefixName = getBasename(matcher.directoryPrefix);
      if (
        normalizedPath === matcher.directoryPrefix ||
        normalizedPath.startsWith(`${matcher.directoryPrefix}/`) ||
        basename.toLowerCase() === prefixName
      ) {
        return true;
      }
    }
    return matcher.hasSlash ? matcher.regex.test(path) : matcher.regex.test(basename);
  }

  function entryToPath(entry) {
    // 这一段兼容目录响应 entry 的 path/displayPath 形态，未知结构不做过滤。
    // Support path/displayPath response entries and leave unknown shapes untouched.
    if (typeof entry === "string") return entry;
    if (!entry || typeof entry !== "object") return "";
    return entry.displayPath || entry.path || "";
  }

  function shouldKeepEntry(entry, matchers) {
    // 这一段在响应进入 React Query/FileTree 前判断条目是否保留。
    // Decide whether an entry should remain before it reaches React Query and FileTree.
    if (!matchers.length) return true;
    const path = normalizeCandidatePath(entryToPath(entry));
    return !path || !matchers.some((matcher) => matcherMatchesPath(matcher, path));
  }

  function filterEntries(entries, matchers) {
    // 这一段只过滤当前响应的 entries，不递归扫描磁盘或遍历整棵项目树。
    // Filter only the entries in the current response, never scanning disk or walking the whole project tree.
    if (!Array.isArray(entries) || !matchers.length) return entries;
    let changed = false;
    const filteredEntries = [];
    for (const entry of entries) {
      if (shouldKeepEntry(entry, matchers)) {
        filteredEntries.push(entry);
      } else {
        changed = true;
      }
    }
    return changed ? filteredEntries : entries;
  }

  function cloneResultWithEntries(result, entries) {
    // 这一段只在确实过滤掉条目时复制响应对象，避免无变化时扰动官方缓存。
    // Copy the response object only when entries changed so unchanged official cache values keep identity.
    if (entries === result.entries) return result;
    return { ...result, entries };
  }

  function getTrackedRequestId(message) {
    // 这一段用官方 fetch URL 或 mcp-request 方法名识别文件夹列表请求，避免全局消息过滤。
    // Identify folder-list requests by the official fetch URL or mcp-request method name to avoid global filtering.
    if (
      message?.type === "fetch" &&
      message.url === trackedFetchUrl &&
      typeof message.requestId === "string"
    ) {
      return message.requestId;
    }
    if (
      message?.type === "mcp-request" &&
      message.request?.method === trackedMethod &&
      typeof message.request.id === "string"
    ) {
      return message.request.id;
    }
    return null;
  }

  function isTrackedResultMessage(message, trackedRequests) {
    // 这一段只接受之前记录过 requestId 的结果消息，其它 app-server 结果原样放行。
    // Accept only result messages whose requestId was previously recorded, leaving other app-server results untouched.
    return Boolean(
      message?.type === "handle-mcp-result-for-host" &&
        typeof message.requestId === "string" &&
        trackedRequests.has(message.requestId),
    );
  }

  function cloneMessageWithResult(message, result) {
    // 这一段在结果对象变化时复制外层消息，避免直接改不可扩展的官方消息对象。
    // Copy the outer message when the result changes so sealed official message objects are not mutated directly.
    return result === message.result ? message : { ...message, result };
  }

  function cloneFetchMessageWithBody(message, body) {
    // 这一段在 fetch 响应 body 变化时复制外层消息，避免直接改不可扩展的官方消息对象。
    // Copy the outer fetch message when the body changes so sealed official message objects are not mutated directly.
    return body === message.bodyJsonString ? message : { ...message, bodyJsonString: body };
  }

  function getMessageEventDataDescriptor(event) {
    // 这一段读取 MessageEvent.data 描述符，后续必要时用实例 getter 替换当前事件数据。
    // Read the MessageEvent.data descriptor so the current event can be redirected when needed.
    let prototype = event;
    while (prototype) {
      const descriptor = Object.getOwnPropertyDescriptor(prototype, "data");
      if (descriptor) return descriptor;
      prototype = Object.getPrototypeOf(prototype);
    }
    return null;
  }

  function replaceMessageEventData(event, nextData) {
    // 这一段优先原地替换 data；如果浏览器只提供 getter，就在当前事件上覆写 getter。
    // Prefer replacing data in place; if the browser only exposes a getter, override it on this event.
    try {
      event.data = nextData;
      if (event.data === nextData) return true;
    } catch {
      // 这一段忽略直接赋值失败，继续尝试描述符覆写路径。
      // Ignore assignment failures and try the descriptor path below.
    }

    const descriptor = getMessageEventDataDescriptor(event);
    if (!descriptor?.get) return false;
    try {
      Object.defineProperty(event, "data", {
        configurable: true,
        enumerable: true,
        get: () => nextData,
      });
      return event.data === nextData;
    } catch {
      return false;
    }
  }

  function getPropertyDescriptorDeep(object, propertyName) {
    // 这一段沿原型链查找属性描述符，用于判断官方 bridge 是否允许替换。
    // Walk the prototype chain for a property descriptor so bridge replaceability can be checked.
    let prototype = object;
    while (prototype) {
      const descriptor = Object.getOwnPropertyDescriptor(prototype, propertyName);
      if (descriptor) return descriptor;
      prototype = Object.getPrototypeOf(prototype);
    }
    return null;
  }

  function canReplaceProperty(object, propertyName) {
    // 这一段只在属性可写、可配置或有 setter 时替换，避免触碰只读 native bridge。
    // Replace only writable/configurable/setter-backed properties to avoid touching read-only native bridges.
    const descriptor = getPropertyDescriptorDeep(object, propertyName);
    return !descriptor || descriptor.writable || descriptor.configurable || Boolean(descriptor.set);
  }

  function getViewMessageFromEvent(event) {
    // 这一段读取官方发出的 codex-message-from-view 事件，复用它记录已发送请求。
    // Read official codex-message-from-view events so sent requests can be tracked through that existing path.
    if (!(event instanceof CustomEvent) || event.type !== "codex-message-from-view") return null;
    const message = event.detail;
    return message && typeof message === "object" ? message : null;
  }

  runtime.registerSystem("file-tree-response-filter", () => {
    const settingsApi = runtime.systemModules.settingsMenu?.settings;
    if (!settingsApi) return;

    // 这一段创建系统生命周期控制器，重复注入时会恢复官方 bridge/事件入口。
    // Create this system's lifecycle controller so reinjection restores official bridge and event entrypoints.
    const controller = new AbortController();
    runtime.lifecycle.replaceController("file-tree-response-filter", controller);

    let matchers = compilePatterns(settingsApi.getSettings().hiddenFileTreePatterns);
    const trackedRequests = new Map();
    const bridge = window.electronBridge;
    const originalSendMessageFromView = bridge?.sendMessageFromView;
    const originalDispatchEvent = window.dispatchEvent;
    const canWrapSendMessageFromView =
      bridge &&
      typeof originalSendMessageFromView === "function" &&
      canReplaceProperty(bridge, "sendMessageFromView");

    function pruneTrackedRequests() {
      // 这一段清理过期请求记录，避免长时间运行后 Map 无限制增长。
      // Prune expired request records so the map cannot grow without bound over long sessions.
      const expiresBefore = Date.now();
      for (const [requestId, record] of trackedRequests) {
        if (record.expiresAt <= expiresBefore) trackedRequests.delete(requestId);
      }
    }

    function rememberRequest(message) {
      // 这一段只记录文件夹列表请求 id，用于后续窄范围识别对应结果。
      // Remember only folder-list request ids so later result filtering stays narrowly scoped.
      const requestId = getTrackedRequestId(message);
      if (!requestId) return;
      pruneTrackedRequests();
      trackedRequests.set(requestId, { expiresAt: Date.now() + requestRecordTtlMs });
    }

    function filterResultMessage(message) {
      // 这一段过滤对应请求的 result.entries，并在处理后删除 requestId 记录。
      // Filter result.entries for the matched request and remove the request record after handling.
      if (!isTrackedResultMessage(message, trackedRequests)) return message;
      trackedRequests.delete(message.requestId);
      const result = message.result;
      if (!result || typeof result !== "object" || !Array.isArray(result.entries)) return message;
      const nextEntries = filterEntries(result.entries, matchers);
      return cloneMessageWithResult(message, cloneResultWithEntries(result, nextEntries));
    }

    function filterFetchResponseMessage(message) {
      // 这一段过滤 fetch-response 的 JSON body，让官方 fetch 解析前就拿到过滤结果。
      // Filter fetch-response JSON body before the official fetch bridge parses it.
      if (
        message?.type !== "fetch-response" ||
        typeof message.requestId !== "string" ||
        !trackedRequests.has(message.requestId)
      ) {
        return message;
      }
      trackedRequests.delete(message.requestId);
      if (message.responseType !== "success" || typeof message.bodyJsonString !== "string") return message;

      try {
        const body = JSON.parse(message.bodyJsonString);
        if (!body || typeof body !== "object" || !Array.isArray(body.entries)) return message;
        const nextEntries = filterEntries(body.entries, matchers);
        if (nextEntries === body.entries) return message;
        return cloneFetchMessageWithBody(message, JSON.stringify({ ...body, entries: nextEntries }));
      } catch {
        return message;
      }
    }

    function filterHostMessage(message) {
      // 这一段按官方消息类型分流，保持每条过滤路径都绑定已记录的 requestId。
      // Route by official message type while keeping every filter path bound to a recorded request id.
      return filterFetchResponseMessage(filterResultMessage(message));
    }

    function filterMessageEvent(event) {
      // 这一段在官方 message listener 接收前替换数据，让 React Query 只看到已过滤响应。
      // Replace data before official message listeners receive it so React Query sees only filtered responses.
      const nextData = filterHostMessage(event.data);
      if (nextData !== event.data) replaceMessageEventData(event, nextData);
    }

    if (canWrapSendMessageFromView) {
      bridge.sendMessageFromView = function sendMessageFromViewWithFileTreeResponseFilter(message, ...rest) {
        // 这一段记录即将发送给官方 bridge 的文件夹列表请求，不改变请求内容。
        // Record outgoing folder-list requests before they reach the official bridge without changing the request payload.
        rememberRequest(message);
        return originalSendMessageFromView.call(this, message, ...rest);
      };
    }

    window.dispatchEvent = function dispatchEventWithFileTreeResponseFilter(event) {
      // 这一段通过官方 view-message 事件记录请求，并兼容 preload 直接派发 MessageEvent 的响应路径。
      // Track requests through official view-message events and support preload paths that dispatch MessageEvent responses.
      rememberRequest(getViewMessageFromEvent(event));
      if (event instanceof MessageEvent) filterMessageEvent(event);
      return originalDispatchEvent.call(this, event);
    };

    window.addEventListener("message", filterMessageEvent, { capture: true, signal: controller.signal });

    settingsApi.subscribe((settings) => {
      // 这一段只在设置保存后重编译规则，运行时过滤继续复用预编译结果。
      // Recompile rules only when settings are saved so runtime filtering reuses prepared matchers.
      matchers = compilePatterns(settings.hiddenFileTreePatterns);
    }, controller.signal);

    controller.signal.addEventListener(
      "abort",
      () => {
        // 这一段恢复官方入口并清空请求记录，避免重新注入后重复包裹。
        // Restore official entrypoints and clear records so reinjection does not stack wrappers.
        trackedRequests.clear();
        if (canWrapSendMessageFromView) {
          bridge.sendMessageFromView = originalSendMessageFromView;
        }
        window.dispatchEvent = originalDispatchEvent;
      },
      { once: true },
    );
  }, { enableSetting: "enableFileTreeFilter" });
})();
