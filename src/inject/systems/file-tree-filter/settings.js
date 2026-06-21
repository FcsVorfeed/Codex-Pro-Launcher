(() => {
  const runtime = window.__codexProRuntime;
  if (!runtime) return;
  const settingsMenu = runtime.systemModules.settingsMenu ??= {};
  const controls = settingsMenu.sectionControls;
  if (!settingsMenu.registerSection || !controls) return;

  const icon = `
    <svg class="codex-pro-settings-section-icon" viewBox="0 0 24 24" aria-hidden="true" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round">
      <path d="M3 6h5l2 2h11v10a2 2 0 0 1-2 2H5a2 2 0 0 1-2-2Z"></path>
      <path d="M8 13h8"></path>
      <path d="M8 16h5"></path>
    </svg>
  `;

  settingsMenu.registerSection({
    icon,
    id: "file-tree",
    labelKey: "settings.fileTree.label",
    noteKey: "settings.fileTree.note",
    order: 120,
    settingKeys: ["enableFileTreeFilter", "hiddenFileTreePatterns"],
    fieldDependencies: {
      hiddenFileTreePatterns: "enableFileTreeFilter",
    },
    sourcePath: "src/inject/systems/file-tree-filter/settings.js",
    sourceSystem: "file-tree-filter",
    titleKey: "settings.fileTree.title",
    render(settings) {
      // 这一段声明文件列表过滤设置，实际过滤逻辑仍在两个 file-tree 系统内。
      // Declare file-tree filter settings while actual filtering stays in the two file-tree systems.
      return `
        ${controls.renderSwitchField({
          helpKey: "settings.fileTree.enable.help",
          key: "enableFileTreeFilter",
          labelKey: "settings.fileTree.enable.label",
        })}
        ${controls.renderTextareaField({
          helpKey: "settings.fileTree.patterns.help",
          key: "hiddenFileTreePatterns",
          labelKey: "settings.fileTree.patterns.label",
          maxlength: settings.maxHiddenFileTreePatternsLength,
        })}
      `;
    },
  });
})();
