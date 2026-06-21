(() => {
  const runtime = window.__codexProRuntime;
  if (!runtime) return;
  const settingsMenu = runtime.systemModules.settingsMenu ??= {};
  const controls = settingsMenu.sectionControls;
  if (!settingsMenu.registerSection || !controls) return;

  const icon = `
    <svg class="codex-pro-settings-section-icon" viewBox="0 0 24 24" aria-hidden="true" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round">
      <rect x="3" y="4" width="18" height="16" rx="2"></rect>
      <path d="M7 8h10M7 12h6"></path>
    </svg>
  `;

  settingsMenu.registerSection({
    icon,
    id: "startup-sidebar",
    labelKey: "settings.startupSidebar.label",
    noteKey: "settings.startupSidebar.note",
    order: 10,
    settingKeys: ["enableStartupSidebar", "collapseSidebarOnStartup"],
    fieldDependencies: {
      collapseSidebarOnStartup: "enableStartupSidebar",
    },
    sourcePath: "src/inject/systems/startup-sidebar/settings.js",
    sourceSystem: "startup-sidebar",
    titleKey: "settings.startupSidebar.title",
    render() {
      // 这一段声明启动侧边栏分区的两个开关，不包含任何运行时行为。
      // Declare the two startup-sidebar switches without embedding runtime behavior.
      return `
        ${controls.renderSwitchField({
          helpKey: "settings.startupSidebar.enable.help",
          key: "enableStartupSidebar",
          labelKey: "settings.startupSidebar.enable.label",
        })}
        ${controls.renderSwitchField({
          helpKey: "settings.startupSidebar.collapse.help",
          key: "collapseSidebarOnStartup",
          labelKey: "settings.startupSidebar.collapse.label",
        })}
      `;
    },
  });
})();
