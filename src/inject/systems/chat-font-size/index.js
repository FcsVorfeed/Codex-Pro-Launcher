(() => {
  // 这一段仅增强官方聊天区域的字体变量，不修改全局 UI 或代码字体。
  // Enhance the native chat font variable without changing global UI or code fonts.
  const runtime = window.__codexProRuntime;
  if (!runtime) return;
  const systemName = "chat-font-size";
  const styleId = "codex-pro-chat-font-size-style";

  // 这一段管理设置变化和卸载，纯 CSS 继承会自动跟随原生字号及新挂载聊天。
  // Manage settings and cleanup; CSS inheritance follows native size and newly mounted chats.
  runtime.registerSystem(systemName, () => {
    const controller = new AbortController();
    runtime.lifecycle.replaceController(systemName, controller);

    // 这一段在根节点解析官方字号别名，避免子层级的官方 override 变量重置影响跟随。
    // Resolve a native font alias at the root so descendant override resets cannot break native-size tracking.
    function sync(settings) {
      const offset = Number(settings?.chatFontSizeOffset ?? 2);
      if (![1, 2].includes(offset)) {
        document.getElementById(styleId)?.remove();
        return;
      }
      runtime.dom.upsertStyle(styleId, `
        :root {
          --codex-pro-native-chat-font-size: var(--codex-chat-font-size);
        }
        [data-app-action-timeline-scroll], [data-thread-find-composer] {
          --codex-chat-font-size: calc(var(--codex-pro-native-chat-font-size) + ${offset}px);
        }
      `);
    }

    // 这一段移除自有样式即可恢复官方继承，不保存或覆盖官方设置值。
    // Removing our stylesheet restores native inheritance without storing or overwriting native settings.
    controller.signal.addEventListener("abort", () => document.getElementById(styleId)?.remove(), { once: true });
    sync(runtime.systemModules.settingsMenu?.settings?.getSettings?.());
    return { sync };
  }, { enableSetting: "enableChatFontSize" });
})();
