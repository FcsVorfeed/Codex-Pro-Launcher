(() => {
  const runtime = window.__codexProRuntime;
  if (!runtime) return;

  runtime.registerSystem("settings-menu", () => {
    const { settings, view } = runtime.systemModules.settingsMenu;

    // 这一段创建设置菜单生命周期控制器，重复注入时会移除旧监听。
    // Create the settings menu lifecycle controller so reinjection removes old listeners.
    const controller = new AbortController();
    runtime.lifecycle.replaceController("settings-menu", controller);
    let viewController = null;
    let currentLanguage = settings.getSettings?.().uiLanguage || runtime.i18n?.defaultLocale || "en-US";
    let renderTimer = 0;

    function renderSettingsMenu() {
      // 这一段重建设置菜单 DOM 和交互绑定，语言切换后可以刷新所有静态文案。
      // Rebuild the settings-menu DOM and bindings so language changes refresh all static copy.
      renderTimer = 0;
      viewController?.abort();
      viewController = new AbortController();
      view.uninstall?.();
      const root = view.install(settings);
      view.bind(root, settings, viewController.signal);
    }

    controller.signal.addEventListener(
      "abort",
      () => {
        if (renderTimer) window.clearTimeout(renderTimer);
        viewController?.abort();
        view.uninstall?.();
      },
      { once: true },
    );

    // 这一段安装右上角入口与弹窗，并在语言设置变化后刷新界面外壳。
    // Install the top-right entry and dialog, then refresh the shell when the language setting changes.
    renderSettingsMenu();
    settings.subscribe((nextSettings) => {
      const nextLanguage = nextSettings?.uiLanguage || runtime.i18n?.defaultLocale || "en-US";
      if (nextLanguage === currentLanguage) return;
      currentLanguage = nextLanguage;
      runtime.i18n?.setLocale?.(nextLanguage);
      if (renderTimer) window.clearTimeout(renderTimer);
      renderTimer = window.setTimeout(renderSettingsMenu, 0);
    }, controller.signal);
  });
})();
