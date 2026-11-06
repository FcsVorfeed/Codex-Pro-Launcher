(() => {
  // 注册独立设置入口，普通开关由共享表单和系统生命周期管理。
  // Register a separate settings section; the shared form and lifecycle manage its switch.
  const runtime = window.__codexProRuntime;
  const menu = runtime?.systemModules.settingsMenu;
  if (!menu?.registerSection || !menu.sectionControls) return;
  menu.registerSection({
    id: "sidebar-usage-label",
    icon: '<svg class="codex-pro-settings-section-icon" viewBox="0 0 24 24" aria-hidden="true" fill="none" stroke="currentColor" stroke-width="2"><circle cx="12" cy="12" r="9"/><path d="m8 16 8-8M8 8h.01M16 16h.01"/></svg>',
    labelKey: "settings.sidebarUsage.label",
    titleKey: "settings.sidebarUsage.label",
    noteKey: "settings.sidebarUsage.note",
    order: 35,
    settingKeys: ["enableSidebarUsageLabel"],
    sourceSystem: "sidebar-usage-label",
    sourcePath: "src/inject/systems/sidebar-usage-label/settings.js",
    // 声明开关即可由通用表单保存，避免增加独立事件绑定。
    // Declare the switch for shared form persistence without additional event bindings.
    render() {
      return menu.sectionControls.renderSwitchField({
        key: "enableSidebarUsageLabel",
        labelKey: "settings.sidebarUsage.enable.label",
        helpKey: "settings.sidebarUsage.enable.help",
      });
    },
  });
})();
