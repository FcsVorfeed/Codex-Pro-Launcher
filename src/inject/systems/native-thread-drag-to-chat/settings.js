(() => {
  const runtime = window.__codexProRuntime;
  if (!runtime) return;
  const settingsMenu = runtime.systemModules.settingsMenu ??= {};
  const controls = settingsMenu.sectionControls;
  if (!settingsMenu.registerSection || !controls) return;

  const icon = `
    <svg class="codex-pro-settings-section-icon" viewBox="0 0 24 24" aria-hidden="true" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round">
      <path d="M7 4h10"></path>
      <path d="M5 8h14"></path>
      <path d="M7 12h8"></path>
      <path d="M7 16h6"></path>
      <path d="m15 15 4 4"></path>
      <path d="m19 15-4 4"></path>
    </svg>
  `;

  settingsMenu.registerSection({
    fieldDependencies: {
      enableNativeThreadDragToChat: "enableTabDragToChat",
    },
    icon,
    id: "native-thread-drag-to-chat",
    labelKey: "settings.nativeThreadDragToChat.label",
    noteKey: "settings.nativeThreadDragToChat.note",
    order: 142,
    settingKeys: ["enableNativeThreadDragToChat"],
    sourcePath: "src/inject/systems/native-thread-drag-to-chat/settings.js",
    sourceSystem: "native-thread-drag-to-chat",
    titleKey: "settings.nativeThreadDragToChat.title",
    render() {
      // 这一段声明官方左侧历史对话拖入聊天开关，附件入口仍由文件拖入聊天模块提供。
      // Declare the native-sidebar thread drag switch while the file-drag module still owns attachments.
      return controls.renderSwitchField({
        helpKey: "settings.nativeThreadDragToChat.enable.help",
        key: "enableNativeThreadDragToChat",
        labelKey: "settings.nativeThreadDragToChat.enable.label",
      });
    },
  });
})();
