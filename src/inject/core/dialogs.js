(() => {
  const runtime = window.__codexProRuntime;
  if (!runtime) return;

  const dialogId = "codex-pro-shared-dialog";
  const styleId = "codex-pro-shared-dialog-style";
  let activeDialogFinish = null;

  function installStyle() {
    // 这一段安装全局页面内确认框样式，复用同步侧栏确认框的视觉语言。
    // Install the shared in-page dialog style, reusing the sync-sidebar confirmation visual language.
    runtime.dom.ensureNativePanelTokens?.();
    runtime.dom.upsertStyle(styleId, `
      #${dialogId}.codex-pro-sync-confirm-backdrop {
        align-items: center;
        background: rgba(0, 0, 0, 0.28);
        display: flex;
        inset: 0;
        justify-content: center;
        padding: 16px;
        position: fixed;
        z-index: 2147483640;
      }
      #${dialogId} .codex-pro-sync-confirm-card {
        background: var(--codex-pro-native-panel-surface);
        background-clip: padding-box;
        border: 1px solid var(--codex-pro-native-panel-border);
        border-radius: var(--codex-pro-native-panel-radius-medium);
        box-shadow: var(--codex-pro-native-panel-shadow);
        color: var(--codex-pro-native-panel-foreground);
        display: flex;
        flex-direction: column;
        gap: 14px;
        max-width: min(460px, calc(100vw - 32px));
        min-width: min(360px, calc(100vw - 32px));
        padding: 18px;
        -webkit-backdrop-filter: blur(var(--codex-pro-native-panel-blur));
        backdrop-filter: blur(var(--codex-pro-native-panel-blur));
      }
      #${dialogId} .codex-pro-sync-confirm-title {
        font-size: 15px;
        font-weight: 600;
        line-height: 22px;
        margin: 0;
      }
      #${dialogId} .codex-pro-sync-confirm-message {
        color: var(--codex-pro-native-panel-muted);
        font-size: 13px;
        line-height: 20px;
        margin: 0;
        white-space: pre-wrap;
      }
      #${dialogId} .codex-pro-sync-confirm-actions {
        display: flex;
        gap: 8px;
        justify-content: flex-end;
      }
      #${dialogId} .codex-pro-sync-confirm-button {
        background: transparent;
        border: 1px solid var(--codex-pro-native-panel-border);
        border-radius: var(--codex-pro-native-panel-radius-inner);
        color: var(--codex-pro-native-panel-foreground);
        cursor: pointer;
        font: inherit;
        font-size: 13px;
        min-height: 32px;
        min-width: 68px;
        padding: 0 12px;
      }
      #${dialogId} .codex-pro-sync-confirm-button:hover {
        background: var(--codex-pro-native-panel-hover);
      }
      #${dialogId} .codex-pro-sync-confirm-button[data-kind="primary"] {
        background: color-mix(in srgb, #0e9eea 24%, transparent);
        border-color: color-mix(in srgb, #0e9eea 58%, var(--codex-pro-native-panel-border));
      }
      #${dialogId} .codex-pro-sync-confirm-button[data-kind="danger"] {
        background: color-mix(in srgb, #c2410c 18%, transparent);
        border-color: color-mix(in srgb, #f97316 48%, var(--codex-pro-native-panel-border));
      }
      #${dialogId} .codex-pro-sync-confirm-button:focus-visible {
        outline: 2px solid color-mix(in srgb, Highlight 78%, transparent);
        outline-offset: 2px;
      }
    `);
  }

  function getI18nText(key, fallback) {
    // 这一段在 i18n 未就绪或缺 key 时保持按钮文案可用。
    // Keep button copy usable when i18n is unavailable or a key is missing.
    return runtime.i18n?.t?.(key) || fallback;
  }

  function showDialog({
    cancelLabel = getI18nText("common.cancel", "Cancel"),
    confirmKind = "primary",
    confirmLabel = getI18nText("common.confirm", "OK"),
    message = "",
    showCancel = true,
    signal,
    title = getI18nText("common.dialog.title", "Notice"),
  } = {}) {
    // 这一段用页面内对话框替代浏览器原生 alert/confirm，避免用户勾选“阻止后续对话框”后功能失效。
    // Use an in-page dialog instead of native alert/confirm so browser dialog suppression cannot break features.
    installStyle();
    activeDialogFinish?.(false);
    document.getElementById(dialogId)?.remove();
    const previousFocus = document.activeElement instanceof HTMLElement ? document.activeElement : null;
    const localController = new AbortController();
    const backdrop = document.createElement("div");
    backdrop.id = dialogId;
    backdrop.className = "codex-pro-sync-confirm-backdrop";
    const card = document.createElement("div");
    card.className = "codex-pro-sync-confirm-card";
    card.setAttribute("aria-describedby", `${dialogId}-message`);
    card.setAttribute("aria-labelledby", `${dialogId}-title`);
    card.setAttribute("aria-modal", "true");
    card.setAttribute("role", "dialog");

    // 这一段所有正文都用 textContent 写入，调用方传入的设备名、错误信息或远端文案不会进入 HTML。
    // Write every visible string through textContent so device names, errors, and remote copy never become HTML.
    const titleElement = document.createElement("h2");
    titleElement.id = `${dialogId}-title`;
    titleElement.className = "codex-pro-sync-confirm-title";
    titleElement.textContent = title;
    const messageElement = document.createElement("p");
    messageElement.id = `${dialogId}-message`;
    messageElement.className = "codex-pro-sync-confirm-message";
    messageElement.textContent = message;

    const actions = document.createElement("div");
    actions.className = "codex-pro-sync-confirm-actions";
    const cancelButton = document.createElement("button");
    cancelButton.className = "codex-pro-sync-confirm-button";
    cancelButton.type = "button";
    cancelButton.textContent = cancelLabel;
    const confirmButton = document.createElement("button");
    confirmButton.className = "codex-pro-sync-confirm-button";
    confirmButton.type = "button";
    confirmButton.dataset.kind = confirmKind;
    confirmButton.textContent = confirmLabel;
    if (showCancel) actions.append(cancelButton);
    actions.append(confirmButton);
    card.append(titleElement, messageElement, actions);
    backdrop.append(card);
    document.body.append(backdrop);

    return new Promise((resolve) => {
      let settled = false;
      function finish(value) {
        // 这一段保证对话框只结算一次，并恢复用户打开它之前的焦点。
        // Ensure the dialog settles only once and restore focus to where the user opened it.
        if (settled) return;
        settled = true;
        localController.abort();
        backdrop.remove();
        if (activeDialogFinish === finish) activeDialogFinish = null;
        previousFocus?.focus?.({ preventScroll: true });
        resolve(value);
      }
      activeDialogFinish = finish;
      cancelButton.addEventListener("click", () => finish(false), { signal: localController.signal });
      confirmButton.addEventListener("click", () => finish(true), { signal: localController.signal });
      backdrop.addEventListener("click", (event) => {
        if (event.target === backdrop) finish(false);
      }, { signal: localController.signal });
      backdrop.addEventListener("keydown", (event) => {
        if (event.key !== "Escape") return;
        event.preventDefault();
        finish(false);
      }, { signal: localController.signal });
      signal?.addEventListener?.("abort", () => finish(false), { once: true, signal: localController.signal });
      if (signal?.aborted) {
        finish(false);
        return;
      }
      (showCancel ? cancelButton : confirmButton).focus({ preventScroll: true });
    });
  }

  runtime.dialogs = {
    alert(options = {}) {
      // 这一段提供 alert 语义，但始终使用页面内对话框。
      // Provide alert semantics while always rendering an in-page dialog.
      return showDialog({
        ...options,
        confirmKind: options.confirmKind || "primary",
        confirmLabel: options.confirmLabel || getI18nText("common.confirm", "OK"),
        showCancel: false,
      });
    },
    confirm(options = {}) {
      // 这一段提供 confirm 语义，返回 Promise<boolean> 供异步同步流程等待。
      // Provide confirm semantics as Promise<boolean> so async sync flows can await it.
      return showDialog({
        ...options,
        confirmKind: options.confirmKind || "primary",
        showCancel: true,
      });
    },
    remove() {
      // 这一段给重新注入或极端恢复场景保留显式清理入口。
      // Keep an explicit cleanup entrypoint for reinjection and recovery paths.
      activeDialogFinish?.(false);
      document.getElementById(dialogId)?.remove();
    },
  };
})();
