(() => {
  const runtime = window.__codexProRuntime;
  if (!runtime) return;
  const settingsMenu = runtime.systemModules.settingsMenu ??= {};
  const i18n = runtime.i18n;
  if (!settingsMenu.registerCloudSyncBlock) return;

  function formatCloudSyncTime(value) {
    // 这一段把 ISO 同步时间压缩成本机短时间，避免状态栏文字过长。
    // Format ISO sync timestamps into short local time so the status line stays compact.
    const timestamp = Date.parse(value || "");
    if (!Number.isFinite(timestamp)) return "";
    return i18n.formatDateTime(timestamp);
  }

  function getPetSyncSavedMetadata(data, fallbackSettings) {
    // 这一段从宠物同步响应里提取本机同步元数据，响应缺项时保留当前记录。
    // Extract local pet-sync metadata from responses, preserving current values when fields are missing.
    const revision = Number(data?.revision);
    return {
      petSyncLastSyncAt: data?.updatedAt || new Date().toISOString(),
      petSyncRevision: Number.isFinite(revision) && revision >= 0
        ? Math.floor(revision)
        : fallbackSettings.petSyncRevision,
    };
  }

  function getPetSyncCountText(data) {
    // 这一段把后端返回的宠物数量压缩成短文案，避免状态栏出现未知字段。
    // Convert the backend pet count into compact copy so unknown fields do not leak into the status line.
    const petCount = Number(data?.petCount);
    return Number.isFinite(petCount) && petCount >= 0
      ? i18n.t("settings.petSync.petCount", { count: Math.floor(petCount) })
      : i18n.t("settings.petSync.petFallback");
  }

  settingsMenu.registerCloudSyncBlock({
    id: "pet-sync",
    noteKey: "settings.petSync.note",
    order: 20,
    settingKeys: [],
    titleKey: "settings.petSync.title",
    render() {
      // 这一段声明宠物同步配置和命令按钮，文件读写仍通过 native bridge 受控执行。
      // Declare pet-sync config and commands while file IO remains controlled through the native bridge.
      return `
        <div class="codex-pro-settings-field codex-pro-settings-field-stack">
          <span class="codex-pro-settings-copy">
            <span class="codex-pro-settings-label">${i18n.html("settings.petSync.manual.label")}</span>
            <span class="codex-pro-settings-help">${i18n.html("settings.petSync.manual.help")}</span>
          </span>
          <span class="codex-pro-settings-command-row">
            <button class="codex-pro-settings-action codex-pro-settings-action-primary" type="button" data-codex-pro-pet-sync-upload>${i18n.html("settings.petSync.upload")}</button>
            <button class="codex-pro-settings-action" type="button" data-codex-pro-pet-sync-download>${i18n.html("settings.petSync.download")}</button>
          </span>
          <span class="codex-pro-settings-status" data-codex-pro-pet-sync-status></span>
        </div>
      `;
    },
    bind(context) {
      const {
        addDraftSettingsReader,
        addSettingsWriter,
        form,
        renderModifiedState,
        root,
        saveAndRefreshSettings,
        settings,
        signal,
        writeSettingsToForm,
      } = context;
      const cloudSync = settingsMenu.cloudSync;
      const petSync = runtime.systemModules.petSync;
      const keyInput = form?.elements?.cloudSyncKey;
      const uploadButton = root.querySelector("[data-codex-pro-pet-sync-upload]");
      const downloadButton = root.querySelector("[data-codex-pro-pet-sync-download]");
      const status = root.querySelector("[data-codex-pro-pet-sync-status]");
      if (!uploadButton || !downloadButton || !status) return;

      let petSyncRevision = settings.defaultSettings.petSyncRevision;
      let petSyncLastSyncAt = settings.defaultSettings.petSyncLastSyncAt;
      let isPetSyncBusy = false;

      function getCurrentSyncLicenseGate() {
        // 这一段读取同一个云端同步密钥，宠物同步不维护第二把密钥。
        // Read the same cloud-sync key; pet sync does not maintain a second key.
        const currentSettings = settings.getSettings?.() || settings.defaultSettings || {};
        const syncKey = keyInput?.value ?? currentSettings.cloudSyncKey;
        return cloudSync?.getSyncLicenseGate?.(syncKey) || {
          canSync: Boolean(syncKey),
          message: i18n.t("sync.licenseStatus.required"),
          status: syncKey ? "unknown" : "missing",
          tone: syncKey ? "" : "error",
        };
      }

      function applyPetSyncAvailability() {
        // 这一段根据统一授权状态控制宠物同步按钮灰态。
        // Apply pet-sync button disabled state from the shared license gate.
        const gate = getCurrentSyncLicenseGate();
        const disabled = isPetSyncBusy || !gate.canSync;
        uploadButton.disabled = disabled;
        downloadButton.disabled = disabled;
        uploadButton.title = !gate.canSync ? gate.message : "";
        downloadButton.title = !gate.canSync ? gate.message : "";
      }

      function renderPetSyncStatus(message = "", tone = "") {
        // 这一段统一渲染宠物同步状态；没有临时消息时展示宠物资源云端版本。
        // Render pet-sync status consistently; without a transient message, show the pet-resource cloud revision.
        const gate = getCurrentSyncLicenseGate();
        if (!message && !gate.canSync) {
          status.textContent = "";
          status.dataset.codexProCloudSyncTone = "";
          status.hidden = true;
          applyPetSyncAvailability();
          return;
        }
        const lastSyncText = formatCloudSyncTime(petSyncLastSyncAt);
        status.textContent = message || (
          petSyncRevision > 0
            ? i18n.t("common.cloudVersion", {
              revision: petSyncRevision,
              time: lastSyncText ? i18n.t("common.timeSeparator", { time: lastSyncText }) : "",
            })
            : i18n.t("common.unsynced")
        );
        status.dataset.codexProCloudSyncTone = tone;
        status.hidden = false;
        applyPetSyncAvailability();
      }

      function setPetSyncBusy(isBusy, message = "", tone = "") {
        // 这一段在宠物资源同步期间锁住操作按钮，避免本机文件读写和云端请求交叉执行。
        // Lock pet-resource sync buttons during requests so local file IO and cloud requests do not overlap.
        isPetSyncBusy = isBusy;
        applyPetSyncAvailability();
        if (message) renderPetSyncStatus(message, tone);
      }

      function ensurePetSyncLicenseAvailable() {
        // 这一段在宠物同步前复用同一把授权状态，避免空密钥时还进入文件扫描。
        // Reuse the shared license state before pet sync so empty keys do not enter file scanning.
        const gate = getCurrentSyncLicenseGate();
        if (gate.canSync) return true;
        renderPetSyncStatus();
        return false;
      }

      function confirmPetSyncOverwrite() {
        // 这一段用共享页面内确认框处理远端宠物版本冲突，不再调用 window.confirm。
        // Resolve remote pet-version conflicts through the shared in-page confirm instead of window.confirm.
        return runtime.dialogs.confirm({
          cancelLabel: i18n.t("common.cancel"),
          confirmLabel: i18n.t("settings.petSync.confirmOverwriteAction"),
          message: i18n.t("settings.petSync.confirmOverwrite"),
          signal,
          title: i18n.t("settings.petSync.confirmOverwriteTitle"),
        });
      }

      async function pushSavedPetsToCloud(savedSettings, { force = false } = {}) {
        // 这一段上传已保存的本机宠物资源；force=true 时不带 baseRevision，用于确认覆盖云端。
        // Upload already-saved local pet resources; force=true omits baseRevision for confirmed cloud overwrite.
        const gate = cloudSync?.getSyncLicenseGate?.(savedSettings.cloudSyncKey);
        if (gate && !gate.canSync) {
          renderPetSyncStatus();
          return savedSettings;
        }
        if (!petSync?.pushPets) {
          renderPetSyncStatus(i18n.t("common.error.moduleMissingReinject", { module: i18n.t("settings.petSync.label") }), "error");
          return savedSettings;
        }
        setPetSyncBusy(true, i18n.t("settings.petSync.status.uploading"));
        try {
          const data = await petSync.pushPets({
            baseRevision: force ? undefined : savedSettings.petSyncRevision,
            endpoint: savedSettings.petSyncEndpoint,
            syncKey: savedSettings.cloudSyncKey,
          });
          const nextSettings = settings.saveSettings({
            ...savedSettings,
            ...getPetSyncSavedMetadata(data, savedSettings),
          });
          writeSettingsToForm(nextSettings);
          renderModifiedState();
          renderPetSyncStatus(i18n.t("settings.petSync.status.uploaded", { countText: getPetSyncCountText(data) }), "success");
          return nextSettings;
        } catch (error) {
          if (error?.conflict && !force) {
            renderPetSyncStatus(i18n.t("settings.petSync.status.remoteNewer"), "error");
            const shouldOverwrite = await confirmPetSyncOverwrite();
            if (shouldOverwrite) {
              return await pushSavedPetsToCloud(savedSettings, { force: true });
            }
            return savedSettings;
          }
          renderPetSyncStatus(error?.message || i18n.t("common.error.syncFailed", { name: i18n.t("settings.petSync.label") }), "error");
          return savedSettings;
        } finally {
          setPetSyncBusy(false);
        }
      }

      async function uploadPetResources() {
        // 这一段先保存表单里的同步地址和密钥，再让 native bridge 读取本机宠物包并上传。
        // Save the endpoint and key first, then let the native bridge read and upload local pet packages.
        if (!ensurePetSyncLicenseAvailable()) return;
        const savedSettings = saveAndRefreshSettings();
        await pushSavedPetsToCloud(savedSettings);
      }

      async function downloadPetResources() {
        // 这一段拉取云端宠物资源，由 native bridge 写入本机文件并返回轻量结果摘要。
        // Pull cloud pet resources; the native bridge writes local files and returns a small summary.
        if (!ensurePetSyncLicenseAvailable()) return;
        const draftSettings = saveAndRefreshSettings();
        if (!petSync?.pullPets) {
          renderPetSyncStatus(i18n.t("common.error.moduleMissingReinject", { module: i18n.t("settings.petSync.label") }), "error");
          return;
        }
        setPetSyncBusy(true, i18n.t("settings.petSync.status.downloading"));
        try {
          const data = await petSync.pullPets({
            endpoint: draftSettings.petSyncEndpoint,
            syncKey: draftSettings.cloudSyncKey,
          });
          if (!data.exists) {
            const nextSettings = settings.saveSettings({
              ...draftSettings,
              petSyncLastSyncAt: "",
              petSyncRevision: 0,
            });
            writeSettingsToForm(nextSettings);
            renderModifiedState();
            renderPetSyncStatus(i18n.t("settings.petSync.status.empty"), "success");
            return;
          }
          const nextSettings = settings.saveSettings({
            ...draftSettings,
            ...getPetSyncSavedMetadata(data, draftSettings),
          });
          writeSettingsToForm(nextSettings);
          renderModifiedState();
          renderPetSyncStatus(i18n.t("settings.petSync.status.downloaded", { countText: getPetSyncCountText(data) }), "success");
        } catch (error) {
          renderPetSyncStatus(error?.message || i18n.t("common.error.syncFailed", { name: i18n.t("settings.petSync.label") }), "error");
        } finally {
          setPetSyncBusy(false);
        }
      }

      addDraftSettingsReader(() => ({
        petSyncLastSyncAt,
        petSyncRevision,
      }));
      addSettingsWriter((currentSettings) => {
        petSyncLastSyncAt = currentSettings.petSyncLastSyncAt;
        petSyncRevision = currentSettings.petSyncRevision;
        renderPetSyncStatus();
      });

      keyInput?.addEventListener("input", () => {
        renderPetSyncStatus();
      }, { signal });
      if (cloudSync?.syncLicenseStatusEventName && typeof window.addEventListener === "function") {
        window.addEventListener(cloudSync.syncLicenseStatusEventName, () => {
          renderPetSyncStatus();
        }, { signal });
      }
      uploadButton.addEventListener("click", () => {
        void uploadPetResources();
      }, { signal });
      downloadButton.addEventListener("click", () => {
        void downloadPetResources();
      }, { signal });
      renderPetSyncStatus();
    },
  });
})();
