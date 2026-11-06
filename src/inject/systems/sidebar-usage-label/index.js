(() => {
  // 本系统只增强官方导航栏额度按钮，所有状态随控制器清理。
  // Enhance only the native navigation quota button and dispose all state with its controller.
  const runtime = window.__codexProRuntime;
  if (!runtime) return;
  const systemName = "sidebar-usage-label";
  const styleId = "codex-pro-sidebar-usage-label-style";
  const railSelector = "[data-app-navigation-rail]";
  const buttonAttribute = "data-codex-pro-sidebar-usage-button";
  const labelAttribute = "data-codex-pro-sidebar-usage-label";
  // 自有布局变量只保存文字上移量，卸载时移除。
  // The owned layout variable stores only the label lift and is removed on teardown.
  const liftProperty = "--codex-pro-sidebar-usage-lift";

  // 开关、热注入和卸载共用一个控制器，不创建网络请求或定时轮询。
  // Use one controller for toggles, reinjection and teardown without requests or polling.
  runtime.registerSystem(systemName, () => {
    const controller = new AbortController();
    runtime.lifecycle.replaceController(systemName, controller);
    let rail = null;
    let button = null;
    let label = null;
    let frame = 0;
    let layoutHost = null;

    // 复用头像顶部到圆圈底部的空白，作为文字底部到圆圈顶部的间距。
    // Match the avatar-top to ring-bottom gap above the ring, below the label.
    runtime.dom.upsertStyle(styleId, `
      [${buttonAttribute}] { position: relative; margin-block-start: var(${liftProperty}); }
      [${labelAttribute}] {
        position: absolute; inset-inline: 0; top: calc(-1 * var(${liftProperty}));
        display: block; height: 14px; line-height: 14px; font-size: 11px;
        font-weight: 500; font-variant-numeric: tabular-nums;
        text-align: center; white-space: nowrap; color: inherit;
        pointer-events: none; user-select: none;
      }
    `);

    // 只移除自有变量、标记和文字，保留原生样式、子节点和事件。
    // Remove only owned variables, markers and text, preserving native styles, children and events.
    function clearLabel() {
      label?.remove();
      button?.removeAttribute(buttonAttribute);
      button?.style.removeProperty(liftProperty);
      layoutObserver.disconnect();
      layoutHost = null;
      label = null;
      button = null;
    }

    // 限定在官方导航栏的语义指示器，并用额度 props 验证身份。
    // Limit discovery to semantic rail indicators and verify identity with quota props.
    function refresh() {
      frame = 0;
      if (controller.signal.aborted) return;
      const nextRail = document.querySelector(railSelector);
      if (nextRail !== rail) {
        railObserver.disconnect();
        clearLabel();
        rail = nextRail;
        if (rail) railObserver.observe(rail, {
          childList: true, subtree: true, attributes: true,
          attributeFilter: ["aria-description", "data-transition-phase"],
        });
      }
      let target = null;
      let text = null;
      for (const indicator of rail?.querySelectorAll("[data-transition-phase]") || []) {
        const candidate = indicator.closest("button");
        if (!candidate || !rail.contains(candidate)) continue;
        const value = runtime.systemModules.sidebarUsageLabel.readIndicator(indicator);
        if (!value || value.text === null) continue;
        target = candidate;
        text = value.text;
        break;
      }
      if (target !== button || (label && label.parentNode !== button)) clearLabel();
      if (!target) return;
      // 从同一导航栏中读取圆圈与下方头像的真实边界，不依赖文案或固定坐标。
      // Measure the ring and avatar bounds in the same rail without text matching or fixed coordinates.
      const ring = target.querySelector('path[pathLength="100"]')?.closest("svg");
      const ringRect = ring?.getBoundingClientRect();
      const buttonRect = target.getBoundingClientRect();
      const ringCenter = ringRect ? ringRect.top + ringRect.height / 2 : NaN;
      const avatar = Array.from(rail.querySelectorAll("button img")).find((image) => {
        const rect = image.getBoundingClientRect();
        return rect.width > 0 && rect.height > 0 && rect.top > ringCenter &&
          Math.abs(rect.left + rect.width / 2 - buttonRect.left - buttonRect.width / 2) < 1;
      });
      if (!ringRect?.height || !avatar) {
        clearLabel();
        return;
      }
      const avatarRect = avatar.getBoundingClientRect();
      // 按 14px 文字行框的底边定位，使上下两段边缘空白相等。
      // Position the bottom of the 14px text line box so both edge gaps are equal.
      const gap = avatarRect.top - ringRect.bottom;
      const lift = buttonRect.top + target.clientTop + 14 - (ringRect.top - gap);
      let nextLayoutHost = target.parentElement;
      while (nextLayoutHost && !nextLayoutHost.contains(avatar)) nextLayoutHost = nextLayoutHost.parentElement;
      if (nextLayoutHost !== layoutHost) {
        layoutObserver.disconnect();
        layoutHost = nextLayoutHost;
        if (layoutHost) layoutObserver.observe(layoutHost);
      }
      if (!label) {
        button = target;
        label = document.createElement("span");
        label.setAttribute(labelAttribute, "");
        // 原生按钮已有完整无障碍说明，新增视觉文字避免重复朗读。
        // The native button already describes quota accessibly; avoid duplicate announcements.
        label.setAttribute("aria-hidden", "true");
        button.setAttribute(buttonAttribute, "");
        button.append(label);
      }
      const liftValue = `${lift}px`;
      if (button.style.getPropertyValue(liftProperty) !== liftValue) button.style.setProperty(liftProperty, liftValue);
      if (label.textContent !== text) label.textContent = text;
    }

    // 把同一帧的局部变化合并，避免动画或多次 React 提交重复扫描。
    // Coalesce local changes per frame to avoid repeated scans during animation or React commits.
    function schedule() {
      if (!frame && !controller.signal.aborted) frame = requestAnimationFrame(refresh);
    }

    // 常规更新只观察导航栏；外层观察器只检测整个栏是否被替换。
    // Observe the rail for normal updates; the outer observer only detects rail replacement.
    const railObserver = new MutationObserver(schedule);
    // 监听共同布局容器的尺寸，缩放或原生间距变化时重新计算边缘空白。
    // Observe the shared layout container to recompute edge gaps after resize or native gap changes.
    const layoutObserver = new ResizeObserver(schedule);
    const shellObserver = new MutationObserver(() => {
      if (!rail?.isConnected) schedule();
    });
    shellObserver.observe(document.body, { childList: true, subtree: true });
    window.addEventListener("resize", schedule, { signal: controller.signal });
    controller.signal.addEventListener("abort", () => {
      railObserver.disconnect();
      shellObserver.disconnect();
      cancelAnimationFrame(frame);
      clearLabel();
      rail = null;
      document.getElementById(styleId)?.remove();
    }, { once: true });
    refresh();
    return { sync: schedule };
  }, { enableSetting: "enableSidebarUsageLabel" });
})();
