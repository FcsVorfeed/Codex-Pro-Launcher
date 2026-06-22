(() => {
  const runtime = window.__codexProRuntime;
  if (!runtime) return;
  const settingsMenu = runtime.systemModules.settingsMenu ??= {};
  const i18n = runtime.i18n;
  if (!settingsMenu.registerSection) return;

  const icon = `
    <svg class="codex-pro-settings-section-icon" viewBox="0 0 24 24" aria-hidden="true" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round">
      <path d="M12 3c2.5 2.1 3.9 4.5 4.2 7.2"></path>
      <path d="M12 3c-2.5 2.1-3.9 4.5-4.2 7.2"></path>
      <path d="M5 9c2.5.2 4.8 1.3 7 3.2"></path>
      <path d="M19 9c-2.5.2-4.8 1.3-7 3.2"></path>
      <path d="M12 12.2V21"></path>
      <path d="M7.8 10.2c.2 4.1 1.6 6.2 4.2 6.2s4-2.1 4.2-6.2"></path>
    </svg>
  `;

  function renderPetEventSoundCard(stateId, settings) {
    // 这一段为单个宠物动画状态生成音效路径卡片，标题和说明统一走 i18n。
    // Render one pet-animation state sound-path card, with title and description resolved through i18n.
    const labelKey = `settings.petStatus.events.${stateId}.label`;
    const helpKey = `settings.petStatus.events.${stateId}.help`;
    const pathKey = `petEventSoundPaths:${stateId}`;
    const escapedStateId = i18n.escapeHtml(stateId);
    const maxPathLength = Number(settings.maxPetEventSoundPathLength) || 1000;
    return `
      <section class="codex-pro-cloud-sync-feature-block codex-pro-pet-status-event-card" data-codex-pro-pet-event-sound-card="${escapedStateId}">
        <div class="codex-pro-cloud-sync-feature-heading">
          <span class="codex-pro-cloud-sync-feature-title">${i18n.html(labelKey)}</span>
          <span class="codex-pro-cloud-sync-feature-note">${i18n.html(helpKey)}</span>
        </div>
        <div class="codex-pro-cloud-sync-feature-body">
          <label class="codex-pro-settings-field codex-pro-settings-field-stack" data-codex-pro-setting-key="${pathKey}">
            <span class="codex-pro-settings-copy">
              <span class="codex-pro-settings-label">${i18n.html("settings.petStatus.path.label")}</span>
              <span class="codex-pro-settings-help">${i18n.html("settings.petStatus.path.help")}</span>
            </span>
            <input class="codex-pro-settings-input codex-pro-settings-path-input" name="petEventSoundPath_${escapedStateId}" type="text" maxlength="${String(maxPathLength)}" autocomplete="off" spellcheck="false" placeholder="${i18n.attr("settings.petStatus.path.placeholder")}" data-codex-pro-pet-event-sound-path="${escapedStateId}">
          </label>
        </div>
      </section>
    `;
  }

  function readPetEventSoundPaths(inputs) {
    // 这一段从固定事件输入框读取路径草稿，保存前仍交给 settings 模块统一规范化。
    // Read path drafts from fixed event inputs while leaving final normalization to the settings model.
    const paths = {};
    for (const input of inputs) {
      const stateId = input.getAttribute("data-codex-pro-pet-event-sound-path");
      paths[stateId] = input.value;
    }
    return paths;
  }

  function writePetEventSoundPaths(inputs, paths) {
    // 这一段把已保存路径写回每个事件输入框，未知事件不会影响当前界面。
    // Write saved paths back to each event input; unknown events cannot affect the current UI.
    for (const input of inputs) {
      const stateId = input.getAttribute("data-codex-pro-pet-event-sound-path");
      input.value = paths?.[stateId] || "";
    }
  }

  function setPetEventSoundInputsDisabled(inputs, isDisabled) {
    // 这一段同步每个路径输入的禁用状态，让总开关关闭后事件卡片不可编辑。
    // Sync disabled state for each path input so cards become read-only when the master switch is off.
    for (const input of inputs) {
      input.disabled = isDisabled;
      const field = input.closest?.("[data-codex-pro-setting-key]");
      if (!field) continue;
      field.dataset.codexProDisabled = String(isDisabled);
      field.setAttribute("aria-disabled", String(isDisabled));
    }
  }

  settingsMenu.registerSection({
    fieldDependencies: {},
    icon,
    id: "pet-status",
    labelKey: "settings.petStatus.label",
    noteKey: "settings.petStatus.note",
    order: 92,
    settingKeys: ["enablePetEventSounds", "petEventSoundCooldownMs", "petEventSoundPaths"],
    sourcePath: "src/inject/systems/settings-menu/sections/pet-status.js",
    sourceSystem: "pet-event-sounds",
    titleKey: "settings.petStatus.title",
    render(settings) {
      // 这一段渲染宠物状态音效配置，事件列表来自 settings 模块的固定状态清单。
      // Render pet-state sound configuration using the fixed state list exposed by the settings module.
      const stateIds = Array.isArray(settings.petEventSoundStateIds) ? settings.petEventSoundStateIds : [];
      return `
        ${settingsMenu.sectionControls.renderSwitchField({
          helpKey: "settings.petStatus.enable.help",
          key: "enablePetEventSounds",
          labelKey: "settings.petStatus.enable.label",
        })}
        ${settingsMenu.sectionControls.renderNumberField({
          copyParams: {
            max: settings.maxPetEventSoundCooldownMs,
            min: settings.minPetEventSoundCooldownMs,
          },
          helpKey: "settings.petStatus.cooldown.help",
          key: "petEventSoundCooldownMs",
          labelKey: "settings.petStatus.cooldown.label",
          max: settings.maxPetEventSoundCooldownMs,
          min: settings.minPetEventSoundCooldownMs,
          unitKey: "settings.petStatus.cooldown.unit",
        })}
        <div class="codex-pro-cloud-sync-feature-list codex-pro-pet-status-event-list">
          ${stateIds.map((stateId) => renderPetEventSoundCard(stateId, settings)).join("")}
        </div>
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
      const enableInput = form?.elements?.enablePetEventSounds;
      const pathInputs = Array.from(root.querySelectorAll("[data-codex-pro-pet-event-sound-path]"));
      if (pathInputs.length !== settings.petEventSoundStateIds.length) return;

      addDraftSettingsReader(() => ({
        petEventSoundPaths: readPetEventSoundPaths(pathInputs),
      }));
      addSettingsWriter((currentSettings) => {
        writePetEventSoundPaths(pathInputs, currentSettings.petEventSoundPaths);
      });
      addModifiedStateRenderer(() => {
        setPetEventSoundInputsDisabled(pathInputs, !enableInput?.checked);
      });

      for (const input of pathInputs) {
        input.addEventListener("input", () => {
          // 这一段在路径输入时立即刷新修改标记，让每个事件卡片能显示自己的蓝点。
          // Refresh modified markers while typing so each event card can show its own dirty state.
          renderModifiedState();
        }, { signal });
      }
    },
  });
})();
