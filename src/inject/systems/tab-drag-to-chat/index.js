(() => {
  const runtime = window.__codexProRuntime;
  if (!runtime) return;

  const systemName = "tab-drag-to-chat";
  const tabDragToChat = runtime.systemModules.tabDragToChat ??= {};
  const dragDataType = "application/x-codex-pro-file-tab";
  const fileTabPrefix = "file:local:";
  const fiberPrefix = "__reactFiber$";
  const pointerDragThresholdPx = 8;

  function getReactFiber(element) {
    // 这一段通过 React 挂在 DOM 节点上的内部 fiber 找到 composer 附件入口。
    // Locate the composer attachment entrypoint through React's internal fiber stored on DOM nodes.
    const key = Object.getOwnPropertyNames(element).find((name) => name.startsWith(fiberPrefix));
    return key ? element[key] : null;
  }

  function isElementVisible(element) {
    // 这一段过滤不可见节点，避免隐藏 composer 或菜单里的旧按钮被误用。
    // Filter invisible nodes so hidden composers or stale menu buttons are not used.
    if (!element?.isConnected) return false;
    const rect = element.getBoundingClientRect();
    if (rect.width <= 0 || rect.height <= 0) return false;
    const style = window.getComputedStyle(element);
    return style.display !== "none" && style.visibility !== "hidden" && Number(style.opacity) !== 0;
  }

  function normalizeDecodedPath(value) {
    // 这一段把右侧标签里的 file:local 路径解码为 Codex 附件状态使用的本机路径。
    // Decode the right-side tab file:local path into the local path shape used by Codex attachments.
    let path = String(value || "").trim();
    try {
      path = decodeURIComponent(path);
    } catch {
      try {
        path = decodeURI(path);
      } catch {
        // 这一段保留原始路径继续处理，避免异常编码让拖拽流程直接中断。
        // Keep the original path so malformed encoding does not abort the drag flow.
      }
    }
    path = path.replace(/\\/g, "/");
    if (/^\/[a-zA-Z]:\//.test(path)) path = path.slice(1);
    if (/^[a-zA-Z]:\//.test(path)) return path.replace(/\//g, "\\");
    return path;
  }

  function getFileName(path) {
    // 这一段从绝对路径里取文件名，用作 Codex 附件卡片的显示 label。
    // Extract the filename from the absolute path for the Codex attachment card label.
    const parts = String(path || "").split(/[\\/]+/).filter(Boolean);
    return parts.at(-1) || path;
  }

  function decodeTabId(tabId) {
    // 这一段只接受 Codex 右侧本地文件标签，避免普通页面拖拽被本系统接管。
    // Accept only Codex right-side local file tabs so normal page drags are not handled here.
    if (typeof tabId !== "string" || !tabId.startsWith(fileTabPrefix)) return null;
    const path = normalizeDecodedPath(tabId.slice(fileTabPrefix.length));
    if (!path) return null;
    return {
      fsPath: path,
      label: getFileName(path),
      path,
    };
  }

  function findDraggedFileTab(target) {
    // 这一段从拖拽起点向上找右侧文件标签容器，排除其它 app shell 标签或按钮。
    // Walk up from the drag source to find a right-side file tab while excluding other shell tabs or buttons.
    const tab = target?.closest?.("[data-tab-id^='file:local:']");
    if (!tab) return null;
    const controller = tab.closest?.("[data-app-shell-tab-controller='right']");
    if (!controller && tab.getAttribute("data-app-shell-tab-controller") !== "right") return null;
    return decodeTabId(tab.getAttribute("data-tab-id"));
  }

  function hasVisibleComposerEditor(element) {
    // 这一段确认候选容器内确实有可见编辑器，避免只因为工具栏尺寸相近就接管拖拽。
    // Confirm the candidate contains a visible editor so similarly sized toolbar wrappers are not intercepted.
    return [...element.querySelectorAll("[data-codex-composer='true'], .ProseMirror, textarea, [contenteditable='true']")].some((editor) => (
      !editor.closest("[aria-hidden='true']") &&
      isElementVisible(editor)
    ));
  }

  function findComposerEditor() {
    // 这一段优先使用 Codex 自己标记的 composer 编辑器，不再依赖任何语言的按钮文案。
    // Prefer Codex's own composer marker so no localized button text is needed.
    const candidates = [...document.querySelectorAll("[data-codex-composer='true'], .ProseMirror, textarea, [contenteditable='true']")]
      .filter((editor) => !editor.closest("[aria-hidden='true']") && isElementVisible(editor));
    const markedEditors = candidates.filter((editor) => editor.matches("[data-codex-composer='true']"));
    const editors = markedEditors.length ? markedEditors : candidates;
    return editors.sort((left, right) => right.getBoundingClientRect().bottom - left.getBoundingClientRect().bottom)[0] || null;
  }

  function findComposerDropRegion() {
    // 这一段从 composer 编辑器向上找最小的可投放容器，兼容新对话居中输入框和旧对话底部输入框。
    // Walk upward from the composer editor to find the smallest drop container for both centered and bottom composers.
    const editor = findComposerEditor();
    for (let element = editor, depth = 0; element && depth < 16; element = element.parentElement, depth += 1) {
      const rect = element.getBoundingClientRect();
      if (
        rect.width >= 300 &&
        rect.height >= 70 &&
        rect.height <= 420 &&
        rect.bottom <= window.innerHeight &&
        rect.top >= 0
      ) {
        if (!hasVisibleComposerEditor(element)) continue;
        return element;
      }
    }
    return null;
  }

  function isPointInElement(event, element) {
    // 这一段用指针坐标判断是否真正拖到 composer 范围内，避免误接管页面其它区域。
    // Check the pointer coordinates against the composer bounds so other page areas are not intercepted.
    if (!element) return false;
    const rect = element.getBoundingClientRect();
    return (
      event.clientX >= rect.left &&
      event.clientX <= rect.right &&
      event.clientY >= rect.top &&
      event.clientY <= rect.bottom
    );
  }

  function findComposerControllerFromElement(element) {
    // 这一段沿候选元素的 React 父链读取新版 Codex composer controller。
    // Walk a candidate element's React parent chain to read the current Codex composer controller.
    let fiber = element ? getReactFiber(element) : null;
    for (let depth = 0; fiber && depth < 80; depth += 1) {
      const props = fiber.memoizedProps || fiber.pendingProps || {};
      const controller =
        props.composerController ||
        props.composerInput?.props?.children?.props?.composerController;
      if (controller?.eventEmitter && typeof controller.eventEmitter.emit === "function") {
        return controller;
      }
      fiber = fiber.return;
    }
    return null;
  }

  function findComposerController() {
    // 这一段只在当前 composer 容器内扫描可交互节点，避免跨语言文案匹配或误扫聊天历史。
    // Scan only interactive nodes inside the current composer, avoiding localized text matching and chat-history hits.
    const dropRegion = findComposerDropRegion();
    if (!dropRegion) return null;
    const candidates = [
      dropRegion,
      ...dropRegion.querySelectorAll("button, [role='button'], input, [data-codex-composer='true'], .ProseMirror, textarea, [contenteditable='true']"),
    ];
    for (const candidate of candidates) {
      if (candidate !== dropRegion && !isElementVisible(candidate)) continue;
      const controller = findComposerControllerFromElement(candidate);
      if (controller) return controller;
    }
    return null;
  }

  function createPastedFileLike(attachment) {
    // 这一段把受信本机路径包装成真实 File 实例，满足 Codex 的 electronBridge.getPathForFile 检查。
    // Wrap a trusted local path into a real File instance so Codex's electronBridge.getPathForFile accepts it.
    const path = String(attachment?.fsPath || attachment?.path || "");
    const name = String(attachment?.label || "").trim() || getFileName(path);
    const file = new File([new Uint8Array([0])], name, {
      lastModified: Date.now(),
      type: "",
    });
    Object.defineProperties(file, {
      fsPath: {
        configurable: true,
        enumerable: true,
        value: path,
      },
      path: {
        configurable: true,
        enumerable: true,
        value: path,
      },
    });
    return file;
  }

  function getAttachmentWarningSummary(attachment) {
    // 这一段只生成警告日志用的轻量摘要，避免日志展开 File 对象内容。
    // Build only a lightweight warning summary so logs do not expand the File object body.
    const path = String(attachment?.fsPath || attachment?.path || "");
    return {
      fsPath: path,
      label: String(attachment?.label || "").trim() || getFileName(path),
      path,
    };
  }

  function addAttachmentToComposer(attachment) {
    // 这一段复用 Codex 官方 pasted-files 管线；本地/远程附件处理继续交给 Codex 自己判断。
    // Reuse Codex's official pasted-files pipeline so local and remote attachment handling stays native.
    const controller = findComposerController();
    const path = String(attachment?.fsPath || attachment?.path || "");
    if (!controller?.eventEmitter || !path) return false;
    try {
      const pastedFile = createPastedFileLike(attachment);
      controller.eventEmitter.emit("pasted-files", [pastedFile]);
      return true;
    } catch (error) {
      // 这一段只兜住同步抛错，异步上传/转换失败仍由 Codex 官方提示负责。
      // Catch only synchronous failures; async upload/convert errors remain handled by native Codex UI.
      console.warn("[Codex-Pro] failed to emit pasted file attachment", getAttachmentWarningSummary(attachment), error);
      return false;
    }
  }

  function createLocalFileAttachment(path, label = "") {
    // 这一段把受信本机路径封装成 Codex 官方附件状态需要的最小对象。
    // Wrap a trusted local path into the minimal object Codex's native attachment state expects.
    const fsPath = String(path || "");
    return {
      fsPath,
      label: String(label || "").trim() || getFileName(fsPath),
      path: fsPath,
    };
  }

  runtime.registerSystem(systemName, () => {
    const controller = new AbortController();
    runtime.lifecycle?.replaceController?.(systemName, controller);
    const { signal } = controller;
    let activeAttachment = null;
    let activePointerDrag = null;
    const attachmentApi = {
      addLocalFileAttachment: addAttachmentToComposer,
      createLocalFileAttachment,
      isComposerDropEvent: (event) => isPointInElement(event, findComposerDropRegion()),
    };

    // 这一段把“本地文件添加为当前消息附件”的官方入口暴露给其它注入系统复用。
    // Expose the native "local file as current message attachment" entrypoint for other injected systems.
    Object.assign(tabDragToChat, attachmentApi);

    function clearActiveDrag() {
      // 这一段清空本次内部拖拽状态，避免下一次普通拖拽误复用旧路径。
      // Clear the current internal drag state so the next normal drag cannot reuse a stale path.
      activeAttachment = null;
      activePointerDrag = null;
    }

    function getDropAttachment(event) {
      // 这一段优先使用内存里的拖拽状态，再兼容 dataTransfer 自定义数据。
      // Prefer in-memory drag state, then fall back to the custom dataTransfer payload.
      if (activeAttachment) return activeAttachment;
      const rawPath = event.dataTransfer?.getData?.(dragDataType);
      return decodeTabId(rawPath ? `${fileTabPrefix}${rawPath}` : "");
    }

    function handleDragStart(event) {
      // 这一段只记录右侧文件标签拖拽，不阻止 Codex 原生标签拖动逻辑。
      // Record only right-side file tab drags without blocking Codex's native tab drag logic.
      const attachment = findDraggedFileTab(event.target);
      if (!attachment) return;
      activeAttachment = attachment;
      try {
        event.dataTransfer?.setData?.(dragDataType, attachment.path);
      } catch {
        // 这一段忽略 dataTransfer 写入失败，内存状态仍可完成同页拖放。
        // Ignore dataTransfer write failures because in-memory state can still finish same-page drops.
      }
    }

    function getPointerKey(event) {
      // 这一段给 pointer 和 mouse fallback 统一生成本次拖拽的指针标识。
      // Build a shared pointer id for PointerEvent and the mouse fallback path.
      return Number.isFinite(event.pointerId) ? event.pointerId : "mouse";
    }

    function getPointerDistance(drag, event) {
      // 这一段计算从标签按下到当前位置的位移，用于区分点击和真实拖拽。
      // Compute movement from tab press to the current pointer position so clicks are not treated as drags.
      return Math.hypot(event.clientX - drag.startX, event.clientY - drag.startY);
    }

    function startPointerDrag(event) {
      // 这一段记录 Codex 标签栏自己的 pointer 拖拽，因为真实标签拖动不一定触发浏览器 dragstart。
      // Record Codex's pointer-based tab drag because real tab dragging may not emit browser dragstart.
      if (event.button !== 0) return;
      const attachment = findDraggedFileTab(event.target);
      if (!attachment) return;
      activePointerDrag = {
        attachment,
        hasDragged: false,
        pointerKey: getPointerKey(event),
        startX: event.clientX,
        startY: event.clientY,
      };
    }

    function updatePointerDrag(event) {
      // 这一段只跟踪同一个指针，并在超过阈值后标记为真实拖拽。
      // Track only the same pointer and mark it as a real drag after the movement threshold.
      const drag = activePointerDrag;
      if (!drag || drag.pointerKey !== getPointerKey(event)) return;
      if (Number.isFinite(event.buttons) && (event.buttons & 1) !== 1) {
        clearActiveDrag();
        return;
      }
      if (getPointerDistance(drag, event) >= pointerDragThresholdPx) {
        drag.hasDragged = true;
      }
    }

    function finishPointerDrag(event) {
      // 这一段在真实标签拖拽松手时检查落点，落在 composer 内才添加附件。
      // On pointer release, add the tab as an attachment only when the real drag ends inside the composer.
      const drag = activePointerDrag;
      if (!drag || drag.pointerKey !== getPointerKey(event)) return;
      activePointerDrag = null;
      if (!drag.hasDragged && getPointerDistance(drag, event) < pointerDragThresholdPx) return;
      if (!isPointInElement(event, findComposerDropRegion())) return;
      if (!addAttachmentToComposer(drag.attachment)) {
        console.warn("[Codex-Pro] unable to add dragged tab to chat", drag.attachment.path);
      }
    }

    function handleDragOver(event) {
      // 这一段只在内部文件标签拖到 composer 上时允许 drop，其它拖拽继续交给 Codex 原生处理。
      // Allow drop only when an internal file tab is over the composer; all other drags stay native.
      if (!getDropAttachment(event)) return;
      if (!isPointInElement(event, findComposerDropRegion())) return;
      event.preventDefault();
      if (event.dataTransfer) event.dataTransfer.dropEffect = "copy";
    }

    function handleDrop(event) {
      // 这一段在 composer 范围内接管内部 tab drop，并把文件追加到当前消息附件。
      // Handle internal tab drops inside the composer and append the file to the current message attachments.
      const attachment = getDropAttachment(event);
      if (!attachment || !isPointInElement(event, findComposerDropRegion())) return;
      event.preventDefault();
      event.stopPropagation();
      if (!addAttachmentToComposer(attachment)) {
        console.warn("[Codex-Pro] unable to add dragged tab to chat", attachment.path);
      }
      clearActiveDrag();
    }

    document.addEventListener("dragstart", handleDragStart, { capture: true, signal });
    document.addEventListener("dragover", handleDragOver, { capture: true, signal });
    document.addEventListener("drop", handleDrop, { capture: true, signal });
    document.addEventListener("dragend", clearActiveDrag, { capture: true, signal });
    document.addEventListener("dragcancel", clearActiveDrag, { capture: true, signal });
    document.addEventListener("pointerdown", startPointerDrag, { capture: true, signal });
    document.addEventListener("pointermove", updatePointerDrag, { capture: true, signal });
    document.addEventListener("pointerup", finishPointerDrag, { capture: true, signal });
    document.addEventListener("pointercancel", clearActiveDrag, { capture: true, signal });
    window.addEventListener("blur", clearActiveDrag, { signal });

    if (!window.PointerEvent) {
      // 这一段只在没有 PointerEvent 的环境启用 mouse fallback，避免现代 Electron 里重复处理。
      // Enable the mouse fallback only without PointerEvent so modern Electron does not process drags twice.
      document.addEventListener("mousedown", startPointerDrag, { capture: true, signal });
      document.addEventListener("mousemove", updatePointerDrag, { capture: true, signal });
      document.addEventListener("mouseup", finishPointerDrag, { capture: true, signal });
    }

    controller.signal.addEventListener("abort", () => {
      // 这一段关闭共享附件 helper，保证设置关闭后同步侧栏不会继续复用旧入口。
      // Disable the shared attachment helper when the setting is turned off so the sync sidebar cannot reuse stale entrypoints.
      for (const [key, value] of Object.entries(attachmentApi)) {
        if (tabDragToChat[key] === value) delete tabDragToChat[key];
      }
    }, { once: true });
  }, { enableSetting: "enableTabDragToChat" });
})();
