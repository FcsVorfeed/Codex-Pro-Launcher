(() => {
  const runtime = window.__codexProRuntime;
  if (!runtime) return;
  const settingsMenu = runtime.systemModules.settingsMenu ??= {};
  if (!settingsMenu.registerSection) return;
  const i18n = runtime.i18n;

  const icon = `
    <svg class="codex-pro-settings-section-icon" viewBox="0 0 24 24" aria-hidden="true" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round">
      <path d="m5 8 6 6"></path>
      <path d="m4 14 6-6 2-3"></path>
      <path d="M2 5h12"></path>
      <path d="M7 2h1"></path>
      <path d="m22 22-5-10-5 10"></path>
      <path d="M14 18h6"></path>
    </svg>
  `;

  settingsMenu.registerSection({
    icon,
    id: "language",
    labelKey: "settings.language.label",
    noteKey: "settings.language.note",
    order: 5,
    settingKeys: ["uiLanguage"],
    titleKey: "settings.language.title",
    render() {
      // 这一段声明语言选择字段；保存后 settings-menu 会重建自身来刷新所有静态文案。
      // Declare the language selector; after saving, settings-menu rebuilds itself to refresh static copy.
      return `
        <label class="codex-pro-settings-field" data-codex-pro-setting-key="uiLanguage">
          <span class="codex-pro-settings-copy">
            <span class="codex-pro-settings-label">${i18n.html("settings.language.field.label")}</span>
            <span class="codex-pro-settings-help">${i18n.html("settings.language.field.help")}</span>
          </span>
          <select class="codex-pro-settings-select" name="uiLanguage">
            <option value="zh-CN">${i18n.html("settings.language.zhCN")}</option>
            <option value="en-US">${i18n.html("settings.language.enUS")}</option>
            <option value="ja-JP">${i18n.html("settings.language.jaJP")}</option>
          </select>
        </label>
      `;
    },
  });
})();
