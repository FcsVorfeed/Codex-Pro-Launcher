(() => {
  const runtime = window.__codexProRuntime;
  if (!runtime) return;

  runtime.registerSystem("usage-panel", () => {
    const { api, format, view } = runtime.systemModules.usagePanel;
    const settings = runtime.systemModules.settingsMenu?.settings;
    const todayTokenRefreshMs = 60_000;
    const hiddenTodayTokenSource = "hidden";

    // 这一段先替换旧控制器，再安装新面板，避免旧卸载逻辑删掉刚创建的新 DOM。
    // Replace the old controller before installing the new panel so old cleanup cannot remove the new DOM.
    const controller = new AbortController();
    runtime.lifecycle.replaceController("usage-panel", controller);
    runtime.lifecycle.replaceWindowController("__codexProUsageController", controller);
    const root = view.install();

    view.bindHoverTransparency(root, controller.signal);
    view.bindNativeMenuVisibility(root, settings, controller.signal);
    view.bindAdaptiveWidth(root, settings, controller.signal);
    view.bindEnvironmentPanelUsage(settings, controller.signal);

    // 这一段合并额度窗口、当前对话 token 行和可配置 Ping 行，设置关闭时不生成对应行。
    // Merge quota-window rows, current-conversation token rows, and the configurable Ping row, omitting disabled rows.
    let latestUsageSnapshot = null;
    let latestPingSnapshot = null;
    let latestTodayTokenSnapshot = null;
    let activeTodayTokenSource = settings?.getSettings?.()?.usagePanelTodayTokenSource || hiddenTodayTokenSource;
    let activePingEndpoint = settings?.getSettings?.()?.usagePanelPingEndpoint || "";
    let pingRequestInFlight = false;
    let todayTokenRequestInFlight = false;
    let todayTokenRequestInFlightSource = "";
    const buildRows = (usage) => {
      const rows = format.normalizeUsageRows(usage);
      const latestSettings = settings?.getSettings?.() || {};
      if ((latestSettings.usagePanelTodayTokenSource || hiddenTodayTokenSource) !== hiddenTodayTokenSource) {
        rows.push(...format.normalizeTodayTokenUsageRows(latestTodayTokenSnapshot));
      }
      if (latestSettings.showUsagePanelTokenDetails === true) {
        rows.push(...format.normalizeTokenUsageRows(api.readConversationTokenUsage?.(), {
          showTotalInputTokens: latestSettings.showUsagePanelTotalInputTokens === true,
        }));
      }
      if (latestSettings.showUsagePanelPing !== false) {
        rows.push(...format.normalizePingRows(latestPingSnapshot));
      }
      return rows;
    };
    const renderRowsFromSnapshot = () => {
      // 这一段用最近一次额度快照和当前线程 token 缓存重渲染，不因为切换对话额外请求额度接口。
      // Re-render from the latest quota snapshot and current-thread token cache without refetching quota on thread switches.
      const rows = buildRows(latestUsageSnapshot);
      view.renderUsageRows(root, rows);
      view.renderEnvironmentUsageRows(rows);
    };

    // 这一段刷新用量数据并渲染展示，失败时显示统一状态。
    // Refresh usage data and render rows, showing one consistent state on failure.
    const refresh = () => {
      api
        .fetchUsage(controller.signal)
        .then((usage) => {
          latestUsageSnapshot = usage;
          renderRowsFromSnapshot();
        })
        .catch((error) => {
          if (error?.name === "AbortError") return;
          latestUsageSnapshot = null;
          const rows = buildRows(null);
          const unavailableText = runtime.i18n.t("common.status.notAvailable");
          view.renderUsageRows(root, rows);
          view.renderEnvironmentUsageRows(rows);
          view.renderUsageStatus(root, unavailableText);
          view.renderEnvironmentUsageStatus(unavailableText);
        });
    };

    // 这一段独立刷新 Ping，避免用量接口失败时影响网络耗时行。
    // Refresh Ping independently so usage API failures do not affect the network timing row.
    const refreshPing = () => {
      const latestSettings = settings?.getSettings?.() || {};
      if (latestSettings.showUsagePanelPing === false) {
        latestPingSnapshot = null;
        renderRowsFromSnapshot();
        return;
      }
      // 这一段避免极慢网络或手动保存设置时叠加同一个状态端点请求。
      // Avoid stacking requests to the same endpoint on very slow networks or manual settings saves.
      if (pingRequestInFlight) return;
      const requestedEndpoint = latestSettings.usagePanelPingEndpoint || "";
      pingRequestInFlight = true;
      api
        .fetchStatusPing(requestedEndpoint, controller.signal)
        .then((ping) => {
          const currentSettings = settings?.getSettings?.() || {};
          if (currentSettings.showUsagePanelPing === false || (currentSettings.usagePanelPingEndpoint || "") !== requestedEndpoint) return;
          latestPingSnapshot = ping;
          renderRowsFromSnapshot();
        })
        .catch((error) => {
          if (error?.name === "AbortError") return;
          latestPingSnapshot = null;
          renderRowsFromSnapshot();
        })
        .finally(() => {
          pingRequestInFlight = false;
        });
    };
    const refreshTodayTokenUsage = () => {
      const latestSettings = settings?.getSettings?.() || {};
      const requestedSource = latestSettings.usagePanelTodayTokenSource || hiddenTodayTokenSource;
      if (requestedSource === hiddenTodayTokenSource) {
        latestTodayTokenSnapshot = null;
        renderRowsFromSnapshot();
        return;
      }
      if (todayTokenRequestInFlight && todayTokenRequestInFlightSource === requestedSource) return;
      todayTokenRequestInFlight = true;
      todayTokenRequestInFlightSource = requestedSource;
      api
        .fetchTodayTokenUsage(requestedSource, controller.signal)
        .then((todayUsage) => {
          if ((settings?.getSettings?.()?.usagePanelTodayTokenSource || hiddenTodayTokenSource) !== requestedSource) return;
          latestTodayTokenSnapshot = todayUsage;
          renderRowsFromSnapshot();
        })
        .catch((error) => {
          if (error?.name === "AbortError") return;
          latestTodayTokenSnapshot = null;
          renderRowsFromSnapshot();
        })
        .finally(() => {
          if (todayTokenRequestInFlightSource === requestedSource) {
            todayTokenRequestInFlight = false;
            todayTokenRequestInFlightSource = "";
          }
        });
    };
    let intervalId = 0;
    let pingIntervalId = 0;
    let todayTokenIntervalId = 0;
    const unsubscribeTokenUsage = api.bindConversationTokenUsageUpdates?.(() => renderRowsFromSnapshot(), controller.signal);
    const unsubscribeCurrentThread = api.bindCurrentThreadChange?.(() => renderRowsFromSnapshot(), controller.signal);

    // 这一段按设置中的刷新间隔重建定时器，保存设置后可立即切换周期。
    // Rebuild the timer from the configured interval so saved settings take effect immediately.
    const restartRefreshTimer = (shouldRefreshNow = false) => {
      window.clearInterval(intervalId);
      const refreshSeconds = settings?.getSettings?.()?.usageRefreshSeconds || 60;
      const refreshMs = refreshSeconds * 1000;
      intervalId = window.setInterval(refresh, refreshMs);
      if (shouldRefreshNow) refresh();
    };

    // 这一段按设置重建 Ping 定时器；关闭该行或切换地址时立即清掉快照并重渲染。
    // Rebuild the Ping timer from settings; clear the snapshot immediately when disabled or when the endpoint changes.
    const restartPingTimer = (shouldRefreshNow = false) => {
      window.clearInterval(pingIntervalId);
      const latestSettings = settings?.getSettings?.() || {};
      const nextPingEndpoint = latestSettings.usagePanelPingEndpoint || "";
      if (nextPingEndpoint !== activePingEndpoint) {
        activePingEndpoint = nextPingEndpoint;
        latestPingSnapshot = null;
        renderRowsFromSnapshot();
      }
      if (latestSettings.showUsagePanelPing === false) {
        latestPingSnapshot = null;
        renderRowsFromSnapshot();
        return;
      }
      const refreshSeconds = latestSettings.usagePanelPingRefreshSeconds || 10;
      const pingRefreshMs = refreshSeconds * 1000;
      pingIntervalId = window.setInterval(refreshPing, pingRefreshMs);
      if (shouldRefreshNow) refreshPing();
    };
    const restartTodayTokenTimer = (shouldRefreshNow = false) => {
      // 这一段固定以 60 秒刷新 Today token，不复用剩余用量的可配置刷新间隔。
      // Refresh Today tokens on a fixed 60-second cadence instead of reusing the configurable quota interval.
      window.clearInterval(todayTokenIntervalId);
      const nextTodayTokenSource = settings?.getSettings?.()?.usagePanelTodayTokenSource || hiddenTodayTokenSource;
      if (nextTodayTokenSource !== activeTodayTokenSource) {
        activeTodayTokenSource = nextTodayTokenSource;
        latestTodayTokenSnapshot = null;
        renderRowsFromSnapshot();
      }
      if (nextTodayTokenSource === hiddenTodayTokenSource) {
        latestTodayTokenSnapshot = null;
        return;
      }
      todayTokenIntervalId = window.setInterval(refreshTodayTokenUsage, todayTokenRefreshMs);
      if (shouldRefreshNow) refreshTodayTokenUsage();
    };
    const unsubscribeSettings = settings?.subscribe?.(() => {
      restartRefreshTimer(true);
      restartPingTimer(true);
      restartTodayTokenTimer(true);
    }, controller.signal);

    // 这一段在系统结束时清除刷新定时器，避免后台继续请求。
    // Clear the refresh timer when the system ends so background requests stop.
    controller.signal.addEventListener(
      "abort",
      () => {
        window.clearInterval(intervalId);
        window.clearInterval(pingIntervalId);
        window.clearInterval(todayTokenIntervalId);
        unsubscribeCurrentThread?.();
        unsubscribeTokenUsage?.();
        unsubscribeSettings?.();
        view.uninstall?.();
      },
      { once: true },
    );

    restartRefreshTimer(true);
    restartPingTimer(true);
    restartTodayTokenTimer(true);
  }, { enableSetting: "enableUsagePanel" });
})();
