(() => {
  const runtime = window.__codexProRuntime;
  if (!runtime) return;

  function replaceController(key, controller) {
    // 这一段替换同名控制器，避免重复注入留下旧定时器或监听器。
    // Replace a named controller so reinjection does not leave stale timers or listeners.
    runtime.controllers[key]?.abort?.();
    runtime.controllers[key] = controller;
    return controller;
  }

  function replaceWindowController(key, controller) {
    // 这一段兼容旧版挂在 window 上的控制器，便于平滑迁移。
    // Support older controllers stored on window so migration remains clean.
    window[key]?.abort?.();
    window[key] = controller;
    return controller;
  }

  function clearWindowController(key) {
    // 这一段清理旧版全局控制器，避免已经废弃的系统继续运行。
    // Clear a legacy global controller so retired systems stop running.
    window[key]?.abort?.();
    delete window[key];
  }

  runtime.lifecycle = {
    clearWindowController,
    replaceController,
    replaceWindowController,
  };
})();
