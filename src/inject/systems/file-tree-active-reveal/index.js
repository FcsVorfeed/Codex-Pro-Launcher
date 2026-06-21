(() => {
  const runtime = window.__codexProRuntime;
  if (!runtime) return;

  const systemName = "file-tree-active-reveal";
  const maxPendingRevealPasses = 120;
  const fiberPrefix = "__reactFiber$";

  function getReactFiber(element) {
    // 这一段通过 React 挂在 DOM 节点上的内部 fiber 找到右侧文件树上下文。
    // Locate the right-side file tree context through React's internal fiber stored on DOM nodes.
    const key = Object.getOwnPropertyNames(element).find((name) => name.startsWith(fiberPrefix));
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

  function compactPathText(value) {
    // 这一段统一路径输入的空白和长度，避免异常 props 影响路径计算。
    // Normalize whitespace and length for path inputs so unusual props cannot affect path calculation.
    return String(value || "").replace(/\s+/g, " ").trim().slice(0, 1000);
  }

  function decodePathText(value) {
    // 这一段尽量解码 URL 形式路径，解码失败时保留原值继续走普通路径逻辑。
    // Decode URL-shaped paths when possible, falling back to the original value on malformed input.
    try {
      return decodeURI(value);
    } catch {
      return value;
    }
  }

  function normalizeSlashes(value) {
    // 这一段把 Windows 和 file:// 路径规整成浏览器侧统一的斜杠格式。
    // Normalize Windows and file:// paths into the slash format used in the browser side.
    let path = decodePathText(compactPathText(value))
      .replace(/^file:\/\/\/?/i, "")
      .replace(/\\/g, "/")
      .replace(/^\/([a-zA-Z]:\/)/, "$1")
      .replace(/\/+/g, "/")
      .replace(/\/$/, "");
    if (path === ".") path = "";
    return path;
  }

  function normalizeRelativePath(value) {
    // 这一段把 model 内部相对路径规整成无 ./、无前导斜杠的格式。
    // Normalize model-relative paths by removing ./ and leading slashes.
    return normalizeSlashes(value)
      .replace(/^\.\//, "")
      .replace(/^\/+/, "")
      .replace(/\/$/, "");
  }

  function isElementVisible(element) {
    // 这一段只在右侧文件树真实可见时触发，避免隐藏面板里的树被后台重置。
    // Trigger only when the right-side file tree is actually visible, avoiding resets in hidden panels.
    if (!element?.isConnected) return false;
    const rect = element.getBoundingClientRect();
    if (rect.width <= 0 || rect.height <= 0) return false;
    const style = window.getComputedStyle(element);
    return style.display !== "none" && style.visibility !== "hidden" && Number(style.opacity) !== 0;
  }

  function mergeContextValue(current, next) {
    // 这一段保留最靠近文件树的已知值，避免外层空值覆盖内层有效状态。
    // Preserve the nearest known value so outer empty props do not overwrite valid inner state.
    return current || compactPathText(next);
  }

  function collectFileTreeContext(host) {
    // 这一段沿 React fiber 向上收集当前文件树 model、路径列表和活动文件路径。
    // Walk up the React fiber chain to collect the tree model, path list, and active file path.
    let fiber = getReactFiber(host);
    const context = {
      activeFilePath: "",
      cwd: "",
      host,
      initialExpandedPaths: null,
      model: null,
      paths: null,
      root: "",
      selectedPath: "",
      tabFilePath: "",
      workspaceRoot: "",
    };

    for (let depth = 0; fiber && depth < 80; depth += 1) {
      const props = fiber.memoizedProps || fiber.pendingProps || {};
      if (!context.model && isFileTreeModel(props.model)) context.model = props.model;
      if (!context.paths && Array.isArray(props.paths)) context.paths = props.paths;
      if (!context.initialExpandedPaths && Array.isArray(props.initialExpandedPaths)) {
        context.initialExpandedPaths = props.initialExpandedPaths;
      }
      context.cwd = mergeContextValue(context.cwd, props.cwd);
      context.root = mergeContextValue(context.root, props.root);
      context.workspaceRoot = mergeContextValue(context.workspaceRoot, props.workspaceRoot);
      context.activeFilePath = mergeContextValue(context.activeFilePath, props.activeFilePath);
      context.selectedPath = mergeContextValue(context.selectedPath, props.selectedPath);
      if (props.isActive === true && typeof props.path === "string") {
        context.tabFilePath = mergeContextValue(context.tabFilePath, props.path);
      }
      fiber = fiber.return;
    }

    return context.model && Array.isArray(context.paths) ? context : null;
  }

  function getWorkspaceRoots(context) {
    // 这一段按可信度收集项目根路径，用于判断活动文件是否属于当前项目。
    // Collect workspace roots by trust order so active files can be checked against the current project.
    return [context.cwd, context.root, context.workspaceRoot]
      .map(normalizeSlashes)
      .filter(Boolean);
  }

  function makeRelativeToWorkspace(activePath, roots) {
    // 这一段把 Codex 右侧预览的绝对路径转换成 FileTree model 使用的项目相对路径。
    // Convert Codex side-preview absolute paths into project-relative paths used by the FileTree model.
    const normalizedActivePath = normalizeSlashes(activePath);
    if (!normalizedActivePath) return "";

    for (const root of roots) {
      const normalizedRoot = normalizeSlashes(root);
      if (!normalizedRoot) continue;
      const activeLower = normalizedActivePath.toLowerCase();
      const rootLower = normalizedRoot.toLowerCase();
      if (activeLower === rootLower) return "";
      if (activeLower.startsWith(`${rootLower}/`)) {
        return normalizeRelativePath(normalizedActivePath.slice(normalizedRoot.length + 1));
      }
    }

    // 这一段兼容少数 props 直接给相对路径的情况，但绝对路径不在当前根目录时会跳过。
    // Support the rare case where props already expose a relative path, while skipping out-of-root absolute paths.
    if (!/^[a-zA-Z]:\//.test(normalizedActivePath) && !normalizedActivePath.startsWith("/")) {
      return normalizeRelativePath(normalizedActivePath);
    }
    return "";
  }

  function getActiveRelativePath(context) {
    // 这一段优先使用活动文件标签路径，缺失时再退回 activeFilePath 和当前选中路径。
    // Prefer the active tab path, then activeFilePath, and finally the current selected path.
    const roots = getWorkspaceRoots(context);
    const candidates = [context.tabFilePath, context.activeFilePath, context.selectedPath];
    for (const candidate of candidates) {
      const relativePath = makeRelativeToWorkspace(candidate, roots);
      if (relativePath) return relativePath;
    }
    return "";
  }

  function getAncestorPaths(relativePath) {
    // 这一段根据当前文件路径生成要保留展开的父目录链，其它目录会被 reset 收起。
    // Build the parent-folder chain to keep expanded while reset collapses other folders.
    const parts = normalizeRelativePath(relativePath).split("/").filter(Boolean);
    if (parts.length <= 1) return [];
    const ancestors = [];
    for (let index = 1; index < parts.length; index += 1) {
      ancestors.push(parts.slice(0, index).join("/"));
    }
    return ancestors;
  }

  function selectAndFocusPath(model, relativePath) {
    // 这一段在目标文件已经进入 model 后恢复选择和焦点，保证右侧树能标出当前位置。
    // Restore selection and focus after the target file reaches the model so the tree marks the current location.
    const item = model.getItem?.(relativePath);
    if (!item || item.isDirectory?.()) return false;
    // 这一段清掉旧选择，避免文件切换后右侧树保留多个高亮文件。
    // Clear old selections so switching files does not leave multiple highlighted rows.
    for (const selectedPath of Array.from(model.getSelectedPaths?.() || [])) {
      if (selectedPath === relativePath) continue;
      model.getItem?.(selectedPath)?.deselect?.();
    }
    item.select?.();
    item.focus?.();
    model.focusPath?.(relativePath);
    return true;
  }

  function expandLoadedAncestors(model, ancestorPaths) {
    // 这一段逐层展开已加载的父目录；未加载的目录交给后续重试等待官方懒加载完成。
    // Expand loaded parent folders step by step; unloaded folders are left for later retries after official lazy loading.
    let pending = false;
    for (const ancestorPath of ancestorPaths) {
      const item = model.getItem?.(ancestorPath);
      if (!item || !item.isDirectory?.()) {
        pending = true;
        break;
      }
      if (!item.isExpanded?.()) {
        item.expand?.();
        pending = true;
      }
    }
    return pending;
  }

  runtime.registerSystem(systemName, () => {
    const controller = new AbortController();
    runtime.lifecycle?.replaceController?.(systemName, controller);
    const { signal } = controller;
    const stateByModel = new WeakMap();
    const modelStates = new Set();
    let scanFrame = 0;

    function getModelState(model) {
      // 这一段给每个官方 FileTree model 保存本系统自己的轻量状态，避免跨树互相影响。
      // Store this system's lightweight state per official FileTree model so separate trees do not affect each other.
      let state = stateByModel.get(model);
      if (!state) {
        state = {
          applying: false,
          host: null,
          lastAppliedKey: "",
          pendingReveal: null,
          revealToken: 0,
          unsubscribeModelChanges: null,
        };
        stateByModel.set(model, state);
      }
      modelStates.add(state);
      return state;
    }

    function releaseModelState(modelState) {
      // 这一段释放不再可见的官方 model 订阅，避免切换面板或 model 替换后旧回调继续唤醒扫描。
      // Release subscriptions for no-longer-visible official models so stale callbacks do not keep waking scans.
      if (typeof modelState.unsubscribeModelChanges === "function") modelState.unsubscribeModelChanges();
      modelState.unsubscribeModelChanges = null;
      modelState.host = null;
      modelStates.delete(modelState);
    }

    function getContextPathCount(context) {
      // 这一段记录官方 paths 快照长度，用于判断失败后的定位是否真的等到了新 model 数据。
      // Track the official paths snapshot length so exhausted reveals resume only after new model data arrives.
      return Array.isArray(context.paths) ? context.paths.length : 0;
    }

    function continueActiveReveal(context, relativePath, ancestorPaths, token) {
      // 这一段在官方文件树发生变化后继续推进定位，不用固定延迟轮询懒加载结果。
      // Continue reveal after official file-tree changes, without fixed-delay polling for lazy-load results.
      const modelState = getModelState(context.model);
      if (signal.aborted || modelState.revealToken !== token || !isElementVisible(context.host)) return;
      const pendingReveal = modelState.pendingReveal;
      if (!pendingReveal || pendingReveal.relativePath !== relativePath) return;
      const currentPathCount = getContextPathCount(context);
      const targetItem = context.model.getItem?.(relativePath);
      if (pendingReveal.exhausted) {
        const hasNewModelData = currentPathCount !== pendingReveal.pathCount || Boolean(targetItem);
        if (!hasNewModelData) return;
        pendingReveal.exhausted = false;
        pendingReveal.passes = 0;
      }
      pendingReveal.pathCount = currentPathCount;
      if (!pendingReveal.exhausted) pendingReveal.passes += 1;
      const hasPendingAncestors = expandLoadedAncestors(context.model, ancestorPaths);
      const hasTarget = selectAndFocusPath(context.model, relativePath);
      if (hasTarget && !hasPendingAncestors) {
        modelState.pendingReveal = null;
        modelState.lastAppliedKey = pendingReveal.key;
        return;
      }
      if (pendingReveal.passes >= maxPendingRevealPasses) {
        pendingReveal.exhausted = true;
      }
    }

    function applyActiveReveal(context, relativePath) {
      // 这一段保留自动折叠语义：用官方 resetPaths 只保留目标父目录链展开。
      // Preserve auto-collapse semantics: use official resetPaths with only the target parent chain expanded.
      const modelState = getModelState(context.model);
      const currentItem = context.model.getItem?.(relativePath);
      if (currentItem?.isDirectory?.()) return;
      const ancestorPaths = getAncestorPaths(relativePath);
      const nextKey = [
        normalizeSlashes(context.cwd || context.root || context.workspaceRoot),
        relativePath,
      ].join("::");
      if (modelState.pendingReveal?.key === nextKey) {
        continueActiveReveal(context, relativePath, modelState.pendingReveal.ancestorPaths, modelState.revealToken);
        return;
      }
      if (modelState.applying || modelState.lastAppliedKey === nextKey) return;

      modelState.applying = true;
      modelState.revealToken += 1;
      const token = modelState.revealToken;
      modelState.pendingReveal = {
        ancestorPaths,
        exhausted: false,
        key: nextKey,
        passes: 0,
        pathCount: getContextPathCount(context),
        relativePath,
      };
      try {
        context.model.resetPaths(context.paths, { initialExpandedPaths: ancestorPaths });
        continueActiveReveal(context, relativePath, ancestorPaths, token);
      } finally {
        modelState.applying = false;
      }
    }

    function scanFileTrees() {
      // 这一段扫描当前页面可见的右侧文件树，并在活动文件变化时触发定位。
      // Scan visible right-side file trees and trigger reveal when the active file changes.
      scanFrame = 0;
      const seenModelStates = new Set();
      for (const host of document.querySelectorAll("file-tree-container")) {
        if (!isElementVisible(host)) continue;
        const context = collectFileTreeContext(host);
        if (!context) continue;
        seenModelStates.add(ensureModelSubscription(context));
        const relativePath = getActiveRelativePath(context);
        if (!relativePath) continue;
        applyActiveReveal(context, relativePath);
      }
      for (const modelState of Array.from(modelStates)) {
        if (!seenModelStates.has(modelState)) releaseModelState(modelState);
      }
    }

    function scheduleScan() {
      // 这一段按动画帧合并 DOM 变化，避免固定延迟导致文件树反复跳动。
      // Coalesce DOM changes by animation frame so fixed delays do not make the file tree jump repeatedly.
      if (scanFrame || signal.aborted) return;
      scanFrame = window.requestAnimationFrame(scanFileTrees);
    }

    function ensureModelSubscription(context) {
      // 这一段订阅官方 FileTree model 变化，覆盖懒加载只更新 model、不触发可见 DOM 变化的情况。
      // Subscribe to official FileTree model changes, covering lazy loads that update the model without visible DOM mutations.
      const modelState = getModelState(context.model);
      modelState.host = context.host;
      if (modelState.unsubscribeModelChanges !== null) return modelState;
      if (typeof context.model.subscribe !== "function") {
        modelState.unsubscribeModelChanges = false;
        return modelState;
      }
      const unsubscribe = context.model.subscribe(() => {
        scheduleScan();
      });
      modelState.unsubscribeModelChanges = typeof unsubscribe === "function" ? unsubscribe : false;
      return modelState;
    }

    function nodeTouchesRevealSurface(node) {
      // 这一段只接受文件树和右侧预览区域变化，不让聊天正文流式渲染唤醒定位。
      // Accept only file-tree and right-preview changes so chat streaming does not wake reveal.
      if (!(node instanceof Element)) return false;
      const selector = [
        "file-tree-container",
        "[role='tabpanel'][data-app-shell-tab-panel-controller='right']",
        "[data-app-shell-tab-controller='right']",
        ".diffs-container",
      ].join(",");
      return Boolean(node.matches?.(selector) || node.closest?.(selector) || node.querySelector?.(selector));
    }

    function mutationTouchesRevealSurface(mutation) {
      // 这一段用结构选择器识别定位相关变化，覆盖右侧 tab 切换和文件树懒加载。
      // Identify reveal-related changes structurally, covering right-tab switches and file-tree lazy loading.
      const target = mutation.target instanceof Element ? mutation.target : mutation.target?.parentElement;
      if (target instanceof Element && target !== document.body && target !== document.documentElement) {
        if (nodeTouchesRevealSurface(target)) return true;
      }
      return [...mutation.addedNodes, ...mutation.removedNodes].some((node) => {
        if (!(node instanceof Element)) return false;
        return nodeTouchesRevealSurface(node);
      });
    }

    const observer = new MutationObserver((mutations) => {
      if (mutations.some(mutationTouchesRevealSurface)) scheduleScan();
    });
    observer.observe(document.body, {
      attributeFilter: ["aria-expanded", "aria-selected", "class", "data-state", "hidden", "style"],
      attributes: true,
      childList: true,
      subtree: true,
    });
    scanFileTrees();

    signal.addEventListener(
      "abort",
      () => {
        // 这一段清理本系统的观察器和定时器，重复注入或设置关闭时不留下后台任务。
        // Clean up this system's observer and timers so reinjection or disabling leaves no background tasks.
        observer.disconnect();
        if (scanFrame) window.cancelAnimationFrame(scanFrame);
        for (const modelState of Array.from(modelStates)) {
          releaseModelState(modelState);
        }
      },
      { once: true },
    );
  }, { enableSetting: "enableFileTreeActiveReveal" });
})();
