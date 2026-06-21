(() => {
  const runtime = window.__codexProRuntime;
  if (!runtime) return;

  const maxAttempts = 30;
  const retryDelayMs = 250;
  const minPinnedSidebarWidth = 120;
  const sidebarMaxRight = 520;

  function getVisibleRect(element) {
    // 这一段只接受真实可见节点，避免收起后的残留结构被误判为固定侧栏。
    // Accept only truly visible nodes so collapsed leftover structure is not treated as a pinned sidebar.
    if (!(element instanceof HTMLElement)) return null;
    const rect = element.getBoundingClientRect();
    if (rect.width <= 0 || rect.height <= 0) return null;
    const style = window.getComputedStyle(element);
    if (style.display === "none" || style.visibility === "hidden" || Number(style.opacity) === 0) return null;
    return rect;
  }

  function getRenderedRect(element) {
    // 这一段允许宽度为 0 的已渲染侧栏壳参与收起态判断。
    // Allow rendered zero-width sidebar shells to participate in collapsed-state checks.
    if (!(element instanceof HTMLElement)) return null;
    const rect = element.getBoundingClientRect();
    if (rect.height <= 0) return null;
    const style = window.getComputedStyle(element);
    if (style.display === "none" || style.visibility === "hidden" || Number(style.opacity) === 0) return null;
    return rect;
  }

  function isTopLeftSidebarButton(button) {
    // 这一段用左上角按钮的几何位置和图标结构定位原生侧栏开关，不读取多语言文案。
    // Locate the native sidebar toggle by top-left geometry and icon structure without reading localized labels.
    const rect = getVisibleRect(button);
    if (!rect) return false;
    return rect.left >= -4 &&
      rect.left <= 12 &&
      rect.top >= 0 &&
      rect.top <= 40 &&
      rect.width >= 20 &&
      rect.width <= 40 &&
      rect.height >= 20 &&
      rect.height <= 40 &&
      Boolean(button.querySelector("svg"));
  }

  function isPinnedSidebarShell(element) {
    // 这一段通过左侧固定外壳判断侧栏是否已展开，收起态只剩窄边不会满足宽度条件。
    // Detect expanded pinned state through the left shell; collapsed slivers fail the width check.
    if (element?.tagName !== "ASIDE") return false;
    const rect = getVisibleRect(element);
    if (!rect) return false;
    return rect.left >= -8 &&
      rect.left <= 12 &&
      rect.right <= sidebarMaxRight &&
      rect.width >= minPinnedSidebarWidth &&
      rect.height >= Math.min(220, window.innerHeight * 0.36) &&
      hasLayoutSiblingAfterSidebar(element, rect);
  }

  function isCollapsedSidebarShell(element) {
    // 这一段用左侧窄外壳确认侧栏已经收起，避免按钮先渲染时提前停止。
    // Confirm collapsed state through the narrow left shell so early button render does not stop polling.
    if (element?.tagName !== "ASIDE") return false;
    const rect = getRenderedRect(element);
    if (!rect) return false;
    return rect.left >= -8 &&
      rect.left <= 12 &&
      rect.right <= 64 &&
      rect.width < minPinnedSidebarWidth &&
      rect.height >= Math.min(220, window.innerHeight * 0.36) &&
      hasLayoutSiblingAfterSidebar(element, rect);
  }

  function hasLayoutSiblingAfterSidebar(element, rect) {
    // 这一段确认侧栏占据主布局宽度，避免自动收起浮层误触发启动点击。
    // Confirm the sidebar consumes layout width so auto-hidden flyouts do not trigger startup clicks.
    const parent = element.parentElement;
    if (!parent) return false;
    const children = Array.from(parent.children);
    const index = children.indexOf(element);
    if (index < 0) return false;
    for (const sibling of children.slice(index + 1)) {
      const siblingRect = getVisibleRect(sibling);
      if (!siblingRect) continue;
      if (siblingRect.bottom <= rect.top || siblingRect.top >= rect.bottom) continue;
      if (siblingRect.width < 200 || siblingRect.height < Math.min(220, window.innerHeight * 0.36)) continue;
      return siblingRect.left >= rect.right - 12;
    }
    return false;
  }

  function isPinnedSidebarVisible() {
    // 这一段只看固定展开的侧栏外壳，不把自动收起后的 hover 浮层当成启动目标。
    // Look only for the pinned sidebar shell so auto-hidden hover flyouts are not startup targets.
    return Array.from(document.querySelectorAll("aside")).some(isPinnedSidebarShell);
  }

  function isCollapsedSidebarVisible() {
    // 这一段只在看到真实收起侧栏壳时结束重试，冷启动缺结构时继续等待。
    // End retries only after a real collapsed shell is visible; missing cold-start structure keeps polling.
    return Array.from(document.querySelectorAll("aside")).some(isCollapsedSidebarShell);
  }

  function findSidebarToggleButton() {
    // 这一段在左上角按钮探针里选择最靠左的可见图标按钮，即 Codex 原生侧栏开关。
    // Pick the leftmost visible icon button in the top-left probe area, which is Codex's native sidebar toggle.
    return Array.from(document.querySelectorAll("button"))
      .filter(isTopLeftSidebarButton)
      .sort((left, right) => {
        const leftRect = left.getBoundingClientRect();
        const rightRect = right.getBoundingClientRect();
        return leftRect.left - rightRect.left || leftRect.top - rightRect.top;
      })[0] || null;
  }

  runtime.registerSystem("startup-sidebar", () => {
    const settings = runtime.systemModules.settingsMenu?.settings;
    const currentSettings = settings?.getSettings?.();

    // 这一段创建启动收起的短生命周期控制器，重复注入时会停止旧重试。
    // Create a short-lived startup-collapse controller so reinjection stops older retries.
    const controller = new AbortController();
    runtime.lifecycle.replaceController("startup-sidebar", controller);
    if (!currentSettings?.collapseSidebarOnStartup) return;

    let attempts = 0;
    let timeoutId = 0;
    let collapseRequested = false;

    const stop = () => {
      window.clearTimeout(timeoutId);
      controller.abort();
    };

    const tryCollapse = () => {
      // 这一段等待 Codex 顶部按钮和固定侧栏渲染完成，再按结构状态决定是否点击。
      // Wait for Codex's top button and pinned shell to render, then decide from structural state.
      if (controller.signal.aborted) return;
      attempts += 1;

      const button = findSidebarToggleButton();
      const pinnedSidebarVisible = isPinnedSidebarVisible();
      if (button && isCollapsedSidebarVisible()) {
        stop();
        return;
      }

      if (button && pinnedSidebarVisible && !collapseRequested) {
        collapseRequested = true;
        button.click();
      }

      // 这一段给冷启动页面留出渲染时间，超过上限就静默停止。
      // Give cold-start pages time to render, then stop quietly after the attempt limit.
      if (attempts >= maxAttempts) {
        stop();
        return;
      }
      timeoutId = window.setTimeout(tryCollapse, retryDelayMs);
    };

    controller.signal.addEventListener(
      "abort",
      () => {
        window.clearTimeout(timeoutId);
      },
      { once: true },
    );

    tryCollapse();
  }, { enableSetting: "enableStartupSidebar" });
})();
