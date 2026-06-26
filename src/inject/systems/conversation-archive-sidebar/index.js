(() => {
  const runtime = window.__codexProRuntime;
  if (!runtime) return;
  const i18n = runtime.i18n;

  const rootId = "codex-pro-conversation-archive-sidebar-root";
  const panelId = "codex-pro-conversation-archive-sidebar-panel";
  const profileMenuId = "codex-pro-conversation-archive-profile-menu";
  const threadPanelId = "codex-pro-conversation-archive-thread-panel";
  const styleId = "codex-pro-conversation-archive-sidebar-style";
  const previewFileTreeHiddenAttribute = "data-codex-pro-conversation-archive-file-tree-hidden";
  const conversationArchiveStatusEventName = "codex-pro:conversation-archive-status";
  const conversationArchiveThreadDragDataType = "application/x-codex-pro-conversation-archive-thread";
  const workspaceFileModulePattern = /(?:assets\/)?open-workspace-file-[A-Za-z0-9_-]+\.js/u;
  const workspaceFileModuleFallbackPaths = [
    "./assets/open-workspace-file-CJcJ-CWR.js",
    "./assets/open-workspace-file-CQYIHLHN.js",
  ];
  const conversationArchiveAttachmentPointerThresholdPx = 8;
  const refreshDelayMs = 250;
  const pendingDeleteRefreshDelayMs = 3000;
  const remoteListRefreshIntervalMs = 30 * 60 * 1000;
  const statusResetDelayMs = 3000;
  const devicePanelHoverCloseDelayMs = 240;
  const threadPanelHoverCloseDelayMs = 240;
  const panelViewportMargin = 8;
  const routeScopeObjectDepth = 8;
  const routeScopeObjectKeys = 80;
  const routeScopeFiberDepth = 160;
  const codexProDataDirectoryName = ".Codex-Pro-Launcher";
  const conversationArchivePreviewPathSegment = `/${codexProDataDirectoryName}/conversation-archive-preview/`;

  let workspaceFileModulePathPromise = null;
  let workspaceFileModulePromise = null;

  function normalizePath(value) {
    // 这一段统一本机路径分隔符，方便判断预览文件是否属于 Codex-Pro 数据根。
    // Normalize local separators so preview-file Codex-Pro data-root checks are stable.
    return String(value || "").replace(/\\/g, "/").replace(/\/+$/u, "").trim();
  }

  function getReactFiber(element) {
    // 这一段读取 React 挂在 DOM 节点上的 fiber 指针，用于调用 Codex 原生文件打开入口。
    // Read the React fiber pointer stored on DOM nodes so Codex's native file opener can be reached.
    if (!element) return null;
    const key = Object.keys(element).find((name) => name.startsWith("__reactFiber$") || name.startsWith("__reactInternalInstance$"));
    return key ? element[key] : null;
  }

  function installStyle() {
    // 这一段安装同步侧栏样式；重复注入时先复用同一个 style 节点。
    // Install sync-sidebar styles while reusing the same style node across reinjections.
    runtime.dom.ensureNativePanelTokens?.();
    runtime.dom.upsertStyle(styleId, `
      #${rootId} {
        --codex-pro-sync-sidebar-foreground: var(--codex-pro-native-panel-foreground);
        --codex-pro-sync-sidebar-muted: var(--codex-pro-native-panel-muted);
        --codex-pro-sync-sidebar-hover: var(--codex-pro-native-panel-hover);
        margin-top: auto;
        padding: 6px 8px 0;
      }
      #${rootId} .codex-pro-sync-heading {
        color: var(--codex-pro-sync-sidebar-muted);
        font-size: 16px;
        line-height: 24px;
        padding: 0 8px;
      }
      #${rootId} .codex-pro-sync-header {
        align-items: center;
        display: flex;
        gap: 6px;
        justify-content: space-between;
        min-height: 28px;
      }
      #${rootId} .codex-pro-sync-refresh {
        align-items: center;
        background: transparent;
        border: 0;
        border-radius: 6px;
        color: var(--codex-pro-sync-sidebar-muted);
        cursor: pointer;
        display: inline-flex;
        height: 26px;
        justify-content: center;
        padding: 0;
        width: 26px;
      }
      #${rootId} .codex-pro-sync-refresh:hover {
        background: var(--codex-pro-sync-sidebar-hover);
        color: var(--codex-pro-sync-sidebar-foreground);
      }
      #${rootId} .codex-pro-sync-refresh:disabled {
        cursor: default;
        opacity: 0.45;
      }
      #${rootId} .codex-pro-sync-device-list {
        display: flex;
        flex-direction: column;
        gap: 1px;
      }
      #${rootId} .codex-pro-sync-device-button {
        align-items: center;
        background: transparent;
        border: 0;
        border-radius: 6px;
        color: var(--codex-pro-sync-sidebar-muted);
        cursor: pointer;
        display: flex;
        font: inherit;
        min-height: 30px;
        min-width: 0;
        overflow: hidden;
        padding: 5px 8px;
        text-align: left;
        width: 100%;
      }
      #${rootId} .codex-pro-sync-device-button:hover,
      #${rootId} .codex-pro-sync-device-button[aria-selected="true"] {
        background: var(--codex-pro-sync-sidebar-hover);
        color: var(--codex-pro-sync-sidebar-foreground);
      }
      #${rootId} .codex-pro-sync-device-name,
      #${panelId} .codex-pro-sync-group-name,
      #${panelId} .codex-pro-sync-thread-title,
      #${threadPanelId} .codex-pro-sync-thread-title,
      #${threadPanelId} .codex-pro-sync-panel-title,
      #${panelId} .codex-pro-sync-panel-title {
        min-width: 0;
        overflow: hidden;
        text-overflow: ellipsis;
        white-space: nowrap;
      }
      #${rootId} .codex-pro-sync-empty {
        color: var(--codex-pro-sync-sidebar-muted);
        font-size: 12px;
        line-height: 18px;
        padding: 6px 8px;
      }
      #${panelId},
      #${threadPanelId},
      #${profileMenuId}.codex-pro-sync-profile-menu {
        --codex-pro-sync-surface: var(--codex-pro-native-panel-surface);
        --codex-pro-sync-border: var(--codex-pro-native-panel-border);
        --codex-pro-sync-foreground: var(--codex-pro-native-panel-foreground);
        --codex-pro-sync-muted: var(--codex-pro-native-panel-muted);
        --codex-pro-sync-row: var(--codex-pro-native-panel-row);
        --codex-pro-sync-row-hover: var(--codex-pro-native-panel-hover);
        --codex-pro-sync-row-active: var(--codex-pro-native-panel-active);
        --codex-pro-sync-shadow: var(--codex-pro-native-panel-shadow);
      }
      #${panelId} {
        background: var(--codex-pro-sync-surface);
        background-clip: padding-box;
        border: 1px solid var(--codex-pro-sync-border);
        border-radius: var(--codex-pro-native-panel-radius);
        box-shadow: var(--codex-pro-sync-shadow);
        color: var(--codex-pro-sync-foreground);
        display: flex;
        flex-direction: column;
        height: auto;
        left: 320px;
        max-height: calc(100vh - 16px);
        max-width: calc(100vw - 16px);
        min-width: min(300px, calc(100vw - 16px));
        overflow: hidden;
        position: fixed;
        top: 36px;
        width: min(380px, calc(100vw - 16px));
        z-index: 60;
        -webkit-backdrop-filter: blur(var(--codex-pro-native-panel-blur));
        backdrop-filter: blur(var(--codex-pro-native-panel-blur));
      }
      #${threadPanelId} {
        background: var(--codex-pro-sync-surface);
        background-clip: padding-box;
        border: 1px solid var(--codex-pro-sync-border);
        border-radius: var(--codex-pro-native-panel-radius-medium);
        box-shadow: var(--codex-pro-sync-shadow);
        color: var(--codex-pro-sync-foreground);
        display: flex;
        flex-direction: column;
        height: min(760px, max(320px, calc(100vh - 72px)));
        left: 712px;
        max-height: calc(100vh - 16px);
        max-width: calc(100vw - 16px);
        min-width: min(320px, calc(100vw - 16px));
        overflow: hidden;
        position: fixed;
        top: 36px;
        width: min(420px, calc(100vw - 16px));
        z-index: 61;
        -webkit-backdrop-filter: blur(var(--codex-pro-native-panel-blur));
        backdrop-filter: blur(var(--codex-pro-native-panel-blur));
      }
      #${panelId}[hidden] {
        display: none;
      }
      #${threadPanelId}[hidden] {
        display: none;
      }
      #${panelId} .codex-pro-sync-panel-header,
      #${threadPanelId} .codex-pro-sync-panel-header {
        align-items: center;
        cursor: grab;
        display: flex;
        gap: 8px;
        min-height: 40px;
        padding: 12px 14px 4px 16px;
        touch-action: none;
        user-select: none;
      }
      #${panelId}[data-codex-pro-sync-dragging="true"] .codex-pro-sync-panel-header {
        cursor: grabbing;
      }
      #${panelId} .codex-pro-sync-panel-title,
      #${threadPanelId} .codex-pro-sync-panel-title {
        color: var(--codex-pro-sync-muted);
        flex: 1;
        font-size: 16px;
        font-weight: 430;
        line-height: 24px;
      }
      #${panelId} .codex-pro-sync-panel-actions {
        align-items: center;
        display: inline-flex;
        flex: 0 0 auto;
        gap: 4px;
      }
      #${panelId} .codex-pro-sync-panel-action {
        align-items: center;
        background: transparent;
        border: 0;
        border-radius: 6px;
        color: var(--codex-pro-sync-muted);
        cursor: pointer;
        display: inline-flex;
        height: 28px;
        justify-content: center;
        padding: 0;
        width: 28px;
      }
      #${panelId} .codex-pro-sync-panel-action:hover {
        background: var(--codex-pro-sync-row-hover);
        color: var(--codex-pro-sync-foreground);
      }
      #${panelId} .codex-pro-sync-panel-action:disabled {
        cursor: default;
        opacity: 0.45;
      }
      #${panelId} .codex-pro-sync-panel-action svg {
        height: 15px;
        width: 15px;
      }
      #${panelId} .codex-pro-sync-profile-picker {
        margin: 4px 12px 6px;
      }
      #${panelId} .codex-pro-sync-profile-trigger {
        align-items: center;
        background: transparent;
        border: 1px solid transparent;
        border-radius: var(--codex-pro-native-panel-radius-inner);
        color: var(--codex-pro-sync-muted);
        cursor: pointer;
        display: flex;
        font: inherit;
        font-size: 13px;
        gap: 8px;
        min-height: 34px;
        outline: none;
        padding: 0 10px 0 12px;
        text-align: left;
        width: 100%;
      }
      #${panelId} .codex-pro-sync-profile-trigger:hover {
        background: var(--codex-pro-sync-row-hover);
        border-color: var(--codex-pro-sync-border);
        color: var(--codex-pro-sync-foreground);
      }
      #${panelId} .codex-pro-sync-profile-trigger:focus-visible {
        background: var(--codex-pro-sync-row-hover);
        border-color: var(--codex-pro-sync-border);
        color: var(--codex-pro-sync-foreground);
        outline: 1px solid var(--codex-pro-sync-border);
        outline-offset: 2px;
      }
      #${panelId} .codex-pro-sync-profile-label {
        flex: 1;
        min-width: 0;
        overflow: hidden;
        text-overflow: ellipsis;
        white-space: nowrap;
      }
      #${panelId} .codex-pro-sync-profile-chevron {
        color: var(--codex-pro-sync-muted);
        flex: 0 0 auto;
        height: 7px;
        margin-right: 2px;
        transform: rotate(45deg) translate(-1px, -1px);
        width: 7px;
        border-bottom: 1.4px solid currentColor;
        border-right: 1.4px solid currentColor;
      }
      #${profileMenuId}.codex-pro-sync-profile-menu {
        background: var(--codex-pro-sync-surface);
        background-clip: padding-box;
        border: 1px solid var(--codex-pro-sync-border);
        border-radius: var(--codex-pro-native-panel-radius-small);
        box-shadow: var(--codex-pro-native-panel-shadow-compact);
        display: flex;
        flex-direction: column;
        gap: 2px;
        max-height: min(260px, calc(100vh - 160px));
        min-width: min(220px, calc(100vw - 16px));
        overflow-x: hidden;
        overflow-y: auto;
        padding: 6px;
        position: fixed;
        z-index: 63;
        -webkit-backdrop-filter: blur(var(--codex-pro-native-panel-blur));
        backdrop-filter: blur(var(--codex-pro-native-panel-blur));
      }
      #${profileMenuId} .codex-pro-sync-profile-option {
        align-items: center;
        background: transparent;
        border: 0;
        border-radius: var(--codex-pro-native-panel-radius-inner);
        color: var(--codex-pro-sync-foreground);
        cursor: pointer;
        display: flex;
        font: inherit;
        font-size: 13px;
        gap: 8px;
        min-height: 30px;
        padding: 0 8px 0 10px;
        text-align: left;
        width: 100%;
      }
      #${profileMenuId} .codex-pro-sync-profile-option:hover,
      #${profileMenuId} .codex-pro-sync-profile-option[aria-selected="true"] {
        background: var(--codex-pro-sync-row-hover);
      }
      #${profileMenuId} .codex-pro-sync-profile-option-label {
        flex: 1;
        min-width: 0;
        overflow: hidden;
        text-overflow: ellipsis;
        white-space: nowrap;
      }
      #${profileMenuId} .codex-pro-sync-profile-check {
        color: var(--codex-pro-sync-foreground);
        flex: 0 0 auto;
        font-size: 14px;
        line-height: 1;
        opacity: 0;
      }
      #${profileMenuId} .codex-pro-sync-profile-option[aria-selected="true"] .codex-pro-sync-profile-check {
        opacity: 1;
      }
      #${panelId} .codex-pro-sync-group-list {
        display: flex;
        flex: 0 1 auto;
        flex-direction: column;
        gap: 4px;
        max-height: min(620px, calc(100vh - 128px));
        min-height: 0;
        overflow-x: hidden;
        overflow-y: auto;
        padding: 6px 10px 12px;
      }
      #${panelId} .codex-pro-sync-group-button {
        align-items: center;
        background: transparent;
        border: 0;
        border-radius: var(--codex-pro-native-panel-radius-inner);
        color: color-mix(in srgb, var(--codex-pro-sync-foreground) 68%, transparent);
        cursor: pointer;
        display: flex;
        font: inherit;
        gap: 8px;
        min-height: 42px;
        min-width: 0;
        padding: 8px;
        text-align: left;
        width: 100%;
      }
      #${panelId} .codex-pro-sync-group-button:hover,
      #${panelId} .codex-pro-sync-group-button[aria-selected="true"] {
        background: var(--codex-pro-sync-row-hover);
        color: var(--codex-pro-sync-foreground);
      }
      #${panelId} .codex-pro-sync-group-button[data-codex-pro-sync-pinned="true"] .codex-pro-sync-group-name::after {
        color: color-mix(in srgb, var(--codex-pro-sync-foreground) 50%, transparent);
        content: "  •";
      }
      #${panelId} .codex-pro-sync-group-icon {
        flex: 0 0 auto;
        height: 18px;
        opacity: 0.86;
        width: 18px;
      }
      #${panelId} .codex-pro-sync-group-name {
        flex: 1 1 auto;
        font-size: 14px;
        line-height: 20px;
      }
      #${panelId} .codex-pro-sync-group-count {
        color: var(--codex-pro-sync-muted);
        flex: 0 0 auto;
        font-size: 12px;
        line-height: 18px;
      }
      #${panelId} .codex-pro-sync-status,
      #${threadPanelId} .codex-pro-sync-status {
        color: var(--codex-pro-sync-muted);
        font-size: 12px;
        line-height: 18px;
        min-height: 18px;
        padding: 7px 12px;
      }
      #${threadPanelId} .codex-pro-sync-status {
        flex: 0 0 44px;
        height: 44px;
        line-height: 44px;
        min-height: 44px;
        overflow: hidden;
        padding: 0 12px;
        text-overflow: ellipsis;
        white-space: nowrap;
      }
      #${threadPanelId} .codex-pro-sync-status[data-tone="idle"] {
        color: color-mix(in srgb, var(--codex-pro-sync-muted) 82%, transparent);
      }
      #${panelId} .codex-pro-sync-status[data-tone="error"],
      #${threadPanelId} .codex-pro-sync-status[data-tone="error"] {
        color: #ff9a9a;
      }
      #${panelId} .codex-pro-sync-status[data-tone="success"],
      #${threadPanelId} .codex-pro-sync-status[data-tone="success"] {
        color: #8fd7a5;
      }
      #${threadPanelId} .codex-pro-sync-thread-list {
        display: flex;
        flex: 1 1 auto;
        flex-direction: column;
        gap: 6px;
        min-height: 0;
        overflow-x: hidden;
        overflow-y: auto;
        padding: 6px 10px 12px;
      }
      #${threadPanelId} .codex-pro-sync-thread-button {
        background: color-mix(in srgb, var(--codex-pro-sync-foreground) 4%, transparent);
        border: 1px solid var(--codex-pro-native-panel-border-soft);
        border-radius: var(--codex-pro-native-panel-radius-inner);
        color: inherit;
        cursor: pointer;
        display: flex;
        flex-direction: column;
        gap: 2px;
        justify-content: center;
        min-height: 56px;
        min-width: 0;
        overflow: hidden;
        padding: 8px;
        text-align: left;
        width: 100%;
      }
      #${threadPanelId} .codex-pro-sync-thread-button[draggable="true"] {
        cursor: grab;
      }
      #${threadPanelId} .codex-pro-sync-thread-button[draggable="true"]:active {
        cursor: grabbing;
      }
      #${threadPanelId} .codex-pro-sync-thread-button:hover {
        background: color-mix(in srgb, var(--codex-pro-sync-foreground) 6%, transparent);
        border-color: color-mix(in srgb, var(--codex-pro-sync-foreground) 12%, var(--codex-pro-native-panel-border-soft));
      }
      #${threadPanelId} .codex-pro-sync-thread-button[aria-selected="true"] {
        background: color-mix(in srgb, #0e9eea 12%, transparent);
        border-color: color-mix(in srgb, #0e9eea 48%, var(--codex-pro-native-panel-border-soft));
      }
      #${threadPanelId} .codex-pro-sync-thread-button:focus-visible {
        border-color: color-mix(in srgb, Highlight 58%, var(--codex-pro-native-panel-border-soft));
        outline: none;
      }
      #${threadPanelId} .codex-pro-sync-thread-title {
        color: var(--codex-pro-sync-foreground);
        display: block;
        flex: 0 0 auto;
        font-size: 16px;
        font-weight: 560;
        line-height: 22px;
        max-width: 100%;
        min-height: 22px;
        overflow: hidden;
        text-overflow: ellipsis;
        white-space: nowrap;
      }
      #${threadPanelId} .codex-pro-sync-thread-meta {
        color: var(--codex-pro-sync-muted);
        display: block;
        flex: 0 0 auto;
        font-size: 12px;
        line-height: 16px;
        max-width: 100%;
        min-height: 16px;
        overflow: hidden;
        text-overflow: ellipsis;
        white-space: nowrap;
      }
      [role="tabpanel"][data-app-shell-tab-panel-controller="right"][data-tab-id*="/.Codex-Pro-Launcher/conversation-archive-preview/"] [${previewFileTreeHiddenAttribute}] {
        display: none !important;
      }
    `);
  }

  function removeDom() {
    // 这一段清理本系统创建的 DOM，保证关闭设置或重新注入不会留下浮层。
    // Remove DOM created by this system so disabling the setting or reinjection leaves no floating panel.
    restoreConversationArchivePreviewFileTrees();
    document.getElementById(rootId)?.remove();
    document.getElementById(panelId)?.remove();
    document.getElementById(profileMenuId)?.remove();
    document.getElementById(threadPanelId)?.remove();
    document.getElementById(styleId)?.remove();
  }

  function removeVisibleSyncSidebarDom() {
    // 这一段只移除同步侧栏可见节点，保留样式和系统生命周期，授权恢复后可重新挂载。
    // Remove only visible sync-sidebar nodes while keeping styles and lifecycle so authorization recovery can remount.
    document.getElementById(rootId)?.remove();
    document.getElementById(panelId)?.remove();
    document.getElementById(profileMenuId)?.remove();
    document.getElementById(threadPanelId)?.remove();
  }

  function getVisibleRect(element) {
    // 这一段读取可见布局尺寸，隐藏侧栏或旧节点不会被当成挂载目标。
    // Read visible layout bounds so hidden sidebars or stale nodes are not treated as mount targets.
    if (!(element instanceof Element)) return null;
    const rect = element.getBoundingClientRect();
    if (rect.width <= 0 || rect.height <= 0) return null;
    const style = window.getComputedStyle(element);
    if (style.visibility === "hidden" || style.display === "none") return null;
    return rect;
  }

  function findSidebarScroll() {
    // 这一段只找 Codex 原生侧栏滚动容器，不依赖“项目/对话”等多语言文案。
    // Find only Codex's native sidebar scroll container, without relying on localized Project/Thread labels.
    for (const candidate of document.querySelectorAll("[data-app-action-sidebar-scroll]")) {
      const rect = getVisibleRect(candidate);
      if (rect && rect.left <= 16 && rect.right <= 560) return candidate;
    }
    return null;
  }

  function isThreadTimelineElement(element) {
    // 这一段排除主聊天时间线变化，避免冷加载消息时反复重挂同步侧栏。
    // Exclude main chat timeline changes so cold message loading does not repeatedly remount the sync sidebar.
    return Boolean(element instanceof Element && element.closest?.(".thread-scroll-container"));
  }

  function mutationTouchesNativeSidebar(mutation) {
    // 这一段只把原生侧栏结构变化视为重挂载信号，几何读取限制在 aside/nav 外壳。
    // Treat only native-sidebar structural changes as remount signals, limiting geometry reads to aside/nav shells.
    const target = mutation.target instanceof Element ? mutation.target : mutation.target?.parentElement;
    if (!target || target.closest?.(`#${rootId}, #${panelId}`) || isThreadTimelineElement(target)) return false;
    if (target.matches?.("[data-app-action-sidebar-scroll]") || target.closest?.("[data-app-action-sidebar-scroll]")) return true;
    if (target !== document.body && target !== document.documentElement && target.querySelector?.(`#${rootId}, [data-app-action-sidebar-scroll]`)) return true;
    if ([...mutation.addedNodes, ...mutation.removedNodes].some((node) => (
      node instanceof Element &&
      (node.matches?.("[data-app-action-sidebar-scroll]") || Boolean(node.querySelector?.("[data-app-action-sidebar-scroll]")))
    ))) {
      return true;
    }
    const shell = target.closest?.("aside, nav");
    const rect = getVisibleRect(shell);
    return Boolean(rect && rect.left <= 24 && rect.right <= 640);
  }

  function getArchiveDevices(snapshot) {
    // 这一段从远端归档快照取设备列表，坏数据直接视为空列表。
    // Read device entries from the remote archive snapshot and treat malformed data as empty.
    return Array.isArray(snapshot?.devices) ? snapshot.devices : [];
  }

  function isLocalArchiveDevice(device, snapshot) {
    // 这一段用 native bridge 返回的本机随机设备 ID 判断当前设备，不用电脑名做模糊匹配。
    // Detect the current device through the native bridge random device id instead of fuzzy name matching.
    const localDeviceId = String(snapshot?.identity?.deviceId || "");
    return Boolean(localDeviceId && device?.deviceId === localDeviceId);
  }

  function formatArchiveDeviceName(device, snapshot) {
    // 这一段为设备名追加本机标记，侧栏和弹出栏标题保持一致。
    // Append the local marker to device names consistently in the sidebar and flyout title.
    const deviceName = device?.deviceName || device?.deviceId || i18n.t("common.unknownDevice");
    return isLocalArchiveDevice(device, snapshot) ? i18n.t("common.localDevice", { name: deviceName }) : deviceName;
  }

  function getSortedArchiveDevices(snapshot) {
    // 这一段让本机设备永远排在同步设备列表第一位，其余设备按名称稳定排序。
    // Keep the local device first in the sync device list and sort other devices by name.
    return [...getArchiveDevices(snapshot)].sort((left, right) => {
      const localDelta = Number(isLocalArchiveDevice(right, snapshot)) - Number(isLocalArchiveDevice(left, snapshot));
      if (localDelta) return localDelta;
      return String(left.deviceName || left.deviceId || "").localeCompare(String(right.deviceName || right.deviceId || ""));
    });
  }

  function normalizeArchiveThreadId(value) {
    // 这一段统一原生侧栏和归档 manifest 的 thread id 形态，方便比较排序。
    // Normalize native sidebar and archive manifest thread ids so sort-order comparison is stable.
    return String(value || "").trim().replace(/^local:/u, "");
  }

  function getArchiveThreadSortTime(thread) {
    // 这一段优先使用最后更新时间排序，缺少更新时间时才回退到创建时间。
    // Sort by last update time first, falling back to created time when update time is missing.
    const value = thread.sourceUpdatedAt || thread.sourceCreatedAt;
    const timestamp = Date.parse(String(value || ""));
    return Number.isFinite(timestamp) ? timestamp : 0;
  }

  function compareArchiveThreads(left, right) {
    // 这一段按最后更新时间倒序排列同步会话，时间相同时用 thread id 保持稳定。
    // Sort synced threads by last update time descending and keep deterministic order with thread id ties.
    const timeDelta = getArchiveThreadSortTime(right) - getArchiveThreadSortTime(left);
    if (timeDelta) return timeDelta;
    return normalizeArchiveThreadId(right.threadId).localeCompare(normalizeArchiveThreadId(left.threadId));
  }

  function getDeviceProfiles(device) {
    // 这一段读取设备下的账号列表，兼容远端异常结构时返回空数组。
    // Read profiles under a device, returning an empty array for malformed remote shapes.
    return Array.isArray(device?.profiles) ? device.profiles : [];
  }

  function getProfileGroupKey(group) {
    // 这一段用类型和 ID 组合目录 key，避免项目和普通对话 ID 碰撞。
    // Combine type and id into a group key so projects and conversations cannot collide.
    return `${group?.archiveGroupType || "conversation"}:${group?.archiveGroupId || "conversation_default"}`;
  }

  function createFallbackConversationGroup(profile) {
    // 这一段把旧版平铺会话折成“对话”目录，保证未重新同步的历史也能浏览。
    // Fold legacy flat threads into the Conversations directory so old archives remain browsable.
    const threads = Array.isArray(profile?.threads) ? profile.threads.slice().sort(compareArchiveThreads) : [];
    return {
      archiveGroupId: "conversation_default",
      archiveGroupName: i18n.t("syncSidebar.group.conversations"),
      archiveGroupType: "conversation",
      threads,
    };
  }

  function getProfileGroups(profile) {
    // 这一段读取账号下的目录分组；没有分组字段时使用旧数据兜底。
    // Read directory groups under a profile, falling back for legacy payloads without group fields.
    const groups = Array.isArray(profile?.groups) ? profile.groups : [];
    const normalizedGroups = groups
      .map((group) => ({
        archiveGroupDisplayName: group?.archiveGroupDisplayName || group?.archiveGroupName || (group?.archiveGroupType === "project" ? i18n.t("syncSidebar.group.projects") : i18n.t("syncSidebar.group.conversations")),
        archiveGroupId: group?.archiveGroupId || "conversation_default",
        archiveGroupName: group?.archiveGroupName || (group?.archiveGroupType === "project" ? i18n.t("syncSidebar.group.projects") : i18n.t("syncSidebar.group.conversations")),
        archiveGroupType: group?.archiveGroupType === "project" ? "project" : "conversation",
        threads: Array.isArray(group?.threads) ? group.threads.slice().sort(compareArchiveThreads) : [],
      }))
      .filter((group) => group.threads.length > 0);
    if (normalizedGroups.length > 0) {
      return normalizedGroups.sort((left, right) => {
        const typeDelta = Number(left.archiveGroupType !== "project") - Number(right.archiveGroupType !== "project");
        return typeDelta || left.archiveGroupName.localeCompare(right.archiveGroupName);
      });
    }
    const fallbackGroup = createFallbackConversationGroup(profile);
    return fallbackGroup.threads.length > 0 ? [fallbackGroup] : [];
  }

  function getDeviceThreads(device) {
    // 这一段把同一设备下所有 profile 的会话展平，并按最后更新时间倒序排序。
    // Flatten all profiles under one device and sort by last update time descending.
    const threads = [];
    for (const profile of getDeviceProfiles(device)) {
      for (const thread of Array.isArray(profile?.threads) ? profile.threads : []) {
        threads.push({
          ...thread,
          profileId: profile.profileId || "",
          profileName: profile.profileName || i18n.t("common.defaultProfile"),
        });
      }
    }
    return threads.sort(compareArchiveThreads);
  }

  function formatArchiveTime(value) {
    // 这一段把归档更新时间压成短时间，保持侧栏会话行紧凑。
    // Format archive update timestamps compactly so sidebar rows stay scannable.
    const timestamp = Date.parse(String(value || ""));
    if (!Number.isFinite(timestamp)) return "";
    return i18n.formatDateTime(timestamp);
  }

  function formatArchiveBytes(value) {
    // 这一段用近似大小提示 Markdown 体量，避免展开正文前没有任何量级信息。
    // Show approximate Markdown size so users get scale without downloading the body first.
    const bytes = Math.max(0, Math.floor(Number(value) || 0));
    if (bytes >= 1024 * 1024) return `${(bytes / (1024 * 1024)).toFixed(1)} MB`;
    if (bytes >= 1024) return `${Math.round(bytes / 1024)} KB`;
    return `${bytes} B`;
  }

  function formatArchiveTransferRate(value) {
    // 这一段把 native bridge 上传速度压成短单位，避免左下角标题过长。
    // Format native-bridge upload speed into compact units so the lower-left heading stays short.
    const bytesPerSecond = Math.max(0, Math.floor(Number(value) || 0));
    if (bytesPerSecond <= 0) return "";
    if (bytesPerSecond >= 1024 * 1024) return `${(bytesPerSecond / (1024 * 1024)).toFixed(1)} MB/s`;
    if (bytesPerSecond >= 1024) return `${Math.max(1, Math.round(bytesPerSecond / 1024))} KB/s`;
    return `${bytesPerSecond} B/s`;
  }

  function getArchiveUploadProgressStatusText(progress) {
    // 这一段把扫描、处理和上传进度转成左下角短状态；上传前不显示 0/0 这类噪声。
    // Convert scan, processing, and upload progress into a short lower-left status, avoiding noisy 0/0 text before upload starts.
    const stage = String(progress?.stage || "").trim();
    if (stage === "init" || stage === "pull" || stage === "scan") return i18n.t("syncSidebar.headingStatus.scanning");
    const totalCount = Math.max(0, Math.floor(Number(progress?.pendingThreadCount) || 0));
    if (stage === "export") {
      if (!totalCount) return i18n.t("syncSidebar.headingStatus.processing");
      const processedCount = Math.max(0, Math.floor(Number(progress?.preparedThreadCount ?? progress?.processedThreadCount) || 0));
      return i18n.t("syncSidebar.headingStatus.processingProgress", {
        currentCount: Math.min(processedCount + 1, totalCount),
        totalCount,
      });
    }
    if (stage !== "upload" && stage !== "done") return "";
    if (!totalCount) return i18n.t("syncSidebar.headingStatus.uploading");
    const uploadedCount = Math.max(0, Math.floor(Number(progress?.uploadedCount) || 0));
    const speed = formatArchiveTransferRate(progress?.uploadBytesPerSecond);
    const speedText = speed ? i18n.t("syncSidebar.headingStatus.uploadSpeed", { speed }) : "";
    return i18n.t("syncSidebar.headingStatus.uploadingProgress", {
      speedText,
      totalCount,
      uploadedCount,
    });
  }

  function getArchivePerformanceNowMs() {
    // 这一段优先使用单调时钟，浏览器不支持时再回落到当前时间。
    // Prefer a monotonic clock and fall back to wall-clock time when unavailable.
    return typeof window.performance?.now === "function" ? window.performance.now() : Date.now();
  }

  function normalizeArchiveTimingMs(value) {
    // 这一段把桥接层返回的耗时收敛为非负整数，避免控制台输出 NaN。
    // Normalize bridge timing values into non-negative integers so console output never shows NaN.
    const numericValue = Number(value);
    return Number.isFinite(numericValue) && numericValue >= 0 ? Math.round(numericValue) : 0;
  }

  function normalizeArchiveByteCount(value) {
    // 这一段把包大小和 Markdown 大小收敛为非负整数。
    // Normalize package and Markdown sizes into non-negative integers.
    const numericValue = Number(value);
    return Number.isFinite(numericValue) && numericValue >= 0 ? Math.floor(numericValue) : 0;
  }

  function logArchiveOpenPerformance(data, pageTimings) {
    // 这一段只打印阶段耗时和大小，不打印同步密钥、正文、本机路径或标题。
    // Log only timings and sizes, never sync keys, body text, local paths, or titles.
    const nativePerformance = data && typeof data === "object" ? data.performance : null;
    if (!nativePerformance || typeof window.console?.info !== "function") return;
    window.console.info("[Codex-Pro] conversation archive open performance", {
      downloadedPackageBytes: normalizeArchiveByteCount(nativePerformance.downloadedPackageBytes),
      getBundleMs: normalizeArchiveTimingMs(nativePerformance.getBundleMs),
      keyDerivationMs: normalizeArchiveTimingMs(nativePerformance.keyDerivationMs),
      markdownBytes: normalizeArchiveByteCount(nativePerformance.markdownBytes),
      openSidePanelMs: normalizeArchiveTimingMs(pageTimings?.openSidePanelMs),
      packageBytes: normalizeArchiveByteCount(nativePerformance.packageBytes),
      packageDownloadMs: normalizeArchiveTimingMs(nativePerformance.packageDownloadMs),
      packageResolveMs: normalizeArchiveTimingMs(nativePerformance.packageResolveMs),
      packageTransport: String(nativePerformance.packageTransport || ""),
      relatedFileCount: normalizeArchiveByteCount(nativePerformance.relatedFileCount),
      totalNativeMs: normalizeArchiveTimingMs(nativePerformance.totalNativeMs),
      totalPageMs: normalizeArchiveTimingMs(pageTimings?.totalPageMs),
      unpackPackageMs: normalizeArchiveTimingMs(nativePerformance.unpackPackageMs),
      writePreviewMs: normalizeArchiveTimingMs(nativePerformance.writePreviewMs),
    });
  }

  function normalizeWorkspaceFileModulePath(candidate, baseUrl = location.href) {
    // 这一段只接受官方 open-workspace-file chunk 文件名，避免动态 import 任意脚本。
    // Accept only the official open-workspace-file chunk filename before dynamic import.
    const match = String(candidate || "").match(workspaceFileModulePattern);
    if (!match) return "";
    const modulePath = match[0].startsWith("assets/") ? `/${match[0]}` : `/assets/${match[0].split("/").pop()}`;
    try {
      return new URL(modulePath, baseUrl).href;
    } catch {
      return `.${modulePath}`;
    }
  }

  async function discoverWorkspaceFileModulePath() {
    // 这一段从 Codex 已加载脚本里扫描真实 chunk 名称，兼容官方更新后的 hash 变化。
    // Scan loaded Codex scripts for the real chunk name so official hash changes do not break file opening.
    const scriptUrls = Array.from(document.scripts)
      .map((script) => script.src)
      .filter((src) => src && src.startsWith("app://-/assets/"))
      .slice(0, 12);
    for (const scriptUrl of scriptUrls) {
      try {
        const response = await fetch(scriptUrl);
        if (!response.ok) continue;
        const modulePath = normalizeWorkspaceFileModulePath(await response.text(), scriptUrl);
        if (modulePath) return modulePath;
      } catch {
        // 这一段忽略不可读的 app asset，继续尝试固定兜底文件名。
        // Ignore unreadable app assets and continue with pinned fallback filenames.
      }
    }
    for (const fallbackPath of workspaceFileModuleFallbackPaths) {
      const modulePath = normalizeWorkspaceFileModulePath(fallbackPath, location.href);
      if (modulePath) return modulePath;
    }
    return "";
  }

  async function getWorkspaceFileModule() {
    // 这一段缓存官方文件打开模块，避免每次点击会话都重新扫描 Codex 资源。
    // Cache the official file-opening module so each thread click does not rescan Codex assets.
    if (!workspaceFileModulePathPromise) {
      workspaceFileModulePathPromise = discoverWorkspaceFileModulePath().catch((error) => {
        workspaceFileModulePathPromise = null;
        throw error;
      });
    }
    if (!workspaceFileModulePromise) {
      workspaceFileModulePromise = workspaceFileModulePathPromise.then((modulePath) => {
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

  function findWorkspaceRouteScope() {
    // 这一段复用现有 route-scope 工具，优先从文件树找，首页态再从 React 页面宿主找。
    // Reuse the existing route-scope utility, preferring file-tree hosts and falling back to page React hosts.
    const navigation = runtime.systemModules.diffHoverPreviewNavigation;
    const primaryHosts = Array.from(document.querySelectorAll("file-tree-container"));
    const fallbackHosts = [
      document.getElementById("root"),
      document.body,
      ...document.querySelectorAll("main, aside, nav, [role=\"main\"]"),
    ].filter(Boolean);
    const routeScopeHosts = [...primaryHosts, ...fallbackHosts];
    if (navigation?.findWorkspaceRouteScope) {
      for (const host of routeScopeHosts) {
        const scope = navigation.findWorkspaceRouteScope(host, {}, {
          getFallbackHosts: () => primaryHosts.length > 0 ? primaryHosts : fallbackHosts,
          getReactFiber,
          maxFiberDepth: routeScopeFiberDepth,
        });
        if (scope) return scope;
      }
    }
    for (const host of routeScopeHosts) {
      const scope = findConversationArchiveRouteScopeFromHost(host);
      if (scope) return scope;
    }
    return null;
  }

  function normalizeConversationArchiveLocalPath(value) {
    // 这一段清理 Codex tabId、file-reference 链接或 bridge 返回的本机路径，兼容 file:local/file URI 和编码空格。
    // Clean local paths from Codex tabIds, file-reference links, or bridge results, including file:local/file URIs and encoded spaces.
    const decodedPath = decodeConversationArchivePromptLink(value);
    return normalizePath(decodedPath)
      .replace(/^file:local:/iu, "")
      .replace(/^file:\/\/\/?/iu, "")
      .replace(/^\/([A-Za-z]:\/)/u, "$1");
  }

  function getConversationArchivePathDirectory(localPath) {
    // 这一段从本机路径取目录，用作官方文件预览入口的 cwd。
    // Extract the local directory so it can be used as cwd for Codex's official file preview opener.
    const normalizedPath = normalizeConversationArchiveLocalPath(localPath);
    const slashIndex = normalizedPath.lastIndexOf("/");
    return slashIndex > 0 ? normalizedPath.slice(0, slashIndex) : "";
  }

  function getConversationArchivePathFileName(localPath) {
    // 这一段从本机路径取文件名，用作官方文件预览入口的相对 path。
    // Extract the local file name so it can be used as the relative path for Codex's official file preview opener.
    const normalizedPath = normalizeConversationArchiveLocalPath(localPath);
    const slashIndex = normalizedPath.lastIndexOf("/");
    return slashIndex >= 0 ? normalizedPath.slice(slashIndex + 1) : normalizedPath;
  }

  function getConversationArchivePreviewOpenTarget(localPath) {
    // 这一段把 Codex-Pro 数据目录里的预览文件转换为 cwd + 文件名，避免依赖项目根目录。
    // Convert a preview file under the Codex-Pro data directory into cwd plus file name without relying on project roots.
    const normalizedPath = normalizeConversationArchiveLocalPath(localPath);
    const cwd = getConversationArchivePathDirectory(normalizedPath);
    const fileName = getConversationArchivePathFileName(normalizedPath);
    if (!cwd || !fileName) return { cwd: "", workspacePath: normalizedPath };
    return { cwd, workspacePath: fileName };
  }

  function isConversationArchiveRouteScope(value) {
    // 这一段识别 Codex route scope；新对话和首页态也可用来唤醒右侧预览。
    // Identify a Codex route scope; new-thread and home states can also wake the right preview.
    if (!value || typeof value !== "object") return false;
    if (typeof value.get !== "function" || typeof value.set !== "function") return false;
    if (!value.node || !value.chain) return false;
    try {
      if (!value.queryClient) return false;
    } catch {
      return false;
    }
    const routeKind = String(value.value?.routeKind || "");
    return ["home", "local-thread", "new-thread-panel", "other", "remote-thread"].includes(routeKind);
  }

  function scanConversationArchiveRouteScope(value, seenObjects, depth = 0) {
    // 这一段有界扫描 React 内部对象，补足 diff-hover 工具在首页态偶发拿不到 scope 的情况。
    // Bounded-scan React internals to cover project-home cases where the diff-hover helper may miss the scope.
    if (!value || (typeof value !== "object" && typeof value !== "function")) return null;
    if (depth > routeScopeObjectDepth) return null;
    if (typeof value === "object") {
      if (seenObjects.has(value)) return null;
      seenObjects.add(value);
    }
    if (isConversationArchiveRouteScope(value)) return value;
    if (typeof value !== "object") return null;
    if (value instanceof Map && depth < 4) {
      let entryCount = 0;
      for (const [key, child] of value) {
        const keyScope = scanConversationArchiveRouteScope(key, seenObjects, depth + 1);
        if (keyScope) return keyScope;
        const childScope = scanConversationArchiveRouteScope(child, seenObjects, depth + 1);
        if (childScope) return childScope;
        entryCount += 1;
        if (entryCount >= routeScopeObjectKeys) break;
      }
    }
    for (const key of Object.keys(value).slice(0, routeScopeObjectKeys)) {
      let child = null;
      try {
        child = value[key];
      } catch {
        continue;
      }
      const childScope = scanConversationArchiveRouteScope(child, seenObjects, depth + 1);
      if (childScope) return childScope;
    }
    return null;
  }

  function findConversationArchiveRouteScopeFromHost(host) {
    // 这一段沿 DOM host 对应的 fiber 向上找 route scope，不依赖文件树是否已经挂载。
    // Walk upward from a DOM host's fiber to find route scope without requiring a mounted file tree.
    let fiber = null;
    try {
      fiber = getReactFiber(host);
    } catch {
      fiber = null;
    }
    for (let depth = 0; fiber && depth < routeScopeFiberDepth; depth += 1) {
      const seenObjects = new WeakSet();
      const scope =
        scanConversationArchiveRouteScope(fiber.memoizedState, seenObjects) ||
        scanConversationArchiveRouteScope(fiber.updateQueue, seenObjects) ||
        scanConversationArchiveRouteScope(fiber.dependencies, seenObjects) ||
        scanConversationArchiveRouteScope(fiber.memoizedProps, seenObjects);
      if (scope) return scope;
      fiber = fiber.return;
    }
    return null;
  }

  function isConversationArchivePreviewTabPanel(panel) {
    // 这一段只识别同步归档生成的右侧预览 tab，不影响普通工作区文件。
    // Identify only right-side preview tabs generated by synced archives, leaving normal files unchanged.
    if (!(panel instanceof HTMLElement)) return false;
    const tabId = normalizePath(panel.getAttribute("data-tab-id") || "");
    return panel.getAttribute("role") === "tabpanel" &&
      panel.getAttribute("data-app-shell-tab-panel-controller") === "right" &&
      tabId.startsWith("file:local:") &&
      tabId.includes(conversationArchivePreviewPathSegment);
  }

  function decodeConversationArchivePromptLink(value) {
    // 这一段宽容解码 Codex prompt link 属性，解码失败时保留原值继续做严格路径匹配。
    // Decode Codex prompt-link attributes permissively, keeping the raw value if decoding fails before strict path checks.
    const text = String(value || "").trim();
    try {
      return decodeURIComponent(text);
    } catch {
      return text;
    }
  }

  function getConversationArchivePreviewDirectory(panel) {
    // 这一段从归档预览 tabId 反推出当前预览目录，避免用当前路由或文案猜测路径。
    // Derive the current preview directory from the archive preview tabId instead of guessing from route state or labels.
    if (!isConversationArchivePreviewTabPanel(panel)) return "";
    const tabId = normalizePath(panel.getAttribute("data-tab-id") || "");
    const localPath = normalizeConversationArchiveLocalPath(tabId.replace(/^file:local:/u, ""));
    const markerIndex = localPath.toLowerCase().indexOf(conversationArchivePreviewPathSegment.toLowerCase());
    if (markerIndex <= 0) return "";
    return getConversationArchivePathDirectory(localPath);
  }

  function isConversationArchiveThinkingPreviewPath(value) {
    // 这一段只允许会话归档 thinking 附件，避免接管普通 Markdown、HTML 或外部链接。
    // Allow only conversation-archive thinking attachments so normal Markdown, HTML, and external links stay native.
    const normalizedPath = normalizeConversationArchiveLocalPath(value);
    const previewIndex = normalizedPath.toLowerCase().indexOf(conversationArchivePreviewPathSegment.toLowerCase());
    if (previewIndex < 0) return false;
    const previewRelativePath = normalizedPath.slice(previewIndex + conversationArchivePreviewPathSegment.length);
    const parts = previewRelativePath.split("/");
    if (parts.length !== 2) return false;
    const [directoryName, fileName] = parts;
    if (!directoryName || directoryName === "." || directoryName === "..") return false;
    return /^thinking-\d{3,6}-[a-f0-9]{12}\.md$/iu.test(fileName);
  }

  function resolveConversationArchiveThinkingLinkPath(linkTarget, panel) {
    // 这一段把 Codex file-reference 的 prompt link 转成本机路径，只接受当前预览目录内的 thinking 附件。
    // Convert a Codex file-reference prompt link into a local path, accepting only thinking attachments in the current preview directory.
    const previewDirectory = getConversationArchivePreviewDirectory(panel);
    if (!previewDirectory) return "";
    const normalizedTarget = normalizeConversationArchiveLocalPath(decodeConversationArchivePromptLink(linkTarget));
    if (/^thinking-\d{3,6}-[a-f0-9]{12}\.md$/iu.test(normalizedTarget)) return `${previewDirectory}/${normalizedTarget}`;
    if (!isConversationArchiveThinkingPreviewPath(normalizedTarget)) return "";
    const normalizedPreviewDirectory = `${normalizePath(previewDirectory)}/`;
    if (normalizedTarget.toLowerCase().startsWith(normalizedPreviewDirectory.toLowerCase())) return normalizedTarget;
    return "";
  }

  function getConversationArchiveThinkingLinkFromEvent(event) {
    // 这一段从事件目标向上找 Codex file-reference，只接管归档预览里的 thinking 附件按钮。
    // Walk up from the event target to find only archive-preview thinking attachment file-reference buttons.
    const target = event?.target instanceof Element ? event.target : null;
    const link = target?.closest?.('[data-file-reference="true"][data-prompt-link-href]');
    if (!(link instanceof HTMLElement)) return null;
    const panel = link.closest("[role='tabpanel'][data-app-shell-tab-panel-controller='right']");
    if (!isConversationArchivePreviewTabPanel(panel)) return null;
    const localPath = resolveConversationArchiveThinkingLinkPath(link.getAttribute("data-prompt-link-href"), panel);
    return localPath ? { link, localPath } : null;
  }

  function stopConversationArchiveThinkingLinkEvent(event) {
    // 这一段阻止 Codex 原生 file-reference 回落到外部打开，后续改用右侧 Preview 打开。
    // Stop Codex's native file-reference fallback from opening externally before using the right-side Preview opener.
    event.preventDefault();
    event.stopPropagation();
    event.stopImmediatePropagation?.();
  }

  function restoreConversationArchivePreviewFileTrees() {
    // 这一段恢复不再属于同步归档预览的文件树列，避免影响之后普通文件预览。
    // Restore file-tree columns that no longer belong to archive previews so later normal file previews are unaffected.
    for (const column of document.querySelectorAll(`[${previewFileTreeHiddenAttribute}]`)) {
      column.style.removeProperty("display");
      if (isConversationArchivePreviewTabPanel(column.closest("[role='tabpanel']"))) continue;
      column.removeAttribute(previewFileTreeHiddenAttribute);
    }
  }

  function findConversationArchivePreviewFileTreeColumn(tree, panel) {
    // 这一段从 file-tree-container 向上找右侧窄列，让隐藏后预览内容自动吃满剩余宽度。
    // Walk upward from file-tree-container to the narrow right column so the preview content can reclaim the width.
    const panelRect = panel.getBoundingClientRect();
    let column = tree;
    let candidate = tree;
    for (let depth = 0; column?.parentElement && column !== panel && depth < 8; depth += 1) {
      const parent = column.parentElement;
      const columnRect = column.getBoundingClientRect();
      const parentRect = parent.getBoundingClientRect();
      const parentStyle = window.getComputedStyle(parent);
      const isRightNarrowColumn =
        parentStyle.display.includes("flex") &&
        columnRect.width > 0 &&
        columnRect.width <= Math.min(420, parentRect.width * 0.45) &&
        columnRect.height >= panelRect.height * 0.65 &&
        Math.abs(columnRect.right - parentRect.right) <= 4;
      if (isRightNarrowColumn) candidate = column;
      column = parent;
    }
    return candidate;
  }

  function hideConversationArchivePreviewFileTree() {
    // 这一段隐藏同步归档预览里的文件树列，不点击官方按钮、不改变普通文件 tab。
    // Hide the file-tree column inside archive previews without clicking native buttons or changing normal file tabs.
    restoreConversationArchivePreviewFileTrees();
    for (const panel of document.querySelectorAll("[role='tabpanel'][data-app-shell-tab-panel-controller='right']")) {
      if (!isConversationArchivePreviewTabPanel(panel)) continue;
      for (const tree of panel.querySelectorAll("file-tree-container")) {
        const column = findConversationArchivePreviewFileTreeColumn(tree, panel);
        column.setAttribute(previewFileTreeHiddenAttribute, "true");
        column.style.removeProperty("display");
      }
    }
  }

  function scheduleConversationArchivePreviewFileTreeHide() {
    // 这一段用有界重试覆盖官方 Preview 异步挂载，避免留下常驻 observer 或定时器。
    // Use bounded retries for the async native Preview mount without leaving a persistent observer or timer.
    for (const delayMs of [0, 80, 220, 520, 900]) {
      window.setTimeout(hideConversationArchivePreviewFileTree, delayMs);
    }
  }

  async function openLocalMarkdownInSidePanel(localPath) {
    // 这一段只调用 Codex 官方右侧 Preview 入口，避免普通标签或外部编辑器兜底。
    // Use only Codex's official right-side Preview opener, avoiding normal tabs or external-editor fallbacks.
    const scope = findWorkspaceRouteScope();
    const { cwd, workspacePath } = getConversationArchivePreviewOpenTarget(localPath);
    if (!scope) {
      console.warn("[Codex-Pro] route scope unavailable for conversation archive preview");
      return false;
    }

    try {
      const module = await getWorkspaceFileModule();
      const openWorkspaceFile = getWorkspaceFileOpener(module);
      if (openWorkspaceFile) {
        let usedOpenFileFallback = false;
        openWorkspaceFile({
          scope,
          ...(cwd ? { cwd } : {}),
          hostId: "local",
          isPreview: true,
          openFile: (params) => {
            usedOpenFileFallback = true;
            console.warn("[Codex-Pro] blocked open-file fallback for conversation archive preview", params);
          },
          openInSidePanel: true,
          path: workspacePath,
        });
        if (!usedOpenFileFallback) scheduleConversationArchivePreviewFileTreeHide();
        return !usedOpenFileFallback;
      }
    } catch (error) {
      console.warn("[Codex-Pro] official Preview opener failed for conversation archive", error?.message || error);
    }
    return false;
  }

  async function openConversationArchiveThinkingLink(localPath) {
    // 这一段复用主归档 Markdown 的官方右侧 Preview 入口，让“已处理”附件留在 Codex 内部打开。
    // Reuse the main archive Markdown right-side Preview opener so thinking attachments stay inside Codex.
    const opened = await openLocalMarkdownInSidePanel(localPath);
    if (!opened) console.warn("[Codex-Pro] failed to open conversation archive thinking preview", localPath);
  }

  runtime.registerSystem("conversation-archive-sidebar", () => {
    const settingsApi = runtime.systemModules.settingsMenu?.settings;
    const conversationArchive = runtime.systemModules.conversationArchive;
    if (!settingsApi?.getSettings || !settingsApi?.subscribe || !conversationArchive?.listArchive) return;

    // 这一段建立同步侧栏生命周期；关闭功能时会清理 DOM、监听器和请求状态。
    // Create the sync-sidebar lifecycle; disabling the feature cleans up DOM, listeners, and request state.
    const controller = new AbortController();
    runtime.lifecycle.replaceController("conversation-archive-sidebar", controller);
    installStyle();
    restoreConversationArchivePreviewFileTrees();

    const initialSettings = settingsApi.getSettings();
    const state = {
      activeArchivePointerDrag: null,
      activeArchiveThreadDrag: null,
      activeThreadPanelWorkCount: 0,
      activeThreadPath: "",
      devicePanelCloseTimer: 0,
      dragAbortController: null,
      hoverGroupKey: "",
      isNativeArchiveThreadDragActive: false,
      isDeletingDevice: false,
      isDevicePinned: initialSettings.conversationArchiveSidebarDirectoryPanelMode !== "hover",
      isGroupPinned: initialSettings.conversationArchiveSidebarPanelMode !== "hover",
      isPanelOpen: false,
      isPanelPointerInside: false,
      isProfileMenuOpen: false,
      isProfileMenuPointerInside: false,
      isManualSyncActive: false,
      isRefreshing: false,
      isSavingArchiveMetadata: false,
      isStartupAutoSyncing: false,
      isThreadPanelPointerInside: false,
      lastError: "",
      lastPointerClientX: null,
      lastPointerClientY: null,
      latestSettings: initialSettings,
      deviceDeletePending: false,
      localDeviceDeletePending: false,
      localDeviceUploadBlockedAfterDelete: false,
      locallyHiddenDeviceIds: new Map(),
      panelDeviceId: "",
      panelGroupKey: "",
      panelPosition: null,
      panelProfileId: "",
      pendingAutoArchiveSnapshot: null,
      pendingDeleteRefreshTimer: 0,
      refreshTimer: 0,
      snapshot: null,
      startupAutoSyncTimer: 0,
      statusMessage: "",
      statusKind: "",
      statusSource: "",
      statusProgress: null,
      statusTone: "",
      statusTimer: 0,
      threadPanelCloseTimer: 0,
      threadListScrollByGroupKey: new Map(),
      uploadProgressFloor: null,
    };

    function readSyncConfig() {
      // 这一段从现有设置读取同步地址和密钥，避免在同步侧栏重复保存敏感配置。
      // Read endpoint and sync key from existing settings so the sidebar does not duplicate sensitive config.
      const settings = state.latestSettings || settingsApi.getSettings();
      return {
        deviceName: settings.conversationArchiveDeviceName,
        endpoint: settings.conversationArchiveEndpoint,
        profileName: settings.conversationArchiveProfileName,
        syncKey: settings.cloudSyncKey,
      };
    }

    function getSyncLicenseGate(config = readSyncConfig()) {
      // 这一段复用设置页维护的共享同步密钥状态，侧栏不单独判断授权。
      // Reuse the shared sync-key state maintained by settings; the sidebar does not judge authorization separately.
      return runtime.systemModules.settingsMenu?.cloudSync?.getSyncLicenseGate?.(config.syncKey) || {
        canSync: false,
        message: config.syncKey ? i18n.t("sync.licenseStatus.pending") : i18n.t("syncSidebar.empty.configureKey"),
        status: config.syncKey ? "unknown" : "missing",
        tone: config.syncKey ? "" : "error",
      };
    }

    function getSyncUnavailableMessage(config = readSyncConfig()) {
      // 这一段给禁用态按钮和空列表提供同一条提示。
      // Provide one message for disabled buttons and empty states.
      if (!config.endpoint || !config.syncKey) return i18n.t("syncSidebar.empty.configureKey");
      const gate = getSyncLicenseGate(config);
      return gate.canSync ? "" : gate.message;
    }

    function normalizeManualUploadProgress(progress) {
      // 这一段让同一次手动上传的已上传计数只前进不后退，抵消分包阶段切换的旧进度事件。
      // Keep uploaded counts monotonic within one manual upload, absorbing stale progress events from batch transitions.
      if (!progress || typeof progress !== "object") return progress;
      const stage = String(progress.stage || "").trim();
      if (stage !== "export" && stage !== "upload" && stage !== "done" && stage !== "failed") {
        return progress;
      }
      const totalCount = Math.max(0, Math.floor(Number(progress.pendingThreadCount) || 0));
      const uploadedCount = Math.max(0, Math.floor(Number(progress.uploadedCount) || 0));
      const floor = state.uploadProgressFloor;
      if (!floor || floor.totalCount !== totalCount) {
        state.uploadProgressFloor = { totalCount, uploadedCount };
        return progress;
      }
      const nextUploadedCount = Math.max(uploadedCount, floor.uploadedCount);
      state.uploadProgressFloor = { totalCount, uploadedCount: nextUploadedCount };
      if (nextUploadedCount === uploadedCount) return progress;
      return {
        ...progress,
        uploadedCount: nextUploadedCount,
      };
    }

    function getConversationArchiveSavedMetadata(data, fallbackSettings) {
      // 这一段从上传或刷新响应里提取归档同步元数据，缺项时保留现有设置。
      // Extract archive sync metadata from upload or refresh responses, preserving existing settings when fields are missing.
      const revision = Number(data?.revision);
      return {
        conversationArchiveLastSyncAt: data?.updatedAt || new Date().toISOString(),
        conversationArchiveRevision: Number.isFinite(revision) && revision >= 0
          ? Math.floor(revision)
          : fallbackSettings.conversationArchiveRevision,
      };
    }

    function saveConversationArchiveMetadata(data) {
      // 这一段用实时完整设置写回归档 revision，避免旧快照覆盖外部 Diff 等其它本机设置。
      // Save archive revisions with live full settings so stale snapshots cannot overwrite unrelated local settings such as external Diff.
      if (!settingsApi?.saveSettings || !data || typeof data !== "object") return;
      const currentSettings = settingsApi.getSettings();
      state.isSavingArchiveMetadata = true;
      try {
        const nextSettings = settingsApi.saveSettings({
          ...currentSettings,
          ...getConversationArchiveSavedMetadata(data, currentSettings),
        });
        state.latestSettings = nextSettings;
      } finally {
        state.isSavingArchiveMetadata = false;
      }
    }

    function hasSyncConfig() {
      // 这一段只判断是否具备拉取远端索引的必要配置，不触发任何上传。
      // Check only whether remote index reads are configured; this never triggers uploads.
      const config = readSyncConfig();
      return Boolean(config.endpoint && config.syncKey && getSyncLicenseGate(config).canSync);
    }

    function isDeviceDeleteLocked() {
      // 这一段把“正在删除”和“删除待确认”都视为同步锁，避免按钮和自动状态抢跑。
      // Treat active delete and pending confirmation as one sync lock so buttons and auto statuses cannot race ahead.
      return state.isDeletingDevice || state.deviceDeletePending;
    }

    function isArchiveSidebarBusy() {
      // 这一段统一侧栏自己的刷新/启动上传忙碌态，避免按钮和空态各自判断。
      // Keep sidebar refresh/startup-upload busy checks in one place so buttons and empty states stay consistent.
      return state.isRefreshing || state.isStartupAutoSyncing;
    }

    function schedulePendingDeleteRefresh() {
      // 这一段在删除待确认时短轮询列表，只做删除重试和刷新，不触发本机会话上传。
      // Short-poll the list while delete confirmation is pending; this retries deletion without uploading local sessions.
      window.clearTimeout(state.pendingDeleteRefreshTimer);
      state.pendingDeleteRefreshTimer = 0;
      if (!state.deviceDeletePending || !hasSyncConfig()) return;
      state.pendingDeleteRefreshTimer = window.setTimeout(() => {
        state.pendingDeleteRefreshTimer = 0;
        if (state.deviceDeletePending && !state.isRefreshing && !state.isDeletingDevice) {
          void refreshArchive({ force: true });
        }
      }, pendingDeleteRefreshDelayMs);
    }

    function syncLocalDeviceDeleteState(data) {
      // 这一段把 native 返回的设备删除状态同步到侧栏状态机，避免状态文字和按钮各走各的。
      // Mirror native device-delete state into the sidebar state machine so text and buttons stay consistent.
      if (!data || typeof data !== "object") return;
      const wasPending = state.deviceDeletePending;
      if ("deviceDeletePending" in data || data.deletePending) {
        state.deviceDeletePending = Boolean(data.deviceDeletePending || data.deletePending);
      }
      if ("localDeviceDeletePending" in data || data.deletePending) {
        state.localDeviceDeletePending = Boolean(data.localDeviceDeletePending || data.deletePending);
      }
      if ("localDeviceUploadBlockedAfterDelete" in data) {
        state.localDeviceUploadBlockedAfterDelete = Boolean(data.localDeviceUploadBlockedAfterDelete);
      }
      if (state.deviceDeletePending) {
        setStatus(i18n.t("syncSidebar.deleteDevice.status.pending"), "", "syncing", 0);
        schedulePendingDeleteRefresh();
      } else {
        window.clearTimeout(state.pendingDeleteRefreshTimer);
        state.pendingDeleteRefreshTimer = 0;
        if (wasPending && state.statusKind === "syncing") setStatus();
      }
    }

    function getArchiveRevision(value) {
      // 这一段把归档 revision 收敛为可比较数字，用于判断弹窗缓存是否已经落后。
      // Normalize archive revisions into comparable numbers so popup cache staleness can be detected.
      const revision = Math.floor(Number(value) || 0);
      return Number.isFinite(revision) && revision > 0 ? revision : 0;
    }

    function isArchiveSnapshotCurrent() {
      // 这一段比较远端快照 revision 和设置里最近一次同步 revision，避免显示清理重建前的旧分组。
      // Compare remote snapshot revision with the latest saved sync revision so rebuilt archives do not show stale groups.
      const expectedRevision = getArchiveRevision(state.latestSettings?.conversationArchiveRevision);
      const snapshotRevision = getArchiveRevision(state.snapshot?.revision);
      return !expectedRevision || snapshotRevision >= expectedRevision;
    }

    function filterLocallyHiddenArchiveSnapshot(snapshot) {
      // 这一段过滤本次运行里刚删除的设备，避免旧的自动同步响应晚到后把设备重新画回来。
      // Filter devices deleted during this runtime so late auto-sync responses cannot re-render them.
      if (!snapshot || typeof snapshot !== "object" || !Array.isArray(snapshot.devices) || state.locallyHiddenDeviceIds.size === 0) return snapshot;
      const snapshotRevision = getArchiveRevision(snapshot.revision);
      const devices = snapshot.devices.filter((device) => {
        const hiddenUntilRevision = state.locallyHiddenDeviceIds.get(device?.deviceId);
        if (hiddenUntilRevision === undefined) return true;
        if (!Number.isFinite(hiddenUntilRevision)) return false;
        return snapshotRevision > hiddenUntilRevision;
      });
      if (devices.length === snapshot.devices.length) return snapshot;
      return { ...snapshot, devices };
    }

    function rememberLocallyHiddenDevice(deviceId, visibleAfterRevision = Number.POSITIVE_INFINITY) {
      // 这一段记录本次运行内需要隐藏的设备；远端确认后只屏蔽旧 revision，允许后续新同步重新出现。
      // Track devices hidden during this runtime; after remote confirmation, block only old revisions so later syncs can reappear.
      const normalizedDeviceId = String(deviceId || "");
      if (!normalizedDeviceId) return false;
      const revision = getArchiveRevision(visibleAfterRevision) || Number.POSITIVE_INFINITY;
      const previousRevision = state.locallyHiddenDeviceIds.get(normalizedDeviceId);
      if (revision === Number.POSITIVE_INFINITY || previousRevision === undefined || previousRevision === Number.POSITIVE_INFINITY || revision > previousRevision) {
        state.locallyHiddenDeviceIds.set(normalizedDeviceId, revision);
      }
      return true;
    }

    function revealLocallyHiddenDeviceFromSnapshot(snapshot, deviceId) {
      // 这一段在新上传响应已经包含本机设备时解除运行态隐藏，避免删除后重传成功仍显示空列表。
      // Clear runtime hiding when a fresh upload snapshot contains the local device so re-sync after deletion can render it again.
      const normalizedDeviceId = String(deviceId || "");
      const devices = Array.isArray(snapshot?.devices) ? snapshot.devices : [];
      if (!normalizedDeviceId || !state.locallyHiddenDeviceIds.has(normalizedDeviceId)) return false;
      if (!devices.some((device) => device?.deviceId === normalizedDeviceId)) return false;
      state.locallyHiddenDeviceIds.delete(normalizedDeviceId);
      return true;
    }

    function revealUploadedLocalDeviceFromSnapshot(snapshot) {
      // 这一段只信任完成上传后的本机设备快照，不让删除待确认或上传阻止的列表请求重新露出旧设备。
      // Trust only completed upload snapshots for the local device, without revealing stale entries during pending delete or upload blocking.
      const deviceId = String(snapshot?.identity?.deviceId || "");
      if (!deviceId ||
        snapshot?.deviceDeletePending ||
        snapshot?.localDeviceDeletePending ||
        snapshot?.localDeviceUploadBlockedAfterDelete ||
        snapshot?.localDeviceUploadSkippedForPendingDelete) {
        return false;
      }
      return revealLocallyHiddenDeviceFromSnapshot(snapshot, deviceId);
    }

    function getConversationArchiveSidebarPanelMode() {
      // 这一段读取右侧会话列表显示方式；未知值回落点击固定，避免旧配置造成悬空面板。
      // Read the thread-list display mode; unknown values fall back to click-pinned mode so stale settings cannot detach the panel.
      return state.latestSettings?.conversationArchiveSidebarPanelMode === "hover" ? "hover" : "click";
    }

    function isHoverThreadPanelMode() {
      // 这一段把模式判断收敛成布尔值，后续 hover 计时器和渲染逻辑共用。
      // Collapse the mode check into one boolean shared by hover timers and rendering.
      return getConversationArchiveSidebarPanelMode() === "hover";
    }

    function getConversationArchiveSidebarDirectoryPanelMode() {
      // 这一段读取左侧目录面板显示方式；未知值回落点击固定，保持升级前的交互。
      // Read the left directory-panel display mode; unknown values fall back to click-pinned mode to keep pre-upgrade behavior.
      return state.latestSettings?.conversationArchiveSidebarDirectoryPanelMode === "hover" ? "hover" : "click";
    }

    function isHoverDirectoryPanelMode() {
      // 这一段把左侧目录模式判断收敛成布尔值，设备 hover 和关闭计时器共用。
      // Collapse the left directory mode check into one boolean shared by device hover and close timers.
      return getConversationArchiveSidebarDirectoryPanelMode() === "hover";
    }

    function getActivePanelGroupKey() {
      // 这一段决定右侧会话列表当前显示哪个目录：固定目录优先，未固定时才跟随悬停预览。
      // Decide which directory the right thread panel shows: pinned selection wins, hover preview is used only when unpinned.
      if (isHoverThreadPanelMode()) {
        if (state.isGroupPinned) return state.panelGroupKey;
        return state.hoverGroupKey || "";
      }
      return state.panelGroupKey;
    }

    function getSelectedGroupScrollKey(groupKey = state.panelGroupKey) {
      // 这一段把设备、账号和目录组合成滚动记忆 key，避免不同目录共用列表位置。
      // Combine device, profile, and group into one scroll-memory key so lists do not share positions.
      return [state.panelDeviceId || "", state.panelProfileId || "", groupKey || ""].join("/");
    }

    function readThreadListScrollSnapshot(panel = document.getElementById(threadPanelId)) {
      // 这一段读取当前弹窗列表的滚动锚点；隐藏旧弹窗不参与，避免跨配置写入陈旧位置。
      // Read the current popup list scroll anchor; ignore hidden stale popups so old config state is not reused.
      if (!(panel instanceof HTMLElement) || panel.hidden) return null;

      // 这一段优先用右侧面板绑定的目录 key，避免关闭过程中 active 状态变化导致写错目录。
      // Prefer the group key bound on the thread panel so close-time active state changes do not save under the wrong group.
      const scrollKey = panel.dataset.codexProSyncGroupKey || getSelectedGroupScrollKey();
      const list = panel.querySelector(".codex-pro-sync-thread-list");
      if (!scrollKey || !(list instanceof HTMLElement)) return null;

      // 这一段把列表顶部附近的会话 path 作为锚点；列表内容变更时优先按同一会话恢复位置。
      // Use the thread path near the top of the list as the anchor so content changes restore around the same thread first.
      const listRect = list.getBoundingClientRect();
      let anchorPath = "";
      let anchorOffset = 0;
      for (const button of list.querySelectorAll(".codex-pro-sync-thread-button")) {
        const buttonRect = button.getBoundingClientRect();
        if (buttonRect.bottom < listRect.top) continue;
        anchorPath = button instanceof HTMLElement ? button.dataset.codexProSyncThreadPath || "" : "";
        anchorOffset = buttonRect.top - listRect.top;
        break;
      }
      return {
        scrollKey,
        value: {
          anchorOffset,
          anchorPath,
          scrollTop: list.scrollTop,
        },
      };
    }

    function rememberThreadListScroll(panel = document.getElementById(threadPanelId)) {
      // 这一段只在本次运行内按目录记住会话列表位置，关闭再打开时能回到用户刚才浏览的区域。
      // Remember each directory's thread-list position only for this runtime so reopening returns to the area the user was browsing.
      const snapshot = readThreadListScrollSnapshot(panel);
      if (!snapshot) return;
      state.threadListScrollByGroupKey.set(snapshot.scrollKey, snapshot.value);
    }

    function restoreThreadListScroll(list, snapshot) {
      // 这一段优先按会话 path 锚点恢复，锚点失效时才回退到保存的像素位置。
      // Restore by thread-path anchor first, falling back to the saved pixel offset only when the anchor is gone.
      if (!(list instanceof HTMLElement) || !snapshot || typeof snapshot !== "object") return;
      const anchorPath = snapshot.anchorPath || "";
      const anchor = anchorPath
        ? Array.from(list.querySelectorAll(".codex-pro-sync-thread-button"))
          .find((button) => button instanceof HTMLElement && button.dataset.codexProSyncThreadPath === anchorPath)
        : null;
      if (anchor instanceof HTMLElement) {
        const listRect = list.getBoundingClientRect();
        const anchorRect = anchor.getBoundingClientRect();
        const anchorOffset = Number(snapshot.anchorOffset) || 0;
        list.scrollTop = Math.max(0, list.scrollTop + anchorRect.top - listRect.top - anchorOffset);
        return;
      }
      list.scrollTop = Math.max(0, Number(snapshot.scrollTop) || 0);
    }

    function clearThreadListScrollMemory() {
      // 这一段在同步配置变化时清掉运行时滚动记忆和旧弹窗内容，避免不同密钥的数据串位置。
      // Clear runtime scroll memory and stale popup content when sync config changes so different keys do not share position.
      state.threadListScrollByGroupKey.clear();
      state.isProfileMenuOpen = false;
      state.isProfileMenuPointerInside = false;
      state.hoverGroupKey = "";
      state.isDevicePinned = !isHoverDirectoryPanelMode();
      state.isGroupPinned = !isHoverThreadPanelMode();
      window.clearTimeout(state.devicePanelCloseTimer);
      state.devicePanelCloseTimer = 0;
      window.clearTimeout(state.threadPanelCloseTimer);
      state.threadPanelCloseTimer = 0;
      const panel = document.getElementById(panelId);
      if (panel instanceof HTMLElement) {
        panel.hidden = true;
        delete panel.dataset.codexProSyncDeviceId;
        panel.replaceChildren();
      }
      removeProfileMenu();
      const threadPanel = document.getElementById(threadPanelId);
      if (threadPanel instanceof HTMLElement) {
        threadPanel.hidden = true;
        delete threadPanel.dataset.codexProSyncGroupKey;
        threadPanel.replaceChildren();
      }
    }

    function rememberPointerPosition(event) {
      // 这一段记录最后一次指针坐标，让 hover 关闭计时器能在 DOM 重绘后重新判断实际落点。
      // Remember the latest pointer coordinates so hover-close timers can re-check the real hit area after DOM rerenders.
      if (!Number.isFinite(event?.clientX) || !Number.isFinite(event?.clientY)) return;
      state.lastPointerClientX = event.clientX;
      state.lastPointerClientY = event.clientY;
    }

    function isLastPointerInsideElement(element) {
      // 这一段用几何命中补足 pointerleave 可能被重绘吞掉的情况，避免 hover 面板误关或不关。
      // Use geometric hit testing to cover pointerleave events swallowed by rerenders, avoiding wrong hover-panel close behavior.
      if (!(element instanceof Element)) return false;
      if (element instanceof HTMLElement && element.hidden) return false;
      if (!Number.isFinite(state.lastPointerClientX) || !Number.isFinite(state.lastPointerClientY)) return false;
      const rect = element.getBoundingClientRect();
      return state.lastPointerClientX >= rect.left &&
        state.lastPointerClientX <= rect.right &&
        state.lastPointerClientY >= rect.top &&
        state.lastPointerClientY <= rect.bottom;
    }

    function isPointerInsideDirectoryHoverRegion() {
      // 这一段把设备入口、左侧目录、账号菜单和右侧会话列表视为同一个 hover 安全区域。
      // Treat the device entry, left directory panel, profile menu, and right thread panel as one hover-safe area.
      const root = document.getElementById(rootId);
      return isPointerInsideThreadHoverRegion() || isLastPointerInsideElement(root);
    }

    function isPointerInsideThreadHoverRegion() {
      // 这一段保持右侧会话列表原有 hover 边界，只把左侧目录、账号菜单和右侧列表视为安全区。
      // Keep the right thread-list hover boundary unchanged, treating only the left directory, profile menu, and right list as safe areas.
      const panel = document.getElementById(panelId);
      const profileMenu = document.getElementById(profileMenuId);
      const threadPanel = document.getElementById(threadPanelId);
      return state.isPanelPointerInside ||
        state.isProfileMenuPointerInside ||
        state.isThreadPanelPointerInside ||
        isLastPointerInsideElement(panel) ||
        isLastPointerInsideElement(profileMenu) ||
        isLastPointerInsideElement(threadPanel);
    }

    function clearDevicePanelHoverCloseTimer() {
      // 这一段清理左侧目录面板关闭计时器，避免跨面板移动时旧计时器误关。
      // Clear the left directory-panel close timer so stale timers do not close it while crossing panels.
      window.clearTimeout(state.devicePanelCloseTimer);
      state.devicePanelCloseTimer = 0;
    }

    function clearThreadPanelHoverCloseTimer() {
      // 这一段清理悬停关闭计时器，保证鼠标进入右侧列表或重新悬停目录时不会误关。
      // Clear the hover-close timer so entering the thread panel or hovering another group does not close it.
      window.clearTimeout(state.threadPanelCloseTimer);
      state.threadPanelCloseTimer = 0;
    }

    function scheduleDevicePanelHoverClose() {
      // 这一段延迟收起临时目录面板；鼠标在任一相关浮层内或会话操作进行中都不关闭。
      // Delay folding the temporary directory panel; keep it while the pointer is in any related surface or thread work is active.
      if (!isHoverDirectoryPanelMode() || !state.isPanelOpen || state.isDevicePinned) return;
      clearDevicePanelHoverCloseTimer();
      state.devicePanelCloseTimer = window.setTimeout(() => {
        state.devicePanelCloseTimer = 0;
        if (
          state.isDevicePinned ||
          isPointerInsideDirectoryHoverRegion() ||
          state.activeThreadPanelWorkCount > 0 ||
          state.activeArchivePointerDrag ||
          state.activeArchiveThreadDrag ||
          state.isNativeArchiveThreadDragActive
        ) {
          return;
        }
        closePanel();
        render();
      }, devicePanelHoverCloseDelayMs);
    }

    function scheduleThreadPanelHoverClose() {
      // 这一段给悬停预览留出跨面板移动时间；拖拽会话时不关闭右侧列表。
      // Give hover preview time to cross the panel gap; do not close the thread panel while a thread is being dragged.
      if (!isHoverThreadPanelMode() || !state.isPanelOpen) return;
      clearThreadPanelHoverCloseTimer();
      state.threadPanelCloseTimer = window.setTimeout(() => {
        state.threadPanelCloseTimer = 0;
        if (
          isPointerInsideThreadHoverRegion() ||
          state.activeThreadPanelWorkCount > 0 ||
          state.activeArchivePointerDrag ||
          state.activeArchiveThreadDrag ||
          state.isNativeArchiveThreadDragActive
        ) {
          return;
        }
        if (!state.hoverGroupKey) return;
        rememberThreadListScroll();
        state.hoverGroupKey = "";
        state.activeThreadPath = "";
        render();
      }, threadPanelHoverCloseDelayMs);
    }

    function previewThreadPanelGroup(groupKey) {
      // 这一段只在未固定时按悬停目录临时切换右侧列表，固定后 hover 不再覆盖用户选择。
      // Temporarily switch the right thread panel only while unpinned; hover no longer overrides the user's pinned choice.
      if (!isHoverThreadPanelMode() || !groupKey || state.isGroupPinned) return;
      clearThreadPanelHoverCloseTimer();
      if (state.hoverGroupKey === groupKey) return;
      rememberThreadListScroll();
      state.hoverGroupKey = groupKey;
      state.activeThreadPath = "";
      render();
    }

    function setStatus(message = "", tone = "", kind = "", resetDelayMs = tone === "success" ? statusResetDelayMs : 0, source = message || kind ? "manual" : "", progress = null) {
      // 这一段设置弹出栏状态文案，并按调用来源决定是否自动回到版本信息。
      // Set panel status text and decide by caller whether it should fall back to version info automatically.
      window.clearTimeout(state.statusTimer);
      state.statusMessage = message;
      state.statusKind = kind;
      state.statusProgress = progress && typeof progress === "object" ? progress : null;
      state.statusSource = source;
      state.statusTone = tone;
      if (resetDelayMs > 0) {
        state.statusTimer = window.setTimeout(() => {
          state.statusMessage = "";
          state.statusKind = "";
          state.statusProgress = null;
          state.statusSource = "";
          state.statusTone = "";
          render();
        }, resetDelayMs);
      }
      render();
    }

    function getSidebarHeadingStatusText() {
      // 这一段把长状态压成左下角标题里的短标签，完整错误仍保留在弹窗状态行。
      // Compress long statuses into a short lower-left heading label while full errors stay in the popup status row.
      if (!state.statusMessage || !state.statusKind) return "";
      if (state.statusKind === "attaching") return i18n.t("syncSidebar.headingStatus.attaching");
      if (state.statusKind === "deleting") return i18n.t("syncSidebar.headingStatus.deleting");
      if (state.statusKind === "syncing") return i18n.t("syncSidebar.headingStatus.syncing");
      if (state.statusKind === "uploading") return getArchiveUploadProgressStatusText(state.statusProgress) || i18n.t("syncSidebar.headingStatus.uploading");
      if (state.statusKind === "refreshing") return i18n.t("syncSidebar.headingStatus.refreshing");
      if (state.statusKind === "success") return i18n.t("syncSidebar.headingStatus.success");
      if (state.statusKind === "error") return i18n.t("syncSidebar.headingStatus.error");
      return "";
    }

    function formatSidebarHeading() {
      // 这一段在同步进行或失败时把状态挂到“同步”标题后，平时保持原文案。
      // Append sync status to the heading only while syncing or failed; otherwise keep the plain heading.
      const heading = i18n.t("syncSidebar.heading");
      const status = getSidebarHeadingStatusText();
      return status ? i18n.t("syncSidebar.headingWithStatus", { heading, status }) : heading;
    }

    function ensureRoot() {
      // 这一段把“同步”栏目挂到原生侧栏滚动容器末尾，侧栏重建后会重新挂载。
      // Mount the Sync section at the end of the native sidebar scroller and remount after sidebar rebuilds.
      const scroll = findSidebarScroll();
      if (!scroll) return null;
      let root = document.getElementById(rootId);
      if (!root) {
        root = document.createElement("section");
        root.id = rootId;
        root.addEventListener("pointerenter", (event) => {
          // 这一段把稳定的同步入口根节点纳入 hover 安全区，兜底设备按钮重绘吞掉 leave 的情况。
          // Include the stable sync-entry root in the hover-safe area to cover device-button rerenders swallowing leave.
          rememberPointerPosition(event);
          clearDevicePanelHoverCloseTimer();
        }, { signal: controller.signal });
        root.addEventListener("pointerleave", (event) => {
          // 这一段离开整个同步入口后再延迟关闭临时目录面板。
          // Delay closing the temporary directory panel after the pointer leaves the whole sync entry.
          rememberPointerPosition(event);
          scheduleDevicePanelHoverClose();
        }, { signal: controller.signal });
      }
      if (root.parentElement !== scroll) scroll.append(root);
      return root;
    }

    function ensurePanel() {
      // 这一段创建设备目录弹出框，后续只更新内容和用户选择的位置。
      // Create the device-directory popup; later renders update only content and the user-selected placement.
      let panel = document.getElementById(panelId);
      if (!panel) {
        panel = document.createElement("aside");
        panel.id = panelId;
        panel.setAttribute("role", "dialog");
        panel.setAttribute("aria-label", i18n.t("syncSidebar.panel.aria"));
        panel.addEventListener("pointerenter", (event) => {
          // 这一段标记鼠标仍在左侧目录面板内，避免 hover 模式下右侧列表提前关闭。
          // Mark the pointer as still inside the directory panel so hover mode does not close the thread panel early.
          rememberPointerPosition(event);
          state.isPanelPointerInside = true;
          clearDevicePanelHoverCloseTimer();
          clearThreadPanelHoverCloseTimer();
        }, { signal: controller.signal });
        panel.addEventListener("pointerleave", (event) => {
          // 这一段在离开左侧面板后延迟关闭临时预览，给用户移动到右侧列表的时间。
          // Delay closing the temporary preview after leaving the left panel so the user can move into the thread panel.
          rememberPointerPosition(event);
          state.isPanelPointerInside = false;
          scheduleDevicePanelHoverClose();
          scheduleThreadPanelHoverClose();
        }, { signal: controller.signal });
        panel.addEventListener("keydown", (event) => {
          // 这一段保留无可见关闭按钮后的键盘关闭能力，避免 dialog 只能靠鼠标点外部退出。
          // Preserve keyboard closing after removing the visible close button so the dialog is not mouse-only.
          if (event.key !== "Escape") return;
          event.preventDefault();
          closePanel(panel);
          render();
        }, { signal: controller.signal });
        document.body.append(panel);
      }
      return panel;
    }

    function removeProfileMenu() {
      // 这一段移除独立账号浮层，避免关闭面板或重复注入后留下游离菜单。
      // Remove the detached profile popup so closing the panel or reinjecting does not leave a stray menu.
      state.isProfileMenuPointerInside = false;
      document.getElementById(profileMenuId)?.remove();
    }

    function ensureProfileMenu() {
      // 这一段创建 body 级 fixed 浮层，规避面板 overflow 对菜单的裁切。
      // Create a body-level fixed popup so panel overflow cannot clip the menu.
      let menu = document.getElementById(profileMenuId);
      if (!menu) {
        menu = document.createElement("div");
        menu.id = profileMenuId;
        menu.className = "codex-pro-sync-profile-menu";
        menu.setAttribute("role", "listbox");
        menu.setAttribute("aria-label", i18n.t("syncSidebar.profileSelect.aria"));
        menu.addEventListener("pointerenter", (event) => {
          // 这一段把独立账号菜单纳入左侧 hover 安全区，避免切换账号时目录面板被收起。
          // Include the detached profile menu in the left hover-safe area so switching profiles does not fold the directory panel.
          rememberPointerPosition(event);
          state.isProfileMenuPointerInside = true;
          clearDevicePanelHoverCloseTimer();
          clearThreadPanelHoverCloseTimer();
        }, { signal: controller.signal });
        menu.addEventListener("pointerleave", (event) => {
          // 这一段离开账号菜单后恢复 hover 收起规则。
          // Restore hover-close rules after the pointer leaves the profile menu.
          rememberPointerPosition(event);
          state.isProfileMenuPointerInside = false;
          scheduleDevicePanelHoverClose();
          scheduleThreadPanelHoverClose();
        }, { signal: controller.signal });
        menu.addEventListener("keydown", (event) => {
          if (event.key !== "Escape") return;
          event.preventDefault();
          state.isProfileMenuOpen = false;
          render();
        }, { signal: controller.signal });
        document.body.append(menu);
      }
      return menu;
    }

    function ensureThreadPanel() {
      // 这一段创建右侧会话列表弹出框，让目录选择和会话列表可以并排浏览。
      // Create the right-side thread-list popup so directory selection and sessions can be browsed side by side.
      let panel = document.getElementById(threadPanelId);
      if (!panel) {
        panel = document.createElement("aside");
        panel.id = threadPanelId;
        panel.setAttribute("role", "dialog");
        panel.setAttribute("aria-label", i18n.t("syncSidebar.panel.aria"));
        panel.addEventListener("pointerenter", (event) => {
          // 这一段保持右侧会话列表可操作，鼠标进入后不再按左侧离开事件自动关闭。
          // Keep the right thread list interactive; entering it cancels the left-panel leave close.
          rememberPointerPosition(event);
          state.isThreadPanelPointerInside = true;
          clearDevicePanelHoverCloseTimer();
          clearThreadPanelHoverCloseTimer();
        }, { signal: controller.signal });
        panel.addEventListener("pointerleave", (event) => {
          // 这一段在离开右侧会话列表后再延迟收起临时 hover 目录。
          // Delay folding the temporary hover directory after the pointer leaves the right thread panel.
          rememberPointerPosition(event);
          state.isThreadPanelPointerInside = false;
          scheduleDevicePanelHoverClose();
          scheduleThreadPanelHoverClose();
        }, { signal: controller.signal });
        document.body.append(panel);
      }
      return panel;
    }

    function closePanel(panel = document.getElementById(panelId)) {
      // 这一段关闭普通弹出框，但保留本次运行中的拖动位置和目录选择，方便下次打开复用。
      // Close the normal popup while keeping the in-memory dragged position and directory selection for the next open.
      rememberThreadListScroll();
      clearArchiveThreadDrag();
      clearDevicePanelHoverCloseTimer();
      clearThreadPanelHoverCloseTimer();
      state.hoverGroupKey = "";
      state.isDevicePinned = !isHoverDirectoryPanelMode();
      state.isGroupPinned = !isHoverThreadPanelMode();
      state.isPanelOpen = false;
      state.isPanelPointerInside = false;
      state.isProfileMenuOpen = false;
      state.isProfileMenuPointerInside = false;
      state.isThreadPanelPointerInside = false;
      state.activeThreadPath = "";
      state.dragAbortController?.abort();
      state.dragAbortController = null;
      if (panel) {
        panel.removeAttribute("data-codex-pro-sync-dragging");
        panel.hidden = true;
        panel.replaceChildren();
      }
      removeProfileMenu();
      const threadPanel = document.getElementById(threadPanelId);
      if (threadPanel instanceof HTMLElement) {
        threadPanel.hidden = true;
        threadPanel.replaceChildren();
      }
    }

    function clampPanelPosition(position, panel) {
      // 这一段把弹出框位置夹在可视窗口内，避免拖动或窗口缩放后完全跑出屏幕。
      // Clamp the popup position into the viewport so dragging or resizing cannot move it fully off-screen.
      const rect = panel.getBoundingClientRect();
      const width = Math.max(rect.width, 1);
      const height = Math.max(rect.height, 1);
      const maxLeft = Math.max(panelViewportMargin, window.innerWidth - width - panelViewportMargin);
      const maxTop = Math.max(panelViewportMargin, window.innerHeight - height - panelViewportMargin);
      return {
        left: Math.min(Math.max(Math.round(position.left), panelViewportMargin), maxLeft),
        top: Math.min(Math.max(Math.round(position.top), panelViewportMargin), maxTop),
      };
    }

    function getDefaultPanelPosition(root, panel) {
      // 这一段首次打开时贴住左侧栏右边缘，并让弹窗底部跟随左下角同步入口底部。
      // On first open, attach to the sidebar's right edge and align the popup bottom with the lower-left sync entry.
      const sidebarRect = getVisibleRect(findSidebarScroll()) || getVisibleRect(root);
      const rootRect = getVisibleRect(root) || sidebarRect;
      const panelRect = panel.getBoundingClientRect();
      const panelHeight = Math.max(panelRect.height, 1);
      const left = Math.max(0, Math.round(sidebarRect?.right || 320));
      const anchorBottom = Math.min(
        window.innerHeight - panelViewportMargin,
        Math.round(rootRect?.bottom || sidebarRect?.bottom || window.innerHeight - panelViewportMargin),
      );
      const top = anchorBottom - panelHeight;
      return clampPanelPosition({ left, top }, panel);
    }

    function applyPanelPosition(root, panel, threadPanel = document.getElementById(threadPanelId)) {
      // 这一段只在第一次打开时读取侧栏位置，之后渲染和侧栏变化都不会覆盖用户拖动坐标。
      // Read the sidebar position only for the first open; later renders and sidebar changes do not overwrite the dragged coordinates.
      if (!state.isPanelOpen || panel.hidden) return;
      if (!state.panelPosition) state.panelPosition = getDefaultPanelPosition(root, panel);
      state.panelPosition = clampPanelPosition(state.panelPosition, panel);
      panel.style.left = `${state.panelPosition.left}px`;
      panel.style.top = `${state.panelPosition.top}px`;
      if (threadPanel instanceof HTMLElement && !threadPanel.hidden) {
        const panelRect = panel.getBoundingClientRect();
        const threadRect = threadPanel.getBoundingClientRect();
        const threadHeight = Math.max(threadRect.height, 1);
        const gap = 10;
        const rightLeft = Math.min(
          Math.max(panelViewportMargin, state.panelPosition.left + panelRect.width + gap),
          Math.max(panelViewportMargin, window.innerWidth - Math.max(threadRect.width, 1) - panelViewportMargin),
        );
        const threadTop = Math.min(
          state.panelPosition.top,
          Math.max(panelViewportMargin, window.innerHeight - threadHeight - panelViewportMargin),
        );
        threadPanel.style.left = `${Math.round(rightLeft)}px`;
        threadPanel.style.top = `${Math.round(threadTop)}px`;
      }
    }

    function beginPanelDrag(event, panel) {
      // 这一段只允许鼠标左键从标题栏拖动，关闭按钮等控件不触发拖拽。
      // Start dragging only from the header with the primary mouse button; controls such as close do not drag.
      if (event.button !== 0 || event.target?.closest?.("button")) return;
      event.preventDefault();
      const startRect = panel.getBoundingClientRect();
      const startPointer = { x: event.clientX, y: event.clientY };
      const startPosition = {
        left: state.panelPosition?.left ?? startRect.left,
        top: state.panelPosition?.top ?? startRect.top,
      };
      const dragController = new AbortController();
      state.dragAbortController?.abort();
      state.dragAbortController = dragController;
      panel.setAttribute("data-codex-pro-sync-dragging", "true");

      function movePanel(nextEvent) {
        // 这一段根据指针位移更新弹出框坐标，并实时限制在当前窗口内。
        // Update the popup coordinates from pointer movement and keep them clamped to the current viewport.
        state.panelPosition = clampPanelPosition({
          left: startPosition.left + nextEvent.clientX - startPointer.x,
          top: startPosition.top + nextEvent.clientY - startPointer.y,
        }, panel);
        panel.style.left = `${state.panelPosition.left}px`;
        panel.style.top = `${state.panelPosition.top}px`;
        applyPanelPosition(document.getElementById(rootId), panel, document.getElementById(threadPanelId));
      }

      function stopPanelDrag() {
        // 这一段结束本次拖动并释放一次性事件，避免关闭后继续监听鼠标移动。
        // Finish this drag operation and release one-off listeners so mouse movement is not tracked after close.
        panel.removeAttribute("data-codex-pro-sync-dragging");
        dragController.abort();
        if (state.dragAbortController === dragController) state.dragAbortController = null;
      }

      window.addEventListener("pointermove", movePanel, { signal: dragController.signal });
      window.addEventListener("pointerup", stopPanelDrag, { once: true, signal: dragController.signal });
      window.addEventListener("pointercancel", stopPanelDrag, { once: true, signal: dragController.signal });
    }

    function closePanelFromOutside(event) {
      // 这一段实现普通弹出框行为：点击弹出框外部关闭，但保留左侧同步入口的点击切换能力。
      // Implement normal popup behavior: close on outside clicks while preserving left sync-entry clicks.
      if (!state.isPanelOpen) return;
      const target = event.target;
      if (!(target instanceof Node)) return;
      const panel = document.getElementById(panelId);
      const profileMenu = document.getElementById(profileMenuId);
      const threadPanel = document.getElementById(threadPanelId);
      const root = document.getElementById(rootId);
      const eventPath = typeof event.composedPath === "function" ? event.composedPath() : [];
      if (!panel || panel.hidden) return;
      if (profileMenu?.contains(target) || eventPath.includes(profileMenu)) return;
      if (panel.contains(target) || eventPath.includes(panel)) {
        if (state.isProfileMenuOpen && !target.closest?.(".codex-pro-sync-profile-picker")) {
          state.isProfileMenuOpen = false;
          render();
        }
        return;
      }
      if (
        threadPanel?.contains(target) ||
        eventPath.includes(threadPanel) ||
        root?.contains(target) ||
        eventPath.includes(root)
      ) {
        if (state.isProfileMenuOpen) {
          state.isProfileMenuOpen = false;
          render();
        }
        return;
      }
      closePanel(panel);
      render();
    }

    function getSelectedDevice() {
      // 这一段根据当前选中设备 id 找远端设备；设备列表刷新后失效则返回空。
      // Find the selected remote device by id; return null if a refresh invalidated it.
      return getArchiveDevices(state.snapshot).find((device) => device.deviceId === state.panelDeviceId) || null;
    }

    function getSelectedProfile(device = getSelectedDevice()) {
      // 这一段根据当前账号 id 找设备下的 profile，刷新失效时回落第一个账号。
      // Find the selected profile under the device, falling back to the first profile after refresh invalidation.
      const profiles = getDeviceProfiles(device);
      return profiles.find((profile) => profile.profileId === state.panelProfileId) || profiles[0] || null;
    }

    function getSelectedGroup(profile = getSelectedProfile(), groupKey = getActivePanelGroupKey()) {
      // 这一段根据当前活动目录 key 找账号下的分组；hover 模式没有活动目录时返回空。
      // Find the active group under the profile; in hover mode, return null when no group is active.
      const groups = getProfileGroups(profile);
      if (!groupKey) return null;
      return groups.find((group) => getProfileGroupKey(group) === groupKey) || null;
    }

    function ensurePanelSelection(device = getSelectedDevice()) {
      // 这一段在渲染前修正账号和目录选择，避免空选择导致右侧列表悬空。
      // Repair profile and group selection before rendering so the right thread list is never detached.
      const profiles = getDeviceProfiles(device);
      const profile = profiles.find((item) => item.profileId === state.panelProfileId) || profiles[0] || null;
      state.panelProfileId = profile?.profileId || "";
      const groups = getProfileGroups(profile);
      const group = groups.find((item) => getProfileGroupKey(item) === state.panelGroupKey) || groups[0] || null;
      state.panelGroupKey = group ? getProfileGroupKey(group) : "";
      if (!groups.some((item) => getProfileGroupKey(item) === state.hoverGroupKey)) state.hoverGroupKey = "";
      if (!group) state.isGroupPinned = false;
      const activeGroupKey = getActivePanelGroupKey();
      const activeGroup = activeGroupKey
        ? groups.find((item) => getProfileGroupKey(item) === activeGroupKey) || null
        : null;
      return { activeGroup, group, groups, profile, profiles };
    }

    function appendGroupIcon(button, group) {
      // 这一段给目录行补一个轻量文件夹图标，帮助区分目录和具体会话。
      // Add a lightweight folder icon to directory rows so groups are visually distinct from sessions.
      const icon = document.createElementNS("http://www.w3.org/2000/svg", "svg");
      icon.setAttribute("class", "codex-pro-sync-group-icon");
      icon.setAttribute("viewBox", "0 0 24 24");
      icon.setAttribute("aria-hidden", "true");
      icon.setAttribute("fill", "none");
      icon.setAttribute("stroke", "currentColor");
      icon.setAttribute("stroke-width", "1.8");
      icon.setAttribute("stroke-linecap", "round");
      icon.setAttribute("stroke-linejoin", "round");
      const folderPath = document.createElementNS("http://www.w3.org/2000/svg", "path");
      folderPath.setAttribute("d", group?.archiveGroupType === "project"
        ? "M3 7.5h6l2 2H21v8.5a2 2 0 0 1-2 2H5a2 2 0 0 1-2-2Z"
        : "M4 6h6l2 2h8v10a2 2 0 0 1-2 2H6a2 2 0 0 1-2-2Z");
      icon.append(folderPath);
      button.append(icon);
    }

    function appendTrashIcon(button) {
      // 这一段给删除设备按钮补一个轻量垃圾桶图标，避免用文字按钮挤占标题栏。
      // Add a lightweight trash icon to the device-delete button so the header does not need a text button.
      const icon = document.createElementNS("http://www.w3.org/2000/svg", "svg");
      icon.setAttribute("viewBox", "0 0 24 24");
      icon.setAttribute("aria-hidden", "true");
      icon.setAttribute("fill", "none");
      icon.setAttribute("stroke", "currentColor");
      icon.setAttribute("stroke-width", "1.8");
      icon.setAttribute("stroke-linecap", "round");
      icon.setAttribute("stroke-linejoin", "round");
      for (const d of [
        "M3 6h18",
        "M8 6V4.8A1.8 1.8 0 0 1 9.8 3h4.4A1.8 1.8 0 0 1 16 4.8V6",
        "M19 6l-.8 13.2A2 2 0 0 1 16.2 21H7.8a2 2 0 0 1-2-1.8L5 6",
        "M10 11v5",
        "M14 11v5",
      ]) {
        const pathElement = document.createElementNS("http://www.w3.org/2000/svg", "path");
        pathElement.setAttribute("d", d);
        icon.append(pathElement);
      }
      button.append(icon);
    }

    function removeDeviceFromLocalSnapshot(deviceId, visibleAfterRevision = Number.POSITIVE_INFINITY) {
      // 这一段只从本次已拉取的远端列表快照里移除设备，真正远端数据仍以服务端删除结果为准。
      // Remove the device only from the currently pulled remote-list snapshot; real remote data still depends on the server result.
      const normalizedDeviceId = String(deviceId || "");
      const snapshotDevices = Array.isArray(state.snapshot?.devices) ? state.snapshot.devices : [];
      if (!normalizedDeviceId) return false;
      rememberLocallyHiddenDevice(normalizedDeviceId, visibleAfterRevision);
      if (snapshotDevices.length === 0) return false;

      // 这一段只重建内存快照里的设备数组，不写本地设置或远端状态。
      // Rebuild only the in-memory device list without writing local settings or remote state.
      const nextDevices = snapshotDevices.filter((device) => device?.deviceId !== normalizedDeviceId);
      if (nextDevices.length === snapshotDevices.length) return false;
      state.snapshot = {
        ...(state.snapshot && typeof state.snapshot === "object" ? state.snapshot : {}),
        devices: nextDevices,
      };

      // 这一段如果删的是当前弹窗设备，就关闭弹窗并清理运行时选择，避免右侧列表悬空。
      // If the removed device owns the current popup, close it and clear runtime selection so the thread panel cannot float detached.
      if (state.panelDeviceId === normalizedDeviceId) {
        closePanel();
        state.panelDeviceId = "";
        state.panelProfileId = "";
        state.panelGroupKey = "";
      }
      return true;
    }

    function selectPanelProfile(profileId, device) {
      // 这一段切换账号并重置目录选择；账号菜单只影响远端索引分组，不读取真实账号数据。
      // Switch profile and reset directory selection; this menu only changes remote-index grouping and never reads real account data.
      rememberThreadListScroll();
      clearThreadPanelHoverCloseTimer();
      state.hoverGroupKey = "";
      state.isGroupPinned = !isHoverThreadPanelMode();
      state.panelProfileId = profileId || "";
      state.panelGroupKey = "";
      state.activeThreadPath = "";
      state.isProfileMenuOpen = false;
      ensurePanelSelection(device);
      render();
    }

    function getArchiveThreadTitle(thread) {
      // 这一段统一会话标题兜底，拖拽附件和列表显示保持同一套标题语义。
      // Normalize the thread title fallback so drag attachments and list rows use the same title semantics.
      return thread?.title || i18n.t("common.untitledSession");
    }

    function getArchiveThreadAttachmentApi() {
      // 这一段只复用文件拖入聊天模块暴露的官方附件入口，不在同步侧栏里重复逆向 composer。
      // Reuse only the official attachment entrypoint exposed by the file-drag module instead of re-discovering the composer here.
      const attachmentApi = runtime.systemModules.tabDragToChat;
      if (
        typeof attachmentApi?.addLocalFileAttachment !== "function" ||
        typeof attachmentApi?.isComposerDropEvent !== "function"
      ) {
        return null;
      }
      return attachmentApi;
    }

    function isArchiveThreadComposerDropEvent(event) {
      // 这一段把投放区域判断交给共享附件模块，避免同步侧栏按文案或尺寸重复定位输入框。
      // Delegate drop-zone detection to the shared attachment module so the sync sidebar does not re-locate the composer by text or size.
      return Boolean(getArchiveThreadAttachmentApi()?.isComposerDropEvent(event));
    }

    function findSelectedArchiveThreadByPath(path) {
      // 这一段只从当前可见目录找拖拽 path，避免跨密钥或跨目录恢复不可见旧数据。
      // Resolve a dragged path only from the current visible directory, avoiding stale data across keys or directories.
      const normalizedPath = String(path || "");
      if (!normalizedPath) return null;
      const group = getSelectedGroup();
      const threads = Array.isArray(group?.threads) ? group.threads : [];
      return threads.find((thread) => thread?.path === normalizedPath) || null;
    }

    function getDraggedArchiveThread(event) {
      // 这一段优先使用同页内存拖拽对象，再兼容 dataTransfer 里的受限会话 path。
      // Prefer the in-page drag object, then fall back to the constrained thread path stored in dataTransfer.
      if (state.activeArchiveThreadDrag?.path) return state.activeArchiveThreadDrag;
      const path = event.dataTransfer?.getData?.(conversationArchiveThreadDragDataType);
      return findSelectedArchiveThreadByPath(path);
    }

    function clearArchiveThreadDrag() {
      // 这一段清理本次会话拖拽状态，避免下一次普通拖拽复用旧会话 path。
      // Clear the current thread-drag state so the next normal drag cannot reuse an old thread path.
      const hadActiveThreadDrag = Boolean(
        state.activeArchivePointerDrag ||
        state.activeArchiveThreadDrag ||
        state.isNativeArchiveThreadDragActive,
      );
      state.activeArchivePointerDrag = null;
      state.activeArchiveThreadDrag = null;
      state.isNativeArchiveThreadDragActive = false;
      const isInsideDirectoryHoverRegion = isPointerInsideDirectoryHoverRegion();
      const isInsideThreadHoverRegion = isPointerInsideThreadHoverRegion();
      if (hadActiveThreadDrag && !isInsideDirectoryHoverRegion) {
        scheduleDevicePanelHoverClose();
      }
      if (hadActiveThreadDrag && !isInsideThreadHoverRegion) {
        scheduleThreadPanelHoverClose();
      }
    }

    function handleArchiveThreadPointerCancel() {
      // 这一段把原生拖拽启动时的 pointercancel 视为拖拽交接，不让它清掉 hover 面板。
      // Treat pointercancel during native drag startup as handoff to drag events, not as a reason to close the hover panel.
      if (state.activeArchiveThreadDrag || state.isNativeArchiveThreadDragActive) {
        // 这一段覆盖 dragstart 已经先于 pointercancel 触发的浏览器顺序，保留原生拖拽状态直到 dragend/drop。
        // Cover the browser order where dragstart fires before pointercancel, keeping native drag state until dragend/drop.
        clearDevicePanelHoverCloseTimer();
        clearThreadPanelHoverCloseTimer();
        return;
      }
      const drag = state.activeArchivePointerDrag;
      if (drag?.thread?.path) {
        state.activeArchivePointerDrag = null;
        state.activeArchiveThreadDrag = drag.thread;
        state.isNativeArchiveThreadDragActive = true;
        clearThreadPanelHoverCloseTimer();
        return;
      }
      clearArchiveThreadDrag();
    }

    function beginThreadPanelWork() {
      // 这一段在会话打开或附件解包期间保持 hover 面板，避免异步操作中途被鼠标离开收起。
      // Keep the hover panel alive while a thread is opening or being unpacked for attachment.
      state.activeThreadPanelWorkCount += 1;
      clearDevicePanelHoverCloseTimer();
      clearThreadPanelHoverCloseTimer();
    }

    function endThreadPanelWork() {
      // 这一段释放异步工作保持锁；如果鼠标已经离开左右面板，再恢复 hover 收起规则。
      // Release the async work keepalive; if the pointer has left both panels, restore the hover-close rule.
      state.activeThreadPanelWorkCount = Math.max(0, state.activeThreadPanelWorkCount - 1);
      if (state.activeThreadPanelWorkCount === 0 && !isPointerInsideDirectoryHoverRegion()) {
        scheduleDevicePanelHoverClose();
      }
      if (state.activeThreadPanelWorkCount === 0 && !isPointerInsideThreadHoverRegion()) {
        scheduleThreadPanelHoverClose();
      }
    }

    function getArchivePointerKey(event) {
      // 这一段给 PointerEvent 和 mouse fallback 统一生成拖拽指针标识。
      // Build one pointer identifier for PointerEvent and the mouse fallback path.
      return Number.isFinite(event.pointerId) ? event.pointerId : "mouse";
    }

    function getArchivePointerDistance(drag, event) {
      // 这一段计算会话行拖拽距离，用来区分点击打开和真实拖拽。
      // Measure movement from the thread row so clicks remain opens and real drags become attachments.
      return Math.hypot(event.clientX - drag.startX, event.clientY - drag.startY);
    }

    function startArchiveThreadPointerDrag(event, thread) {
      // 这一段记录会话行指针拖拽，兼容不触发浏览器 dragstart 的 Electron 拖动路径。
      // Record pointer-based thread drags for Electron paths that may not emit browser dragstart.
      if (event.button !== 0 || !thread?.path) return;
      state.activeArchivePointerDrag = {
        hasDragged: false,
        pointerKey: getArchivePointerKey(event),
        startX: event.clientX,
        startY: event.clientY,
        thread,
      };
    }

    function updateArchiveThreadPointerDrag(event) {
      // 这一段只跟踪同一个指针，并在超过阈值后标记为拖拽。
      // Track only the same pointer and mark it as a drag after the movement threshold.
      rememberPointerPosition(event);
      const drag = state.activeArchivePointerDrag;
      if (!drag || drag.pointerKey !== getArchivePointerKey(event)) return;
      if (Number.isFinite(event.buttons) && (event.buttons & 1) !== 1) {
        clearArchiveThreadDrag();
        return;
      }
      if (getArchivePointerDistance(drag, event) >= conversationArchiveAttachmentPointerThresholdPx) {
        drag.hasDragged = true;
      }
    }

    function finishArchiveThreadPointerDrag(event) {
      // 这一段在指针拖拽松手时检查 composer 落点，成功时把会话追加成附件。
      // On pointer release, check the composer drop point and append the conversation as an attachment when valid.
      rememberPointerPosition(event);
      const drag = state.activeArchivePointerDrag;
      if (!drag || drag.pointerKey !== getArchivePointerKey(event)) return;
      state.activeArchivePointerDrag = null;
      if (!drag.hasDragged && getArchivePointerDistance(drag, event) < conversationArchiveAttachmentPointerThresholdPx) return;
      if (!isArchiveThreadComposerDropEvent(event)) return;
      event.preventDefault();
      event.stopPropagation();
      clearArchiveThreadDrag();
      void attachArchiveThreadToComposer(drag.thread);
    }

    function handleArchiveThreadDragStart(event, thread) {
      // 这一段把当前会话 path 写入同页拖拽状态；不写会话正文或本机路径。
      // Store only the current thread path for same-page dragging; no conversation body or local path is written.
      if (!thread?.path) return;
      state.activeArchiveThreadDrag = thread;
      state.activeArchivePointerDrag = null;
      state.isNativeArchiveThreadDragActive = true;
      clearDevicePanelHoverCloseTimer();
      clearThreadPanelHoverCloseTimer();
      try {
        event.dataTransfer?.setData?.(conversationArchiveThreadDragDataType, thread.path);
        if (event.dataTransfer) event.dataTransfer.effectAllowed = "copy";
      } catch {
        // 这一段忽略 dataTransfer 写入失败，内存拖拽状态仍可完成同页投放。
        // Ignore dataTransfer write failures because in-memory drag state can still complete same-page drops.
      }
    }

    function handleArchiveThreadDragOver(event) {
      // 这一段只在同步会话拖到 composer 上时允许 drop，其它拖拽继续交给 Codex 原生处理。
      // Allow drop only when a synced thread is over the composer; every other drag remains native.
      const thread = getDraggedArchiveThread(event);
      if (!thread || !isArchiveThreadComposerDropEvent(event)) return;
      event.preventDefault();
      if (event.dataTransfer) event.dataTransfer.dropEffect = "copy";
    }

    function handleArchiveThreadDrop(event) {
      // 这一段接管 composer 内的同步会话 drop，并在落下后才下载会话 Markdown。
      // Handle synced-thread drops inside the composer and download the conversation Markdown only after the drop.
      const thread = getDraggedArchiveThread(event);
      if (!thread || !isArchiveThreadComposerDropEvent(event)) return;
      event.preventDefault();
      event.stopPropagation();
      clearArchiveThreadDrag();
      void attachArchiveThreadToComposer(thread);
    }

    function renderProfilePicker(panel, device, profile, profiles) {
      // 这一段用 Codex 风格的按钮加浮层替换原生 select，避免系统蓝色下拉态破坏视觉一致性。
      // Replace the native select with a Codex-style button and popup so system-blue dropdown states do not leak into the UI.
      const picker = document.createElement("div");
      picker.className = "codex-pro-sync-profile-picker";
      const trigger = document.createElement("button");
      trigger.className = "codex-pro-sync-profile-trigger";
      trigger.type = "button";
      trigger.setAttribute("aria-haspopup", "listbox");
      trigger.setAttribute("aria-expanded", String(state.isProfileMenuOpen));
      trigger.title = profiles.length <= 1
        ? i18n.t("syncSidebar.profileSelect.single")
        : i18n.t("syncSidebar.profileSelect.aria");
      const label = document.createElement("span");
      label.className = "codex-pro-sync-profile-label";
      label.textContent = profile?.profileName || i18n.t("common.defaultProfile");
      const chevron = document.createElement("span");
      chevron.className = "codex-pro-sync-profile-chevron";
      chevron.setAttribute("aria-hidden", "true");
      trigger.append(label, chevron);
      trigger.addEventListener("click", () => {
        state.isProfileMenuOpen = !state.isProfileMenuOpen;
        render();
      }, { signal: controller.signal });
      trigger.addEventListener("keydown", (event) => {
        if (event.key !== "ArrowDown" && event.key !== "Enter" && event.key !== " ") return;
        event.preventDefault();
        state.isProfileMenuOpen = true;
        render();
      }, { signal: controller.signal });
      picker.append(trigger);
      panel.append(picker);
    }

    function positionProfileMenu(menu, trigger) {
      // 这一段让独立账号菜单固定从触发器上方展开，避免向下覆盖目录列表。
      // Always open the detached profile menu above the trigger so it does not cover the directory list below.
      const triggerRect = trigger.getBoundingClientRect();
      const width = Math.min(Math.max(triggerRect.width, 220), window.innerWidth - panelViewportMargin * 2);
      const left = Math.min(
        Math.max(panelViewportMargin, triggerRect.left),
        Math.max(panelViewportMargin, window.innerWidth - width - panelViewportMargin),
      );
      menu.style.width = `${Math.round(width)}px`;
      menu.style.left = `${Math.round(left)}px`;
      menu.style.top = "0px";
      menu.style.visibility = "hidden";
      const menuRect = menu.getBoundingClientRect();
      const gap = 6;
      const upTop = triggerRect.top - menuRect.height - gap;
      const top = Math.max(panelViewportMargin, upTop);
      menu.style.top = `${Math.round(top)}px`;
      menu.style.visibility = "";
    }

    function syncProfileMenuSurface(menu, panel) {
      // 这一段让 body 级账号菜单直接继承目录面板的实际渲染颜色，避免脱离父级后主题变量计算不一致。
      // Let the body-level profile menu copy the directory panel's computed colors so detached theme resolution cannot drift.
      if (!(menu instanceof HTMLElement) || !(panel instanceof HTMLElement)) return;
      const panelStyle = window.getComputedStyle(panel);
      const panelBackground = panelStyle.backgroundColor;
      const panelBorder = panelStyle.borderTopColor;
      if (panelBackground) menu.style.setProperty("--codex-pro-sync-surface", panelBackground);
      if (panelBorder) menu.style.setProperty("--codex-pro-sync-border", panelBorder);
    }

    function renderProfileMenu() {
      // 这一段渲染独立账号浮层；触发器不在屏幕上或菜单未打开时立即移除。
      // Render the detached profile popup; remove it when closed or when the trigger is not visible.
      if (!state.isProfileMenuOpen) {
        removeProfileMenu();
        return;
      }
      const panel = document.getElementById(panelId);
      const trigger = panel?.querySelector(".codex-pro-sync-profile-trigger");
      const device = getSelectedDevice();
      const profiles = getDeviceProfiles(device);
      const profile = getSelectedProfile(device);
      if (!(trigger instanceof HTMLElement) || !device || profiles.length === 0) {
        removeProfileMenu();
        return;
      }
      const menu = ensureProfileMenu();
      syncProfileMenuSurface(menu, panel);
      menu.replaceChildren();
      for (const item of profiles) {
        const option = document.createElement("button");
        option.className = "codex-pro-sync-profile-option";
        option.type = "button";
        option.setAttribute("role", "option");
        option.setAttribute("aria-selected", String(item.profileId === profile?.profileId));
        option.title = item.profileName || i18n.t("common.defaultProfile");
        const optionLabel = document.createElement("span");
        optionLabel.className = "codex-pro-sync-profile-option-label";
        optionLabel.textContent = item.profileName || i18n.t("common.defaultProfile");
        const check = document.createElement("span");
        check.className = "codex-pro-sync-profile-check";
        check.setAttribute("aria-hidden", "true");
        check.textContent = "✓";
        option.append(optionLabel, check);
        option.addEventListener("click", () => {
          selectPanelProfile(item.profileId || "", device);
        }, { signal: controller.signal });
        menu.append(option);
      }
      positionProfileMenu(menu, trigger);
    }

    async function deleteDeviceArchive(device) {
      // 这一段按用户确认删除远端设备；远端失败时也先从本地快照隐藏，避免旧设备一直粘在侧栏。
      // Delete the remote device after confirmation; even on remote failure, hide it from the local snapshot so stale devices do not stick.
      const deviceId = String(device?.deviceId || "");
      if (!deviceId || state.isDeletingDevice) return;

      // 这一段用页面内确认框提示远端清理范围，避免误点标题栏图标直接删远端数据。
      // Use an in-page confirmation for the remote cleanup scope so a stray header click cannot delete remote data.
      const deviceName = formatArchiveDeviceName(device, state.snapshot);
      const confirmed = await runtime.dialogs.confirm({
        cancelLabel: i18n.t("syncSidebar.deleteDevice.cancel"),
        confirmKind: "danger",
        confirmLabel: i18n.t("syncSidebar.deleteDevice.confirmAction"),
        message: i18n.t("syncSidebar.deleteDevice.confirm", { name: deviceName }),
        signal: controller.signal,
        title: i18n.t("syncSidebar.deleteDevice.confirmTitle", { name: deviceName }),
      });
      if (!confirmed) return;

      // 这一段先从本次快照隐藏设备，再异步清理服务器，避免云端慢请求让设备列表看起来卡住。
      // Hide the device from the current snapshot before asynchronously clearing the server so a slow cloud request does not leave the list stuck.
      state.isDeletingDevice = true;
      const hiddenLocally = removeDeviceFromLocalSnapshot(deviceId);
      setStatus(
        hiddenLocally ? i18n.t("syncSidebar.deleteDevice.status.localPending") : i18n.t("syncSidebar.deleteDevice.status.deleting"),
        "",
        hiddenLocally ? "syncing" : "deleting",
        0,
      );
      try {
        if (typeof conversationArchive.deleteRemoteDeviceArchive !== "function") {
          throw new Error(i18n.t("common.error.moduleMissingReinject", { module: i18n.t("settings.conversationArchive.label") }));
        }

        // 这一段只发送同步配置和设备 ID，远端清理由 launcher 与云函数完成。
        // Send only sync config and the device ID; the launcher and cloud function perform the remote cleanup.
        const data = await conversationArchive.deleteRemoteDeviceArchive({
          ...readSyncConfig(),
          deviceId,
        });
        syncLocalDeviceDeleteState(data);
        if (data?.deletePending) {
          removeDeviceFromLocalSnapshot(deviceId);
        } else {
          saveConversationArchiveMetadata(data);
          removeDeviceFromLocalSnapshot(deviceId, data?.revision);
          setStatus(i18n.t("syncSidebar.deleteDevice.status.deleted"), "success", "success");
        }
      } catch (error) {
        // 这一段实现用户要求的兜底：远端失败也先隐藏本地快照，刷新后如又出现则说明服务器仍有数据。
        // Implement the requested fallback: hide the local snapshot even if remote deletion fails; refresh can bring it back if the server still has it.
        const isHiddenLocally = removeDeviceFromLocalSnapshot(deviceId) || hiddenLocally;
        const message = isHiddenLocally
          ? i18n.t("syncSidebar.deleteDevice.status.localOnly")
          : error?.message || i18n.t("syncSidebar.deleteDevice.status.failed");
        setStatus(message, "error", "error", 0);
        if (!isHiddenLocally) console.warn("[Codex-Pro] conversation archive device delete failed", error?.message || error);
      } finally {
        state.isDeletingDevice = false;
        render();
      }
    }

    function openDirectoryPanelDevice(device, { pinned = true, refresh = false } = {}) {
      // 这一段统一设备点击固定和悬停预览的打开流程，避免两种模式分叉后选择状态不一致。
      // Share the open flow for device click-pinning and hover-preview so selection state cannot drift between modes.
      const deviceId = String(device?.deviceId || "");
      if (!deviceId) return;
      rememberThreadListScroll();
      clearDevicePanelHoverCloseTimer();

      // 这一段重新打开同一设备时保留上次账号和目录；切换设备时才回到默认选择。
      // Preserve the last profile and directory when reopening the same device; reset only when switching devices.
      const isSamePanelDevice = state.panelDeviceId === deviceId;
      const shouldUnpinDevice = pinned && isHoverDirectoryPanelMode() && state.isDevicePinned && isSamePanelDevice;
      state.isProfileMenuOpen = false;
      state.hoverGroupKey = "";
      state.isGroupPinned = isSamePanelDevice ? state.isGroupPinned : !isHoverThreadPanelMode();
      state.panelDeviceId = deviceId;
      state.panelProfileId = isSamePanelDevice ? state.panelProfileId : getDeviceProfiles(device)[0]?.profileId || "";
      if (!isSamePanelDevice) state.panelGroupKey = "";
      state.isPanelOpen = true;
      state.isDevicePinned = pinned ? !shouldUnpinDevice : false;
      state.activeThreadPath = "";
      ensurePanelSelection(device);
      render();
      if (!state.isDevicePinned) scheduleDevicePanelHoverClose();
      if (refresh) void refreshArchive({ force: false });
    }

    function previewDirectoryPanelDevice(device) {
      // 这一段只在左侧目录悬停模式且未固定时按设备名临时打开目录面板。
      // Temporarily open the directory panel by device name only in hover mode while it is not pinned.
      if (!isHoverDirectoryPanelMode() || state.isDevicePinned) return;
      openDirectoryPanelDevice(device, { pinned: false });
    }

    function renderDeviceList(root) {
      // 这一段渲染左侧“同步”栏目和设备按钮；每行只显示电脑名。
      // Render the left Sync section and device buttons; each row shows only the computer name.
      root.replaceChildren();
      const header = document.createElement("div");
      header.className = "codex-pro-sync-header";
      const heading = document.createElement("div");
      heading.className = "codex-pro-sync-heading";
      heading.textContent = formatSidebarHeading();
      heading.title = state.statusMessage || i18n.t("syncSidebar.heading");
      const syncUnavailableMessage = getSyncUnavailableMessage();
      const refreshButton = document.createElement("button");
      refreshButton.className = "codex-pro-sync-refresh";
      refreshButton.type = "button";
      refreshButton.title = syncUnavailableMessage || i18n.t("syncSidebar.refreshList");
      refreshButton.setAttribute("aria-label", syncUnavailableMessage || i18n.t("syncSidebar.refreshList"));
      refreshButton.disabled = isArchiveSidebarBusy() || isDeviceDeleteLocked() || !hasSyncConfig();
      refreshButton.textContent = isArchiveSidebarBusy() ? "..." : "↻";
      refreshButton.addEventListener("click", () => {
        void refreshArchive({ force: true, uploadFirst: true });
      }, { signal: controller.signal });
      header.append(heading, refreshButton);
      root.append(header);

      const list = document.createElement("div");
      list.className = "codex-pro-sync-device-list";
      if (!hasSyncConfig()) {
        const empty = document.createElement("div");
        empty.className = "codex-pro-sync-empty";
        empty.textContent = syncUnavailableMessage || i18n.t("syncSidebar.empty.configureKey");
        list.append(empty);
      } else if (isArchiveSidebarBusy() && !state.snapshot) {
        const empty = document.createElement("div");
        empty.className = "codex-pro-sync-empty";
        empty.textContent = i18n.t("syncSidebar.empty.refreshing");
        list.append(empty);
      } else {
        const devices = getSortedArchiveDevices(state.snapshot);
        if (devices.length === 0) {
          const empty = document.createElement("div");
          empty.className = "codex-pro-sync-empty";
          empty.textContent = state.lastError || i18n.t("syncSidebar.empty.noDevices");
          list.append(empty);
        }
        for (const device of devices) {
          const button = document.createElement("button");
          button.className = "codex-pro-sync-device-button";
          button.type = "button";
          button.dataset.codexProSyncDeviceId = device.deviceId || "";
          button.setAttribute("aria-selected", String(state.isPanelOpen && state.panelDeviceId === device.deviceId));
          const name = document.createElement("span");
          name.className = "codex-pro-sync-device-name";
          name.textContent = formatArchiveDeviceName(device, state.snapshot);
          button.append(name);
          button.addEventListener("pointerenter", (event) => {
            // 这一段只让鼠标悬停触发左侧目录预览；触摸/笔输入保留点击固定。
            // Preview the left directory panel only for mouse hover; touch/pen input keeps click-to-pin.
            rememberPointerPosition(event);
            if (event.pointerType && event.pointerType !== "mouse") return;
            clearDevicePanelHoverCloseTimer();
            previewDirectoryPanelDevice(device);
          }, { signal: controller.signal });
          button.addEventListener("pointerleave", (event) => {
            // 这一段离开设备名后延迟关闭临时目录面板，给用户移动到目录或右侧列表的时间。
            // Delay closing the temporary directory panel after leaving the device name so the pointer can cross into either popup.
            rememberPointerPosition(event);
            if (event.pointerType && event.pointerType !== "mouse") return;
            scheduleDevicePanelHoverClose();
          }, { signal: controller.signal });
          button.addEventListener("click", () => {
            openDirectoryPanelDevice(device, { pinned: true, refresh: true });
          }, { signal: controller.signal });
          list.append(button);
        }
      }
      root.append(list);
    }

    function renderPanel(panel) {
      // 这一段渲染设备下的账号选择和目录列表；具体会话交给右侧面板显示。
      // Render profile selection and directory groups for a device; the right panel renders concrete sessions.
      const device = getSelectedDevice();
      panel.hidden = !state.isPanelOpen || !device;
      if (panel.hidden) return;
      const { activeGroup, groups, profile, profiles } = ensurePanelSelection(device);
      panel.replaceChildren();
      panel.dataset.codexProSyncDeviceId = device.deviceId || "";
      panel.dataset.codexProSyncDirectoryPanelMode = getConversationArchiveSidebarDirectoryPanelMode();
      panel.dataset.codexProSyncPanelMode = getConversationArchiveSidebarPanelMode();

      const header = document.createElement("div");
      header.className = "codex-pro-sync-panel-header";
      header.addEventListener("pointerdown", (event) => {
        beginPanelDrag(event, panel);
      }, { signal: controller.signal });
      const title = document.createElement("div");
      title.className = "codex-pro-sync-panel-title";
      title.textContent = formatArchiveDeviceName(device, state.snapshot);
      const actions = document.createElement("div");
      actions.className = "codex-pro-sync-panel-actions";
      const deleteButton = document.createElement("button");
      deleteButton.className = "codex-pro-sync-panel-action";
      deleteButton.type = "button";
      deleteButton.disabled = state.isDeletingDevice;
      deleteButton.title = i18n.t("syncSidebar.deleteDevice.title", { name: title.textContent });
      deleteButton.setAttribute("aria-label", i18n.t("syncSidebar.deleteDevice.title", { name: title.textContent }));
      appendTrashIcon(deleteButton);
      deleteButton.addEventListener("click", (event) => {
        event.preventDefault();
        event.stopPropagation();
        void deleteDeviceArchive(device);
      }, { signal: controller.signal });
      actions.append(deleteButton);
      header.append(title, actions);
      panel.append(header);

      renderProfilePicker(panel, device, profile, profiles);

      const list = document.createElement("div");
      list.className = "codex-pro-sync-group-list";
      if (!profile) {
        const empty = document.createElement("div");
        empty.className = "codex-pro-sync-empty";
        empty.textContent = i18n.t("syncSidebar.empty.noProfiles");
        list.append(empty);
      } else if (groups.length === 0) {
        const empty = document.createElement("div");
        empty.className = "codex-pro-sync-empty";
        empty.textContent = i18n.t("syncSidebar.empty.noGroups");
        list.append(empty);
      }
      for (const item of groups) {
        const groupKey = getProfileGroupKey(item);
        const activeGroupKey = activeGroup ? getProfileGroupKey(activeGroup) : "";
        const isActiveGroup = Boolean(activeGroupKey && groupKey === activeGroupKey);
        const isPinnedGroup = state.isGroupPinned && groupKey === state.panelGroupKey;
        const button = document.createElement("button");
        button.className = "codex-pro-sync-group-button";
        button.type = "button";
        button.setAttribute("aria-expanded", String(isActiveGroup));
        button.setAttribute("aria-selected", String(isActiveGroup));
        button.dataset.codexProSyncPinned = String(isHoverThreadPanelMode() && isPinnedGroup);
        button.title = item.archiveGroupDisplayName || item.archiveGroupName || i18n.t("syncSidebar.group.conversations");
        appendGroupIcon(button, item);
        const name = document.createElement("span");
        name.className = "codex-pro-sync-group-name";
        name.textContent = item.archiveGroupDisplayName || item.archiveGroupName || i18n.t("syncSidebar.group.conversations");
        const count = document.createElement("span");
        count.className = "codex-pro-sync-group-count";
        count.textContent = i18n.t("common.count.sessions", { count: Array.isArray(item.threads) ? item.threads.length : 0 });
        button.append(name, count);
        button.addEventListener("pointerenter", (event) => {
          // 这一段只让鼠标悬停触发预览；触摸/笔输入保留点击固定，避免预览重渲染吞掉 click。
          // Preview only for mouse hover; touch/pen input keeps click-to-pin so preview rerenders cannot swallow the click.
          if (event.pointerType && event.pointerType !== "mouse") return;
          previewThreadPanelGroup(groupKey);
        }, { signal: controller.signal });
        button.addEventListener("click", () => {
          rememberThreadListScroll();
          clearThreadPanelHoverCloseTimer();
          const shouldUnpinGroup = isHoverThreadPanelMode() && state.isGroupPinned && state.panelGroupKey === groupKey;
          state.isProfileMenuOpen = false;
          state.panelGroupKey = groupKey;
          state.hoverGroupKey = shouldUnpinGroup ? groupKey : "";
          state.isGroupPinned = !shouldUnpinGroup;
          state.activeThreadPath = "";
          render();
        }, { signal: controller.signal });
        list.append(button);
      }
      panel.append(list);
    }

    function renderThreadPanel(panel) {
      // 这一段渲染当前目录下的实际会话列表；点击会话时才下载对应 Markdown。
      // Render the concrete session list for the selected group; Markdown downloads only after a thread click.
      const device = getSelectedDevice();
      const profile = getSelectedProfile(device);
      const group = getSelectedGroup(profile);
      panel.hidden = !state.isPanelOpen || !device || !profile || !group;
      if (panel.hidden) return;
      const threads = Array.isArray(group.threads) ? group.threads.slice().sort(compareArchiveThreads) : [];
      const statusText = state.statusMessage || i18n.t("syncSidebar.status.idle");
      const currentGroupKey = getSelectedGroupScrollKey(getProfileGroupKey(group));
      const previousGroupKey = panel.dataset.codexProSyncGroupKey || "";
      const currentThreadListScroll = previousGroupKey === currentGroupKey
        ? readThreadListScrollSnapshot(panel)?.value || null
        : null;
      const rememberedThreadListScroll = currentThreadListScroll || state.threadListScrollByGroupKey.get(currentGroupKey) || null;
      panel.replaceChildren();
      panel.dataset.codexProSyncGroupKey = currentGroupKey;

      const header = document.createElement("div");
      header.className = "codex-pro-sync-panel-header";
      const title = document.createElement("div");
      title.className = "codex-pro-sync-panel-title";
      title.textContent = group.archiveGroupDisplayName || group.archiveGroupName || i18n.t("syncSidebar.group.conversations");
      header.append(title);

      const status = document.createElement("div");
      status.className = "codex-pro-sync-status";
      status.dataset.tone = state.statusMessage ? state.statusTone : "idle";
      status.textContent = statusText;

      const list = document.createElement("div");
      list.className = "codex-pro-sync-thread-list";
      if (threads.length === 0) {
        const empty = document.createElement("div");
        empty.className = "codex-pro-sync-empty";
        empty.textContent = i18n.t("syncSidebar.empty.noThreads");
        list.append(empty);
      }
      for (const thread of threads) {
        const button = document.createElement("button");
        button.className = "codex-pro-sync-thread-button";
        button.draggable = true;
        button.type = "button";
        button.dataset.codexProSyncThreadPath = thread.path || "";
        button.setAttribute("aria-selected", String(thread.path === state.activeThreadPath));
        button.title = getArchiveThreadTitle(thread);
        const threadTitle = document.createElement("span");
        threadTitle.className = "codex-pro-sync-thread-title";
        threadTitle.textContent = getArchiveThreadTitle(thread);
        threadTitle.title = getArchiveThreadTitle(thread);
        const meta = document.createElement("span");
        meta.className = "codex-pro-sync-thread-meta";
        const timeText = formatArchiveTime(thread.sourceUpdatedAt || thread.sourceCreatedAt);
        meta.textContent = `${timeText || i18n.t("common.unknownTime")} · ${formatArchiveBytes(thread.markdownBytes)}`;
        button.append(threadTitle, meta);
        button.addEventListener("dragstart", (event) => {
          handleArchiveThreadDragStart(event, thread);
        }, { signal: controller.signal });
        button.addEventListener("dragend", clearArchiveThreadDrag, { signal: controller.signal });
        button.addEventListener("pointerdown", (event) => {
          startArchiveThreadPointerDrag(event, thread);
        }, { signal: controller.signal });
        if (!window.PointerEvent) {
          button.addEventListener("mousedown", (event) => {
            startArchiveThreadPointerDrag(event, thread);
          }, { signal: controller.signal });
        }
        button.addEventListener("click", () => {
          void openArchiveThread(thread);
        }, { signal: controller.signal });
        list.append(button);
      }

      panel.append(header);
      panel.append(status);
      panel.append(list);
      restoreThreadListScroll(list, rememberedThreadListScroll);
    }

    function render() {
      // 这一段统一刷新左侧栏目、弹出框内容和弹出框位置，侧栏缺失时不再强制关闭弹窗。
      // Refresh the left section, popup content, and popup placement; a missing sidebar no longer force-closes the popup.
      if (!hasSyncConfig()) {
        state.isPanelOpen = false;
        state.panelDeviceId = "";
        state.panelProfileId = "";
        state.panelGroupKey = "";
        state.hoverGroupKey = "";
        removeVisibleSyncSidebarDom();
        return;
      }
      const root = ensureRoot();
      const panel = ensurePanel();
      const threadPanel = ensureThreadPanel();
      if (!panel || !threadPanel) return;
      if (root) renderDeviceList(root);
      renderPanel(panel);
      renderThreadPanel(threadPanel);
      applyPanelPosition(root, panel, threadPanel);
      renderProfileMenu();
    }

    async function refreshArchive({ force = false, uploadFirst = false } = {}) {
      // 这一段刷新远端 manifest；手动按钮会先上传本机会话，再读取最新设备和会话标题。
      // Refresh the remote manifest; the manual button uploads local sessions first, then reads latest device and title data.
      if (state.isRefreshing || !hasSyncConfig()) {
        render();
        return;
      }
      if (state.deviceDeletePending && uploadFirst) {
        uploadFirst = false;
        setStatus(i18n.t("syncSidebar.deleteDevice.status.pending"), "", "syncing", 0);
      }
      if (!force && state.snapshot && isArchiveSnapshotCurrent()) {
        render();
        return;
      }
      state.isRefreshing = true;
      state.isManualSyncActive = Boolean(uploadFirst);
      state.uploadProgressFloor = null;
      state.lastError = "";
      render();
      try {
        const config = readSyncConfig();
        if (uploadFirst) {
          // 这一段先复用会话归档模块执行本机增量上传，页面侧仍不读取会话正文。
          // First reuse the archive module for local incremental upload; the page still does not read conversation bodies.
          if (typeof conversationArchive.pushLocalArchive !== "function") {
            throw new Error(i18n.t("common.error.moduleMissingReinject", { module: i18n.t("settings.conversationArchive.label") }));
          }
          setStatus(i18n.t("syncSidebar.status.uploading"), "", "uploading");
          const uploadData = await conversationArchive.pushLocalArchive({
            ...config,
            force: true,
            onProgress: (progress) => {
              // 这一段把手动上传进度显示到左下角，扫描阶段不提前显示上传数量。
              // Show manual upload progress in the lower-left area without showing upload counts during scanning.
              const displayProgress = normalizeManualUploadProgress(progress);
              const progressText = getArchiveUploadProgressStatusText(displayProgress);
              setStatus(progressText || i18n.t("syncSidebar.status.uploading"), "", "uploading", 0, "manual", displayProgress);
            },
          });
          syncLocalDeviceDeleteState(uploadData);
          revealUploadedLocalDeviceFromSnapshot(uploadData);
          const uploadSnapshot = filterLocallyHiddenArchiveSnapshot(uploadData);
          if (!uploadSnapshot?.deviceDeletePending) saveConversationArchiveMetadata(uploadSnapshot);
          state.snapshot = uploadSnapshot;
          setStatus(i18n.t("syncSidebar.status.refreshing"), "", "refreshing");
        }
        // 这一段上传完成后再拉取远端索引，确保列表展示的是服务端最终 manifest。
        // Pull the remote index after upload so the list reflects the server's final manifest.
        const data = await conversationArchive.listArchive(config);
        syncLocalDeviceDeleteState(data);
        const listSnapshot = filterLocallyHiddenArchiveSnapshot(data);
        if (!listSnapshot?.deviceDeletePending) saveConversationArchiveMetadata(listSnapshot);
        state.snapshot = listSnapshot;
        const devices = getSortedArchiveDevices(listSnapshot);
        if (!devices.some((device) => device.deviceId === state.panelDeviceId)) {
          state.panelDeviceId = devices[0]?.deviceId || "";
          state.isPanelOpen = state.isPanelOpen && Boolean(state.panelDeviceId);
        }
        ensurePanelSelection(getSelectedDevice());
        const skippedLocalUpload = Boolean(data?.localDeviceUploadSkippedForPendingDelete || data?.localDeviceUploadBlockedAfterDelete);
        if (data?.deviceDeletePending) {
          setStatus(i18n.t("syncSidebar.deleteDevice.status.pending"), "", "syncing", 0);
        } else {
          setStatus(i18n.t(uploadFirst && !skippedLocalUpload ? "syncSidebar.status.uploadedAndRefreshed" : "syncSidebar.status.refreshed"), "success", "success");
        }
      } catch (error) {
        const errorMessage = error?.message || i18n.t("syncSidebar.status.refreshFailed");
        state.lastError = uploadFirst ? errorMessage : "";
        if (uploadFirst) {
          // 这一段只在手动刷新失败时保留完整错误，后台刷新失败不占用左下角常驻 UI。
          // Keep the full error only for manual refresh failures; background refresh failures should not occupy the lower-left UI.
          setStatus(errorMessage, "error", "error");
        }
        if (errorMessage.includes("启动器不支持")) {
          scheduleRefresh(true);
        }
      } finally {
        const shouldApplyPendingAutoArchiveSnapshot = !state.isManualSyncActive;
        state.isRefreshing = false;
        state.isManualSyncActive = false;
        state.uploadProgressFloor = null;
        if (shouldApplyPendingAutoArchiveSnapshot) {
          applyPendingAutoArchiveSnapshot();
        } else {
          state.pendingAutoArchiveSnapshot = null;
        }
        render();
      }
    }

    function scheduleRefresh(force = false) {
      // 这一段合并设置变化和侧栏重建触发的刷新，避免短时间内重复请求远端索引。
      // Coalesce settings changes and sidebar rebuilds so the remote index is not requested repeatedly.
      window.clearTimeout(state.refreshTimer);
      state.refreshTimer = window.setTimeout(() => {
        state.refreshTimer = 0;
        void refreshArchive({ force });
      }, refreshDelayMs);
    }

    async function runStartupAutoSync() {
      // 这一段启动后先尝试非强制上传本机稳定会话，再用上传返回的快照更新侧栏。
      // On startup, try a non-forced upload of stable local sessions first, then render the returned snapshot.
      if (isArchiveSidebarBusy() || !hasSyncConfig()) {
        render();
        return;
      }
      if (typeof conversationArchive.pushLocalArchive !== "function") {
        scheduleRefresh(true);
        return;
      }
      state.isStartupAutoSyncing = true;
      state.lastError = "";
      setStatus(i18n.t("syncSidebar.status.uploading"), "", "uploading", 0, "auto");
      render();
      try {
        const config = readSyncConfig();
        const uploadData = await conversationArchive.pushLocalArchive({
          ...config,
          force: false,
          onProgress: (progress) => {
            // 这一段只展示非正文的启动上传进度；真正正文仍留在 native bridge 内处理。
            // Show only non-content startup-upload progress; conversation bodies still stay inside the native bridge.
            if (!state.isStartupAutoSyncing || state.isManualSyncActive || state.isRefreshing) return;
            const progressText = getArchiveUploadProgressStatusText(progress);
            setStatus(progressText || i18n.t("syncSidebar.status.uploading"), "", "uploading", 0, "auto", progress);
          },
        });
        const applied = applyAutoArchiveSnapshot(uploadData);
        const skippedLocalUpload = Boolean(
          uploadData?.localDeviceUploadSkippedForPendingDelete ||
          uploadData?.localDeviceUploadBlockedAfterDelete ||
          uploadData?.deviceDeletePending
        );
        if (applied) {
          if (uploadData?.deviceDeletePending) {
            setStatus(i18n.t("syncSidebar.deleteDevice.status.pending"), "", "syncing", 0);
          } else if (skippedLocalUpload) {
            setStatus(i18n.t("syncSidebar.status.refreshed"), "success", "success", 0, "auto");
          } else {
            setStatus(i18n.t("syncSidebar.status.autoUploaded"), "success", "success", 0, "auto");
          }
        }
        if (!applied) scheduleRefresh(true);
      } catch {
        // 这一段启动上传失败时退回远端列表刷新，不把一次后台失败变成常驻错误。
        // Fall back to a remote-list refresh when startup upload fails, without turning one background failure into a sticky error.
        if (state.statusSource === "auto") setStatus();
        scheduleRefresh(true);
      } finally {
        state.isStartupAutoSyncing = false;
        render();
      }
    }

    function scheduleStartupAutoSync(delayMs = refreshDelayMs) {
      // 这一段合并启动和配置变化触发的首次自动上传，避免重复扫描同一批本机会话。
      // Coalesce startup/config-change first uploads so the same local sessions are not scanned repeatedly.
      window.clearTimeout(state.startupAutoSyncTimer);
      state.startupAutoSyncTimer = window.setTimeout(() => {
        state.startupAutoSyncTimer = 0;
        void runStartupAutoSync();
      }, delayMs);
    }

    async function openArchiveThread(thread) {
      // 这一段点击会话后只下载该会话 Markdown，然后交给 Codex 原生右侧文件面板。
      // Download only the clicked thread's Markdown, then hand it to Codex's native right-side file panel.
      if (!thread?.path || !conversationArchive.prepareArchiveFile) {
        setStatus(i18n.t("common.error.moduleMissingReinject", { module: i18n.t("settings.conversationArchive.label") }), "error");
        return;
      }
      state.activeThreadPath = thread.path;
      setStatus(i18n.t("syncSidebar.status.opening"));
      beginThreadPanelWork();
      const openStartedAt = getArchivePerformanceNowMs();
      try {
        const config = readSyncConfig();
        const data = await conversationArchive.prepareArchiveFile({
          ...config,
          path: thread.path,
        });
        const localPath = String(data?.localPath || "");
        if (!localPath) throw new Error(i18n.t("syncSidebar.error.previewFileFailed"));
        const openSidePanelStartedAt = getArchivePerformanceNowMs();
        const opened = await openLocalMarkdownInSidePanel(localPath);
        if (!opened) throw new Error(i18n.t("syncSidebar.error.previewUnavailable"));
        logArchiveOpenPerformance(data, {
          openSidePanelMs: getArchivePerformanceNowMs() - openSidePanelStartedAt,
          totalPageMs: getArchivePerformanceNowMs() - openStartedAt,
        });
        setStatus(i18n.t("syncSidebar.status.opened"), "success");
      } catch (error) {
        setStatus(error?.message || i18n.t("syncSidebar.status.openFailed"), "error");
      } finally {
        endThreadPanelWork();
      }
    }

    async function attachArchiveThreadToComposer(thread) {
      // 这一段把远端归档会话解包成本地 Markdown，再追加为当前输入框附件。
      // Unpack the archived remote thread into a local Markdown file, then append it to the current composer as an attachment.
      const initialAttachmentApi = getArchiveThreadAttachmentApi();
      if (!thread?.path || !conversationArchive.prepareArchiveFile || !initialAttachmentApi) {
        setStatus(i18n.t("syncSidebar.error.attachmentUnavailable"), "error", "error");
        return;
      }
      state.activeThreadPath = thread.path;
      setStatus(i18n.t("syncSidebar.status.attaching"), "", "attaching");
      beginThreadPanelWork();
      try {
        const config = readSyncConfig();
        const data = await conversationArchive.prepareArchiveFile({
          ...config,
          path: thread.path,
        });
        const localPath = String(data?.localPath || "");
        if (!localPath) throw new Error(i18n.t("syncSidebar.error.previewFileFailed"));

        // 这一段在异步下载后重新读取附件入口，避免用户期间关闭“文件拖入聊天”设置。
        // Re-read the attachment entrypoint after async download in case the user disabled file dragging meanwhile.
        const attachmentApi = getArchiveThreadAttachmentApi();
        if (!attachmentApi) throw new Error(i18n.t("syncSidebar.error.attachmentUnavailable"));
        const attachment = typeof attachmentApi.createLocalFileAttachment === "function"
          ? attachmentApi.createLocalFileAttachment(localPath, getArchiveThreadTitle(thread))
          : { fsPath: localPath, label: getArchiveThreadTitle(thread), path: localPath };
        if (!attachmentApi.addLocalFileAttachment(attachment)) {
          throw new Error(i18n.t("syncSidebar.error.attachmentUnavailable"));
        }
        setStatus(i18n.t("syncSidebar.status.attached"), "success", "success");
      } catch (error) {
        setStatus(error?.message || i18n.t("syncSidebar.status.attachFailed"), "error", "error");
      } finally {
        endThreadPanelWork();
      }
    }

    function handleConversationArchivePreviewLinkClick(event) {
      // 这一段只处理鼠标左键点击的 thinking 附件链接，保留其它链接的 Codex 原生行为。
      // Handle only left-clicks on thinking attachment links, preserving Codex native behavior for every other link.
      if (event.button !== 0) return;
      const match = getConversationArchiveThinkingLinkFromEvent(event);
      if (!match) return;
      stopConversationArchiveThinkingLinkEvent(event);
      void openConversationArchiveThinkingLink(match.localPath);
    }

    function handleConversationArchivePreviewLinkKeydown(event) {
      // 这一段补齐键盘可访问性；Enter 和 Space 与鼠标点击使用同一条受限打开路径。
      // Preserve keyboard accessibility; Enter and Space use the same constrained open path as mouse clicks.
      if (event.key !== "Enter" && event.key !== " ") return;
      const match = getConversationArchiveThinkingLinkFromEvent(event);
      if (!match) return;
      stopConversationArchiveThinkingLinkEvent(event);
      void openConversationArchiveThinkingLink(match.localPath);
    }

    function applyAutoArchiveSnapshot(snapshot) {
      // 这一段复用自动上传返回的列表快照，避免上传成功后再额外拉一次远端 manifest。
      // Reuse the list snapshot returned by auto upload so success does not need an extra remote manifest pull.
      if (!snapshot || typeof snapshot !== "object" || !Array.isArray(snapshot.devices)) return false;
      syncLocalDeviceDeleteState(snapshot);
      revealUploadedLocalDeviceFromSnapshot(snapshot);
      const nextSnapshot = filterLocallyHiddenArchiveSnapshot(snapshot);
      rememberThreadListScroll();
      if (!nextSnapshot?.deviceDeletePending) saveConversationArchiveMetadata(nextSnapshot);
      state.snapshot = nextSnapshot;
      const devices = getSortedArchiveDevices(nextSnapshot);
      if (!devices.some((device) => device.deviceId === state.panelDeviceId)) {
        state.panelDeviceId = devices[0]?.deviceId || "";
        state.isPanelOpen = state.isPanelOpen && Boolean(state.panelDeviceId);
      }
      ensurePanelSelection(getSelectedDevice());
      render();
      return true;
    }

    function rememberPendingAutoArchiveSnapshot(snapshot) {
      // 这一段在侧栏刷新期间暂存自动上传结果，避免慢速空列表覆盖真实上传快照。
      // Store auto-upload results while the sidebar is refreshing so a slow empty list cannot hide the uploaded snapshot.
      if (!snapshot || typeof snapshot !== "object" || !Array.isArray(snapshot.devices)) return false;
      state.pendingAutoArchiveSnapshot = snapshot;
      return true;
    }

    function applyPendingAutoArchiveSnapshot() {
      // 这一段只应用不比当前刷新结果旧的自动上传快照，避免把远端重置或删除后的旧设备画回去。
      // Apply only auto-upload snapshots that are not older than the current refresh result, so remote resets or deletes are not redrawn.
      const snapshot = state.pendingAutoArchiveSnapshot;
      state.pendingAutoArchiveSnapshot = null;
      if (!snapshot || typeof snapshot !== "object" || !Array.isArray(snapshot.devices)) return false;
      const currentRevision = getArchiveRevision(state.snapshot?.revision);
      const pendingRevision = getArchiveRevision(snapshot.revision);
      if (currentRevision && (!pendingRevision || pendingRevision < currentRevision)) return false;
      return applyAutoArchiveSnapshot(snapshot);
    }

    function handleConversationArchiveStatusEvent(event) {
      // 这一段接收后台自动归档状态，让左下角标题在非手动点击时也能提示当前同步状态。
      // Receive background auto-archive status so the lower-left heading reflects sync state even without manual clicks.
      const detail = event?.detail && typeof event.detail === "object" ? event.detail : {};
      if (detail.source !== "auto") return;
      const message = String(detail.message || "").trim();
      const tone = String(detail.tone || "").trim();
      const kind = String(detail.kind || "").trim();
      const progress = detail.progress && typeof detail.progress === "object" ? detail.progress : null;
      if (!message || !kind) return;
      if (state.isManualSyncActive) return;
      if (state.isRefreshing) {
        if (kind === "success") rememberPendingAutoArchiveSnapshot(detail.snapshot);
        return;
      }
      if (kind === "error") {
        // 这一段只清掉后台自动同步自己留下的状态，避免覆盖手动刷新失败。
        // Clear only the background auto-sync status itself so manual refresh failures stay visible.
        if (state.statusSource === "auto") setStatus();
        return;
      }
      if (kind === "success") {
        applyAutoArchiveSnapshot(detail.snapshot);
        if (state.deviceDeletePending || state.localDeviceUploadBlockedAfterDelete) return;
      }
      if ((state.deviceDeletePending || state.localDeviceUploadBlockedAfterDelete) && kind === "uploading") return;
      if (state.statusSource && state.statusSource !== "auto") return;
      const progressText = kind === "uploading" ? getArchiveUploadProgressStatusText(progress) : "";
      setStatus(progressText || message, tone, kind, undefined, "auto", progress);
    }

    const observer = new MutationObserver((mutations) => {
      // 这一段只在左侧栏附近结构变化时重挂载，避免聊天内容变化触发频繁渲染。
      // Remount only for structural changes near the left sidebar, avoiding frequent chat-content renders.
      if (mutations.some(mutationTouchesNativeSidebar)) {
        render();
      }
    });
    observer.observe(document.body, {
      attributeFilter: ["aria-hidden", "class", "hidden", "style"],
      attributes: true,
      childList: true,
      subtree: true,
    });

    const unsubscribe = settingsApi.subscribe((nextSettings) => {
      // 这一段在同步配置变化后清空旧快照并重新拉取，避免显示上一套密钥的数据。
      // Clear stale snapshots and refresh when sync config changes so data from another key is not shown.
      const previous = state.latestSettings || {};
      state.latestSettings = nextSettings;
      const configChanged =
        previous.cloudSyncKey !== nextSettings.cloudSyncKey ||
        previous.conversationArchiveEndpoint !== nextSettings.conversationArchiveEndpoint;
      const revisionChanged = getArchiveRevision(previous.conversationArchiveRevision) !== getArchiveRevision(nextSettings.conversationArchiveRevision);
      const directoryPanelModeChanged =
        previous.conversationArchiveSidebarDirectoryPanelMode !== nextSettings.conversationArchiveSidebarDirectoryPanelMode;
      const panelModeChanged = previous.conversationArchiveSidebarPanelMode !== nextSettings.conversationArchiveSidebarPanelMode;
      if (configChanged) {
        state.snapshot = null;
        state.locallyHiddenDeviceIds.clear();
        state.panelDeviceId = "";
        state.panelProfileId = "";
        state.panelGroupKey = "";
        state.hoverGroupKey = "";
        state.pendingAutoArchiveSnapshot = null;
        state.isDevicePinned = !isHoverDirectoryPanelMode();
        state.isGroupPinned = !isHoverThreadPanelMode();
        state.isPanelOpen = false;
        state.deviceDeletePending = false;
        state.localDeviceDeletePending = false;
        state.localDeviceUploadBlockedAfterDelete = false;
        window.clearTimeout(state.pendingDeleteRefreshTimer);
        state.pendingDeleteRefreshTimer = 0;
        state.activeThreadPath = "";
        clearThreadListScrollMemory();
        window.clearTimeout(state.startupAutoSyncTimer);
        state.startupAutoSyncTimer = 0;
        scheduleStartupAutoSync();
      } else if (revisionChanged && !state.isSavingArchiveMetadata) {
        state.activeThreadPath = "";
        scheduleRefresh(true);
      }
      if (directoryPanelModeChanged) {
        // 这一段切换左侧目录显示方式时清掉临时 hover 状态，避免新模式继承旧面板。
        // Clear temporary hover state when the left directory display mode changes so the new mode does not inherit the old panel.
        rememberThreadListScroll();
        clearDevicePanelHoverCloseTimer();
        state.isDevicePinned = !isHoverDirectoryPanelMode();
        if (!state.isDevicePinned) scheduleDevicePanelHoverClose();
      }
      if (panelModeChanged) {
        // 这一段切换显示方式时清掉临时 hover 状态，避免新模式继承旧模式的悬停面板。
        // Clear temporary hover state when the display mode changes so the new mode does not inherit the old flyout.
        rememberThreadListScroll();
        clearThreadPanelHoverCloseTimer();
        state.hoverGroupKey = "";
        state.isGroupPinned = !isHoverThreadPanelMode();
        state.activeThreadPath = "";
      }
      render();
    }, controller.signal);

    window.addEventListener("resize", render, { signal: controller.signal });
    document.addEventListener("click", handleConversationArchivePreviewLinkClick, { capture: true, signal: controller.signal });
    document.addEventListener("keydown", handleConversationArchivePreviewLinkKeydown, { capture: true, signal: controller.signal });
    document.addEventListener("dragover", handleArchiveThreadDragOver, { capture: true, signal: controller.signal });
    document.addEventListener("drop", handleArchiveThreadDrop, { capture: true, signal: controller.signal });
    document.addEventListener("dragend", clearArchiveThreadDrag, { capture: true, signal: controller.signal });
    document.addEventListener("dragcancel", clearArchiveThreadDrag, { capture: true, signal: controller.signal });
    document.addEventListener("pointermove", updateArchiveThreadPointerDrag, { capture: true, signal: controller.signal });
    document.addEventListener("pointerup", finishArchiveThreadPointerDrag, { capture: true, signal: controller.signal });
    document.addEventListener("pointercancel", handleArchiveThreadPointerCancel, { capture: true, signal: controller.signal });
    if (!window.PointerEvent) {
      document.addEventListener("mousemove", updateArchiveThreadPointerDrag, { capture: true, signal: controller.signal });
      document.addEventListener("mouseup", finishArchiveThreadPointerDrag, { capture: true, signal: controller.signal });
    }
    window.addEventListener(conversationArchiveStatusEventName, handleConversationArchiveStatusEvent, { signal: controller.signal });
    if (runtime.systemModules.settingsMenu?.cloudSync?.syncLicenseStatusEventName) {
      window.addEventListener(runtime.systemModules.settingsMenu.cloudSync.syncLicenseStatusEventName, render, { signal: controller.signal });
    }
    window.addEventListener("blur", clearArchiveThreadDrag, { signal: controller.signal });
    document.addEventListener("click", closePanelFromOutside, { capture: true, signal: controller.signal });
    const remoteListRefreshIntervalId = window.setInterval(() => {
      // 这一段低频强制拉取远端列表，用来发现其它电脑同步上来的会话。
      // Force-pull the remote list at a low frequency to discover sessions synced from other machines.
      void refreshArchive({ force: true });
    }, remoteListRefreshIntervalMs);
    render();
    scheduleStartupAutoSync();

    controller.signal.addEventListener("abort", () => {
      // 这一段停止观察、清掉计时器并移除 UI，避免关闭功能后仍有请求或浮层。
      // Stop observers, clear timers, and remove UI so disabling the feature leaves no requests or panels.
      observer.disconnect();
      unsubscribe?.();
      window.clearInterval(remoteListRefreshIntervalId);
      window.clearTimeout(state.pendingDeleteRefreshTimer);
      window.clearTimeout(state.refreshTimer);
      window.clearTimeout(state.startupAutoSyncTimer);
      window.clearTimeout(state.statusTimer);
      window.clearTimeout(state.devicePanelCloseTimer);
      window.clearTimeout(state.threadPanelCloseTimer);
      state.dragAbortController?.abort();
      removeDom();
    }, { once: true });
  }, { enableSetting: "enableConversationArchiveSidebar" });
})();
