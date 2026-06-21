(() => {
  const runtime = window.__codexProRuntime;
  if (!runtime) return;
  const settingsMenu = runtime.systemModules.settingsMenu ??= {};
  const i18n = runtime.i18n;
  if (!settingsMenu.registerSection) return;

  const mouseGestureShortcutRows = [
    { code: "L", labelKey: "settings.mouseGestures.gesture.L" },
    { code: "R", labelKey: "settings.mouseGestures.gesture.R" },
    { code: "U", labelKey: "settings.mouseGestures.gesture.U" },
    { code: "D", labelKey: "settings.mouseGestures.gesture.D" },
    { code: "DL", labelKey: "settings.mouseGestures.gesture.DL" },
    { code: "DR", labelKey: "settings.mouseGestures.gesture.DR" },
    { code: "LR", labelKey: "settings.mouseGestures.gesture.LR" },
    { code: "RL", labelKey: "settings.mouseGestures.gesture.RL" },
  ];

  const icon = `
    <svg class="codex-pro-settings-section-icon" viewBox="0 0 24 24" aria-hidden="true" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round">
      <path d="M12 3v5"></path>
      <path d="m9 6 3 3 3-3"></path>
      <path d="M4 12h5"></path>
      <path d="m7 9 3 3-3 3"></path>
      <path d="M20 12h-5"></path>
      <path d="m17 9-3 3 3 3"></path>
      <path d="M12 21v-5"></path>
      <path d="m9 18 3-3 3 3"></path>
    </svg>
  `;

  function getDefaultShortcutText(settings, code) {
    // 这一段生成每个手势的默认值说明，空默认值统一显示为未设置。
    // Build the default-value copy for each gesture, showing unset defaults consistently.
    const defaultShortcut = settings.defaultSettings?.mouseGestureShortcuts?.[code] || "";
    return defaultShortcut
      ? i18n.t("settings.mouseGestures.default", { shortcut: defaultShortcut })
      : i18n.t("settings.mouseGestures.defaultUnset");
  }

  function renderMouseGestureShortcutFields(settings) {
    // 这一段按固定手势集合生成快捷键输入行，避免设置页和执行层出现不同方向码。
    // Render shortcut rows from the fixed gesture set so the settings UI and executor use the same codes.
    return mouseGestureShortcutRows.map((row) => `
      <label class="codex-pro-settings-field" data-codex-pro-setting-key="mouseGestureShortcuts:${row.code}">
        <span class="codex-pro-settings-copy">
          <span class="codex-pro-settings-label">${i18n.html(row.labelKey)}</span>
          <span class="codex-pro-settings-help">${i18n.html("settings.mouseGestures.shortcutHelp", { defaultText: getDefaultShortcutText(settings, row.code) })}</span>
        </span>
        <span class="codex-pro-settings-shortcut-row">
          <input class="codex-pro-settings-input codex-pro-settings-shortcut-input" name="mouseGestureShortcut_${row.code}" type="text" readonly autocomplete="off" spellcheck="false" placeholder="${i18n.attr("settings.mouseGestures.unsetPlaceholder")}" data-codex-pro-mouse-gesture-shortcut="${row.code}">
          <button class="codex-pro-settings-icon-action" type="button" aria-label="${i18n.attr("settings.mouseGestures.clearShortcut", { label: i18n.t(row.labelKey) })}" title="${i18n.attr("settings.mouseGestures.clear")}" data-codex-pro-clear-mouse-gesture-shortcut="${row.code}">
            <svg viewBox="0 0 24 24" aria-hidden="true" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round">
              <path d="M18 6 6 18"></path>
              <path d="m6 6 12 12"></path>
            </svg>
          </button>
        </span>
      </label>
    `).join("");
  }

  function getShortcutMainKeyFromEvent(event) {
    // 这一段把键盘事件里的主键转成设置模块能规范化的文本。
    // Convert the keyboard event main key into text that the settings module can normalize.
    if (["Alt", "Control", "Meta", "Shift"].includes(event.key)) return "";
    if (event.key === " ") return "Space";
    if (event.key?.startsWith?.("Arrow")) return event.key.slice("Arrow".length);
    return event.key || "";
  }

  function getShortcutFromEvent(event, settings) {
    // 这一段从 keydown 事件生成组合键草稿，最终合法性仍交给 settings 统一校验。
    // Build a shortcut draft from a keydown event while leaving final validation to settings.
    const mainKey = getShortcutMainKeyFromEvent(event);
    if (!mainKey) return "";
    const parts = [];
    if (event.ctrlKey) parts.push("Ctrl");
    if (event.altKey) parts.push("Alt");
    if (event.shiftKey) parts.push("Shift");
    if (event.metaKey) parts.push("Meta");
    parts.push(mainKey);
    return settings.normalizeMouseGestureShortcut(parts.join("+"));
  }

  settingsMenu.registerSection({
    icon,
    id: "mouse-gestures",
    labelKey: "settings.mouseGestures.label",
    noteKey: "settings.mouseGestures.note",
    order: 100,
    settingKeys: ["enableMouseGestures", "mouseGestureShortcuts"],
    titleKey: "settings.mouseGestures.title",
    render(settings) {
      // 这一段声明鼠标手势设置；快捷键输入是特殊控件，保存值由本 section 自己读写。
      // Declare mouse-gesture settings; shortcut inputs are special controls read and written by this section.
      return `
        <label class="codex-pro-settings-field" data-codex-pro-setting-key="enableMouseGestures">
          <span class="codex-pro-settings-copy">
            <span class="codex-pro-settings-label">${i18n.html("settings.mouseGestures.enable.label")}</span>
            <span class="codex-pro-settings-help">${i18n.html("settings.mouseGestures.enable.help")}</span>
          </span>
          <span class="codex-pro-settings-switch">
            <input name="enableMouseGestures" type="checkbox">
            <span class="codex-pro-settings-switch-track" aria-hidden="true"></span>
          </span>
        </label>
        ${renderMouseGestureShortcutFields(settings)}
      `;
    },
    bind(context) {
      const {
        addDraftSettingsReader,
        addModifiedStateRenderer,
        addSettingsWriter,
        form,
        renderModifiedState,
        root,
        settings,
        signal,
      } = context;
      const enableInput = form?.elements?.enableMouseGestures;
      const shortcutInputs = Array.from(root.querySelectorAll("[data-codex-pro-mouse-gesture-shortcut]"));
      const clearButtons = Array.from(root.querySelectorAll("[data-codex-pro-clear-mouse-gesture-shortcut]"));
      if (shortcutInputs.length !== settings.mouseGestureShortcutCodes.length) return;

      function readMouseGestureShortcuts() {
        // 这一段从固定输入框读取手势快捷键，保存前仍由 settings 模块做最终规范化。
        // Read gesture shortcuts from fixed inputs while leaving final normalization to the settings module.
        return Object.fromEntries(
          shortcutInputs.map((input) => [
            input.getAttribute("data-codex-pro-mouse-gesture-shortcut"),
            input.value,
          ]),
        );
      }

      function setMouseGestureShortcutInputs(shortcuts) {
        // 这一段把已保存配置写回输入框；未知方向码不会影响当前 UI。
        // Write saved shortcut values back to inputs; unknown gesture codes cannot affect the current UI.
        for (const input of shortcutInputs) {
          const code = input.getAttribute("data-codex-pro-mouse-gesture-shortcut");
          input.value = shortcuts?.[code] || "";
        }
      }

      addDraftSettingsReader(() => ({
        mouseGestureShortcuts: readMouseGestureShortcuts(),
      }));
      addSettingsWriter((currentSettings) => {
        setMouseGestureShortcutInputs(currentSettings.mouseGestureShortcuts);
      });
      addModifiedStateRenderer(() => {
        const isDisabled = !enableInput?.checked;
        for (const input of shortcutInputs) {
          input.disabled = isDisabled;
        }
        for (const button of clearButtons) {
          button.disabled = isDisabled;
        }
      });

      for (const input of shortcutInputs) {
        input.addEventListener("keydown", (event) => {
          // 这一段用按键捕获录入组合键，避免用户手输导致格式漂移。
          // Capture keydown to record the chord and avoid format drift from manual typing.
          if (event.key === "Escape") return;
          event.preventDefault();
          event.stopPropagation();
          if ((event.key === "Backspace" || event.key === "Delete") && !event.ctrlKey && !event.altKey && !event.shiftKey && !event.metaKey) {
            input.value = "";
            renderModifiedState();
            return;
          }
          const shortcut = getShortcutFromEvent(event, settings);
          if (!shortcut) return;
          input.value = shortcut;
          renderModifiedState();
        }, { signal });
        input.addEventListener("focus", () => {
          // 这一段聚焦时选中旧值，让用户直接按新组合键即可覆盖。
          // Select the old value on focus so pressing a new chord replaces it directly.
          input.select();
        }, { signal });
      }

      for (const button of clearButtons) {
        button.addEventListener("click", () => {
          // 这一段只清空对应方向码的输入框，不影响其它手势配置。
          // Clear only the matching gesture input without touching other gesture settings.
          const code = button.getAttribute("data-codex-pro-clear-mouse-gesture-shortcut");
          const input = root.querySelector(`[data-codex-pro-mouse-gesture-shortcut="${code}"]`);
          if (!input) return;
          input.value = "";
          renderModifiedState();
        }, { signal });
      }
    },
  });
})();
