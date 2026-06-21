(() => {
  const runtime = window.__codexProRuntime;
  if (!runtime) return;
  const settingsMenu = runtime.systemModules.settingsMenu ??= {};
  const i18n = runtime.i18n;
  if (!settingsMenu.registerSection) return;

  const icon = `
    <svg class="codex-pro-settings-section-icon" viewBox="0 0 24 24" aria-hidden="true" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round">
      <path d="M17.5 19H8a5 5 0 1 1 .9-9.92A7 7 0 0 1 22 12.5 4.5 4.5 0 0 1 17.5 19Z"></path>
      <path d="M12 13v5"></path>
      <path d="m9 16 3 3 3-3"></path>
    </svg>
  `;

  function formatCloudSyncTime(value) {
    // 这一段把 ISO 同步时间压缩成本机短时间，避免状态栏文字过长。
    // Format ISO sync timestamps into short local time so the status line stays compact.
    const timestamp = Date.parse(value || "");
    if (!Number.isFinite(timestamp)) return "";
    return i18n.formatDateTime(timestamp);
  }

  function formatSyncLicenseStatus(gate) {
    // 这一段优先展示同步密钥到期时间；没有到期字段时回退到授权状态文案。
    // Prefer the sync-key expiry time; fall back to the authorization status copy when expiry is unavailable.
    if (gate?.status === "authorized" && gate.expiresAt) {
      const expiresAtText = formatCloudSyncTime(gate.expiresAt);
      if (expiresAtText) {
        return i18n.t("sync.licenseStatus.expiresAt", { time: expiresAtText });
      }
    }
    return gate?.message || "";
  }

  function getCloudSyncSavedMetadata(data, fallbackSettings) {
    // 这一段从云端响应里提取本机同步元数据，响应缺项时保留当前记录。
    // Extract local sync metadata from cloud responses, preserving current values when fields are missing.
    const revision = Number(data?.revision);
    return {
      cloudSyncLastSyncAt: data?.updatedAt || new Date().toISOString(),
      cloudSyncRevision: Number.isFinite(revision) && revision >= 0
        ? Math.floor(revision)
        : fallbackSettings.cloudSyncRevision,
    };
  }

  const cloudSyncBlocks = settingsMenu.cloudSyncBlocks ??= [];

  function normalizeCloudSyncBlock(block) {
    // 这一段收敛云端同步子功能块定义，避免坏模块破坏整个设置页。
    // Normalize cloud-sync feature block definitions so a bad module cannot break the settings page.
    if (!block || typeof block !== "object") return null;
    const id = String(block.id || "").trim();
    if (!/^[a-z0-9-]+$/u.test(id) || typeof block.render !== "function") return null;
    return {
      bind: typeof block.bind === "function" ? block.bind : null,
      fieldDependencies: block.fieldDependencies && typeof block.fieldDependencies === "object" && !Array.isArray(block.fieldDependencies)
        ? block.fieldDependencies
        : null,
      gated: block.gated !== false,
      id,
      note: block.note || "",
      noteKey: block.noteKey || "",
      order: Number.isFinite(block.order) ? block.order : 0,
      render: block.render,
      settingKeys: Array.isArray(block.settingKeys) ? block.settingKeys.slice() : [],
      title: block.title || "",
      titleKey: block.titleKey || "",
    };
  }

  function registerCloudSyncBlock(block) {
    // 这一段把宠物、归档和同步侧栏注册成云端同步页内的子区块，而不是左侧独立分页。
    // Register pets, archive, and sidebar as blocks inside Cloud Sync instead of separate left-nav sections.
    const normalizedBlock = normalizeCloudSyncBlock(block);
    if (!normalizedBlock) return;
    const existingIndex = cloudSyncBlocks.findIndex((item) => item.id === normalizedBlock.id);
    if (existingIndex >= 0) {
      cloudSyncBlocks.splice(existingIndex, 1, normalizedBlock);
      return;
    }
    cloudSyncBlocks.push(normalizedBlock);
  }

  function getRegisteredCloudSyncBlocks() {
    // 这一段按声明顺序排序子区块，保证设置同步、宠物、归档、侧栏的阅读顺序稳定。
    // Sort feature blocks by declared order so settings, pets, archive, and sidebar stay stable.
    return cloudSyncBlocks
      .filter((block) => block && typeof block.id === "string" && typeof block.render === "function")
      .slice()
      .sort((left, right) => left.order - right.order || left.id.localeCompare(right.id));
  }

  function resolveBlockCopy({ value, key }) {
    // 这一段统一解析子区块标题和说明，支持 i18n key 和直接文本两种来源。
    // Resolve feature-block titles and notes from either i18n keys or direct text.
    if (key) return i18n.html(key);
    return i18n.escapeHtml(value || "");
  }

  function getCloudSyncSettingKeys() {
    // 这一段把所有子区块设置键归入“云端同步”左侧修改标记。
    // Fold all child block setting keys into the Cloud Sync modified marker.
    const keys = ["cloudSyncKey", "enableCloudSettingsSync"];
    for (const block of getRegisteredCloudSyncBlocks()) {
      keys.push(...block.settingKeys);
    }
    return Array.from(new Set(keys));
  }

  function getCloudSyncFieldDependencies() {
    // 这一段合并子区块字段依赖，让同步侧栏等区块仍能保持原有开关联动。
    // Merge child block field dependencies so blocks like the sync sidebar keep their existing control dependencies.
    const dependencies = {};
    for (const block of getRegisteredCloudSyncBlocks()) {
      if (!block.fieldDependencies) continue;
      Object.assign(dependencies, block.fieldDependencies);
    }
    return dependencies;
  }

  function renderCloudSyncFeatureBlock(block, settings) {
    // 这一段渲染云端同步页内的单个功能区块，用浅底色和分隔线强化边界。
    // Render one feature block inside Cloud Sync, using a subtle panel boundary for scanability.
    const title = resolveBlockCopy({ value: block.title, key: block.titleKey });
    const note = resolveBlockCopy({ value: block.note, key: block.noteKey });
    const gatedAttribute = block.gated ? " data-codex-pro-cloud-sync-gated-block" : "";
    return `
      <section class="codex-pro-cloud-sync-feature-block"${gatedAttribute} data-codex-pro-cloud-sync-feature-block="${i18n.escapeHtml(block.id)}">
        <div class="codex-pro-cloud-sync-feature-heading">
          <span class="codex-pro-cloud-sync-feature-title">${title}</span>
          ${note ? `<span class="codex-pro-cloud-sync-feature-note">${note}</span>` : ""}
        </div>
        <div class="codex-pro-cloud-sync-feature-body">
          ${block.render(settings)}
        </div>
      </section>
    `;
  }

  settingsMenu.registerCloudSyncBlock = registerCloudSyncBlock;

  settingsMenu.registerSection({
    icon,
    id: "cloud-sync",
    labelKey: "settings.cloudSync.label",
    noteKey: "settings.cloudSync.note",
    order: 50,
    get fieldDependencies() {
      return getCloudSyncFieldDependencies();
    },
    get settingKeys() {
      return getCloudSyncSettingKeys();
    },
    titleKey: "settings.cloudSync.title",
    render(settings) {
      // 这一段先声明同步密钥，再把所有云端同步相关功能按区块收拢到同一页。
      // Declare the sync key first, then collect every cloud-sync feature into one page.
      return `
        <label class="codex-pro-settings-field codex-pro-settings-field-stack" data-codex-pro-setting-key="cloudSyncKey">
          <span class="codex-pro-settings-copy">
            <span class="codex-pro-settings-label">${i18n.html("settings.cloudSync.key.label")}</span>
            <span class="codex-pro-settings-help">${i18n.html("settings.cloudSync.key.help")}</span>
          </span>
          <span class="codex-pro-settings-key-row" data-codex-pro-cloud-sync-key-row>
            <input class="codex-pro-settings-input codex-pro-settings-path-input" name="cloudSyncKey" type="password" maxlength="${settings.maxCloudSyncKeyLength}" autocomplete="off" spellcheck="false" placeholder="${i18n.attr("settings.cloudSync.key.placeholder")}">
            <button class="codex-pro-settings-icon-action" type="button" aria-label="${i18n.attr("settings.cloudSync.key.validate")}" title="${i18n.attr("settings.cloudSync.key.validate")}" data-codex-pro-cloud-sync-validate-key>
              <svg viewBox="0 0 24 24" aria-hidden="true" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round">
                <path d="M9 10 4 15l5 5"></path>
                <path d="M20 4v7a4 4 0 0 1-4 4H4"></path>
              </svg>
            </button>
            <button class="codex-pro-settings-action" type="button" data-codex-pro-cloud-sync-get-key>${i18n.html("settings.cloudSync.key.get")}</button>
          </span>
          <span class="codex-pro-settings-status" data-codex-pro-cloud-sync-status></span>
        </label>
        <div class="codex-pro-cloud-sync-feature-list">
          ${renderCloudSyncFeatureBlock({
            gated: true,
            id: "settings-sync",
            noteKey: "settings.cloudSync.settingsBlock.note",
            render: () => `
              <label class="codex-pro-settings-field" data-codex-pro-setting-key="enableCloudSettingsSync">
                <span class="codex-pro-settings-copy">
                  <span class="codex-pro-settings-label">${i18n.html("settings.cloudSync.autoUpload.label")}</span>
                  <span class="codex-pro-settings-help">${i18n.html("settings.cloudSync.autoUpload.help")}</span>
                </span>
                <span class="codex-pro-settings-switch">
                  <input name="enableCloudSettingsSync" type="checkbox">
                  <span class="codex-pro-settings-switch-track" aria-hidden="true"></span>
                </span>
              </label>
              <div class="codex-pro-settings-field codex-pro-settings-field-stack">
                <span class="codex-pro-settings-copy">
                  <span class="codex-pro-settings-label">${i18n.html("settings.cloudSync.manual.label")}</span>
                  <span class="codex-pro-settings-help">${i18n.html("settings.cloudSync.manual.help")}</span>
                </span>
                <span class="codex-pro-settings-command-row">
                  <button class="codex-pro-settings-action codex-pro-settings-action-primary" type="button" data-codex-pro-cloud-sync-upload>${i18n.html("settings.cloudSync.upload")}</button>
                  <button class="codex-pro-settings-action" type="button" data-codex-pro-cloud-sync-download>${i18n.html("settings.cloudSync.download")}</button>
                </span>
              </div>
            `,
            titleKey: "settings.cloudSync.settingsBlock.title",
          }, settings)}
          ${getRegisteredCloudSyncBlocks().map((block) => renderCloudSyncFeatureBlock(block, settings)).join("")}
        </div>
      `;
    },
    bind(context) {
      const {
        addDialogOpenHandler,
        addDraftSettingsReader,
        addModifiedStateRenderer,
        addSettingsWriter,
        form,
        registerAfterSaveHandler,
        renderModifiedState,
        root,
        saveAndRefreshSettings,
        settings,
        signal,
        writeSettingsToForm,
      } = context;
      const cloudSync = settingsMenu.cloudSync;
      const keyInput = form?.elements?.cloudSyncKey;
      const getKeyButton = root.querySelector("[data-codex-pro-cloud-sync-get-key]");
      const validateKeyButton = root.querySelector("[data-codex-pro-cloud-sync-validate-key]");
      const uploadButton = root.querySelector("[data-codex-pro-cloud-sync-upload]");
      const downloadButton = root.querySelector("[data-codex-pro-cloud-sync-download]");
      const status = root.querySelector("[data-codex-pro-cloud-sync-status]");
      if (!cloudSync || !keyInput || !getKeyButton || !validateKeyButton || !uploadButton || !downloadButton || !status) return;

      let cloudSyncRevision = settings.defaultSettings.cloudSyncRevision;
      let cloudSyncLastSyncAt = settings.defaultSettings.cloudSyncLastSyncAt;
      let isCloudSyncBusy = false;
      let isSyncLicenseValidating = false;
      let syncLicenseValidationTimer = 0;
      let syncLicenseValidationToken = 0;

      function applyCloudSyncFeatureGate(gate = getCurrentSyncLicenseGate()) {
        // 这一段只把功能区块按授权状态临时灰掉，不写回或改动用户保存的开关值。
        // Temporarily gray feature blocks from the license gate without writing back or changing saved toggles.
        const isGateClosed = !gate.canSync;
        const fieldDependencies = getCloudSyncFieldDependencies();
        for (const block of root.querySelectorAll("[data-codex-pro-cloud-sync-gated-block]")) {
          block.dataset.codexProCloudSyncGateDisabled = String(isGateClosed);
          block.setAttribute("aria-disabled", String(isGateClosed));
          for (const element of block.querySelectorAll("button, input, select, textarea")) {
            const field = typeof element.closest === "function" ? element.closest("[data-codex-pro-setting-key]") : null;
            const fieldKey = field?.getAttribute("data-codex-pro-setting-key") || "";
            if (!isGateClosed && fieldKey && Object.hasOwn(fieldDependencies, fieldKey)) continue;
            element.disabled = isGateClosed;
            if (field) {
              field.dataset.codexProDisabled = String(isGateClosed);
              field.setAttribute("aria-disabled", String(isGateClosed));
            }
          }
        }
        if (!isGateClosed) {
          settingsMenu.formBinding?.applyFieldDependencyState?.({ form });
        }
      }

      function getCurrentSyncLicenseGate() {
        // 这一段读取当前输入框里的同步密钥状态，避免使用已过期的保存快照。
        // Read the current input's sync-key state instead of relying on a stale saved snapshot.
        const syncKey = typeof keyInput.value === "string" ? keyInput.value.trim() : "";
        return cloudSync.getSyncLicenseGate?.(syncKey) || {
          canSync: syncKey.length >= 16,
          expiresAt: "",
          message: syncKey.length >= 16 ? i18n.t("sync.licenseStatus.pending") : i18n.t("sync.licenseStatus.required"),
          status: syncKey.length >= 16 ? "unknown" : "missing",
          tone: syncKey.length >= 16 ? "" : "error",
        };
      }

      function applyCloudSyncAvailability() {
        // 这一段根据授权状态和忙碌状态统一控制手动同步按钮灰态。
        // Apply one disabled-state rule for manual sync buttons from license state and busy state.
        const gate = getCurrentSyncLicenseGate();
        applyCloudSyncFeatureGate(gate);
        const disabled = isCloudSyncBusy || !gate.canSync;
        uploadButton.disabled = disabled;
        downloadButton.disabled = disabled;
        validateKeyButton.disabled = Boolean(
          isCloudSyncBusy ||
          isSyncLicenseValidating ||
          typeof keyInput.value !== "string" ||
          keyInput.value.trim().length < 16 ||
          (typeof cloudSync.requestSyncLicenseValidation !== "function" && typeof cloudSync.validateSyncLicense !== "function")
        );
        validateKeyButton.title = isSyncLicenseValidating
          ? i18n.t("sync.licenseStatus.validating")
          : i18n.t("settings.cloudSync.key.validate");
        uploadButton.title = !gate.canSync ? gate.message : "";
        downloadButton.title = !gate.canSync ? gate.message : "";
      }

      function renderCloudSyncStatus(message = "", tone = "") {
        // 这一段统一渲染同步密钥状态；没有临时消息时展示授权到期时间或授权状态。
        // Render sync-key status consistently; without a transient message, show license expiry or authorization state.
        const gate = getCurrentSyncLicenseGate();
        if (!message) {
          status.textContent = formatSyncLicenseStatus(gate);
          status.dataset.codexProCloudSyncTone = gate.tone;
          applyCloudSyncAvailability();
          return;
        }
        status.textContent = message;
        status.dataset.codexProCloudSyncTone = tone;
        applyCloudSyncAvailability();
      }

      async function runSyncLicenseValidation({ force = false } = {}) {
        // 这一段执行当前输入框密钥的授权验证，手动按钮和自动验证都复用它。
        // Validate the current input's license key; both the manual button and automatic checks reuse this path.
        if (typeof window.clearTimeout === "function") window.clearTimeout(syncLicenseValidationTimer);
        syncLicenseValidationTimer = 0;
        syncLicenseValidationToken += 1;
        const validationToken = syncLicenseValidationToken;
        const syncKey = typeof keyInput.value === "string" ? keyInput.value.trim() : "";
        const draftSettings = settings.getSettings?.() || settings.defaultSettings || {};
        const requestValidation = typeof cloudSync.requestSyncLicenseValidation === "function"
          ? cloudSync.requestSyncLicenseValidation
          : cloudSync.validateSyncLicense;
        if (syncKey.length < 16 || typeof requestValidation !== "function") {
          isSyncLicenseValidating = false;
          renderCloudSyncStatus();
          return;
        }
        isSyncLicenseValidating = true;
        renderCloudSyncStatus(i18n.t("sync.licenseStatus.validating"));
        try {
          await requestValidation({
            endpoint: draftSettings.cloudSyncEndpoint,
            force,
            syncKey,
          });
          if (validationToken !== syncLicenseValidationToken || keyInput.value.trim() !== syncKey) return;
          renderCloudSyncStatus();
        } catch (error) {
          if (validationToken !== syncLicenseValidationToken || keyInput.value.trim() !== syncKey) return;
          renderCloudSyncStatus(error?.message || i18n.t("sync.licenseStatus.invalid"), "error");
        } finally {
          if (validationToken === syncLicenseValidationToken) {
            isSyncLicenseValidating = false;
            applyCloudSyncAvailability();
          }
        }
      }

      function scheduleSyncLicenseValidation({ delay = 650, force = false } = {}) {
        // 这一段在用户停止输入、打开设置页或恢复已保存密钥时安排一次授权验证。
        // Schedule one license validation after typing settles, the dialog opens, or a saved key is restored.
        if (typeof window.clearTimeout === "function") window.clearTimeout(syncLicenseValidationTimer);
        syncLicenseValidationToken += 1;
        const scheduledToken = syncLicenseValidationToken;
        const syncKey = typeof keyInput.value === "string" ? keyInput.value.trim() : "";
        if (syncKey.length < 16 || typeof window.setTimeout !== "function") {
          syncLicenseValidationTimer = 0;
          isSyncLicenseValidating = false;
          applyCloudSyncAvailability();
          return;
        }
        syncLicenseValidationTimer = window.setTimeout(() => {
          if (scheduledToken !== syncLicenseValidationToken) return;
          void runSyncLicenseValidation({ force });
        }, delay);
      }

      function setCloudSyncBusy(isBusy, message = "", tone = "") {
        // 这一段在同步请求期间锁住操作按钮，防止连续点击产生交叉上传或拉取。
        // Lock sync action buttons during requests so repeated clicks cannot create overlapping pushes or pulls.
        isCloudSyncBusy = isBusy;
        applyCloudSyncAvailability();
        getKeyButton.disabled = isBusy;
        if (message) renderCloudSyncStatus(message, tone);
      }

      function ensureCloudSyncLicenseAvailable() {
        // 这一段在请求前给空密钥或已知无效密钥直接提示，不进入保存和网络请求。
        // Stop before saving or networking when the key is empty or known-invalid.
        const gate = getCurrentSyncLicenseGate();
        if (gate.canSync) return true;
        renderCloudSyncStatus(gate.message, gate.tone);
        return false;
      }

      function showCloudSyncAutoFailure(message) {
        // 这一段用共享页面内对话框提示自动同步失败，避免浏览器原生 alert 被用户永久禁用。
        // Show auto-sync failures with the shared in-page dialog so native alert suppression cannot break prompts.
        return runtime.dialogs.alert({
          confirmLabel: i18n.t("common.confirm"),
          message: i18n.t("settings.cloudSync.autoFailed", { message }),
          signal,
          title: i18n.t("settings.cloudSync.autoFailedTitle"),
        });
      }

      function confirmCloudSyncOverwrite() {
        // 这一段用共享页面内确认框处理远端版本冲突，不再调用 window.confirm。
        // Resolve remote-version conflicts through the shared in-page confirm instead of window.confirm.
        return runtime.dialogs.confirm({
          cancelLabel: i18n.t("common.cancel"),
          confirmLabel: i18n.t("settings.cloudSync.confirmOverwriteAction"),
          message: i18n.t("settings.cloudSync.confirmOverwrite"),
          signal,
          title: i18n.t("settings.cloudSync.confirmOverwriteTitle"),
        });
      }

      async function pushSavedSettingsToCloud(savedSettings, { force = false, auto = false } = {}) {
        // 这一段上传已经保存的本机设置；force=true 时不带 baseRevision，用于用户确认覆盖云端。
        // Upload already-saved local settings; force=true omits baseRevision for user-confirmed overwrite.
        const gate = cloudSync.getSyncLicenseGate(savedSettings.cloudSyncKey);
        if (!gate.canSync) {
          renderCloudSyncStatus(gate.message, gate.tone);
          if (auto) await showCloudSyncAutoFailure(gate.message);
          return savedSettings;
        }
        setCloudSyncBusy(true, i18n.t("common.syncing.upload"));
        try {
          const data = await cloudSync.pushSettings({
            baseRevision: force ? undefined : savedSettings.cloudSyncRevision,
            endpoint: savedSettings.cloudSyncEndpoint,
            sourceSettings: savedSettings,
            syncKey: savedSettings.cloudSyncKey,
          });
          const nextSettings = settings.saveSettings({
            ...savedSettings,
            ...getCloudSyncSavedMetadata(data, savedSettings),
          });
          writeSettingsToForm(nextSettings);
          renderModifiedState();
          renderCloudSyncStatus(i18n.t("settings.cloudSync.status.uploaded"), "success");
          return nextSettings;
        } catch (error) {
          if (error?.conflict && !force) {
            renderCloudSyncStatus(i18n.t("settings.cloudSync.status.remoteNewer"), "error");
            const shouldOverwrite = await confirmCloudSyncOverwrite();
            if (shouldOverwrite) {
              return await pushSavedSettingsToCloud(savedSettings, { force: true, auto });
            }
            return savedSettings;
          }
          const errorMessage = error?.message || i18n.t("common.error.syncFailed", { name: i18n.t("settings.cloudSync.label") });
          renderCloudSyncStatus(errorMessage, "error");
          if (auto) await showCloudSyncAutoFailure(errorMessage);
          return savedSettings;
        } finally {
          setCloudSyncBusy(false);
        }
      }

      async function uploadCloudSettings() {
        // 这一段先保存当前表单草稿，再上传规范化后的安全白名单设置。
        // Save the current form draft first, then upload the normalized allow-listed settings.
        if (!ensureCloudSyncLicenseAvailable()) return;
        const savedSettings = saveAndRefreshSettings();
        await pushSavedSettingsToCloud(savedSettings);
      }

      async function downloadCloudSettings() {
        // 这一段拉取云端设置并通过 settings.saveSettings 合并，复用现有订阅和启停机制。
        // Pull cloud settings and merge through settings.saveSettings so existing subscribers and toggles are reused.
        if (!ensureCloudSyncLicenseAvailable()) return;
        const draftSettings = saveAndRefreshSettings();
        setCloudSyncBusy(true, i18n.t("common.syncing.download"));
        try {
          const data = await cloudSync.pullSettings({
            endpoint: draftSettings.cloudSyncEndpoint,
            syncKey: draftSettings.cloudSyncKey,
          });
          if (!data.exists) {
            const nextSettings = settings.saveSettings({
              ...draftSettings,
              cloudSyncLastSyncAt: "",
              cloudSyncRevision: 0,
            });
            writeSettingsToForm(nextSettings);
            renderModifiedState();
            renderCloudSyncStatus(i18n.t("settings.cloudSync.status.empty"), "success");
            return;
          }
          const nextSettings = settings.saveSettings({
            ...settings.getSettings(),
            ...data.settings,
            cloudSyncEndpoint: draftSettings.cloudSyncEndpoint,
            cloudSyncKey: draftSettings.cloudSyncKey,
            enableCloudSettingsSync: draftSettings.enableCloudSettingsSync,
            ...getCloudSyncSavedMetadata(data, draftSettings),
          });
          writeSettingsToForm(nextSettings);
          renderModifiedState();
          renderCloudSyncStatus(i18n.t("settings.cloudSync.status.downloaded"), "success");
        } catch (error) {
          renderCloudSyncStatus(error?.message || i18n.t("common.error.syncFailed", { name: i18n.t("settings.cloudSync.label") }), "error");
        } finally {
          setCloudSyncBusy(false);
        }
      }

      addDraftSettingsReader(() => ({
        cloudSyncLastSyncAt,
        cloudSyncRevision,
      }));
      addModifiedStateRenderer(() => {
        applyCloudSyncAvailability();
      });
      addSettingsWriter((currentSettings) => {
        cloudSyncLastSyncAt = currentSettings.cloudSyncLastSyncAt;
        cloudSyncRevision = currentSettings.cloudSyncRevision;
        if (keyInput.value !== currentSettings.cloudSyncKey) {
          cloudSync.resetSyncLicenseState?.(currentSettings.cloudSyncKey);
        }
        renderCloudSyncStatus();
      });
      registerAfterSaveHandler((savedSettings) => {
        // 这一段保留保存后自动上传行为，但让逻辑留在云端同步区块内。
        // Preserve auto-upload after save while keeping the behavior inside the cloud-sync section.
        const gate = cloudSync.getSyncLicenseGate(savedSettings.cloudSyncKey);
        if (savedSettings.enableCloudSettingsSync && gate.canSync) {
          void pushSavedSettingsToCloud(savedSettings, { auto: true });
        }
      });

      getKeyButton.addEventListener("click", () => {
        // 这一段打开固定获取密钥页面，不在本机继续生成未授权的随机同步密钥。
        // Open the fixed key acquisition page instead of generating an unlicensed local random sync key.
        if (cloudSync.openKeyAcquisitionPage()) {
          renderCloudSyncStatus(i18n.t("settings.cloudSync.status.openedKeyPage"), "success");
        }
      }, { signal });
      validateKeyButton.addEventListener("click", () => {
        // 这一段给已保存或刚输入的密钥提供手动重验入口，不需要用户删掉重填。
        // Provide a manual revalidation entry so users do not need to delete and retype a saved key.
        void runSyncLicenseValidation({ force: true });
      }, { signal });
      keyInput.addEventListener("input", () => {
        // 这一段只重置本轮授权状态，不把输入的密钥写入日志或其它模块。
        // Reset only the runtime license state; do not log or copy the entered key elsewhere.
        cloudSync.resetSyncLicenseState?.(keyInput.value);
        renderModifiedState();
        renderCloudSyncStatus();
        scheduleSyncLicenseValidation({ force: true });
      }, { signal });
      if (cloudSync.syncLicenseStatusEventName && typeof window.addEventListener === "function") {
        window.addEventListener(cloudSync.syncLicenseStatusEventName, () => {
          renderCloudSyncStatus();
        }, { signal });
      }
      uploadButton.addEventListener("click", () => {
        void uploadCloudSettings();
      }, { signal });
      downloadButton.addEventListener("click", () => {
        void downloadCloudSettings();
      }, { signal });
      addDialogOpenHandler?.(() => {
        scheduleSyncLicenseValidation({ delay: 0, force: true });
      });
      signal?.addEventListener?.("abort", () => {
        syncLicenseValidationToken += 1;
        if (typeof window.clearTimeout === "function") window.clearTimeout(syncLicenseValidationTimer);
        syncLicenseValidationTimer = 0;
      }, { once: true });
      renderCloudSyncStatus();
      scheduleSyncLicenseValidation({ force: false });
      for (const block of getRegisteredCloudSyncBlocks()) {
        try {
          block.bind?.(context);
        } catch (error) {
          console.warn("[Codex-Pro] cloud sync block bind failed", block.id, error);
        }
      }
    },
  });
})();
