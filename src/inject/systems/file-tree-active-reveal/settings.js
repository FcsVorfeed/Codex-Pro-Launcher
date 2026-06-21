(() => {
  const runtime = window.__codexProRuntime;
  if (!runtime) return;
  const settingsMenu = runtime.systemModules.settingsMenu ??= {};
  const controls = settingsMenu.sectionControls;
  if (!settingsMenu.registerSection || !controls) return;

  const icon = `
    <svg class="codex-pro-settings-section-icon" viewBox="0 0 24 24" aria-hidden="true" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round">
      <path d="M3 6h5l2 2h11v10a2 2 0 0 1-2 2H5a2 2 0 0 1-2-2Z"></path>
      <path d="M12 12v5"></path>
      <path d="m9 15 3 3 3-3"></path>
    </svg>
  `;

  settingsMenu.registerSection({
    icon,
    id: "file-tree-active-reveal",
    labelKey: "settings.fileTreeActiveReveal.label",
    noteKey: "settings.fileTreeActiveReveal.note",
    order: 130,
    settingKeys: ["enableFileTreeActiveReveal"],
    sourcePath: "src/inject/systems/file-tree-active-reveal/settings.js",
    sourceSystem: "file-tree-active-reveal",
    titleKey: "settings.fileTreeActiveReveal.title",
    render() {
      // 这一段声明文件树定位开关，保持分区 UI 与执行逻辑分离。
      // Declare the active-file reveal switch while keeping UI config separate from execution logic.
      return controls.renderSwitchField({
        helpKey: "settings.fileTreeActiveReveal.enable.help",
        key: "enableFileTreeActiveReveal",
        labelKey: "settings.fileTreeActiveReveal.enable.label",
      });
    },
  });
})();
