(() => {
  // 这一段作为注入入口，只负责启动已注册系统，不承载具体功能逻辑。
  // Act as the injection entrypoint only, starting registered systems without feature logic.
  window.__codexProRuntime?.start?.();
})();
