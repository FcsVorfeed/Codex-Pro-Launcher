(() => {
  const runtime = window.__codexProRuntime;
  if (!runtime?.registerSystem) return;

  const systemName = "chat-line-hover";
  const styleId = "codex-pro-chat-line-hover-style";
  const lineId = "codex-pro-chat-line-hover";
  const pointTolerancePixels = 3;
  const minimumLineWidthPixels = 12;
  const chatTextRootSelector = [
    "[data-selected-text-overlay-target]",
    "[data-user-message-bubble='true'] [class*='whitespace-pre-wrap']",
    "[class*='_markdownContent_']",
  ].join(",");
  const excludedAncestorSelector = [
    "#codex-pro-settings-root",
    "#codex-pro-diff-hover-preview",
    "#codex-pro-conversation-archive-sidebar-root",
    "#codex-pro-conversation-archive-sidebar-panel",
    "#codex-pro-mouse-gesture-root",
    "#codex-pro-native-thread-drag-to-chat-ghost",
    "[data-codex-composer='true']",
    ".ProseMirror",
    "textarea",
    "input",
    "select",
    "button",
    "nav",
    "aside",
    "header",
    "footer",
    "[role='dialog']",
    "[role='menu']",
    "[contenteditable='true']",
  ].join(",");

  function installStyles() {
    // 这一段只安装一个不接收鼠标事件的细线节点样式，避免影响 Codex 原生交互。
    // Install only one pointer-transparent line node so Codex's native interactions stay untouched.
    runtime.dom.upsertStyle(
      styleId,
      `
        #${lineId} {
          position: fixed;
          z-index: 2147482300;
          height: 1px;
          min-width: ${minimumLineWidthPixels}px;
          background: color-mix(in srgb, CanvasText 38%, transparent);
          border-radius: 999px;
          box-shadow: 0 0 0 0.5px color-mix(in srgb, CanvasText 10%, transparent);
          opacity: 0;
          pointer-events: none;
          transform: translate3d(0, 0, 0);
          transition:
            opacity 140ms ease,
            left 70ms cubic-bezier(0.2, 0, 0.2, 1),
            top 70ms cubic-bezier(0.2, 0, 0.2, 1),
            width 70ms cubic-bezier(0.2, 0, 0.2, 1);
          user-select: none;
          will-change: left, top, width, opacity;
          -webkit-user-select: none;
        }
        #${lineId}[data-codex-pro-chat-line-hover-visible="true"] {
          opacity: 0.82;
        }
      `,
    );
  }

  function ensureLine(signal) {
    // 这一段复用唯一 overlay 节点，重复注入或设置重开时不会叠加多条线。
    // Reuse one overlay node so reinjection or setting toggles never stack multiple lines.
    let line = document.getElementById(lineId);
    if (!line) {
      line = document.createElement("div");
      line.id = lineId;
      line.setAttribute("aria-hidden", "true");
      document.body?.appendChild(line);
    }
    line.hidden = false;
    line.dataset.codexProChatLineHoverVisible = "false";
    signal.addEventListener("abort", () => line.remove(), { once: true });
    return line;
  }

  function isUsableRect(rect) {
    // 这一段过滤空矩形和视口外矩形，避免隐藏节点或折叠文本产生误判。
    // Filter empty and off-viewport rectangles so hidden or collapsed text cannot place the line.
    if (!rect || rect.width <= 0 || rect.height <= 0) return false;
    if (rect.bottom < 0 || rect.top > window.innerHeight) return false;
    return rect.right >= 0 && rect.left <= window.innerWidth;
  }

  function rectContainsY(rect, y) {
    // 这一段只按纵向命中当前行，允许鼠标在行尾空白处仍能稳定落到该行。
    // Match the current line by vertical overlap so trailing whitespace still keeps a stable line.
    return y >= rect.top - pointTolerancePixels && y <= rect.bottom + pointTolerancePixels;
  }

  function rectContainsPoint(rect, x, y) {
    // 这一段用于文本节点扫描兜底，只接受鼠标真正压在文本片段附近的矩形。
    // Use this for local text-node fallback scans, accepting only fragments near the pointer.
    return rectContainsY(rect, y) &&
      x >= rect.left - pointTolerancePixels &&
      x <= rect.right + pointTolerancePixels;
  }

  function parseCssPixels(value) {
    // 这一段只把 CSS 像素字符串转换为数字，非法值按 0 处理以保持布局计算可用。
    // Convert CSS pixel strings into numbers and treat invalid values as 0 so layout math stays usable.
    const number = Number.parseFloat(value);
    return Number.isFinite(number) ? number : 0;
  }

  function getParentElement(node) {
    // 这一段把文本节点和元素节点统一转换成可继续向上检查的元素。
    // Normalize text and element nodes into an element that can be walked upward.
    if (node instanceof HTMLElement) return node;
    return node?.parentElement || null;
  }

  function isVisibleElement(element) {
    // 这一段只接受真实可见元素，避免隐藏面板、旧 DOM 或过渡节点参与命中。
    // Accept only truly visible elements so hidden panels, stale DOM, or transition nodes do not match.
    if (!(element instanceof HTMLElement)) return false;
    const rect = element.getBoundingClientRect();
    if (rect.width <= 0 || rect.height <= 0) return false;
    const style = window.getComputedStyle(element);
    return style.display !== "none" && style.visibility !== "hidden" && Number(style.opacity) !== 0;
  }

  function findChatTextRoot(textNode) {
    // 这一段正向定位聊天消息正文 root，新窗口或状态浮窗不会仅因为在 main 里就被接受。
    // Positively locate the chat-message text root so panels are not accepted merely because they live in main.
    const parent = getParentElement(textNode);
    if (!parent || parent.closest(excludedAncestorSelector)) return null;
    const textRoot = parent.closest(chatTextRootSelector);
    if (!(textRoot instanceof HTMLElement) || !isVisibleElement(textRoot)) return null;
    const messageUnit = textRoot.closest("[data-content-search-unit-key]");
    if (!(messageUnit instanceof HTMLElement) || !messageUnit.closest("main")) return null;
    const messageKey = String(messageUnit.getAttribute("data-content-search-unit-key") || "");
    if (!/:(assistant|user)$/u.test(messageKey)) return null;
    return textRoot;
  }

  function isChatTextNode(textNode) {
    // 这一段只接受真实聊天消息正文里的文本节点，不依赖任何中文或英文界面文案。
    // Accept only text nodes inside real chat-message text roots, never localized UI copy.
    if (textNode?.nodeType !== Node.TEXT_NODE || !String(textNode.nodeValue || "").trim()) return false;
    const parent = getParentElement(textNode);
    if (!parent || !isVisibleElement(parent)) return false;
    return Boolean(findChatTextRoot(textNode));
  }

  function getCaretRangeFromPoint(x, y) {
    // 这一段优先使用 Chromium 的 caretRangeFromPoint，兼容实现再尝试标准 caretPositionFromPoint。
    // Prefer Chromium's caretRangeFromPoint and fall back to the standard caretPositionFromPoint shape.
    if (typeof document.caretRangeFromPoint === "function") {
      return document.caretRangeFromPoint(x, y);
    }
    if (typeof document.caretPositionFromPoint !== "function") return null;
    const position = document.caretPositionFromPoint(x, y);
    if (!position?.offsetNode) return null;
    const range = document.createRange();
    range.setStart(position.offsetNode, position.offset);
    range.collapse(true);
    return range;
  }

  function findTextNodeFromCaret(x, y) {
    // 这一段从鼠标点直接读取最近文本节点，避免遍历聊天记录或 React 树。
    // Read the nearest text node directly from the pointer point, avoiding chat-log or React-tree scans.
    const range = getCaretRangeFromPoint(x, y);
    const node = range?.startContainer || null;
    return node?.nodeType === Node.TEXT_NODE && isChatTextNode(node) ? node : null;
  }

  function findTextNodeInsideElement(element, x, y) {
    // 这一段只在当前命中元素内部做小范围兜底扫描，最多检查少量文本节点。
    // Fallback-scan only inside the hit element and cap the work to a small number of text nodes.
    if (!(element instanceof HTMLElement) || !isVisibleElement(element)) return null;
    const walker = document.createTreeWalker(element, NodeFilter.SHOW_TEXT);
    let visited = 0;
    for (let node = walker.nextNode(); node && visited < 80; node = walker.nextNode(), visited += 1) {
      if (!isChatTextNode(node)) continue;
      const rect = getTextNodePointRect(node, x, y);
      if (rect) return node;
    }
    return null;
  }

  function findTextNodeAtPoint(x, y) {
    // 这一段先走浏览器点命中，只有边界命不中时才扫描当前元素内部。
    // Use browser point hit-testing first and scan only the hit element when the point is on an edge.
    const caretNode = findTextNodeFromCaret(x, y);
    if (caretNode) return caretNode;
    const hitElement = document.elementFromPoint(x, y);
    if (getParentElement(hitElement)?.closest(excludedAncestorSelector)) return null;
    return findTextNodeInsideElement(hitElement, x, y);
  }

  function getRangeRects(range) {
    // 这一段把 RangeClientRectList 转成稳定数组，并统一过滤不可用矩形。
    // Convert RangeClientRectList into a stable array and filter unusable rectangles consistently.
    return Array.from(range.getClientRects()).filter(isUsableRect);
  }

  function getTextNodePointRect(textNode, x, y) {
    // 这一段只选中文本节点本身，拿到浏览器已经分好的可视行矩形。
    // Select only the text node itself and read browser-produced visual line rectangles.
    const range = document.createRange();
    range.selectNodeContents(textNode);
    const rects = getRangeRects(range);
    range.detach?.();
    return rects.find((rect) => rectContainsPoint(rect, x, y)) ||
      rects.find((rect) => rectContainsY(rect, y)) ||
      null;
  }

  function isLineBlockCandidate(element) {
    // 这一段寻找局部文本块，不跨到整条消息或整页，避免大上下文产生昂贵布局读取。
    // Find a local text block without climbing to an entire message or page, avoiding costly large-context layout reads.
    if (!(element instanceof HTMLElement) || !isVisibleElement(element)) return false;
    const tagName = element.tagName;
    if (/^(P|LI|PRE|BLOCKQUOTE|H1|H2|H3|H4|H5|H6|TD|TH)$/u.test(tagName)) return true;
    const style = window.getComputedStyle(element);
    return style.display === "block" || style.display === "list-item";
  }

  function findLineBlock(textNode) {
    // 这一段从文本节点向上找最近的局部文本块，找不到时回到父元素。
    // Walk upward from the text node to the nearest local text block, falling back to the parent.
    const parent = getParentElement(textNode);
    const textRoot = findChatTextRoot(textNode);
    for (let element = parent; element instanceof HTMLElement && element !== document.body; element = element.parentElement) {
      if (element.closest(excludedAncestorSelector)) return parent;
      if (isLineBlockCandidate(element)) return element;
      if (element === textRoot) break;
    }
    return parent;
  }

  function getLineBlockContentRect(block) {
    // 这一段读取最近局部文本块的内容盒宽度，避免测量整段聊天文本。
    // Read the nearest local text block's content box width without measuring the whole chat text.
    if (!(block instanceof HTMLElement)) return null;
    const blockRect = block.getBoundingClientRect();
    if (!isUsableRect(blockRect)) return null;
    const style = window.getComputedStyle(block);
    const left = blockRect.left +
      parseCssPixels(style.borderLeftWidth) +
      parseCssPixels(style.paddingLeft);
    const right = blockRect.right -
      parseCssPixels(style.borderRightWidth) -
      parseCssPixels(style.paddingRight);
    if (right - left < minimumLineWidthPixels) return null;
    return {
      bottom: blockRect.bottom,
      left,
      right,
      top: blockRect.top,
    };
  }

  function getExpandedLineRect(textNode, sourceRect, y) {
    // 这一段把线条横向扩展到当前文本块内容宽度，纵向仍锁定当前命中文本行。
    // Expand the line horizontally to the current text block content width while keeping the hit row vertically locked.
    const block = findLineBlock(textNode);
    const contentRect = getLineBlockContentRect(block);
    if (!contentRect || !rectContainsY(contentRect, y)) return sourceRect;
    return {
      bottom: sourceRect.bottom,
      left: contentRect.left,
      right: contentRect.right,
      top: sourceRect.top,
    };
  }

  function computeLineRect(x, y, options = {}) {
    // 这一段完成一次鼠标坐标到行矩形的转换；失败时返回 null 让 UI 隐藏。
    // Convert one pointer coordinate into a line rectangle; return null on any miss so the UI hides.
    const textNode = findTextNodeAtPoint(x, y);
    if (!textNode) return null;
    const textRect = getTextNodePointRect(textNode, x, y);
    if (!textRect) return null;
    const lineRect = options.expandToLine === true
      ? getExpandedLineRect(textNode, textRect, y)
      : textRect;
    const left = Math.max(0, Math.floor(lineRect.left));
    const right = Math.min(window.innerWidth, Math.ceil(lineRect.right));
    if (right - left < minimumLineWidthPixels) return null;
    return {
      bottom: Math.min(window.innerHeight, Math.ceil(lineRect.bottom)),
      left,
      width: right - left,
    };
  }

  function placeLine(line, rect) {
    // 这一段只写入 overlay 的几何样式，不改任何 Codex 原生节点。
    // Write only overlay geometry styles without mutating any native Codex nodes.
    if (!rect) {
      line.dataset.codexProChatLineHoverVisible = "false";
      return;
    }
    line.style.left = `${rect.left}px`;
    line.style.top = `${rect.bottom + 1}px`;
    line.style.width = `${rect.width}px`;
    line.dataset.codexProChatLineHoverVisible = "true";
  }

  runtime.registerSystem(systemName, () => {
    const controller = new AbortController();
    runtime.lifecycle.replaceController(systemName, controller);
    runtime.lifecycle.replaceWindowController("__codexProChatLineHoverController", controller);

    installStyles();
    const line = ensureLine(controller.signal);
    let expandToLine = (runtime.systemModules.settingsMenu?.settings?.getSettings?.() || {}).expandChatLineHoverToLine === true;
    let frameId = 0;
    let lastPointer = null;

    function hideLine() {
      // 这一段在鼠标离开、滚出页面或功能停止时隐藏线条。
      // Hide the line when the pointer leaves, scrolls out, or the feature stops.
      line.dataset.codexProChatLineHoverVisible = "false";
    }

    function scheduleUpdate(pointer) {
      // 这一段把高频 pointermove 合并到下一帧，每帧最多做一次点命中和布局读取。
      // Coalesce high-frequency pointermove events into the next frame with at most one hit-test/layout read.
      lastPointer = pointer || lastPointer;
      if (frameId) return;
      frameId = window.requestAnimationFrame(() => {
        frameId = 0;
        if (!lastPointer) {
          hideLine();
          return;
        }
        placeLine(line, computeLineRect(lastPointer.x, lastPointer.y, { expandToLine }));
      });
    }

    function handlePointerMove(event) {
      // 这一段只记录当前坐标，实际 DOM 命中延后到 requestAnimationFrame。
      // Record only the current coordinate; actual DOM hit-testing is deferred to requestAnimationFrame.
      scheduleUpdate({ x: event.clientX, y: event.clientY });
    }

    function handlePointerLeave() {
      // 这一段清空坐标，避免窗口外或辅助面板里留下旧线条。
      // Clear coordinates so old lines do not remain outside the window or over auxiliary panels.
      lastPointer = null;
      hideLine();
    }

    function handleViewportChange() {
      // 这一段在滚动或窗口变化后用最后坐标重算，内容移走时会自动隐藏。
      // Recompute after scroll or resize with the last coordinate; hide automatically if content moved away.
      if (lastPointer) scheduleUpdate(lastPointer);
    }

    window.addEventListener("pointermove", handlePointerMove, { passive: true, signal: controller.signal });
    window.addEventListener("pointerleave", handlePointerLeave, { signal: controller.signal });
    window.addEventListener("blur", handlePointerLeave, { signal: controller.signal });
    window.addEventListener("scroll", handleViewportChange, { capture: true, passive: true, signal: controller.signal });
    window.addEventListener("resize", handleViewportChange, { passive: true, signal: controller.signal });
    controller.signal.addEventListener("abort", () => {
      if (frameId) window.cancelAnimationFrame(frameId);
      hideLine();
      document.getElementById(styleId)?.remove();
    }, { once: true });

    return {
      sync(settings = {}) {
        // 这一段设置变化时只按最后鼠标位置重算；开关关闭由 runtime 统一 abort。
        // On setting changes, just recompute against the last pointer; runtime handles abort when disabled.
        expandToLine = settings.expandChatLineHoverToLine === true;
        if (lastPointer) scheduleUpdate(lastPointer);
      },
    };
  }, { enableSetting: "enableChatLineHover" });
})();
