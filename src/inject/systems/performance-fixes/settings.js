(() => {
  const runtime = window.__codexProRuntime;
  if (!runtime) return;
  const settingsMenu = runtime.systemModules.settingsMenu ??= {};
  const controls = settingsMenu.sectionControls;
  if (!settingsMenu.registerSection || !controls) return;
  const sqliteLogBlockerStatusSelector = "[data-codex-pro-sqlite-log-blocker-status]";
  const sqliteLogBlockerStartupRetryLimit = 6;

  const icon = `
    <svg class="codex-pro-settings-section-icon" viewBox="0 0 24 24" aria-hidden="true" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round">
      <path d="M21 12a9 9 0 1 1-18 0"></path>
      <path d="M12 3v4"></path>
      <path d="m19 5-3 3"></path>
      <path d="M5 5l3 3"></path>
      <path d="m13 13 4-4"></path>
      <path d="M12 13h.01"></path>
    </svg>
  `;

  settingsMenu.registerSection({
    icon,
    id: "performance-fixes",
    labelKey: "settings.performanceFixes.label",
    modifiedSettingKeys: ["enableSplitItemsHotpathPatch", "enableCodexSqliteLogInsertBlocker"],
    noteKey: "settings.performanceFixes.note",
    order: 880,
    settingKeys: ["enableSplitItemsHotpathPatch", "enableCodexSqliteLogInsertBlocker"],
    sourcePath: "src/inject/systems/performance-fixes/settings.js",
    sourceSystem: "split-items-hotpath-patch",
    titleKey: "settings.performanceFixes.title",
    render() {
      // 这一段声明性能修复开关；具体资源补丁和 SQLite schema 操作由原生侧执行。
      // Declare performance-fix switches; native code owns resource patching and SQLite schema work.
      return `
        ${controls.renderSwitchField({
        helpKey: "settings.performanceFixes.splitItemsHotpath.help",
        key: "enableSplitItemsHotpathPatch",
        labelKey: "settings.performanceFixes.splitItemsHotpath.label",
        })}
        ${controls.renderSwitchField({
          helpKey: "settings.performanceFixes.sqliteLogBlocker.help",
          key: "enableCodexSqliteLogInsertBlocker",
          labelKey: "settings.performanceFixes.sqliteLogBlocker.label",
        })}
        <div class="codex-pro-settings-field codex-pro-settings-field-stack">
          <span class="codex-pro-settings-copy">
            <span class="codex-pro-settings-label">${controls.resolveCopy({ key: "settings.performanceFixes.sqliteLogBlocker.statusLabel" })}</span>
            <span class="codex-pro-settings-help">${controls.resolveCopy({ key: "settings.performanceFixes.sqliteLogBlocker.statusHelp" })}</span>
          </span>
          <span class="codex-pro-settings-status" data-codex-pro-sqlite-log-blocker-status>${controls.resolveCopy({ key: "settings.performanceFixes.sqliteLogBlocker.status.unknown" })}</span>
        </div>
      `;
    },
    bind(context) {
      // 这一段把本机 SQLite trigger 状态接入设置页生命周期，保存后立即尝试应用。
      // Attach the local SQLite trigger state to the settings page lifecycle and apply immediately after save.
      const statusElement = context.root.querySelector(sqliteLogBlockerStatusSelector);
      const renderStatus = (state, tone = "") => renderSqliteLogBlockerStatus(statusElement, state, tone);
      context.addDialogOpenHandler(() => refreshSqliteLogBlockerStatus(renderStatus));
      context.registerAfterSaveHandler((savedSettings) => {
        applySqliteLogBlockerDesiredState(savedSettings, renderStatus);
      });
    },
  });

  scheduleStartupSqliteLogBlockerReconcile();

  function supportsSqliteLogBlocker() {
    // 这一段要求新版原生桥可用，避免旧 worker 收到未知请求后无响应。
    // Require the newer native bridge so old workers do not receive unknown requests.
    return runtime.nativeBridge?.supportsCodexSqliteLogBlocker?.() === true;
  }

  function getDesiredSqliteLogBlockerEnabled(settings = null) {
    // 这一段读取规范化设置；缺失设置 API 时保守视为关闭。
    // Read normalized settings; treat missing settings API as disabled.
    const source = settings || settingsMenu.settings?.getSettings?.() || {};
    return source.enableCodexSqliteLogInsertBlocker === true;
  }

  function responseState(response) {
    // 这一段把原生响应收敛成短状态名，前端不依赖错误正文。
    // Collapse native responses into a short state so the frontend does not rely on error text.
    const state = String(response?.data?.state || "").trim();
    return state || "error";
  }

  function responseTone(response) {
    // 这一段把状态映射到现有设置页色调，错误和锁定用 error，已启用用 success。
    // Map states to existing settings-page tones: errors and locks use error, enabled uses success.
    const state = responseState(response);
    if (response?.ok !== true || ["locked", "triggerConflict", "missingLogsTable", "error"].includes(state)) return "error";
    return response?.data?.enabled === true ? "success" : "";
  }

  function renderSqliteLogBlockerStatus(statusElement, state, tone = "") {
    // 这一段只更新状态文本，不把本机路径或 SQL 细节展示给页面。
    // Update only status copy and never expose local paths or SQL details to the page.
    if (!statusElement) return;
    statusElement.textContent = runtime.i18n?.t?.(`settings.performanceFixes.sqliteLogBlocker.status.${state}`)
      || runtime.i18n?.t?.("settings.performanceFixes.sqliteLogBlocker.status.unknown")
      || state;
    if (tone) {
      statusElement.dataset.codexProCloudSyncTone = tone;
    } else {
      delete statusElement.dataset.codexProCloudSyncTone;
    }
  }

  async function refreshSqliteLogBlockerStatus(renderStatus) {
    // 这一段打开弹窗时查询真实 trigger 状态，让显示和实际数据库保持一致。
    // Query the real trigger state when the dialog opens so the display matches the database.
    if (!supportsSqliteLogBlocker()) {
      renderStatus("launcherUnsupported", "error");
      return null;
    }
    renderStatus("checking");
    const response = await runtime.nativeBridge.requestCodexSqliteLogBlocker({ action: "status" });
    if (!response) {
      renderStatus("launcherUnsupported", "error");
      return null;
    }
    renderStatus(responseState(response), responseTone(response));
    return response;
  }

  async function applySqliteLogBlockerDesiredState(settings, renderStatus = () => {}) {
    // 这一段保存后立即尝试应用用户期望状态；锁定时保留设置并让用户稍后重试。
    // Try to apply the user's desired state immediately after save; locks keep the setting for a later retry.
    if (!supportsSqliteLogBlocker()) {
      renderStatus("launcherUnsupported", "error");
      return null;
    }
    const enabled = getDesiredSqliteLogBlockerEnabled(settings);
    renderStatus("applying");
    const response = await runtime.nativeBridge.requestCodexSqliteLogBlocker({ action: "apply", enabled });
    if (!response) {
      renderStatus("launcherUnsupported", "error");
      return null;
    }
    renderStatus(responseState(response), responseTone(response));
    return response;
  }

  function scheduleStartupSqliteLogBlockerReconcile(attempt = 0) {
    // 这一段只在用户明确开启时自动补装 trigger；默认关闭不会删除用户手动创建的 workaround。
    // Auto-install only when the user explicitly enabled it; default-off never removes a manually created workaround.
    const scheduleTimeout = typeof window.setTimeout === "function" ? window.setTimeout.bind(window) : null;
    if (!scheduleTimeout) return;
    scheduleTimeout(async () => {
      if (!getDesiredSqliteLogBlockerEnabled()) return;
      if (!supportsSqliteLogBlocker()) {
        if (attempt + 1 < sqliteLogBlockerStartupRetryLimit) {
          scheduleStartupSqliteLogBlockerReconcile(attempt + 1);
        }
        return;
      }
      await runtime.nativeBridge.requestCodexSqliteLogBlocker({ action: "apply", enabled: true });
    }, 1000 + (attempt * 1500));
  }
})();
