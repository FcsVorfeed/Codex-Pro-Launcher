(() => {
  const runtime = window.__codexProRuntime;
  if (!runtime) return;
  const nativePanelStyleId = "codex-pro-native-panel-tokens";

  function ensureNativePanelTokens() {
    // 这一段集中声明 Codex-Pro 浮层材质变量，优先继承 Codex 当前主题 token。
    // Centralize Codex-Pro floating-surface tokens while inheriting the current Codex theme first.
    return upsertStyle(
      nativePanelStyleId,
      `
        :root {
          --codex-pro-native-panel-surface: var(--color-token-input-background, var(--color-background-control, Canvas));
          --codex-pro-native-panel-surface-strong: var(--color-token-dropdown-background, var(--color-background-control-opaque, Canvas));
          --codex-pro-native-panel-border: var(--color-token-input-border, var(--color-token-border, color-mix(in srgb, CanvasText 12%, transparent)));
          --codex-pro-native-panel-border-soft: var(--color-token-border, color-mix(in srgb, CanvasText 10%, transparent));
          --codex-pro-native-panel-foreground: var(--color-token-foreground, var(--color-text-foreground, CanvasText));
          --codex-pro-native-panel-muted: var(--color-token-description-foreground, var(--color-token-text-tertiary, color-mix(in srgb, CanvasText 58%, transparent)));
          --codex-pro-native-panel-hover: var(--color-token-list-hover-background, var(--color-background-button-secondary-hover, color-mix(in srgb, CanvasText 8%, transparent)));
          --codex-pro-native-panel-active: var(--color-token-list-active-selection-background, var(--color-background-button-secondary-active, color-mix(in srgb, CanvasText 12%, transparent)));
          --codex-pro-native-panel-row: var(--color-background-elevated-secondary, color-mix(in srgb, var(--codex-pro-native-panel-foreground) 4%, transparent));
          --codex-pro-native-panel-blur: var(--blur-lg, 16px);
          --codex-pro-native-panel-radius: var(--radius-3xl, 25px);
          --codex-pro-native-panel-radius-medium: var(--radius-2xl, 20px);
          --codex-pro-native-panel-radius-small: var(--radius-lg, 10px);
          --codex-pro-native-panel-radius-inner: var(--radius-md, 8px);
          --codex-pro-native-panel-shadow: 0 4px 16px 0 rgba(0, 0, 0, .05), 0 16px 32px -8px rgba(0, 0, 0, .18);
          --codex-pro-native-panel-shadow-compact: 0 4px 16px 0 rgba(0, 0, 0, .05), 0 12px 24px -10px rgba(0, 0, 0, .20);
          --codex-pro-native-panel-font-family: -apple-system, BlinkMacSystemFont, "Segoe UI", sans-serif;
        }
      `,
    );
  }

  function upsertStyle(id, cssText) {
    // 这一段复用已有样式节点，确保重复注入时 CSS 会刷新。
    // Reuse the existing style node so repeated injection refreshes CSS.
    let style = document.getElementById(id);
    if (!style) {
      style = document.createElement("style");
      style.id = id;
      (document.head || document.documentElement).appendChild(style);
    }

    // 这一段写入完整样式，避免旧版本样式残留。
    // Write the full stylesheet to avoid stale styles from older injections.
    style.textContent = cssText;
    return style;
  }

  function ensureRoot(id) {
    // 这一段复用固定根节点，避免重复注入生成多个面板。
    // Reuse a stable root node so reinjection does not create duplicate panels.
    let root = document.getElementById(id);
    if (!root) {
      root = document.createElement("div");
      root.id = id;
      document.body.appendChild(root);
    }
    return root;
  }

  runtime.dom = {
    ensureNativePanelTokens,
    ensureRoot,
    upsertStyle,
  };
})();
