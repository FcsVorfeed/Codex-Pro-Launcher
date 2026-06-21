(() => {
  const runtime = window.__codexProRuntime;
  if (!runtime) return;

  const reactFiberPrefix = "__reactFiber$";

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
          console.warn("[Codex-Pro] invalid file tree filter pattern", pattern, error);
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
    // 这一段把候选路径规整成 Codex FileTree model 使用的路径格式。
    // Normalize candidate paths into the path format used by Codex's FileTree model.
    const text = compactText(value);
    if (!text || text.length > 1000) return "";
    return text.replace(/\\/g, "/").replace(/^\.\//, "");
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

  function pathEntryToDisplayPath(entry) {
    // 这一段兼容 Codex FileTree paths 的字符串和对象两种输入形态。
    // Support both string and object shapes used by Codex FileTree paths.
    if (typeof entry === "string") return entry;
    if (!entry || typeof entry !== "object") return "";
    return entry.displayPath || entry.path || "";
  }

  function shouldKeepPathEntry(entry, matchers) {
    // 这一段在进入官方 FileTree model 前判断路径是否保留。
    // Decide whether a path should be kept before it enters the official FileTree model.
    if (!matchers.length) return true;
    const path = normalizeCandidatePath(pathEntryToDisplayPath(entry));
    return !path || !matchers.some((matcher) => matcherMatchesPath(matcher, path));
  }

  function filterPathEntries(paths, matchers) {
    // 这一段过滤 model 输入路径，不修改虚拟列表渲染后的 DOM。
    // Filter model input paths instead of mutating the rendered virtual-list DOM.
    if (!Array.isArray(paths) || !matchers.length) return paths;
    let changed = false;
    const filteredPaths = [];
    for (const path of paths) {
      if (shouldKeepPathEntry(path, matchers)) {
        filteredPaths.push(path);
      } else {
        changed = true;
      }
    }
    return changed ? filteredPaths : paths;
  }

  function arePathEntriesEqual(leftPaths, rightPaths) {
    // 这一段比较官方 paths 内容，避免打开文件导致数组引用变化时误触发整棵树重建。
    // Compare official paths by content so opening a file does not rebuild the tree just because array identity changed.
    if (leftPaths === rightPaths) return true;
    if (!Array.isArray(leftPaths) || !Array.isArray(rightPaths)) return false;
    if (leftPaths.length !== rightPaths.length) return false;
    for (let index = 0; index < leftPaths.length; index += 1) {
      if (pathEntryToDisplayPath(leftPaths[index]) !== pathEntryToDisplayPath(rightPaths[index])) return false;
    }
    return true;
  }

  function normalizeExpandedPath(path) {
    // 这一段把目录路径转换成 FileTree initialExpandedPaths 使用的不带尾斜杠格式。
    // Convert folder paths into the slashless-tail format used by FileTree initialExpandedPaths.
    const normalized = normalizeCandidatePath(path);
    return normalized.endsWith("/") ? normalized.slice(0, -1) : normalized;
  }

  function getReactFiber(element) {
    // 这一段通过 React 挂在 DOM 节点上的内部 fiber 找到 FileTree 组件边界。
    // Locate the FileTree component boundary through React's internal fiber stored on DOM nodes.
    const key = Object.getOwnPropertyNames(element).find((name) => name.startsWith(reactFiberPrefix));
    return key ? element[key] : null;
  }

  function isFileTreeModel(value) {
    // 这一段用 FileTree model 的公开方法形状识别实例，避免依赖压缩后的类名。
    // Identify FileTree model instances by public method shape instead of minified class names.
    return Boolean(
      value &&
        typeof value === "object" &&
        typeof value.resetPaths === "function" &&
        typeof value.getItem === "function" &&
        typeof value.getSelectedPaths === "function",
    );
  }

  function findFileTreeContext(host) {
    // 这一段沿 React fiber 向上查找同一棵文件树的 model 和原始 paths 属性。
    // Walk up the React fiber chain to find the model and original paths for the same file tree.
    let fiber = getReactFiber(host);
    const context = {
      host,
      initialExpandedPaths: null,
      model: null,
      paths: null,
    };

    for (let depth = 0; fiber && depth < 30; depth += 1) {
      const props = fiber.memoizedProps || {};
      if (!context.model && isFileTreeModel(props.model)) context.model = props.model;
      if (!context.paths && Array.isArray(props.paths)) context.paths = props.paths;
      if (!context.initialExpandedPaths && Array.isArray(props.initialExpandedPaths)) {
        context.initialExpandedPaths = props.initialExpandedPaths;
      }
      if (context.model && context.paths) return context;
      fiber = fiber.return;
    }

    return context.model && context.paths ? context : null;
  }

  runtime.registerSystem("file-tree-filter", () => {
    const settingsApi = runtime.systemModules.settingsMenu?.settings;
    if (!settingsApi) return;

    // 这一段创建系统生命周期控制器，重复注入时会恢复旧 model patch。
    // Create this system's lifecycle controller so reinjection restores old model patches.
    const controller = new AbortController();
    runtime.lifecycle.replaceController("file-tree-filter", controller);

    let matchers = compilePatterns(settingsApi.getSettings().hiddenFileTreePatterns);
    const modelStateByModel = new WeakMap();
    const modelStates = new Set();
    let discoveryFrame = 0;

    function getExpandedPathsFromModel(state) {
      // 这一段从官方 model 读取所有已展开目录，不依赖虚拟列表当前渲染出来的可见 DOM 行。
      // Read all expanded folders from the official model instead of depending on currently rendered virtual-list DOM rows.
      const expandedPaths = [];
      for (const pathEntry of state.rawPaths || []) {
        const path = normalizeExpandedPath(pathEntryToDisplayPath(pathEntry));
        if (!path) continue;
        const item = state.model.getItem?.(path);
        if (item?.isDirectory?.() && item?.isExpanded?.()) expandedPaths.push(path);
      }
      return expandedPaths;
    }

    function getResetOptions(state, incomingOptions, currentExpandedPaths) {
      // 这一段合并官方 reset 选项和当前 model 展开状态，不接管其它 FileTree 行为。
      // Merge official reset options with current model expansion state without taking over other FileTree behavior.
      const options = incomingOptions && typeof incomingOptions === "object" ? { ...incomingOptions } : {};
      const expandedPaths = currentExpandedPaths === undefined
        ? getExpandedPathsFromModel(state)
        : currentExpandedPaths;
      if (Array.isArray(expandedPaths)) {
        state.initialExpandedPaths = Array.from(expandedPaths);
        options.initialExpandedPaths = state.initialExpandedPaths;
      } else if (Array.isArray(options.initialExpandedPaths)) {
        state.initialExpandedPaths = Array.from(options.initialExpandedPaths);
      } else {
        state.initialExpandedPaths = [];
        options.initialExpandedPaths = [];
      }
      return options;
    }

    function restoreSelectionAndFocus(state, selectedPaths, focusedPath) {
      // 这一段在路径过滤后恢复仍然存在的选择和焦点，避免设置保存后文件树跳得过重。
      // Restore still-existing selection and focus after filtering so saving settings causes less tree jump.
      for (const selectedPath of selectedPaths) {
        if (!shouldKeepPathEntry(selectedPath, matchers)) continue;
        state.model.getItem(selectedPath)?.select?.();
      }
      if (focusedPath && shouldKeepPathEntry(focusedPath, matchers)) {
        state.model.focusPath?.(focusedPath);
      }
    }

    function resetModelWithCurrentFilter(state, incomingOptions = null) {
      // 这一段把过滤后的路径交给官方 model，让它自己计算可见数量和虚拟列表高度。
      // Pass filtered paths into the official model so it computes visible counts and virtual-list height itself.
      if (!Array.isArray(state.rawPaths) || state.restored) return undefined;
      const usesOfficialExpansionState = Array.isArray(incomingOptions?.initialExpandedPaths);
      const selectedPaths = Array.from(state.model.getSelectedPaths?.() || []);
      const focusedPath = state.model.getFocusedPath?.() || null;
      const expandedPaths = usesOfficialExpansionState
        ? null
        : getExpandedPathsFromModel(state);
      const nextPaths = filterPathEntries(state.rawPaths, matchers);
      const nextOptions = getResetOptions(state, incomingOptions || state.lastResetOptions, expandedPaths);

      // 这一段记录本次 model 重建是否真的过滤了路径，供后续恢复/跳过重建判断复用。
      // Record whether this model reset actually filtered paths so later restore/skip decisions can reuse it.
      const pathsWereFiltered = nextPaths !== state.rawPaths;

      state.applying = true;
      try {
        const result = state.originalResetPaths.call(state.model, nextPaths, nextOptions);
        state.lastPathsWereFiltered = pathsWereFiltered;
        if (!usesOfficialExpansionState) restoreSelectionAndFocus(state, selectedPaths, focusedPath);
        return result;
      } finally {
        state.applying = false;
      }
    }

    function patchModel(context) {
      // 这一段只 patch 官方 model 的输入方法，不触碰渲染后的 DOM 行。
      // Patch only the official model input methods and never touch rendered DOM rows.
      const existingState = modelStateByModel.get(context.model);
      if (existingState?.restored) {
        modelStateByModel.delete(context.model);
      } else if (existingState) {
        existingState.host = context.host;
        ensureModelSubscription(existingState);
        const pathsChanged = !arePathEntriesEqual(existingState.rawPaths, context.paths);
        const expandedPathsChanged = existingState.sourceExpandedPathsRef !== context.initialExpandedPaths;
        if (pathsChanged) {
          existingState.rawPaths = Array.from(context.paths);
          existingState.sourcePathsRef = context.paths;
        } else {
          existingState.sourcePathsRef = context.paths;
        }
        if (expandedPathsChanged && Array.isArray(context.initialExpandedPaths)) {
          existingState.sourceExpandedPathsRef = context.initialExpandedPaths;
        }

        // 这一段只在路径确实需要过滤或需要恢复旧过滤时重建，避免响应层已过滤后的列表再跳一次。
        // Rebuild only when paths need filtering or a previous filter must be restored, avoiding extra jumps after response-layer filtering.
        if (
          pathsChanged &&
          (
            filterPathEntries(existingState.rawPaths, matchers) !== existingState.rawPaths ||
            existingState.lastPathsWereFiltered
          )
        ) {
          resetModelWithCurrentFilter(existingState);
        }
        return existingState;
      }

      const state = {
        applying: false,
        host: context.host,
        initialExpandedPaths: Array.isArray(context.initialExpandedPaths)
          ? Array.from(context.initialExpandedPaths)
          : [],
        lastPathsWereFiltered: false,
        lastResetOptions: null,
        model: context.model,
        originalAdd: context.model.add,
        originalResetPaths: context.model.resetPaths,
        rawPaths: Array.from(context.paths),
        restored: false,
        sourceExpandedPathsRef: context.initialExpandedPaths,
        sourcePathsRef: context.paths,
        unsubscribeModelChanges: null,
      };

      context.model.resetPaths = function resetPathsWithCodexProFilter(paths, options) {
        // 这一段接管官方 paths 重置入口，在构建 PathStore 前过滤规则命中的路径。
        // Intercept the official paths reset entrypoint and filter matching paths before PathStore construction.
        if (state.applying || !Array.isArray(paths)) {
          return state.originalResetPaths.apply(this, arguments);
        }

        state.rawPaths = Array.from(paths);
        state.lastResetOptions = options && typeof options === "object" ? { ...options } : null;
        if (Array.isArray(options?.initialExpandedPaths)) {
          state.initialExpandedPaths = Array.from(options.initialExpandedPaths);
        }

        // 这一段在没有命中过滤规则时直接走官方 resetPaths，降低 model 兜底层的扰动。
        // Use the official resetPaths directly when no rule matches, reducing disturbance from the model fallback layer.
        const nextPaths = filterPathEntries(state.rawPaths, matchers);
        if (nextPaths === state.rawPaths && !state.lastPathsWereFiltered) {
          return state.originalResetPaths.apply(this, arguments);
        }
        return resetModelWithCurrentFilter(state, options);
      };

      if (typeof context.model.add === "function") {
        context.model.add = function addWithCodexProFilter(path, ...rest) {
          // 这一段过滤运行中追加的路径，避免后续文件列表刷新把隐藏项加回 model。
          // Filter paths appended at runtime so later file-list refreshes do not re-add hidden entries.
          if (state.applying) return state.originalAdd.apply(this, arguments);
          const inputPaths = Array.isArray(path) ? path : [path];
          const nextPaths = filterPathEntries(inputPaths, matchers);
          if (!nextPaths.length) return undefined;
          return state.originalAdd.call(this, Array.isArray(path) ? nextPaths : nextPaths[0], ...rest);
        };
      }

      modelStateByModel.set(context.model, state);
      modelStates.add(state);
      ensureModelSubscription(state);

      // 这一段只在发现阶段确实有隐藏项时主动重建；普通列表交给官方现状继续运行。
      // Rebuild during discovery only when hidden entries are present; ordinary lists keep the official current state.
      if (filterPathEntries(state.rawPaths, matchers) !== state.rawPaths) {
        resetModelWithCurrentFilter(state, { initialExpandedPaths: state.initialExpandedPaths });
      }
      return state;
    }

    function ensureModelSubscription(state) {
      // 这一段订阅官方 model 变化来重新发现 React props，覆盖同一容器内 paths/model 刷新的情况。
      // Subscribe to official model changes to rediscover React props when paths/model refresh inside the same container.
      if (state.unsubscribeModelChanges !== null) return;
      if (typeof state.model.subscribe !== "function") {
        state.unsubscribeModelChanges = false;
        return;
      }
      const unsubscribe = state.model.subscribe(() => {
        scheduleDiscoverFileTreeModels();
      });
      state.unsubscribeModelChanges = typeof unsubscribe === "function" ? unsubscribe : false;
    }

    function releaseModelState(state, options = {}) {
      // 这一段释放已被替换的旧 model，避免旧订阅和旧 model 被强引用长期保留。
      // Release replaced models so stale subscriptions and model objects are not kept strongly referenced.
      if (!state || state.restored) return;
      if (typeof state.unsubscribeModelChanges === "function") state.unsubscribeModelChanges();
      state.unsubscribeModelChanges = null;
      state.restored = true;
      state.model.resetPaths = state.originalResetPaths;
      if (typeof state.originalAdd === "function") state.model.add = state.originalAdd;
      if (options.restoreFilteredPaths && Array.isArray(state.rawPaths) && state.lastPathsWereFiltered) {
        state.originalResetPaths.call(state.model, state.rawPaths, getResetOptions(state, state.lastResetOptions));
      }
      modelStates.delete(state);
      modelStateByModel.delete(state.model);
    }

    function discoverFileTreeModels() {
      // 这一段轻量发现当前页面的官方 file-tree-container，并沿 React fiber 找到 model。
      // Lightly discover official file-tree-container hosts and find their models through React fiber.
      discoveryFrame = 0;
      const seenStates = new Set();
      for (const host of document.querySelectorAll("file-tree-container")) {
        const context = findFileTreeContext(host);
        const state = context ? patchModel(context) : null;
        if (state) seenStates.add(state);
      }
      for (const state of Array.from(modelStates)) {
        if (!seenStates.has(state)) releaseModelState(state);
      }
    }

    function scheduleDiscoverFileTreeModels() {
      // 这一段按文件树 DOM 变化触发 model 发现，替代固定 1 秒轮询。
      // Trigger model discovery from file-tree DOM changes instead of a fixed one-second poll.
      if (discoveryFrame || controller.signal.aborted) return;
      discoveryFrame = window.requestAnimationFrame(discoverFileTreeModels);
    }

    function nodeTouchesFileTree(node) {
      // 这一段只在文件树容器出现或变化时重新发现 model，避免页面其它区域唤醒兜底层。
      // Rediscover models only when file-tree containers appear or change, avoiding wakeups from other page areas.
      if (!(node instanceof Element)) return false;
      return Boolean(
        node.matches?.("file-tree-container") ||
          node.closest?.("file-tree-container") ||
          node.querySelector?.("file-tree-container"),
      );
    }

    function mutationTouchesFileTree(mutation) {
      // 这一段把 MutationObserver 收敛到 file-tree-container 结构。
      // Keep MutationObserver handling constrained to file-tree-container structure.
      const target = mutation.target instanceof Element ? mutation.target : mutation.target?.parentElement;
      if (target instanceof Element && target !== document.body && target !== document.documentElement) {
        if (nodeTouchesFileTree(target)) return true;
      }
      return [...mutation.addedNodes, ...mutation.removedNodes].some(nodeTouchesFileTree);
    }

    function handleFileTreeInteraction(event) {
      // 这一段用真实文件树交互补触发 model 发现，覆盖 React props 静默替换但 DOM 没有结构变化的窄窗口。
      // Use real file-tree interactions to rediscover models when React props change without structural DOM mutations.
      if (nodeTouchesFileTree(event.target)) scheduleDiscoverFileTreeModels();
    }

    function messageHasDirectoryEntries(message) {
      // 这一段识别官方目录响应数据，作为 model 静默替换时的真实数据源触发。
      // Identify official directory-entry responses as the real data-source trigger for silent model replacement.
      if (!message || typeof message !== "object") return false;
      if (Array.isArray(message.result?.entries)) return true;
      if (typeof message.bodyJsonString !== "string" || !message.bodyJsonString.includes("\"entries\"")) return false;
      try {
        const body = JSON.parse(message.bodyJsonString);
        return Array.isArray(body?.entries);
      } catch {
        return false;
      }
    }

    function handleHostMessage(event) {
      // 这一段跟随官方目录响应重新发现 model，不依赖 DOM 结构变化或旧 model 订阅是否触发。
      // Rediscover models from official directory responses without depending on DOM mutations or old model subscriptions.
      if (messageHasDirectoryEntries(event.data)) scheduleDiscoverFileTreeModels();
    }

    const discoveryObserver = new MutationObserver((mutations) => {
      if (mutations.some(mutationTouchesFileTree)) scheduleDiscoverFileTreeModels();
    });
    discoveryObserver.observe(document.body, {
      attributeFilter: ["class", "data-state", "hidden", "style"],
      attributes: true,
      childList: true,
      subtree: true,
    });
    document.addEventListener("pointerdown", handleFileTreeInteraction, { capture: true, signal: controller.signal });
    document.addEventListener("focusin", handleFileTreeInteraction, { capture: true, signal: controller.signal });
    window.addEventListener("message", handleHostMessage, { capture: true, signal: controller.signal });
    discoverFileTreeModels();

    // 这一段订阅 Codex-Pro 设置变化，让保存后的规则从 model 层立即重建文件树。
    // Subscribe to Codex-Pro settings so saved rules rebuild the file tree from the model layer.
    settingsApi.subscribe((settings) => {
      matchers = compilePatterns(settings.hiddenFileTreePatterns);
      for (const state of Array.from(modelStates)) {
        // 这一段只在新规则命中或旧过滤需要恢复时重建，避免保存无关设置导致文件树跳动。
        // Rebuild only when new rules match or an old filter needs restore, avoiding tree jumps from unrelated saves.
        if (
          filterPathEntries(state.rawPaths, matchers) !== state.rawPaths ||
          state.lastPathsWereFiltered
        ) {
          resetModelWithCurrentFilter(state);
        }
      }
    }, controller.signal);

    // 这一段在系统卸载时恢复官方 model 方法和原始路径。
    // Restore official model methods and original paths when this system is torn down.
    controller.signal.addEventListener(
      "abort",
      () => {
        discoveryObserver.disconnect();
        if (discoveryFrame) window.cancelAnimationFrame(discoveryFrame);
        for (const state of Array.from(modelStates)) {
          releaseModelState(state, { restoreFilteredPaths: true });
        }
      },
      { once: true },
    );
  }, { enableSetting: "enableFileTreeFilter" });
})();
