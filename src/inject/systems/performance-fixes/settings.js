(() => {
  const runtime = window.__codexProRuntime;
  if (!runtime) return;
  const settingsMenu = runtime.systemModules.settingsMenu ??= {};
  const controls = settingsMenu.sectionControls;
  if (!settingsMenu.registerSection || !controls) return;

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
    modifiedSettingKeys: ["enableSplitItemsHotpathPatch"],
    noteKey: "settings.performanceFixes.note",
    order: 880,
    settingKeys: ["enableSplitItemsHotpathPatch"],
    sourcePath: "src/inject/systems/performance-fixes/settings.js",
    sourceSystem: "split-items-hotpath-patch",
    titleKey: "settings.performanceFixes.title",
    render() {
      // 这一段只声明补丁开关；实际 chunk 匹配和注入由 Rust 侧热补丁系统执行。
      // Declare only the patch switch; Rust owns chunk matching and injection.
      return controls.renderSwitchField({
        helpKey: "settings.performanceFixes.splitItemsHotpath.help",
        key: "enableSplitItemsHotpathPatch",
        labelKey: "settings.performanceFixes.splitItemsHotpath.label",
      });
    },
  });
})();
