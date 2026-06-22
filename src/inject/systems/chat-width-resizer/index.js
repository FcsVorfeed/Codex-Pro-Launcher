(() => {
  const runtime = window.__codexProRuntime;
  if (!runtime) return;

  const systemName = "chat-width-resizer";
  const styleId = "codex-pro-chat-width-resizer-style";
  const handleId = "codex-pro-chat-width-resizer-handle";
  const resizeHandleAttribute = "data-codex-pro-chat-width-resizer-handle";
  const threadContentWidthProperty = "--thread-content-max-width";
  const composerEditorSelector = "[data-codex-composer='true'], .ProseMirror, textarea, [contenteditable='true']";
  const composerWidthClasses = ["mx-auto", "w-full", "max-w-(--thread-content-max-width)", "px-toolbar"];
  const fallbackDefaultWidthPixels = 1100;
  const fallbackMinimumWidthPixels = 560;
  const fallbackMaximumWidthPixels = 2200;
  const viewportPaddingPixels = 48;
  const dragHotspotWidthPixels = 12;

  function installStyles() {
    // 这一段只安装拖拽热区和拖拽中光标样式，不改 Codex 原生主题 token。
    // Install only the drag hotspot and active-drag cursor styles without changing native Codex tokens.
    runtime.dom.upsertStyle(
      styleId,
      `
        #${handleId} {
          position: fixed;
          z-index: 2147482600;
          width: ${dragHotspotWidthPixels}px;
          min-height: 44px;
          cursor: ew-resize;
          touch-action: none;
          opacity: 0;
          pointer-events: auto;
          user-select: none;
          -webkit-user-select: none;
          transition: opacity 120ms ease;
        }
        #${handleId}[hidden] {
          display: none;
        }
        body[data-codex-pro-chat-width-resizing="true"] {
          cursor: ew-resize !important;
          user-select: none !important;
          -webkit-user-select: none !important;
        }
      `,
    );
  }

  function isVisibleElement(element) {
    // 这一段只接受真实可见节点，避免旧 composer 或隐藏面板参与布局计算。
    // Accept only truly visible nodes so stale composers or hidden panels do not affect layout.
    if (!(element instanceof HTMLElement)) return false;
    const rect = element.getBoundingClientRect();
    if (rect.width <= 0 || rect.height <= 0) return false;
    const style = window.getComputedStyle(element);
    return style.display !== "none" && style.visibility !== "hidden" && Number(style.opacity) !== 0;
  }

  function getClassTokenSet(element) {
    // 这一段把 className 规整成 token 集合，兼容普通 DOM 节点的 class 字符串。
    // Normalize className into a token set for ordinary DOM nodes.
    return new Set(String(element?.className || "").split(/\s+/).filter(Boolean));
  }

  function hasAllClassTokens(element, tokens) {
    // 这一段用完整 class token 命中 Codex 的宽度容器，避免按文案或模糊片段定位。
    // Match Codex width containers by complete class tokens instead of copy or fuzzy substrings.
    const classTokens = getClassTokenSet(element);
    return tokens.every((token) => classTokens.has(token));
  }

  function findComposerEditor() {
    // 这一段优先使用 Codex 自己标记的 composer 编辑器，并按屏幕底部位置选择当前输入框。
    // Prefer Codex's own composer marker and choose the editor closest to the bottom of the viewport.
    const candidates = Array.from(document.querySelectorAll(composerEditorSelector))
      .filter(isVisibleElement);
    const markedEditors = candidates.filter((editor) => editor.matches("[data-codex-composer='true']"));
    const editors = markedEditors.length ? markedEditors : candidates;
    return editors.sort((left, right) => right.getBoundingClientRect().bottom - left.getBoundingClientRect().bottom)[0] || null;
  }

  function findComposerWidthElementFromEditor(editor) {
    // 这一段从编辑器向上寻找官方使用 thread-content 宽度变量的外层，不读取任何语言文案。
    // Walk upward from the editor to find the wrapper that uses the official thread-content width variable.
    for (let element = editor; element instanceof HTMLElement && element !== document.body; element = element.parentElement) {
      if (hasAllClassTokens(element, composerWidthClasses) && isVisibleElement(element)) return element;
    }
    return null;
  }

  function findComposerWidthElement() {
    // 这一段优先从当前输入框定位；DOM 重绘瞬间找不到编辑器时才扫描同类宽度容器。
    // Locate through the current editor first, scanning matching width wrappers only during rerender gaps.
    const editor = findComposerEditor();
    const fromEditor = findComposerWidthElementFromEditor(editor);
    if (fromEditor) return fromEditor;
    return Array.from(document.querySelectorAll("div"))
      .filter((element) => hasAllClassTokens(element, composerWidthClasses) && isVisibleElement(element))
      .sort((left, right) => right.getBoundingClientRect().bottom - left.getBoundingClientRect().bottom)[0] || null;
  }

  function findResizeBoundsElement(composerElement) {
    // 这一段寻找比 composer 更宽的官方滚动/页脚容器，用来限制最大宽度不越出主内容区。
    // Find a wider native scroll/footer container so the maximum width stays inside the main content area.
    if (!(composerElement instanceof HTMLElement)) return document.documentElement;
    const composerRect = composerElement.getBoundingClientRect();
    for (let element = composerElement.parentElement; element instanceof HTMLElement; element = element.parentElement) {
      const rect = element.getBoundingClientRect();
      if (rect.width >= composerRect.width + viewportPaddingPixels && rect.height >= composerRect.height) return element;
    }
    return document.documentElement;
  }

  function getWidthLimits(settingsApi, composerElement) {
    // 这一段合并设置模型限制和当前主内容区宽度，窗口变窄时不会把输入框推出屏幕。
    // Combine settings-model limits with the current content bounds so narrow windows cannot push the composer off-screen.
    const configuredMinimum = Number(settingsApi?.minChatWidthPixels) || fallbackMinimumWidthPixels;
    const configuredMaximum = Number(settingsApi?.maxChatWidthPixels) || fallbackMaximumWidthPixels;
    const boundsRect = findResizeBoundsElement(composerElement).getBoundingClientRect();
    const availableWidth = Math.max(0, Math.floor((boundsRect.width || window.innerWidth) - viewportPaddingPixels));
    const maximum = Math.max(320, Math.min(configuredMaximum, availableWidth || window.innerWidth - viewportPaddingPixels));
    const minimum = Math.min(configuredMinimum, maximum);
    return { maximum, minimum };
  }

  function clampWidth(width, settingsApi, composerElement) {
    // 这一段统一钳制宽度，确保设置值、拖拽值和当前窗口边界使用同一套规则。
    // Clamp configured and dragged widths through the same viewport-aware rules.
    const { maximum, minimum } = getWidthLimits(settingsApi, composerElement);
    const numericWidth = Number(width);
    if (!Number.isFinite(numericWidth)) return minimum;
    return Math.min(Math.max(Math.round(numericWidth), minimum), maximum);
  }

  function readSettingWidth(settings) {
    // 这一段读取已归一化的自定义宽度；设置模块缺失时使用本系统保守默认宽度。
    // Read the normalized custom width and fall back to this system's conservative default.
    const width = Number(settings?.chatWidthPixels);
    return Number.isFinite(width) ? width : fallbackDefaultWidthPixels;
  }

  function shouldUseCustomWidth(settings) {
    // 这一段把宽度模式限制为显式自定义；其他状态全部跟随 Codex 官方默认宽度。
    // Treat only the explicit custom mode as an override; every other state follows Codex's native width.
    return settings?.chatWidthMode === "custom";
  }

  function applyThreadContentWidth(width, settingsApi, composerElement) {
    // 这一段通过官方 CSS 变量放宽聊天内容和输入框，不直接改 React 状态或发送逻辑。
    // Widen chat content and composer through the official CSS variable without touching React state or send logic.
    if (!document.body) return width;
    const nextWidth = clampWidth(width, settingsApi, composerElement);
    document.body.style.setProperty(threadContentWidthProperty, `${nextWidth}px`);
    return nextWidth;
  }

  function restoreNativeThreadContentWidth(originalBodyWidth = "") {
    // 这一段恢复本系统启动前的 inline 宽度；没有原值时才移除覆盖交回官方 CSS。
    // Restore the inline width that existed before this system started; remove only when there was no original value.
    if (!document.body) return;
    if (originalBodyWidth) {
      document.body.style.setProperty(threadContentWidthProperty, originalBodyWidth);
      return;
    }
    document.body.style.removeProperty(threadContentWidthProperty);
  }

  function ensureHandle(signal) {
    // 这一段复用唯一热区节点，重复注入时不会叠出多个拖拽层。
    // Reuse one hotspot node so reinjection cannot stack multiple drag layers.
    let handle = document.getElementById(handleId);
    if (!handle) {
      handle = document.createElement("div");
      handle.id = handleId;
      handle.setAttribute(resizeHandleAttribute, "true");
      handle.setAttribute("aria-hidden", "true");
      document.body?.appendChild(handle);
    }
    signal.addEventListener("abort", () => handle.remove(), { once: true });
    return handle;
  }

  function placeHandle(handle, composerElement) {
    // 这一段把热区贴到当前 composer 外层右边缘，避开发送按钮和输入文本区域。
    // Attach the hotspot to the right edge of the composer wrapper, away from send controls and typed text.
    if (!(handle instanceof HTMLElement) || !(composerElement instanceof HTMLElement) || !isVisibleElement(composerElement)) {
      if (handle) handle.hidden = true;
      return;
    }
    const rect = composerElement.getBoundingClientRect();
    handle.hidden = false;
    handle.style.left = `${Math.round(rect.right - dragHotspotWidthPixels / 2)}px`;
    handle.style.top = `${Math.round(rect.top)}px`;
    handle.style.height = `${Math.max(44, Math.round(rect.height))}px`;
  }

  runtime.registerSystem(systemName, () => {
    const settingsApi = runtime.systemModules.settingsMenu?.settings;
    const controller = new AbortController();
    runtime.lifecycle.replaceController(systemName, controller);
    runtime.lifecycle.replaceWindowController("__codexProChatWidthResizerController", controller);

    installStyles();
    const handle = ensureHandle(controller.signal);
    const originalBodyWidth = document.body?.style.getPropertyValue(threadContentWidthProperty) || "";
    let currentSettings = settingsApi?.getSettings?.() || {};
    let frameId = 0;
    let composerElement = null;
    let dragState = null;

    const resizeObserver = new ResizeObserver(() => scheduleRefresh("resize-observer"));
    const mutationObserver = new MutationObserver(() => scheduleRefresh("mutation"));

    function observeComposer(nextComposerElement) {
      // 这一段只观察当前 composer 宽度容器，输入框高度变化时热区能跟随。
      // Observe only the current composer width wrapper so the hotspot follows composer height changes.
      if (composerElement === nextComposerElement) return;
      if (composerElement) resizeObserver.unobserve(composerElement);
      composerElement = nextComposerElement;
      if (composerElement) resizeObserver.observe(composerElement);
    }

    function refreshLayout() {
      // 这一段合并 DOM 重绘后的定位、宽度应用和热区放置。
      // Coalesce post-render target lookup, width application, and hotspot placement.
      const nextComposerElement = findComposerWidthElement();
      observeComposer(nextComposerElement);
      if (shouldUseCustomWidth(currentSettings)) {
        applyThreadContentWidth(readSettingWidth(currentSettings), settingsApi, nextComposerElement);
      } else {
        restoreNativeThreadContentWidth(originalBodyWidth);
      }
      placeHandle(handle, nextComposerElement);
    }

    function scheduleRefresh() {
      // 这一段把 MutationObserver 和 resize 事件合并到下一帧，降低流式输出时的布局读取频率。
      // Merge mutation and resize events into the next frame to reduce layout reads during streaming.
      if (frameId) return;
      frameId = window.requestAnimationFrame(() => {
        frameId = 0;
        refreshLayout();
      });
    }

    function clearDragState() {
      // 这一段统一清理拖拽态和全局光标标记，避免 pointercancel 后残留。
      // Clear drag state and global cursor markers in one place so pointercancel cannot leave stale UI.
      dragState = null;
      handle.removeAttribute("data-codex-pro-chat-width-dragging");
      document.body?.removeAttribute("data-codex-pro-chat-width-resizing");
    }

    function startResize(event) {
      // 这一段只响应主按钮拖拽，右键或辅助键不会改聊天布局。
      // Start resizing only for primary-button drags so secondary buttons do not change layout.
      if (event.pointerType === "mouse" && event.button !== 0) return;
      const targetComposer = findComposerWidthElement();
      if (!targetComposer) return;
      event.preventDefault();
      event.stopPropagation();

      // 这一段记录实际可见宽度；居中容器右边缘移动 1px 等价于总宽度变化 2px。
      // Record the actual visible width; for a centered container, moving the right edge 1px changes total width by 2px.
      const rect = targetComposer.getBoundingClientRect();
      dragState = {
        lastWidth: rect.width,
        pointerId: event.pointerId,
        startWidth: rect.width,
        startX: event.clientX,
      };
      handle.setAttribute("data-codex-pro-chat-width-dragging", "true");
      document.body?.setAttribute("data-codex-pro-chat-width-resizing", "true");
      try {
        handle.setPointerCapture?.(event.pointerId);
      } catch {
        // 这一段忽略 pointer capture 失败，后续 pointerup/cancel 仍会尝试清理状态。
        // Ignore pointer-capture failures; pointerup/cancel still attempts cleanup.
      }
    }

    function resetToNativeWidth(event) {
      // 这一段把中键点击解释为“回到官方默认宽度”，不采样也不保存固定 px 值。
      // Interpret middle-click as "return to native width" without sampling or storing a fixed pixel value.
      if (event.button !== 1) return;
      event.preventDefault();
      event.stopPropagation();
      clearDragState();
      restoreNativeThreadContentWidth(originalBodyWidth);
      if (settingsApi?.saveSettings) {
        const settings = settingsApi.getSettings();
        settingsApi.saveSettings({
          ...settings,
          chatWidthMode: "official",
          chatWidthPixels: settingsApi.defaultSettings?.chatWidthPixels ?? fallbackDefaultWidthPixels,
        });
      }
      scheduleRefresh("middle-click-reset");
    }

    function isHandleEvent(event) {
      // 这一段只接受命中当前透明热区的事件，避免全局捕获监听影响页面其它中键行为。
      // Accept only events targeting the transparent hotspot so the global capture listener does not affect other middle-clicks.
      return event.target === handle || event.composedPath?.().includes(handle);
    }

    function captureMiddleReset(event) {
      // 这一段早于鼠标手势系统处理中键复位，防止全局中键候选提前吞掉热区事件。
      // Handle middle-click reset before the mouse-gesture system can swallow hotspot events.
      if (event.button !== 1 || !isHandleEvent(event)) return;
      resetToNativeWidth(event);
    }

    function handlePointerDown(event) {
      // 这一段把中键重置和左键拖拽分流，避免中键触发浏览器自动滚动或拖拽。
      // Route middle-click reset and primary-button drag separately to avoid browser autoscroll or accidental resizing.
      if (event.pointerType === "mouse" && event.button === 1) {
        resetToNativeWidth(event);
        return;
      }
      startResize(event);
    }

    function updateResize(event) {
      // 这一段按当前指针位置实时更新 CSS 变量，避免拖拽时等待设置保存。
      // Update the CSS variable live from the pointer position instead of waiting for settings save.
      if (!dragState || event.pointerId !== dragState.pointerId) return;
      event.preventDefault();
      event.stopPropagation();
      const nextWidth = clampWidth(dragState.startWidth + (event.clientX - dragState.startX) * 2, settingsApi, composerElement);
      dragState.lastWidth = applyThreadContentWidth(nextWidth, settingsApi, composerElement);
      currentSettings = { ...currentSettings, chatWidthMode: "custom", chatWidthPixels: dragState.lastWidth };
      placeHandle(handle, composerElement);
    }

    function finishResize(event) {
      // 这一段在释放鼠标时把最终宽度写入设置模型，后续重启或重新注入继续沿用。
      // Persist the final width on pointer release so relaunches and reinjection keep the selected size.
      if (!dragState || event.pointerId !== dragState.pointerId) return;
      event.preventDefault();
      event.stopPropagation();
      const savedWidth = dragState.lastWidth;
      clearDragState();
      if (Number.isFinite(savedWidth) && settingsApi?.saveSettings) {
        settingsApi.saveSettings({
          ...settingsApi.getSettings(),
          chatWidthMode: "custom",
          chatWidthPixels: savedWidth,
        });
      }
      scheduleRefresh("pointerup");
    }

    function syncSettings(nextSettings) {
      // 这一段保存设置后立即刷新当前页面，不需要重启 Codex。
      // Refresh the current page immediately after settings save without requiring a Codex restart.
      currentSettings = nextSettings || settingsApi?.getSettings?.() || {};
      scheduleRefresh("settings");
    }

    handle.addEventListener("pointerdown", handlePointerDown, { signal: controller.signal });
    handle.addEventListener("pointermove", updateResize, { signal: controller.signal });
    handle.addEventListener("pointerup", finishResize, { signal: controller.signal });
    handle.addEventListener("pointercancel", clearDragState, { signal: controller.signal });
    handle.addEventListener("auxclick", resetToNativeWidth, { signal: controller.signal });
    window.addEventListener("pointerdown", captureMiddleReset, { capture: true, signal: controller.signal });
    window.addEventListener("auxclick", captureMiddleReset, { capture: true, signal: controller.signal });
    window.addEventListener("resize", () => scheduleRefresh("window-resize"), { signal: controller.signal });
    mutationObserver.observe(document.body || document.documentElement, {
      attributeFilter: ["class", "hidden", "style", "data-state", "aria-hidden"],
      attributes: true,
      childList: true,
      subtree: true,
    });
    const unsubscribeSettings = settingsApi?.subscribe?.(syncSettings, controller.signal);

    controller.signal.addEventListener(
      "abort",
      () => {
        // 这一段恢复官方宽度变量和清理全部监听/观察器，关闭功能后不留布局副作用。
        // Restore the native width variable and clean all observers/listeners so disabling leaves no layout side effects.
        if (frameId) window.cancelAnimationFrame(frameId);
        mutationObserver.disconnect();
        resizeObserver.disconnect();
        unsubscribeSettings?.();
        clearDragState();
        if (document.body) {
          if (originalBodyWidth) {
            document.body.style.setProperty(threadContentWidthProperty, originalBodyWidth);
          } else {
            document.body.style.removeProperty(threadContentWidthProperty);
          }
        }
        document.getElementById(styleId)?.remove();
      },
      { once: true },
    );

    syncSettings(currentSettings);
  }, { enableSetting: "enableChatWidthResizer" });
})();
