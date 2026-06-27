(() => {
  const runtime = window.__codexProRuntime;
  if (!runtime) return;
  const usagePanel = runtime.systemModules.usagePanel ??= {};
  const i18n = runtime.i18n;

  const rootId = "codex-pro-mvp-root";
  const styleId = "codex-pro-mvp-style";
  const environmentUsageSelector = "[data-codex-pro-environment-usage-panel]";
  const panelHorizontalInset = 12;
  const panelInlineSeparatorSpace = 20;
  const panelRowColumnGap = 22;
  const panelInlineRowColumnGap = 14;
  const composerPanelSafeGap = 12;
  const composerShellMinRadius = 8;
  const reactFiberPrefix = "__reactFiber$";
  const environmentSectionKey = "environment";
  const topPanelUsageFallbackSectionKeys = new Set(["artifacts", "tool-sources"]);
  const maxEnvironmentFiberDepth = 80;
  const adaptiveSidebarMaxRight = 520;
  const minAdaptivePanelWidth = 168;
  const minAdaptiveSidebarWidth = 120;
  const sidebarMaxRight = 380;
  const lowerLeftMaxRight = 420;
  const nativeAccountMenuSelector = "[data-radix-menu-content][role='menu']";
  const nativePopoverWrapperSelector = "[data-radix-popper-content-wrapper]";
  let rightTopPanelContentCache = null;

  function install() {
    // 这一段安装用量面板样式，样式只归这个系统所有。
    // Install usage panel styles, keeping this system's CSS ownership local.
    runtime.dom.ensureNativePanelTokens?.();
    runtime.dom.upsertStyle(
      styleId,
      `
        #${rootId} {
          --codex-pro-usage-surface: var(--codex-pro-native-panel-surface);
          --codex-pro-usage-border: var(--codex-pro-native-panel-border);
          --codex-pro-usage-foreground: var(--codex-pro-native-panel-foreground);
          --codex-pro-usage-muted: var(--codex-pro-native-panel-muted);
          position: fixed;
          left: ${panelHorizontalInset}px;
          bottom: ${panelHorizontalInset}px;
          z-index: 2147483000;
          box-sizing: border-box;
          min-width: 168px;
          border: 1px solid var(--codex-pro-usage-border);
          border-radius: 12px;
          background: var(--codex-pro-usage-surface);
          color: var(--codex-pro-usage-foreground);
          box-shadow: 0 14px 36px rgba(0, 0, 0, .24);
          font: 12px/1.35 system-ui, -apple-system, BlinkMacSystemFont, "Segoe UI", sans-serif;
          opacity: 1;
          padding: 9px 12px;
          pointer-events: none;
          backdrop-filter: blur(12px);
          transition: opacity 140ms ease, filter 140ms ease;
        }
        #${rootId}.codex-pro-usage-adaptive {
          width: var(--codex-pro-usage-panel-width, auto);
          max-width: calc(100vw - ${panelHorizontalInset * 2}px);
          transition: opacity 140ms ease, filter 140ms ease, width 110ms ease-out;
        }
        #${rootId}.codex-pro-usage-sidebar-blurred {
          filter: brightness(.78) saturate(.86);
        }
        #${rootId}.codex-pro-usage-transparent {
          opacity: 0;
        }
        #${rootId}.codex-pro-usage-hidden {
          opacity: 0;
        }
        #${rootId} .codex-pro-usage-rows {
          display: flex;
          flex-direction: column;
          gap: 0;
        }
        #${rootId}.codex-pro-usage-inline .codex-pro-usage-rows {
          flex-direction: row;
          gap: 0;
          align-items: center;
        }
        #${rootId} .codex-pro-usage-row {
          display: grid;
          grid-template-columns: auto 1fr;
          gap: ${panelRowColumnGap}px;
          align-items: center;
          min-height: 22px;
          white-space: nowrap;
        }
        #${rootId}.codex-pro-usage-inline .codex-pro-usage-row {
          flex: 1 1 0;
          gap: ${panelInlineRowColumnGap}px;
          min-width: 0;
        }
        #${rootId}.codex-pro-usage-inline .codex-pro-usage-row + .codex-pro-usage-row {
          border-left: 1px solid var(--codex-pro-usage-border);
          margin-left: ${panelInlineSeparatorSpace / 2}px;
          padding-left: ${panelInlineSeparatorSpace / 2}px;
        }
        #${rootId} .codex-pro-usage-label {
          color: var(--codex-pro-usage-foreground);
          font-weight: 450;
        }
        #${rootId} .codex-pro-usage-value {
          color: var(--codex-pro-usage-muted);
          text-align: right;
          font-variant-numeric: tabular-nums;
        }
        ${environmentUsageSelector} {
          --codex-pro-environment-usage-foreground: var(--codex-pro-native-panel-foreground);
          --codex-pro-environment-usage-muted: var(--codex-pro-native-panel-muted);
          display: flex;
          flex-direction: column;
          gap: 4px;
          padding: 0 16px 0;
          color: var(--codex-pro-environment-usage-foreground);
          font: 12px/1.35 system-ui, -apple-system, BlinkMacSystemFont, "Segoe UI", sans-serif;
          user-select: none;
        }
        ${environmentUsageSelector} .codex-pro-environment-usage-title {
          color: var(--codex-pro-environment-usage-muted);
          font-size: 14px;
          font-weight: 430;
          line-height: 1.45;
        }
        ${environmentUsageSelector} .codex-pro-environment-usage-rows {
          display: flex;
          flex-direction: column;
          gap: 2px;
        }
        ${environmentUsageSelector} .codex-pro-environment-usage-row {
          display: grid;
          grid-template-columns: auto 1fr;
          align-items: center;
          gap: 12px;
          min-height: 24px;
          white-space: nowrap;
        }
        ${environmentUsageSelector} .codex-pro-environment-usage-label {
          color: var(--codex-pro-environment-usage-foreground);
          font-weight: 450;
        }
        ${environmentUsageSelector} .codex-pro-environment-usage-value {
          color: var(--codex-pro-environment-usage-muted);
          text-align: right;
          font-variant-numeric: tabular-nums;
        }
      `,
    );

    // 这一段刷新面板内容，后续渲染会按数据行补齐或移除 token 明细行。
    // Refresh panel content; later renders add or remove token detail rows from the row data.
    const root = runtime.dom.ensureRoot(rootId);
    root.innerHTML = `
      <div class="codex-pro-usage-rows">
        <div class="codex-pro-usage-row" data-codex-pro-window="primary">
          <span class="codex-pro-usage-label">${i18n.html("usage.window.fiveHours")}</span>
          <span class="codex-pro-usage-value" data-codex-pro-usage-value>${i18n.html("common.status.syncing")}</span>
        </div>
        <div class="codex-pro-usage-row" data-codex-pro-window="secondary">
          <span class="codex-pro-usage-label">${i18n.html("usage.window.oneWeek")}</span>
          <span class="codex-pro-usage-value" data-codex-pro-usage-value>${i18n.html("common.status.syncing")}</span>
        </div>
      </div>
    `;

    return root;
  }

  function uninstall() {
    // 这一段移除用量面板自己的 DOM 和样式，供功能开关或硬屏蔽时彻底停用。
    // Remove the usage panel's own DOM and styles so feature switches or hard-disable can fully stop it.
    document.getElementById(rootId)?.remove();
    document.getElementById(styleId)?.remove();
    removeEnvironmentUsageSections();
  }

  function isOwnPanelElement(element) {
    // 这一段排除 Codex-Pro 自己的面板，避免检测逻辑被自己的文字命中。
    // Exclude Codex-Pro's own panel so detection cannot match our own text.
    return Boolean(element?.id === rootId || element?.closest?.(`#${rootId}`));
  }

  function getVisibleRect(element) {
    // 这一段读取可见元素位置；不可见或透明元素不参与菜单/侧栏判断。
    // Read visible element geometry; hidden or transparent nodes do not participate in menu/sidebar checks.
    if (!(element instanceof HTMLElement) || isOwnPanelElement(element)) return null;
    const rect = element.getBoundingClientRect();
    if (rect.width <= 0 || rect.height <= 0) return null;
    const style = window.getComputedStyle(element);
    if (style.display === "none" || style.visibility === "hidden" || Number(style.opacity) === 0) return null;
    return rect;
  }

  function getReactFiber(element) {
    // 这一段读取 DOM 节点上的 React fiber 私有字段，只用于确认右上原生 section 类型。
    // Read React's private fiber field from a DOM node only to confirm the native top-right section type.
    if (!(element instanceof Element)) return null;

    // 这一段只查找当前节点自带的 fiber key，不向全局状态读取数据。
    // Find only the fiber key owned by this node without reading global state.
    const key = Object.getOwnPropertyNames(element).find((name) => name.startsWith(reactFiberPrefix));
    return key ? element[key] : null;
  }

  function readReactSectionKeys(element) {
    // 这一段沿 React 父链收集 sectionKey，用结构信号区分右上原生浮窗里的不同 section。
    // Walk the React parent chain to collect sectionKey values and distinguish native top-right sections structurally.
    const sectionKeys = new Set();
    let fiber = getReactFiber(element);

    // 这一段限制 fiber 深度，避免异常树结构造成过量遍历。
    // Bound fiber traversal depth to avoid excessive walks on unexpected tree shapes.
    for (let depth = 0; fiber && depth < maxEnvironmentFiberDepth; depth += 1) {
      const props = fiber.memoizedProps || fiber.pendingProps;
      if (typeof props?.sectionKey === "string" && props.sectionKey) {
        sectionKeys.add(props.sectionKey);
      }
      fiber = fiber.return;
    }
    return sectionKeys;
  }

  function hasTopPanelUsageFallbackSectionKey(sectionKeys) {
    // 这一段识别无环境区时仍可承载用量的右上输出/来源 section，不依赖界面文案。
    // Identify output/source sections that can host usage when no environment section exists, without relying on UI copy.
    for (const sectionKey of sectionKeys) {
      if (topPanelUsageFallbackSectionKeys.has(sectionKey)) return true;
    }
    return false;
  }

  function hasRightTopUsageSectionKey(element) {
    // 这一段统一判断右上用量可依附的原生 section，包含环境区和无环境时的输出/来源区。
    // Check native top-right sections that can host usage, including environment and output/source fallback sections.
    const sectionKeys = readReactSectionKeys(element);
    return sectionKeys.has(environmentSectionKey) || hasTopPanelUsageFallbackSectionKey(sectionKeys);
  }

  function collectElementsFromPoints(points, maxAncestorDepth = 6) {
    // 这一段只从左侧/左下角探测点收集元素及少量父级，不再扫描整页 div/section。
    // Collect elements and a few ancestors only from left-side probe points instead of scanning all div/section nodes.
    const elements = new Set();
    const getStack = typeof document.elementsFromPoint === "function"
      ? (x, y) => document.elementsFromPoint(x, y)
      : (x, y) => [document.elementFromPoint(x, y)].filter(Boolean);

    for (const point of points) {
      for (const hit of getStack(point.x, point.y)) {
        for (
          let element = hit, depth = 0;
          element instanceof HTMLElement && element !== document.body && depth <= maxAncestorDepth;
          element = element.parentElement, depth += 1
        ) {
          elements.add(element);
        }
      }
    }
    return elements;
  }

  function getSidebarProbePoints() {
    // 这一段覆盖左侧栏列表区域和底部设置入口，保留自动隐藏侧栏划出后的真实可见判断。
    // Cover the sidebar list area and bottom settings entry so hover-expanded sidebars still count as visible.
    const height = window.innerHeight;
    const xs = [24, 96, 220, 340];
    const ys = [72, 150, Math.min(300, Math.max(180, height * 0.28)), height - 150, height - 82];
    return xs.flatMap((x) => ys.map((y) => ({
      x: Math.min(Math.max(0, x), Math.max(0, window.innerWidth - 1)),
      y: Math.min(Math.max(0, y), Math.max(0, height - 1)),
    })));
  }

  function getLowerLeftMenuProbePoints() {
    // 这一段覆盖账号菜单通常出现的左下角浮层区域，避免全页文本查找菜单。
    // Cover the lower-left popover region where the account menu appears, avoiding page-wide text lookups.
    const height = window.innerHeight;
    const xs = [24, 112, 220, 340, 408];
    const offsets = [500, 420, 340, 260, 180, 100, 44];
    return xs.flatMap((x) => offsets.map((offset) => ({
      x: Math.min(Math.max(0, x), Math.max(0, window.innerWidth - 1)),
      y: Math.min(Math.max(0, height - offset), Math.max(0, height - 1)),
    })));
  }

  function isSidebarShellElement(element, rect = getVisibleRect(element), maxRight = sidebarMaxRight) {
    // 这一段用 Codex 当前真实结构识别侧栏外壳，不依赖侧栏里的界面文案。
    // Identify the sidebar shell from Codex's current structure without depending on visible copy.
    if (!rect) return false;
    const role = element.getAttribute("role") || "";
    const isShell =
      element.tagName === "ASIDE" ||
      element.tagName === "NAV" ||
      role === "navigation";
    if (!isShell) return false;

    // 这一段限制候选必须是左侧的大块可见容器，避免命中正文或弹窗里的导航。
    // Require a large visible left-side container so body content or dialogs are not matched.
    return rect.left >= -8 &&
      rect.left <= panelHorizontalInset &&
      rect.right <= maxRight &&
      rect.width >= minAdaptiveSidebarWidth &&
      rect.height >= Math.min(220, window.innerHeight * 0.36);
  }

  function hasLayoutSiblingAfterSidebar(element, rect) {
    // 这一段确认侧栏在主布局中占位，避免把自动收起后的 hover 浮层当成固定展开。
    // Confirm the sidebar consumes layout space so auto-hidden hover flyouts are not treated as pinned.
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

  function isPinnedSidebarShellElement(element, rect = getVisibleRect(element), maxRight = adaptiveSidebarMaxRight) {
    // 这一段用固定侧栏外壳、几何范围和右侧布局占位判断 pinned 模式，不读取按钮文案。
    // Detect pinned mode from the shell, geometry, and adjacent layout slot without reading button copy.
    if (!rect) return false;
    const isShell = element.tagName === "ASIDE" || String(element.className || "").includes("app-shell-left-panel");
    if (!isShell) return false;
    return rect.left >= -8 &&
      rect.left <= panelHorizontalInset &&
      rect.right <= maxRight &&
      rect.width >= minAdaptiveSidebarWidth &&
      rect.height >= Math.min(220, window.innerHeight * 0.36) &&
      hasLayoutSiblingAfterSidebar(element, rect);
  }

  function isSidebarListElement(element, rect = getVisibleRect(element)) {
    // 这一段保留自动隐藏侧栏的局部兜底：只接受左侧栏范围内的真实列表结构。
    // Keep a local fallback for hover-expanded sidebars: accept only real list structures in the sidebar zone.
    if (!rect) return false;
    if ((element.getAttribute("role") || "") !== "list") return false;
    return rect.left >= -8 &&
      rect.right <= sidebarMaxRight &&
      rect.width >= minAdaptiveSidebarWidth &&
      rect.height >= 80;
  }

  function isSidebarContentVisible() {
    // 这一段检查左侧栏内容是否实际可见，优先使用 aside/nav 结构而不是可变文字。
    // Check actual sidebar visibility, preferring aside/nav structure over mutable UI text.
    for (const element of collectElementsFromPoints(getSidebarProbePoints(), 8)) {
      const rect = getVisibleRect(element);
      if (isSidebarShellElement(element, rect) || isSidebarListElement(element, rect)) return true;
    }
    return false;
  }

  function isLowerLeftMenuRect(rect) {
    // 这一段把候选菜单限制在左下角原生账号菜单区域，排除其它 Radix 弹层。
    // Constrain menu candidates to the native lower-left account-menu area and exclude other Radix popovers.
    const minMenuTop = Math.max(0, window.innerHeight - 520);
    return rect.left >= -8 &&
      rect.left <= lowerLeftMaxRight &&
      rect.top >= minMenuTop &&
      rect.bottom <= window.innerHeight + 8 &&
      rect.width >= 160 &&
      rect.height >= 80;
  }

  function isOpenRadixMenu(element) {
    // 这一段用 Radix 菜单结构和打开状态识别原生菜单，避免读取菜单中的账号等隐私文本。
    // Identify native Radix menus by structure and open state without reading private account text.
    if (!(element instanceof HTMLElement)) return false;
    if (!element.matches?.(nativeAccountMenuSelector)) return false;
    if (element.getAttribute("data-state") === "closed") return false;
    return true;
  }

  function isNativeAccountMenuOpen() {
    // 这一段直接按当前界面的 Radix 菜单 DOM 查找，避免通过菜单文案判断打开状态。
    // Find the current Radix menu DOM directly instead of inferring open state from menu copy.
    for (const menu of document.querySelectorAll(nativeAccountMenuSelector)) {
      const rect = getVisibleRect(menu);
      if (rect && isOpenRadixMenu(menu) && isLowerLeftMenuRect(rect)) return true;
    }

    // 这一段保留局部探测兜底，只从左下角点位命中栈里识别菜单或菜单外层。
    // Keep a local probing fallback that recognizes only menu nodes or their popover wrapper from lower-left hit stacks.
    for (const element of collectElementsFromPoints(getLowerLeftMenuProbePoints())) {
      const rect = getVisibleRect(element);
      if (!rect) continue;
      if (isOpenRadixMenu(element) && isLowerLeftMenuRect(rect)) return true;
      const menu = element.matches?.(nativePopoverWrapperSelector)
        ? element.querySelector?.(nativeAccountMenuSelector)
        : null;
      const menuRect = getVisibleRect(menu);
      if (menuRect && isOpenRadixMenu(menu) && isLowerLeftMenuRect(menuRect)) return true;
    }
    return false;
  }

  function getPinnedSidebarRight() {
    // 这一段读取固定展开侧栏右边界；自动收起或 hover 浮层返回 0，面板保持最窄宽度。
    // Read the pinned sidebar right edge; auto-hidden or hover flyout states return 0 so the panel stays narrow.
    let sidebarRight = 0;
    for (const element of document.querySelectorAll("aside, [class*='app-shell-left-panel']")) {
      const rect = getVisibleRect(element);
      if (!isPinnedSidebarShellElement(element, rect, adaptiveSidebarMaxRight)) continue;
      sidebarRight = Math.max(sidebarRight, Math.round(rect.right));
    }
    return sidebarRight;
  }

  function getSidebarLayoutMode() {
    // 这一段用固定外壳和左侧可见内容区分 pinned 与 auto-hidden，不读取按钮文案。
    // Distinguish pinned from auto-hidden through the pinned shell and visible left content, without button copy.
    if (getPinnedSidebarRight() > 0) return "pinned";
    return isSidebarContentVisible() ? "auto-hidden" : "unknown";
  }

  function getComposerShellRect(editor) {
    // 这一段从编辑控件向外扩展到输入框外壳，避免只测到很矮的文字编辑区。
    // Expand from the editor control to the composer shell so the full rounded input area is measured.
    let bestRect = getVisibleRect(editor);
    for (let element = editor.parentElement, depth = 0; element && element !== document.body && depth < 8; element = element.parentElement, depth += 1) {
      const rect = getVisibleRect(element);
      if (!rect) continue;
      if (rect.bottom < window.innerHeight * 0.55) continue;
      if (rect.width < Math.max(240, window.innerWidth * 0.28)) continue;
      if (rect.height > window.innerHeight * 0.55) break;
      if (isLikelyComposerShell(element, rect)) bestRect = rect;
    }
    return bestRect;
  }

  function parseMaxPixelValue(value) {
    // 这一段读取 CSS 圆角/边框里的最大像素值，用于识别真实输入框外壳。
    // Read the largest pixel value from radius/border CSS so the real composer shell can be identified.
    return Math.max(0, ...String(value || "").match(/[\d.]+px/g)?.map((part) => Number.parseFloat(part)) || [0]);
  }

  function hasVisibleBackground(style) {
    // 这一段排除透明布局容器，避免把全宽底栏误当成输入框外壳。
    // Exclude transparent layout containers so full-width footers are not mistaken for the composer shell.
    const backgroundColor = style.backgroundColor || "";
    return Boolean(backgroundColor && !/rgba?\(\s*0\s*,\s*0\s*,\s*0\s*,\s*0\s*\)|transparent/i.test(backgroundColor));
  }

  function isLikelyComposerShell(element, rect) {
    // 这一段只接受有圆角、边框或背景的近层容器，避免继续扩展到页面底部布局容器。
    // Accept only nearby visual containers with radius, border, or background to avoid selecting page footer wrappers.
    const style = window.getComputedStyle(element);
    const radius = parseMaxPixelValue([
      style.borderRadius,
      style.borderTopLeftRadius,
      style.borderTopRightRadius,
      style.borderBottomLeftRadius,
      style.borderBottomRightRadius,
    ].join(" "));
    const borderWidth =
      Number.parseFloat(style.borderTopWidth) +
      Number.parseFloat(style.borderRightWidth) +
      Number.parseFloat(style.borderBottomWidth) +
      Number.parseFloat(style.borderLeftWidth);
    const hasVisualShell = radius >= composerShellMinRadius || borderWidth > 0 || hasVisibleBackground(style);
    const isFullViewportWrapper = rect.left <= 2 && rect.right >= window.innerWidth - 2;
    return hasVisualShell && (!isFullViewportWrapper || radius >= composerShellMinRadius);
  }

  function getBottomComposerRect() {
    // 这一段只定位底部输入框控件和外壳，避免聊天正文或设置面板里的输入项误参与判断。
    // Locate only the bottom composer control and shell so message body or settings inputs do not affect the check.
    let bottomRect = null;
    for (const element of document.querySelectorAll(".ProseMirror, textarea, [contenteditable='true'], input")) {
      if (!(element instanceof HTMLElement) || isOwnPanelElement(element)) continue;
      const editorRect = getVisibleRect(element);
      if (!editorRect) continue;
      if (editorRect.bottom < window.innerHeight * 0.55) continue;
      const composerRect = getComposerShellRect(element);
      if (!composerRect) continue;
      if (!bottomRect || composerRect.bottom > bottomRect.bottom) bottomRect = composerRect;
    }
    return bottomRect;
  }

  function isComposerCrowdingPanel(root) {
    // 这一段在输入框外壳挤到用量面板安全间距内时隐藏面板，避免两者重叠遮挡。
    // Hide the panel when the composer shell enters the panel's safety gap, avoiding visual overlap.
    const panelRect = root.getBoundingClientRect();
    const composerRect = getBottomComposerRect();
    if (!composerRect || panelRect.width <= 0 || panelRect.height <= 0) return false;
    return !(
      composerRect.left >= panelRect.right + composerPanelSafeGap ||
      composerRect.right <= panelRect.left - composerPanelSafeGap ||
      composerRect.top >= panelRect.bottom + composerPanelSafeGap ||
      composerRect.bottom <= panelRect.top - composerPanelSafeGap
    );
  }

  function getPanelContentWidth(root, width = root.clientWidth) {
    // 这一段计算面板可用于两段用量内容的宽度，扣除左右内边距。
    // Compute the content width available for the two usage rows after horizontal padding.
    const style = window.getComputedStyle(root);
    const paddingLeft = Number.parseFloat(style.paddingLeft) || 0;
    const paddingRight = Number.parseFloat(style.paddingRight) || 0;
    return Math.max(0, width - paddingLeft - paddingRight);
  }

  function getTextContentWidth(element) {
    // 这一段用文本 Range 读取真实文字宽度，避免 grid 拉伸后的单元格宽度干扰判断。
    // Read the real text width with a Range so stretched grid cells do not distort fit checks.
    if (!element) return 0;
    const range = document.createRange();
    range.selectNodeContents(element);
    const width = range.getBoundingClientRect().width;
    range.detach?.();
    return Math.ceil(width || element.scrollWidth || 0);
  }

  function getUsageRowRequiredWidth(row, columnGap = panelRowColumnGap) {
    // 这一段按标签、数值和列间距估算单段用量在同一行所需的最小宽度。
    // Estimate the minimum same-line width for one usage row from label, value, and column gap.
    const label = row.querySelector(".codex-pro-usage-label");
    const value = row.querySelector("[data-codex-pro-usage-value]");
    return getTextContentWidth(label) + columnGap + getTextContentWidth(value);
  }

  function updateInlineLayout(root, width = root.clientWidth) {
    // 这一段在自适应宽度开启时决定多段用量是否能放到同一行，宽度不足则回退纵向。
    // Decide whether multiple usage rows fit on one line when adaptive width is enabled; fall back vertically otherwise.
    if (!root.classList.contains("codex-pro-usage-adaptive")) {
      root.classList.remove("codex-pro-usage-inline");
      return;
    }
    const rows = Array.from(root.querySelectorAll(".codex-pro-usage-row"));
    if (rows.length < 2) {
      root.classList.remove("codex-pro-usage-inline");
      return;
    }
    const requiredWidth = rows.reduce(
      (total, row) => total + getUsageRowRequiredWidth(row, panelInlineRowColumnGap),
      0,
    ) + (panelInlineSeparatorSpace * (rows.length - 1));
    root.classList.toggle("codex-pro-usage-inline", getPanelContentWidth(root, width) >= requiredWidth);
  }

  function applyAdaptiveWidth(root, enabled, sidebarRight) {
    // 这一段根据开关状态设置面板宽度，保留左侧和右侧各 12px 视觉留白。
    // Apply panel width from the switch state while preserving 12px visual inset on both sides.
    root.classList.toggle("codex-pro-usage-adaptive", enabled);
    if (!enabled) {
      root.style.removeProperty("--codex-pro-usage-panel-width");
      updateInlineLayout(root);
      return;
    }
    const targetWidth = Math.max(
      minAdaptivePanelWidth,
      Math.min(window.innerWidth - (panelHorizontalInset * 2), sidebarRight - (panelHorizontalInset * 2)),
    );
    root.style.setProperty("--codex-pro-usage-panel-width", `${Math.round(targetWidth)}px`);
    updateInlineLayout(root, Math.min(root.clientWidth || targetWidth, targetWidth));
  }

  function bindAdaptiveWidth(root, settingsApi, signal) {
    // 这一段订阅设置和窗口变化，让自适应宽度保存后立即生效并跟随可见侧栏宽度更新。
    // Subscribe to settings and window changes so adaptive width applies immediately and follows visible sidebar width.
    let frameId = 0;
    let latestSettings = settingsApi?.getSettings?.() || {};
    let inlineLayoutTimeoutId = 0;
    const timeoutIds = new Set();

    const isLikelySidebarMutationTarget = (target) => {
      // 这一段只接受左侧栏相关 DOM 变化，避免聊天正文频繁变化触发宽度测量。
      // Accept only sidebar-like DOM changes so chat content mutations do not trigger width measurement.
      if (!(target instanceof HTMLElement) || isOwnPanelElement(target)) return false;
      if (target === document.body || target === document.documentElement) return false;
      if (target.closest?.("aside, nav, [role='navigation']")) return true;
      const rect = target.getBoundingClientRect();
      return rect.width > 0 &&
        rect.height > 80 &&
        rect.left <= panelHorizontalInset &&
        rect.right <= adaptiveSidebarMaxRight;
    };

    const scheduleInlineLayoutRefresh = () => {
      // 这一段在宽度动画结束后复算单行布局，覆盖首屏或云同步只触发一次更新的路径。
      // Recompute inline layout after width animation for one-shot startup or cloud-sync update paths.
      if (inlineLayoutTimeoutId) {
        window.clearTimeout(inlineLayoutTimeoutId);
        timeoutIds.delete(inlineLayoutTimeoutId);
      }
      inlineLayoutTimeoutId = window.setTimeout(() => {
        timeoutIds.delete(inlineLayoutTimeoutId);
        inlineLayoutTimeoutId = 0;
        updateInlineLayout(root);
      }, 140);
      timeoutIds.add(inlineLayoutTimeoutId);
    };

    const updateSidebarFocusDimming = (sidebarMode = getSidebarLayoutMode()) => {
      // 这一段只在侧栏固定展开且 Codex 窗口失焦时压暗面板，自动收起划出层不参与。
      // Dim the panel only when the sidebar is pinned open and the Codex window is blurred; auto-hidden flyouts are ignored.
      root.classList.toggle("codex-pro-usage-sidebar-blurred", sidebarMode === "pinned" && !document.hasFocus());
    };

    const updateLayout = () => {
      frameId = 0;
      const adaptiveEnabled = latestSettings.usagePanelAdaptiveWidth === true;
      const pinnedSidebarRight = getPinnedSidebarRight();
      const sidebarMode = pinnedSidebarRight > 0
        ? "pinned"
        : isSidebarContentVisible()
          ? "auto-hidden"
          : "unknown";
      const shouldFollowPinnedSidebar = adaptiveEnabled && sidebarMode === "pinned";
      applyAdaptiveWidth(
        root,
        adaptiveEnabled,
        shouldFollowPinnedSidebar ? pinnedSidebarRight : (minAdaptivePanelWidth + (panelHorizontalInset * 2)),
      );
      updateSidebarFocusDimming(sidebarMode);
      if (adaptiveEnabled) scheduleInlineLayoutRefresh();
    };
    const scheduleUpdate = () => {
      if (frameId) return;
      frameId = window.requestAnimationFrame(updateLayout);
    };
    const scheduleFollowUp = (delayMs) => {
      const timeoutId = window.setTimeout(() => {
        timeoutIds.delete(timeoutId);
        scheduleUpdate();
      }, delayMs);
      timeoutIds.add(timeoutId);
    };
    const scheduleSettledUpdates = () => {
      scheduleUpdate();
      scheduleFollowUp(80);
      scheduleFollowUp(160);
      scheduleFollowUp(260);
    };
    const unsubscribeSettings = settingsApi?.subscribe?.((nextSettings) => {
      latestSettings = nextSettings || {};
      scheduleUpdate();
    }, signal);

    scheduleUpdate();
    root.addEventListener("transitionend", (event) => {
      // 这一段在真实 CSS 宽度动画结束时立即复算，减少等待 fallback 定时器的机会。
      // Recompute immediately after the real CSS width transition when it fires.
      if (event.target === root && event.propertyName === "width") updateInlineLayout(root);
    }, { signal });
    window.addEventListener("resize", scheduleUpdate, { signal });
    window.addEventListener("focus", scheduleUpdate, { signal });
    window.addEventListener("blur", scheduleUpdate, { signal });
    window.addEventListener("click", scheduleSettledUpdates, { capture: true, signal });
    window.addEventListener("pointermove", (event) => {
      // 这一段只在固定展开侧栏附近复测宽度，自动收起划出层不参与自适应。
      // Remeasure only near pinned sidebars; auto-hidden flyouts do not participate in adaptive width.
      if (event.clientX > adaptiveSidebarMaxRight) return;
      if (latestSettings.usagePanelAdaptiveWidth === true && getSidebarLayoutMode() === "pinned") scheduleUpdate();
    }, { passive: true, signal });
    const sidebarMutationObserver = new MutationObserver((mutations) => {
      if (!latestSettings.usagePanelAdaptiveWidth) return;
      if (mutations.some((mutation) => isLikelySidebarMutationTarget(mutation.target))) {
        scheduleSettledUpdates();
      }
    });
    sidebarMutationObserver.observe(document.body, {
      attributeFilter: ["aria-hidden", "class", "hidden", "style"],
      attributes: true,
      childList: true,
      subtree: true,
    });
    signal.addEventListener(
      "abort",
      () => {
        if (frameId) window.cancelAnimationFrame(frameId);
        for (const timeoutId of timeoutIds) {
          window.clearTimeout(timeoutId);
        }
        timeoutIds.clear();
        sidebarMutationObserver.disconnect();
        unsubscribeSettings?.();
      },
      { once: true },
    );
  }

  function bindNativeMenuVisibility(root, settingsApi, signal) {
    // 这一段根据 Codex 原生账号菜单和左侧栏可见状态隐藏或恢复用量面板。
    // Hide or restore the usage panel from Codex's native account menu and visible sidebar content.
    let frameId = 0;
    let latestSettings = settingsApi?.getSettings?.() || {};
    const timeoutIds = new Set();
    const updateVisibility = () => {
      frameId = 0;
      root.classList.toggle(
        "codex-pro-usage-hidden",
        latestSettings.showUsageInLowerLeftPanel === false ||
          (isSidebarContentVisible() && isNativeAccountMenuOpen()) ||
          isComposerCrowdingPanel(root),
      );
    };
    const scheduleUpdate = () => {
      if (frameId) return;
      frameId = window.requestAnimationFrame(updateVisibility);
    };
    const scheduleFollowUp = (delayMs) => {
      const timeoutId = window.setTimeout(() => {
        timeoutIds.delete(timeoutId);
        scheduleUpdate();
      }, delayMs);
      timeoutIds.add(timeoutId);
    };
    const scheduleSettledUpdate = () => {
      scheduleUpdate();
      scheduleFollowUp(80);
      scheduleFollowUp(180);
    };
    const unsubscribeSettings = settingsApi?.subscribe?.((nextSettings) => {
      latestSettings = nextSettings || {};
      scheduleUpdate();
    }, signal);

    scheduleUpdate();
    window.addEventListener("click", scheduleSettledUpdate, { capture: true, signal });
    window.addEventListener("pointermove", (event) => {
      // 这一段只在左侧栏附近或面板已隐藏时复查，覆盖自动隐藏侧栏收回而不做全局高频扫描。
      // Recheck near the sidebar or while hidden, covering auto-hide collapse without global high-frequency scans.
      if (
        root.classList.contains("codex-pro-usage-hidden") ||
        event.clientX <= 420 ||
        event.clientY >= window.innerHeight - 520
      ) {
        scheduleUpdate();
      }
    }, { passive: true, signal });
    window.addEventListener("keydown", (event) => {
      if (event.key === "Escape") scheduleSettledUpdate();
    }, { signal });
    window.addEventListener("beforeinput", scheduleUpdate, { capture: true, signal });
    window.addEventListener("input", scheduleSettledUpdate, { capture: true, signal });
    window.addEventListener("resize", scheduleSettledUpdate, { signal });
    const composerMutationObserver = new MutationObserver((mutations) => {
      // 这一段只响应底部输入框附近的尺寸或内容变化，避免聊天流式输出时频繁重算。
      // Respond only to bottom-composer changes so streaming chat content does not cause frequent rechecks.
      if (mutations.some((mutation) => {
        const target = mutation.target;
        if (!(target instanceof HTMLElement) || isOwnPanelElement(target)) return false;
        if (target === document.body || target === document.documentElement) return false;
        if (!target.closest?.(".ProseMirror, textarea, [contenteditable='true'], input")) return false;
        const rect = getVisibleRect(target);
        return Boolean(rect && rect.bottom >= window.innerHeight * 0.55);
      })) {
        scheduleSettledUpdate();
      }
    });
    composerMutationObserver.observe(document.body, {
      attributeFilter: ["class", "style", "aria-expanded", "hidden"],
      attributes: true,
      childList: true,
      characterData: true,
      subtree: true,
    });
    signal.addEventListener(
      "abort",
      () => {
        if (frameId) window.cancelAnimationFrame(frameId);
        for (const timeoutId of timeoutIds) {
          window.clearTimeout(timeoutId);
        }
        timeoutIds.clear();
        composerMutationObserver.disconnect();
        unsubscribeSettings?.();
      },
      { once: true },
    );
  }

  function hasDirectSectionChildren(element) {
    // 这一段只把直接包含原生 section 的容器当作右上浮窗 content 候选。
    // Treat only containers with direct native section children as top-right panel content candidates.
    if (!(element instanceof HTMLElement)) return false;
    return Array.from(element.children).some((child) => child instanceof HTMLElement && child.tagName === "SECTION");
  }

  function isRightTopPanelContent(element) {
    // 这一段只校验 content 结构和可见性，位置交给 React sectionKey 这个结构锚点决定。
    // Validate only content structure and visibility; React sectionKey is the structural anchor, not panel coordinates.
    if (!(element instanceof HTMLElement) || isOwnPanelElement(element)) return false;
    if (!hasDirectSectionChildren(element)) return false;
    const contentRect = getVisibleRect(element);
    const shellRect = getVisibleRect(element.parentElement);
    return Boolean(contentRect && shellRect);
  }

  function readRightTopPanelSectionCandidates(content) {
    // 这一段只读取单个右上浮窗 content 的直接子 section，减少对聊天正文 DOM 的接触面。
    // Read only direct child sections from one top-right panel content, reducing contact with message-body DOM.
    return Array.from(content.children)
      .filter((section) => section instanceof HTMLElement && section.tagName === "SECTION")
      .map((section) => ({ section, rect: getVisibleRect(section) }))
      .filter(({ section, rect }) => {
        if (!rect) return false;
        if (section.matches?.(environmentUsageSelector)) return false;
        return !isOwnPanelElement(section);
      })
      .map(({ section, rect }) => ({ section, rect, sectionKeys: readReactSectionKeys(section) }))
      .filter(({ sectionKeys }) => sectionKeys.size > 0)
      .sort((left, right) => left.rect.top - right.rect.top);
  }

  function buildRightTopPanelContentCandidate(content) {
    // 这一段把 content 转成带优先级的候选；environment 永远优先于输出/来源兜底。
    // Convert content into a prioritized candidate; environment always wins over output/source fallback.
    if (!isRightTopPanelContent(content)) return null;
    const sections = readRightTopPanelSectionCandidates(content);
    if (sections.some((section) => section.sectionKeys.has(environmentSectionKey))) {
      return { content, priority: 0, sections };
    }
    if (sections.some((section) => hasTopPanelUsageFallbackSectionKey(section.sectionKeys))) {
      return { content, priority: 1, sections };
    }
    return null;
  }

  function collectRightTopPanelContents() {
    // 这一段通过 React sectionKey 找原生浮窗 content，不用固定屏幕坐标探测。
    // Locate native panel content by React sectionKey instead of fixed screen-coordinate probes.
    const contents = new Set();

    for (const section of document.querySelectorAll("section")) {
      if (!(section instanceof HTMLElement) || section.matches?.(environmentUsageSelector)) continue;
      if (isOwnPanelElement(section) || !getVisibleRect(section)) continue;
      const content = section.parentElement;
      if (!isRightTopPanelContent(content)) continue;
      const sectionKeys = readReactSectionKeys(section);
      if (sectionKeys.has(environmentSectionKey) || hasTopPanelUsageFallbackSectionKey(sectionKeys)) {
        contents.add(content);
      }
    }

    return Array.from(contents);
  }

  function getCachedRightTopPanelContentCandidate() {
    // 这一段复用上次已验证的 content，避免对话切换后的稳定阶段反复扫描全页 section。
    // Reuse the last verified content so stable periods after thread switches do not rescan all page sections.
    if (!rightTopPanelContentCache || !document.contains(rightTopPanelContentCache)) {
      rightTopPanelContentCache = null;
      return null;
    }
    const candidate = buildRightTopPanelContentCandidate(rightTopPanelContentCache);
    if (!candidate) rightTopPanelContentCache = null;
    return candidate;
  }

  function findEnvironmentPanelContent() {
    // 这一段从右上浮窗的直接子 section 读取 React sectionKey，优先定位真实环境面板。
    // Read React sectionKey from direct child sections of the top-right shell, preferring the real environment panel.
    const cachedCandidate = getCachedRightTopPanelContentCandidate();
    if (cachedCandidate?.priority === 0) return cachedCandidate.content;

    const contentCandidates = collectRightTopPanelContents()
      .map(buildRightTopPanelContentCandidate)
      .filter(Boolean)
      .sort((left, right) => left.priority - right.priority);

    const candidate = contentCandidates[0] || cachedCandidate;
    if (candidate) {
      rightTopPanelContentCache = candidate.content;
      return candidate.content;
    }
    rightTopPanelContentCache = null;
    return null;
  }

  function createEnvironmentUsageSection() {
    // 这一段创建右上环境面板里的自有 section，只使用 data 标记作为后续更新和清理锚点。
    // Create our owned section inside the environment panel, using a data marker for later updates and cleanup.
    const section = document.createElement("section");
    section.dataset.codexProEnvironmentUsagePanel = "true";
    section.innerHTML = `
      <div class="codex-pro-environment-usage-title">${i18n.html("usage.title")}</div>
      <div class="codex-pro-environment-usage-rows">
        <div class="codex-pro-environment-usage-row" data-codex-pro-window="primary">
          <span class="codex-pro-environment-usage-label">${i18n.html("usage.window.fiveHours")}</span>
          <span class="codex-pro-environment-usage-value" data-codex-pro-usage-value>${i18n.html("common.status.syncing")}</span>
        </div>
        <div class="codex-pro-environment-usage-row" data-codex-pro-window="secondary">
          <span class="codex-pro-environment-usage-label">${i18n.html("usage.window.oneWeek")}</span>
          <span class="codex-pro-environment-usage-value" data-codex-pro-usage-value>${i18n.html("common.status.syncing")}</span>
        </div>
      </div>
    `;
    return section;
  }

  function syncEnvironmentUsageTitle(section) {
    // 这一段只在语言或标题文本变化时改右上用量标题，避免普通刷新反复查询同一个标题节点。
    // Update the top-right usage title only when locale/copy changes, avoiding repeated title-node queries on normal refreshes.
    if (!section) return;
    const nextLocale = i18n.resolveLocale?.() || "";
    const nextTitle = i18n.t("usage.title");
    if (
      section.dataset.codexProUsageTitleLocale === nextLocale &&
      section.dataset.codexProUsageTitleText === nextTitle
    ) {
      return;
    }
    const titleElement = section?.querySelector?.(".codex-pro-environment-usage-title");
    if (titleElement) titleElement.textContent = nextTitle;
    section.dataset.codexProUsageTitleLocale = nextLocale;
    section.dataset.codexProUsageTitleText = nextTitle;
  }

  function ensureEnvironmentUsageSection(content) {
    // 这一段复用已有节点或把新节点插到原生滚动内容末尾，让它自然跟随面板隐藏和滚动。
    // Reuse the existing node or append a new one to the native scroll content so it follows hide and scroll behavior.
    const existing = content.querySelector(environmentUsageSelector);
    if (existing) {
      syncEnvironmentUsageTitle(existing);
      return existing;
    }
    removeEnvironmentUsageSections(content);
    const section = createEnvironmentUsageSection();
    content.appendChild(section);
    renderEnvironmentUsageSnapshot(section);
    return section;
  }

  function removeEnvironmentUsageSections(keepParent = null) {
    // 这一段移除不在当前目标容器里的自有节点，避免原生面板重建后留下孤儿。
    // Remove owned nodes outside the current target container so native panel rebuilds do not leave orphans.
    for (const section of document.querySelectorAll(environmentUsageSelector)) {
      if (keepParent && section.parentElement === keepParent) continue;
      section.remove();
    }
  }

  function isLikelyEnvironmentPanelMutationTarget(target) {
    // 这一段只把已知 content 或带结构 sectionKey 的节点视为重新挂载信号，避免可见正文变动唤醒。
    // Treat only known content or structurally keyed sections as remount signals, avoiding visible message-body wakeups.
    if (!(target instanceof HTMLElement) || target.closest?.(environmentUsageSelector)) return false;
    if (target === document.documentElement || target === document.body) return false;
    if (target.closest?.(".thread-scroll-container")) return false;
    if (rightTopPanelContentCache?.contains?.(target)) return true;
    if (target.tagName === "SECTION" && getVisibleRect(target) && hasRightTopUsageSectionKey(target)) return true;
    if (!hasDirectSectionChildren(target)) return false;
    return Array.from(target.children).some((child) => (
      child instanceof HTMLElement &&
      child.tagName === "SECTION" &&
      getVisibleRect(child) &&
      hasRightTopUsageSectionKey(child)
    ));
  }

  function collectNearbySectionElements(element, maxDepth = 2) {
    // 这一段只收集新增/移除节点附近两层 section，覆盖 shell/content 结构且避免深扫聊天正文。
    // Collect only nearby sections within two levels, covering shell/content structures without deep-scanning message DOM.
    const sections = [];
    const visit = (node, depth) => {
      if (!(node instanceof HTMLElement) || depth > maxDepth) return;
      if (node.tagName === "SECTION") sections.push(node);
      for (const child of node.children) {
        visit(child, depth + 1);
      }
    };
    visit(element, 0);
    return sections;
  }

  function mutationTouchesEnvironmentPanel(mutation) {
    // 这一段检查 mutation 目标和节点列表，避免 body 级观察器无条件触发局部重定位。
    // Check the mutation target and node lists so a body-level observer does not unconditionally trigger local relocation.
    const target = mutation.target instanceof HTMLElement ? mutation.target : mutation.target?.parentElement;
    if (target?.closest?.(".thread-scroll-container")) return false;
    if (isLikelyEnvironmentPanelMutationTarget(mutation.target)) return true;
    const nodes = [...mutation.addedNodes, ...mutation.removedNodes];
    return nodes.some((node) => {
      if (!(node instanceof HTMLElement)) return false;
      if (node.closest?.(".thread-scroll-container")) return false;
      if (isLikelyEnvironmentPanelMutationTarget(node)) return true;

      // 这一段只在新增/移除节点近邻 section 中读 fiber，并先要求它处在右上浮窗区域。
      // Read fiber only from nearby sections of added/removed nodes, after confirming the top-right panel geometry.
      return collectNearbySectionElements(node).some((section) => (
        getVisibleRect(section) &&
        hasRightTopUsageSectionKey(section)
      ));
    });
  }

  function bindEnvironmentPanelUsage(settingsApi, signal, options = {}) {
    // 这一段按设置把用量 section 挂到右上原生环境面板，面板不存在或关闭时清理自有节点。
    // Attach the usage section into the top-right native environment panel by setting, cleaning up when absent or disabled.
    let frameId = 0;
    const timeoutIds = new Set();
    let latestSettings = settingsApi?.getSettings?.() || {};
    let panelWasVisible = false;
    const onPanelVisible = typeof options.onPanelVisible === "function" ? options.onPanelVisible : null;

    const syncEnvironmentPanel = () => {
      frameId = 0;
      if (latestSettings.showUsageInEnvironmentPanel === false) {
        panelWasVisible = false;
        removeEnvironmentUsageSections();
        return;
      }
      const content = findEnvironmentPanelContent();
      if (!content) {
        panelWasVisible = false;
        removeEnvironmentUsageSections();
        return;
      }
      ensureEnvironmentUsageSection(content);
      removeEnvironmentUsageSections(content);
      if (!panelWasVisible) {
        panelWasVisible = true;
        onPanelVisible?.();
      }
    };
    const scheduleSync = () => {
      if (frameId) return;
      frameId = window.requestAnimationFrame(syncEnvironmentPanel);
    };
    const scheduleFollowUp = (delayMs) => {
      const timeoutId = window.setTimeout(() => {
        timeoutIds.delete(timeoutId);
        scheduleSync();
      }, delayMs);
      timeoutIds.add(timeoutId);
    };
    const scheduleSettledSync = () => {
      scheduleSync();
      scheduleFollowUp(80);
      scheduleFollowUp(180);
    };
    const unsubscribeSettings = settingsApi?.subscribe?.((nextSettings) => {
      latestSettings = nextSettings || {};
      scheduleSettledSync();
    }, signal);
    const observer = new MutationObserver((mutations) => {
      if (latestSettings.showUsageInEnvironmentPanel === false) return;
      if (mutations.some(mutationTouchesEnvironmentPanel)) {
        scheduleSync();
      }
    });

    scheduleSettledSync();
    observer.observe(document.body, {
      attributeFilter: ["aria-expanded", "aria-hidden", "class", "hidden", "style"],
      attributes: true,
      childList: true,
      subtree: true,
    });
    window.addEventListener("click", scheduleSettledSync, { capture: true, signal });
    window.addEventListener("resize", scheduleSettledSync, { signal });
    signal.addEventListener(
      "abort",
      () => {
        if (frameId) window.cancelAnimationFrame(frameId);
        for (const timeoutId of timeoutIds) {
          window.clearTimeout(timeoutId);
        }
        timeoutIds.clear();
        observer.disconnect();
        unsubscribeSettings?.();
        removeEnvironmentUsageSections();
      },
      { once: true },
    );
  }

  function bindHoverTransparency(root, signal) {
    // 这一段用全局鼠标坐标判断是否进入面板区域，让面板透明时仍然点击穿透。
    // Track global pointer coordinates so the panel can fade out while clicks still pass through.
    const updateTransparency = (event) => {
      const rect = root.getBoundingClientRect();
      const isInside =
        event.clientX >= rect.left &&
        event.clientX <= rect.right &&
        event.clientY >= rect.top &&
        event.clientY <= rect.bottom;

      root.classList.toggle("codex-pro-usage-transparent", isInside);
    };

    // 这一段在鼠标离开窗口或窗口失焦时恢复显示，避免透明状态卡住。
    // Restore visibility when the pointer leaves the window or the window loses focus.
    const restoreVisibility = () => {
      root.classList.remove("codex-pro-usage-transparent");
    };

    window.addEventListener("pointermove", updateTransparency, { passive: true, signal });
    window.addEventListener("mouseout", (event) => {
      if (!event.relatedTarget) restoreVisibility();
    }, { signal });
    window.addEventListener("blur", restoreVisibility, { signal });
  }

  function renderUsageRows(root, rows) {
    // 这一段按展示数据同步行节点，让 token 明细开关可以立即增删对应 DOM。
    // Sync row nodes from display data so the token-detail switch can add or remove DOM immediately.
    renderRowsInContainer(root, rows);
    updateInlineLayout(root);
  }

  function renderEnvironmentUsageRows(rows) {
    // 这一段缓存并同步右上环境面板里的用量文本；节点稍后创建时会复用最新快照。
    // Cache and sync usage text in the top-right environment panel; nodes created later reuse the latest snapshot.
    usagePanel.latestEnvironmentUsageRows = rows;
    usagePanel.latestEnvironmentUsageStatus = "";
    for (const section of document.querySelectorAll(environmentUsageSelector)) {
      syncEnvironmentUsageTitle(section);
      renderRowsInContainer(section, rows);
    }
  }

  function isPingRowValueElement(valueElement) {
    // 这一段识别独立 Ping 行，避免用量接口失败状态覆盖网络耗时读数。
    // Identify the independent Ping row so usage API failure status does not overwrite network timing.
    return Boolean(valueElement?.closest?.('[data-codex-pro-window="status-ping"]'));
  }

  function renderUsageStatus(root, text) {
    // 这一段在接口未就绪或失败时显示同一个状态，避免展示过期误导数据。
    // Show one consistent status when the bridge is unavailable or the request fails.
    for (const valueElement of root.querySelectorAll("[data-codex-pro-usage-value]")) {
      if (isPingRowValueElement(valueElement)) continue;
      valueElement.textContent = text;
    }
    updateInlineLayout(root);
  }

  function renderEnvironmentUsageStatus(text) {
    // 这一段缓存并同步右上环境面板里的失败状态，避免新挂载节点显示旧数据。
    // Cache and sync the failure state in the top-right environment panel so newly mounted nodes avoid stale data.
    usagePanel.latestEnvironmentUsageRows = null;
    usagePanel.latestEnvironmentUsageStatus = text;
    for (const section of document.querySelectorAll(environmentUsageSelector)) {
      syncEnvironmentUsageTitle(section);
      for (const valueElement of section.querySelectorAll("[data-codex-pro-usage-value]")) {
        if (isPingRowValueElement(valueElement)) continue;
        valueElement.textContent = text;
      }
    }
  }

  function getRowsContainer(container) {
    // 这一段兼容左下角根节点和右上环境 section，两边都复用同一份 rows 数据。
    // Support both the lower-left root and the top-right environment section with the same row data.
    return container.querySelector(".codex-pro-environment-usage-rows, .codex-pro-usage-rows");
  }

  function getRowClassNames(container) {
    // 这一段按所在容器选择 class，避免右上原生面板样式和左下浮层样式混用。
    // Choose classes by container so top-right native-panel styling and lower-left floating styling stay separate.
    const isEnvironment = Boolean(container.matches?.(environmentUsageSelector) || container.querySelector?.(".codex-pro-environment-usage-rows"));
    return isEnvironment
      ? {
          label: "codex-pro-environment-usage-label",
          row: "codex-pro-environment-usage-row",
          value: "codex-pro-environment-usage-value",
        }
      : {
          label: "codex-pro-usage-label",
          row: "codex-pro-usage-row",
          value: "codex-pro-usage-value",
        };
  }

  function ensureRowElement(rowsContainer, row, classNames) {
    // 这一段复用已有行，缺失时只创建本系统自己的最小 DOM。
    // Reuse existing rows and create only the minimal owned DOM when a row is missing.
    let rowElement = Array.from(rowsContainer.querySelectorAll("[data-codex-pro-window]"))
      .find((element) => element.dataset.codexProWindow === row.key);
    if (rowElement) return rowElement;
    rowElement = document.createElement("div");
    rowElement.className = classNames.row;
    rowElement.dataset.codexProWindow = row.key;
    rowElement.innerHTML = `
      <span class="${classNames.label}"></span>
      <span class="${classNames.value}" data-codex-pro-usage-value></span>
    `;
    return rowElement;
  }

  function renderRowsInContainer(container, rows) {
    // 这一段按 rows 顺序同步指定容器，移除不再展示的行，避免设置切换后残留旧 token 行。
    // Sync the container in row order and remove rows no longer shown so setting changes leave no stale token rows.
    const rowsContainer = getRowsContainer(container);
    if (!rowsContainer) return;
    const classNames = getRowClassNames(container);
    const nextRows = Array.isArray(rows) ? rows : [];
    const nextKeys = new Set(nextRows.map((row) => row.key));
    for (const rowElement of Array.from(rowsContainer.querySelectorAll("[data-codex-pro-window]"))) {
      if (!nextKeys.has(rowElement.dataset.codexProWindow)) rowElement.remove();
    }
    for (const row of nextRows) {
      if (!row?.key) continue;
      const rowElement = ensureRowElement(rowsContainer, row, classNames);
      const labelElement = rowElement.querySelector(`.${classNames.label}`);
      const valueElement = rowElement.querySelector("[data-codex-pro-usage-value]");
      if (labelElement) labelElement.textContent = row.label;
      if (valueElement) valueElement.textContent = row.value;
      if (row.title) rowElement.title = row.title;
      else rowElement.removeAttribute("title");
      rowsContainer.appendChild(rowElement);
    }
  }

  function renderEnvironmentUsageSnapshot(section) {
    // 这一段把最新用量或状态补写到刚插入的右上 section，解决面板晚于请求结果出现的问题。
    // Apply the latest usage or status to a newly inserted top-right section when the panel appears after refresh.
    syncEnvironmentUsageTitle(section);
    if (usagePanel.latestEnvironmentUsageRows) {
      renderRowsInContainer(section, usagePanel.latestEnvironmentUsageRows);
      return;
    }
    if (usagePanel.latestEnvironmentUsageStatus) {
      for (const valueElement of section.querySelectorAll("[data-codex-pro-usage-value]")) {
        if (isPingRowValueElement(valueElement)) continue;
        valueElement.textContent = usagePanel.latestEnvironmentUsageStatus;
      }
    }
  }

  usagePanel.view = {
    bindAdaptiveWidth,
    bindEnvironmentPanelUsage,
    bindNativeMenuVisibility,
    bindHoverTransparency,
    install,
    renderEnvironmentUsageRows,
    renderEnvironmentUsageStatus,
    renderUsageRows,
    renderUsageStatus,
    uninstall,
  };
})();
