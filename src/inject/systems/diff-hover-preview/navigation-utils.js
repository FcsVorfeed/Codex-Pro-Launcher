(() => {
  const runtime = window.__codexProRuntime;
  if (!runtime) return;

  const maxNavigationRanges = 200;
  const maxRouteScopeObjectDepth = 7;
  const maxRouteScopeObjectKeys = 80;
  const maxRouteScopeFallbackHosts = 24;
  const defaultMaxRouteScopeFiberDepth = 100;
  const hunkHeaderPattern = /^@@\s+-\d+(?:,\d+)?\s+\+(\d+)(?:,(\d+))?\s+@@/u;

  function normalizePath(value) {
    // 这一段统一 diff 路径格式，避免 Windows 分隔符或 ./ 前缀影响匹配。
    // Normalize diff paths so Windows separators or ./ prefixes do not affect matching.
    return String(value || "")
      .replace(/\\/g, "/")
      .replace(/^\.\//u, "")
      .trim()
      .slice(0, 500);
  }

  function parseUnifiedDiffPath(value) {
    // 这一段从 unified diff 文件头里提取工作区相对路径，忽略 /dev/null。
    // Extract the workspace-relative path from unified diff file headers, ignoring /dev/null.
    const token = String(value || "").trim().split(/\t/u)[0];
    if (!token || token === "/dev/null") return "";
    return normalizePath(token.replace(/^"?[ab]\//u, "").replace(/^"|"$/gu, ""));
  }

  function normalizeNavigationRanges(value) {
    // 这一段只保留正整数行范围，并限制数量避免异常 diff 撑大状态。
    // Keep only positive integer line ranges and cap the count so unusual diffs cannot grow state unbounded.
    if (!Array.isArray(value)) return [];
    const ranges = [];
    for (const item of value) {
      const line = Math.round(Number(item?.line));
      const endLine = Math.round(Number(item?.endLine ?? item?.line));
      if (!Number.isFinite(line) || line <= 0) continue;
      const normalizedEndLine = Number.isFinite(endLine) && endLine > 0
        ? Math.max(line, endLine)
        : line;
      ranges.push({ line, endLine: normalizedEndLine });
      if (ranges.length >= maxNavigationRanges) break;
    }
    return ranges;
  }

  function clampNumber(value, min, max) {
    // 这一段把浮动定位约束在可视范围内，避免小窗口时按钮溢出。
    // Constrain floating placement inside the viewport so buttons do not overflow in small windows.
    return Math.min(Math.max(value, min), max);
  }

  function normalizeRect(value) {
    // 这一段接受 DOMRect 或测试里的普通对象，并补齐 width/height。
    // Accept either DOMRect or plain test objects and fill width/height.
    if (!value || typeof value !== "object") return null;
    const left = Number(value.left);
    const top = Number(value.top);
    const right = Number(value.right);
    const bottom = Number(value.bottom);
    const width = Number.isFinite(Number(value.width)) ? Number(value.width) : right - left;
    const height = Number.isFinite(Number(value.height)) ? Number(value.height) : bottom - top;
    if (![left, top, right, bottom, width, height].every(Number.isFinite)) return null;
    if (width <= 0 || height <= 0 || right <= left || bottom <= top) return null;
    return { bottom, height, left, right, top, width };
  }

  function getPreviewNavigationPlacement(hostRectValue, rootRectValue = {}, viewportValue = {}) {
    // 这一段计算导航条在预览内容右上角的固定定位；没有预览 host 时返回 null 让调用方隐藏。
    // Compute fixed placement at the preview content's top-right; return null without a usable preview host.
    const hostRect = normalizeRect(hostRectValue);
    if (!hostRect || hostRect.width < 120 || hostRect.height < 80) return null;
    const rootRect = normalizeRect({
      bottom: Number(rootRectValue?.height || 116),
      height: Number(rootRectValue?.height || 116),
      left: 0,
      right: Number(rootRectValue?.width || 40),
      top: 0,
      width: Number(rootRectValue?.width || 40),
    }) || { height: 116, width: 40 };
    const viewportWidth = Number(viewportValue?.width || viewportValue?.innerWidth || window.innerWidth || hostRect.right);
    const viewportHeight = Number(viewportValue?.height || viewportValue?.innerHeight || window.innerHeight || hostRect.bottom);
    const leftMin = Math.max(8, hostRect.left + 8);
    const leftMax = Math.max(leftMin, Math.min(hostRect.right - rootRect.width - 8, viewportWidth - rootRect.width - 8));
    const topMin = Math.max(8, hostRect.top + 12);
    const topMax = Math.max(topMin, Math.min(hostRect.bottom - rootRect.height - 8, viewportHeight - rootRect.height - 8));
    return {
      left: Math.round(clampNumber(hostRect.right - rootRect.width - 16, leftMin, leftMax)),
      top: Math.round(clampNumber(hostRect.top + 12, topMin, topMax)),
    };
  }

  function createHunkTracker(line, count) {
    // 这一段记录当前 hunk 在新文件侧的起点；删除-only hunk 用该起点作为可跳转锚点。
    // Track the new-file start for the current hunk; deletion-only hunks use it as the jump anchor.
    return {
      anchorLine: Math.max(1, line),
      endLine: 0,
      hasChange: false,
      line: 0,
      newLine: line,
      newLineCount: Math.max(0, count),
    };
  }

  function pushHunkRange(file, hunk) {
    // 这一段把一个 hunk 收束成单个导航块，不逐行导航，避免连续修改过于碎片化。
    // Collapse one hunk into one navigation block instead of per-line navigation, avoiding noisy movement.
    if (!file || !hunk || !hunk.hasChange) return;
    const line = hunk.line || hunk.anchorLine;
    const endLine = hunk.endLine || line;
    file.navigationRanges.push({ line, endLine: Math.max(line, endLine) });
  }

  function finalizeFile(rangesByPath, file) {
    // 这一段把当前文件的导航范围写入 Map，只保留有路径且有范围的文件。
    // Store the current file ranges in the map, keeping only files with paths and ranges.
    if (!file) return;
    const path = file.path || file.previousPath;
    const navigationRanges = normalizeNavigationRanges(file.navigationRanges);
    if (!path || navigationRanges.length === 0) return;
    rangesByPath.set(path, navigationRanges);
  }

  function parseUnifiedDiffNavigationRanges(diffText) {
    // 这一段只解析文件头和 hunk 行号，不读取或返回具体源码内容。
    // Parse only file headers and hunk line numbers, without returning source-code content.
    const source = typeof diffText === "string" ? diffText : "";
    const rangesByPath = new Map();
    if (!source.trim()) return rangesByPath;

    let currentFile = null;
    let currentHunk = null;
    for (const line of source.split(/\r?\n/u)) {
      if (line.startsWith("diff --git ")) {
        pushHunkRange(currentFile, currentHunk);
        finalizeFile(rangesByPath, currentFile);
        currentFile = { navigationRanges: [], path: "", previousPath: "" };
        currentHunk = null;
        continue;
      }
      if (!currentFile) continue;
      if (line.startsWith("rename from ")) {
        currentFile.previousPath = normalizePath(line.slice("rename from ".length));
        continue;
      }
      if (line.startsWith("rename to ")) {
        currentFile.path = normalizePath(line.slice("rename to ".length));
        continue;
      }
      if (line.startsWith("--- ")) {
        currentFile.previousPath = parseUnifiedDiffPath(line.slice(4));
        continue;
      }
      if (line.startsWith("+++ ")) {
        currentFile.path = parseUnifiedDiffPath(line.slice(4));
        continue;
      }
      const hunkMatch = hunkHeaderPattern.exec(line);
      if (hunkMatch) {
        pushHunkRange(currentFile, currentHunk);
        currentHunk = createHunkTracker(Number(hunkMatch[1]), Number(hunkMatch[2] ?? "1"));
        continue;
      }
      if (!currentHunk) continue;
      if (line.startsWith("+") && !line.startsWith("+++")) {
        currentHunk.hasChange = true;
        if (!currentHunk.line) currentHunk.line = currentHunk.newLine;
        currentHunk.endLine = currentHunk.newLine;
        currentHunk.newLine += 1;
        continue;
      }
      if (line.startsWith("-") && !line.startsWith("---")) {
        currentHunk.hasChange = true;
        if (!currentHunk.line && currentHunk.newLineCount === 0) currentHunk.line = currentHunk.anchorLine;
        continue;
      }
      if (line.startsWith(" ")) {
        currentHunk.newLine += 1;
      }
    }
    pushHunkRange(currentFile, currentHunk);
    finalizeFile(rangesByPath, currentFile);
    return rangesByPath;
  }

  function firstNavigationRange(file) {
    // 这一段返回文件第一处可跳转范围，用于点击文件后自动定位。
    // Return the first jumpable range for a file so file clicks can auto-position.
    return normalizeNavigationRanges(file?.navigationRanges)[0] || null;
  }

  function isWorkspaceRouteScope(value, summary, options = {}) {
    // 这一段识别官方 route scope 对象，只接受当前对话的 local/remote thread scope。
    // Identify official route scope objects and accept only the current local/remote thread scope.
    if (!value || typeof value !== "object") return false;
    if (typeof value.get !== "function" || typeof value.set !== "function") return false;
    if (!value.node || !value.chain) return false;
    try {
      if (!value.queryClient) return false;
    } catch {
      return false;
    }
    const route = value.value;
    if (!route || typeof route !== "object") return false;
    if (route.routeKind !== "local-thread" && route.routeKind !== "remote-thread") return false;
    const expectedConversationId = String(summary?.conversationId || "");
    const routeConversationId = String(route.conversationId || "");
    if (expectedConversationId) return routeConversationId === expectedConversationId;
    return options.allowMissingConversationId === true;
  }

  function findWorkspaceRouteScope(anchor, summary = {}, options = {}) {
    // 这一段先查触发行，再查调用方提供的少量备用 host，兼容环境面板不在 thread scope 子树内的情况。
    // Search the trigger row first, then caller-provided fallback hosts for environment-panel rows outside the thread scope tree.
    const getReactFiber = typeof options.getReactFiber === "function" ? options.getReactFiber : () => null;
    const getFallbackHosts = typeof options.getFallbackHosts === "function" ? options.getFallbackHosts : () => [];
    const maxFiberDepth = Math.max(1, Math.min(
      200,
      Math.round(Number(options.maxFiberDepth)) || defaultMaxRouteScopeFiberDepth,
    ));
    const seenObjects = new WeakSet();

    function scanObject(value, depth = 0, scanOptions = {}) {
      // 这一段限制递归深度和对象 fan-out，避免点击时深扫整棵 React 内部结构。
      // Bound recursion depth and object fan-out so a click does not deeply scan all React internals.
      if (!value || (typeof value !== "object" && typeof value !== "function")) return null;
      if (depth > maxRouteScopeObjectDepth) return null;
      if (typeof value === "object") {
        if (seenObjects.has(value)) return null;
        seenObjects.add(value);
      }
      if (isWorkspaceRouteScope(value, summary, scanOptions)) return value;
      if (typeof value !== "object") return null;

      if (value instanceof Map && depth < 4) {
        let index = 0;
        for (const [key, child] of value) {
          const keyScope = scanObject(key, depth + 1, scanOptions);
          if (keyScope) return keyScope;
          const childScope = scanObject(child, depth + 1, scanOptions);
          if (childScope) return childScope;
          index += 1;
          if (index >= maxRouteScopeObjectKeys) break;
        }
      }

      for (const key of Object.keys(value).slice(0, maxRouteScopeObjectKeys)) {
        let child = null;
        try {
          child = value[key];
        } catch {
          continue;
        }
        const childScope = scanObject(child, depth + 1, scanOptions);
        if (childScope) return childScope;
      }
      return null;
    }

    function scanFiberHost(host, scanOptions = {}) {
      // 这一段沿 host 对应 fiber 向上查找 route scope，和 Codex 原生组件树边界保持一致。
      // Walk upward from the host's fiber to find the route scope, matching Codex's native component tree boundary.
      if (!host) return null;
      let fiber = null;
      try {
        fiber = getReactFiber(host);
      } catch {
        fiber = null;
      }
      for (let depth = 0; fiber && depth < maxFiberDepth; depth += 1) {
        const memoizedStateScope = scanObject(fiber.memoizedState, 0, scanOptions);
        if (memoizedStateScope) return memoizedStateScope;
        const updateQueueScope = scanObject(fiber.updateQueue, 0, scanOptions);
        if (updateQueueScope) return updateQueueScope;
        const dependenciesScope = scanObject(fiber.dependencies, 0, scanOptions);
        if (dependenciesScope) return dependenciesScope;
        const memoizedPropsScope = scanObject(fiber.memoizedProps, 0, scanOptions);
        if (memoizedPropsScope) return memoizedPropsScope;
        fiber = fiber.return;
      }
      return null;
    }

    const anchorScope = scanFiberHost(anchor, { allowMissingConversationId: true });
    if (anchorScope) return anchorScope;

    let fallbackHosts = [];
    try {
      fallbackHosts = Array.from(getFallbackHosts(anchor, summary) || []);
    } catch {
      fallbackHosts = [];
    }
    for (const host of fallbackHosts.slice(0, maxRouteScopeFallbackHosts)) {
      if (!host || host === anchor) continue;
      const scope = scanFiberHost(host, { allowMissingConversationId: false });
      if (scope) return scope;
    }
    return null;
  }

  runtime.systemModules.diffHoverPreviewNavigation = {
    findWorkspaceRouteScope,
    firstNavigationRange,
    getPreviewNavigationPlacement,
    normalizeNavigationRanges,
    parseUnifiedDiffNavigationRanges,
  };
})();
