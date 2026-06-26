(() => {
  // 这一段是悬浮预览系统入口，依赖当前 Codex turn 和环境面板的 diff 元数据。
  // This is the hover-preview system entrypoint, backed by current Codex turn and environment-panel diff metadata.
  const runtime = window.__codexProRuntime;
  if (!runtime) return;
  const i18n = runtime.i18n;

  const systemName = "diff-hover-preview";
  const styleId = "codex-pro-diff-hover-preview-style";
  const panelId = "codex-pro-diff-hover-preview";
  const navigationId = "codex-pro-diff-hover-navigation";
  const summaryAttribute = "data-codex-pro-diff-hover-summary";
  const fiberPrefix = "__reactFiber$";
  const aboveComposerPortalId = "above-composer-portal";
  const environmentSectionKey = "environment";
  const maxFiles = 100;
  const hideDelayMs = 140;
  const workspaceFileModulePattern = /(?:assets\/)?open-workspace-file-[A-Za-z0-9_-]+\.js/u;
  const reviewNavigationModulePattern = /(?:assets\/)?review-navigation-model-[A-Za-z0-9_-]+\.js/u;
  const reviewSidePanelTabsModulePattern = /(?:assets\/)?thread-side-panel-tabs-[A-Za-z0-9_-]+\.js/u;
  const workspaceFileModuleFallbackPaths = [
    "./assets/open-workspace-file-CJcJ-CWR.js",
    "./assets/open-workspace-file-CQYIHLHN.js",
  ];
  const reviewNavigationModuleFallbackPaths = [
    "./assets/review-navigation-model-CjSNogLO.js",
  ];
  const reviewSidePanelTabsModuleFallbackPaths = [
    "./assets/thread-side-panel-tabs-D_LOwjfa.js",
  ];
  const routeScopeHostSelectors = ["file-tree-container", "aside", "main", "nav", "#root"];
  const maxScopeObjectDepth = 7;
  const maxScopeObjectKeys = 80;
  const maxEnvironmentAncestorDepth = 10;
  const maxEnvironmentDiffCandidates = 12;
  const maxEnvironmentFiberDepth = 80;
  const maxEditedFileCardAncestorDepth = 8;
  const maxEditedFileCardFiberDepth = 16;
  const maxSummaryAncestorDepth = 8;
  const reviewSingleFileScopeTimeoutMs = 1800;
  const reviewSingleFileScopePollMs = 80;
  const reviewScopeHiddenAttribute = "data-codex-pro-review-scope-hidden";
  const reviewScopePreviousDisplayAttribute = "data-codex-pro-review-scope-prev-display";
  const reviewFileToggleAttribute = "data-app-action-review-file-toggle";
  const reviewFileExpandedAttribute = "data-app-action-review-file-expanded";
  const environmentReviewSingleFileScopeTimeoutMs = 6000;
  const minBottomSummaryGapPx = 0;
  const maxBottomSummaryGapPx = 760;
  const environmentGitRefreshTtlMs = 1800;
  const maxEnvironmentGitRefreshCacheEntries = 8;
  let workspaceFileModulePromise = null;
  let workspaceFileModulePathPromise = null;
  let reviewNavigationModulePromise = null;
  let reviewNavigationModulePathPromise = null;
  let reviewSidePanelTabsModulePromise = null;
  let reviewSidePanelTabsModulePathPromise = null;
  let environmentReviewSingleFileScopeCleanup = null;
  const parsedDiffCache = new Map();
  const navigationApi = runtime.systemModules.diffHoverPreviewNavigation || {
    findWorkspaceRouteScope: () => null,
    firstNavigationRange: () => null,
    getPreviewNavigationPlacement: () => null,
    normalizeNavigationRanges: () => [],
    parseUnifiedDiffNavigationRanges: () => new Map(),
  };

  function installStyles() {
    // 这一段安装悬浮面板样式，尽量复用 Codex 原生面板的暗色、边框和小字号。
    // Install hover panel styles that stay close to Codex's native dark panel, border, and compact text.
    runtime.dom.ensureNativePanelTokens?.();
    runtime.dom.upsertStyle(
      styleId,
      `
        #${panelId} {
          position: fixed;
          left: 0;
          top: 0;
          z-index: 2147483590;
          width: min(640px, calc(100vw - 24px));
          max-height: min(420px, calc(100vh - 120px));
          box-sizing: border-box;
          display: grid;
          grid-template-rows: auto minmax(0, 1fr);
          overflow: hidden;
          border: 1px solid var(--codex-pro-native-panel-border);
          border-radius: var(--codex-pro-native-panel-radius-medium);
          background: var(--codex-pro-native-panel-surface);
          background-clip: padding-box;
          color: var(--codex-pro-native-panel-foreground);
          box-shadow: var(--codex-pro-native-panel-shadow);
          --codex-pro-diff-hover-font-size: var(--vscode-editor-font-size, var(--codex-chat-code-font-size, 12px));
          font-family: var(--codex-pro-native-panel-font-family);
          font-size: var(--codex-pro-diff-hover-font-size);
          line-height: 1.45;
          pointer-events: auto;
          -webkit-app-region: no-drag;
          -webkit-backdrop-filter: blur(var(--codex-pro-native-panel-blur));
          backdrop-filter: blur(var(--codex-pro-native-panel-blur));
        }
        #${panelId}[hidden] {
          display: none;
        }
        #${panelId} .codex-pro-diff-hover-header {
          display: flex;
          align-items: baseline;
          justify-content: space-between;
          gap: 12px;
          min-width: 0;
          padding: 10px 12px 8px;
          border-bottom: 1px solid var(--codex-pro-native-panel-border-soft);
        }
        #${panelId} .codex-pro-diff-hover-title {
          min-width: 0;
          color: var(--codex-pro-native-panel-foreground);
          font-weight: 650;
          overflow: hidden;
          text-overflow: ellipsis;
          white-space: nowrap;
        }
        #${panelId} .codex-pro-diff-hover-total {
          flex: 0 0 auto;
          display: inline-flex;
          align-items: center;
          gap: 6px;
          font-family: ui-monospace, SFMono-Regular, Consolas, "Liberation Mono", monospace;
          font-size: var(--codex-pro-diff-hover-font-size);
          line-height: 1.3;
        }
        #${panelId} .codex-pro-diff-hover-additions {
          color: #49d17d;
        }
        #${panelId} .codex-pro-diff-hover-deletions {
          color: #ff6b6b;
        }
        #${panelId} .codex-pro-diff-hover-list {
          min-height: 0;
          overflow-y: auto;
          padding: 4px;
        }
        #${panelId} .codex-pro-diff-hover-row {
          width: 100%;
          min-width: 0;
          min-height: 34px;
          display: grid;
          grid-template-columns: minmax(0, 1fr) auto auto 28px;
          align-items: center;
          gap: 10px;
          border: 0;
          border-radius: 7px;
          background: transparent;
          color: inherit;
          font: inherit;
          text-align: left;
          padding: 6px 8px;
        }
        #${panelId} .codex-pro-diff-hover-row:hover,
        #${panelId} .codex-pro-diff-hover-row:focus-visible {
          background: var(--codex-pro-native-panel-hover);
          outline: none;
        }
        #${panelId} .codex-pro-diff-hover-row[role="button"] {
          cursor: pointer;
        }
        #${panelId} .codex-pro-diff-hover-path {
          min-width: 0;
          overflow: hidden;
          text-overflow: ellipsis;
          white-space: nowrap;
          font-family: ui-monospace, SFMono-Regular, Consolas, "Liberation Mono", monospace;
        }
        #${panelId} .codex-pro-diff-hover-kind {
          flex: 0 0 auto;
          color: var(--codex-pro-native-panel-muted);
          font-size: var(--codex-pro-diff-hover-font-size);
        }
        #${panelId} .codex-pro-diff-hover-stats {
          flex: 0 0 auto;
          display: inline-flex;
          justify-content: flex-end;
          gap: 6px;
          min-width: 72px;
          font-family: ui-monospace, SFMono-Regular, Consolas, "Liberation Mono", monospace;
          font-size: var(--codex-pro-diff-hover-font-size);
          line-height: 1.3;
        }
        #${panelId} .codex-pro-diff-hover-external-diff-button {
          width: 26px;
          height: 26px;
          display: grid;
          place-items: center;
          border: 1px solid var(--codex-pro-native-panel-border);
          border-radius: var(--codex-pro-native-panel-radius-inner);
          background: transparent;
          color: var(--codex-pro-native-panel-muted);
          padding: 0;
        }
        #${panelId} .codex-pro-diff-hover-external-diff-button:hover,
        #${panelId} .codex-pro-diff-hover-external-diff-button:focus-visible {
          background: var(--codex-pro-native-panel-hover);
          color: var(--codex-pro-native-panel-foreground);
          outline: none;
        }
        #${panelId} .codex-pro-diff-hover-external-diff-button[aria-disabled="true"] {
          opacity: .42;
        }
        #${panelId} .codex-pro-diff-hover-external-diff-button svg {
          width: 14px;
          height: 14px;
          display: block;
        }
        [${summaryAttribute}="true"] {
          cursor: default;
        }
        #${navigationId} {
          position: fixed;
          z-index: 2147483588;
          width: 40px;
          min-height: 112px;
          display: inline-flex;
          flex-direction: column;
          align-items: center;
          justify-content: center;
          gap: 5px;
          box-sizing: border-box;
          padding: 6px 5px;
          border: 1px solid var(--codex-pro-native-panel-border);
          border-radius: var(--codex-pro-native-panel-radius-small);
          background: var(--codex-pro-native-panel-surface);
          background-clip: padding-box;
          color: var(--codex-pro-native-panel-foreground);
          box-shadow: var(--codex-pro-native-panel-shadow-compact);
          font-family: ui-monospace, SFMono-Regular, Consolas, "Liberation Mono", monospace;
          font-size: 12px;
          line-height: 1.2;
          pointer-events: auto;
          -webkit-app-region: no-drag;
          -webkit-backdrop-filter: blur(var(--codex-pro-native-panel-blur));
          backdrop-filter: blur(var(--codex-pro-native-panel-blur));
        }
        #${navigationId}[hidden] {
          display: none;
        }
        #${navigationId} button {
          width: 28px;
          height: 28px;
          display: grid;
          place-items: center;
          border: 1px solid var(--codex-pro-native-panel-border);
          border-radius: var(--codex-pro-native-panel-radius-inner);
          background: transparent;
          color: inherit;
          font: inherit;
          padding: 0;
        }
        #${navigationId} button:not(:disabled):hover,
        #${navigationId} button:not(:disabled):focus-visible {
          background: var(--codex-pro-native-panel-hover);
          outline: none;
        }
        #${navigationId} button:disabled {
          opacity: .38;
          cursor: default;
        }
        #${navigationId} .codex-pro-diff-navigation-count {
          min-width: 0;
          min-height: 34px;
          display: grid;
          place-items: center;
          white-space: pre;
          text-align: center;
          color: var(--codex-pro-native-panel-muted);
          line-height: 1.05;
        }
      `,
    );
  }

  function getReactFiber(element) {
    // 这一段从 DOM 节点读取 React fiber 私有字段，只用于定位当前 turn 的 diff 元数据。
    // Read React's private fiber field from a DOM node only to locate the current turn diff metadata.
    if (!(element instanceof Element)) return null;
    const key = Object.getOwnPropertyNames(element).find((name) => name.startsWith(fiberPrefix));
    return key ? element[key] : null;
  }

  function parseUnifiedDiffPath(value) {
    // 这一段从 unified diff 的文件头里提取路径，去掉 a/、b/ 和 /dev/null 这些标记。
    // Extract a path from unified diff file headers, removing a/, b/, and /dev/null markers.
    const token = String(value || "").trim().split(/\t/)[0];
    if (!token || token === "/dev/null") return "";
    return normalizePath(token.replace(/^"?[ab]\//, "").replace(/^"|"$/g, ""));
  }

  function finalizeParsedFile(files, file, navigationRangesByPath = new Map()) {
    // 这一段把正在解析的 diff 文件段落收束成统一的文件对象。
    // Finalize one parsed diff section into the normalized file object shape.
    if (!file) return;
    const path = file.path || file.previousPath;
    if (!path) return;
    const isAdded = !file.previousPath && Boolean(file.path);
    const isDeleted = Boolean(file.previousPath) && !file.path;
    const isRenamed = Boolean(file.previousPath && file.path && file.previousPath !== file.path);
    files.push({
      additions: file.additions,
      changeKind: isAdded ? "added" : isDeleted ? "deleted" : isRenamed ? "renamed" : "modified",
      deletions: file.deletions,
      navigationRanges: navigationRangesByPath.get(path) || [],
      path,
      previousPath: isRenamed || isDeleted ? file.previousPath : "",
      revision: "",
    });
  }

  function parseUnifiedDiff(diffText) {
    // 这一段把 Codex 当前 turn 上的 unified diff 字符串解析成 files[]，作为官方 diff summary 对象的兜底。
    // Parse the current Codex turn unified diff string into files[] as a fallback for the official diff summary object.
    const source = typeof diffText === "string" ? diffText : "";
    if (!source.trim()) return null;
    if (parsedDiffCache.has(source)) return parsedDiffCache.get(source);
    if (parsedDiffCache.size > 12) parsedDiffCache.clear();

    const navigationRangesByPath = navigationApi.parseUnifiedDiffNavigationRanges(source);
    const files = [];
    let currentFile = null;
    let inHunk = false;
    for (const line of source.split(/\r?\n/)) {
      if (line.startsWith("diff --git ")) {
        finalizeParsedFile(files, currentFile, navigationRangesByPath);
        currentFile = { additions: 0, deletions: 0, path: "", previousPath: "" };
        inHunk = false;
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
      if (line.startsWith("@@")) {
        inHunk = true;
        continue;
      }
      if (!inHunk) continue;
      if (line.startsWith("+") && !line.startsWith("+++")) {
        currentFile.additions += 1;
        continue;
      }
      if (line.startsWith("-") && !line.startsWith("---")) {
        currentFile.deletions += 1;
      }
    }
    finalizeParsedFile(files, currentFile, navigationRangesByPath);

    const result = files.length > 0 ? { files, type: "success" } : null;
    parsedDiffCache.set(source, result);
    return result;
  }

  function normalizeDiffCandidate(candidate) {
    // 这一段兼容对象版 diff summary 和字符串版 unified diff 两种 Codex 数据入口。
    // Support both object diff summaries and string unified diffs from Codex turn props.
    if (candidate && Array.isArray(candidate.files)) return candidate;
    if (typeof candidate === "string" && candidate.includes("diff --git ")) return parseUnifiedDiff(candidate);
    return null;
  }

  function getDiffFromProps(props) {
    // 这一段兼容 Codex 不同组件层的 props 命名，优先读取真实 React diff 数据而不是界面文字。
    // Support several Codex prop shapes, preferring real React diff data over visible UI text.
    const candidates = [
      props?.mcpTurn?.diff,
      props?.turn?.diff,
      props?.entry?.turn?.diff,
      props?.item?.turn?.diff,
      props?.item?.diff,
      props?.item?.unifiedDiff,
      props?.unifiedDiffItem?.diff,
      props?.unifiedDiffItem?.unifiedDiff,
      props?.diff,
    ];
    for (const candidate of candidates) {
      const diff = normalizeDiffCandidate(candidate);
      if (diff) return diff;
    }
    return null;
  }

  function getTurnIdFromProps(props) {
    // 这一段提取稳定 turn id，避免同一个摘要行在重复扫描时被错误合并。
    // Extract a stable turn id so repeated scans do not merge unrelated summary rows.
    return props?.mcpTurn?.id ||
      props?.turn?.id ||
      props?.entry?.turn?.id ||
      props?.item?.turn?.id ||
      props?.item?.turnId ||
      props?.item?.id ||
      props?.unifiedDiffItem?.turnId ||
      props?.unifiedDiffItem?.id ||
      "";
  }

  function normalizeCwd(value) {
    // 这一段保留 Codex 原生 Windows cwd 形态，只做空白和长度保护。
    // Preserve Codex's native Windows cwd shape while only trimming and bounding length.
    return String(value || "").trim().slice(0, 500);
  }

  function readWorkspaceContextFromProps(props) {
    // 这一段从 turn 相关 props 里提取 cwd/hostId/conversationId，供原生右侧文件预览入口使用。
    // Extract cwd/hostId/conversationId from turn props for the native right-side file preview entry.
    return {
      conversationId: String(props?.conversationId || props?.turn?.conversationId || props?.mcpTurn?.conversationId || ""),
      cwd: normalizeCwd(props?.cwd || props?.item?.cwd || props?.unifiedDiffItem?.cwd || props?.turn?.cwd || props?.mcpTurn?.cwd),
      hostId: String(props?.hostId || props?.item?.hostId || props?.unifiedDiffItem?.hostId || props?.turn?.hostId || props?.mcpTurn?.hostId || ""),
    };
  }

  function mergeWorkspaceContext(current, next) {
    // 这一段沿 fiber 父链保留最早拿到的 workspace 上下文，避免 diff 和 cwd 分散在不同层级时丢失。
    // Preserve the first workspace context found along the fiber chain when diff and cwd live on different levels.
    return {
      conversationId: current.conversationId || next.conversationId || "",
      cwd: current.cwd || next.cwd || "",
      hostId: current.hostId || next.hostId || "",
    };
  }

  function readTurnDiff(element) {
    // 这一段沿 React fiber 父链向上找 turn props，避免扫描页面全局状态或请求额外数据。
    // Walk the React fiber return chain to find turn props without scanning global state or fetching extra data.
    let fiber = getReactFiber(element);
    let workspaceContext = { conversationId: "", cwd: "", hostId: "" };
    for (let depth = 0; fiber && depth < 80; depth += 1) {
      const props = fiber.memoizedProps || fiber.pendingProps;
      workspaceContext = mergeWorkspaceContext(workspaceContext, readWorkspaceContextFromProps(props));
      const diff = getDiffFromProps(props);
      if (diff) return { diff, turnId: getTurnIdFromProps(props), ...workspaceContext };
      fiber = fiber.return;
    }
    return null;
  }

  function normalizeNumber(value) {
    // 这一段把 additions/deletions 规整成非负整数，缺失字段显示为 0。
    // Normalize additions/deletions into non-negative integers, showing missing fields as zero.
    const number = Number(value);
    if (!Number.isFinite(number)) return 0;
    return Math.max(0, Math.round(number));
  }

  function normalizePath(value) {
    // 这一段统一路径分隔符并限制长度，避免异常长字符串撑坏悬浮面板。
    // Normalize path separators and cap length so unusually long strings cannot break the hover panel.
    return String(value || "")
      .replace(/\\/g, "/")
      .replace(/^\.\//, "")
      .trim()
      .slice(0, 500);
  }

  function getKindLabel(file) {
    // 这一段把 Codex diff 的 changeKind 转成短标签，未知类型保持“修改”。
    // Convert Codex diff changeKind into a short label, falling back to "modified" for unknown kinds.
    const kind = String(file?.changeKind || "").toLowerCase();
    if (kind.includes("add") || kind === "created") return i18n.t("diff.kind.added");
    if (kind.includes("delete") || kind === "removed") return i18n.t("diff.kind.deleted");
    if (kind.includes("rename") || file?.previousPath) return i18n.t("diff.kind.renamed");
    return i18n.t("diff.kind.modified");
  }

  function normalizeFile(file) {
    // 这一段只保留文件路径、旧路径和行数统计，不读取或展示文件内容。
    // Keep only file paths, previous paths, and line counts without reading or showing file contents.
    const path = normalizePath(file?.path || file?.displayPath || file?.name);
    if (!path) return null;
    const previousPath = normalizePath(file?.previousPath);
    return {
      additions: normalizeNumber(file?.additions),
      changeKind: String(file?.changeKind || "").slice(0, 40),
      deletions: normalizeNumber(file?.deletions),
      kind: getKindLabel(file),
      navigationRanges: navigationApi.normalizeNavigationRanges(file?.navigationRanges),
      path,
      previousPath,
      revision: String(file?.revision || ""),
    };
  }

  function normalizeNonNullDiffPath(value) {
    // 这一段把官方 diff 里的 /dev/null 侧收敛为空，避免把它当作工作区文件路径。
    // Collapse /dev/null sides from official diffs to empty so they are not treated as workspace paths.
    const path = normalizePath(value);
    return path === "/dev/null" ? "" : path;
  }

  function inferEditedFileCardChangeKind(diff, path, previousPath) {
    // 这一段从官方单文件 diff 元数据推断外部 Diff 需要的新增/删除/重命名语义。
    // Infer the added/deleted/renamed semantics needed by external Diff from the official single-file diff metadata.
    const rawType = String(diff?.metadata?.type || diff?.changeKind || diff?.kind || "").toLowerCase();
    const oldPath = normalizeNonNullDiffPath(diff?.oldPath);
    const newPath = normalizeNonNullDiffPath(diff?.newPath);
    if (rawType.includes("new") || rawType.includes("add") || rawType.includes("create")) return "added";
    if (rawType.includes("delete") || rawType.includes("remove")) return "deleted";
    if (rawType.includes("rename") || rawType.includes("move")) return "renamed";
    if (oldPath && newPath && oldPath !== newPath) return "renamed";
    if (!oldPath && newPath) return "added";
    if (oldPath && !newPath) return "deleted";
    return previousPath && previousPath !== path ? "renamed" : "modified";
  }

  function normalizeEditedFileCardFile(props) {
    // 这一段把 Codex 官方“已编辑文件”卡片的单行 props 转成外部 Diff 复用的文件对象。
    // Convert one official edited-file card row's props into the file object reused by external Diff.
    const diff = props?.diff && typeof props.diff === "object" ? props.diff : {};
    const oldPath = normalizeNonNullDiffPath(diff.oldPath);
    const newPath = normalizeNonNullDiffPath(diff.newPath);
    const path = normalizePath(props?.path || props?.displayPath || newPath || oldPath || diff?.metadata?.name);
    if (!path) return null;
    const inferredPreviousPath = oldPath && oldPath !== path ? oldPath : "";
    const changeKind = inferEditedFileCardChangeKind(diff, path, inferredPreviousPath);
    const previousPath = changeKind === "renamed" ? inferredPreviousPath : "";
    return {
      additions: normalizeNumber(props?.linesAdded ?? diff.additions),
      changeKind,
      deletions: normalizeNumber(props?.linesRemoved ?? diff.deletions),
      kind: getKindLabel({ changeKind, previousPath }),
      navigationRanges: [],
      path,
      previousPath,
      revision: String(diff?.metadata?.prevObjectId || ""),
    };
  }

  function isEditedFileCardFileProps(props) {
    // 这一段只接受官方已编辑文件卡片里的单文件行 props，不用界面文案或按钮文字做判断。
    // Accept only the official edited-file card's per-file row props, without relying on visible copy.
    return Boolean(
      props &&
      typeof props === "object" &&
      typeof props.onOpen === "function" &&
      typeof props.path === "string" &&
      props.diff &&
      typeof props.diff === "object" &&
      !Array.isArray(props.diff) &&
      props.disabled !== true,
    );
  }

  function readEditedFileCardExternalDiffTarget(element) {
    // 这一段沿官方文件行的 React fiber 读取 cwd/path/diff，形成中键外部 Diff 的最小结构化目标。
    // Walk the official file row's React fiber to read cwd/path/diff and build the minimal external-Diff target.
    let fiber = getReactFiber(element);
    let workspaceContext = { conversationId: "", cwd: "", hostId: "" };
    for (let depth = 0; fiber && depth < maxEditedFileCardFiberDepth; depth += 1) {
      const props = fiber.memoizedProps || fiber.pendingProps;
      workspaceContext = mergeWorkspaceContext(workspaceContext, readWorkspaceContextFromProps(props));
      if (isEditedFileCardFileProps(props)) {
        const file = normalizeEditedFileCardFile(props);
        const cwd = normalizeCwd(props.cwd) || workspaceContext.cwd;
        if (!file || !cwd) return null;
        const hostId = String(props.hostId || workspaceContext.hostId || "local");
        return {
          button: element,
          file,
          summary: {
            conversationId: workspaceContext.conversationId,
            cwd,
            files: [file],
            hiddenCount: 0,
            hostId,
            signature: ["edited-file-card", cwd, hostId, file.path, file.additions, file.deletions, file.changeKind].join("::"),
            totals: {
              additions: file.additions,
              deletions: file.deletions,
            },
            turnId: "",
            visibleFiles: [file],
          },
        };
      }
      fiber = fiber.return;
    }
    return null;
  }

  function normalizeTotalsOverride(value) {
    // 这一段只接受环境面板提供的官方总增删统计，用于显示 header 而不改文件列表。
    // Accept only official total line stats from the environment panel for header display without changing file rows.
    if (!value || typeof value !== "object") return null;
    return {
      additions: normalizeNumber(value.additions),
      deletions: normalizeNumber(value.deletions),
    };
  }

  function buildSummary(turnDiff) {
    // 这一段汇总当前 turn 的文件列表和总增删行数，供摘要行 hover 渲染。
    // Summarize the current turn file list and total line counts for hover rendering.
    const files = (turnDiff?.diff?.files || [])
      .map(normalizeFile)
      .filter(Boolean);
    if (files.length === 0) return null;
    const visibleFiles = files.slice(0, maxFiles);
    const parsedTotals = files.reduce((totals, file) => ({
      additions: totals.additions + file.additions,
      deletions: totals.deletions + file.deletions,
    }), { additions: 0, deletions: 0 });
    return {
      files,
      hiddenCount: Math.max(0, files.length - visibleFiles.length),
      signature: [
        turnDiff.turnId,
        turnDiff.cwd,
        turnDiff.hostId,
        files.map((file) => {
          const ranges = file.navigationRanges.map((range) => `${range.line}-${range.endLine}`).join(",");
          return `${file.path}:${file.additions}:${file.deletions}:${file.revision}:${ranges}`;
        }).join("|"),
      ].join("::"),
      conversationId: turnDiff.conversationId || "",
      cwd: turnDiff.cwd || "",
      hostId: turnDiff.hostId || "local",
      turnId: turnDiff.turnId,
      totals: normalizeTotalsOverride(turnDiff?.totalsOverride) || parsedTotals,
      visibleFiles,
    };
  }

  function readDiffStatsFromProps(props) {
    // 这一段读取右上角环境面板“变更”行只暴露的统计数据，用它校验扫描到的 diff。
    // Read the stats exposed by the top-right environment-panel Changes row to validate scanned diffs.
    const stats = props?.diffStats;
    if (!stats || typeof stats !== "object") return null;
    const fileCount = normalizeNumber(stats.fileCount);
    if (fileCount <= 0) return null;
    return {
      additions: normalizeNumber(stats.additions),
      deletions: normalizeNumber(stats.deletions),
      fileCount,
    };
  }

  function summaryMatchesStats(summary, stats) {
    // 这一段要求文件数和总增删行数都匹配环境面板统计，避免误用历史命令或旧 turn 的 diff。
    // Require file count and total line counts to match environment stats so old command or turn diffs are ignored.
    if (!summary || !stats) return false;
    return (
      summary.files.length === stats.fileCount &&
      summary.totals.additions === stats.additions &&
      summary.totals.deletions === stats.deletions
    );
  }

  function summaryFileCountMatchesStats(summary, stats) {
    // 这一段作为环境面板统计短暂滞后时的兜底，仍要求文件数量完全一致。
    // Use this as a fallback when environment-panel line stats lag, while still requiring exact file count.
    return Boolean(summary && stats && summary.files.length === stats.fileCount);
  }

  function collectDiffCandidates(value, candidates, seenObjects, depth = 0) {
    // 这一段在环境面板附近做有界对象扫描，只收集能解析成 files[] 的 diff 候选。
    // Perform a bounded object scan near the environment panel, collecting only candidates parseable into files[].
    if (!value || candidates.length >= maxEnvironmentDiffCandidates || depth > maxScopeObjectDepth) return;
    const diff = normalizeDiffCandidate(value);
    if (diff) {
      candidates.push(diff);
      return;
    }
    if (typeof value !== "object" && typeof value !== "function") return;
    if (typeof value === "object") {
      if (seenObjects.has(value)) return;
      seenObjects.add(value);
    }

    if (value instanceof Map && depth < 4) {
      let index = 0;
      for (const [key, child] of value) {
        collectDiffCandidates(key, candidates, seenObjects, depth + 1);
        collectDiffCandidates(child, candidates, seenObjects, depth + 1);
        index += 1;
        if (index >= maxScopeObjectKeys || candidates.length >= maxEnvironmentDiffCandidates) break;
      }
      return;
    }

    if (Array.isArray(value)) {
      for (const child of value.slice(0, maxScopeObjectKeys)) {
        collectDiffCandidates(child, candidates, seenObjects, depth + 1);
        if (candidates.length >= maxEnvironmentDiffCandidates) break;
      }
      return;
    }

    for (const key of Object.keys(value).slice(0, maxScopeObjectKeys)) {
      let child = null;
      try {
        child = value[key];
      } catch {
        continue;
      }
      collectDiffCandidates(child, candidates, seenObjects, depth + 1);
      if (candidates.length >= maxEnvironmentDiffCandidates) break;
    }
  }

  function readEnvironmentDiffData(anchor) {
    // 这一段从环境信息面板的 React 父链读取 workspace 上下文、统计和可见 diff 候选。
    // Read workspace context, stats, and visible diff candidates from the environment panel fiber chain.
    let fiber = getReactFiber(anchor);
    let workspaceContext = { conversationId: "", cwd: "", hostId: "" };
    let diffStats = null;
    let isEnvironmentSection = false;
    let turnId = "";
    const candidates = [];
    const seenObjects = new WeakSet();

    for (let depth = 0; fiber && depth < maxEnvironmentFiberDepth; depth += 1) {
      const props = fiber.memoizedProps || fiber.pendingProps;
      workspaceContext = mergeWorkspaceContext(workspaceContext, readWorkspaceContextFromProps(props));
      diffStats ||= readDiffStatsFromProps(props);
      isEnvironmentSection ||= props?.sectionKey === environmentSectionKey;
      turnId ||= getTurnIdFromProps(props);
      collectDiffCandidates(props, candidates, seenObjects);
      collectDiffCandidates(fiber.memoizedState, candidates, seenObjects);
      collectDiffCandidates(fiber.updateQueue, candidates, seenObjects);
      collectDiffCandidates(fiber.dependencies, candidates, seenObjects);
      fiber = fiber.return;
    }
    return {
      ...workspaceContext,
      candidates,
      diffStats,
      isEnvironmentSection,
      turnId,
    };
  }

  function readEnvironmentAnchorMetadata(anchor) {
    // 这一段轻量读取环境行的 fiber 元数据，用于定位和摆放时避免扫描候选 diff 对象。
    // Read lightweight environment-row fiber metadata for matching and placement without scanning candidate diff objects.
    let fiber = getReactFiber(anchor);
    let workspaceContext = { conversationId: "", cwd: "", hostId: "" };
    let diffStats = null;
    let isEnvironmentSection = false;
    let turnId = "";

    for (let depth = 0; fiber && depth < maxEnvironmentFiberDepth; depth += 1) {
      const props = fiber.memoizedProps || fiber.pendingProps;
      workspaceContext = mergeWorkspaceContext(workspaceContext, readWorkspaceContextFromProps(props));
      diffStats ||= readDiffStatsFromProps(props);
      isEnvironmentSection ||= props?.sectionKey === environmentSectionKey;
      turnId ||= getTurnIdFromProps(props);
      fiber = fiber.return;
    }
    return {
      ...workspaceContext,
      diffStats,
      isEnvironmentSection,
      turnId,
    };
  }

  function buildEnvironmentTurnDiffFromData(data) {
    // 这一段用环境面板统计挑选同一父链里的 diff；找不到时交给 Git fallback。
    // Select a diff from the same parent chain using environment stats; missing data falls through to the Git fallback.
    if (!data) return null;
    let fileCountMatchedTurnDiff = null;
    for (const diff of data.candidates || []) {
      const summary = buildSummary({ diff, turnId: data.turnId, ...data });
      if (summaryMatchesStats(summary, data.diffStats)) {
        return { diff, totalsOverride: data.diffStats, ...data };
      }
      if (!fileCountMatchedTurnDiff && summaryFileCountMatchesStats(summary, data.diffStats)) {
        fileCountMatchedTurnDiff = { diff, totalsOverride: data.diffStats, ...data };
      }
    }
    return fileCountMatchedTurnDiff;
  }

  function readEnvironmentTurnDiff(anchor) {
    // 这一段从环境信息面板读取可直接渲染的 diff；只处理 React 当前仍持有的候选数据。
    // Read a directly renderable environment-panel diff, using only candidates still held by React.
    return buildEnvironmentTurnDiffFromData(readEnvironmentDiffData(anchor));
  }

  function isVisibleCompactElement(element) {
    // 这一段过滤不可见或过大的节点，减少扫描成本并避开完整消息正文。
    // Filter invisible or oversized nodes to reduce scanning cost and avoid full message bodies.
    const rect = element.getBoundingClientRect();
    if (rect.width < 80 || rect.height < 16 || rect.height > 76) return false;
    const style = window.getComputedStyle(element);
    return style.visibility !== "hidden" && style.display !== "none" && Number(style.opacity) !== 0;
  }

  function isEnvironmentDiffAnchor(element) {
    // 这一段识别右上角环境面板的变更行，优先使用 fiber 里的 diffStats 和 environment sectionKey。
    // Identify the top-right environment Changes row, preferring fiber diffStats plus the environment sectionKey.
    return isEnvironmentDiffAnchorWithData(element, readEnvironmentAnchorMetadata(element));
  }

  function isEnvironmentDiffAnchorWithData(element, data) {
    // 这一段只接受带环境 sectionKey 和 diffStats 的结构化行，不用界面文案做兜底。
    // Accept only structured rows with environment sectionKey and diffStats; UI copy is not a fallback.
    if (!(element instanceof HTMLElement)) return false;
    if (element.getAttribute("role") !== "button") return false;
    if (!isVisibleCompactElement(element)) return false;
    return Boolean(data?.diffStats && data.isEnvironmentSection);
  }

  function findAboveComposerPortal(element) {
    // 这一段沿父链确认触发点来自输入框上方的官方 portal，而不是聊天历史里的相似摘要。
    // Walk ancestors to confirm the trigger comes from the official above-composer portal, not similar chat history.
    for (let current = element; current && current !== document.body; current = current.parentElement) {
      if (current.id === aboveComposerPortalId) return current;
    }
    return null;
  }

  function getDiffHoverPanelRoots() {
    // 这一段收集当前页面上所有同 ID 悬浮面板，兼容热注入前旧版本留下的 DOM。
    // Collect all same-id hover panels so hot reinjection can clean DOM left by older versions.
    return Array.from(document.querySelectorAll(`#${panelId}`))
      .filter((node) => node instanceof HTMLElement);
  }

  function clearSummaryMarks(except = null) {
    // 这一段清理旧版本或旧锚点留下的摘要标记，只保留当前真实按钮锚点。
    // Clear stale summary markers from older versions or anchors, keeping only the current real button anchor.
    for (const node of document.querySelectorAll(`[${summaryAttribute}="true"]`)) {
      if (node !== except) node.removeAttribute(summaryAttribute);
    }
  }

  function hideDiffHoverPanelRoots() {
    // 这一段隐藏所有同 ID 悬浮面板，避免旧匿名监听在无效区域弹出后残留。
    // Hide all same-id hover panels so stale anonymous listeners cannot leave a panel visible on invalid areas.
    for (const root of getDiffHoverPanelRoots()) root.hidden = true;
  }

  function removeDuplicatePanelRoots(keep) {
    // 这一段删除重复面板节点，只保留当前系统接管的一个根节点。
    // Remove duplicate panel roots and keep the one controlled by the current system.
    for (const root of getDiffHoverPanelRoots()) {
      if (root !== keep) root.remove();
    }
  }

  function getElementRect(element) {
    // 这一段读取元素位置并过滤不可见节点，供底部输入区限定逻辑复用。
    // Read an element rect and filter invisible nodes for the bottom-composer guard.
    if (!(element instanceof HTMLElement)) return null;
    const rect = element.getBoundingClientRect();
    if (rect.width <= 0 || rect.height <= 0) return null;
    const style = window.getComputedStyle(element);
    if (style.visibility === "hidden" || style.display === "none" || Number(style.opacity) === 0) return null;
    return rect;
  }

  function getBottomComposerRect() {
    // 这一段只查找输入控件本身，不扫描聊天正文，用它限定“底部修改摘要”的有效区域。
    // Locate only the composer/editor control, not message content, to bound the bottom diff summary area.
    let bottomRect = null;
    for (const element of document.querySelectorAll(".ProseMirror, textarea, [contenteditable='true'], input")) {
      const rect = getElementRect(element);
      if (!rect) continue;
      if (!bottomRect || rect.bottom > bottomRect.bottom) bottomRect = rect;
    }
    return bottomRect;
  }

  function hasHorizontalOverlap(leftRect, rightRect) {
    // 这一段要求摘要行和输入框横向相交，避免侧栏或设置页里的相似文案误触发。
    // Require the summary row and composer to overlap horizontally so side panels or settings text do not trigger.
    const overlap = Math.min(leftRect.right, rightRect.right) - Math.max(leftRect.left, rightRect.left);
    return overlap >= Math.min(leftRect.width, rightRect.width) * 0.2;
  }

  function isBottomSummaryAnchor(anchor) {
    // 这一段把触发范围限制在输入框上方的底部区域，避免历史消息里的修改摘要响应。
    // Limit activation to the bottom area above the composer so older diff summaries do not respond.
    const anchorRect = getElementRect(anchor);
    if (!anchorRect || !isVisibleCompactElement(anchor)) return false;
    const composerRect = getBottomComposerRect();
    if (!composerRect) return anchorRect.bottom >= window.innerHeight * 0.55;
    const maxGap = Math.min(maxBottomSummaryGapPx, Math.max(360, window.innerHeight * 0.6));
    const gap = composerRect.top - anchorRect.bottom;
    return (
      gap >= minBottomSummaryGapPx &&
      gap <= maxGap &&
      hasHorizontalOverlap(anchorRect, composerRect)
    );
  }

  function hasBottomDiffLineStats(element) {
    // 这一段只在候选按钮内部查找官方行数统计组件，避免外层动画容器继承 turn diff 后误触发。
    // Look for the official line-stat component only inside the candidate button so outer animation containers cannot trigger.
    if (!(element instanceof HTMLElement)) return false;

    // 这一段限制扫描范围到按钮自身和少量后代，避免 hover 时做全页扫描。
    // Keep the scan bounded to the button and a few descendants instead of scanning the page on hover.
    const candidates = [element, ...Array.from(element.querySelectorAll("*")).slice(0, 24)];
    for (const candidate of candidates) {
      let fiber = getReactFiber(candidate);
      for (let depth = 0; fiber && depth < 6; depth += 1) {
        const props = fiber.memoizedProps || fiber.pendingProps;
        if (props && typeof props === "object" && ("linesAdded" in props || "linesRemoved" in props)) return true;
        fiber = fiber.return;
      }
    }
    return false;
  }

  function isBottomDiffSummaryButton(element, portal) {
    // 这一段只接受输入框上方 portal 内的官方 diff 按钮，不接受外层占位层或动画容器。
    // Accept only the official diff button inside the above-composer portal, not placeholder or animation wrappers.
    if (!(element instanceof HTMLElement) || !(portal instanceof HTMLElement)) return false;
    if (!portal.contains(element)) return false;
    if (!element.matches("button,[role='button']")) return false;
    if (!isVisibleCompactElement(element)) return false;
    if (!hasBottomDiffLineStats(element)) return false;
    return Boolean(buildSummary(readTurnDiff(element)));
  }

  function findBottomDiffSummaryButton(target, portal) {
    // 这一段从真实事件目标向上找最近的官方 diff 按钮，鼠标在按钮外的空白区域会失败关闭。
    // Walk upward from the real event target to the nearest official diff button; empty space outside it fails closed.
    for (
      let element = target, depth = 0;
      element && element !== portal && depth <= maxSummaryAncestorDepth;
      element = element.parentElement, depth += 1
    ) {
      if (isBottomDiffSummaryButton(element, portal)) return element;
    }
    return null;
  }

  function findBottomSummaryFromEventTarget(target) {
    // 这一段只处理输入框上方 portal 内的节点，正文区域永远不会进入 diff 识别。
    // Handle only nodes inside the above-composer portal; body content never enters diff detection.
    if (!(target instanceof HTMLElement)) return null;
    const portal = findAboveComposerPortal(target);
    if (!portal) return null;
    const anchor = findBottomDiffSummaryButton(target, portal);
    if (!anchor || !isBottomSummaryAnchor(anchor)) return null;
    return {
      anchor,
      summary: buildSummary(readTurnDiff(anchor)),
    };
  }

  function findEnvironmentSummaryFromEventTarget(target) {
    // 这一段只沿事件目标父链寻找环境面板变更行；优先用 fiber diffStats 确认目标。
    // Walk only the event target's ancestors for the environment Changes row, preferring fiber diffStats to confirm the target.
    if (!(target instanceof HTMLElement)) return null;
    for (
      let element = target, depth = 0;
      element && element !== document.body && depth <= maxEnvironmentAncestorDepth;
      element = element.parentElement, depth += 1
    ) {
      if (element.getAttribute("role") !== "button" || !isVisibleCompactElement(element)) continue;
      const metadata = readEnvironmentAnchorMetadata(element);
      if (!isEnvironmentDiffAnchorWithData(element, metadata)) continue;
      const data = readEnvironmentDiffData(element);
      const summary = buildSummary(buildEnvironmentTurnDiffFromData(data));
      return {
        anchor: element,
        gitFallback: data,
        summary,
      };
    }
    return null;
  }

  runtime.registerSystem(systemName, () => {
    const controller = new AbortController();
    runtime.lifecycle?.replaceController?.(systemName, controller);
    const { signal } = controller;
    const summaryByElement = new WeakMap();
    let panel = null;
    let activeAnchor = null;
    let hideTimer = 0;
    const pendingEnvironmentGitSummaryKeys = new Set();
    const environmentGitSummaryCache = new Map();
    let renderedSignature = "";
    let navigationRoot = null;
    let navigationState = null;
    let navigationSyncInterval = 0;
    const settingsApi = runtime.systemModules.settingsMenu?.settings;

    installStyles();

    function ensurePanel() {
      // 这一段懒创建悬浮根节点，关闭系统时由 abort 统一移除。
      // Lazily create the hover root node and remove it through abort cleanup.
      if (panel?.isConnected) {
        removeDuplicatePanelRoots(panel);
        return panel;
      }
      const existingPanel = document.getElementById(panelId);
      panel = existingPanel instanceof HTMLElement ? existingPanel : document.createElement("section");
      panel.id = panelId;
      panel.hidden = true;
      panel.setAttribute("aria-label", i18n.t("diff.panel.aria"));
      removeDuplicatePanelRoots(panel);
      panel.addEventListener("pointerenter", () => {
        window.clearTimeout(hideTimer);
      }, { signal });
      panel.addEventListener("pointerleave", scheduleHide, { signal });
      if (!panel.isConnected) document.body.append(panel);
      return panel;
    }

    function makeTextSpan(className, text) {
      // 这一段用 textContent 写入路径和统计，避免文件名影响面板结构。
      // Write paths and stats with textContent so filenames cannot affect panel structure.
      const span = document.createElement("span");
      span.className = className;
      span.textContent = text;
      return span;
    }

    function ensureNavigationRoot() {
      // 这一段懒创建右侧变更导航条，跟随系统生命周期统一清理。
      // Lazily create the right-side change navigator and clean it with the system lifecycle.
      if (navigationRoot?.isConnected) return navigationRoot;
      navigationRoot = document.createElement("aside");
      navigationRoot.id = navigationId;
      navigationRoot.hidden = true;
      navigationRoot.setAttribute("aria-label", i18n.t("diff.navigation.aria"));
      document.body.append(navigationRoot);
      return navigationRoot;
    }

    function getNavigationFileLabel(file) {
      // 这一段提取当前导航文件名，用于判断右侧预览是否仍然对应同一个文件。
      // Extract the current navigation filename so we can tell whether the right preview still matches it.
      const path = normalizePath(file?.path);
      return path.split("/").filter(Boolean).pop() || path;
    }

    function getRightPreviewPanel() {
      // 这一段只接受真实文件预览正文，不把右侧顶部 tab 控制器误当成预览面板。
      // Accept only the real file-preview body, avoiding the right-side tab controller.
      const fileLabel = getNavigationFileLabel(navigationState?.file);
      const candidates = Array.from(document.querySelectorAll('aside [role="tabpanel"], [role="tabpanel"]'));
      const visibleCandidates = candidates.filter((candidate) => {
        if (!(candidate instanceof HTMLElement) || !candidate.isConnected) return false;
        const rect = candidate.getBoundingClientRect();
        return rect.width >= 160 && rect.height >= 120;
      });
      return visibleCandidates.find((candidate) => {
        const ariaLabel = candidate.getAttribute("aria-label") || "";
        return fileLabel && ariaLabel.includes(fileLabel);
      }) || visibleCandidates[0] || null;
    }

    function rightPreviewMatchesNavigationFile(rightPanel) {
      // 这一段确认右侧预览仍显示当前导航文件；刚打开后的短时间允许 React 延迟渲染标题。
      // Confirm the right preview still shows the navigated file; allow a short React title-render delay after opening.
      if (!navigationState) return false;
      if (Date.now() - navigationState.openedAt < 1200) return true;
      const filePath = normalizePath(navigationState.file?.path);
      const fileLabel = getNavigationFileLabel(navigationState.file);
      const ariaLabel = rightPanel.getAttribute("aria-label") || "";
      const panelText = rightPanel.textContent || "";
      return Boolean(
        (fileLabel && ariaLabel.includes(fileLabel)) ||
        (filePath && panelText.includes(filePath)) ||
        (fileLabel && panelText.includes(fileLabel))
      );
    }

    function readVisibleRect(element, containerRect) {
      // 这一段读取候选预览内容区域，并过滤掉标题栏、按钮和过小节点。
      // Read a candidate preview-content rect and filter out headers, buttons, and tiny nodes.
      if (!(element instanceof HTMLElement) || !element.isConnected) return null;
      const rect = element.getBoundingClientRect();
      if (rect.width < 220 || rect.height < 120) return null;
      if (rect.bottom <= containerRect.top || rect.top >= containerRect.bottom) return null;
      if (rect.right <= containerRect.left || rect.left >= containerRect.right) return null;
      if (rect.top < containerRect.top + 64) return null;
      return rect;
    }

    function getNavigationPreviewHostRect() {
      // 这一段优先定位代码预览滚动区域；找不到精确节点时退到右侧面板内的内容区域。
      // Prefer the code-preview scroll area; fall back to the content area inside the right panel when exact nodes are unavailable.
      const rightPanel = getRightPreviewPanel();
      if (!rightPanel || !rightPreviewMatchesNavigationFile(rightPanel)) return null;
      const panelRect = rightPanel.getBoundingClientRect();
      const candidateSelector = [
        "diffs-container",
        ".cm-scroller",
        ".monaco-scrollable-element",
        "pre",
        "code",
        "[data-testid*='file']",
        "[data-testid*='preview']",
        "[class*='code']",
        "[class*='Code']",
      ].join(",");
      let bestRect = null;
      let bestScore = -1;
      for (const candidate of rightPanel.querySelectorAll(candidateSelector)) {
        const rect = readVisibleRect(candidate, panelRect);
        if (!rect) continue;
        const rightEdgePenalty = Math.abs(panelRect.right - rect.right) * 4;
        const score = rect.width * rect.height - rightEdgePenalty;
        if (score > bestScore) {
          bestRect = rect;
          bestScore = score;
        }
      }
      if (bestRect) return bestRect;
      const fallbackTop = Math.min(
        panelRect.bottom - 120,
        panelRect.top + Math.min(180, Math.max(96, panelRect.height * 0.22)),
      );
      return {
        bottom: panelRect.bottom,
        height: panelRect.bottom - fallbackTop,
        left: panelRect.left,
        right: panelRect.right,
        top: fallbackTop,
        width: panelRect.width,
      };
    }

    function placeNavigationRoot() {
      // 这一段把导航条贴到当前文件预览右上角；预览消失时立即清理悬浮按钮。
      // Place the navigator at the current file preview's top-right; clear it as soon as the preview disappears.
      if (!navigationRoot?.isConnected || navigationRoot.hidden) return false;
      const placement = navigationApi.getPreviewNavigationPlacement(
        getNavigationPreviewHostRect(),
        navigationRoot.getBoundingClientRect(),
        { height: window.innerHeight, width: window.innerWidth },
      );
      if (!placement) {
        if (navigationState && Date.now() - navigationState.openedAt < 1200) {
          navigationRoot.style.visibility = "hidden";
          return false;
        }
        clearNavigationBar();
        return false;
      }
      navigationRoot.style.left = `${placement.left}px`;
      navigationRoot.style.top = `${placement.top}px`;
      navigationRoot.style.right = "";
      navigationRoot.style.visibility = "visible";
      return true;
    }

    function startNavigationSync() {
      // 这一段只在导航条显示期间轻量轮询预览状态，确保关闭右侧面板后按钮会自动消失。
      // Poll preview state only while the navigator is visible so closing the right panel automatically hides the buttons.
      if (navigationSyncInterval) return;
      navigationSyncInterval = window.setInterval(placeNavigationRoot, 700);
    }

    function clearNavigationBar() {
      // 这一段隐藏并清空导航状态，避免切到无 hunk 文件后残留旧按钮。
      // Hide and clear navigation state so files without hunks do not leave stale controls behind.
      if (navigationSyncInterval) {
        window.clearInterval(navigationSyncInterval);
        navigationSyncInterval = 0;
      }
      navigationState = null;
      if (!navigationRoot) return;
      navigationRoot.hidden = true;
      navigationRoot.style.visibility = "";
      navigationRoot.textContent = "";
    }

    function getNavigationRanges(file) {
      // 这一段集中规整文件上的 hunk 范围，供打开和按钮导航共用。
      // Centralize hunk-range normalization for both file opening and button navigation.
      return navigationApi.normalizeNavigationRanges(file?.navigationRanges);
    }

    function renderNavigationBar() {
      // 这一段渲染上一处/下一处按钮；只有当前文件有 hunk 范围时才显示。
      // Render previous/next controls only when the current file has hunk ranges.
      if (!navigationState || navigationState.ranges.length === 0) {
        clearNavigationBar();
        return;
      }
      const root = ensureNavigationRoot();
      const previousButton = document.createElement("button");
      previousButton.type = "button";
      previousButton.textContent = "^";
      previousButton.title = i18n.t("diff.navigation.previous");
      previousButton.setAttribute("aria-label", i18n.t("diff.navigation.previous"));
      previousButton.disabled = navigationState.index <= 0;
      previousButton.addEventListener("click", () => navigateDiffRange(-1), { signal });

      const count = document.createElement("span");
      count.className = "codex-pro-diff-navigation-count";
      count.textContent = `${navigationState.index + 1}\n/\n${navigationState.ranges.length}`;

      const nextButton = document.createElement("button");
      nextButton.type = "button";
      nextButton.textContent = "v";
      nextButton.title = i18n.t("diff.navigation.next");
      nextButton.setAttribute("aria-label", i18n.t("diff.navigation.next"));
      nextButton.disabled = navigationState.index >= navigationState.ranges.length - 1;
      nextButton.addEventListener("click", () => navigateDiffRange(1), { signal });

      root.replaceChildren(previousButton, count, nextButton);
      root.hidden = false;
      placeNavigationRoot();
      if (navigationState) startNavigationSync();
    }

    async function reopenNavigationRange(nextIndex) {
      // 这一段复用官方文件打开入口跳到目标 hunk，不自行操作代码预览内部滚动。
      // Reuse the official file-open entry to jump to the target hunk without manipulating preview internals.
      if (!navigationState) return;
      const nextRange = navigationState.ranges[nextIndex];
      if (!nextRange) return;
      navigationState.index = nextIndex;
      navigationState.openedAt = Date.now();
      renderNavigationBar();
      try {
        const opened = await openWithWorkspaceFileModule(
          navigationState.anchor,
          navigationState.summary,
          navigationState.file,
          nextRange,
        );
        if (!opened) clearNavigationBar();
      } catch (error) {
        clearNavigationBar();
        console.warn("[Codex-Pro] diff navigation jump failed", error);
      }
    }

    function showNavigationForFile(anchor, summary, file, knownRanges = null) {
      // 这一段为当前文件创建变更块导航状态，渲染仍交给统一导航条逻辑。
      // Create hunk-navigation state for the current file while keeping rendering in the shared navigator path.
      const ranges = Array.isArray(knownRanges) ? knownRanges : getNavigationRanges(file);
      if (ranges.length === 0) {
        clearNavigationBar();
        return;
      }
      navigationState = {
        anchor,
        file,
        index: 0,
        openedAt: Date.now(),
        ranges,
        summary,
      };
      renderNavigationBar();
    }

    function navigateDiffRange(delta) {
      // 这一段处理按钮导航边界，避免无效点击触发多余的文件打开。
      // Handle button navigation bounds so invalid clicks do not trigger extra file opens.
      if (!navigationState) return;
      const nextIndex = navigationState.index + delta;
      if (nextIndex < 0 || nextIndex >= navigationState.ranges.length) return;
      void reopenNavigationRange(nextIndex);
    }

    function getExternalDiffToolPath() {
      // 这一段读取设置里的外部 Diff 工具路径；空值会让外部 Diff 入口进入禁用态。
      // Read the external diff tool path from settings; empty makes external diff entries disabled.
      return String(settingsApi?.getSettings?.()?.externalDiffToolPath || "").trim();
    }

    function isExternalDiffMiddleClickEnabled() {
      // 这一段读取文件行中键打开外部 Diff 的独立开关，缺省时保持启用。
      // Read the independent middle-click external diff switch, defaulting to enabled.
      return settingsApi?.getSettings?.()?.enableExternalDiffMiddleClick !== false;
    }

    function isEditedFileCardExternalDiffMiddleClickEnabled() {
      // 这一段读取官方已编辑文件卡片的中键外部 Diff 开关，缺省时保持启用。
      // Read the official edited-file card middle-click external Diff switch, defaulting to enabled.
      return settingsApi?.getSettings?.()?.enableEditedFileCardExternalDiffMiddleClick !== false;
    }

    function getDiffHoverFileOpenMode() {
      // 这一段读取文件行左键打开模式，缺省继续使用官方审查页以保持升级前行为。
      // Read the file-row left-click open mode, defaulting to the official review page for upgrade compatibility.
      return settingsApi?.getSettings?.()?.diffHoverFileOpenMode === "preview" ? "preview" : "review";
    }

    function getDiffHoverPreviewFontSize() {
      // 这一段读取悬浮预览自定义字号；空值表示继续跟随 Codex 原生代码字号变量。
      // Read the custom hover-preview font size; blank keeps following Codex's native code font-size variable.
      const fontSize = Number(settingsApi?.getSettings?.()?.diffHoverPreviewFontSize);
      return Number.isFinite(fontSize) && fontSize > 0 ? fontSize : 0;
    }

    function getNativeCodeFontSize() {
      // 这一段从根节点读取 Codex 外观里的代码字号，避开 body 层级对 VS Code 变量的局部覆盖。
      // Read Codex's code font size from the root node, avoiding body-level local overrides of VS Code variables.
      const rootStyle = window.getComputedStyle(document.documentElement);
      for (const variableName of ["--vscode-editor-font-size", "--codex-chat-code-font-size", "--diffs-font-size"]) {
        const value = rootStyle.getPropertyValue(variableName).trim();
        const fontSize = Number.parseFloat(value);
        if (/^\d+(?:\.\d+)?px$/u.test(value) && Number.isFinite(fontSize) && fontSize > 0) return value;
      }
      return "";
    }

    function applyPanelFontSize(root, customFontSize, nativeFontSize = "") {
      // 这一段总是显式写入悬浮面板字号，优先使用自定义值，否则使用根节点原生代码字号。
      // Always write the hover panel font size explicitly, preferring the custom value over the root native code size.
      if (customFontSize > 0) {
        root.style.setProperty("--codex-pro-diff-hover-font-size", `${customFontSize}px`);
        return;
      }
      if (nativeFontSize) {
        root.style.setProperty("--codex-pro-diff-hover-font-size", nativeFontSize);
        return;
      }
      root.style.removeProperty("--codex-pro-diff-hover-font-size");
    }

    function getExternalDiffDisabledReason(summary, externalDiffToolPath) {
      // 这一段集中判断外部 Diff 是否可用，让按钮和中键入口使用同一套禁用原因。
      // Centralize external diff availability so button and middle-click paths share the same disabled reason.
      if (!externalDiffToolPath) return i18n.t("diff.external.needTool");
      if (!summary.cwd) return i18n.t("diff.external.missingCwd");
      if (!runtime.nativeBridge?.supportsExternalDiff?.()) {
        return runtime.nativeBridge?.isAvailable?.()
          ? i18n.t("diff.external.bridgeOld")
          : i18n.t("diff.external.bridgeUnavailable");
      }
      return "";
    }

    function createExternalDiffIcon() {
      // 这一段创建轻量图标节点，避免用文字按钮挤占文件路径空间。
      // Create a compact icon node so a text button does not consume file-path space.
      const svg = document.createElementNS("http://www.w3.org/2000/svg", "svg");
      svg.setAttribute("viewBox", "0 0 24 24");
      svg.setAttribute("aria-hidden", "true");
      svg.setAttribute("fill", "none");
      svg.setAttribute("stroke", "currentColor");
      svg.setAttribute("stroke-width", "2");
      svg.setAttribute("stroke-linecap", "round");
      svg.setAttribute("stroke-linejoin", "round");
      for (const d of ["M8 6h12", "M8 12h8", "M8 18h12", "M4 6h.01", "M4 12h.01", "M4 18h.01"]) {
        const pathNode = document.createElementNS("http://www.w3.org/2000/svg", "path");
        pathNode.setAttribute("d", d);
        svg.append(pathNode);
      }
      return svg;
    }

    function bindWorkspaceOpenRow(row, summary, file, externalDiffToolPath, externalDiffMiddleClickEnabled, externalDiffDisabledReason) {
      // 这一段让整行继续承担原有“左键在 Codex 内打开文件”的行为。
      // Keep the row responsible for the existing left-click "open inside Codex" behavior.
      row.setAttribute("role", "button");
      row.tabIndex = 0;
      row.addEventListener("click", () => {
        openWorkspaceFile(summary, file);
      }, { signal });
      row.addEventListener("mousedown", (event) => {
        // 这一段在中键候选开始时阻止 Chromium 自动滚动，真正打开动作仍交给 auxclick。
        // Prevent Chromium autoscroll when middle-click starts; auxclick still performs the open action.
        if (event.button !== 1 || !externalDiffMiddleClickEnabled) return;
        event.preventDefault();
        event.stopPropagation();
      }, { signal });
      let lastMiddleClickDiffAt = 0;
      row.addEventListener("auxclick", (event) => {
        // 这一段用中键打开外部 Diff，同时兼容鼠标手势系统回放的 auxclick 事件。
        // Open external diff on middle-click while accepting auxclick events replayed by the mouse-gesture system.
        if (event.button !== 1 || !externalDiffMiddleClickEnabled) return;
        event.preventDefault();
        event.stopPropagation();
        const now = Date.now();
        if (now - lastMiddleClickDiffAt < 250) return;
        lastMiddleClickDiffAt = now;
        if (externalDiffDisabledReason) {
          console.warn("[Codex-Pro] external diff middle-click falling back to workspace open:", externalDiffDisabledReason);
          openWorkspaceFile(summary, file);
          return;
        }
        if (!openExternalDiff(summary, file, externalDiffToolPath)) {
          openWorkspaceFile(summary, file);
        }
      }, { signal });
      row.addEventListener("keydown", (event) => {
        if (event.key !== "Enter" && event.key !== " ") return;
        event.preventDefault();
        openWorkspaceFile(summary, file);
      }, { signal });
    }

    function createExternalDiffButton(summary, file, externalDiffToolPath) {
      // 这一段创建每行最右侧的外部 Diff 小按钮，禁用态会说明缺少桥接或 cwd。
      // Create the right-side external diff button for each row, explaining disabled bridge/cwd states.
      const button = document.createElement("button");
      button.className = "codex-pro-diff-hover-external-diff-button";
      button.type = "button";
      button.setAttribute("aria-label", i18n.t("diff.external.buttonForFile", { path: file.path }));
      button.title = i18n.t("diff.external.button");
      button.append(createExternalDiffIcon());
      const disabledReason = getExternalDiffDisabledReason(summary, externalDiffToolPath);
      if (disabledReason) {
        button.setAttribute("aria-disabled", "true");
        button.title = disabledReason;
      }
      button.addEventListener("click", (event) => {
        event.preventDefault();
        event.stopPropagation();
        if (disabledReason) {
          console.warn("[Codex-Pro] external diff button disabled:", disabledReason);
          return;
        }
        openExternalDiff(summary, file, externalDiffToolPath);
      }, { signal });
      return button;
    }

    function renderPanel(
      summary,
      externalDiffToolPath = "",
      externalDiffMiddleClickEnabled = true,
      diffHoverPreviewFontSize = 0,
      nativeDiffHoverPreviewFontSize = "",
    ) {
      // 这一段渲染文件列表、总增删行数和隐藏数量提示。
      // Render the file list, total line counts, and hidden-file hint.
      const root = ensurePanel();
      applyPanelFontSize(root, diffHoverPreviewFontSize, nativeDiffHoverPreviewFontSize);
      root.textContent = "";

      const header = document.createElement("header");
      header.className = "codex-pro-diff-hover-header";
      header.append(
        makeTextSpan("codex-pro-diff-hover-title", i18n.t("diff.panel.title", { count: summary.files.length })),
        makeTextSpan("codex-pro-diff-hover-total", ""),
      );
      header.querySelector(".codex-pro-diff-hover-total")?.append(
        makeTextSpan("codex-pro-diff-hover-additions", `+${summary.totals.additions}`),
        makeTextSpan("codex-pro-diff-hover-deletions", `-${summary.totals.deletions}`),
      );

      const list = document.createElement("div");
      list.className = "codex-pro-diff-hover-list";
      const externalDiffDisabledReason = getExternalDiffDisabledReason(summary, externalDiffToolPath);
      for (const file of summary.visibleFiles) {
        const row = document.createElement("div");
        row.className = "codex-pro-diff-hover-row";
        row.title = file.previousPath ? `${file.previousPath} -> ${file.path}` : file.path;
        row.append(
          makeTextSpan("codex-pro-diff-hover-path", file.path),
          makeTextSpan("codex-pro-diff-hover-kind", file.kind),
          makeTextSpan("codex-pro-diff-hover-stats", ""),
        );
        row.querySelector(".codex-pro-diff-hover-stats")?.append(
          makeTextSpan("codex-pro-diff-hover-additions", `+${file.additions}`),
          makeTextSpan("codex-pro-diff-hover-deletions", `-${file.deletions}`),
        );
        row.append(createExternalDiffButton(summary, file, externalDiffToolPath));
        bindWorkspaceOpenRow(
          row,
          summary,
          file,
          externalDiffToolPath,
          externalDiffMiddleClickEnabled,
          externalDiffDisabledReason,
        );
        list.append(row);
      }
      if (summary.hiddenCount > 0) {
        const moreRow = document.createElement("div");
        moreRow.className = "codex-pro-diff-hover-row";
        moreRow.append(makeTextSpan("codex-pro-diff-hover-path", i18n.t("diff.panel.hiddenMore", { count: summary.hiddenCount })));
        list.append(moreRow);
      }

      root.append(header, list);
    }

    function placePanel(anchor) {
      // 这一段根据触发来源摆放悬浮窗：底部摘要按触发胶囊居中放上方，环境面板变更行放到左侧。
      // Place the panel by source: centered above bottom summaries and to the left of environment-panel Changes rows.
      const root = ensurePanel();
      const anchorRect = anchor.getBoundingClientRect();
      root.hidden = false;
      root.style.left = "0px";
      root.style.top = "0px";
      const panelRect = root.getBoundingClientRect();
      if (isEnvironmentDiffAnchor(anchor)) {
        const left = Math.min(
          Math.max(12, anchorRect.left - panelRect.width - 8),
          Math.max(12, window.innerWidth - panelRect.width - 12),
        );
        const top = Math.min(
          Math.max(12, anchorRect.top - 8),
          Math.max(12, window.innerHeight - panelRect.height - 12),
        );
        root.style.left = `${Math.round(left)}px`;
        root.style.top = `${Math.round(top)}px`;
        return;
      }
      const maxLeft = Math.max(12, window.innerWidth - panelRect.width - 12);
      const centeredLeft = anchorRect.left + (anchorRect.width / 2) - (panelRect.width / 2);
      const left = Math.min(Math.max(12, centeredLeft), maxLeft);
      const aboveTop = anchorRect.top - panelRect.height - 8;
      const belowTop = anchorRect.bottom + 8;
      const top = aboveTop >= 12
        ? aboveTop
        : Math.min(belowTop, Math.max(12, window.innerHeight - panelRect.height - 12));
      root.style.left = `${Math.round(left)}px`;
      root.style.top = `${Math.round(top)}px`;
    }

    function readSummaryForAnchor(anchor, fallbackSummary = null) {
      // 这一段在 hover/focus 时从当前 React fiber 读取 diff，失败时复用事件目标上刚解析出的结果。
      // Read diff from React fiber on hover/focus, falling back to the result parsed from the event target.
      const latestSummary = buildSummary(readTurnDiff(anchor)) ||
        (isEnvironmentDiffAnchor(anchor) ? buildSummary(readEnvironmentTurnDiff(anchor)) : null);
      const summary = latestSummary || fallbackSummary || summaryByElement.get(anchor) || null;
      if (summary) summaryByElement.set(anchor, summary);
      return summary;
    }

    function showPanel(anchor, fallbackSummary = null) {
      // 这一段只在有效摘要 hover/focus 时渲染或复用面板，避免重复替换文件按钮。
      // Render or reuse the panel only for valid summary hover/focus so file buttons stay stable.
      const summary = readSummaryForAnchor(anchor, fallbackSummary);
      if (!summary) return;
      showPanelWithSummary(anchor, summary);
    }

    function showPanelWithSummary(anchor, summary) {
      // 这一段直接按指定摘要渲染面板，用于后台 Git 刷新覆盖可能过期的 React 摘要。
      // Render the panel from a supplied summary so background Git refreshes can override stale React summaries.
      if (!anchor || !summary) return;
      const externalDiffToolPath = getExternalDiffToolPath();
      const externalDiffMiddleClickEnabled = isExternalDiffMiddleClickEnabled();
      const fileOpenMode = getDiffHoverFileOpenMode();
      const diffHoverPreviewFontSize = getDiffHoverPreviewFontSize();
      const nativeDiffHoverPreviewFontSize = diffHoverPreviewFontSize > 0 ? "" : getNativeCodeFontSize();
      const renderSignature = [
        summary.signature,
        externalDiffToolPath,
        externalDiffMiddleClickEnabled ? "middle-click-diff" : "no-middle-click-diff",
        fileOpenMode,
        diffHoverPreviewFontSize > 0 ? `${diffHoverPreviewFontSize}px` : nativeDiffHoverPreviewFontSize || "native-code-font-size",
        runtime.nativeBridge?.supportsExternalDiff?.() ? "external-bridge" : "no-external-bridge",
      ].join("::");
      window.clearTimeout(hideTimer);
      clearSummaryMarks(anchor);
      activeAnchor = anchor;
      activeAnchor.setAttribute(summaryAttribute, "true");
      if (renderedSignature !== renderSignature || !panel?.isConnected) {
        renderPanel(
          summary,
          externalDiffToolPath,
          externalDiffMiddleClickEnabled,
          diffHoverPreviewFontSize,
          nativeDiffHoverPreviewFontSize,
        );
        renderedSignature = renderSignature;
      }
      placePanel(anchor);
    }

    function activatePendingAnchor(anchor) {
      // 这一段在异步 Git 摘要返回前先记录当前触发行，避免请求回来后弹到旧目标。
      // Record the current trigger row before async Git summary returns so stale requests do not render on old targets.
      window.clearTimeout(hideTimer);
      clearSummaryMarks(anchor);
      activeAnchor = anchor;
      activeAnchor.setAttribute(summaryAttribute, "true");
    }

    function makeEnvironmentGitSummaryKey(gitFallback) {
      // 这一段把工作区和环境面板统计合成刷新键，避免不同仓库或不同变更状态互相复用。
      // Build a refresh key from workspace and environment stats so different repos or states do not share results.
      return [
        gitFallback.cwd,
        gitFallback.diffStats?.fileCount || 0,
        gitFallback.diffStats?.additions || 0,
        gitFallback.diffStats?.deletions || 0,
      ].join("::");
    }

    function rememberEnvironmentGitSummary(requestKey, summary) {
      // 这一段只缓存少量最新 Git 摘要，避免频繁 hover 重复跑 Git，也避免 Map 长期增长。
      // Cache only a few recent Git summaries to avoid repeated Git calls on hover without letting the Map grow forever.
      environmentGitSummaryCache.set(requestKey, {
        summary,
        timestamp: Date.now(),
      });
      while (environmentGitSummaryCache.size > maxEnvironmentGitRefreshCacheEntries) {
        environmentGitSummaryCache.delete(environmentGitSummaryCache.keys().next().value);
      }
    }

    function getFreshEnvironmentGitSummary(requestKey) {
      // 这一段只复用短时间内的 Git 摘要，超时后下次 hover 会重新刷新。
      // Reuse Git summaries only briefly so the next hover refreshes after the TTL expires.
      const cached = environmentGitSummaryCache.get(requestKey);
      if (!cached || Date.now() - cached.timestamp > environmentGitRefreshTtlMs) return null;
      return cached.summary;
    }

    function applyEnvironmentGitSummary(anchor, summary, refreshExisting) {
      // 这一段只在后台结果确实更新时重绘，避免相同数据导致悬浮窗抖动。
      // Redraw only when the background result changes so identical data does not make the panel flicker.
      const previousSummary = summaryByElement.get(anchor);
      summaryByElement.set(anchor, summary);
      if (!refreshExisting || previousSummary?.signature !== summary.signature) {
        showPanelWithSummary(anchor, summary);
      }
    }

    function requestEnvironmentGitSummary(anchor, gitFallback, options = {}) {
      // 这一段通过原生桥读取本地 Git 变更摘要；后台刷新不会阻塞已有悬浮窗。
      // Read the local Git diff summary through the native bridge; background refreshes do not block the current panel.
      if (!gitFallback?.cwd || !runtime.nativeBridge?.supportsGitDiffSummary?.()) return;
      const refreshExisting = options.refreshExisting === true;
      const requestKey = makeEnvironmentGitSummaryKey(gitFallback);
      const cachedSummary = getFreshEnvironmentGitSummary(requestKey);
      if (cachedSummary) {
        if (!refreshExisting) activatePendingAnchor(anchor);
        if (activeAnchor === anchor) applyEnvironmentGitSummary(anchor, cachedSummary, refreshExisting);
        return;
      }
      if (pendingEnvironmentGitSummaryKeys.has(requestKey)) return;
      pendingEnvironmentGitSummaryKeys.add(requestKey);
      if (!refreshExisting) activatePendingAnchor(anchor);
      void runtime.nativeBridge.requestGitDiffSummary({ cwd: gitFallback.cwd }).then((diff) => {
        pendingEnvironmentGitSummaryKeys.delete(requestKey);
        const summary = buildSummary({
          conversationId: gitFallback.conversationId,
          cwd: gitFallback.cwd,
          diff,
          hostId: gitFallback.hostId,
          totalsOverride: gitFallback.diffStats,
          turnId: gitFallback.turnId || "git-worktree",
        });
        if (!summary) {
          if (!refreshExisting && activeAnchor === anchor) hidePanel();
          return;
        }
        rememberEnvironmentGitSummary(requestKey, summary);
        if (activeAnchor !== anchor) return;
        applyEnvironmentGitSummary(anchor, summary, refreshExisting);
      });
    }

    function hidePanel() {
      // 这一段关闭悬浮窗但保留节点，下一次 hover 可复用以减少 DOM 抖动。
      // Hide the panel while keeping the node for reuse to reduce DOM churn on the next hover.
      clearSummaryMarks();
      activeAnchor = null;
      if (panel) panel.hidden = true;
      hideDiffHoverPanelRoots();
    }

    function scheduleHide() {
      // 这一段给指针从摘要行移动到悬浮窗留出短暂时间，避免面板闪烁。
      // Leave a short grace period for moving from the summary row to the panel to avoid flicker.
      window.clearTimeout(hideTimer);
      hideTimer = window.setTimeout(hidePanel, hideDelayMs);
    }

    function targetIsInsideActiveSurface(target) {
      // 这一段判断指针/焦点是否仍在摘要行或悬浮面板内，避免移动到面板时被误关。
      // Check whether pointer/focus remains inside the anchor or panel so moving into the panel does not hide it.
      return target instanceof Node && (
        Boolean(activeAnchor?.contains(target)) ||
        Boolean(panel?.contains(target))
      );
    }

    function handlePointerOver(event) {
      // 这一段在鼠标实际经过元素时才识别底部摘要或环境面板变更行，不做空闲扫描。
      // Detect bottom summaries or environment-panel Changes rows only on pointer movement, with no idle scanning.
      if (panel?.contains(event.target)) return;
      const match = findBottomSummaryFromEventTarget(event.target) ||
        findEnvironmentSummaryFromEventTarget(event.target);
      if (!match) {
        if (event.target instanceof HTMLElement && findAboveComposerPortal(event.target)) {
          if (activeAnchor) scheduleHide();
          else hidePanel();
        }
        return;
      }
      if (!match.summary && match.gitFallback) {
        requestEnvironmentGitSummary(match.anchor, match.gitFallback);
        return;
      }
      showPanel(match.anchor, match.summary);
      if (match.gitFallback && isEnvironmentDiffAnchor(match.anchor)) {
        requestEnvironmentGitSummary(match.anchor, match.gitFallback, { refreshExisting: true });
      }
    }

    function handlePointerOut(event) {
      // 这一段在离开当前摘要行且没有进入面板时延迟关闭，保留从摘要移动到面板的容错。
      // Delay hiding when leaving the active summary unless the pointer moves into the panel.
      if (!activeAnchor || !activeAnchor.contains(event.target)) return;
      if (targetIsInsideActiveSurface(event.relatedTarget)) return;
      scheduleHide();
    }

    function handleFocusIn(event) {
      // 这一段支持键盘焦点进入底部摘要或环境面板变更行时打开预览，保持 hover 和 focus 行为一致。
      // Open the preview when keyboard focus enters bottom summaries or environment Changes rows, matching hover behavior.
      const match = findBottomSummaryFromEventTarget(event.target) ||
        findEnvironmentSummaryFromEventTarget(event.target);
      if (!match) return;
      if (!match.summary && match.gitFallback) {
        requestEnvironmentGitSummary(match.anchor, match.gitFallback);
        return;
      }
      showPanel(match.anchor, match.summary);
      if (match.gitFallback && isEnvironmentDiffAnchor(match.anchor)) {
        requestEnvironmentGitSummary(match.anchor, match.gitFallback, { refreshExisting: true });
      }
    }

    function handleFocusOut(event) {
      // 这一段在焦点离开摘要和面板后关闭预览，避免键盘导航留下悬浮窗。
      // Hide the preview after focus leaves both the summary and panel.
      if (!activeAnchor || !activeAnchor.contains(event.target)) return;
      if (targetIsInsideActiveSurface(event.relatedTarget)) return;
      scheduleHide();
    }

    function findSummaryAnchor(summary) {
      // 这一段只复用当前活动摘要行，不再从全页已绑定节点里回查历史摘要。
      // Reuse only the current active summary row instead of searching page-wide bound historical summaries.
      return activeAnchor && summaryByElement.get(activeAnchor)?.signature === summary.signature ? activeAnchor : null;
    }

    function normalizeCodexAssetModulePath(candidate, modulePattern, baseUrl = location.href) {
      // 这一段只接受白名单官方 chunk 文件名，避免把任意脚本路径交给动态导入。
      // Accept only allowlisted official chunk filenames before handing a path to dynamic import.
      const match = String(candidate || "").match(modulePattern);
      if (!match) return "";
      const modulePath = match[0].startsWith("assets/") ? `/${match[0]}` : `/assets/${match[0].split("/").pop()}`;
      try {
        return new URL(modulePath, baseUrl).href;
      } catch {
        return `.${modulePath}`;
      }
    }

    function normalizeWorkspaceFileModulePath(candidate, baseUrl = location.href) {
      // 这一段只接受官方 open-workspace-file chunk 文件名，避免把任意脚本路径交给动态导入。
      // Accept only the official open-workspace-file chunk filename before handing a path to dynamic import.
      return normalizeCodexAssetModulePath(candidate, workspaceFileModulePattern, baseUrl);
    }

    async function discoverCodexAssetModulePath(modulePattern, fallbackPaths = []) {
      // 这一段从当前 Codex 已加载脚本里扫描真实 chunk 名称，兼容 Codex 更新后 hash 变化。
      // Scan currently loaded Codex scripts for real chunk names so Codex hash updates do not break calls.
      const scriptUrls = Array.from(document.scripts)
        .map((script) => script.src)
        .filter((src) => src && src.startsWith("app://-/assets/"))
        .slice(0, 12);

      for (const scriptUrl of scriptUrls) {
        try {
          const response = await fetch(scriptUrl);
          if (!response.ok) continue;
          const source = await response.text();
          const modulePath = normalizeCodexAssetModulePath(source, modulePattern, scriptUrl);
          if (modulePath) return modulePath;
        } catch {
          // Ignore unreadable app assets and continue to the pinned fallbacks below.
        }
      }

      for (const fallbackPath of fallbackPaths) {
        const modulePath = normalizeCodexAssetModulePath(fallbackPath, modulePattern, location.href);
        if (modulePath) return modulePath;
      }
      return "";
    }

    async function discoverWorkspaceFileModulePath() {
      // 这一段复用官方 chunk 发现逻辑寻找右侧文件预览入口。
      // Reuse official chunk discovery for the right-side file preview entry.
      return discoverCodexAssetModulePath(workspaceFileModulePattern, workspaceFileModuleFallbackPaths);
    }

    async function getWorkspaceFileModulePath() {
      // 这一段缓存 chunk 发现结果，避免每次点击都重新读取主脚本。
      // Cache chunk discovery so each file click does not reread the main script.
      if (!workspaceFileModulePathPromise) {
        workspaceFileModulePathPromise = discoverWorkspaceFileModulePath().catch((error) => {
          workspaceFileModulePathPromise = null;
          throw error;
        });
      }
      return workspaceFileModulePathPromise;
    }

    async function getWorkspaceFileModule() {
      // 这一段复用 Codex 官方 open-workspace-file chunk，避免重写右侧文件预览内部协议。
      // Reuse Codex's official open-workspace-file chunk instead of recreating the side-panel protocol.
      if (!workspaceFileModulePromise) {
        workspaceFileModulePromise = getWorkspaceFileModulePath().then((modulePath) => {
          if (!modulePath) throw new Error("open-workspace-file module path not found");
          return import(modulePath);
        }).catch((error) => {
          workspaceFileModulePromise = null;
          throw error;
        });
      }
      return workspaceFileModulePromise;
    }

    function isWorkspaceFileOpener(candidate) {
      // 这一段用官方 opener 的参数名特征识别真实打开函数，兼容 Codex 更新后导出名漂移。
      // Identify the real opener by its official parameter names so Codex export-name drift stays compatible.
      if (typeof candidate !== "function") return false;

      // 这一段只做源码特征检查，不执行候选函数，避免误触发页面状态变化。
      // Check source features only and never execute candidates while detecting the opener.
      let source = "";
      try {
        source = Function.prototype.toString.call(candidate);
      } catch {
        return false;
      }
      return source.includes("openInSidePanel") &&
        source.includes("openFile") &&
        source.includes("path") &&
        source.includes("scope");
    }

    function getWorkspaceFileOpener(module) {
      // 这一段优先尝试已知导出名：旧版 Codex 是 t，2026-06-26 更新后是 n。
      // Prefer known export names: older Codex used t, while the 2026-06-26 update uses n.
      for (const candidate of [module?.t, module?.n]) {
        if (isWorkspaceFileOpener(candidate)) return candidate;
      }

      // 这一段有界扫描模块导出，避免之后官方再改短导出名时直接失效。
      // Bounded-scan module exports so future short export-name changes do not immediately break opening.
      for (const key of Object.keys(module || {})) {
        let candidate = null;
        try {
          candidate = module[key];
        } catch {
          continue;
        }
        if (isWorkspaceFileOpener(candidate)) return candidate;
      }
      return null;
    }

    async function getReviewNavigationModulePath() {
      // 这一段缓存官方 review-navigation-model chunk 路径，避免右上角点击重复扫描主脚本。
      // Cache the official review-navigation-model chunk path so right-top clicks do not rescan the main script.
      if (!reviewNavigationModulePathPromise) {
        reviewNavigationModulePathPromise = discoverCodexAssetModulePath(
          reviewNavigationModulePattern,
          reviewNavigationModuleFallbackPaths,
        ).catch((error) => {
          reviewNavigationModulePathPromise = null;
          throw error;
        });
      }
      return reviewNavigationModulePathPromise;
    }

    async function getReviewSidePanelTabsModulePath() {
      // 这一段缓存官方 thread-side-panel-tabs chunk 路径，供右上角快速打开 Review tab。
      // Cache the official thread-side-panel-tabs chunk path for fast right-top Review tab opening.
      if (!reviewSidePanelTabsModulePathPromise) {
        reviewSidePanelTabsModulePathPromise = discoverCodexAssetModulePath(
          reviewSidePanelTabsModulePattern,
          reviewSidePanelTabsModuleFallbackPaths,
        ).catch((error) => {
          reviewSidePanelTabsModulePathPromise = null;
          throw error;
        });
      }
      return reviewSidePanelTabsModulePathPromise;
    }

    async function getReviewNavigationModule() {
      // 这一段复用官方 Review 状态模块，只调用现有 source/path 入口。
      // Reuse the official Review state module and call only its existing source/path entrypoints.
      if (!reviewNavigationModulePromise) {
        reviewNavigationModulePromise = getReviewNavigationModulePath().then((modulePath) => {
          if (!modulePath) throw new Error("review-navigation-model module path not found");
          return import(modulePath);
        }).catch((error) => {
          reviewNavigationModulePromise = null;
          throw error;
        });
      }
      return reviewNavigationModulePromise;
    }

    async function getReviewSidePanelTabsModule() {
      // 这一段复用官方侧栏 tab 模块，避免点击环境面板 Changes 行触发全量入口。
      // Reuse the official side-panel tab module instead of clicking the environment Changes row.
      if (!reviewSidePanelTabsModulePromise) {
        reviewSidePanelTabsModulePromise = getReviewSidePanelTabsModulePath().then((modulePath) => {
          if (!modulePath) throw new Error("thread-side-panel-tabs module path not found");
          return import(modulePath);
        }).catch((error) => {
          reviewSidePanelTabsModulePromise = null;
          throw error;
        });
      }
      return reviewSidePanelTabsModulePromise;
    }

    function getReviewSourceSetter(reviewNavigationModule) {
      // 这一段兼容 Codex 官方 review-navigation-model 的导出名漂移：旧版本是 Bt，当前版本是 Xt。
      // Support Codex review-navigation-model export drift: older builds use Bt, current builds use Xt.
      for (const candidate of [reviewNavigationModule?.Bt, reviewNavigationModule?.Xt]) {
        if (typeof candidate === "function") return candidate;
      }
      return null;
    }

    function getWorkspaceRouteScopeFallbackHosts() {
      // 这一段收集少量结构化页面 host 找 route scope，避免依赖文件树是否已经挂载。
      // Collect a few structural page hosts for route-scope lookup without depending on a mounted file tree.
      const hosts = [];
      const addHost = (host) => {
        if (!(host instanceof Element) || hosts.includes(host)) return;
        hosts.push(host);
      };

      for (const selector of routeScopeHostSelectors) {
        for (const host of document.querySelectorAll(selector)) addHost(host);
      }
      return hosts;
    }

    function findWorkspaceRouteScope(anchor, summary) {
      // 这一段把 route scope 查找交给独立工具模块，并提供当前页面的有限兜底 host。
      // Delegate route-scope lookup to the utility module and provide bounded fallback hosts from this page.
      return navigationApi.findWorkspaceRouteScope(anchor, summary, {
        getFallbackHosts: getWorkspaceRouteScopeFallbackHosts,
        getReactFiber,
      });
    }

    async function openWithWorkspaceFileModule(anchor, summary, file, targetRange = null) {
      // 这一段调用 Codex 官方右侧文件预览入口，并用空函数拦截外部 open-file 兜底。
      // Call Codex's official right-side file preview entry and intercept the external open-file fallback.
      const scope = findWorkspaceRouteScope(anchor, summary);
      if (!scope) return false;
      const module = await getWorkspaceFileModule();
      const openWorkspaceFile = getWorkspaceFileOpener(module);
      if (!openWorkspaceFile) return false;
      let usedExternalFallback = false;
      const normalizedRange = navigationApi.firstNavigationRange({ navigationRanges: targetRange ? [targetRange] : [] });
      openWorkspaceFile({
        scope,
        path: file.path,
        cwd: summary.cwd || null,
        hostId: summary.hostId || "local",
        isPreview: false,
        ...(normalizedRange ? { line: normalizedRange.line, endLine: normalizedRange.endLine } : {}),
        openFile: (params) => {
          usedExternalFallback = true;
          console.warn("[Codex-Pro] blocked external open-file fallback for diff hover preview", params);
        },
        openInSidePanel: true,
      });
      return !usedExternalFallback;
    }

    function getExternalDiffBridgePath(summary, path) {
      // 这一段只在发送外部 Diff 前把工作区绝对路径转成桥接层要求的相对路径。
      // Convert workspace-absolute paths to bridge-required relative paths only before sending external diff.
      const normalizedPath = normalizePath(path);
      const normalizedCwd = normalizePath(summary?.cwd).replace(/\/+$/u, "");
      if (!normalizedPath || !normalizedCwd) return normalizedPath;

      // 这一段按 Windows 路径习惯做大小写不敏感比较，避免盘符大小写导致误判。
      // Compare case-insensitively for Windows paths so drive-letter casing does not break matching.
      const lowerPath = normalizedPath.toLowerCase();
      const lowerCwd = normalizedCwd.toLowerCase();
      const cwdPrefix = `${lowerCwd}/`;
      return lowerPath.startsWith(cwdPrefix)
        ? normalizedPath.slice(normalizedCwd.length + 1)
        : normalizedPath;
    }

    function openExternalDiff(summary, file, externalDiffToolPath) {
      // 这一段把外部 Diff 请求交给受控原生桥，页面侧不拼接命令行。
      // Hand the external diff request to the constrained native bridge; the page does not build a command line.
      clearNavigationBar();
      const bridgePath = getExternalDiffBridgePath(summary, file.path);
      const bridgePreviousPath = getExternalDiffBridgePath(summary, file.previousPath);
      const sent = runtime.nativeBridge?.sendExternalDiff?.({
        changeKind: file.changeKind || file.kind,
        cwd: summary.cwd,
        path: bridgePath,
        previousPath: bridgePreviousPath,
        toolPath: externalDiffToolPath,
      });
      hidePanel();
      if (!sent) {
        console.warn("[Codex-Pro] external diff bridge unavailable or rejected request", {
          cwd: summary.cwd,
          path: bridgePath,
        });
        return false;
      }
      return true;
    }

    function findEditedFileCardExternalDiffTarget(target) {
      // 这一段从真实事件目标向上找官方“已编辑文件”卡片里的单文件按钮。
      // Walk upward from the real event target to find a single-file button in Codex's official edited-file card.
      const start = target instanceof HTMLElement
        ? target
        : target instanceof Node
          ? target.parentElement
          : null;
      for (
        let element = start, depth = 0;
        element && element !== document.body && depth <= maxEditedFileCardAncestorDepth;
        element = element.parentElement, depth += 1
      ) {
        if (!element.matches("button")) continue;
        const diffTarget = readEditedFileCardExternalDiffTarget(element);
        if (diffTarget) return diffTarget;
      }
      return null;
    }

    function handleEditedFileCardExternalDiffMouseDown(event) {
      // 这一段只在官方已编辑文件卡片的中键按下时阻止 Chromium 自动滚动，不影响左键官方打开。
      // Prevent Chromium autoscroll only for middle-down on official edited-file card rows, leaving left-click native open untouched.
      if (event.button !== 1 || !isEditedFileCardExternalDiffMiddleClickEnabled()) return;
      const diffTarget = findEditedFileCardExternalDiffTarget(event.target);
      if (!diffTarget) return;
      event.preventDefault();
      event.stopPropagation();
    }

    let lastEditedFileCardMiddleClickDiffAt = 0;
    function handleEditedFileCardExternalDiffAuxClick(event) {
      // 这一段用中键直接打开官方已编辑文件卡片的单文件外部 Diff，并兼容鼠标手势系统回放事件。
      // Open external Diff directly for official edited-file card rows on middle-click, including mouse-gesture replay events.
      if (event.button !== 1 || !isEditedFileCardExternalDiffMiddleClickEnabled()) return;
      const diffTarget = findEditedFileCardExternalDiffTarget(event.target);
      if (!diffTarget) return;
      event.preventDefault();
      event.stopPropagation();
      const now = Date.now();
      if (now - lastEditedFileCardMiddleClickDiffAt < 250) return;
      lastEditedFileCardMiddleClickDiffAt = now;
      const externalDiffToolPath = getExternalDiffToolPath();
      const disabledReason = getExternalDiffDisabledReason(diffTarget.summary, externalDiffToolPath);
      if (disabledReason) {
        console.warn("[Codex-Pro] edited file card external diff middle-click falling back to single-file review:", disabledReason);
        void openEditedFileCardSingleFileReview(diffTarget);
        return;
      }
      if (!openExternalDiff(diffTarget.summary, diffTarget.file, externalDiffToolPath)) {
        void openEditedFileCardSingleFileReview(diffTarget);
      }
    }

    async function openEditedFileCardSingleFileReview(diffTarget) {
      // 这一段回退到右上角环境变更同款单文件 Review，不触发官方文件行左键的全量展开。
      // Fall back to the same single-file Review path as the environment Changes row without clicking the native all-files row.
      const anchor = diffTarget?.button;
      const summary = diffTarget?.summary;
      const file = diffTarget?.file;
      if (!(anchor instanceof HTMLElement) || !summary || !file) {
        console.warn("[Codex-Pro] edited file card single-file review fallback unavailable");
        return false;
      }
      const filterTarget = getReviewFilterTarget(summary, file);
      clearNavigationBar();
      hidePanel();
      clearReviewSingleFileScope();
      if (await openOfficialSingleFileBranchReview(anchor, summary, file, "edited file card")) {
        scheduleEnvironmentReviewSingleFileToggleScope(filterTarget, file);
        return true;
      }
      console.warn("[Codex-Pro] edited file card single-file review opener failed", file.path);
      return false;
    }

    function getReviewFilterPath(summary, file) {
      // 这一段优先使用工作区相对路径，匹配官方审查侧栏里的文件显示和搜索逻辑。
      // Prefer the workspace-relative path so it matches the official review sidebar display and search logic.
      const relativePath = getExternalDiffBridgePath(summary, file.path);
      return relativePath || file.path;
    }

    function isVisibleViewportElement(element) {
      // 这一段统一过滤不可见交互元素，后续官方入口定位不再依赖按钮文案。
      // Filter invisible interactive elements so official-entry discovery no longer depends on button copy.
      if (!(element instanceof HTMLElement)) return false;
      if (element.closest?.(`#${panelId}, #${navigationId}`)) return false;
      const rect = element.getBoundingClientRect();
      if (rect.width <= 0 || rect.height <= 0) return false;
      if (rect.bottom <= 0 || rect.top >= window.innerHeight) return false;
      const style = window.getComputedStyle(element);
      return style.display !== "none" && style.visibility !== "hidden" && Number(style.opacity) !== 0;
    }

    function getReviewTriggerSignature(element) {
      // 这一段只读取候选自身的 diff 签名，用它和当前摘要签名做精确匹配。
      // Read only the candidate's own diff signature so it can be matched exactly to the active summary.
      return buildSummary(readTurnDiff(element))?.signature || "";
    }

    function isLargeEnoughReviewTrigger(candidateRect, anchorRect) {
      // 这一段排除摘要行里的小工具按钮，避免误点复制、更多操作等同 fiber 子按钮。
      // Exclude small utility buttons inside a summary row so copy/more buttons with the same fiber are not clicked.
      if (!anchorRect) return candidateRect.width >= 120 && candidateRect.height >= 24;
      const widthRatio = candidateRect.width / Math.max(anchorRect.width, 1);
      const heightRatio = candidateRect.height / Math.max(anchorRect.height, 1);
      const areaRatio = (candidateRect.width * candidateRect.height) / Math.max(anchorRect.width * anchorRect.height, 1);
      return widthRatio >= 0.6 && heightRatio >= 0.55 && areaRatio >= 0.42;
    }

    function isNearReviewAnchor(candidateRect, anchorRect) {
      // 这一段把候选限制在当前摘要附近，避免全页同签名按钮被当作入口。
      // Keep candidates near the active summary so same-signature buttons elsewhere are not treated as entries.
      if (!anchorRect) return true;
      const horizontalOverlap = Math.min(candidateRect.right, anchorRect.right) - Math.max(candidateRect.left, anchorRect.left);
      const verticalOverlap = Math.min(candidateRect.bottom, anchorRect.bottom) - Math.max(candidateRect.top, anchorRect.top);
      const closeVertical = Math.abs(candidateRect.top - anchorRect.top) <= Math.max(48, anchorRect.height * 1.5);
      return horizontalOverlap > Math.min(candidateRect.width, anchorRect.width) * 0.5 && (verticalOverlap > 0 || closeVertical);
    }

    function isCompactAboveComposerReviewTrigger(element, expectedSignature, anchor) {
      // 这一段兼容新版 Codex 输入框上方修改横条里的紧凑审查按钮，不依赖按钮文案。
      // Support the compact review button in Codex's above-composer change bar without relying on button copy.
      if (!(anchor instanceof HTMLElement) || !findAboveComposerPortal(anchor)) return false;
      if (!(element instanceof HTMLElement) || !anchor.contains(element)) return false;
      if (!element.matches?.("button,[role='button']")) return false;
      const signature = getReviewTriggerSignature(element);
      if (!signature || (expectedSignature && signature !== expectedSignature)) return false;
      const anchorRect = anchor.getBoundingClientRect();
      const rect = element.getBoundingClientRect();
      const centerY = rect.top + rect.height / 2;
      return (
        rect.width >= 24 &&
        rect.height >= 16 &&
        centerY >= anchorRect.top &&
        centerY <= anchorRect.bottom &&
        isNearReviewAnchor(rect, anchorRect)
      );
    }

    function isVisibleReviewTrigger(element, expectedSignature = "", anchorRect = null) {
      // 这一段只接受当前摘要附近、面积接近摘要行且 diff 签名一致的官方审查入口。
      // Accept only near-summary official review entries with similar footprint and matching diff signature.
      if (!isVisibleViewportElement(element)) return false;
      if (isEnvironmentDiffAnchor(element)) return true;
      const signature = getReviewTriggerSignature(element);
      if (!signature || (expectedSignature && signature !== expectedSignature)) return false;
      const rect = element.getBoundingClientRect();
      return isNearReviewAnchor(rect, anchorRect) && isLargeEnoughReviewTrigger(rect, anchorRect);
    }

    function findReviewTriggerFromAnchor(anchor) {
      // 这一段先在当前摘要附近找官方审查入口；环境面板变更行没有按钮时直接复用行自身点击。
      // First look for the official review trigger near the active summary; environment rows reuse their own click target.
      if (anchor instanceof HTMLElement) {
        if (isEnvironmentDiffAnchor(anchor)) return anchor;
        const summary = buildSummary(readTurnDiff(anchor));
        const anchorRect = anchor.getBoundingClientRect();
        if (!summary) return null;
        let current = anchor;
        for (let depth = 0; current && depth < 8; depth += 1, current = current.parentElement) {
          if (current.matches?.("button,[role='button']") && isVisibleReviewTrigger(current, summary.signature, anchorRect)) {
            return current;
          }
          const localTrigger = Array.from(current.querySelectorAll("button,[role='button']"))
            .find((candidate) => isVisibleReviewTrigger(candidate, summary.signature, anchorRect));
          if (localTrigger) return localTrigger;
          const compactLocalTrigger = Array.from(current.querySelectorAll("button,[role='button']"))
            .find((candidate) => isVisibleViewportElement(candidate) &&
              isCompactAboveComposerReviewTrigger(candidate, summary.signature, anchor));
          if (compactLocalTrigger) return compactLocalTrigger;
        }
      }
      return null;
    }

    function setReviewSearchInput(input, value) {
      // 这一段走原生 input value setter 并派发事件，让 Codex 官方 React 状态执行自己的过滤。
      // Use the native input value setter and events so Codex's official React state performs the filtering.
      const setter = Object.getOwnPropertyDescriptor(HTMLInputElement.prototype, "value")?.set;
      if (typeof setter === "function") setter.call(input, value);
      else input.value = value;
      input.dispatchEvent(new InputEvent("input", { bubbles: true, data: value, inputType: "insertText" }));
      input.dispatchEvent(new Event("change", { bubbles: true }));
    }

    function clearReviewSearchInput() {
      // 这一段只在官方搜索框已经挂载时清空它，不主动展开官方文件列表。
      // Clear the official search box only when it is already mounted, without opening the official file list.
      const input = document.querySelector("#review-changed-files-search");
      if (!(input instanceof HTMLInputElement) || input.value === "") return;
      setReviewSearchInput(input, "");
    }

    function getReviewFileListSearchInput() {
      // 这一段以官方搜索框结构作为“文件列表已展开”的唯一信号，不主动按文案展开列表。
      // Use the official search input structure as the only "file list is open" signal, never opening by copy.
      const input = document.querySelector("#review-changed-files-search");
      return input instanceof HTMLInputElement && isVisibleViewportElement(input) ? input : null;
    }

    function isVisibleReviewFileListHideButton(element) {
      // 这一段只在搜索框附近寻找已展开控件，避免用“隐藏文件/Hide files”文案判断按钮。
      // Look only for an expanded control near the search input instead of matching "Hide files" copy.
      const input = getReviewFileListSearchInput();
      if (!input || !(element instanceof HTMLElement) || !isVisibleViewportElement(element)) return false;
      const inputRect = input.getBoundingClientRect();
      const rect = element.getBoundingClientRect();
      if (rect.bottom < inputRect.top - 96 || rect.top > inputRect.bottom + 32) return false;
      if (rect.right < inputRect.left - 96 || rect.left > inputRect.right + 96) return false;
      if (element.getAttribute("aria-expanded") === "true") return true;
      const controls = element.getAttribute("aria-controls") || "";
      return Boolean(controls && document.getElementById(controls)?.contains(input));
    }

    function hideReviewFileListIfVisible() {
      // 这一段如果用户当前已经展开官方文件列表，就把它收起；不会反向展开列表。
      // Collapse the official file list when it is already open; never expand it in the opposite direction.
      const hideFilesButton = Array.from(document.querySelectorAll("button,[role='button']"))
        .find(isVisibleReviewFileListHideButton);
      hideFilesButton?.click();
    }

    function cancelEnvironmentReviewSingleFileScope() {
      // 这一段停止右上角环境面板专用的官方展开状态监听，避免旧点击继续影响新审查页。
      // Stop the environment-panel-only official expansion watcher so stale clicks cannot affect a new review page.
      environmentReviewSingleFileScopeCleanup?.();
      environmentReviewSingleFileScopeCleanup = null;
    }

    function restoreReviewCardDisplay(card) {
      // 这一段恢复之前由单文件作用域隐藏过的官方 diff 卡片。
      // Restore an official diff card previously hidden by the single-file scope.
      if (!(card instanceof HTMLElement) || !card.hasAttribute(reviewScopeHiddenAttribute)) return;
      const previousDisplay = card.getAttribute(reviewScopePreviousDisplayAttribute) || "";
      if (previousDisplay) card.style.display = previousDisplay;
      else card.style.removeProperty("display");
      card.removeAttribute(reviewScopeHiddenAttribute);
      card.removeAttribute(reviewScopePreviousDisplayAttribute);
    }

    function setReviewCardScopedHidden(card, hidden) {
      // 这一段只改当前审查页 diff 卡片的显示状态，不写官方搜索框状态。
      // Change only the visible state of review diff cards without writing the official search state.
      if (!(card instanceof HTMLElement)) return;
      if (!hidden) {
        restoreReviewCardDisplay(card);
        return;
      }
      if (!card.hasAttribute(reviewScopeHiddenAttribute)) {
        card.setAttribute(reviewScopePreviousDisplayAttribute, card.style.display || "");
      }
      card.setAttribute(reviewScopeHiddenAttribute, "true");
      card.style.setProperty("display", "none", "important");
    }

    function applyReviewSingleFileScope(filterTarget) {
      // 这一段在官方审查页内只保留目标文件卡片，文件列表保持收起或原样。
      // Keep only the target file card visible in the official review page while leaving the file list collapsed or unchanged.
      const reviewCards = Array.from(document.querySelectorAll("[data-review-path]"));
      let matchedCount = 0;
      for (const card of reviewCards) {
        if (reviewDiffPathMatches(card.getAttribute("data-review-path"), filterTarget)) matchedCount += 1;
      }
      if (matchedCount <= 0) {
        for (const card of reviewCards) restoreReviewCardDisplay(card);
        return { matchedCount, totalCount: reviewCards.length };
      }
      for (const card of reviewCards) {
        const matched = reviewDiffPathMatches(card.getAttribute("data-review-path"), filterTarget);
        setReviewCardScopedHidden(card, !matched);
      }
      return { matchedCount, totalCount: reviewCards.length };
    }

    function clearReviewSingleFileScope() {
      // 这一段清理我们自己加的单文件作用域，并停止右上角官方展开监听。
      // Clear our single-file scope and stop the environment-panel official expansion watcher.
      cancelEnvironmentReviewSingleFileScope();
      for (const card of document.querySelectorAll(`[${reviewScopeHiddenAttribute}]`)) {
        restoreReviewCardDisplay(card);
      }
    }

    function getOfficialReviewFileToggle(card) {
      // 这一段读取官方审查卡片自己的展开按钮，不依赖右上菜单文案。
      // Read the official review card's own expand toggle without relying on menu copy.
      if (!(card instanceof HTMLElement)) return null;
      const toggle = card.querySelector(`[${reviewFileToggleAttribute}]`);
      return toggle instanceof HTMLElement ? toggle : null;
    }

    function applyEnvironmentReviewSingleFileToggleScope(filterTarget) {
      // 这一段只用于右上角环境面板：折叠非目标官方 diff，只展开目标文件。
      // This is environment-panel only: collapse non-target official diffs and expand only the target file.
      const reviewCards = Array.from(document.querySelectorAll("[data-review-path]"));
      let matchedCount = 0;
      let toggledCount = 0;
      let toggleCount = 0;
      for (const card of reviewCards) {
        const matched = reviewDiffPathMatches(card.getAttribute("data-review-path"), filterTarget);
        if (matched) matchedCount += 1;
        const toggle = getOfficialReviewFileToggle(card);
        const expandedState = toggle?.getAttribute(reviewFileExpandedAttribute) || "";
        if (expandedState !== "true" && expandedState !== "false") continue;
        toggleCount += 1;
        const expanded = expandedState === "true";
        if (expanded !== matched) {
          toggle.click();
          toggledCount += 1;
        }
      }
      return { matchedCount, toggleCount, toggledCount, totalCount: reviewCards.length };
    }

    function scheduleEnvironmentReviewSingleFileToggleScope(filterTarget, file) {
      // 这一段用 MutationObserver 跟随官方异步加载，而不是猜固定延迟后再折叠。
      // Use a MutationObserver to follow official async loading instead of guessing a fixed delay.
      cancelEnvironmentReviewSingleFileScope();
      let stopped = false;
      let animationFrameId = 0;
      let matchedOnce = false;
      let timeoutId = 0;
      let observer = null;

      const applyScope = () => {
        if (stopped || signal.aborted) return { matchedCount: 0, toggleCount: 0, toggledCount: 0, totalCount: 0 };
        const result = applyEnvironmentReviewSingleFileToggleScope(filterTarget);
        if (result.matchedCount > 0) matchedOnce = true;
        return result;
      };

      const cleanup = () => {
        if (stopped) return;
        stopped = true;
        if (timeoutId) window.clearTimeout(timeoutId);
        if (animationFrameId) window.cancelAnimationFrame(animationFrameId);
        observer?.disconnect();
        if (environmentReviewSingleFileScopeCleanup === cleanup) environmentReviewSingleFileScopeCleanup = null;
      };

      const queueApply = () => {
        if (stopped || animationFrameId) return;
        animationFrameId = window.requestAnimationFrame(() => {
          animationFrameId = 0;
          applyScope();
        });
      };

      observer = new MutationObserver(queueApply);
      observer.observe(document.body, {
        attributeFilter: ["data-review-path", reviewFileExpandedAttribute],
        attributes: true,
        childList: true,
        subtree: true,
      });
      environmentReviewSingleFileScopeCleanup = cleanup;
      applyScope();
      timeoutId = window.setTimeout(() => {
        applyScope();
        cleanup();
        if (!matchedOnce) {
          console.warn("[Codex-Pro] official review file toggle not found for environment diff hover preview", file.path);
        }
      }, environmentReviewSingleFileScopeTimeoutMs);
    }

    function syncReviewSingleFileScope(filterTarget, timeoutMs = reviewSingleFileScopeTimeoutMs) {
      // 这一段短轮询官方审查卡片，因为点击审查入口后 diff DOM 会异步挂载。
      // Poll the official review cards briefly because the diff DOM mounts asynchronously after opening review.
      const startedAt = Date.now();
      return new Promise((resolve) => {
        const tick = () => {
          if (signal.aborted) {
            resolve({ matchedCount: 0, totalCount: 0 });
            return;
          }
          hideReviewFileListIfVisible();
          const result = applyReviewSingleFileScope(filterTarget);
          if (result.matchedCount > 0 || Date.now() - startedAt >= timeoutMs) {
            resolve(result);
            return;
          }
          window.setTimeout(tick, reviewSingleFileScopePollMs);
        };
        tick();
      });
    }

    function normalizeReviewDiffPath(value) {
      // 这一段统一审查面板里的绝对路径和悬浮列表里的相对路径，便于只处理当前文件。
      // Normalize absolute review paths and hover-list relative paths so only the current file is handled.
      return String(value || "")
        .replace(/\\/gu, "/")
        .replace(/^\/([A-Za-z]:\/)/u, "$1")
        .toLowerCase();
    }

    function normalizeReviewFilterTarget(targetPath) {
      // 这一段把单文件 Review 的相对路径和绝对路径拆开，避免裸文件名触发后缀误匹配。
      // Split relative and absolute single-file Review targets so bare filenames do not overmatch by suffix.
      if (targetPath && typeof targetPath === "object") {
        return {
          absolutePath: normalizeReviewDiffPath(targetPath.absolutePath),
          relativePath: normalizeReviewDiffPath(targetPath.relativePath),
        };
      }
      return {
        absolutePath: "",
        relativePath: normalizeReviewDiffPath(targetPath),
      };
    }

    function reviewDiffPathMatches(candidatePath, targetPath) {
      // 这一段允许官方绝对路径精确匹配目标文件，同时只对带目录的相对路径启用后缀匹配。
      // Allow exact official absolute-path matches while limiting suffix matching to relative targets with directories.
      const normalizedCandidate = normalizeReviewDiffPath(candidatePath);
      const { absolutePath, relativePath } = normalizeReviewFilterTarget(targetPath);
      if (!normalizedCandidate || !relativePath) return false;
      if (normalizedCandidate === relativePath || (absolutePath && normalizedCandidate === absolutePath)) return true;
      if (!relativePath.includes("/")) return false;
      return normalizedCandidate.endsWith(`/${relativePath}`);
    }

    function shouldClearReviewFilterForClick(event) {
      // 这一段只处理用户真实点击官方审查入口；悬浮面板内的文件行点击会保留单文件筛选流程。
      // Handle only trusted clicks on official review entrypoints; hover-panel file clicks keep the single-file flow.
      if (!event.isTrusted || panel?.contains(event.target)) return false;
      const target = event.target instanceof Element ? event.target : null;
      const trigger = target?.closest?.("button,[role='button']");
      return Boolean(trigger && (isVisibleReviewTrigger(trigger) || isEnvironmentDiffAnchor(trigger)));
    }

    function handleReviewTriggerClick(event) {
      // 这一段在普通官方入口打开审查时清掉上次单文件作用域。
      // Clear the previous single-file scope when review is opened from a normal official entrypoint.
      if (!shouldClearReviewFilterForClick(event)) return;
      clearReviewSingleFileScope();
      window.setTimeout(() => {
        clearReviewSingleFileScope();
        clearReviewSearchInput();
      }, 120);
    }

    function getOfficialReviewSelectPath(summary, file) {
      // 这一段优先给官方 Review 传工作区绝对路径，贴近 branch review 的 data-review-path 形态。
      // Prefer a workspace-absolute path for official Review, matching branch review data-review-path values.
      const normalizedPath = normalizePath(file?.path);
      if (!normalizedPath) return "";
      if (/^(?:[A-Za-z]:\/|\/)/u.test(normalizedPath)) return normalizedPath;
      const normalizedCwd = normalizePath(summary?.cwd).replace(/\/+$/u, "");
      return normalizedCwd ? `${normalizedCwd}/${normalizedPath}` : normalizedPath;
    }

    function getReviewFilterTarget(summary, file) {
      // 这一段同时保留相对路径和绝对路径，供 DOM 过滤精确区分同名文件。
      // Keep both relative and absolute paths so DOM filtering can distinguish files with the same basename.
      const relativePath = getReviewFilterPath(summary, file);
      return {
        absolutePath: getOfficialReviewSelectPath(summary, file),
        relativePath: relativePath || file?.path || "",
      };
    }

    function scheduleReviewSingleFileScope(filterTarget, file) {
      // 这一段在官方 Review 挂载后收起文件列表并只保留目标文件卡片。
      // After official Review mounts, collapse the file list and keep only the target file card.
      window.setTimeout(() => {
        if (signal.aborted) return;
        clearReviewSearchInput();
        hideReviewFileListIfVisible();
      }, 120);
      void syncReviewSingleFileScope(filterTarget).then((result) => {
        if (signal.aborted) return;
        if (!result.matchedCount) {
          console.warn("[Codex-Pro] official review diff card not found for diff hover preview", file.path);
        }
      });
    }

    async function openOfficialSingleFileBranchReview(anchor, summary, file, sourceLabel) {
      // 这一段复用官方 Review source/path API，直接选中目标文件而不是点击会展开全部文件的入口。
      // Reuse Codex's official Review source/path API to select one file directly instead of clicking an all-files entrypoint.
      if (!(anchor instanceof HTMLElement)) return false;
      const scope = findWorkspaceRouteScope(anchor, summary);
      if (!scope) return false;
      try {
        const [reviewNavigationModule, reviewSidePanelTabsModule] = await Promise.all([
          getReviewNavigationModule(),
          getReviewSidePanelTabsModule(),
        ]);
        const setReviewSource = getReviewSourceSetter(reviewNavigationModule);
        const selectReviewPath = reviewNavigationModule?.r;
        const openReviewTab = reviewSidePanelTabsModule?.u;
        if (
          typeof setReviewSource !== "function" ||
          typeof selectReviewPath !== "function" ||
          typeof openReviewTab !== "function"
        ) {
          return false;
        }

        // 这一段只改官方已有的 Review source/path 状态，不自己构造侧栏 tab。
        // Use only official Review source/path state and avoid constructing side-panel tabs ourselves.
        setReviewSource(scope, "branch");
        const opened = openReviewTab(scope);
        const reviewPath = getOfficialReviewSelectPath(summary, file);
        if (reviewPath) selectReviewPath(scope, reviewPath);
        return Boolean(opened);
      } catch (error) {
        console.warn(`[Codex-Pro] official branch review opener failed for ${sourceLabel}`, error?.message || error);
        return false;
      }
    }

    async function openEnvironmentWorkspaceFileReview(anchor, summary, file) {
      // 这一段为右上角环境面板直接设置官方 branch+path 状态，避免点击 Changes 行走全量入口。
      // For the right-top environment panel, set official branch+path state directly instead of clicking Changes.
      if (!(anchor instanceof HTMLElement) || findAboveComposerPortal(anchor) || !isEnvironmentDiffAnchor(anchor)) return false;
      return openOfficialSingleFileBranchReview(anchor, summary, file, "diff hover preview");
    }

    async function openWorkspaceFilePreview(summary, file) {
      // 这一段打开 Codex 官方右侧文件预览，并初始化当前文件的变更块导航条。
      // Open Codex's official right-side file preview and initialize this file's change-hunk navigator.
      const anchor = findSummaryAnchor(summary);
      const ranges = getNavigationRanges(file);
      clearReviewSingleFileScope();
      hidePanel();
      const opened = await openWithWorkspaceFileModule(anchor, summary, file, ranges[0] || null);
      if (!opened) {
        console.warn("[Codex-Pro] official file preview opener unavailable for diff hover preview", file.path);
      }
      showNavigationForFile(anchor, summary, file, ranges);
    }

    async function openWorkspaceFileReview(summary, file) {
      // 这一段左键打开 Codex 官方审查页；右上角和输入区入口各自保留自己的限定方式。
      // Left-click opens Codex's official review view; environment and composer entries keep separate scoping.
      const anchor = findSummaryAnchor(summary);
      const filterTarget = getReviewFilterTarget(summary, file);
      const environmentReviewAnchor = anchor instanceof HTMLElement && isEnvironmentDiffAnchor(anchor) && !findAboveComposerPortal(anchor);
      clearNavigationBar();
      hidePanel();
      clearReviewSingleFileScope();
      if (environmentReviewAnchor && await openEnvironmentWorkspaceFileReview(anchor, summary, file)) {
        scheduleEnvironmentReviewSingleFileToggleScope(filterTarget, file);
        return;
      }
      const trigger = findReviewTriggerFromAnchor(anchor);
      if (!trigger) {
        console.warn("[Codex-Pro] official review trigger not found for diff hover preview", file.path);
        return;
      }
      trigger.click();
      if (environmentReviewAnchor) scheduleEnvironmentReviewSingleFileToggleScope(filterTarget, file);
      else scheduleReviewSingleFileScope(filterTarget, file);
    }

    function openWorkspaceFile(summary, file) {
      // 这一段按设置选择悬浮文件行的左键打开方式，键盘触发也复用同一入口。
      // Choose the hover file row's left-click behavior from settings, sharing the path with keyboard activation.
      if (getDiffHoverFileOpenMode() === "preview") {
        void openWorkspaceFilePreview(summary, file);
        return;
      }
      void openWorkspaceFileReview(summary, file);
    }

    document.addEventListener("pointerover", handlePointerOver, { capture: true, signal });
    document.addEventListener("pointerout", handlePointerOut, { capture: true, signal });
    document.addEventListener("click", handleReviewTriggerClick, { capture: true, signal });
    document.addEventListener("mousedown", handleEditedFileCardExternalDiffMouseDown, { capture: true, signal });
    document.addEventListener("auxclick", handleEditedFileCardExternalDiffAuxClick, { capture: true, signal });
    document.addEventListener("focusin", handleFocusIn, { signal });
    document.addEventListener("focusout", handleFocusOut, { signal });
    document.addEventListener("pointerup", () => {
      // 这一段在用户点击关闭右侧面板或文件 tab 后尽快复核导航条可见性。
      // Recheck navigator visibility promptly after clicks that may close the right panel or file tab.
      if (navigationState) window.setTimeout(placeNavigationRoot, 80);
    }, { capture: true, signal });
    window.addEventListener("resize", placeNavigationRoot, { signal });

    signal.addEventListener(
      "abort",
      () => {
        // 这一段清理本系统创建的 DOM、样式、计时器和摘要标记，支持设置里即时关闭。
        // Clean up DOM, styles, timers, and summary markers so the setting can disable the system immediately.
        window.clearTimeout(hideTimer);
        if (navigationSyncInterval) window.clearInterval(navigationSyncInterval);
        clearReviewSingleFileScope();
        panel?.remove();
        navigationRoot?.remove();
        document.getElementById(styleId)?.remove();
        activeAnchor?.removeAttribute(summaryAttribute);
      },
      { once: true },
    );
  }, { enableSetting: "enableDiffHoverPreview" });
})();
