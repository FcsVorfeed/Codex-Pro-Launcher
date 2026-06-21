(() => {
  const runtime = window.__codexProRuntime;
  if (!runtime) return;

  runtime.registerSystem("legacy-cleanup", () => {
    // 这一段清理旧版 MVP 的拖拽监听器，避免继续拦截 Codex 原生上传。
    // Clear old MVP drag listeners so Codex native uploads are not intercepted.
    runtime.lifecycle.clearWindowController("__codexProDropController");

    // 这一段移除旧版 MVP 可能残留的拖拽提示卡，避免界面上留下孤立元素。
    // Remove any stale MVP drop toast so no orphan UI remains on the page.
    document.querySelector(".codex-pro-drop-card")?.remove();

    // 这一段清理已退役的字体替换系统运行态，避免热刷新后旧 CSS 覆盖继续残留。
    // Clean the retired font override runtime so hot reinjection cannot leave stale CSS overrides.
    runtime.controllers?.["font-override"]?.abort?.();
    if (runtime.controllers) delete runtime.controllers["font-override"];
    document.getElementById("codex-pro-font-override-style")?.remove();
  });
})();
