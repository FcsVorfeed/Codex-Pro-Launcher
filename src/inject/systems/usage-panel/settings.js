(() => {
  const runtime = window.__codexProRuntime;
  if (!runtime) return;
  const settingsMenu = runtime.systemModules.settingsMenu ??= {};
  const controls = settingsMenu.sectionControls;
  if (!settingsMenu.registerSection || !controls) return;

  const icon = `
    <svg class="codex-pro-settings-section-icon" viewBox="0 0 24 24" aria-hidden="true" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round">
      <path d="M4 19V5"></path>
      <path d="M8 19v-8"></path>
      <path d="M12 19V8"></path>
      <path d="M16 19v-5"></path>
      <path d="M20 19V9"></path>
    </svg>
  `;

  settingsMenu.registerSection({
    icon,
    id: "usage-panel",
    labelKey: "settings.usagePanel.label",
    noteKey: "settings.usagePanel.note",
    order: 20,
    settingKeys: [
      "enableUsagePanel",
      "showUsageInLowerLeftPanel",
      "showUsageInEnvironmentPanel",
      "showUsagePanelTokenDetails",
      "showUsagePanelTotalInputTokens",
      "showUsagePanelPing",
      "usagePanelPingEndpoint",
      "usagePanelPingRefreshSeconds",
      "usagePanelTodayTokenSource",
      "usagePanelAdaptiveWidth",
      "usageRefreshSeconds",
    ],
    fieldDependencies: {
      showUsageInLowerLeftPanel: "enableUsagePanel",
      showUsageInEnvironmentPanel: "enableUsagePanel",
      showUsagePanelTokenDetails: "enableUsagePanel",
      showUsagePanelTotalInputTokens: ["enableUsagePanel", "showUsagePanelTokenDetails"],
      showUsagePanelPing: "enableUsagePanel",
      usagePanelPingEndpoint: ["enableUsagePanel", "showUsagePanelPing"],
      usagePanelPingRefreshSeconds: ["enableUsagePanel", "showUsagePanelPing"],
      usagePanelTodayTokenSource: "enableUsagePanel",
      usagePanelAdaptiveWidth: ["enableUsagePanel", "showUsageInLowerLeftPanel"],
      usageRefreshSeconds: "enableUsagePanel",
    },
    sourcePath: "src/inject/systems/usage-panel/settings.js",
    sourceSystem: "usage-panel",
    titleKey: "settings.usagePanel.title",
    render(settings) {
      // 这一段声明用量面板的纯表单设置，刷新和渲染逻辑仍由 usage-panel 系统负责。
      // Declare usage-panel form settings while refresh and rendering logic remain in the usage-panel system.
      return `
        ${controls.renderSwitchField({
          helpKey: "settings.usagePanel.enable.help",
          key: "enableUsagePanel",
          labelKey: "settings.usagePanel.enable.label",
        })}
        ${controls.renderSwitchField({
          helpKey: "settings.usagePanel.lowerLeft.help",
          key: "showUsageInLowerLeftPanel",
          labelKey: "settings.usagePanel.lowerLeft.label",
        })}
        ${controls.renderSwitchField({
          helpKey: "settings.usagePanel.environment.help",
          key: "showUsageInEnvironmentPanel",
          labelKey: "settings.usagePanel.environment.label",
        })}
        ${controls.renderSwitchField({
          helpKey: "settings.usagePanel.tokenDetails.help",
          key: "showUsagePanelTokenDetails",
          labelKey: "settings.usagePanel.tokenDetails.label",
        })}
        ${controls.renderSwitchField({
          helpKey: "settings.usagePanel.totalInput.help",
          key: "showUsagePanelTotalInputTokens",
          labelKey: "settings.usagePanel.totalInput.label",
        })}
        ${controls.renderSwitchField({
          helpKey: "settings.usagePanel.ping.help",
          key: "showUsagePanelPing",
          labelKey: "settings.usagePanel.ping.label",
        })}
        <label class="codex-pro-settings-field codex-pro-settings-field-stack" data-codex-pro-setting-key="usagePanelPingEndpoint">
          <span class="codex-pro-settings-copy">
            <span class="codex-pro-settings-label">${runtime.i18n.html("settings.usagePanel.pingEndpoint.label")}</span>
            <span class="codex-pro-settings-help">${runtime.i18n.html("settings.usagePanel.pingEndpoint.help")}</span>
          </span>
          <input class="codex-pro-settings-input codex-pro-settings-path-input" name="usagePanelPingEndpoint" type="url" maxlength="${settings.maxUsagePanelPingEndpointLength}" autocomplete="off" spellcheck="false" placeholder="${runtime.i18n.attr("settings.usagePanel.pingEndpoint.placeholder")}">
        </label>
        ${controls.renderNumberField({
          copyParams: { min: settings.minUsagePanelPingRefreshSeconds },
          helpKey: "settings.usagePanel.pingRefreshSeconds.help",
          key: "usagePanelPingRefreshSeconds",
          labelKey: "settings.usagePanel.pingRefreshSeconds.label",
          min: settings.minUsagePanelPingRefreshSeconds,
          step: "1",
          unitKey: "common.secondsUnit",
        })}
        <label class="codex-pro-settings-field" data-codex-pro-setting-key="usagePanelTodayTokenSource">
          <span class="codex-pro-settings-copy">
            <span class="codex-pro-settings-label">${runtime.i18n.html("settings.usagePanel.todayTokenSource.label")}</span>
            <span class="codex-pro-settings-help">${runtime.i18n.html("settings.usagePanel.todayTokenSource.help")}</span>
          </span>
          <select class="codex-pro-settings-select" name="usagePanelTodayTokenSource">
            <option value="hidden">${runtime.i18n.html("settings.usagePanel.todayTokenSource.hidden")}</option>
            <option value="observer">${runtime.i18n.html("settings.usagePanel.todayTokenSource.observer")}</option>
            <option value="official">${runtime.i18n.html("settings.usagePanel.todayTokenSource.official")}</option>
          </select>
        </label>
        ${controls.renderSwitchField({
          helpKey: "settings.usagePanel.adaptiveWidth.help",
          key: "usagePanelAdaptiveWidth",
          labelKey: "settings.usagePanel.adaptiveWidth.label",
        })}
        ${controls.renderNumberField({
          copyParams: { min: settings.minUsageRefreshSeconds },
          helpKey: "settings.usagePanel.refreshSeconds.help",
          key: "usageRefreshSeconds",
          labelKey: "settings.usagePanel.refreshSeconds.label",
          min: settings.minUsageRefreshSeconds,
          step: "5",
          unitKey: "common.secondsUnit",
        })}
      `;
    },
  });
})();
