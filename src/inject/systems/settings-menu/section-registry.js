(() => {
  const runtime = window.__codexProRuntime;
  if (!runtime) return;
  const settingsMenu = runtime.systemModules.settingsMenu ??= {};
  const sections = settingsMenu.sections ??= [];
  const i18n = runtime.i18n || {
    attr: (key, params) => escapeHtml(interpolateFallback(key, params)),
    escapeHtml,
    html: (key, params) => escapeHtml(interpolateFallback(key, params)),
    t: interpolateFallback,
  };

  function escapeHtml(value) {
    // 这一段转义 registry 兜底文案，正常路径会直接使用 core i18n 的转义函数。
    // Escape fallback registry copy; the normal path uses the core i18n escape helper directly.
    return String(value ?? "")
      .replace(/&/g, "&amp;")
      .replace(/</g, "&lt;")
      .replace(/>/g, "&gt;")
      .replace(/"/g, "&quot;")
      .replace(/'/g, "&#39;");
  }

  function interpolateFallback(key, params = {}) {
    // 这一段只在 i18n 核心异常缺失时兜底，保证设置页注册器不会直接崩溃。
    // Use this only when the i18n core is unexpectedly missing so the settings registry does not crash.
    return String(key || "").replace(/\{([A-Za-z0-9_.-]+)\}/g, (_, name) => String(params[name] ?? ""));
  }

  function resolveCopy({ value, key, params }) {
    // 这一段统一解析设置分区文案，支持直接文本和 i18n key 两种声明方式。
    // Resolve settings-section copy from either direct text or an i18n key.
    if (key) return i18n.html(key, params);
    return i18n.escapeHtml(value || "");
  }

  function registerSection(section) {
    // 这一段只接受完整的分区定义，避免坏模块破坏整个设置页。
    // Accept only complete section definitions so a bad module cannot break the whole settings page.
    if (!section || typeof section !== "object" || typeof section.id !== "string" || typeof section.render !== "function") return;
    if (section.bind != null && typeof section.bind !== "function") return;
    const existingIndex = sections.findIndex((item) => item.id === section.id);
    if (existingIndex >= 0) {
      sections.splice(existingIndex, 1, section);
      return;
    }
    sections.push(section);
  }

  function renderSwitchField({ key, label, labelKey, help, helpKey, copyParams, name = key }) {
    // 这一段生成通用开关字段，功能系统只声明文案和设置键即可。
    // Render a common switch field so feature systems only declare copy and setting keys.
    return `
      <label class="codex-pro-settings-field" data-codex-pro-setting-key="${key}">
        <span class="codex-pro-settings-copy">
          <span class="codex-pro-settings-label">${resolveCopy({ value: label, key: labelKey, params: copyParams })}</span>
          <span class="codex-pro-settings-help">${resolveCopy({ value: help, key: helpKey, params: copyParams })}</span>
        </span>
        <span class="codex-pro-settings-switch">
          <input name="${name}" type="checkbox">
          <span class="codex-pro-settings-switch-track" aria-hidden="true"></span>
        </span>
      </label>
    `;
  }

  function renderNumberField({
    key,
    label,
    labelKey,
    help,
    helpKey,
    copyParams,
    min,
    max = "",
    step = "1",
    unit = "",
    unitKey,
    placeholder = "",
    placeholderKey,
    name = key,
  }) {
    // 这一段生成通用数字字段，让功能系统声明数值设置时不用回到 view.js。
    // Render a common number field so feature systems can declare numeric settings without returning to view.js.
    const maxAttribute = max === "" ? "" : ` max="${max}"`;
    const placeholderValue = placeholderKey ? i18n.attr(placeholderKey, copyParams) : i18n.escapeHtml(placeholder);
    const placeholderAttribute = placeholderValue === "" ? "" : ` placeholder="${placeholderValue}"`;
    return `
      <label class="codex-pro-settings-field" data-codex-pro-setting-key="${key}">
        <span class="codex-pro-settings-copy">
          <span class="codex-pro-settings-label">${resolveCopy({ value: label, key: labelKey, params: copyParams })}</span>
          <span class="codex-pro-settings-help">${resolveCopy({ value: help, key: helpKey, params: copyParams })}</span>
        </span>
        <span class="codex-pro-settings-number-row">
          <input class="codex-pro-settings-input" name="${name}" type="number" min="${min}"${maxAttribute} step="${step}" inputmode="numeric"${placeholderAttribute}>
          <span class="codex-pro-settings-unit">${resolveCopy({ value: unit, key: unitKey, params: copyParams })}</span>
        </span>
      </label>
    `;
  }

  function renderTextareaField({ key, label, labelKey, help, helpKey, copyParams, maxlength, name = key }) {
    // 这一段生成通用多行文本字段，适合 Glob 规则等纯本机配置。
    // Render a common textarea field for local-only config such as Glob rules.
    return `
      <label class="codex-pro-settings-field codex-pro-settings-field-stack" data-codex-pro-setting-key="${key}">
        <span class="codex-pro-settings-copy">
          <span class="codex-pro-settings-label">${resolveCopy({ value: label, key: labelKey, params: copyParams })}</span>
          <span class="codex-pro-settings-help">${resolveCopy({ value: help, key: helpKey, params: copyParams })}</span>
        </span>
        <textarea class="codex-pro-settings-textarea" name="${name}" maxlength="${maxlength}" spellcheck="false"></textarea>
      </label>
    `;
  }

  settingsMenu.registerSection = registerSection;
  settingsMenu.sectionControls = {
    renderNumberField,
    renderSwitchField,
    renderTextareaField,
    resolveCopy,
  };
})();
