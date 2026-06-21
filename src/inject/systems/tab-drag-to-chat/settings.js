(() => {
  const runtime = window.__codexProRuntime;
  if (!runtime) return;
  const settingsMenu = runtime.systemModules.settingsMenu ??= {};
  const controls = settingsMenu.sectionControls;
  if (!settingsMenu.registerSection || !controls) return;

  const icon = `
    <svg class="codex-pro-settings-section-icon" viewBox="0 0 24 24" aria-hidden="true" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round">
      <path d="M6 3h9l4 4v14H6Z"></path>
      <path d="M14 3v5h5"></path>
      <path d="M9 14h6"></path>
      <path d="m13 11 3 3-3 3"></path>
    </svg>
  `;

  settingsMenu.registerSection({
    icon,
    id: "tab-drag-to-chat",
    labelKey: "settings.tabDragToChat.label",
    noteKey: "settings.tabDragToChat.note",
    order: 140,
    settingKeys: ["enableTabDragToChat"],
    sourcePath: "src/inject/systems/tab-drag-to-chat/settings.js",
    sourceSystem: "tab-drag-to-chat",
    titleKey: "settings.tabDragToChat.title",
    render() {
      // 这一段声明文件标签拖入聊天开关，减少 view.js 对单功能文案的承载。
      // Declare the tab-drag switch so view.js carries less single-feature copy.
      return controls.renderSwitchField({
        helpKey: "settings.tabDragToChat.enable.help",
        key: "enableTabDragToChat",
        labelKey: "settings.tabDragToChat.enable.label",
      });
    },
  });
})();
