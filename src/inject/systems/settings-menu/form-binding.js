(() => {
  const runtime = window.__codexProRuntime;
  if (!runtime) return;
  const settingsMenu = runtime.systemModules.settingsMenu ??= {};

  function getBindableFields(settings) {
    // 这一段只读取设置模型公开字段，避免表单层维护第二份设置名单。
    // Read only fields exposed by the settings model so the form layer does not maintain a second setting list.
    return (Array.isArray(settings?.settingFields) ? settings.settingFields : [])
      .filter((field) => field?.key && field.key !== "mouseGestureShortcuts");
  }

  function getNamedElement(form, key) {
    // 这一段按字段名读取表单控件；硬屏蔽分区导致缺失时返回 null，让调用方保留当前设置值。
    // Read a form control by field name; return null when hard-disabled sections remove it so callers keep current settings.
    const element = form?.elements?.[key];
    if (!element) return null;
    if (typeof element.length === "number" && !element.tagName) return element[0] || null;
    return element;
  }

  function readElementValue(element) {
    // 这一段把普通输入控件转换成设置草稿值；最终类型和范围仍由 settings 模块归一化。
    // Convert common controls into draft setting values while final type and range normalization stays in settings.
    if (element?.type === "checkbox") return Boolean(element.checked);
    return element?.value ?? "";
  }

  function writeElementValue(element, value) {
    // 这一段把规范化设置写回普通控件，打开、保存和远端下载都复用同一逻辑。
    // Write normalized settings back to common controls so open, save, and remote download share one path.
    if (!element) return;
    if (element.type === "checkbox") {
      element.checked = Boolean(value);
      return;
    }
    element.value = value == null ? "" : String(value);
  }

  function getChangeEventName(element) {
    // 这一段根据控件类型选择轻量监听事件，文本即时标记，开关和下拉等确认后标记。
    // Choose a lightweight event per control type: text marks immediately, switches and selects mark after change.
    if (element?.type === "checkbox" || element?.tagName === "SELECT") return "change";
    return "input";
  }

  function normalizeDependencyKeys(value) {
    // 这一段把 section 声明里的依赖键规整成字符串数组，支持单键和多键依赖。
    // Normalize section-declared dependency keys into a string array, supporting one or many keys.
    const rawKeys = Array.isArray(value) ? value : [value];
    return rawKeys
      .map((key) => String(key || "").trim())
      .filter(Boolean);
  }

  function getFieldDependencies() {
    // 这一段从已注册 section 收集字段依赖，避免 view shell 维护跨系统字段清单。
    // Collect field dependencies from registered sections so the view shell does not own cross-system field lists.
    const dependencies = new Map();
    const sections = Array.isArray(settingsMenu.sections) ? settingsMenu.sections : [];
    for (const section of sections) {
      const fieldDependencies = section?.fieldDependencies;
      if (!fieldDependencies || typeof fieldDependencies !== "object" || Array.isArray(fieldDependencies)) continue;
      for (const [fieldKey, dependencyKeys] of Object.entries(fieldDependencies)) {
        const key = String(fieldKey || "").trim();
        const keys = normalizeDependencyKeys(dependencyKeys);
        if (key && keys.length > 0) dependencies.set(key, keys);
      }
    }
    return dependencies;
  }

  function isDependencyEnabled(form, key) {
    // 这一段读取依赖控件当前状态；缺失控件视为不参与，避免硬屏蔽分区误禁用其它字段。
    // Read the current dependency control state; missing controls are ignored so hard-disabled sections do not disable others.
    const element = getNamedElement(form, key);
    if (!element) return true;
    if (element.type === "checkbox") return Boolean(element.checked);
    return Boolean(readElementValue(element));
  }

  function setFieldDisabledState(element, isDisabled) {
    // 这一段同步控件 disabled 属性和整行禁用标记，让可访问状态与视觉状态保持一致。
    // Sync the control disabled attribute and row-level marker so accessibility and visuals stay aligned.
    element.disabled = isDisabled;

    // 这一段只标记当前设置行；测试替身或异常 DOM 没有 closest 时安全跳过。
    // Mark only the current settings row; safely skip test stand-ins or unusual DOM without closest.
    const field = typeof element.closest === "function" ? element.closest("[data-codex-pro-setting-key]") : null;
    if (!field) return;
    field.dataset.codexProDisabled = String(isDisabled);
    field.setAttribute("aria-disabled", String(isDisabled));
  }

  function applyFieldDependencyState({ form }) {
    // 这一段统一应用 section 声明的可编辑依赖，新增分区只需要声明依赖关系。
    // Apply section-declared editability dependencies; new sections only declare the dependency relationship.
    for (const [fieldKey, dependencyKeys] of getFieldDependencies()) {
      const element = getNamedElement(form, fieldKey);
      if (!element) continue;
      setFieldDisabledState(element, !dependencyKeys.every((dependencyKey) => isDependencyEnabled(form, dependencyKey)));
    }
  }

  function readDraftSettings({ form, settings }) {
    // 这一段以当前完整设置为基准读取表单草稿；缺失 DOM 字段自然保留当前值。
    // Read draft values from the form using current complete settings as the baseline so missing DOM fields are preserved.
    const draftSettings = { ...settings.getSettings() };
    for (const field of getBindableFields(settings)) {
      const element = getNamedElement(form, field.key);
      if (!element) continue;
      draftSettings[field.key] = readElementValue(element);
    }
    return draftSettings;
  }

  function writeSettingsToForm({ form, settings, currentSettings }) {
    // 这一段把 settings 模块给出的完整设置写回现有控件，缺失控件直接跳过。
    // Write the complete settings object from the settings module into existing controls, skipping missing controls.
    for (const field of getBindableFields(settings)) {
      const element = getNamedElement(form, field.key);
      if (!element) continue;
      writeElementValue(element, currentSettings[field.key]);
    }
  }

  function bindFieldListeners({ form, settings, onChange, signal }) {
    // 这一段统一给普通字段绑定修改监听，复杂 section 自己继续绑定命令按钮和特殊输入。
    // Attach change listeners for common fields while complex sections keep binding command buttons and special inputs.
    for (const field of getBindableFields(settings)) {
      const element = getNamedElement(form, field.key);
      if (!element || typeof element.addEventListener !== "function") continue;
      element.addEventListener(getChangeEventName(element), onChange, { signal });
    }
  }

  settingsMenu.formBinding = {
    applyFieldDependencyState,
    bindFieldListeners,
    readDraftSettings,
    writeSettingsToForm,
  };
})();
