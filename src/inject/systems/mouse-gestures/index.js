(() => {
  const runtime = window.__codexProRuntime;
  if (!runtime) return;
  const i18n = runtime.i18n;

  const rootId = "codex-pro-mouse-gesture-root";
  const styleId = "codex-pro-mouse-gesture-style";
  const activationDistancePx = 6;
  const segmentDistancePx = 22;
  const maxGestureMs = 5000;
  const maxTrailPoints = 120;

  function installOverlay() {
    // 这一段安装手势轨迹样式，固定根节点只显示本系统自己的临时反馈。
    // Install gesture-trail styles; the fixed root only shows this system's transient feedback.
    runtime.dom.upsertStyle(
      styleId,
      `
        #${rootId} {
          position: fixed;
          inset: 0;
          z-index: 2147483590;
          display: none;
          pointer-events: none;
          -webkit-app-region: no-drag;
        }
        #${rootId}.codex-pro-mouse-gesture-active {
          display: block;
        }
        #${rootId} .codex-pro-mouse-gesture-trail {
          position: absolute;
          inset: 0;
          width: 100%;
          height: 100%;
        }
        #${rootId} .codex-pro-mouse-gesture-line {
          fill: none;
          stroke: #38bdf8;
          stroke-width: 3.5;
          stroke-linecap: round;
          stroke-linejoin: round;
          filter: drop-shadow(0 1px 4px rgba(0, 0, 0, .42));
        }
        #${rootId} .codex-pro-mouse-gesture-label {
          position: fixed;
          max-width: 140px;
          transform: translate(14px, 12px);
          border: 1px solid color-mix(in srgb, #38bdf8 52%, transparent);
          border-radius: 8px;
          background: color-mix(in srgb, var(--color-token-dropdown-background, #1f2937) 94%, transparent);
          color: var(--color-token-foreground, #f8fafc);
          box-shadow: 0 10px 30px rgba(0, 0, 0, .28);
          font: 12px/1.35 system-ui, -apple-system, BlinkMacSystemFont, "Segoe UI", sans-serif;
          padding: 7px 9px;
          white-space: nowrap;
          overflow: hidden;
          text-overflow: ellipsis;
        }
      `,
    );

    // 这一段创建或复用轨迹根节点，重复注入时会覆盖旧结构。
    // Create or reuse the trail root and replace stale markup during reinjection.
    const root = runtime.dom.ensureRoot(rootId);
    root.innerHTML = `
      <svg class="codex-pro-mouse-gesture-trail" aria-hidden="true">
        <polyline class="codex-pro-mouse-gesture-line" points=""></polyline>
      </svg>
      <div class="codex-pro-mouse-gesture-label" aria-hidden="true">
        <span class="codex-pro-mouse-gesture-action"></span>
      </div>
    `;
    return root;
  }

  function uninstallOverlay() {
    // 这一段移除轨迹 DOM 和样式，确保禁用或重新注入后没有残留遮罩。
    // Remove trail DOM and styles so disabling or reinjection leaves no overlay behind.
    document.getElementById(rootId)?.remove();
    document.getElementById(styleId)?.remove();
  }

  function isElement(value) {
    // 这一段用跨上下文安全判断过滤非元素节点，避免 closest 调用异常。
    // Filter non-element nodes safely before calling closest.
    return value instanceof Element;
  }

  function isCodexProTarget(target) {
    // 这一段跳过 Codex-Pro 自己的浮层，避免设置弹窗和轨迹层触发手势。
    // Skip Codex-Pro overlays so settings dialogs and trail nodes do not start gestures.
    if (!isElement(target)) return false;
    return Boolean(target.closest(`#${rootId}, #codex-pro-settings-root`));
  }

  function shouldStartGesture(event, enabled) {
    // 这一段只接受未被拦截的鼠标中键按下，普通点击、右键和触控笔不进入手势状态。
    // Accept only unhandled middle-button mouse presses; normal clicks, secondary clicks, and pens do not enter gesture state.
    if (!enabled || event.defaultPrevented || event.button !== 1) return false;
    if (event.pointerType && event.pointerType !== "mouse") return false;
    if (event.buttons && (event.buttons & 4) !== 4) return false;
    return !isCodexProTarget(event.target);
  }

  function getEventPointerId(event) {
    // 这一段兼容 PointerEvent 和 MouseEvent，让中键拖动在 Electron 未派发 PointerEvent 时也可用。
    // Support both PointerEvent and MouseEvent so middle-drag works when Electron does not dispatch PointerEvent.
    return Number.isFinite(event.pointerId) ? event.pointerId : "mouse";
  }

  function distance(left, top, right, bottom) {
    // 这一段计算起点到当前点的欧氏距离，用于区分普通中键点击和真实手势。
    // Calculate Euclidean distance so ordinary middle-clicks stay separate from real gestures.
    return Math.hypot(right - left, bottom - top);
  }

  function getDirection(fromX, fromY, toX, toY) {
    // 这一段把移动向量压缩成四向方向码，保持 Edge 风格的简单手势。
    // Compress the movement vector into four-way direction codes for Edge-style simple gestures.
    const dx = toX - fromX;
    const dy = toY - fromY;
    if (Math.abs(dx) >= Math.abs(dy)) return dx >= 0 ? "R" : "L";
    return dy >= 0 ? "D" : "U";
  }

  function compactDirectionList(directions) {
    // 这一段把连续重复方向合并，减少手抖造成的重复码。
    // Merge consecutive duplicate directions to reduce jitter-driven repeated codes.
    return directions.filter((direction, index) => index === 0 || direction !== directions[index - 1]).join("");
  }

  function renderOverlay(root, gesture, gestureShortcuts) {
    // 这一段更新轨迹线、当前动作文字和提示位置，避免方向码撑宽浮层。
    // Update trail line, current action text, and label position without letting direction codes stretch the overlay.
    const line = root.querySelector(".codex-pro-mouse-gesture-line");
    const label = root.querySelector(".codex-pro-mouse-gesture-label");
    const actionNode = root.querySelector(".codex-pro-mouse-gesture-action");
    const code = compactDirectionList(gesture.directions);
    const shortcut = code ? gestureShortcuts?.[code] || "" : "";
    line?.setAttribute("points", gesture.points.map((point) => `${point.x},${point.y}`).join(" "));
    if (label) {
      label.style.left = `${gesture.lastX}px`;
      label.style.top = `${gesture.lastY}px`;
    }
    if (actionNode) actionNode.textContent = code ? shortcut || i18n.t("mouseGestures.overlay.unset") : i18n.t("mouseGestures.overlay.gesture");
    root.classList.toggle("codex-pro-mouse-gesture-active", gesture.activated);
  }

  function hideOverlay(root) {
    // 这一段隐藏轨迹并清空点位，避免下一次手势看到旧线段。
    // Hide the trail and clear points so the next gesture never shows stale lines.
    root.classList.remove("codex-pro-mouse-gesture-active");
    root.querySelector(".codex-pro-mouse-gesture-line")?.setAttribute("points", "");
  }

  function addTrailPoint(gesture, x, y) {
    // 这一段限制轨迹点数量，避免长时间按住中键造成数组持续增长。
    // Cap trail points so holding middle-click for a long time cannot grow the array indefinitely.
    gesture.points.push({ x, y });
    if (gesture.points.length > maxTrailPoints) gesture.points.shift();
  }

  function addDirectionPoint(gesture, x, y) {
    // 这一段只在移动超过分段阈值后记录方向，降低细微抖动误识别。
    // Record a direction only after the segment threshold to reduce tiny jitter false positives.
    if (distance(gesture.anchorX, gesture.anchorY, x, y) < segmentDistancePx) return;
    gesture.directions.push(getDirection(gesture.anchorX, gesture.anchorY, x, y));
    gesture.anchorX = x;
    gesture.anchorY = y;
  }

  function releasePointerCapture(gesture) {
    // 这一段尽力释放 pointer capture，失败时不影响主流程复位。
    // Best-effort release of pointer capture; failures do not block state reset.
    if (!Number.isFinite(gesture?.pointerId)) return;
    try {
      if (gesture?.captureTarget?.hasPointerCapture?.(gesture.pointerId)) {
        gesture.captureTarget.releasePointerCapture(gesture.pointerId);
      }
    } catch {
      // 这一段故意忽略释放失败，因为后续 abort 和超时仍会清理状态。
      // Intentionally ignore release failures because abort and timeout still clean state.
    }
  }

  function capturePointer(event) {
    // 这一段尽力捕获中键指针，让目标 DOM 变化时仍能收到后续事件。
    // Best-effort capture of the middle-button pointer so later events survive target DOM changes.
    if (!Number.isFinite(event.pointerId)) return null;
    const target = isElement(event.target) ? event.target : document.documentElement;
    try {
      target.setPointerCapture?.(event.pointerId);
    } catch {
      // 这一段故意忽略捕获失败，document 捕获阶段监听仍提供兜底。
      // Intentionally ignore capture failures; document capture listeners still provide a fallback.
    }
    return target;
  }

  function createMiddleClickSnapshot(event) {
    // 这一段保存原始中键按下信息，普通点击被入口拦截后可用它重放点击序列。
    // Save the original middle-button down data so ordinary clicks can be replayed after entry interception.
    return {
      altKey: event.altKey,
      clientX: event.clientX,
      clientY: event.clientY,
      ctrlKey: event.ctrlKey,
      metaKey: event.metaKey,
      pointerId: Number.isFinite(event.pointerId) ? event.pointerId : 1,
      screenX: event.screenX,
      screenY: event.screenY,
      shiftKey: event.shiftKey,
      target: isElement(event.target) ? event.target : null,
    };
  }

  function getMiddleClickReplayTarget(snapshot) {
    // 这一段优先回放到原始目标，目标已卸载时退回当前坐标下的元素。
    // Prefer the original target, falling back to the element under the original point if it was removed.
    if (snapshot.target?.isConnected) return snapshot.target;
    return document.elementFromPoint(snapshot.clientX, snapshot.clientY) || document.body || document.documentElement;
  }

  function createReplayedMouseEvent(type, snapshot, buttons) {
    // 这一段构造中键 MouseEvent，补齐坐标和修饰键，供页面自己的监听器识别。
    // Build a middle-button MouseEvent with coordinates and modifiers for page-level listeners.
    return new MouseEvent(type, {
      altKey: snapshot.altKey,
      bubbles: true,
      button: 1,
      buttons,
      cancelable: true,
      clientX: snapshot.clientX,
      clientY: snapshot.clientY,
      composed: true,
      ctrlKey: snapshot.ctrlKey,
      detail: 1,
      metaKey: snapshot.metaKey,
      screenX: snapshot.screenX,
      screenY: snapshot.screenY,
      shiftKey: snapshot.shiftKey,
      view: window,
    });
  }

  function createReplayedPointerEvent(type, snapshot, buttons) {
    // 这一段在支持 PointerEvent 的环境中同步回放指针事件，覆盖只监听 pointer 的页面逻辑。
    // Replay pointer events where supported so page logic that listens only to pointer events is covered.
    if (!window.PointerEvent) return null;
    return new PointerEvent(type, {
      altKey: snapshot.altKey,
      bubbles: true,
      button: 1,
      buttons,
      cancelable: true,
      clientX: snapshot.clientX,
      clientY: snapshot.clientY,
      composed: true,
      ctrlKey: snapshot.ctrlKey,
      detail: 1,
      isPrimary: true,
      metaKey: snapshot.metaKey,
      pointerId: snapshot.pointerId,
      pointerType: "mouse",
      screenX: snapshot.screenX,
      screenY: snapshot.screenY,
      shiftKey: snapshot.shiftKey,
      view: window,
    });
  }

  function runGestureShortcut(code, gestureShortcuts) {
    // 这一段把方向码映射到用户配置的快捷键；未设置的手势保持无动作。
    // Map the gesture code to the configured shortcut; unset gestures intentionally do nothing.
    const shortcut = gestureShortcuts?.[code] || "";
    if (!shortcut) return;

    // 这一段只通过原生桥发送快捷键，桥不可用时记录并忽略，不再回退到页面操作。
    // Send the shortcut only through the native bridge; if unavailable, log and ignore without page-operation fallbacks.
    try {
      if (runtime.nativeBridge?.sendShortcut?.(shortcut)) return;
      console.warn(`[Codex-Pro] native bridge unavailable; gesture shortcut ignored: ${code} ${shortcut}`);
    } catch (error) {
      console.warn(`[Codex-Pro] mouse gesture shortcut failed: ${code} ${shortcut}`, error);
    }
  }

  runtime.registerSystem("mouse-gestures", () => {
    const settingsApi = runtime.systemModules.settingsMenu?.settings;

    // 这一段创建系统生命周期控制器，重复注入时会移除旧监听和轨迹层。
    // Create this system's lifecycle controller so reinjection removes old listeners and trail DOM.
    const controller = new AbortController();
    runtime.lifecycle.replaceController("mouse-gestures", controller);

    const root = installOverlay();
    const currentSettings = settingsApi?.getSettings?.() || {};
    let enabled = currentSettings.enableMouseGestures !== false;
    let gestureShortcuts = currentSettings.mouseGestureShortcuts || {};
    let gesture = null;
    let replayingMiddleClick = false;
    let suppressNextMiddleDefault = false;
    let middleDefaultSuppressTimeoutId = 0;

    function clearMiddleDefaultSuppression() {
      // 这一段清理中键默认行为抑制标记，避免下一次普通中键事件被误吞。
      // Clear middle-button default-action suppression so the next ordinary middle-click is not swallowed.
      suppressNextMiddleDefault = false;
      window.clearTimeout(middleDefaultSuppressTimeoutId);
      middleDefaultSuppressTimeoutId = 0;
    }

    function suppressUpcomingMiddleDefault() {
      // 这一段短时间抑制当前中键候选后的默认行为，防止 auxclick 没出现时标记残留。
      // Suppress the immediate middle-button default action so the flag cannot remain if no auxclick fires.
      suppressNextMiddleDefault = true;
      window.clearTimeout(middleDefaultSuppressTimeoutId);
      middleDefaultSuppressTimeoutId = window.setTimeout(clearMiddleDefaultSuppression, 1500);
    }

    function swallowGestureEvent(event) {
      // 这一段在手势确认后阻断中键自动滚动、链接打开等默认行为。
      // Block middle-button auto-scroll, link opening, and similar default behavior after a gesture is confirmed.
      event.preventDefault();
      event.stopPropagation();
      event.stopImmediatePropagation?.();
    }

    function dispatchReplayedMiddleClickEvent(target, event) {
      // 这一段把合成事件发给原目标，单个监听器异常不影响后续复位。
      // Dispatch a synthetic event to the original target; listener failures do not affect cleanup.
      try {
        target.dispatchEvent(event);
      } catch (error) {
        console.warn("[Codex-Pro] replayed middle-click event failed", error);
      }
    }

    function replayMiddleClick(snapshot) {
      // 这一段为普通中键点击补发完整事件序列，覆盖只依赖页面 JS 监听器的默认行为。
      // Replay a full event sequence for ordinary middle-clicks to cover page JS listeners.
      if (!snapshot) return;
      const target = getMiddleClickReplayTarget(snapshot);
      replayingMiddleClick = true;
      try {
        const pointerDown = createReplayedPointerEvent("pointerdown", snapshot, 4);
        const pointerUp = createReplayedPointerEvent("pointerup", snapshot, 0);
        if (pointerDown) dispatchReplayedMiddleClickEvent(target, pointerDown);
        dispatchReplayedMiddleClickEvent(target, createReplayedMouseEvent("mousedown", snapshot, 4));
        if (pointerUp) dispatchReplayedMiddleClickEvent(target, pointerUp);
        dispatchReplayedMiddleClickEvent(target, createReplayedMouseEvent("mouseup", snapshot, 0));
        dispatchReplayedMiddleClickEvent(target, createReplayedMouseEvent("auxclick", snapshot, 0));
      } finally {
        replayingMiddleClick = false;
      }
    }

    function resetGesture() {
      // 这一段集中清理当前手势、超时器、pointer capture 和轨迹层，所有中断路径都走这里。
      // Centralize cleanup for gesture state, timeout, pointer capture, and trail overlay across all interruption paths.
      if (!gesture) {
        hideOverlay(root);
        return;
      }
      const currentGesture = gesture;
      gesture = null;
      window.clearTimeout(currentGesture.timeoutId);
      releasePointerCapture(currentGesture);
      hideOverlay(root);
    }

    function startGesture(event) {
      // 这一段初始化中键手势候选状态，并在入口处阻断 Chromium 的中键自动滚动默认行为。
      // Initialize a middle-button gesture candidate and block Chromium's middle-button autoscroll default at the entry point.
      resetGesture();
      swallowGestureEvent(event);
      suppressUpcomingMiddleDefault();
      gesture = {
        activated: false,
        anchorX: event.clientX,
        anchorY: event.clientY,
        captureTarget: null,
        directions: [],
        lastX: event.clientX,
        lastY: event.clientY,
        middleClickSnapshot: createMiddleClickSnapshot(event),
        pointerId: getEventPointerId(event),
        points: [{ x: event.clientX, y: event.clientY }],
        startX: event.clientX,
        startY: event.clientY,
        timeoutId: window.setTimeout(resetGesture, maxGestureMs),
      };
    }

    function handlePointerDown(event) {
      // 这一段在捕获阶段启动手势候选，已有候选说明 window 阶段已经处理过同一事件。
      // Start a gesture candidate during capture; an existing candidate means the window phase already handled this event.
      if (replayingMiddleClick) return;
      if (gesture || !shouldStartGesture(event, enabled)) return;
      startGesture(event);
    }

    function handleMouseDown(event) {
      // 这一段作为 MouseEvent 兜底，PointerEvent 已经启动时只补拦截，不重复重置当前手势。
      // Act as a MouseEvent fallback; if PointerEvent already started, only block defaults without resetting the gesture.
      if (replayingMiddleClick) return;
      if (gesture && event.button === 1) {
        swallowGestureEvent(event);
        suppressUpcomingMiddleDefault();
        return;
      }
      if (!shouldStartGesture(event, enabled)) return;
      startGesture(event);
    }

    function isCurrentGestureEvent(event) {
      // 这一段只让当前活动指针或鼠标流更新状态，避免其它事件误取消手势。
      // Allow only the active pointer or mouse stream to update state so unrelated events do not cancel gestures.
      return Boolean(gesture) && getEventPointerId(event) === gesture.pointerId;
    }

    function updateGestureMove(event) {
      // 这一段处理当前指针的移动，禁用或按键释放时立即复位。
      // Handle active pointer movement; reset immediately when disabled or the middle button is released.
      if (!enabled || (event.buttons && (event.buttons & 4) !== 4)) {
        resetGesture();
        return;
      }

      // 这一段更新轨迹状态，入口已经拦截默认行为，移动超过阈值后才显示手势反馈。
      // Update trail state; the entry point already blocks defaults, and movement past the threshold shows gesture feedback.
      gesture.lastX = event.clientX;
      gesture.lastY = event.clientY;
      addTrailPoint(gesture, event.clientX, event.clientY);
      if (!gesture.activated && distance(gesture.startX, gesture.startY, event.clientX, event.clientY) >= activationDistancePx) {
        gesture.activated = true;
        gesture.captureTarget = capturePointer(event);
        suppressUpcomingMiddleDefault();
      }
      if (!gesture.activated) return;

      // 这一段记录方向并渲染反馈，所有 UI 更新都限制在本系统根节点里。
      // Record directions and render feedback, keeping all UI updates inside this system's root.
      swallowGestureEvent(event);
      addDirectionPoint(gesture, event.clientX, event.clientY);
      renderOverlay(root, gesture, gestureShortcuts);
    }

    function handlePointerMove(event) {
      // 这一段只处理当前 PointerEvent 流，鼠标兜底由 MouseEvent 单独处理。
      // Handle only the active PointerEvent stream; MouseEvent fallback is handled separately.
      if (!isCurrentGestureEvent(event)) return;
      updateGestureMove(event);
    }

    function handleMouseMove(event) {
      // 这一段处理没有 PointerEvent 时的鼠标移动兜底。
      // Handle mouse movement fallback when PointerEvent is not available for middle-drag.
      if (!isCurrentGestureEvent(event)) return;
      updateGestureMove(event);
    }

    function finishGesture(event) {
      // 这一段在中键松开时先提取方向码，再复位状态，最后执行命令避免动作失败导致锁住。
      // On middle-button release, extract the code, reset state first, then run the command so failures cannot lock state.
      const shouldRun = gesture.activated;
      const replaySnapshot = shouldRun ? null : gesture.middleClickSnapshot;
      let code = compactDirectionList(gesture.directions);
      if (shouldRun && !code) code = getDirection(gesture.startX, gesture.startY, gesture.lastX, gesture.lastY);
      if (shouldRun) {
        // 这一段只在真实手势后继续抑制 auxclick，避免手势结束后又触发原生中键动作。
        // Keep suppressing auxclick only after a real gesture so the native middle action does not run afterward.
        suppressUpcomingMiddleDefault();
        swallowGestureEvent(event);
      } else {
        // 这一段把普通中键点击还给页面，入口拦截仍负责防止候选阶段触发自动滚动。
        // Return ordinary middle-clicks to the page while the entry interception still prevents candidate autoscroll.
        clearMiddleDefaultSuppression();
      }
      resetGesture();
      if (!shouldRun) replayMiddleClick(replaySnapshot);
      if (shouldRun) runGestureShortcut(code, gestureShortcuts);
    }

    function handlePointerUp(event) {
      // 这一段结束当前 PointerEvent 手势，非当前指针事件直接忽略。
      // Finish the current PointerEvent gesture and ignore events from other pointers.
      if (replayingMiddleClick) return;
      if (!isCurrentGestureEvent(event)) return;
      finishGesture(event);
    }

    function handleMouseUp(event) {
      // 这一段结束 MouseEvent 兜底手势，兼容中键释放时 button 字段被归零的 Electron 情况。
      // Finish the MouseEvent fallback gesture, including Electron cases where middle-button release reports button as zero.
      if (replayingMiddleClick) return;
      if (!isCurrentGestureEvent(event) || (event.button !== 1 && event.buttons !== 0)) return;
      finishGesture(event);
    }

    function handleAuxClick(event) {
      // 这一段兜底阻断中键 auxclick，避免 Chromium 在 mouseup 后继续触发自动滚动或链接打开。
      // Block middle-button auxclick as a fallback so Chromium does not continue auto-scroll or link-opening behavior after mouseup.
      if (replayingMiddleClick) return;
      if (event.button !== 1 || (!gesture?.activated && !suppressNextMiddleDefault)) return;
      swallowGestureEvent(event);
      clearMiddleDefaultSuppression();
    }

    function handleHardCancel() {
      // 这一段处理窗口失焦、页面隐藏、pointercancel 等硬中断，统一安全复位。
      // Handle hard interruptions such as blur, hidden pages, and pointercancel with one safe reset path.
      clearMiddleDefaultSuppression();
      resetGesture();
    }

    // 这一段订阅设置变化，关闭开关时立即释放当前手势和可见轨迹。
    // Subscribe to setting changes; turning the switch off immediately releases active gesture state and visible trails.
    settingsApi?.subscribe?.((settings) => {
      enabled = settings.enableMouseGestures !== false;
      gestureShortcuts = settings.mouseGestureShortcuts || {};
      if (!enabled) handleHardCancel();
    }, controller.signal);

    // 这一段绑定全局捕获阶段事件，用同一个生命周期控制器保证重新注入自动卸载。
    // Bind global capture-phase events under one lifecycle controller so reinjection unloads them automatically.
    window.addEventListener("pointerdown", handlePointerDown, { capture: true, signal: controller.signal });
    window.addEventListener("pointermove", handlePointerMove, { capture: true, signal: controller.signal });
    window.addEventListener("pointerup", handlePointerUp, { capture: true, signal: controller.signal });
    window.addEventListener("pointercancel", handleHardCancel, { capture: true, signal: controller.signal });
    window.addEventListener("lostpointercapture", handleHardCancel, { capture: true, signal: controller.signal });
    window.addEventListener("mousedown", handleMouseDown, { capture: true, signal: controller.signal });
    window.addEventListener("mousemove", handleMouseMove, { capture: true, signal: controller.signal });
    window.addEventListener("mouseup", handleMouseUp, { capture: true, signal: controller.signal });
    window.addEventListener("auxclick", handleAuxClick, { capture: true, signal: controller.signal });
    document.addEventListener("pointerdown", handlePointerDown, { capture: true, signal: controller.signal });
    document.addEventListener("pointermove", handlePointerMove, { capture: true, signal: controller.signal });
    document.addEventListener("pointerup", handlePointerUp, { capture: true, signal: controller.signal });
    document.addEventListener("pointercancel", handleHardCancel, { capture: true, signal: controller.signal });
    document.addEventListener("lostpointercapture", handleHardCancel, { capture: true, signal: controller.signal });
    document.addEventListener("mousedown", handleMouseDown, { capture: true, signal: controller.signal });
    document.addEventListener("mousemove", handleMouseMove, { capture: true, signal: controller.signal });
    document.addEventListener("mouseup", handleMouseUp, { capture: true, signal: controller.signal });
    document.addEventListener("auxclick", handleAuxClick, { capture: true, signal: controller.signal });
    window.addEventListener("blur", handleHardCancel, { signal: controller.signal });
    document.addEventListener("visibilitychange", () => {
      if (document.hidden) handleHardCancel();
    }, { signal: controller.signal });
    window.addEventListener("keydown", (event) => {
      if (event.key === "Escape") handleHardCancel();
    }, { signal: controller.signal });

    // 这一段在系统卸载时清理所有残留状态，防止旧注入版本继续占用鼠标事件。
    // Clean all remaining state during teardown so older injected versions cannot keep mouse event ownership.
    controller.signal.addEventListener(
      "abort",
      () => {
        clearMiddleDefaultSuppression();
        resetGesture();
        uninstallOverlay();
      },
      { once: true },
    );
  }, { enableSetting: "enableMouseGestures" });
})();
