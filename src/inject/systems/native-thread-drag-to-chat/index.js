(() => {
  const runtime = window.__codexProRuntime;
  if (!runtime) return;
  const i18n = runtime.i18n;

  const systemName = "native-thread-drag-to-chat";
  const threadSelector = "[data-app-action-sidebar-thread-id]";
  const sidebarScrollSelector = "[data-app-action-sidebar-scroll]";
  const fiberPrefix = "__reactFiber$";
  const styleId = "codex-pro-native-thread-drag-to-chat-style";
  const ghostId = "codex-pro-native-thread-drag-to-chat-ghost";
  const dragStateAttr = "data-codex-pro-native-thread-drag-state";
  const pointerDragThresholdPx = 8;
  const ghostOffset = 14;
  const statusHideDelayMs = 1200;

  function installStyle() {
    // 这一段安装拖拽浮层样式，重复注入时复用同一个 style 节点。
    // Install the drag ghost style and reuse the same style node across reinjections.
    if (document.getElementById(styleId)) return;
    const style = document.createElement("style");
    style.id = styleId;
    style.textContent = `
      #${ghostId} {
        align-items: center;
        background: var(--color-background-control-opaque, var(--color-token-dropdown-background, rgba(35, 35, 35, 0.96)));
        border: 1px solid var(--color-token-input-border, rgba(255, 255, 255, 0.16));
        border-radius: 8px;
        box-shadow: rgba(0, 0, 0, 0.28) 0 12px 32px -18px, rgba(0, 0, 0, 0.22) 0 4px 12px -6px;
        color: var(--text-primary, rgb(235, 235, 235));
        display: none;
        font: inherit;
        font-size: 12px;
        gap: 7px;
        left: 0;
        line-height: 18px;
        max-width: min(320px, calc(100vw - 24px));
        min-height: 30px;
        min-width: 120px;
        overflow: hidden;
        padding: 6px 10px;
        pointer-events: none;
        position: fixed;
        top: 0;
        transform: translate3d(-9999px, -9999px, 0);
        user-select: none;
        white-space: nowrap;
        z-index: 10000;
      }
      #${ghostId}[data-codex-pro-visible="true"] {
        display: inline-flex;
      }
      #${ghostId}[data-codex-pro-tone="drop"] {
        border-color: var(--color-token-border-selected, rgba(87, 166, 255, 0.72));
      }
      #${ghostId}[data-codex-pro-tone="success"] {
        border-color: rgba(70, 180, 120, 0.78);
      }
      #${ghostId}[data-codex-pro-tone="error"] {
        border-color: rgba(230, 100, 100, 0.84);
      }
      #${ghostId} .codex-pro-native-thread-drag-dot {
        background: currentColor;
        border-radius: 999px;
        flex: 0 0 auto;
        height: 6px;
        opacity: 0.72;
        width: 6px;
      }
      #${ghostId} .codex-pro-native-thread-drag-text {
        min-width: 0;
        overflow: hidden;
        text-overflow: ellipsis;
      }
      body[${dragStateAttr}="blocked"],
      body[${dragStateAttr}="blocked"] * {
        cursor: no-drop !important;
      }
      body[${dragStateAttr}="copy"],
      body[${dragStateAttr}="copy"] * {
        cursor: copy !important;
      }
    `;
    document.head.append(style);
  }

  function getGhost() {
    // 这一段按需创建唯一拖拽浮层，不把状态写进官方侧栏 DOM。
    // Lazily create one drag ghost without writing state into the native sidebar DOM.
    installStyle();
    let ghost = document.getElementById(ghostId);
    if (ghost) return ghost;
    ghost = document.createElement("div");
    ghost.id = ghostId;
    ghost.setAttribute("aria-hidden", "true");
    const dot = document.createElement("span");
    dot.className = "codex-pro-native-thread-drag-dot";
    const text = document.createElement("span");
    text.className = "codex-pro-native-thread-drag-text";
    ghost.append(dot, text);
    document.body.append(ghost);
    return ghost;
  }

  function positionGhost(event) {
    // 这一段让浮层跟随鼠标，同时限制在视口内，避免拖到边缘时被裁掉。
    // Keep the ghost near the pointer and clamp it inside the viewport.
    const ghost = getGhost();
    const rect = ghost.getBoundingClientRect();
    const width = rect.width || 180;
    const height = rect.height || 32;
    const x = Math.min(Math.max(8, event.clientX + ghostOffset), Math.max(8, window.innerWidth - width - 8));
    const y = Math.min(Math.max(8, event.clientY + ghostOffset), Math.max(8, window.innerHeight - height - 8));
    ghost.style.transform = `translate3d(${Math.round(x)}px, ${Math.round(y)}px, 0)`;
  }

  function showGhost(text, event, tone = "") {
    // 这一段显示拖拽或状态反馈，只展示会话标题/状态，不包含正文。
    // Show drag or status feedback with only the thread title/status and no body content.
    const ghost = getGhost();
    const label = ghost.querySelector(".codex-pro-native-thread-drag-text");
    if (label) label.textContent = String(text || "").trim() || i18n.t("common.untitledSession");
    ghost.dataset.codexProVisible = "true";
    ghost.dataset.codexProTone = tone;
    if (event) positionGhost(event);
  }

  function hideGhost() {
    // 这一段隐藏拖拽浮层，并清理短暂状态色。
    // Hide the drag ghost and clear transient tone state.
    const ghost = document.getElementById(ghostId);
    if (!ghost) return;
    ghost.dataset.codexProVisible = "false";
    ghost.dataset.codexProTone = "";
  }

  function normalizeThreadId(value) {
    // 这一段把官方侧栏 data id 归一化为裸 threadId，避免 local/remote 前缀影响本机查找。
    // Normalize native sidebar data ids into bare thread IDs so local/remote prefixes do not affect lookup.
    const threadId = String(value || "").trim().replace(/^(?:local|remote):/iu, "").slice(0, 180);
    if (!threadId || ["__proto__", "prototype", "constructor"].includes(threadId)) return "";
    return /^[A-Za-z0-9_.:-]{8,180}$/u.test(threadId) ? threadId : "";
  }

  function getReactFiber(element) {
    // 这一段通过官方 React 节点上的内部 fiber 读取新版会话行数据，不依赖标题或其它界面文案。
    // Read updated thread-row data through the official React node's internal fiber without depending on titles or UI copy.
    const key = element
      ? Object.getOwnPropertyNames(element).find((name) => name.startsWith(fiberPrefix))
      : "";
    return key ? element[key] : null;
  }

  function findCanonicalThreadId(row) {
    // 这一段优先读取新版会话行的正式 conversationId；DOM thread key 可能仍是 client-new-thread 临时键。
    // Prefer the updated row's canonical conversationId because its DOM thread key may still be a client-new-thread placeholder.
    let fiber = getReactFiber(row);
    for (let depth = 0; fiber && depth < 32; depth += 1) {
      const props = fiber.memoizedProps || fiber.pendingProps || {};
      const candidate =
        props.conversationId ||
        props.entry?.conversationId ||
        props.tooltipContent?.props?.children?.props?.conversationId;
      const threadId = normalizeThreadId(candidate);
      if (threadId) return threadId;
      fiber = fiber.return;
    }
    return "";
  }

  function normalizeThreadTitle(row, threadId) {
    // 这一段只把标题当作拖拽反馈和附件 label 兜底，不用它定位或查找会话。
    // Use the title only as drag feedback and attachment-label fallback, never for locating the thread.
    const title = String(row?.getAttribute?.("aria-label") || row?.title || row?.textContent || "")
      .replace(/\s+/gu, " ")
      .trim()
      .slice(0, 160);
    return title || threadId || i18n.t("common.untitledSession");
  }

  function findNativeThreadRow(target) {
    // 这一段只接受 Codex 官方左侧滚动容器内带结构化 thread id 的行。
    // Accept only rows with structured thread ids inside Codex's native left sidebar scroller.
    const row = target?.closest?.(threadSelector);
    if (!row) return null;
    const sidebar = row.closest?.(sidebarScrollSelector);
    if (!sidebar) return null;
    const threadId =
      findCanonicalThreadId(row) ||
      normalizeThreadId(row.getAttribute("data-app-action-sidebar-thread-id"));
    if (!threadId) return null;
    return {
      element: row,
      threadId,
      title: normalizeThreadTitle(row, threadId),
    };
  }

  function getAttachmentApi() {
    // 这一段复用文件拖入聊天模块暴露的官方附件入口，不在本系统里重复逆向 composer。
    // Reuse the file-drag module's official attachment entrypoint instead of rediscovering the composer here.
    const attachmentApi = runtime.systemModules.tabDragToChat;
    if (
      typeof attachmentApi?.addLocalFileAttachment !== "function" ||
      typeof attachmentApi?.createLocalFileAttachment !== "function" ||
      typeof attachmentApi?.isComposerDropEvent !== "function"
    ) {
      return null;
    }
    return attachmentApi;
  }

  function getConversationArchiveApi() {
    // 这一段只调用会话归档系统公开的本机准备接口，页面侧不读取 SQLite、JSONL 或 Markdown 正文。
    // Call only the local prepare API exposed by conversation archive; page code never reads SQLite, JSONL, or Markdown bodies.
    const archiveApi = runtime.systemModules.conversationArchive;
    return typeof archiveApi?.prepareLocalThreadArchiveFile === "function" ? archiveApi : null;
  }

  runtime.registerSystem(systemName, () => {
    const controller = new AbortController();
    runtime.lifecycle?.replaceController?.(systemName, controller);
    const { signal } = controller;
    let activePointerDrag = null;
    let suppressClickUntil = 0;
    let hideStatusTimer = 0;

    function clearHideStatusTimer() {
      // 这一段清理状态浮层定时器，避免前一次成功/失败延迟隐藏影响下一次拖拽。
      // Clear status-hide timers so previous success/failure feedback cannot hide the next drag.
      window.clearTimeout(hideStatusTimer);
      hideStatusTimer = 0;
    }

    function scheduleHideGhost() {
      // 这一段让成功/失败状态短暂停留，之后自动收起。
      // Keep success/failure feedback briefly, then hide it.
      clearHideStatusTimer();
      hideStatusTimer = window.setTimeout(() => {
        hideStatusTimer = 0;
        hideGhost();
      }, statusHideDelayMs);
    }

    function setDragCursorState(state = "") {
      // 这一段在 pointer 兜底路径里覆盖文本编辑光标，让可投放/不可投放状态更接近原生拖拽。
      // Override text-edit cursors in the pointer fallback path so copy/no-drop states feel like native dragging.
      if (state) document.body.setAttribute(dragStateAttr, state);
      else document.body.removeAttribute(dragStateAttr);
    }

    function clearActiveDrag({ keepGhost = false, suppressClick = false } = {}) {
      // 这一段清理本次拖拽状态，避免下一次普通拖拽复用旧 threadId。
      // Clear this drag state so the next normal drag cannot reuse a stale threadId.
      activePointerDrag = null;
      setDragCursorState("");
      if (suppressClick) suppressClickUntil = Date.now() + 600;
      if (!keepGhost) hideGhost();
    }

    function updateDropFeedback(event) {
      // 这一段按当前指针位置同步可投放状态；只有 composer 范围内显示 copy，其它区域显示不可投放。
      // Sync the drop affordance from the current pointer position: copy inside composer, no-drop elsewhere.
      const isComposerDrop = Boolean(getAttachmentApi()?.isComposerDropEvent(event));
      setDragCursorState(isComposerDrop ? "copy" : "blocked");
      return isComposerDrop;
    }

    function getPointerKey(event) {
      // 这一段给 PointerEvent 和 mouse fallback 生成同一套指针标识。
      // Build one pointer identifier for PointerEvent and mouse fallback.
      return Number.isFinite(event.pointerId) ? event.pointerId : "mouse";
    }

    function getPointerDistance(drag, event) {
      // 这一段计算按下点到当前位置的距离，用于区分点击打开和真实拖拽。
      // Measure movement from press point to separate normal clicks from real drags.
      return Math.hypot(event.clientX - drag.startX, event.clientY - drag.startY);
    }

    async function attachNativeThreadToComposer(thread, event = null) {
      // 这一段在落到 composer 后才请求本机导出 Markdown，并把结果追加为当前消息附件。
      // Request local Markdown export only after dropping on the composer, then append it as a current-message attachment.
      clearHideStatusTimer();
      showGhost(i18n.t("nativeThreadDrag.status.attaching"), event, "drop");
      try {
        const initialAttachmentApi = getAttachmentApi();
        const archiveApi = getConversationArchiveApi();
        if (!thread?.threadId || !initialAttachmentApi || !archiveApi) {
          throw new Error(i18n.t("nativeThreadDrag.error.attachmentUnavailable"));
        }
        const data = await archiveApi.prepareLocalThreadArchiveFile({ threadId: thread.threadId });
        const localPath = String(data?.localPath || data?.filePath || "");
        if (!localPath) throw new Error(i18n.t("nativeThreadDrag.error.attachmentUnavailable"));

        // 这一段异步导出后重新读取附件入口，覆盖用户期间关闭相关设置或重新注入的情况。
        // Re-read the attachment entrypoint after async export in case settings changed or reinjection happened.
        const attachmentApi = getAttachmentApi();
        if (!attachmentApi) throw new Error(i18n.t("nativeThreadDrag.error.attachmentUnavailable"));
        const label = String(data?.title || thread.title || "").trim();
        const attachment = attachmentApi.createLocalFileAttachment(localPath, label);
        if (!attachmentApi.addLocalFileAttachment(attachment)) {
          throw new Error(i18n.t("nativeThreadDrag.error.attachmentUnavailable"));
        }
        hideGhost();
      } catch (error) {
        console.warn("[Codex-Pro] unable to attach native thread to chat", error);
        showGhost(error?.message || i18n.t("nativeThreadDrag.status.attachFailed"), event, "error");
      } finally {
        scheduleHideGhost();
      }
    }

    function startPointerDrag(event) {
      // 这一段记录官方左侧对话行的主按钮按下，不阻止普通点击打开会话。
      // Record primary-button presses on native sidebar thread rows without blocking normal click-to-open.
      if (event.button !== 0) return;
      const thread = findNativeThreadRow(event.target);
      if (!thread) return;
      clearActiveDrag();
      clearHideStatusTimer();
      activePointerDrag = {
        hasDragged: false,
        pointerKey: getPointerKey(event),
        startX: event.clientX,
        startY: event.clientY,
        thread,
      };
    }

    function updatePointerDrag(event) {
      // 这一段只跟踪同一指针，超过阈值后显示拖拽反馈。
      // Track only the same pointer and show feedback after the drag threshold.
      const drag = activePointerDrag;
      if (!drag || drag.pointerKey !== getPointerKey(event)) return;
      if (Number.isFinite(event.buttons) && (event.buttons & 1) !== 1) {
        clearActiveDrag();
        return;
      }
      if (getPointerDistance(drag, event) >= pointerDragThresholdPx) {
        drag.hasDragged = true;
        const isComposerDrop = updateDropFeedback(event);
        showGhost(drag.thread.title, event, isComposerDrop ? "drop" : "");
      }
    }

    function finishPointerDrag(event) {
      // 这一段在松手时检查是否落到 composer，成功则转成 Markdown 附件。
      // On release, check whether the pointer is over the composer and attach the Markdown when it is.
      const drag = activePointerDrag;
      if (!drag || drag.pointerKey !== getPointerKey(event)) return;
      activePointerDrag = null;
      const didDrag = drag.hasDragged || getPointerDistance(drag, event) >= pointerDragThresholdPx;
      if (!didDrag) {
        clearActiveDrag();
        return;
      }
      const isComposerDrop = Boolean(getAttachmentApi()?.isComposerDropEvent(event));
      event.preventDefault();
      event.stopPropagation();
      clearActiveDrag({ keepGhost: isComposerDrop, suppressClick: true });
      if (isComposerDrop) void attachNativeThreadToComposer(drag.thread, event);
    }

    function handleVisibilityChange() {
      // 这一段在页面进入后台时立即结束 pointer 会话，避免系统级切换留下光标状态。
      // End the pointer session as soon as the page becomes hidden so system-level switching cannot leave cursor state behind.
      if (document.visibilityState === "hidden") clearActiveDrag();
    }

    function handleEscapeKey(event) {
      // 这一段让 Escape 成为明确取消入口，和用户对普通拖拽的预期一致。
      // Treat Escape as an explicit cancel action, matching normal drag expectations.
      if (event.key === "Escape") clearActiveDrag();
    }

    function suppressNativeClickAfterDrag(event) {
      // 这一段防止真实拖拽结束后浏览器补发 click 导致切换到被拖的历史会话。
      // Prevent the post-drag synthetic click from opening the dragged history thread.
      if (Date.now() > suppressClickUntil) return;
      if (!findNativeThreadRow(event.target)) return;
      event.preventDefault();
      event.stopPropagation();
      event.stopImmediatePropagation?.();
    }

    document.addEventListener("pointerdown", startPointerDrag, { capture: true, signal });
    document.addEventListener("pointermove", updatePointerDrag, { capture: true, signal });
    document.addEventListener("pointerup", finishPointerDrag, { capture: true, signal });
    document.addEventListener("pointercancel", clearActiveDrag, { capture: true, signal });
    document.addEventListener("lostpointercapture", clearActiveDrag, { capture: true, signal });
    document.addEventListener("click", suppressNativeClickAfterDrag, { capture: true, signal });
    document.addEventListener("keydown", handleEscapeKey, { capture: true, signal });
    document.addEventListener("visibilitychange", handleVisibilityChange, { signal });
    window.addEventListener("blur", clearActiveDrag, { signal });

    if (!window.PointerEvent) {
      // 这一段只在没有 PointerEvent 的环境启用 mouse fallback，避免现代 Electron 重复处理。
      // Enable mouse fallback only without PointerEvent so modern Electron does not process twice.
      document.addEventListener("mousedown", startPointerDrag, { capture: true, signal });
      document.addEventListener("mousemove", updatePointerDrag, { capture: true, signal });
      document.addEventListener("mouseup", finishPointerDrag, { capture: true, signal });
    }

    controller.signal.addEventListener("abort", () => {
      // 这一段卸载时清理浮层和状态计时器。
      // Clean up ghost and status timers on unload.
      clearHideStatusTimer();
      clearActiveDrag();
      document.getElementById(ghostId)?.remove();
      document.getElementById(styleId)?.remove();
    }, { once: true });
  }, {
    enableSetting: "enableNativeThreadDragToChat",
    enableSettings: ["enableNativeThreadDragToChat", "enableTabDragToChat"],
  });
})();
