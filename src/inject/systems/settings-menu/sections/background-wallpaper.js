(() => {
  const runtime = window.__codexProRuntime;
  if (!runtime) return;
  const settingsMenu = runtime.systemModules.settingsMenu ??= {};
  const i18n = runtime.i18n;
  if (!settingsMenu.registerSection) return;

  const icon = `
    <svg class="codex-pro-settings-section-icon" viewBox="0 0 24 24" aria-hidden="true" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round">
      <rect x="3" y="5" width="18" height="14" rx="2"></rect>
      <circle cx="8.5" cy="10" r="1.5"></circle>
      <path d="m21 15-4.5-4.5L9 18"></path>
    </svg>
  `;

  settingsMenu.registerSection({
    icon,
    id: "background-wallpaper",
    labelKey: "settings.background.label",
    noteKey: "settings.background.note",
    order: 80,
    settingKeys: [
      "enableBackgroundWallpaper",
      "backgroundWallpaperImages",
      "backgroundWallpaperIntervalSeconds",
      "backgroundWallpaperOpacity",
      "backgroundWallpaperPosition",
      "backgroundWallpaperRandom",
      "backgroundWallpaperSize",
    ],
    fieldDependencies: {
      backgroundWallpaperImages: "enableBackgroundWallpaper",
      backgroundWallpaperIntervalSeconds: "enableBackgroundWallpaper",
      backgroundWallpaperOpacity: "enableBackgroundWallpaper",
      backgroundWallpaperPosition: "enableBackgroundWallpaper",
      backgroundWallpaperRandom: "enableBackgroundWallpaper",
      backgroundWallpaperSize: "enableBackgroundWallpaper",
    },
    titleKey: "settings.background.title",
    render(settings) {
      // 这一段声明背景轮播的静态表单，实际壁纸运行逻辑仍由 background-wallpaper 系统负责。
      // Declare the wallpaper form while runtime wallpaper behavior stays inside the background-wallpaper system.
      return `
        <label class="codex-pro-settings-field" data-codex-pro-setting-key="enableBackgroundWallpaper">
            <span class="codex-pro-settings-copy">
            <span class="codex-pro-settings-label">${i18n.html("settings.background.enable.label")}</span>
            <span class="codex-pro-settings-help">${i18n.html("settings.background.enable.help")}</span>
          </span>
          <span class="codex-pro-settings-switch">
            <input name="enableBackgroundWallpaper" type="checkbox">
            <span class="codex-pro-settings-switch-track" aria-hidden="true"></span>
          </span>
        </label>
        <label class="codex-pro-settings-field codex-pro-settings-field-stack" data-codex-pro-setting-key="backgroundWallpaperImages">
          <span class="codex-pro-settings-copy">
            <span class="codex-pro-settings-label">${i18n.html("settings.background.images.label")}</span>
            <span class="codex-pro-settings-help">${i18n.html("settings.background.images.help")}</span>
          </span>
          <textarea class="codex-pro-settings-textarea" name="backgroundWallpaperImages" maxlength="${settings.maxBackgroundWallpaperImagesLength}" spellcheck="false" placeholder="https://example.com/wallpaper.jpg"></textarea>
        </label>
        <label class="codex-pro-settings-field" data-codex-pro-setting-key="backgroundWallpaperIntervalSeconds">
          <span class="codex-pro-settings-copy">
            <span class="codex-pro-settings-label">${i18n.html("settings.background.interval.label")}</span>
            <span class="codex-pro-settings-help">${i18n.html("settings.background.interval.help", { min: settings.minBackgroundWallpaperIntervalSeconds })}</span>
          </span>
          <span class="codex-pro-settings-number-row">
            <input class="codex-pro-settings-input" name="backgroundWallpaperIntervalSeconds" type="number" min="${settings.minBackgroundWallpaperIntervalSeconds}" step="5" inputmode="numeric">
            <span class="codex-pro-settings-unit">${i18n.html("common.secondsUnit")}</span>
          </span>
        </label>
        <label class="codex-pro-settings-field" data-codex-pro-setting-key="backgroundWallpaperRandom">
          <span class="codex-pro-settings-copy">
            <span class="codex-pro-settings-label">${i18n.html("settings.background.random.label")}</span>
            <span class="codex-pro-settings-help">${i18n.html("settings.background.random.help")}</span>
          </span>
          <span class="codex-pro-settings-switch">
            <input name="backgroundWallpaperRandom" type="checkbox">
            <span class="codex-pro-settings-switch-track" aria-hidden="true"></span>
          </span>
        </label>
        <label class="codex-pro-settings-field" data-codex-pro-setting-key="backgroundWallpaperOpacity">
          <span class="codex-pro-settings-copy">
            <span class="codex-pro-settings-label">${i18n.html("settings.background.opacity.label")}</span>
            <span class="codex-pro-settings-help">${i18n.html("settings.background.opacity.help", {
              max: settings.maxBackgroundWallpaperOpacity,
              min: settings.minBackgroundWallpaperOpacity,
            })}</span>
          </span>
          <span class="codex-pro-settings-number-row">
            <input class="codex-pro-settings-input" name="backgroundWallpaperOpacity" type="number" min="${settings.minBackgroundWallpaperOpacity}" max="${settings.maxBackgroundWallpaperOpacity}" step="0.01" inputmode="decimal">
            <span class="codex-pro-settings-unit">opacity</span>
          </span>
        </label>
        <label class="codex-pro-settings-field" data-codex-pro-setting-key="backgroundWallpaperSize">
          <span class="codex-pro-settings-copy">
            <span class="codex-pro-settings-label">${i18n.html("settings.background.size.label")}</span>
            <span class="codex-pro-settings-help">${i18n.html("settings.background.size.help")}</span>
          </span>
          <select class="codex-pro-settings-select" name="backgroundWallpaperSize">
            <option value="cover">cover</option>
            <option value="contain">contain</option>
            <option value="auto">auto</option>
          </select>
        </label>
        <label class="codex-pro-settings-field" data-codex-pro-setting-key="backgroundWallpaperPosition">
          <span class="codex-pro-settings-copy">
            <span class="codex-pro-settings-label">${i18n.html("settings.background.position.label")}</span>
            <span class="codex-pro-settings-help">${i18n.html("settings.background.position.help")}</span>
          </span>
          <select class="codex-pro-settings-select" name="backgroundWallpaperPosition">
            <option value="center">center</option>
            <option value="top">top</option>
            <option value="bottom">bottom</option>
            <option value="left">left</option>
            <option value="right">right</option>
            <option value="top left">top left</option>
            <option value="top right">top right</option>
            <option value="bottom left">bottom left</option>
            <option value="bottom right">bottom right</option>
          </select>
        </label>
      `;
    },
  });
})();
