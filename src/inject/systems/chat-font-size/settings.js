(() => {
  // 这一段注册独立聊天字号设置分区，普通字段由共享表单处理。
  // Register a separate chat-font section; the shared form handles ordinary fields.
  const runtime = window.__codexProRuntime;
  const menu = runtime?.systemModules.settingsMenu;
  if (!menu?.registerSection || !menu.sectionControls) return;
  const i18n = runtime.i18n;
  const icon = '<svg class="codex-pro-settings-section-icon" viewBox="0 0 24 24" aria-hidden="true" fill="none" stroke="currentColor" stroke-width="2"><path d="M4 5h16M12 5v14M8 19h8"/></svg>';

  menu.registerSection({
    icon,
    id: "chat-font-size",
    labelKey: "settings.chatFont.label",
    titleKey: "settings.chatFont.label",
    noteKey: "settings.chatFont.note",
    order: 34,
    settingKeys: ["enableChatFontSize", "chatFontSizeOffset"],
    fieldDependencies: { chatFontSizeOffset: "enableChatFontSize" },
    sourceSystem: "chat-font-size",
    sourcePath: "src/inject/systems/chat-font-size/settings.js",
    // 这一段只声明开关和三个已约定的增量选项，不提供全局窗口缩放。
    // Declare the switch and three agreed offsets without adding global window zoom.
    render() {
      return `
        ${menu.sectionControls.renderSwitchField({
          key: "enableChatFontSize",
          labelKey: "settings.chatFont.enable.label",
          helpKey: "settings.chatFont.enable.help",
        })}
        <label class="codex-pro-settings-field" data-codex-pro-setting-key="chatFontSizeOffset">
          <span class="codex-pro-settings-copy">
            <span class="codex-pro-settings-label">${i18n.html("settings.chatFont.offset.label")}</span>
            <span class="codex-pro-settings-help">${i18n.html("settings.chatFont.offset.help")}</span>
          </span>
          <select class="codex-pro-settings-select" name="chatFontSizeOffset">
            <option value="0">${i18n.html("settings.chatFont.follow")}</option>
            <option value="1">+1px</option>
            <option value="2">+2px</option>
          </select>
        </label>
      `;
    },
  });
})();
