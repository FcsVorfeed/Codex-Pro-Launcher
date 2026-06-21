(() => {
  const runtime = window.__codexProRuntime;
  if (!runtime) return;
  const settingsMenu = runtime.systemModules.settingsMenu ??= {};
  const i18n = runtime.i18n;
  if (!settingsMenu.registerCloudSyncBlock) return;

  settingsMenu.registerCloudSyncBlock({
    id: "conversation-archive",
    noteKey: "settings.conversationArchive.note",
    order: 30,
    settingKeys: [
      "enableConversationArchiveSync",
      "conversationArchiveDeviceName",
      "conversationArchiveProfileName",
    ],
    titleKey: "settings.conversationArchive.title",
    render(settings) {
      // 这一段只暴露自动归档和显示名配置；同步地址、手动上传和远端预览由后台逻辑保留但不在设置页展示。
      // Expose only auto-archive and display-name settings; endpoints, manual upload, and remote previews stay available to background logic but hidden from settings.
      return `
        <label class="codex-pro-settings-field" data-codex-pro-setting-key="enableConversationArchiveSync">
          <span class="codex-pro-settings-copy">
            <span class="codex-pro-settings-label">${i18n.html("settings.conversationArchive.autoUpload.label")}</span>
            <span class="codex-pro-settings-help">${i18n.html("settings.conversationArchive.autoUpload.help")}</span>
          </span>
          <span class="codex-pro-settings-switch">
            <input name="enableConversationArchiveSync" type="checkbox">
            <span class="codex-pro-settings-switch-track" aria-hidden="true"></span>
          </span>
        </label>
        <label class="codex-pro-settings-field codex-pro-settings-field-stack" data-codex-pro-setting-key="conversationArchiveDeviceName">
          <span class="codex-pro-settings-copy">
            <span class="codex-pro-settings-label">${i18n.html("settings.conversationArchive.deviceName.label")}</span>
            <span class="codex-pro-settings-help">${i18n.html("settings.conversationArchive.deviceName.help")}</span>
          </span>
          <input class="codex-pro-settings-input" name="conversationArchiveDeviceName" type="text" maxlength="${settings.maxConversationArchiveDisplayNameLength}" spellcheck="false" placeholder="${i18n.attr("settings.conversationArchive.deviceName.placeholder")}">
        </label>
        <label class="codex-pro-settings-field codex-pro-settings-field-stack" data-codex-pro-setting-key="conversationArchiveProfileName">
          <span class="codex-pro-settings-copy">
            <span class="codex-pro-settings-label">${i18n.html("settings.conversationArchive.profileName.label")}</span>
            <span class="codex-pro-settings-help">${i18n.html("settings.conversationArchive.profileName.help")}</span>
          </span>
          <input class="codex-pro-settings-input" name="conversationArchiveProfileName" type="text" maxlength="${settings.maxConversationArchiveDisplayNameLength}" spellcheck="false" placeholder="${i18n.attr("settings.conversationArchive.profileName.placeholder")}">
        </label>
      `;
    },
  });
})();
