(() => {
  const runtime = window.__codexProRuntime;
  if (!runtime) return;
  const settingsMenu = runtime.systemModules.settingsMenu ??= {};
  const controls = settingsMenu.sectionControls;
  if (!settingsMenu.registerSection || !controls) return;

  const icon = `
    <svg class="codex-pro-settings-section-icon" viewBox="0 0 24 24" aria-hidden="true" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round">
      <path d="M4 6h16"></path>
      <path d="M4 18h16"></path>
      <path d="M8 9v6"></path>
      <path d="M16 9v6"></path>
      <path d="m11 12-3 3-3-3"></path>
      <path d="m13 12 3 3 3-3"></path>
    </svg>
  `;

  settingsMenu.registerSection({
    icon,
    id: "chat-width-resizer",
    labelKey: "settings.chatWidth.label",
    modifiedSettingKeys: ["enableChatWidthResizer"],
    noteKey: "settings.chatWidth.note",
    order: 35,
    settingKeys: ["enableChatWidthResizer", "chatWidthMode", "chatWidthPixels"],
    sourcePath: "src/inject/systems/chat-width-resizer/settings.js",
    sourceSystem: "chat-width-resizer",
    titleKey: "settings.chatWidth.title",
    render(settings) {
      // 这一段声明聊天宽度设置；实际 DOM 定位和拖拽行为留在 chat-width-resizer 系统中。
      // Declare chat-width settings while DOM targeting and drag behavior remain in the chat-width-resizer system.
      return `
        ${controls.renderSwitchField({
          helpKey: "settings.chatWidth.enable.help",
          key: "enableChatWidthResizer",
          labelKey: "settings.chatWidth.enable.label",
        })}
      `;
    },
  });
})();
