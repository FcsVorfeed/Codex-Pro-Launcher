(() => {
  const runtime = window.__codexProRuntime;
  if (!runtime) return;
  const settingsMenu = runtime.systemModules.settingsMenu ??= {};
  const i18n = runtime.i18n;
  if (!settingsMenu.registerSection) return;

  function statusMessageKey(state) {
    // 这一段把内部状态映射为三语言文案 key，避免设置页直接拼接状态文案。
    // Map internal state to i18n keys so the settings page does not concatenate display copy.
    if (state?.checking) return "settings.updateCheck.status.checking";
    if (state?.error === "launcherUnsupported") return "settings.updateCheck.status.unsupported";
    if (state?.error) return "settings.updateCheck.status.failed";
    if (state?.updateAvailable) return "settings.updateCheck.status.available";
    if (state?.checkedAt) return "settings.updateCheck.status.latest";
    return "settings.updateCheck.status.notChecked";
  }

  function statusKind(state) {
    // 这一段把内部状态映射为样式状态，避免用文案内容判断颜色。
    // Map internal state to style states without relying on localized status copy.
    if (state?.checking) return "checking";
    if (state?.error === "launcherUnsupported") return "unsupported";
    if (state?.error) return "failed";
    if (state?.updateAvailable) return "available";
    if (state?.checkedAt) return "latest";
    return "notChecked";
  }

  function versionLabel(value) {
    // 这一段把空版本号转成统一占位，避免 DOM 中出现空白状态。
    // Turn an empty version into a consistent placeholder so the DOM does not show a blank state.
    return value || i18n.t("settings.updateCheck.versionUnknown");
  }

  function renderCheckedAt(state) {
    // 这一段格式化检查时间；没有检查记录时保持为空。
    // Format the check timestamp and leave it blank when there is no check record.
    const checkedAt = state?.checkedAt ? i18n.formatDateTime(state.checkedAt) : "";
    return checkedAt
      ? i18n.t("settings.updateCheck.checkedAt", { time: checkedAt })
      : "";
  }

  settingsMenu.registerSection({
    fieldDependencies: {},
    icon: `
      <svg class="codex-pro-settings-section-icon" viewBox="0 0 24 24" aria-hidden="true" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round">
        <path d="M21 12a9 9 0 0 1-15.3 6.4"></path>
        <path d="M3 12A9 9 0 0 1 18.3 5.6"></path>
        <path d="M18 2v4h-4"></path>
        <path d="M6 22v-4h4"></path>
      </svg>
    `,
    id: "update-check",
    labelKey: "settings.updateCheck.label",
    noteKey: "settings.updateCheck.note",
    order: 900,
    settingKeys: [],
    sourcePath: "src/inject/systems/update-check/settings.js",
    sourceSystem: "update-check",
    titleKey: "settings.updateCheck.title",
    render() {
      // 这一段只渲染只读状态和命令按钮，不引入新的持久设置项。
      // Render only read-only status and command buttons without introducing persistent settings.
      return `
        <div class="codex-pro-settings-field codex-pro-settings-field-stack">
          <span class="codex-pro-settings-copy">
            <span class="codex-pro-settings-label">${i18n.html("settings.updateCheck.currentVersion.label")}</span>
            <span class="codex-pro-settings-help" data-codex-pro-update-current-version>${i18n.html("settings.updateCheck.versionUnknown")}</span>
          </span>
        </div>
        <div class="codex-pro-settings-field codex-pro-settings-field-stack">
          <span class="codex-pro-settings-copy">
            <span class="codex-pro-settings-label">${i18n.html("settings.updateCheck.latestVersion.label")}</span>
            <span class="codex-pro-settings-help" data-codex-pro-update-latest-version>${i18n.html("settings.updateCheck.versionUnknown")}</span>
          </span>
        </div>
        <div class="codex-pro-settings-field codex-pro-settings-field-stack">
          <span class="codex-pro-settings-copy">
            <span class="codex-pro-settings-label">${i18n.html("settings.updateCheck.status.label")}</span>
            <span class="codex-pro-settings-help" data-codex-pro-update-status>${i18n.html("settings.updateCheck.status.notChecked")}</span>
            <span class="codex-pro-settings-help" data-codex-pro-update-checked-at></span>
          </span>
          <span class="codex-pro-settings-command-row">
            <button class="codex-pro-settings-action" type="button" data-codex-pro-update-check>${i18n.html("settings.updateCheck.checkNow")}</button>
            <button class="codex-pro-settings-action codex-pro-settings-action-primary" type="button" data-codex-pro-update-open disabled>${i18n.html("settings.updateCheck.openRelease")}</button>
          </span>
        </div>
      `;
    },
    bind(context) {
      const updateCheck = runtime.systemModules.updateCheck;
      if (!updateCheck) return;
      const currentVersion = context.root.querySelector("[data-codex-pro-update-current-version]");
      const latestVersion = context.root.querySelector("[data-codex-pro-update-latest-version]");
      const status = context.root.querySelector("[data-codex-pro-update-status]");
      const checkedAt = context.root.querySelector("[data-codex-pro-update-checked-at]");
      const checkButton = context.root.querySelector("[data-codex-pro-update-check]");
      const openButton = context.root.querySelector("[data-codex-pro-update-open]");
      if (!currentVersion || !latestVersion || !status || !checkedAt || !checkButton || !openButton) return;

      function renderState(state = {}) {
        // 这一段同步只读状态和按钮可用性；打开 Release 只在有安全 URL 时可点。
        // Sync read-only state and button availability; opening the release is enabled only with a safe URL.
        currentVersion.textContent = versionLabel(state.currentVersion || runtime.version);
        latestVersion.textContent = versionLabel(state.latestVersion);
        status.textContent = i18n.t(statusMessageKey(state));
        status.dataset.codexProUpdateStatusKind = statusKind(state);
        checkedAt.textContent = renderCheckedAt(state);
        checkButton.disabled = state.checking === true;
        openButton.disabled = !(state.releaseUrl || state.assetUrl);
      }

      context.addDialogOpenHandler(() => renderState(updateCheck.getState?.()));
      updateCheck.subscribe?.(renderState, context.signal);
      renderState(updateCheck.getState?.());

      checkButton.addEventListener("click", () => {
        // 这一段手动触发强制检查，供用户打开设置页后立即刷新状态。
        // Trigger a forced manual check so users can refresh status immediately from settings.
        void updateCheck.checkNow?.();
      }, { signal: context.signal });
      openButton.addEventListener("click", () => {
        // 这一段只打开 Release 页面，不下载、不执行、不替换本地程序。
        // Open only the release page, without downloading, executing, or replacing the local app.
        updateCheck.openRelease?.();
      }, { signal: context.signal });
    },
  });
})();
