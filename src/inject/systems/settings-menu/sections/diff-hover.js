(() => {
  const runtime = window.__codexProRuntime;
  if (!runtime) return;
  const settingsMenu = runtime.systemModules.settingsMenu ??= {};
  const i18n = runtime.i18n;
  if (!settingsMenu.registerSection) return;

  const icon = `
    <svg class="codex-pro-settings-section-icon" viewBox="0 0 24 24" aria-hidden="true" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round">
      <path d="M6 3h9l4 4v14H6Z"></path>
      <path d="M14 3v5h5"></path>
      <path d="M9 13h6"></path>
      <path d="M9 17h4"></path>
    </svg>
  `;

  settingsMenu.registerSection({
    icon,
    id: "diff-hover",
    labelKey: "settings.diffHover.label",
    noteKey: "settings.diffHover.note",
    order: 90,
    settingKeys: [
      "enableDiffHoverPreview",
      "diffHoverFileOpenMode",
      "diffHoverPreviewFontSize",
      "enableExternalDiffMiddleClick",
      "enableEditedFileCardExternalDiffMiddleClick",
      "externalDiffToolPath",
    ],
    fieldDependencies: {
      diffHoverFileOpenMode: "enableDiffHoverPreview",
      diffHoverPreviewFontSize: "enableDiffHoverPreview",
      enableExternalDiffMiddleClick: "enableDiffHoverPreview",
      enableEditedFileCardExternalDiffMiddleClick: "enableDiffHoverPreview",
      externalDiffToolPath: "enableDiffHoverPreview",
    },
    titleKey: "settings.diffHover.title",
    render(settings) {
      // 这一段声明文件变更悬浮预览的设置表单，预览和外部 Diff 执行逻辑仍在 diff-hover-preview 系统。
      // Declare diff-hover settings while preview and external-diff behavior stays in the diff-hover-preview system.
      return `
        <label class="codex-pro-settings-field" data-codex-pro-setting-key="enableDiffHoverPreview">
          <span class="codex-pro-settings-copy">
            <span class="codex-pro-settings-label">${i18n.html("settings.diffHover.enable.label")}</span>
            <span class="codex-pro-settings-help">${i18n.html("settings.diffHover.enable.help")}</span>
          </span>
          <span class="codex-pro-settings-switch">
            <input name="enableDiffHoverPreview" type="checkbox">
            <span class="codex-pro-settings-switch-track" aria-hidden="true"></span>
          </span>
        </label>
        <label class="codex-pro-settings-field" data-codex-pro-setting-key="diffHoverFileOpenMode">
          <span class="codex-pro-settings-copy">
            <span class="codex-pro-settings-label">${i18n.html("settings.diffHover.openMode.label")}</span>
            <span class="codex-pro-settings-help">${i18n.html("settings.diffHover.openMode.help")}</span>
          </span>
          <select class="codex-pro-settings-select" name="diffHoverFileOpenMode">
            <option value="review">${i18n.html("settings.diffHover.openMode.review")}</option>
            <option value="preview">${i18n.html("settings.diffHover.openMode.preview")}</option>
          </select>
        </label>
        <label class="codex-pro-settings-field" data-codex-pro-setting-key="diffHoverPreviewFontSize">
          <span class="codex-pro-settings-copy">
            <span class="codex-pro-settings-label">${i18n.html("settings.diffHover.fontSize.label")}</span>
            <span class="codex-pro-settings-help">${i18n.html("settings.diffHover.fontSize.help", {
              max: settings.maxDiffHoverPreviewFontSize,
              min: settings.minDiffHoverPreviewFontSize,
            })}</span>
          </span>
          <span class="codex-pro-settings-number-row">
            <input class="codex-pro-settings-input" name="diffHoverPreviewFontSize" type="number" min="${settings.minDiffHoverPreviewFontSize}" max="${settings.maxDiffHoverPreviewFontSize}" step="1" inputmode="numeric" placeholder="${i18n.attr("settings.diffHover.fontSize.placeholder")}">
            <span class="codex-pro-settings-unit">px</span>
          </span>
        </label>
        <label class="codex-pro-settings-field" data-codex-pro-setting-key="enableExternalDiffMiddleClick">
          <span class="codex-pro-settings-copy">
            <span class="codex-pro-settings-label">${i18n.html("settings.diffHover.middleClick.label")}</span>
            <span class="codex-pro-settings-help">${i18n.html("settings.diffHover.middleClick.help")}</span>
          </span>
          <span class="codex-pro-settings-switch">
            <input name="enableExternalDiffMiddleClick" type="checkbox">
            <span class="codex-pro-settings-switch-track" aria-hidden="true"></span>
          </span>
        </label>
        <label class="codex-pro-settings-field" data-codex-pro-setting-key="enableEditedFileCardExternalDiffMiddleClick">
          <span class="codex-pro-settings-copy">
            <span class="codex-pro-settings-label">${i18n.html("settings.diffHover.editedCardMiddleClick.label")}</span>
            <span class="codex-pro-settings-help">${i18n.html("settings.diffHover.editedCardMiddleClick.help")}</span>
          </span>
          <span class="codex-pro-settings-switch">
            <input name="enableEditedFileCardExternalDiffMiddleClick" type="checkbox">
            <span class="codex-pro-settings-switch-track" aria-hidden="true"></span>
          </span>
        </label>
        <label class="codex-pro-settings-field codex-pro-settings-field-stack" data-codex-pro-setting-key="externalDiffToolPath">
          <span class="codex-pro-settings-copy">
            <span class="codex-pro-settings-label">${i18n.html("settings.diffHover.toolPath.label")}</span>
            <span class="codex-pro-settings-help">${i18n.html("settings.diffHover.toolPath.help")}</span>
          </span>
          <input class="codex-pro-settings-input codex-pro-settings-path-input" name="externalDiffToolPath" type="text" maxlength="${settings.maxExternalDiffToolPathLength}" spellcheck="false" placeholder="C:/Program Files/Beyond Compare 4/BCompare.exe">
        </label>
      `;
    },
  });
})();
