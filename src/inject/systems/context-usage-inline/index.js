(() => {
  const runtime = window.__codexProRuntime;
  if (!runtime) return;

  const systemName = "context-usage-inline";
  const styleId = "codex-pro-context-usage-inline-style";
  const badgeSelector = "[data-codex-pro-context-usage-inline]";
  const ringToneSelector = "[data-codex-pro-context-usage-ring-tone]";
  const defaultDecimalPlaces = 1;
  const defaultRingCriticalColor = "#ef4444";
  const defaultRingCriticalThreshold = 80;
  const defaultRingWarningColor = "#f59e0b";
  const defaultRingWarningThreshold = 60;
  const maxDecimalPlaces = 3;
  const minDecimalPlaces = 0;
  const percentOnlyRetryDelayMs = 500;
  const percentOnlyRetryLimit = 20;
  const contextUsageCandidateSelector = '[role="img"], svg';
  let lastTonedRingIcon = null;

  function installStyles() {
    // 这一段安装输入框内联上下文用量样式，跟随 Codex 原生页脚文字风格。
    // Install inline context usage styles that follow Codex's native footer text style.
    runtime.dom.upsertStyle(
      styleId,
      `
        ${badgeSelector} {
          display: inline-flex;
          min-width: 0;
          max-width: 142px;
          align-items: center;
          gap: 4px;
          overflow: hidden;
          color: var(--color-token-description-foreground, currentColor);
          font: inherit;
          line-height: inherit;
          white-space: nowrap;
          font-variant-numeric: tabular-nums;
          pointer-events: none;
          user-select: none;
        }
        ${badgeSelector} .codex-pro-context-usage-counts {
          flex: 0 1 auto;
          min-width: 0;
          overflow: hidden;
          text-overflow: ellipsis;
        }
        ${badgeSelector} .codex-pro-context-usage-percent {
          flex: 0 0 auto;
          min-width: 0;
          overflow: hidden;
          text-overflow: ellipsis;
        }
        ${ringToneSelector},
        ${ringToneSelector} svg,
        svg${ringToneSelector} {
          color: var(--codex-pro-context-usage-ring-color, currentColor) !important;
        }
        ${ringToneSelector} circle,
        ${ringToneSelector} path,
        svg${ringToneSelector} circle,
        svg${ringToneSelector} path {
          stroke: var(--codex-pro-context-usage-ring-color, currentColor) !important;
        }
      `,
    );
  }

  function findContextUsageIcon() {
    // 这一段优先用 React fiber 数据定位 Codex 原生上下文圆圈，不读取多语言界面文案。
    // Prefer React fiber data to locate Codex's native context ring without reading localized UI copy.
    return findFiberContextUsageIcon() || findPercentAriaContextUsageIcon();
  }

  function isOwnBadgeElement(element) {
    // 这一段排除本系统插入的文本，避免兜底解析读到自己生成的百分比。
    // Exclude this system's own badge so fallback parsing cannot read the generated percent.
    return Boolean(element?.matches?.(badgeSelector) || element?.closest?.(badgeSelector));
  }

  function getVisibleRect(element) {
    // 这一段只接受真实可见节点，避免隐藏 composer 或旧节点参与定位。
    // Accept only truly visible nodes so hidden composers or stale nodes do not participate in locating.
    if (!(element instanceof HTMLElement) || isOwnBadgeElement(element)) return null;
    const rect = element.getBoundingClientRect();
    if (rect.width <= 0 || rect.height <= 0) return null;
    const style = window.getComputedStyle(element);
    if (style.display === "none" || style.visibility === "hidden" || Number(style.opacity) === 0) return null;
    return rect;
  }

  function isComposerFooterIconCandidate(element, rect = getVisibleRect(element)) {
    // 这一段把候选限制在输入框页脚的小图标范围，避免读取聊天正文或侧栏图标的 fiber。
    // Constrain candidates to small composer-footer icons so chat body or sidebar icons are not inspected.
    if (!rect) return false;
    return rect.bottom >= window.innerHeight * 0.55 &&
      rect.top <= window.innerHeight + 1 &&
      rect.width <= 80 &&
      rect.height <= 80;
  }

  function findFiberContextUsageIcon() {
    // 这一段在候选图标及少量父级上查找 contextUsage props，把 React 数据作为主定位信号。
    // Look for contextUsage props on candidate icons and a few parents, using React data as the primary signal.
    const visited = new Set();
    for (const candidate of document.querySelectorAll(contextUsageCandidateSelector)) {
      for (
        let element = candidate, depth = 0;
        element instanceof HTMLElement && element !== document.body && depth <= 3;
        element = element.parentElement, depth += 1
      ) {
        if (visited.has(element)) continue;
        visited.add(element);
        if (!isComposerFooterIconCandidate(element)) continue;
        if (readUsageFromFiber(element)) return element;
      }
    }
    return null;
  }

  function findPercentAriaContextUsageIcon() {
    // 这一段是最后兜底：只在同一区域解析百分比数字，不匹配任何界面文案。
    // Last fallback: parse only percent numbers in the same area, without matching any UI copy.
    return Array.from(document.querySelectorAll('[role="img"][aria-label]')).find((element) => (
      isComposerFooterIconCandidate(element) && readUsageFromAria(element)
    )) || null;
  }

  function findInlineTarget(icon) {
    // 这一段从圆圈向外寻找最近的横向布局容器，保证文字插在圆圈左侧并跟随输入框移动。
    // Walk outward from the ring to find the nearest flex row so text sits left of it and follows the composer.
    const anchor = icon.parentElement || icon;
    for (let element = anchor.parentElement; element && element !== document.body; element = element.parentElement) {
      const rect = element.getBoundingClientRect();
      const style = window.getComputedStyle(element);
      if (style.display.includes("flex") && rect.width > 0 && rect.height > 0 && rect.height <= 44) {
        return { container: element, anchor };
      }
    }

    // 这一段在 Codex DOM 结构变化时放弃插入，避免把文字挂到错误区域。
    // Give up if Codex's DOM shape changes so the badge is not mounted in the wrong area.
    return null;
  }

  function getReactFiber(element) {
    // 这一段读取 React 挂在 DOM 节点上的内部 fiber 引用，只用于圆圈附近的用量 props。
    // Read React's internal fiber reference from the DOM node, limited to usage props near the ring.
    const fiberKey = Object.keys(element).find((key) => key.startsWith("__reactFiber$"));
    return fiberKey ? element[fiberKey] : null;
  }

  function normalizeUsage(value) {
    // 这一段把可能的 contextUsage 对象收敛成纯数字字段，异常字段直接忽略。
    // Normalize a possible contextUsage object into plain numeric fields, ignoring invalid fields.
    if (!value || typeof value !== "object") return null;
    const usedTokens = Number(value.usedTokens);
    const contextWindow = Number(value.contextWindow);
    const remainingTokens = Number(value.remainingTokens);
    const percent = Number(value.percent);

    // 这一段只接受至少带有百分比或 token 总量的数据，避免误读其它 props。
    // Accept only data that has at least a percent or token counts so unrelated props are not misread.
    if (![usedTokens, contextWindow, percent].some(Number.isFinite)) return null;
    return { contextWindow, percent, remainingTokens, usedTokens };
  }

  function hasCompleteTokenCounts(usage) {
    // 这一段判断数据是否足够显示“当前 / 总量”，避免 0 / 0 占位数据提前截断查找。
    // Check whether usage can show "used / total" so 0 / 0 placeholder data does not stop the search early.
    return Number.isFinite(usage?.usedTokens) && usage.usedTokens >= 0 && usage?.contextWindow > 0;
  }

  function isPlaceholderUsage(usage) {
    // 这一段识别切换对话时 Codex 短暂给出的占位数据，避免渲染误导性的 0 / 0。
    // Detect the temporary placeholder Codex emits while switching chats so misleading 0 / 0 is not rendered.
    const hasContextWindow = Number.isFinite(usage?.contextWindow);
    const hasUsedTokens = Number.isFinite(usage?.usedTokens);
    const hasZeroPercentOnly = !hasContextWindow && !hasUsedTokens && Number.isFinite(usage?.percent) && usage.percent <= 0;
    return (hasContextWindow && usage.contextWindow <= 0) || hasZeroPercentOnly;
  }

  function readUsageFromFiber(icon) {
    // 这一段沿 React 父链查找 contextUsage，当前 Codex 会把 usedTokens/contextWindow 放在这里。
    // Walk the React owner chain for contextUsage; current Codex stores usedTokens/contextWindow there.
    let fiber = getReactFiber(icon);
    let fallbackUsage = null;
    for (let depth = 0; fiber && depth < 30; depth += 1) {
      const usages = [
        normalizeUsage(fiber.pendingProps?.contextUsage),
        normalizeUsage(fiber.memoizedProps?.contextUsage),
      ];
      for (const usage of usages) {
        if (!usage) continue;
        if (hasCompleteTokenCounts(usage)) return usage;
        fallbackUsage ??= usage;
      }
      fiber = fiber.return;
    }

    // 这一段找不到完整 token 数据时才返回半截数据，让调用方继续保持百分比降级展示。
    // Return partial data only after complete token data is unavailable, preserving the percent fallback.
    return fallbackUsage;
  }

  function readUsageFromAria(icon) {
    // 这一段只作为最后兜底从圆圈可访问文案中提取百分比，不用界面文案定位元素。
    // Use this only as the last fallback to extract percent, not to locate by localized UI copy.
    const label = icon.getAttribute("aria-label") || "";
    const match = /(\d+(?:\.\d+)?)\s*%/.exec(label);
    return match ? { percent: Number(match[1]) } : null;
  }

  function readContextUsage(icon) {
    // 这一段优先读取完整 token 数据，失败时保留百分比展示能力。
    // Prefer complete token data, while preserving percent-only display as a fallback.
    return readUsageFromFiber(icon) || readUsageFromAria(icon);
  }

  function normalizeDecimalPlaces(value) {
    // 这一段在本系统内再次限制小数位，避免设置模块缺失时出现异常展示。
    // Clamp decimal places inside this system too so missing settings cannot produce invalid display.
    const decimalPlaces = Number(value);
    if (!Number.isFinite(decimalPlaces)) return defaultDecimalPlaces;
    return Math.min(Math.max(Math.round(decimalPlaces), minDecimalPlaces), maxDecimalPlaces);
  }

  function formatScaled(value, decimalPlaces) {
    // 这一段对 k/M 数值保留最多一位小数，避免输入框页脚过长。
    // Keep the configured decimal places for k/M values so the composer footer stays compact.
    const fixedValue = value.toFixed(decimalPlaces);
    if (decimalPlaces <= 0) return fixedValue;
    return fixedValue.replace(/(\.\d*?)0+$/, "$1").replace(/\.$/, "");
  }

  function formatTokenCount(value, decimalPlaces) {
    // 这一段把 token 数压缩成用户要求的 k/M 单位。
    // Compact token counts into the requested k/M units.
    if (!Number.isFinite(value) || value < 0) return "";
    if (value >= 1_000_000) return `${formatScaled(value / 1_000_000, decimalPlaces)}M`;
    if (value >= 1_000) return `${formatScaled(value / 1_000, decimalPlaces)}k`;
    return String(Math.round(value));
  }

  function formatPercent(value) {
    // 这一段把百分比限制在 0 到 100 之间，并使用整数显示。
    // Clamp percent to 0-100 and display it as an integer.
    if (!Number.isFinite(value)) return "";
    const percent = Math.min(Math.max(value, 0), 100);
    return `${Math.round(percent)}%`;
  }

  function getUsagePercent(usage) {
    // 这一段把 contextUsage 收敛成 0-100 的百分比，忽略新对话切换时的占位状态。
    // Collapse contextUsage into a 0-100 percent while ignoring placeholder states during chat switches.
    if (isPlaceholderUsage(usage)) return null;
    const percent = Number.isFinite(usage?.percent)
      ? usage.percent
      : usage?.contextWindow > 0 && Number.isFinite(usage?.usedTokens)
        ? (usage.usedTokens / usage.contextWindow) * 100
        : NaN;
    if (!Number.isFinite(percent)) return null;
    return Math.min(Math.max(percent, 0), 100);
  }

  function normalizeRingThreshold(value, fallbackValue) {
    // 这一段在运行态再次钳制阈值，防止设置模块缺失或旧缓存带来异常值。
    // Clamp thresholds again at runtime so missing settings modules or stale caches cannot produce invalid values.
    const threshold = Number(value);
    if (!Number.isFinite(threshold)) return fallbackValue;
    return Math.min(Math.max(Math.round(threshold), 0), 100);
  }

  function normalizeRingColor(value, fallbackValue) {
    // 这一段在写入 CSS 变量前再次校验颜色，只允许安全的 6 位十六进制值。
    // Validate colors again before writing CSS variables, allowing only safe six-digit hex values.
    const rawValue = typeof value === "string" ? value.trim() : "";
    const match = /^#?([0-9a-f]{6})$/iu.exec(rawValue);
    return match ? `#${match[1].toLowerCase()}` : fallbackValue;
  }

  function getRingToneConfig(settings) {
    // 这一段读取用户可配置的阈值和颜色，并保证警告阈值不超过危险阈值。
    // Read user-configurable thresholds and colors, keeping warning no higher than critical.
    const criticalThreshold = normalizeRingThreshold(
      settings?.contextUsageRingCriticalThreshold,
      defaultRingCriticalThreshold,
    );
    return {
      criticalColor: normalizeRingColor(settings?.contextUsageRingCriticalColor, defaultRingCriticalColor),
      criticalThreshold,
      warningColor: normalizeRingColor(settings?.contextUsageRingWarningColor, defaultRingWarningColor),
      warningThreshold: Math.min(
        normalizeRingThreshold(settings?.contextUsageRingWarningThreshold, defaultRingWarningThreshold),
        criticalThreshold,
      ),
    };
  }

  function clearElementRingTone(element) {
    // 这一段只清理本系统写入的属性和 CSS 变量，不回滚或猜测 Codex 原生样式。
    // Clear only attributes and CSS variables written by this system, without guessing Codex's native styles.
    if (!(element instanceof HTMLElement || element instanceof SVGElement)) return;
    element.removeAttribute("data-codex-pro-context-usage-ring-tone");
    element.style.removeProperty("--codex-pro-context-usage-ring-color");
  }

  function clearRingTone() {
    // 这一段清理所有带有本系统标记的圆圈，覆盖重新注入或 React 替换后的残留节点。
    // Clear every ring carrying this system's marker, covering reinjection or React replacement leftovers.
    for (const element of document.querySelectorAll(ringToneSelector)) clearElementRingTone(element);
    if (lastTonedRingIcon) clearElementRingTone(lastTonedRingIcon);
    lastTonedRingIcon = null;
  }

  function applyRingTone(icon, usage, settings) {
    // 这一段按百分比把官方圆圈标记为警告或危险；低于阈值时恢复官方原色。
    // Mark the native ring as warning or critical by percent; restore the native color below thresholds.
    if (settings?.enableContextUsageRingColors !== true) {
      clearRingTone();
      return;
    }
    const percent = getUsagePercent(usage);
    if (percent == null) {
      clearRingTone();
      return;
    }
    const config = getRingToneConfig(settings);
    const tone = percent >= config.criticalThreshold
      ? "critical"
      : percent >= config.warningThreshold
        ? "warning"
        : "";
    const color = tone === "critical" ? config.criticalColor : tone === "warning" ? config.warningColor : "";
    if (!tone || !color) {
      clearRingTone();
      return;
    }
    for (const element of document.querySelectorAll(ringToneSelector)) {
      if (element !== icon) clearElementRingTone(element);
    }
    if (lastTonedRingIcon && lastTonedRingIcon !== icon) clearElementRingTone(lastTonedRingIcon);
    lastTonedRingIcon = icon;
    icon.setAttribute("data-codex-pro-context-usage-ring-tone", tone);
    icon.style.setProperty("--codex-pro-context-usage-ring-color", color);
  }

  function buildDisplayParts(usage, decimalPlaces) {
    // 这一段在新对话真实上下文未就绪时不渲染内联文字，等待后续重试刷新。
    // Skip inline text while the new chat's real context is not ready, waiting for the retry refresh.
    if (isPlaceholderUsage(usage)) return null;

    // 这一段在缺少 percent 但有 token 总量时自行推导百分比。
    // Derive percent from token counts when percent is missing but counts are available.
    const derivedPercent =
      Number.isFinite(usage?.percent)
        ? usage.percent
        : usage?.contextWindow > 0
          ? (usage.usedTokens / usage.contextWindow) * 100
          : NaN;

    // 这一段分别生成“当前/总量”和百分比文本，便于小窗口只保留百分比。
    // Build count and percent text separately so narrow windows can keep only the percent.
    const canShowCounts = hasCompleteTokenCounts(usage);
    const usedText = canShowCounts ? formatTokenCount(usage.usedTokens, decimalPlaces) : "";
    const totalText = canShowCounts ? formatTokenCount(usage.contextWindow, decimalPlaces) : "";
    const counts = usedText && totalText ? `${usedText} / ${totalText}` : "";
    const percent = formatPercent(derivedPercent);
    if (!counts && !percent) return null;
    return { counts, percent };
  }

  function ensureBadge() {
    // 这一段复用已有节点，避免重复注入或 React 重渲染后生成多个文本。
    // Reuse the existing badge so reinjection or React rerenders do not create duplicates.
    let badge = document.querySelector(badgeSelector);
    if (badge) return badge;

    // 这一段创建两个子节点，让空间不足时优先压缩 token 数但保留百分比。
    // Create two child nodes so tight space compresses token counts first while preserving the percent.
    badge = document.createElement("span");
    badge.setAttribute("data-codex-pro-context-usage-inline", "true");
    const counts = document.createElement("span");
    const percent = document.createElement("span");
    counts.className = "codex-pro-context-usage-counts";
    percent.className = "codex-pro-context-usage-percent";
    badge.append(counts, percent);
    return badge;
  }

  function removeBadge() {
    // 这一段移除当前内联节点，避免圆圈消失后留下过期用量。
    // Remove the current inline badge so stale usage is not shown after the native ring disappears.
    document.querySelector(badgeSelector)?.remove();
  }

  function renderBadge(badge, parts, target) {
    // 这一段只在文本变化时写 DOM，降低 MutationObserver 自触发次数。
    // Write DOM only when text changes to reduce self-triggered MutationObserver work.
    const countsElement = badge.querySelector(".codex-pro-context-usage-counts");
    const percentElement = badge.querySelector(".codex-pro-context-usage-percent");
    if (countsElement && countsElement.textContent !== parts.counts) countsElement.textContent = parts.counts;
    if (percentElement && percentElement.textContent !== parts.percent) percentElement.textContent = parts.percent;
    if (countsElement) countsElement.hidden = !parts.counts;
    if (percentElement) percentElement.hidden = !parts.percent;

    // 这一段给辅助技术和调试保留完整状态文本，并清理旧版紧凑隐藏标记。
    // Keep the full status text for accessibility/debugging and clear the old compact-hide marker.
    const fullText = [parts.counts, parts.percent].filter(Boolean).join(" ");
    const ariaLabel = fullText;
    if (badge.getAttribute("aria-label") !== ariaLabel) badge.setAttribute("aria-label", ariaLabel);
    badge.removeAttribute("data-codex-pro-context-usage-compact");
  }

  function syncInlineBadge(currentSettings, retryPercentOnlyUsage, clearPercentOnlyRetry) {
    // 这一段优先执行显示开关；文字和圆圈警示色都关闭时彻底恢复 Codex 原生状态。
    // Apply display switches first; when both text and ring colors are off, restore Codex's native state.
    const shouldShowBadge = currentSettings?.showContextUsageInline !== false;
    const shouldColorRing = currentSettings?.enableContextUsageRingColors === true;
    if (!shouldShowBadge && !shouldColorRing) {
      clearPercentOnlyRetry?.();
      removeBadge();
      clearRingTone();
      return;
    }

    // 这一段定位原生圆圈并读取用量，圆圈变色和内联文字复用同一个真实来源。
    // Locate the native ring and read usage; ring coloring and inline text reuse the same real source.
    const icon = findContextUsageIcon();
    const usage = icon ? readContextUsage(icon) : null;
    if (!icon) {
      clearRingTone();
      removeBadge();
      clearPercentOnlyRetry?.();
      return;
    }
    if (!usage) {
      clearRingTone();
      removeBadge();
      retryPercentOnlyUsage?.();
      return;
    }
    applyRingTone(icon, usage, currentSettings);

    // 这一段允许用户只保留圆圈警示色，不强制显示额外的 token 文本。
    // Allow users to keep only ring warning colors without forcing the extra token text.
    if (!shouldShowBadge) {
      removeBadge();
      if (getUsagePercent(usage) == null) retryPercentOnlyUsage?.();
      else clearPercentOnlyRetry?.();
      return;
    }

    // 这一段只为内联文字寻找插入容器；圆圈警示色不依赖该容器存在。
    // Find the insertion container only for inline text; ring coloring does not depend on that container.
    const target = findInlineTarget(icon);
    const decimalPlaces = normalizeDecimalPlaces(currentSettings?.contextUsageDecimalPlaces);
    const parts = buildDisplayParts(usage, decimalPlaces);
    if (!target) {
      clearPercentOnlyRetry?.();
      removeBadge();
      return;
    }
    if (!parts) {
      // 这一段遇到 0 / 0 占位或暂时缺数据时隐藏文字，并继续等待真实上下文到位。
      // Hide text for 0 / 0 placeholders or temporary missing data, then keep waiting for real context.
      removeBadge();
      retryPercentOnlyUsage?.();
      return;
    }

    // 这一段把节点插到圆圈左侧，React 后续重绘移除时会由观察器自动补回。
    // Insert the badge to the left of the ring; the observer restores it if React later rerenders.
    const badge = ensureBadge();
    if (badge.parentElement !== target.container || badge.nextElementSibling !== target.anchor) {
      target.container.insertBefore(badge, target.anchor);
    }
    renderBadge(badge, parts, target);

    // 这一段在只有百分比或占位数据时短暂复查，接住 Codex 稍后才挂上的 usedTokens/contextWindow。
    // Briefly retry percent-only or placeholder data so late usedTokens/contextWindow props can upgrade the display.
    if (hasCompleteTokenCounts(usage)) {
      clearPercentOnlyRetry?.();
    } else {
      retryPercentOnlyUsage?.();
    }
  }

  runtime.registerSystem(systemName, () => {
    const settings = runtime.systemModules.settingsMenu?.settings;
    let currentSettings = settings?.getSettings?.() || {};
    const controller = new AbortController();
    runtime.lifecycle.replaceController(systemName, controller);
    runtime.lifecycle.replaceWindowController("__codexProContextUsageInlineController", controller);
    installStyles();

    // 这一段用 requestAnimationFrame 合并 DOM 变化，避免输入流式输出时重复扫描。
    // Coalesce DOM changes with requestAnimationFrame so streaming output does not cause repeated scans.
    let frameId = 0;
    let percentOnlyRetryAttempts = 0;
    let percentOnlyRetryTimerId = 0;
    const clearPercentOnlyRetry = () => {
      if (percentOnlyRetryTimerId) {
        window.clearTimeout(percentOnlyRetryTimerId);
        percentOnlyRetryTimerId = 0;
      }
      percentOnlyRetryAttempts = 0;
    };
    const scheduleSync = (source = "external") => {
      if (source !== "retry") percentOnlyRetryAttempts = 0;
      if (frameId) return;
      frameId = window.requestAnimationFrame(() => {
        frameId = 0;
        syncInlineBadge(currentSettings, schedulePercentOnlyRetry, clearPercentOnlyRetry);
      });
    };
    const schedulePercentOnlyRetry = () => {
      // 这一段限制百分比降级态的复查次数，避免长期后台轮询。
      // Limit retries while the display is percent-only so this does not become background polling.
      if (percentOnlyRetryTimerId || percentOnlyRetryAttempts >= percentOnlyRetryLimit) return;
      percentOnlyRetryAttempts += 1;
      percentOnlyRetryTimerId = window.setTimeout(() => {
        percentOnlyRetryTimerId = 0;
        scheduleSync("retry");
      }, percentOnlyRetryDelayMs);
    };

    // 这一段把设置模块里的开关和小数位同步到当前系统，并立即刷新显示。
    // Sync the display switch and decimal places from settings into this system and refresh immediately.
    const syncSettings = (nextSettings) => {
      currentSettings = nextSettings || settings?.getSettings?.() || {};
      scheduleSync("settings");
    };

    // 这一段监听 Codex composer 重绘和圆圈百分比变化，保持内联文本接近实时。
    // Watch composer rerenders and ring percent changes so the inline text stays near realtime.
    const observer = new MutationObserver(() => scheduleSync("mutation"));
    observer.observe(document.body, {
      attributeFilter: ["aria-label", "stroke-dashoffset"],
      attributes: true,
      childList: true,
      subtree: true,
    });
    window.addEventListener("resize", () => scheduleSync("resize"), { signal: controller.signal });
    // 这一段清理观察器、动画帧和内联节点，避免重复注入后残留监听器。
    // Clean up the observer, animation frame, and badge so reinjection leaves no stale listeners.
    controller.signal.addEventListener(
      "abort",
      () => {
        observer.disconnect();
        if (frameId) window.cancelAnimationFrame(frameId);
        clearPercentOnlyRetry();
        removeBadge();
        clearRingTone();
      },
      { once: true },
    );

    syncSettings(currentSettings);
    return { sync: syncSettings };
  }, { enableSetting: "enableContextUsageInline" });
})();
