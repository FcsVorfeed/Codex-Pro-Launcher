(() => {
  // 这一段建立注入运行时命名空间，并在重复注入时重置本次模块注册表。
  // Create the injection runtime namespace and reset this injection's module registry on reinjection.
  const runtime = window.__codexProRuntime ?? {};
  runtime.version = "1.0.5";
  runtime.systems = [];
  runtime.systemModules = {};
  runtime.controllers = runtime.controllers ?? {};
  runtime.localConfig = window.__codexProLocalConfig && typeof window.__codexProLocalConfig === "object"
    ? window.__codexProLocalConfig
    : {};
  runtime.hardDisabledSystems = new Set(Array.isArray(window.__codexProHardDisabledSystems)
    ? window.__codexProHardDisabledSystems
    : []);
  runtime.systemStates = {};

  // 这一段提供系统注册入口，后续每个功能系统只声明自己的启动函数。
  // Provide a system registration entrypoint so each feature system declares only its own start function.
  runtime.registerSystem = (name, start, options = {}) => {
    // 这一段兼容旧的单开关配置，同时允许少数系统声明多个运行态依赖开关。
    // Keep the old single-setting contract while allowing a few systems to declare multiple runtime gate settings.
    const enableSettings = Array.isArray(options.enableSettings)
      ? options.enableSettings.filter(Boolean)
      : options.enableSetting
        ? [options.enableSetting]
        : [];
    runtime.systems.push({ enableSetting: options.enableSetting || "", enableSettings, name, start });
  };

  function getSystemSettings() {
    // 这一段延迟读取设置模块，保证设置菜单损坏时其它系统仍按默认启用运行。
    // Read settings lazily so other systems can still run with defaults if the settings menu is unavailable.
    return runtime.systemModules.settingsMenu?.settings?.getSettings?.() || {};
  }

  function isSystemEnabled(system) {
    // 这一段只让声明了开关键的功能系统受设置控制，核心系统始终保持可启动。
    // Let only systems with explicit enable settings be controlled by settings, keeping core systems startable.
    if (runtime.hardDisabledSystems.has(system.name)) return false;
    const enableSettings = Array.isArray(system.enableSettings)
      ? system.enableSettings
      : system.enableSetting
        ? [system.enableSetting]
        : [];
    if (!enableSettings.length) return true;
    const settings = getSystemSettings();
    return enableSettings.every((key) => settings[key] !== false);
  }

  function stopSystem(system) {
    // 这一段通过系统自己的生命周期控制器停止功能，并记录当前启停状态。
    // Stop a feature through its own lifecycle controller and record its current enabled state.
    runtime.controllers[system.name]?.abort?.();
    system.sync = null;
    runtime.systemStates[system.name] = { enabled: false, started: false };
  }

  function startSystem(system) {
    // 这一段启动单个系统，异常只影响当前系统，不影响其它功能继续运行。
    // Start one system while keeping failures isolated from the rest of Codex-Pro.
    try {
      const instance = system.start(runtime);
      system.sync = typeof instance?.sync === "function" ? instance.sync : null;
      runtime.systemStates[system.name] = { enabled: true, started: true };
    } catch (error) {
      system.sync = null;
      runtime.systemStates[system.name] = { enabled: true, started: false };
      console.warn(`[Codex-Pro] system failed: ${system.name}`, error);
    }
  }

  function syncSystem(system) {
    // 这一段按最新设置同步某个系统，关闭时会 abort，重新打开时会再次 start。
    // Sync one system against current settings, aborting when disabled and starting again when re-enabled.
    const state = runtime.systemStates[system.name] || { enabled: null, started: false };
    const enabled = isSystemEnabled(system);
    if (!enabled) {
      if (state.started || state.enabled !== false) stopSystem(system);
      return;
    }
    if (!state.started) {
      startSystem(system);
      return;
    }
    if (typeof system.sync === "function") {
      try {
        system.sync(getSystemSettings());
      } catch (error) {
        console.warn(`[Codex-Pro] system sync failed: ${system.name}`, error);
      }
    }
    runtime.systemStates[system.name] = { enabled: true, started: true };
  }

  function syncSystems() {
    // 这一段统一同步所有已注册系统，后续新增功能只需要声明自己的开关键。
    // Sync all registered systems in one place so future features only declare their enable setting.
    for (const system of runtime.systems) syncSystem(system);
  }

  function abortHardDisabledSystems() {
    // 这一段停止硬屏蔽系统的旧控制器，覆盖“本次不再加载该系统模块”的重新注入场景。
    // Stop old controllers for hard-disabled systems, covering reinjection where that system module is no longer loaded.
    for (const name of runtime.hardDisabledSystems) {
      runtime.controllers[name]?.abort?.();
      runtime.systemStates[name] = { enabled: false, started: false };
    }
  }

  function bindSettingsSync() {
    // 这一段订阅设置变化，让设置面板里的功能开关能立即启停系统。
    // Subscribe to settings changes so feature switches in the settings panel take effect immediately.
    const settings = runtime.systemModules.settingsMenu?.settings;
    if (!settings?.subscribe) return;
    const controller = new AbortController();
    runtime.lifecycle?.replaceController?.("runtime-system-sync", controller);
    settings.subscribe(syncSystems, controller.signal);
  };

  // 这一段按注册顺序启动系统，单个系统失败不会阻断其它系统。
  // Start systems in registration order, and keep one failed system from blocking the rest.
  runtime.start = () => {
    abortHardDisabledSystems();
    syncSystems();
    bindSettingsSync();
  };

  window.__codexProRuntime = runtime;
})();
