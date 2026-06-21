(() => {
  const runtime = window.__codexProRuntime;
  if (!runtime) return;
  const settingsMenu = runtime.systemModules.settingsMenu ??= {};
  const controls = settingsMenu.sectionControls;
  if (!settingsMenu.registerCloudSyncBlock || !controls) return;

  settingsMenu.registerCloudSyncBlock({
    id: "conversation-archive-sidebar",
    labelKey: "settings.syncSidebar.label",
    noteKey: "settings.syncSidebar.note",
    order: 40,
    fieldDependencies: {
      conversationArchiveSidebarDirectoryPanelMode: "enableConversationArchiveSidebar",
      conversationArchiveSidebarPanelMode: "enableConversationArchiveSidebar",
    },
    settingKeys: [
      "enableConversationArchiveSidebar",
      "conversationArchiveSidebarDirectoryPanelMode",
      "conversationArchiveSidebarPanelMode",
    ],
    sourcePath: "src/inject/systems/conversation-archive-sidebar/settings.js",
    sourceSystem: "conversation-archive-sidebar",
    titleKey: "settings.syncSidebar.title",
    render() {
      // 这一段声明主界面同步侧栏开关和右侧列表显示方式；同步地址和密钥继续由现有同步页管理。
      // Declare the main sidebar switch and thread-list display mode; endpoint and sync key remain managed by existing sync pages.
      return `
        ${controls.renderSwitchField({
          helpKey: "settings.syncSidebar.enable.help",
          key: "enableConversationArchiveSidebar",
          labelKey: "settings.syncSidebar.enable.label",
        })}
        <label class="codex-pro-settings-field" data-codex-pro-setting-key="conversationArchiveSidebarDirectoryPanelMode">
          <span class="codex-pro-settings-copy">
            <span class="codex-pro-settings-label">${runtime.i18n.html("settings.syncSidebar.directoryPanelMode.label")}</span>
            <span class="codex-pro-settings-help">${runtime.i18n.html("settings.syncSidebar.directoryPanelMode.help")}</span>
          </span>
          <select class="codex-pro-settings-select" name="conversationArchiveSidebarDirectoryPanelMode">
            <option value="hover">${runtime.i18n.html("settings.syncSidebar.panelMode.hover")}</option>
            <option value="click">${runtime.i18n.html("settings.syncSidebar.panelMode.click")}</option>
          </select>
        </label>
        <label class="codex-pro-settings-field" data-codex-pro-setting-key="conversationArchiveSidebarPanelMode">
          <span class="codex-pro-settings-copy">
            <span class="codex-pro-settings-label">${runtime.i18n.html("settings.syncSidebar.panelMode.label")}</span>
            <span class="codex-pro-settings-help">${runtime.i18n.html("settings.syncSidebar.panelMode.help")}</span>
          </span>
          <select class="codex-pro-settings-select" name="conversationArchiveSidebarPanelMode">
            <option value="hover">${runtime.i18n.html("settings.syncSidebar.panelMode.hover")}</option>
            <option value="click">${runtime.i18n.html("settings.syncSidebar.panelMode.click")}</option>
          </select>
        </label>
      `;
    },
  });
})();
