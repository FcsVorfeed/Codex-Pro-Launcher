(() => {
  const runtime = window.__codexProRuntime;
  if (!runtime) return;
  const settingsMenu = runtime.systemModules.settingsMenu ??= {};
  const controls = settingsMenu.sectionControls;
  if (!settingsMenu.registerSection || !controls) return;

  const icon = `
    <svg class="codex-pro-settings-section-icon" viewBox="0 0 24 24" aria-hidden="true" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round">
      <path d="M4 7h16"></path>
      <path d="M7 12h10"></path>
      <path d="M4 17h16"></path>
      <path d="M8 20h8"></path>
    </svg>
  `;

  settingsMenu.registerSection({
    icon,
    id: "chat-line-hover",
    labelKey: "settings.chatLineHover.label",
    noteKey: "settings.chatLineHover.note",
    order: 36,
    settingKeys: ["enableChatLineHover"],
    sourcePath: "src/inject/systems/chat-line-hover/settings.js",
    sourceSystem: "chat-line-hover",
    titleKey: "settings.chatLineHover.title",
    render() {
      // 这一段只声明聊天行悬浮线开关，鼠标命中和绘制逻辑留在 chat-line-hover 系统内。
      // Declare only the chat-line hover switch; pointer hit-testing and rendering stay in the chat-line-hover system.
      return `
        ${controls.renderSwitchField({
          helpKey: "settings.chatLineHover.enable.help",
          key: "enableChatLineHover",
          labelKey: "settings.chatLineHover.enable.label",
        })}
      `;
    },
  });
})();
