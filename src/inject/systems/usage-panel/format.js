(() => {
  const runtime = window.__codexProRuntime;
  if (!runtime) return;
  const usagePanel = runtime.systemModules.usagePanel ??= {};
  const i18n = runtime.i18n;

  function getWindowLabel(windowInfo, fallbackLabel) {
    // 这一段按 Codex 返回的窗口秒数识别 5 小时和 1 周，避免依赖返回顺序。
    // Identify five-hour and weekly windows from duration seconds instead of relying on order.
    const seconds = Number(windowInfo?.limit_window_seconds);
    if (Number.isFinite(seconds)) {
      const hours = seconds / 3600;
      const days = seconds / 86_400;
      if (Math.abs(hours - 5) <= 0.25) return i18n.t("usage.window.fiveHours");
      if (Math.abs(days - 7) <= 0.25) return i18n.t("usage.window.oneWeek");
    }

    // 这一段在接口缺少窗口秒数时保留默认标签，保证 UI 不空白。
    // Keep the fallback label when the API omits duration so the UI never goes blank.
    return fallbackLabel;
  }

  function formatRemainingPercent(windowInfo) {
    // 这一段把 Codex 的 used_percent 转成剩余百分比，对齐“剩余用量”的含义。
    // Convert Codex used_percent into remaining percent to match the usage-remaining label.
    const usedPercent = Number(windowInfo?.used_percent);
    if (!Number.isFinite(usedPercent)) return "--%";
    const remainingPercent = Math.min(Math.max(100 - usedPercent, 0), 100);
    return `${Math.round(remainingPercent)}%`;
  }

  function formatUsageDate(date, fallbackText) {
    // 这一段复用 Codex 菜单的表达方式：当天显示时间，跨天显示月日。
    // Match the Codex menu style: same-day resets show time, later resets show month and day.
    if (!date || Number.isNaN(date.getTime())) return fallbackText;
    const now = new Date();
    const isSameDay =
      date.getFullYear() === now.getFullYear() &&
      date.getMonth() === now.getMonth() &&
      date.getDate() === now.getDate();
    if (isSameDay) {
      return new Intl.DateTimeFormat(i18n.resolveLocale(), {
        hour: "2-digit",
        minute: "2-digit",
      }).format(date);
    }
    return i18n.t("usage.date.monthDay", {
      day: date.getDate(),
      month: date.getMonth() + 1,
    });
  }

  function formatResetTime(windowInfo) {
    // 这一段把秒级 reset_at 转成 Date，接口异常时给出稳定占位。
    // Convert second-based reset_at into a Date and use a stable placeholder for bad data.
    const resetAtSeconds = Number(windowInfo?.reset_at);
    const resetAt = Number.isFinite(resetAtSeconds) ? new Date(resetAtSeconds * 1000) : null;
    return formatUsageDate(resetAt, "--:--");
  }

  function formatTokenCount(value) {
    // 这一段把 token 数格式化为紧凑读数，保留表格对齐且避免长数字撑宽面板。
    // Format token counts compactly so rows stay aligned and long numbers do not widen the panel.
    const count = Number(value);
    if (!Number.isFinite(count) || count < 0) return "--";
    if (count >= 1_000_000) return `${(count / 1_000_000).toFixed(count >= 10_000_000 ? 0 : 1)}M`;
    if (count >= 1_000) return `${(count / 1_000).toFixed(count >= 10_000 ? 0 : 1)}K`;
    return String(Math.round(count));
  }

  function formatTodayTokenCount(value) {
    // 这一段只给 Today 行使用中文万/亿单位，其它 token 明细继续沿用 k/M。
    // Use Chinese 万/亿 units only for the Today row; other token detail rows keep k/M.
    const count = Number(value);
    if (!Number.isFinite(count) || count < 0) return "--";
    if (i18n.resolveLocale?.() !== "zh-CN") return formatTokenCount(count);
    const roundedCount = Math.round(count);
    if (roundedCount >= 100_000_000) return `${trimCompactDecimal((roundedCount / 100_000_000).toFixed(1))}亿`;
    if (roundedCount >= 10_000) return `${trimCompactDecimal((roundedCount / 10_000).toFixed(1))}万`;
    return String(roundedCount);
  }

  function trimCompactDecimal(value) {
    // 这一段去掉中文紧凑单位里的无意义 .0，避免出现 10.0万 这种读数。
    // Remove redundant .0 from Chinese compact units so values such as 10.0万 are not shown.
    return String(value).replace(/\.0$/u, "");
  }

  function formatCachePercent(cachedInputTokens, inputTokens) {
    // 这一段用缓存 token / 输入 token 计算命中占比，输入为 0 时显示稳定占位。
    // Compute cache hit share as cached input tokens over input tokens, using a stable placeholder when input is zero.
    const cached = Number(cachedInputTokens);
    const input = Number(inputTokens);
    if (!Number.isFinite(cached) || !Number.isFinite(input) || input <= 0) return "--%";
    const percent = Math.min(Math.max((cached / input) * 100, 0), 100);
    return `${Math.round(percent)}%`;
  }

  function formatPingLatency(ping) {
    // 这一段把 Ping 快照收敛成单行毫秒读数，失败或未完成时保持最小占位。
    // Normalize a Ping snapshot into one millisecond value, keeping a minimal placeholder before success or on failure.
    const latencyMs = Number(ping?.latencyMs);
    if (!Number.isFinite(latencyMs) || latencyMs < 0) return "--";
    return `${Math.round(latencyMs)}ms`;
  }

  function formatTodayTokenUsage(todayUsage) {
    // 这一段只展示 Today 聚合总 token；数据源不可用或尚未同步时保持占位。
    // Show only the Today aggregate total token count, keeping a placeholder when the source is unavailable or unsynced.
    if (!todayUsage?.available) return "--";
    return formatTodayTokenCount(todayUsage.totalTokens);
  }

  function formatResetCreditExpiry(value) {
    // 这一段让重置次数有效期沿用用量窗口的本地化日期表达，不额外显示年份。
    // Format reset-credit expiry like quota windows, using localized month/day without an extra year.
    const date = new Date(value);
    return formatUsageDate(date, "--");
  }

  function formatResetCredits(resetCredits) {
    // 这一段只显示可用次数和最近有效期；缺少字段时保持占位，不展示原始响应。
    // Show only the available count and nearest expiry; keep placeholders when fields are missing.
    if (!resetCredits?.available) return "--";
    const count = Number(resetCredits.availableCount);
    const countText = Number.isFinite(count) && count >= 0 ? String(Math.round(count)) : "--";
    return `${countText} / ${formatResetCreditExpiry(resetCredits.nearestExpiresAt)}`;
  }

  function formatInputTokenBreakdown(cachedInputTokens, inputTokens, options = {}) {
    // 这一段把输入展示成实际输入，按设置决定是否追加包含缓存命中的总输入。
    // Show actual input and append cache-inclusive total input only when the setting asks for it.
    const cached = Number(cachedInputTokens);
    const input = Number(inputTokens);
    const showTotalInputTokens = options.showTotalInputTokens === true;
    if (!Number.isFinite(input) || input < 0) return showTotalInputTokens ? "-- / --" : "--";
    const actualInputTokens = Math.max(input - (Number.isFinite(cached) ? cached : 0), 0);
    const actualInputText = formatTokenCount(actualInputTokens);
    return showTotalInputTokens ? `${actualInputText} / ${formatTokenCount(input)}` : actualInputText;
  }

  function normalizeUsageRows(usage) {
    // 这一段读取 Codex 内部 /wham/usage 响应里的两个核心窗口。
    // Read the two core windows from Codex's internal /wham/usage response.
    const windows = [
      { key: "primary", fallbackLabel: i18n.t("usage.window.fiveHours"), data: usage?.rate_limit?.primary_window },
      { key: "secondary", fallbackLabel: i18n.t("usage.window.oneWeek"), data: usage?.rate_limit?.secondary_window },
    ];

    // 这一段生成面板需要的纯展示数据，避免把账号字段写入 DOM。
    // Build display-only rows so account fields are never written into the DOM.
    return windows.map((windowEntry) => ({
      key: windowEntry.key,
      label: getWindowLabel(windowEntry.data, windowEntry.fallbackLabel),
      value: `${formatRemainingPercent(windowEntry.data)} ${formatResetTime(windowEntry.data)}`,
    }));
  }

  function normalizeTokenUsageRows(tokenUsage, options = {}) {
    // 这一段生成当前对话累计 token 的三行展示；无快照时保持同步中而不是猜测数值。
    // Build the three current-conversation token rows; keep a syncing state instead of guessing values.
    const total = tokenUsage?.total;
    const showTotalInputTokens = options.showTotalInputTokens === true;
    if (!total) {
      return [
        { key: "token-output", label: i18n.t("usage.token.output"), value: "--" },
        { key: "token-input", label: i18n.t("usage.token.input"), value: showTotalInputTokens ? "-- / --" : "--" },
        { key: "token-cache", label: i18n.t("usage.token.cache"), value: "--" },
      ];
    }
    return [
      {
        key: "token-output",
        label: i18n.t("usage.token.output"),
        value: formatTokenCount(total.outputTokens),
      },
      {
        key: "token-input",
        label: i18n.t("usage.token.input"),
        value: formatInputTokenBreakdown(total.cachedInputTokens, total.inputTokens, { showTotalInputTokens }),
      },
      {
        key: "token-cache",
        label: i18n.t("usage.token.cache"),
        value: `${formatTokenCount(total.cachedInputTokens)} (${formatCachePercent(total.cachedInputTokens, total.inputTokens)})`,
      },
    ];
  }

  function normalizeTodayTokenUsageRows(todayUsage) {
    // 这一段生成 Today token 单行，来源说明留在设置项，面板里只显示稳定读数。
    // Build the single Today-token row; source explanation stays in settings while the panel shows a stable readout.
    return [
      {
        key: "token-today",
        label: i18n.t("usage.token.today"),
        value: formatTodayTokenUsage(todayUsage),
      },
    ];
  }

  function normalizeResetCreditRows(resetCredits) {
    // 这一段生成重置次数单行，固定放在基础额度窗口之后。
    // Build the reset-credit row, placed directly after the base quota windows.
    return [
      {
        key: "reset-credits",
        label: i18n.t("usage.resetCredits.label"),
        value: formatResetCredits(resetCredits),
      },
    ];
  }

  function normalizePingRows(ping) {
    // 这一段把可配置网络检测耗时作为最后一行展示，不混入用量或 token 语义。
    // Render the configurable network timing as the last row without mixing it with quota or token meaning.
    return [
      {
        key: "status-ping",
        label: i18n.t("usage.ping.label"),
        value: formatPingLatency(ping),
      },
    ];
  }

  usagePanel.format = {
    normalizePingRows,
    normalizeResetCreditRows,
    normalizeTodayTokenUsageRows,
    normalizeTokenUsageRows,
    normalizeUsageRows,
  };
})();
