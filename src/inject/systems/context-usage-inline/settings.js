(() => {
  const runtime = window.__codexProRuntime;
  if (!runtime) return;
  const settingsMenu = runtime.systemModules.settingsMenu ??= {};
  const controls = settingsMenu.sectionControls;
  if (!settingsMenu.registerSection || !controls) return;

  const icon = `
    <svg class="codex-pro-settings-section-icon" viewBox="0 0 24 24" aria-hidden="true" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round">
      <circle cx="12" cy="12" r="9"></circle>
      <path d="M12 7v5l3 2"></path>
    </svg>
  `;

  settingsMenu.registerSection({
    icon,
    id: "context-usage",
    labelKey: "settings.contextUsage.label",
    noteKey: "settings.contextUsage.note",
    order: 30,
    settingKeys: [
      "enableContextUsageInline",
      "showContextUsageInline",
      "contextUsageDecimalPlaces",
      "enableContextUsageRingColors",
      "contextUsageRingWarningThreshold",
      "contextUsageRingWarningColor",
      "contextUsageRingCriticalThreshold",
      "contextUsageRingCriticalColor",
    ],
    fieldDependencies: {
      contextUsageDecimalPlaces: ["enableContextUsageInline", "showContextUsageInline"],
      contextUsageRingCriticalColor: ["enableContextUsageInline", "enableContextUsageRingColors"],
      contextUsageRingCriticalThreshold: ["enableContextUsageInline", "enableContextUsageRingColors"],
      contextUsageRingWarningColor: ["enableContextUsageInline", "enableContextUsageRingColors"],
      contextUsageRingWarningThreshold: ["enableContextUsageInline", "enableContextUsageRingColors"],
      enableContextUsageRingColors: "enableContextUsageInline",
      showContextUsageInline: "enableContextUsageInline",
    },
    sourcePath: "src/inject/systems/context-usage-inline/settings.js",
    sourceSystem: "context-usage-inline",
    titleKey: "settings.contextUsage.title",
    render(settings) {
      // 这一段声明上下文用量显示设置，DOM 观察与数据读取仍留在对应系统中。
      // Declare context usage display settings while DOM observation and data reading remain in its system.
      return `
        ${controls.renderSwitchField({
          helpKey: "settings.contextUsage.enable.help",
          key: "enableContextUsageInline",
          labelKey: "settings.contextUsage.enable.label",
        })}
        ${controls.renderSwitchField({
          helpKey: "settings.contextUsage.show.help",
          key: "showContextUsageInline",
          labelKey: "settings.contextUsage.show.label",
        })}
        ${controls.renderNumberField({
          helpKey: "settings.contextUsage.decimals.help",
          key: "contextUsageDecimalPlaces",
          labelKey: "settings.contextUsage.decimals.label",
          max: settings.maxContextUsageDecimalPlaces,
          min: settings.minContextUsageDecimalPlaces,
          unitKey: "common.digitsUnit",
        })}
        ${controls.renderSwitchField({
          helpKey: "settings.contextUsage.ringColors.help",
          key: "enableContextUsageRingColors",
          labelKey: "settings.contextUsage.ringColors.label",
        })}
        ${controls.renderNumberField({
          helpKey: "settings.contextUsage.warningThreshold.help",
          key: "contextUsageRingWarningThreshold",
          labelKey: "settings.contextUsage.warningThreshold.label",
          max: settings.maxContextUsageRingThreshold,
          min: settings.minContextUsageRingThreshold,
          unit: "%",
        })}
        ${controls.renderColorField({
          helpKey: "settings.contextUsage.warningColor.help",
          key: "contextUsageRingWarningColor",
          labelKey: "settings.contextUsage.warningColor.label",
        })}
        ${controls.renderNumberField({
          helpKey: "settings.contextUsage.criticalThreshold.help",
          key: "contextUsageRingCriticalThreshold",
          labelKey: "settings.contextUsage.criticalThreshold.label",
          max: settings.maxContextUsageRingThreshold,
          min: settings.minContextUsageRingThreshold,
          unit: "%",
        })}
        ${controls.renderColorField({
          helpKey: "settings.contextUsage.criticalColor.help",
          key: "contextUsageRingCriticalColor",
          labelKey: "settings.contextUsage.criticalColor.label",
        })}
      `;
    },
  });
})();
