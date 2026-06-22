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

  const playIcon = `
    <svg viewBox="0 0 24 24" aria-hidden="true" fill="currentColor">
      <path d="M8 5.6v12.8c0 .7.8 1.1 1.4.7l9.2-6.4c.5-.3.5-1.1 0-1.4L9.4 4.9C8.8 4.5 8 4.9 8 5.6z"></path>
    </svg>
  `;

  function getDefaultPetEventSoundVolume(settings) {
    // 这一段从设置模型读取默认音量；模型缺失时回到 100，避免界面空值影响播放。
    // Read the default volume from the settings model; fall back to 100 so missing metadata does not mute playback.
    return Number(settings.maxPetEventSoundVolume) || 100;
  }

  function normalizePetEventSoundVolume(settings, value) {
    // 这一段把界面输入规整到设置模型公布的音量范围，保存前先保持控件值稳定。
    // Normalize the UI input into the setting model's volume range so the control stays stable before saving.
    const min = Number(settings.minPetEventSoundVolume) || 0;
    const max = Number(settings.maxPetEventSoundVolume) || 100;
    if (typeof value === "string" && !value.trim()) return max;
    const number = Number(value);
    if (!Number.isFinite(number)) return max;
    return Math.round(Math.min(max, Math.max(min, number)));
  }

  function renderPetEventSoundCard(stateId, settings) {
    // 这一段为单个宠物动画状态生成音效路径卡片，标题和说明统一走 i18n。
    // Render one pet-animation state sound-path card, with title and description resolved through i18n.
    const labelKey = `settings.petStatus.events.${stateId}.label`;
    const helpKey = `settings.petStatus.events.${stateId}.help`;
    const pathKey = `petEventSoundPaths:${stateId}`;
    const volumeKey = `petEventSoundVolumes:${stateId}`;
    const escapedStateId = i18n.escapeHtml(stateId);
    const maxPathLength = Number(settings.maxPetEventSoundPathLength) || 1000;
    const minVolume = String(Number(settings.minPetEventSoundVolume) || 0);
    const maxVolume = String(Number(settings.maxPetEventSoundVolume) || 100);
    const previewParams = { label: i18n.t(labelKey) };
    return `
      <section class="codex-pro-cloud-sync-feature-block codex-pro-pet-status-event-card" data-codex-pro-pet-event-sound-card="${escapedStateId}">
        <div class="codex-pro-cloud-sync-feature-heading">
          <span class="codex-pro-cloud-sync-feature-title">${i18n.html(labelKey)}</span>
          <span class="codex-pro-cloud-sync-feature-note">${i18n.html(helpKey)}</span>
        </div>
        <div class="codex-pro-cloud-sync-feature-body">
          <div class="codex-pro-settings-field codex-pro-settings-field-stack" data-codex-pro-setting-key="${pathKey}">
            <span class="codex-pro-settings-copy">
              <span class="codex-pro-settings-label">${i18n.html("settings.petStatus.path.label")}</span>
              <span class="codex-pro-settings-help">${i18n.html("settings.petStatus.path.help")}</span>
            </span>
            <span class="codex-pro-pet-status-sound-row">
              <input class="codex-pro-settings-input codex-pro-settings-path-input" name="petEventSoundPath_${escapedStateId}" type="text" maxlength="${String(maxPathLength)}" autocomplete="off" spellcheck="false" placeholder="${i18n.attr("settings.petStatus.path.placeholder")}" data-codex-pro-pet-event-sound-path="${escapedStateId}">
              <span class="codex-pro-pet-status-volume-field" data-codex-pro-setting-key="${volumeKey}">
                <input class="codex-pro-settings-input codex-pro-pet-status-volume-input" name="petEventSoundVolume_${escapedStateId}" type="number" min="${minVolume}" max="${maxVolume}" step="1" inputmode="numeric" title="${i18n.attr("settings.petStatus.volume.title", previewParams)}" aria-label="${i18n.attr("settings.petStatus.volume.aria", previewParams)}" data-codex-pro-pet-event-sound-volume="${escapedStateId}">
              </span>
              <button class="codex-pro-settings-icon-action codex-pro-pet-status-preview-button" type="button" title="${i18n.attr("settings.petStatus.preview.title", previewParams)}" aria-label="${i18n.attr("settings.petStatus.preview.aria", previewParams)}" data-codex-pro-pet-event-sound-preview="${escapedStateId}">${playIcon}</button>
            </span>
          </div>
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

  function readPetEventSoundVolumes(settings, inputs) {
    // 这一段从固定事件音量输入读取草稿，保存前仍交给 settings 模块统一压缩默认值。
    // Read volume drafts from fixed event inputs while leaving default-value compaction to the settings model.
    const volumes = {};
    for (const input of inputs) {
      const stateId = input.getAttribute("data-codex-pro-pet-event-sound-volume");
      volumes[stateId] = normalizePetEventSoundVolume(settings, input.value);
    }
    return volumes;
  }

  function writePetEventSoundVolumes(settings, inputs, volumes) {
    // 这一段把已保存音量写回每个事件输入框，缺失状态回到默认满音量。
    // Write saved volumes back to each event input, falling back to full volume for missing states.
    const defaultVolume = getDefaultPetEventSoundVolume(settings);
    for (const input of inputs) {
      const stateId = input.getAttribute("data-codex-pro-pet-event-sound-volume");
      input.value = String(volumes?.[stateId] ?? defaultVolume);
    }
  }

  function setPetEventSoundControlsDisabled(pathInputs, volumeInputs, previewButtons, isDisabled) {
    // 这一段同步每个路径、音量和试听按钮的禁用状态，让总开关关闭后事件卡片不可编辑。
    // Sync disabled state for paths, volumes, and preview buttons so cards become read-only when the master switch is off.
    for (const input of [...pathInputs, ...volumeInputs]) {
      input.disabled = isDisabled;
      const field = input.closest?.(".codex-pro-settings-field");
      if (!field) continue;
      field.dataset.codexProDisabled = String(isDisabled);
      field.setAttribute("aria-disabled", String(isDisabled));
    }
    for (const button of previewButtons) {
      button.disabled = isDisabled;
    }
  }

  async function previewPetEventSound(button, stateId, volumeInput, saveAndRefreshSettings) {
    // 这一段先保存当前草稿再通过 stateId 播放，避免把任意页面路径直接传给 native bridge。
    // Save the current draft before stateId playback so arbitrary page paths are not passed directly to the native bridge.
    const petEventSounds = runtime.systemModules.petEventSounds;
    if (typeof petEventSounds?.previewState !== "function") return;
    button.disabled = true;
    button.dataset.codexProPetSoundPreviewing = "true";
    try {
      saveAndRefreshSettings();
      const volume = Number(volumeInput?.value);
      await petEventSounds.previewState(stateId, { volume });
    } finally {
      button.dataset.codexProPetSoundPreviewing = "false";
      button.disabled = false;
    }
  }

  settingsMenu.registerSection({
    fieldDependencies: {},
    icon,
    id: "pet-status",
    labelKey: "settings.petStatus.label",
    noteKey: "settings.petStatus.note",
    order: 92,
    settingKeys: ["enablePetEventSounds", "petEventSoundCooldownMs", "petEventSoundPaths", "petEventSoundVolumes"],
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
        saveAndRefreshSettings,
        settings,
        signal,
      } = context;
      const enableInput = form?.elements?.enablePetEventSounds;
      const pathInputs = Array.from(root.querySelectorAll("[data-codex-pro-pet-event-sound-path]"));
      const volumeInputs = Array.from(root.querySelectorAll("[data-codex-pro-pet-event-sound-volume]"));
      const previewButtons = Array.from(root.querySelectorAll("[data-codex-pro-pet-event-sound-preview]"));
      if (
        pathInputs.length !== settings.petEventSoundStateIds.length ||
        volumeInputs.length !== settings.petEventSoundStateIds.length ||
        previewButtons.length !== settings.petEventSoundStateIds.length
      ) return;

      addDraftSettingsReader(() => ({
        petEventSoundPaths: readPetEventSoundPaths(pathInputs),
        petEventSoundVolumes: readPetEventSoundVolumes(settings, volumeInputs),
      }));
      addSettingsWriter((currentSettings) => {
        writePetEventSoundPaths(pathInputs, currentSettings.petEventSoundPaths);
        writePetEventSoundVolumes(settings, volumeInputs, currentSettings.petEventSoundVolumes);
      });
      addModifiedStateRenderer(() => {
        setPetEventSoundControlsDisabled(pathInputs, volumeInputs, previewButtons, !enableInput?.checked);
      });

      for (const input of [...pathInputs, ...volumeInputs]) {
        input.addEventListener("input", () => {
          // 这一段在路径或音量输入时立即刷新修改标记，让每个事件卡片能显示自己的蓝点。
          // Refresh modified markers while typing paths or volumes so each event card can show its own dirty state.
          renderModifiedState();
        }, { signal });
      }
      for (const button of previewButtons) {
        button.addEventListener("click", () => {
          // 这一段从按钮状态 id 定位对应音量输入，试听失败时保持设置页可继续编辑。
          // Locate the paired volume input by button state id and keep the settings page editable if preview fails.
          const stateId = button.getAttribute("data-codex-pro-pet-event-sound-preview");
          const volumeInput = volumeInputs.find((input) => input.getAttribute("data-codex-pro-pet-event-sound-volume") === stateId);
          previewPetEventSound(button, stateId, volumeInput, saveAndRefreshSettings).catch(() => {});
        }, { signal });
      }
    },
  });
})();
