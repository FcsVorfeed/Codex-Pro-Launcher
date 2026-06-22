(() => {
  const runtime = window.__codexProRuntime;
  if (!runtime) return;
  const settingsMenu = runtime.systemModules.settingsMenu ??= {};
  const i18n = runtime.i18n;

  const rootId = "codex-pro-settings-root";
  const styleId = "codex-pro-settings-style";
  const triggerHostId = "codex-pro-settings-trigger-host";
  const updateTooltipId = "codex-pro-settings-update-tooltip";
  const dialogSizeStorageKey = "codex-pro-settings-dialog-size";
  const dialogSizeDefaults = Object.freeze({ width: 700, height: 640 });
  const dialogSizeMinimums = Object.freeze({ width: 560, height: 420 });
  const dialogCompactSizeMinimums = Object.freeze({ width: 320, height: 420 });
  const dialogViewportPadding = Object.freeze({ width: 48, height: 64 });
  const dialogCompactViewportPadding = Object.freeze({ width: 24, height: 32 });
  const dialogCompactViewportMaxWidth = 680;
  const nativeMenuEntryAttribute = "data-codex-pro-native-settings-entry";
  const nativeMenuEntrySelector = `[${nativeMenuEntryAttribute}]`;
  let updateTooltipState = Object.freeze({ latestVersion: "", updateAvailable: false });

  function getSettingsTrigger() {
    // 这一段统一查找当前设置入口，兼容顶部栏挂载和固定定位兜底两种模式。
    // Find the current settings trigger across both top-bar docking and fixed-position fallback modes.
    return document.getElementById(triggerHostId)?.querySelector(".codex-pro-settings-trigger")
      || document.getElementById(rootId)?.querySelector(".codex-pro-settings-trigger")
      || null;
  }

  function setUpdateCheckState(state = {}) {
    // 这一段只负责把更新状态渲染成设置入口角标，不承担联网检查或版本比较。
    // Render update state as a settings-entry badge only; network checks and version comparison live elsewhere.
    const trigger = getSettingsTrigger();
    const updateAvailable = state?.updateAvailable === true;
    const latestVersion = typeof state?.latestVersion === "string" ? state.latestVersion.trim() : "";
    updateTooltipState = Object.freeze({ latestVersion, updateAvailable });
    const title = updateAvailable
      ? i18n.t("settings.updateCheck.triggerAvailable", { version: latestVersion })
      : i18n.t("settings.shell.trigger");
    if (trigger) {
      trigger.dataset.codexProUpdateAvailable = String(updateAvailable);
      trigger.setAttribute("aria-label", title);
      if (updateAvailable) {
        trigger.removeAttribute("title");
      } else {
        trigger.setAttribute("title", title);
      }
    }
    const updateSectionButton = document.querySelector(`[data-codex-pro-settings-section-button="update-check"]`);
    if (updateSectionButton) {
      updateSectionButton.dataset.codexProUpdateAvailable = String(updateAvailable);
    }
    if (!updateAvailable) removeUpdateTooltip();
  }

  function getUpdateTooltipText() {
    // 这一段生成右上角更新提示浮层文案，版本号来自受控更新检查状态。
    // Build the top-right update tooltip copy from the controlled update-check state.
    if (!updateTooltipState.updateAvailable) return "";
    return i18n.t("settings.updateCheck.hoverAvailable", {
      version: updateTooltipState.latestVersion || i18n.t("settings.updateCheck.versionUnknown"),
    });
  }

  function removeUpdateTooltip() {
    // 这一段移除自定义提示浮层，避免原生 title 和自绘 tooltip 同时残留。
    // Remove the custom tooltip so native title and custom tooltip never linger together.
    document.getElementById(updateTooltipId)?.remove();
  }

  function ensureUpdateTooltip() {
    // 这一段创建一次性 tooltip DOM，跟随鼠标定位，不进入设置弹窗布局流。
    // Create a tooltip DOM node positioned by the mouse without entering the settings dialog layout.
    let tooltip = document.getElementById(updateTooltipId);
    if (!tooltip) {
      tooltip = document.createElement("div");
      tooltip.id = updateTooltipId;
      tooltip.className = "codex-pro-settings-update-tooltip";
      tooltip.setAttribute("role", "tooltip");
      document.body.append(tooltip);
    }
    return tooltip;
  }

  function positionUpdateTooltip(tooltip, clientX, clientY) {
    // 这一段优先把 tooltip 放到鼠标左侧，左侧空间不足时再翻到右侧。
    // Prefer placing the tooltip to the left of the mouse, flipping right only when needed.
    const margin = 8;
    const offset = 12;
    const rect = tooltip.getBoundingClientRect();
    let left = clientX - rect.width - offset;
    let top = clientY + offset;
    if (left < margin) {
      left = clientX + offset;
    }
    if (left + rect.width + margin > window.innerWidth) {
      left = window.innerWidth - rect.width - margin;
    }
    if (top + rect.height + margin > window.innerHeight) {
      top = clientY - rect.height - offset;
    }
    tooltip.style.left = `${Math.max(margin, left)}px`;
    tooltip.style.top = `${Math.max(margin, top)}px`;
  }

  function showUpdateTooltip(event, trigger) {
    // 这一段只在确实有更新时显示提示，普通设置按钮 hover 不显示额外浮层。
    // Show the tooltip only when an update is available; normal settings hover stays quiet.
    const text = getUpdateTooltipText();
    if (!text) {
      removeUpdateTooltip();
      return;
    }
    const tooltip = ensureUpdateTooltip();
    tooltip.textContent = text;
    const rect = trigger.getBoundingClientRect();
    positionUpdateTooltip(
      tooltip,
      Number.isFinite(event?.clientX) ? event.clientX : rect.right,
      Number.isFinite(event?.clientY) ? event.clientY : rect.bottom,
    );
  }

  function bindUpdateTooltip(trigger, signal) {
    // 这一段绑定右上角更新提示浮层生命周期，随设置菜单重建自动清理。
    // Bind the top-right update tooltip lifecycle so it is cleaned up with settings menu rebuilds.
    if (!trigger) return;
    trigger.addEventListener("mouseenter", (event) => showUpdateTooltip(event, trigger), { signal });
    trigger.addEventListener("mousemove", (event) => {
      const tooltip = document.getElementById(updateTooltipId);
      if (!tooltip) return;
      positionUpdateTooltip(tooltip, event.clientX, event.clientY);
    }, { signal });
    trigger.addEventListener("mouseleave", removeUpdateTooltip, { signal });
    trigger.addEventListener("focus", (event) => showUpdateTooltip(event, trigger), { signal });
    trigger.addEventListener("blur", removeUpdateTooltip, { signal });
    trigger.addEventListener("click", removeUpdateTooltip, { signal });
    signal?.addEventListener("abort", removeUpdateTooltip, { once: true });
  }

  function getElementRect(element) {
    // 这一段统一读取 DOM 矩形，调用方只在元素存在时进入。
    // Read a DOMRect consistently; callers only pass existing elements.
    return element.getBoundingClientRect();
  }

  function isTopBarCandidate(element) {
    // 这一段用结构和几何特征识别官方顶部栏，不依赖“文件/编辑”等多语言文案。
    // Identify the native top bar by structure and geometry without relying on localized menu text.
    const rect = getElementRect(element);
    if (rect.width < window.innerWidth * 0.75) return false;
    if (Math.abs(rect.top) > 2 || rect.height < 28 || rect.height > 48) return false;

    // 这一段要求候选本身是横向拖拽区，避免误挂到普通内容工具栏。
    // Require the candidate itself to be a horizontal drag region so regular content toolbars are excluded.
    const style = getComputedStyle(element);
    return (
      style.display.includes("flex") &&
      style.alignItems === "center" &&
      style.webkitAppRegion === "drag"
    );
  }

  function findTopBarContainer() {
    // 这一段从顶部附近的小候选集合里挑出官方标题栏容器，失败时交给固定定位兜底。
    // Pick the official title-bar container from a small top-of-window candidate set, falling back when absent.
    const candidates = Array.from(document.body?.querySelectorAll("div") || [])
      .filter((element) => {
        const rect = getElementRect(element);
        return rect.width > 0 && rect.height > 0 && rect.top <= 8 && rect.bottom >= 24;
      })
      .filter(isTopBarCandidate)
      .sort((left, right) => {
        const leftRect = getElementRect(left);
        const rightRect = getElementRect(right);
        return leftRect.top - rightRect.top || rightRect.width - leftRect.width;
      });
    return candidates[0] || null;
  }

  function mountSettingsTrigger(root, trigger) {
    // 这一段优先把入口挂进官方顶部栏，让垂直居中跟随原生布局。
    // Prefer docking the trigger into the official top bar so vertical centering follows native layout.
    const topBar = findTopBarContainer();
    if (topBar) {
      let host = document.getElementById(triggerHostId);
      if (!host) {
        host = document.createElement("span");
        host.id = triggerHostId;
      }
      if (host.parentElement !== topBar) topBar.append(host);
      if (trigger.parentElement !== host) host.replaceChildren(trigger);
      root.dataset.codexProSettingsTriggerDocked = "true";
      return;
    }

    // 这一段在官方顶部栏不可用时退回旧固定入口，保证设置仍然可打开。
    // Fall back to the old fixed entry when the official top bar is unavailable so settings remain reachable.
    document.getElementById(triggerHostId)?.remove();
    if (trigger.parentElement !== root) root.prepend(trigger);
    root.dataset.codexProSettingsTriggerDocked = "false";
  }

  function getRegisteredSections() {
    // 这一段读取分区注册表并按 order 排序，后续简单分区不再写死在 view.js。
    // Read the section registry and sort by order so simple sections no longer stay hard-coded in view.js.
    const sections = Array.isArray(settingsMenu.sections) ? settingsMenu.sections : [];
    return sections
      .filter((section) => section && typeof section.id === "string" && typeof section.render === "function")
      .slice()
      .sort((left, right) => {
        const leftOrder = Number.isFinite(left.order) ? left.order : 0;
        const rightOrder = Number.isFinite(right.order) ? right.order : 0;
        return leftOrder - rightOrder || left.id.localeCompare(right.id);
      });
  }

  function getRegisteredSection(sectionId) {
    // 这一段按 id 查找已注册分区，缺失时返回 null 让渲染层安全跳过。
    // Find a registered section by id and return null when missing so rendering can skip safely.
    return getRegisteredSections().find((section) => section.id === sectionId) || null;
  }

  function renderRegisteredSectionButton(section) {
    // 这一段渲染已注册分区的左侧导航按钮，图标和文案由分区模块声明。
    // Render the left navigation button for a registered section, with icon and copy declared by the section module.
    if (!section) return "";
    const label = section.labelKey ? i18n.html(section.labelKey) : i18n.escapeHtml(section.label || section.id);
    return `
      <button class="codex-pro-settings-section-button" type="button" role="tab" aria-selected="false" data-codex-pro-settings-section-button="${section.id}">
        ${section.icon || ""}
        <span>${label}</span>
      </button>
    `;
  }

  function renderRegisteredSectionPanel(sectionId, settings, options = {}) {
    // 这一段渲染已注册分区的右侧面板，保持主视图只负责统一外壳。
    // Render the right panel for a registered section so the main view owns only the shared shell.
    const section = getRegisteredSection(sectionId);
    if (!section) return "";
    const hiddenAttribute = options.hidden === false ? "" : " hidden";
    const title = section.titleKey ? i18n.html(section.titleKey) : i18n.escapeHtml(section.title || section.label || section.id);
    const note = section.noteKey ? i18n.html(section.noteKey) : i18n.escapeHtml(section.note || "");
    return `
      <section class="codex-pro-settings-panel" data-codex-pro-settings-section="${section.id}" role="tabpanel"${hiddenAttribute}>
        <h3 class="codex-pro-settings-panel-title">${title}</h3>
        <p class="codex-pro-settings-panel-note">${note}</p>
        ${section.render(settings)}
      </section>
    `;
  }

  function getSectionToSettingKeys() {
    // 这一段从注册分区收集设置键，用于左侧蓝色修改标记。
    // Collect setting keys from registered sections for the left-side modified markers.
    const mapping = {};
    for (const section of getRegisteredSections()) {
      const markerKeys = Array.isArray(section.modifiedSettingKeys) ? section.modifiedSettingKeys : section.settingKeys;
      mapping[section.id] = Array.isArray(markerKeys) ? markerKeys.slice() : [];
    }
    return mapping;
  }

  function getDialogSizeBounds() {
    // 这一段根据当前视口计算弹窗尺寸上下限，避免保存尺寸把窗口撑出屏幕。
    // Compute dialog size limits from the current viewport so saved sizes cannot push it off-screen.
    const isCompactViewport = window.innerWidth <= dialogCompactViewportMaxWidth;
    const minimums = isCompactViewport ? dialogCompactSizeMinimums : dialogSizeMinimums;
    const padding = isCompactViewport ? dialogCompactViewportPadding : dialogViewportPadding;
    const maxWidth = Math.max(minimums.width, window.innerWidth - padding.width);
    const maxHeight = Math.max(minimums.height, window.innerHeight - padding.height);
    return {
      minWidth: Math.min(minimums.width, maxWidth),
      minHeight: Math.min(minimums.height, maxHeight),
      maxWidth,
      maxHeight,
    };
  }

  function clampDialogSize(size) {
    // 这一段把外部传入或拖拽产生的尺寸钳制到当前视口可用范围内。
    // Clamp external or drag-produced sizes into the currently usable viewport range.
    const bounds = getDialogSizeBounds();
    const width = Number(size?.width);
    const height = Number(size?.height);
    return {
      width: Math.round(Math.min(Math.max(Number.isFinite(width) ? width : dialogSizeDefaults.width, bounds.minWidth), bounds.maxWidth)),
      height: Math.round(Math.min(Math.max(Number.isFinite(height) ? height : dialogSizeDefaults.height, bounds.minHeight), bounds.maxHeight)),
    };
  }

  function readStoredDialogSize() {
    // 这一段安全读取本机保存的弹窗宽高，存储不可用或数据损坏时回退默认样式。
    // Safely read the locally saved dialog size and fall back to default styling when storage is unavailable or invalid.
    try {
      const rawSize = window.localStorage?.getItem(dialogSizeStorageKey);
      if (!rawSize) return null;
      const parsedSize = JSON.parse(rawSize);
      const width = Number(parsedSize?.width);
      const height = Number(parsedSize?.height);
      if (!Number.isFinite(width) || !Number.isFinite(height)) return null;
      return clampDialogSize({ width, height });
    } catch {
      return null;
    }
  }

  function writeStoredDialogSize(size) {
    // 这一段只保存经过钳制的宽高，避免坏数据影响下次打开。
    // Save only clamped dimensions so invalid data cannot affect the next open.
    try {
      const nextSize = clampDialogSize(size);
      window.localStorage?.setItem(dialogSizeStorageKey, JSON.stringify(nextSize));
    } catch {
      // 这一段忽略本机存储失败，缩放本身仍应继续工作。
      // Ignore local storage failures so resizing itself can keep working.
    }
  }

  function install(settings) {
    // 这一段安装设置菜单样式，弹窗保持居中并尽量贴近 Codex 原生面板质感。
    // Install settings menu styles, keeping the dialog centered and close to Codex's native panel feel.
    runtime.dom.upsertStyle(
      styleId,
      `
        #${rootId} {
          position: fixed;
          top: 6px;
          right: 146px;
          width: 28px;
          height: 28px;
          z-index: 2147483600;
          color: var(--color-token-foreground, CanvasText);
          font: 13px/1.45 system-ui, -apple-system, BlinkMacSystemFont, "Segoe UI", sans-serif;
          pointer-events: none;
          -webkit-app-region: no-drag;
        }
        #${triggerHostId} {
          position: relative;
          z-index: 2147483600;
          flex: 0 0 28px;
          width: 28px;
          height: 100%;
          margin-left: auto;
          display: inline-flex;
          align-items: center;
          justify-content: center;
          color: var(--color-token-foreground, CanvasText);
          font: 13px/1.45 system-ui, -apple-system, BlinkMacSystemFont, "Segoe UI", sans-serif;
          pointer-events: auto;
          -webkit-app-region: no-drag;
        }
        #${rootId} .codex-pro-settings-trigger {
          position: absolute;
          inset: 0;
        }
        #${triggerHostId} .codex-pro-settings-trigger {
          position: relative;
          inset: auto;
          flex: 0 0 28px;
        }
        #${rootId} .codex-pro-settings-trigger,
        #${triggerHostId} .codex-pro-settings-trigger {
          width: 28px;
          height: 28px;
          border: 0;
          border-radius: 6px;
          background: transparent;
          color: var(--color-token-description-foreground, color-mix(in srgb, CanvasText 68%, transparent));
          display: grid;
          place-items: center;
          padding: 0;
          pointer-events: auto;
        }
        #${rootId} .codex-pro-settings-trigger:hover,
        #${rootId} .codex-pro-settings-trigger:focus-visible,
        #${triggerHostId} .codex-pro-settings-trigger:hover,
        #${triggerHostId} .codex-pro-settings-trigger:focus-visible {
          background: color-mix(in srgb, var(--color-token-foreground, CanvasText) 10%, transparent);
          color: var(--color-token-foreground, CanvasText);
          outline: none;
        }
        #${rootId} .codex-pro-settings-trigger svg,
        #${triggerHostId} .codex-pro-settings-trigger svg {
          width: 16px;
          height: 16px;
          display: block;
        }
        #${rootId} .codex-pro-settings-trigger[data-codex-pro-update-available="true"]::after,
        #${triggerHostId} .codex-pro-settings-trigger[data-codex-pro-update-available="true"]::after {
          position: absolute;
          top: 5px;
          right: 5px;
          width: 5px;
          height: 5px;
          box-sizing: border-box;
          border-radius: 50%;
          background: rgba(150, 150, 150, .78);
          content: "";
          pointer-events: none;
        }
        .codex-pro-settings-update-tooltip {
          position: fixed;
          z-index: 2147483647;
          max-width: min(260px, calc(100vw - 16px));
          box-sizing: border-box;
          padding: 6px 8px;
          border: 1px solid var(--color-token-border, rgba(255, 255, 255, .12));
          border-radius: 6px;
          background: var(--color-token-dropdown-background, rgba(36, 36, 36, .98));
          color: var(--color-token-foreground, rgba(245, 245, 245, .92));
          font: 12px/1.35 system-ui, -apple-system, BlinkMacSystemFont, "Segoe UI", sans-serif;
          white-space: nowrap;
          pointer-events: none;
          box-shadow: 0 8px 24px rgba(0, 0, 0, .26);
        }
        #${rootId} .codex-pro-settings-backdrop {
          position: fixed;
          inset: 0;
          display: none;
          background: rgba(0, 0, 0, .32);
          pointer-events: auto;
        }
        #${rootId}.codex-pro-settings-open .codex-pro-settings-backdrop {
          display: block;
        }
        #${rootId} .codex-pro-settings-dialog {
          position: fixed;
          top: 50%;
          left: 50%;
          width: min(700px, calc(100vw - 48px));
          height: min(640px, calc(100vh - 64px));
          min-width: min(560px, calc(100vw - 48px));
          min-height: min(420px, calc(100vh - 64px));
          max-width: calc(100vw - 48px);
          max-height: calc(100vh - 64px);
          box-sizing: border-box;
          display: none;
          overflow: hidden;
          transform: translate(-50%, -50%);
          border: 1px solid var(--color-token-border, rgba(255, 255, 255, .10));
          border-radius: 18px;
          background: var(--color-token-dropdown-background, rgba(45, 45, 45, .98));
          box-shadow: 0 24px 72px rgba(0, 0, 0, .36);
          pointer-events: auto;
          backdrop-filter: blur(18px);
        }
        #${rootId}.codex-pro-settings-open .codex-pro-settings-dialog {
          display: grid;
        }
        #${rootId} .codex-pro-settings-resize-handle {
          position: absolute;
          right: 4px;
          bottom: 4px;
          z-index: 2;
          width: 18px;
          height: 18px;
          border-radius: 4px;
          cursor: nwse-resize;
          pointer-events: auto;
          touch-action: none;
        }
        #${rootId} .codex-pro-settings-form {
          min-height: 0;
          height: 100%;
          display: grid;
          grid-template-columns: 216px minmax(0, 1fr);
        }
        #${rootId} .codex-pro-settings-sidebar {
          min-height: 0;
          overflow-y: auto;
          padding: 16px 12px;
          border-right: 1px solid var(--color-token-border, rgba(255, 255, 255, .08));
        }
        #${rootId} .codex-pro-settings-title {
          margin: 0 0 12px;
          padding: 0 6px;
          color: var(--color-token-description-foreground, rgba(245, 245, 245, .58));
          font-size: 13px;
          font-weight: 650;
        }
        #${rootId} .codex-pro-settings-section-button {
          position: relative;
          width: 100%;
          min-height: 34px;
          display: flex;
          align-items: center;
          gap: 9px;
          border: 0;
          border-radius: 8px;
          background: transparent;
          color: var(--color-token-description-foreground, rgba(245, 245, 245, .70));
          font: inherit;
          font-weight: 600;
          text-align: left;
          padding: 0 8px;
        }
        #${rootId} .codex-pro-settings-section-button:hover,
        #${rootId} .codex-pro-settings-section-button:focus-visible {
          background: color-mix(in srgb, var(--color-token-foreground, CanvasText) 9%, transparent);
          color: var(--color-token-foreground, CanvasText);
          outline: none;
        }
        #${rootId} .codex-pro-settings-section-button[aria-selected="true"] {
          background: color-mix(in srgb, var(--color-token-foreground, CanvasText) 12%, transparent);
          color: var(--color-token-foreground, CanvasText);
        }
        #${rootId} .codex-pro-settings-section-button[data-codex-pro-section-modified="true"]::after {
          position: absolute;
          right: 8px;
          width: 6px;
          height: 6px;
          border-radius: 999px;
          background: #0e9eea;
          content: "";
        }
        #${rootId} .codex-pro-settings-section-button[data-codex-pro-update-available="true"]::before {
          position: absolute;
          right: 10px;
          width: 7px;
          height: 7px;
          box-sizing: border-box;
          border-radius: 50%;
          background: #47c7ff;
          box-shadow:
            0 0 0 2px color-mix(in srgb, var(--color-token-dropdown-background, rgba(45, 45, 45, .98)) 92%, transparent),
            0 0 10px color-mix(in srgb, #47c7ff 45%, transparent);
          content: "";
          pointer-events: none;
        }
        #${rootId} .codex-pro-settings-section-button > span {
          min-width: 0;
          overflow: hidden;
          text-overflow: ellipsis;
          white-space: nowrap;
        }
        #${rootId} .codex-pro-settings-section-icon {
          width: 16px;
          height: 16px;
          flex: 0 0 auto;
          color: currentColor;
        }
        #${rootId} [data-codex-pro-update-status][data-codex-pro-update-status-kind="available"] {
          color: #47c7ff;
          font-weight: 650;
        }
        #${rootId} [data-codex-pro-update-status][data-codex-pro-update-status-kind="checking"] {
          color: color-mix(in srgb, #47c7ff 78%, var(--color-token-foreground, CanvasText));
        }
        #${rootId} [data-codex-pro-update-status][data-codex-pro-update-status-kind="failed"],
        #${rootId} [data-codex-pro-update-status][data-codex-pro-update-status-kind="unsupported"] {
          color: #f28b82;
        }
        #${rootId} .codex-pro-settings-content {
          min-width: 0;
          min-height: 0;
          height: 100%;
          display: grid;
          grid-template-rows: minmax(0, 1fr) auto;
        }
        #${rootId} .codex-pro-settings-panels {
          min-height: 0;
          overflow-y: auto;
          padding: 18px 18px 8px;
        }
        #${rootId} .codex-pro-settings-panel {
          min-height: 0;
        }
        #${rootId} .codex-pro-settings-panel[hidden] {
          display: none;
        }
        #${rootId} .codex-pro-settings-panel-title {
          margin: 0;
          color: var(--color-token-foreground, CanvasText);
          font-size: 15px;
          font-weight: 700;
        }
        #${rootId} .codex-pro-settings-panel-note {
          margin: 4px 0 16px;
          color: var(--color-token-description-foreground, rgba(245, 245, 245, .58));
          font-size: 12px;
        }
        #${rootId} .codex-pro-settings-field {
          position: relative;
          display: grid;
          grid-template-columns: minmax(0, 1fr) auto;
          gap: 12px;
          align-items: center;
          min-height: 42px;
          margin: 0;
          padding: 10px 0;
          border-top: 1px solid var(--color-token-border, rgba(255, 255, 255, .08));
        }
        #${rootId} .codex-pro-settings-field:first-of-type {
          border-top: 0;
        }
        #${rootId} .codex-pro-settings-field::before {
          position: absolute;
          left: -10px;
          top: 12px;
          bottom: 12px;
          width: 2px;
          border-radius: 999px;
          background: transparent;
          content: "";
        }
        #${rootId} .codex-pro-settings-field[data-codex-pro-modified="true"]::before {
          background: #0e9eea;
        }
        #${rootId} .codex-pro-settings-field[data-codex-pro-disabled="true"] {
          cursor: not-allowed;
        }
        #${rootId} .codex-pro-settings-field[data-codex-pro-disabled="true"] .codex-pro-settings-copy,
        #${rootId} .codex-pro-settings-field[data-codex-pro-disabled="true"] .codex-pro-settings-unit {
          opacity: .48;
        }
        #${rootId} .codex-pro-settings-copy {
          min-width: 0;
          display: grid;
          gap: 3px;
        }
        #${rootId} .codex-pro-settings-label {
          color: var(--color-token-foreground, CanvasText);
          font-weight: 600;
        }
        #${rootId} .codex-pro-settings-help {
          color: var(--color-token-description-foreground, rgba(245, 245, 245, .58));
          font-size: 12px;
        }
        #${rootId} .codex-pro-settings-number-row {
          display: grid;
          grid-template-columns: minmax(72px, 88px) auto;
          gap: 8px;
          align-items: center;
        }
        #${rootId} .codex-pro-settings-shortcut-row {
          display: grid;
          grid-template-columns: minmax(132px, 160px) 30px;
          gap: 8px;
          align-items: center;
        }
        #${rootId} .codex-pro-settings-key-row {
          display: grid;
          grid-template-columns: minmax(180px, 1fr) auto;
          gap: 8px;
          align-items: center;
        }
        #${rootId} .codex-pro-settings-key-row[data-codex-pro-cloud-sync-key-row] {
          grid-template-columns: minmax(180px, 1fr) auto auto;
        }
        #${rootId} .codex-pro-settings-command-row {
          display: flex;
          flex-wrap: wrap;
          justify-content: flex-start;
          gap: 8px;
        }
        #${rootId} .codex-pro-settings-status {
          min-height: 18px;
          color: var(--color-token-description-foreground, rgba(245, 245, 245, .58));
          font-size: 12px;
          overflow-wrap: anywhere;
        }
        #${rootId} .codex-pro-settings-status[data-codex-pro-cloud-sync-tone="error"] {
          color: color-mix(in srgb, #ff5f57 82%, var(--color-token-foreground, CanvasText));
        }
        #${rootId} .codex-pro-settings-status[data-codex-pro-cloud-sync-tone="success"] {
          color: color-mix(in srgb, #2ecc71 82%, var(--color-token-foreground, CanvasText));
        }
        #${rootId} .codex-pro-cloud-sync-feature-list {
          display: grid;
          gap: 12px;
          margin-top: 14px;
        }
        #${rootId} .codex-pro-cloud-sync-feature-block {
          display: grid;
          gap: 10px;
          border: 1px solid var(--color-token-border, rgba(255, 255, 255, .10));
          border-radius: 8px;
          background: color-mix(in srgb, var(--color-token-foreground, CanvasText) 4%, transparent);
          padding: 12px;
        }
        #${rootId} .codex-pro-cloud-sync-feature-block[data-codex-pro-cloud-sync-gate-disabled="true"] {
          background: color-mix(in srgb, var(--color-token-foreground, CanvasText) 2%, transparent);
        }
        #${rootId} .codex-pro-cloud-sync-feature-block[data-codex-pro-cloud-sync-gate-disabled="true"] .codex-pro-cloud-sync-feature-body {
          opacity: .58;
        }
        #${rootId} .codex-pro-cloud-sync-feature-heading {
          display: grid;
          gap: 3px;
          min-width: 0;
        }
        #${rootId} .codex-pro-cloud-sync-feature-title {
          color: var(--color-token-foreground, CanvasText);
          font-size: 13px;
          font-weight: 700;
        }
        #${rootId} .codex-pro-cloud-sync-feature-note {
          color: var(--color-token-description-foreground, rgba(245, 245, 245, .58));
          font-size: 12px;
          line-height: 1.45;
        }
        #${rootId} .codex-pro-cloud-sync-feature-body {
          display: grid;
          gap: 8px;
        }
        #${rootId} .codex-pro-cloud-sync-feature-body > .codex-pro-settings-field {
          border-top: 1px solid var(--color-token-border, rgba(255, 255, 255, .08));
          padding-top: 10px;
        }
        #${rootId} .codex-pro-cloud-sync-feature-body > .codex-pro-settings-field:first-child {
          border-top: 0;
          padding-top: 0;
        }
        #${rootId} .codex-pro-archive-browser {
          display: grid;
          grid-template-columns: minmax(132px, .72fr) minmax(0, 1.28fr);
          gap: 12px;
          min-height: 260px;
          border-top: 1px solid var(--color-token-border, rgba(255, 255, 255, .08));
          padding-top: 12px;
        }
        #${rootId} .codex-pro-archive-groups,
        #${rootId} .codex-pro-archive-main {
          min-width: 0;
          min-height: 0;
        }
        #${rootId} .codex-pro-archive-list {
          display: grid;
          gap: 6px;
          max-height: 228px;
          overflow: auto;
          padding-right: 2px;
        }
        #${rootId} .codex-pro-archive-profile-button,
        #${rootId} .codex-pro-archive-thread-button {
          width: 100%;
          min-width: 0;
          border: 1px solid var(--color-token-border, rgba(255, 255, 255, .10));
          border-radius: 8px;
          background: color-mix(in srgb, var(--color-token-foreground, CanvasText) 4%, transparent);
          color: var(--color-token-foreground, CanvasText);
          display: grid;
          gap: 2px;
          padding: 8px;
          text-align: left;
        }
        #${rootId} .codex-pro-archive-profile-button[aria-selected="true"],
        #${rootId} .codex-pro-archive-thread-button[aria-selected="true"] {
          border-color: color-mix(in srgb, #0e9eea 58%, var(--color-token-border, rgba(255, 255, 255, .12)));
          background: color-mix(in srgb, #0e9eea 14%, transparent);
        }
        #${rootId} .codex-pro-archive-profile-title,
        #${rootId} .codex-pro-archive-thread-title {
          min-width: 0;
          overflow: hidden;
          text-overflow: ellipsis;
          white-space: nowrap;
          font-size: 12px;
          font-weight: 650;
        }
        #${rootId} .codex-pro-archive-profile-meta,
        #${rootId} .codex-pro-archive-thread-meta,
        #${rootId} .codex-pro-archive-empty {
          color: var(--color-token-description-foreground, rgba(245, 245, 245, .58));
          font-size: 11px;
        }
        #${rootId} .codex-pro-archive-preview {
          min-height: 160px;
          max-height: 260px;
          overflow: auto;
          margin: 10px 0 0;
          border: 1px solid var(--color-token-border, rgba(255, 255, 255, .10));
          border-radius: 8px;
          background: rgba(0, 0, 0, .16);
          color: var(--color-token-foreground, CanvasText);
          font: 12px/1.55 ui-monospace, SFMono-Regular, Consolas, "Liberation Mono", monospace;
          padding: 10px;
          white-space: pre-wrap;
          overflow-wrap: anywhere;
        }
        #${rootId} .codex-pro-settings-input {
          min-width: 0;
          height: 30px;
          border: 1px solid var(--color-token-border, rgba(255, 255, 255, .12));
          border-radius: 8px;
          background: var(--color-token-input-background, rgba(255, 255, 255, .04));
          color: var(--color-token-foreground, CanvasText);
          font: inherit;
          padding: 0 9px;
        }
        #${rootId} .codex-pro-settings-select {
          min-width: 156px;
          height: 30px;
          border: 1px solid var(--color-token-border, rgba(255, 255, 255, .12));
          border-radius: 8px;
          background: var(--color-token-input-background, rgba(255, 255, 255, .04));
          color: var(--color-token-foreground, CanvasText);
          font: inherit;
          padding: 0 8px;
        }
        #${rootId} .codex-pro-settings-shortcut-input {
          cursor: default;
          font: 12px/1.45 ui-monospace, SFMono-Regular, Consolas, "Liberation Mono", monospace;
          text-align: center;
        }
        #${rootId} .codex-pro-settings-path-input {
          font: 12px/1.45 ui-monospace, SFMono-Regular, Consolas, "Liberation Mono", monospace;
        }
        #${rootId} .codex-pro-pet-status-sound-row {
          display: grid;
          grid-template-columns: minmax(120px, 1fr) 64px 30px;
          gap: 8px;
          align-items: center;
          min-width: 0;
        }
        #${rootId} .codex-pro-pet-status-volume-input {
          width: 100%;
          padding: 0 6px;
          text-align: center;
        }
        #${rootId} .codex-pro-pet-status-volume-field {
          position: relative;
          display: block;
          min-width: 0;
        }
        #${rootId} .codex-pro-pet-status-volume-field::before {
          position: absolute;
          left: -5px;
          top: 6px;
          bottom: 6px;
          width: 2px;
          border-radius: 999px;
          background: transparent;
          content: "";
        }
        #${rootId} .codex-pro-pet-status-volume-field[data-codex-pro-modified="true"]::before {
          background: #0e9eea;
        }
        #${rootId} .codex-pro-settings-icon-action {
          width: 30px;
          height: 30px;
          display: grid;
          place-items: center;
          border: 1px solid var(--color-token-border, rgba(255, 255, 255, .12));
          border-radius: 8px;
          background: transparent;
          color: var(--color-token-description-foreground, rgba(245, 245, 245, .72));
          padding: 0;
        }
        #${rootId} .codex-pro-settings-icon-action:hover,
        #${rootId} .codex-pro-settings-icon-action:focus-visible {
          background: color-mix(in srgb, var(--color-token-foreground, CanvasText) 9%, transparent);
          color: var(--color-token-foreground, CanvasText);
          outline: none;
        }
        #${rootId} .codex-pro-settings-icon-action svg {
          width: 15px;
          height: 15px;
        }
        #${rootId} .codex-pro-settings-textarea {
          min-width: 0;
          min-height: 86px;
          resize: vertical;
          border: 1px solid var(--color-token-border, rgba(255, 255, 255, .12));
          border-radius: 8px;
          background: var(--color-token-input-background, rgba(255, 255, 255, .04));
          color: var(--color-token-foreground, CanvasText);
          font: 12px/1.45 ui-monospace, SFMono-Regular, Consolas, "Liberation Mono", monospace;
          padding: 8px 9px;
        }
        #${rootId} .codex-pro-settings-input:focus,
        #${rootId} .codex-pro-settings-select:focus {
          border-color: color-mix(in srgb, Highlight 70%, var(--color-token-border, transparent));
          outline: none;
        }
        #${rootId} .codex-pro-settings-textarea:focus {
          border-color: color-mix(in srgb, Highlight 70%, var(--color-token-border, transparent));
          outline: none;
        }
        #${rootId} .codex-pro-settings-input:disabled,
        #${rootId} .codex-pro-settings-select:disabled,
        #${rootId} .codex-pro-settings-textarea:disabled,
        #${rootId} .codex-pro-settings-icon-action:disabled,
        #${rootId} .codex-pro-settings-action:disabled {
          cursor: not-allowed;
          opacity: .45;
        }
        #${rootId} .codex-pro-settings-field-stack {
          grid-template-columns: 1fr;
          align-items: stretch;
        }
        #${rootId} [data-codex-pro-settings-section="file-tree"] {
          height: 100%;
          display: flex;
          flex-direction: column;
          overflow: hidden;
        }
        #${rootId} [data-codex-pro-settings-section="file-tree"][hidden] {
          display: none;
        }
        #${rootId} [data-codex-pro-settings-section="file-tree"] .codex-pro-settings-field-stack {
          flex: 1 1 auto;
          grid-template-rows: auto minmax(0, 1fr);
          min-height: 0;
          overflow: hidden;
        }
        #${rootId} [data-codex-pro-settings-section="file-tree"] .codex-pro-settings-textarea {
          height: 100%;
          min-height: 0;
          overflow: auto;
          resize: none;
        }
        #${rootId} .codex-pro-settings-unit {
          color: var(--color-token-description-foreground, rgba(245, 245, 245, .58));
          font-size: 12px;
        }
        #${rootId} .codex-pro-settings-switch {
          position: relative;
          width: 34px;
          height: 20px;
          flex: 0 0 auto;
        }
        #${rootId} .codex-pro-settings-switch input {
          position: absolute;
          opacity: 0;
          inset: 0;
        }
        #${rootId} .codex-pro-settings-switch-track {
          position: absolute;
          inset: 0;
          border-radius: 999px;
          background: color-mix(in srgb, var(--color-token-foreground, CanvasText) 16%, transparent);
          transition: background 140ms ease;
        }
        #${rootId} .codex-pro-settings-switch-track::after {
          position: absolute;
          top: 3px;
          left: 3px;
          width: 14px;
          height: 14px;
          border-radius: 999px;
          background: var(--color-token-foreground, CanvasText);
          content: "";
          transition: transform 140ms ease;
        }
        #${rootId} .codex-pro-settings-switch input:checked + .codex-pro-settings-switch-track {
          background: color-mix(in srgb, Highlight 82%, transparent);
        }
        #${rootId} .codex-pro-settings-switch input:checked + .codex-pro-settings-switch-track::after {
          transform: translateX(14px);
          background: HighlightText;
        }
        #${rootId} .codex-pro-settings-switch input:disabled + .codex-pro-settings-switch-track {
          background: color-mix(in srgb, var(--color-token-foreground, CanvasText) 12%, transparent);
          cursor: not-allowed;
        }
        #${rootId} .codex-pro-settings-switch input:disabled + .codex-pro-settings-switch-track::after {
          background: color-mix(in srgb, var(--color-token-foreground, CanvasText) 72%, transparent);
        }
        #${rootId} .codex-pro-settings-switch input:focus-visible + .codex-pro-settings-switch-track {
          outline: 2px solid color-mix(in srgb, Highlight 70%, transparent);
          outline-offset: 2px;
        }
        #${rootId} .codex-pro-settings-actions {
          display: flex;
          justify-content: flex-end;
          gap: 8px;
          padding: 12px 34px 16px 18px;
          border-top: 1px solid var(--color-token-border, rgba(255, 255, 255, .08));
        }
        #${rootId} .codex-pro-settings-action {
          height: 30px;
          border: 1px solid var(--color-token-border, rgba(255, 255, 255, .12));
          border-radius: 8px;
          background: transparent;
          color: var(--color-token-foreground, CanvasText);
          font: inherit;
          padding: 0 12px;
        }
        #${rootId} .codex-pro-settings-action:hover {
          background: color-mix(in srgb, var(--color-token-foreground, CanvasText) 9%, transparent);
        }
        #${rootId} .codex-pro-settings-action-primary {
          border-color: color-mix(in srgb, Highlight 70%, transparent);
          background: Highlight;
          color: HighlightText;
        }
        #${rootId} .codex-pro-settings-action-primary:hover {
          background: color-mix(in srgb, Highlight 88%, CanvasText);
        }
        @media (max-width: 680px) {
          #${rootId} .codex-pro-settings-form {
            grid-template-columns: 1fr;
            grid-template-rows: auto minmax(0, 1fr);
          }
          #${rootId} .codex-pro-settings-dialog {
            min-width: min(320px, calc(100vw - 24px));
            min-height: min(420px, calc(100vh - 32px));
            max-width: calc(100vw - 24px);
            max-height: calc(100vh - 32px);
          }
          #${rootId} .codex-pro-settings-sidebar {
            min-height: 0;
            max-height: 168px;
            border-right: 0;
            border-bottom: 1px solid var(--color-token-border, rgba(255, 255, 255, .08));
          }
          #${rootId} .codex-pro-settings-section-list {
            display: grid;
            grid-template-columns: repeat(auto-fit, minmax(92px, 1fr));
            gap: 6px;
          }
          #${rootId} .codex-pro-archive-browser {
            grid-template-columns: 1fr;
          }
          #${rootId} .codex-pro-archive-list {
            max-height: 184px;
          }
        }
      `,
    );

    // 这一段创建或复用设置根节点，重复注入时会用最新两栏结构覆盖旧结构。
    // Create or reuse the settings root and replace stale markup with the latest two-column layout.
    const root = runtime.dom.ensureRoot(rootId);
    root.innerHTML = `
      <button class="codex-pro-settings-trigger" type="button" aria-label="${i18n.attr("settings.shell.trigger")}" title="${i18n.attr("settings.shell.trigger")}">
        <svg viewBox="0 0 24 24" aria-hidden="true" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round">
          <path d="M12 15.5a3.5 3.5 0 1 0 0-7 3.5 3.5 0 0 0 0 7Z"></path>
          <path d="M19.4 15a1.7 1.7 0 0 0 .34 1.88l.05.05a2 2 0 1 1-2.83 2.83l-.05-.05A1.7 1.7 0 0 0 15 19.38a1.7 1.7 0 0 0-1 .62 1.7 1.7 0 0 0-.4 1.1V21a2 2 0 1 1-4 0v-.08A1.7 1.7 0 0 0 8.6 19.4a1.7 1.7 0 0 0-1.88.34l-.05.05a2 2 0 1 1-2.83-2.83l.05-.05A1.7 1.7 0 0 0 4.62 15a1.7 1.7 0 0 0-.62-1 1.7 1.7 0 0 0-1.1-.4H3a2 2 0 1 1 0-4h-.08A1.7 1.7 0 0 0 4.6 8.6a1.7 1.7 0 0 0-.34-1.88l-.05-.05a2 2 0 1 1 2.83-2.83l.05.05A1.7 1.7 0 0 0 9 4.62a1.7 1.7 0 0 0 1-.62 1.7 1.7 0 0 0 .4-1.1V3a2 2 0 1 1 4 0v.08A1.7 1.7 0 0 0 15.4 4.6a1.7 1.7 0 0 0 1.88-.34l.05-.05A2 2 0 1 1 20.16 6l-.05.05A1.7 1.7 0 0 0 19.38 9c.11.37.32.72.62 1 .3.28.68.43 1.1.4H21a2 2 0 1 1 0 4h-.08A1.7 1.7 0 0 0 19.4 15Z"></path>
        </svg>
      </button>
      <div class="codex-pro-settings-backdrop" data-codex-pro-settings-close></div>
      <section class="codex-pro-settings-dialog" role="dialog" aria-modal="true" aria-labelledby="codex-pro-settings-title">
        <form class="codex-pro-settings-form" data-codex-pro-settings-form>
          <aside class="codex-pro-settings-sidebar">
            <h2 class="codex-pro-settings-title" id="codex-pro-settings-title">${i18n.html("settings.shell.title")}</h2>
            <nav class="codex-pro-settings-section-list" aria-label="${i18n.attr("settings.shell.nav")}">
              ${getRegisteredSections().map(renderRegisteredSectionButton).join("")}
            </nav>
          </aside>
          <div class="codex-pro-settings-content">
            <div class="codex-pro-settings-panels">
              ${getRegisteredSections().map((section, index) => renderRegisteredSectionPanel(section.id, settings, { hidden: index !== 0 })).join("")}
            </div>
            <div class="codex-pro-settings-actions">
              <button class="codex-pro-settings-action" type="button" data-codex-pro-settings-close>${i18n.html("settings.shell.cancel")}</button>
              <button class="codex-pro-settings-action codex-pro-settings-action-primary" type="submit">${i18n.html("settings.shell.save")}</button>
            </div>
          </div>
        </form>
        <span class="codex-pro-settings-resize-handle" aria-hidden="true" data-codex-pro-settings-resize-handle></span>
      </section>
    `;
    const trigger = root.querySelector(".codex-pro-settings-trigger");
    if (trigger) mountSettingsTrigger(root, trigger);
    setUpdateCheckState(runtime.systemModules.updateCheck?.getState?.());

    return root;
  }

  function uninstall() {
    // 这一段移除右上角入口、弹窗和旧版本可能残留的左下角入口。
    // Remove the top-right entry, dialog, and any legacy lower-left entry left by older injections.
    document.getElementById(rootId)?.remove();
    document.getElementById(styleId)?.remove();
    document.getElementById(triggerHostId)?.remove();
    removeUpdateTooltip();
    for (const entry of document.querySelectorAll(nativeMenuEntrySelector)) {
      entry.remove();
    }
  }

  function bind(root, settings, signal) {
    // 这一段缓存弹窗外壳节点；具体分区节点由各自 section bind(context) 管理。
    // Cache only shell nodes here; each section owns its own nodes through bind(context).
    const formBinding = settingsMenu.formBinding;
    const trigger = root.querySelector(".codex-pro-settings-trigger") || document.getElementById(triggerHostId)?.querySelector(".codex-pro-settings-trigger");
    const dialog = root.querySelector(".codex-pro-settings-dialog");
    const dialogResizeHandle = root.querySelector("[data-codex-pro-settings-resize-handle]");
    const form = root.querySelector("[data-codex-pro-settings-form]");
    const sectionButtons = Array.from(root.querySelectorAll("[data-codex-pro-settings-section-button]"));
    const panels = Array.from(root.querySelectorAll("[data-codex-pro-settings-section]"));
    if (!trigger || !dialog || !dialogResizeHandle || !form || !formBinding) return;

    // 这一段默认打开第一个可用分区，硬屏蔽系统后仍能落到实际存在的面板。
    // Default to the first available section so hard-disabled systems still land on a real panel.
    let activeSection = sectionButtons[0]?.getAttribute("data-codex-pro-settings-section-button") || "";
    const draftSettingsReaders = [];
    const settingsWriters = [];
    const modifiedStateRenderers = [];
    const dialogOpenHandlers = [];
    const afterSaveHandlers = [];

    function addDraftSettingsReader(reader) {
      // 这一段登记复杂分区自己的草稿补充字段，例如同步 revision 或鼠标手势快捷键。
      // Register complex-section draft additions such as sync revisions or mouse gesture shortcuts.
      if (typeof reader === "function") draftSettingsReaders.push(reader);
    }

    function addSettingsWriter(writer) {
      // 这一段登记复杂分区写回逻辑，普通 DOM 字段仍由 form-binding 统一处理。
      // Register complex-section writeback logic while common DOM fields stay in form-binding.
      if (typeof writer === "function") settingsWriters.push(writer);
    }

    function addModifiedStateRenderer(renderer) {
      // 这一段登记分区级禁用态渲染，避免 shell 了解具体分区控件。
      // Register section-level disabled-state rendering so the shell does not know individual controls.
      if (typeof renderer === "function") modifiedStateRenderers.push(renderer);
    }

    function addDialogOpenHandler(handler) {
      // 这一段登记打开弹窗后的分区刷新动作，例如会话归档列表恢复为空态。
      // Register section refresh work that should run after the dialog opens, such as archive empty-state rendering.
      if (typeof handler === "function") dialogOpenHandlers.push(handler);
    }

    function registerAfterSaveHandler(handler) {
      // 这一段登记保存后的副作用，例如云端设置自动上传。
      // Register after-save side effects such as automatic cloud settings upload.
      if (typeof handler === "function") afterSaveHandlers.push(handler);
    }

    function setDialogSize(size) {
      // 这一段把目标尺寸写入弹窗内联样式，并复用统一钳制规则。
      // Apply the target size to the dialog inline style while reusing shared clamping rules.
      const nextSize = clampDialogSize(size);
      dialog.style.width = `${nextSize.width}px`;
      dialog.style.height = `${nextSize.height}px`;
      return nextSize;
    }

    function applyDialogSizePreference() {
      // 这一段在打开弹窗前恢复用户上次保存的尺寸；没有记录时交回 CSS 默认尺寸。
      // Restore the user's last saved size before opening the dialog; without a record, return to CSS defaults.
      const storedSize = readStoredDialogSize();
      if (!storedSize) {
        dialog.style.removeProperty("width");
        dialog.style.removeProperty("height");
        return;
      }
      setDialogSize(storedSize);
    }

    function clampOpenDialogToViewport() {
      // 这一段在窗口尺寸变化时只修正当前弹窗，避免已保存尺寸把弹窗留在屏幕外。
      // Correct only the currently open dialog on viewport changes so saved preferences cannot leave it off-screen.
      if (!root.classList.contains("codex-pro-settings-open")) return;
      const rect = dialog.getBoundingClientRect();
      setDialogSize({ width: rect.width, height: rect.height });
    }

    function startDialogResize(event) {
      // 这一段只响应主按钮拖拽，避免右键或辅助按钮误触发缩放。
      // Respond only to primary-button drags so secondary or auxiliary buttons cannot resize accidentally.
      if (event.pointerType === "mouse" && event.button !== 0) return;
      event.preventDefault();
      event.stopPropagation();

      // 这一段记录拖拽起点；弹窗保持居中，所以宽高变化要按指针位移的两倍计算。
      // Record the drag origin; because the dialog stays centered, size changes use twice the pointer delta.
      const startRect = dialog.getBoundingClientRect();
      const startX = event.clientX;
      const startY = event.clientY;
      let latestSize = { width: startRect.width, height: startRect.height };

      function handlePointerMove(moveEvent) {
        // 这一段跟随指针实时更新弹窗尺寸，并由 setDialogSize 保证不会超过屏幕。
        // Follow the pointer to update the dialog size in real time while setDialogSize keeps it within the screen.
        moveEvent.preventDefault();
        latestSize = setDialogSize({
          width: startRect.width + ((moveEvent.clientX - startX) * 2),
          height: startRect.height + ((moveEvent.clientY - startY) * 2),
        });
      }

      function finishPointerResize() {
        // 这一段清理本次拖拽监听，并把最终尺寸保存到本机。
        // Clean up listeners for this drag and persist the final size locally.
        window.removeEventListener("pointermove", handlePointerMove);
        window.removeEventListener("pointerup", finishPointerResize);
        window.removeEventListener("pointercancel", finishPointerResize);
        try {
          dialogResizeHandle.releasePointerCapture?.(event.pointerId);
        } catch {
          // 这一段忽略指针捕获释放失败，避免缩放结束影响设置页其它交互。
          // Ignore pointer-capture release failures so resize completion cannot affect other settings interactions.
        }
        writeStoredDialogSize(latestSize);
      }

      try {
        dialogResizeHandle.setPointerCapture?.(event.pointerId);
      } catch {
        // 这一段忽略指针捕获设置失败，窗口级监听仍能完成本次拖拽。
        // Ignore pointer-capture setup failures because window-level listeners can still finish this drag.
      }
      window.addEventListener("pointermove", handlePointerMove, { signal });
      window.addEventListener("pointerup", finishPointerResize, { once: true, signal });
      window.addEventListener("pointercancel", finishPointerResize, { once: true, signal });
    }

    function readDraftSettings() {
      // 这一段读取普通表单字段后合并复杂分区自己的草稿字段。
      // Read common form fields first, then merge draft values supplied by complex sections.
      const draftSettings = formBinding.readDraftSettings({ form, settings });
      for (const reader of draftSettingsReaders) {
        Object.assign(draftSettings, reader(draftSettings) || {});
      }
      return draftSettings;
    }

    function writeSettingsToForm(currentSettings) {
      // 这一段写回普通表单字段后通知复杂分区同步自己的本地状态。
      // Write common form fields first, then let complex sections sync their local state.
      formBinding.writeSettingsToForm({ form, settings, currentSettings });
      for (const writer of settingsWriters) {
        writer(currentSettings);
      }
    }

    function getFirstAvailableSection() {
      // 这一段从当前实际渲染的导航项里选择第一个分区，硬屏蔽系统后仍能打开有效面板。
      // Pick the first actually rendered navigation section so hard-disabled systems still leave a usable panel.
      return sectionButtons[0]?.getAttribute("data-codex-pro-settings-section-button") || "";
    }

    function getAvailableSection(section) {
      // 这一段把已失效的 activeSection 回退到当前可用分区，避免默认分区被硬屏蔽后打开空面板。
      // Fall back from a stale activeSection to an available section so a disabled default section cannot open a blank panel.
      const requestedSection = String(section || "");
      return sectionButtons.some((button) => button.getAttribute("data-codex-pro-settings-section-button") === requestedSection)
        ? requestedSection
        : getFirstAvailableSection();
    }

    function setActiveSection(section) {
      // 这一段切换左侧功能项和右侧设置页，后续新增功能只需要注册 section。
      // Switch the left feature item and right settings panel; future features only register sections.
      activeSection = getAvailableSection(section);
      for (const button of sectionButtons) {
        const isActive = button.getAttribute("data-codex-pro-settings-section-button") === activeSection;
        button.setAttribute("aria-selected", String(isActive));
      }
      for (const panel of panels) {
        const isActive = panel.getAttribute("data-codex-pro-settings-section") === activeSection;
        panel.hidden = !isActive;
      }
    }

    function renderModifiedState() {
      // 这一段根据当前表单草稿值渲染每个设置项和左侧功能项的修改标记。
      // Render modified markers for both individual settings and their left-side feature sections.
      const modifiedState = settings.getDraftModifiedState(readDraftSettings());
      const sectionToSettingKeys = getSectionToSettingKeys();
      for (const field of root.querySelectorAll("[data-codex-pro-setting-key]")) {
        const key = field.getAttribute("data-codex-pro-setting-key");
        field.dataset.codexProModified = String(Boolean(modifiedState[key]));
      }
      for (const button of sectionButtons) {
        const section = button.getAttribute("data-codex-pro-settings-section-button");
        const isModified = sectionToSettingKeys[section]?.some((key) => modifiedState[key]) || false;
        button.dataset.codexProSectionModified = String(isModified);
      }
      formBinding.applyFieldDependencyState({ form });
      for (const renderer of modifiedStateRenderers) {
        renderer(modifiedState);
      }
    }

    function saveAndRefreshSettings() {
      // 这一段保存当前草稿并立即写回规范化值，供保存按钮和各 section 命令共用。
      // Save the current draft and write normalized values back immediately for both the save button and section commands.
      const savedSettings = settings.saveSettings(readDraftSettings());
      writeSettingsToForm(savedSettings);
      renderModifiedState();
      return savedSettings;
    }

    function openDialog() {
      // 这一段每次打开时重新读取配置，保证弹窗展示最新保存值。
      // Read settings on every open so the dialog always shows the latest saved value.
      const currentSettings = settings.getSettings();
      writeSettingsToForm(currentSettings);
      setActiveSection(activeSection);
      renderModifiedState();
      for (const handler of dialogOpenHandlers) {
        handler(currentSettings);
      }
      applyDialogSizePreference();
      root.classList.add("codex-pro-settings-open");
      root.querySelector(`[data-codex-pro-settings-section="${activeSection}"] input, [data-codex-pro-settings-section="${activeSection}"] textarea`)?.focus();
    }

    function closeDialog() {
      // 这一段只关闭弹窗，不改动已经保存的设置。
      // Close only the dialog without changing saved settings.
      root.classList.remove("codex-pro-settings-open");
    }

    function saveDialog() {
      // 这一段保存当前弹窗设置，并把保存后的副作用交回注册分区处理。
      // Save current dialog settings and hand after-save side effects back to registered sections.
      const savedSettings = saveAndRefreshSettings();
      for (const handler of afterSaveHandlers) {
        try {
          handler(savedSettings);
        } catch (error) {
          console.warn("[Codex-Pro] settings-menu after-save handler failed", error);
        }
      }
      closeDialog();
    }

    function scheduleTriggerRemount() {
      // 这一段在官方标题栏重建后合并重挂载，避免 MutationObserver 高频回调直接扫 DOM。
      // Coalesce remount work after native top-bar rebuilds so the MutationObserver does not scan on every mutation.
      if (scheduleTriggerRemount.frame) return;
      scheduleTriggerRemount.frame = requestAnimationFrame(() => {
        scheduleTriggerRemount.frame = 0;
        mountSettingsTrigger(root, trigger);
      });
    }
    scheduleTriggerRemount.frame = 0;

    const context = {
      addDialogOpenHandler,
      addDraftSettingsReader,
      addModifiedStateRenderer,
      addSettingsWriter,
      form,
      readDraftSettings,
      registerAfterSaveHandler,
      renderModifiedState,
      root,
      runtime,
      saveAndRefreshSettings,
      settings,
      signal,
      writeSettingsToForm,
    };
    for (const section of getRegisteredSections()) {
      try {
        section.bind?.(context);
      } catch (error) {
        console.warn("[Codex-Pro] settings section bind failed", section.id, error);
      }
    }

    // 这一段绑定功能导航、右上角入口按钮、关闭按钮和表单提交，生命周期交给系统控制器。
    // Bind feature navigation, top-right trigger, close buttons, and form submit under the system controller lifecycle.
    const triggerMountObserver = new MutationObserver(() => {
      // 这一段只在已挂载入口真的丢失时重扫，避免固定坐标兜底模式下每次 DOM 变化都读取布局。
      // Rescan only when the mounted entry is actually lost, avoiding layout reads on every DOM change in fallback mode.
      const isDocked = root.dataset.codexProSettingsTriggerDocked === "true";
      const host = document.getElementById(triggerHostId);
      if (!document.contains(trigger) || (isDocked && !host)) scheduleTriggerRemount();
    });
    triggerMountObserver.observe(document.body, { childList: true, subtree: true });
    signal.addEventListener("abort", () => {
      triggerMountObserver.disconnect();
      if (scheduleTriggerRemount.frame) cancelAnimationFrame(scheduleTriggerRemount.frame);
    }, { once: true });
    trigger.addEventListener("click", openDialog, { signal });
    bindUpdateTooltip(trigger, signal);
    dialogResizeHandle.addEventListener("pointerdown", startDialogResize, { signal });
    window.addEventListener("resize", clampOpenDialogToViewport, { signal });
    for (const button of sectionButtons) {
      button.addEventListener("click", () => {
        setActiveSection(button.getAttribute("data-codex-pro-settings-section-button"));
      }, { signal });
    }
    formBinding.bindFieldListeners({
      form,
      onChange: renderModifiedState,
      settings,
      signal,
    });
    form.addEventListener("submit", (event) => {
      event.preventDefault();
      saveDialog();
    }, { signal });
    for (const closeElement of root.querySelectorAll("[data-codex-pro-settings-close]")) {
      closeElement.addEventListener("click", closeDialog, { signal });
    }

    // 这一段支持 Escape 关闭弹窗，减少鼠标操作成本。
    // Support Escape to close the dialog and reduce mouse-only interaction.
    window.addEventListener("keydown", (event) => {
      if (event.key === "Escape") closeDialog();
    }, { signal });
  }
  settingsMenu.view = {
    bind,
    install,
    setUpdateCheckState,
    uninstall,
  };
})();
