(() => {
  const runtime = window.__codexProRuntime;
  if (!runtime) return;
  const conversationArchive = runtime.systemModules.conversationArchive ??= {};
  const i18n = runtime.i18n;

  const autoPushDelayMs = 12000;
  const autoPushIntervalMs = 10 * 60 * 1000;
  const conversationArchiveStatusEventName = "codex-pro:conversation-archive-status";
  let activePushPromise = null;
  const commonWeakSyncKeys = new Set([
    "0000000000000000",
    "1111111111111111",
    "1234567890123456",
    "1234567890abcdef",
    "abcdefghijklmnop",
    "codexprocodexpro",
    "passwordpassword",
    "qwertyuiopasdfgh",
  ]);

  function createArchiveError(message, status, data) {
    // 这一段把归档同步失败统一成带状态码的错误，设置页和后台自动同步共用同一种形态。
    // Normalize archive-sync failures into status-bearing errors shared by the settings UI and auto sync.
    const error = new Error(message);
    error.status = status;
    error.data = data;
    return error;
  }

  function emitConversationArchiveStatus(message, tone, kind, snapshot = null, progress = null) {
    // 这一段只广播同步阶段给同页面 UI，不携带会话正文、账号或本机路径。
    // Broadcast only sync phase to same-page UI, without conversation bodies, account data, or local paths.
    window.dispatchEvent(new CustomEvent(conversationArchiveStatusEventName, {
      detail: {
        kind,
        message,
        progress,
        snapshot,
        source: "auto",
        tone,
      },
    }));
  }

  function getDisplayResponseError(responseData, data, fallbackKey) {
    // 这一段避免把归档服务或 launcher 的原始错误文案直接透出到非中文 UI。
    // Avoid leaking raw archive-service or launcher error copy directly into non-Chinese UI.
    const messageKey = String(data?.messageKey || "").trim();
    if (messageKey) return i18n.t(messageKey, { detail: String(data?.messageDetail || "").trim() });
    const rawMessage = String(responseData?.error || data?.message || "").trim();
    if (rawMessage && i18n.resolveLocale() === "zh-CN") return rawMessage;
    return i18n.t(fallbackKey);
  }

  function normalizeEndpoint(endpoint) {
    // 这一段规范化归档服务地址；保存设置时已校验，这里只做请求前兜底。
    // Normalize the archive endpoint; saved settings validate it and this guards before requests.
    const value = typeof endpoint === "string" ? endpoint.trim() : "";
    if (!value) throw createArchiveError(i18n.t("settings.conversationArchive.error.endpointRequired"), 0, null);
    return value;
  }

  function validateSyncKey(syncKey) {
    // 这一段复用同步密钥强度规则，但不把密钥写入日志或对话归档。
    // Reuse sync-key strength rules without logging the key or writing it into archives.
    const value = typeof syncKey === "string" ? syncKey.trim() : "";
    const compactValue = value.replace(/[\s_-]+/g, "").toLowerCase();
    const hasSingleRepeatedChar = compactValue.length > 0 && /^(.)(\1)+$/.test(compactValue);
    if (value.length < 16) {
      throw createArchiveError(i18n.t("sync.error.keyTooShort"), 0, null);
    }
    if (commonWeakSyncKeys.has(compactValue) || hasSingleRepeatedChar) {
      throw createArchiveError(i18n.t("sync.error.weakKey"), 0, null);
    }
    return value;
  }

  function normalizeDisplayName(value, fallback) {
    // 这一段只保留短显示名，避免把换行或控制字符传给本机桥接层。
    // Keep display names short and free of control characters before sending them to the native bridge.
    const rawValue = typeof value === "string" ? value.replace(/[\0-\x1f]/gu, " ").trim() : "";
    return (rawValue || fallback).slice(0, 120);
  }

  function normalizeArchiveDeviceId(value) {
    // 这一段只接受归档同步生成的设备 ID，避免页面把任意路径片段传给本机桥接层。
    // Accept only archive-sync generated device IDs so the page cannot pass arbitrary path segments to the bridge.
    const deviceId = typeof value === "string" ? value.trim().slice(0, 96) : "";
    return /^device_[A-Za-z0-9._-]{1,96}$/u.test(deviceId) ? deviceId : "";
  }

  function normalizeArchiveThreadId(value) {
    // 这一段只接受 Codex 官方线程 ID，并去掉侧栏 data id 可能带的 local/remote 前缀。
    // Accept only Codex native thread IDs, stripping local/remote prefixes from sidebar data ids.
    const threadId = typeof value === "string"
      ? value.trim().replace(/^(?:local|remote):/iu, "").slice(0, 180)
      : "";
    if (!threadId || ["__proto__", "prototype", "constructor"].includes(threadId)) return "";
    return /^[A-Za-z0-9_.:-]{8,180}$/u.test(threadId) ? threadId : "";
  }

  function readResponseData(response) {
    // 这一段统一解析 native bridge 响应，把服务端错误转换成可展示错误。
    // Normalize native bridge responses and convert service errors into displayable errors.
    const responseData = response && typeof response === "object" ? response : {};
    const data = responseData?.data || null;
    if (!responseData.ok) {
      throw createArchiveError(getDisplayResponseError(responseData, data, "settings.conversationArchive.error.requestFailed"), responseData?.status || 0, data);
    }
    return data || {};
  }

  async function requestArchive({ action, endpoint, syncKey, deviceName, deviceId, profileName, path, threadId, force, onProgress }) {
    // 这一段只把小型控制字段发给 launcher；SQLite 读取、Markdown 导出和上传都留在本机侧。
    // Send only small control fields to the launcher; SQLite reads, Markdown export, and upload stay native-side.
    const bridge = runtime.nativeBridge;
    if (!bridge?.supportsConversationArchive?.() || typeof bridge.requestConversationArchive !== "function") {
      throw createArchiveError(i18n.t("settings.conversationArchive.error.launcherUnsupported"), 0, null);
    }
    if (action === "prepare-local-file") {
      const normalizedThreadId = normalizeArchiveThreadId(threadId);
      if (!normalizedThreadId) throw createArchiveError(i18n.t("nativeThreadDrag.error.invalidThread"), 0, null);
      return readResponseData(await bridge.requestConversationArchive({
        action,
        threadId: normalizedThreadId,
      }));
    }
    const request = {
      action,
      deviceName: normalizeDisplayName(deviceName, ""),
      endpoint: normalizeEndpoint(endpoint),
      profileName: normalizeDisplayName(profileName, "Default profile"),
      syncKey: validateSyncKey(syncKey),
    };
    if (typeof deviceId === "string" && deviceId) request.deviceId = normalizeArchiveDeviceId(deviceId);
    if (action === "delete-device" && !request.deviceId) {
      throw createArchiveError(i18n.t("syncSidebar.deleteDevice.error.invalidDevice"), 0, null);
    }
    if (typeof path === "string" && path) request.path = path;
    if (force === true) request.force = true;
    if (typeof onProgress === "function") request.onProgress = onProgress;
    try {
      const data = readResponseData(await bridge.requestConversationArchive(request));
      runtime.systemModules.settingsMenu?.cloudSync?.markSyncLicenseAuthorized?.(request.syncKey);
      return data;
    } catch (error) {
      runtime.systemModules.settingsMenu?.cloudSync?.markSyncLicenseInvalid?.(request.syncKey, error);
      throw error;
    }
  }

  function startLocalArchivePush({ endpoint, syncKey, deviceName, profileName, force = false, onProgress }) {
    // 这一段启动一轮真实 native 上传，并把 active 状态绑定到这一轮 promise。
    // Start one real native upload and bind the active state to that promise.
    const nextPushPromise = requestArchive({ action: "push", deviceName, endpoint, force, onProgress, profileName, syncKey });
    activePushPromise = nextPushPromise;
    return nextPushPromise.finally(() => {
      if (activePushPromise === nextPushPromise) activePushPromise = null;
    });
  }

  function pushLocalArchive({ endpoint, syncKey, deviceName, profileName, force = false, onProgress }) {
    // 这一段触发本机增量扫描和上传，页面侧不会读取任何会话正文。
    // Trigger native incremental scanning and upload without the page reading conversation bodies.
    if (activePushPromise) {
      if (force === true) {
        // 这一段让手动强制同步等待当前后台上传结束后重跑，避免先报 busy 再被自动同步改成成功。
        // Let manual force sync wait for the current background upload and rerun, avoiding busy-then-auto-success status races.
        const previousPushPromise = activePushPromise;
        const queuedPushPromise = previousPushPromise
          .catch(() => null)
          .then(() => startLocalArchivePush({ deviceName, endpoint, force, onProgress, profileName, syncKey }));
        activePushPromise = queuedPushPromise;
        return queuedPushPromise.finally(() => {
          if (activePushPromise === queuedPushPromise) activePushPromise = null;
        });
      }
      throw createArchiveError(i18n.t("settings.conversationArchive.error.uploadBusy"), 0, null);
    }
    return startLocalArchivePush({ deviceName, endpoint, force, onProgress, profileName, syncKey });
  }

  function listArchive({ endpoint, syncKey, deviceName, profileName }) {
    // 这一段拉取远端归档索引，供设置页按设备和账号分组浏览。
    // Pull the remote archive index so the settings UI can browse by device and profile.
    return requestArchive({ action: "list", deviceName, endpoint, profileName, syncKey });
  }

  function resetRemoteArchive({ endpoint, syncKey, deviceName, profileName }) {
    // 这一段清空当前同步密钥下的远端归档，并让下一次同步从空索引全量重建。
    // Clear the remote archive for the current sync key and let the next sync rebuild from an empty index.
    return requestArchive({ action: "reset", deviceName, endpoint, profileName, syncKey });
  }

  function deleteRemoteDeviceArchive({ endpoint, syncKey, deviceName, deviceId, profileName }) {
    // 这一段清空当前同步密钥下的单个远端设备，失败时由侧栏决定是否仅本地隐藏。
    // Clear one remote device under the current sync key; the sidebar decides whether to hide locally on failure.
    return requestArchive({ action: "delete-device", deviceId, deviceName, endpoint, profileName, syncKey });
  }

  function getArchiveFile({ endpoint, syncKey, deviceName, profileName, path }) {
    // 这一段按远端归档路径读取会话包预览，不把它恢复成 Codex 原生会话。
    // Read one remote thread-package preview by archive path without restoring it as a native Codex thread.
    return requestArchive({ action: "get-file", deviceName, endpoint, path, profileName, syncKey });
  }

  function prepareArchiveFile({ endpoint, syncKey, deviceName, profileName, path }) {
    // 这一段请求 launcher 把远端会话包解压到受控本机临时目录，供原生右侧面板打开。
    // Ask the launcher to unpack the remote thread package into a controlled local temp directory for the native right-side panel.
    return requestArchive({ action: "prepare-file", deviceName, endpoint, path, profileName, syncKey });
  }

  function prepareLocalThreadArchiveFile({ threadId }) {
    // 这一段按官方 threadId 在本机导出临时 Markdown，不要求云同步密钥或远端归档路径。
    // Export a local temporary Markdown by native threadId without requiring a sync key or remote archive path.
    return requestArchive({ action: "prepare-local-file", threadId });
  }

  runtime.registerSystem("conversation-archive", () => {
    const settings = runtime.systemModules.settingsMenu?.settings;
    if (!settings?.getSettings || !settings?.subscribe) return;

    // 这一段创建自动归档生命周期；功能关闭或重复注入时会清掉计时器。
    // Create the auto-archive lifecycle; disabling the feature or reinjection clears timers.
    const controller = new AbortController();
    runtime.lifecycle.replaceController("conversation-archive", controller);
    let timeoutId = 0;
    let intervalId = 0;
    let isRunning = false;
    let latestSettings = settings.getSettings();

    function clearAutoPushTimers() {
      // 这一段集中清理自动同步计时器，避免设置切换后留下重复后台任务。
      // Clear auto-sync timers in one place so setting changes do not leave duplicate background work.
      window.clearTimeout(timeoutId);
      window.clearInterval(intervalId);
      timeoutId = 0;
      intervalId = 0;
    }

    async function runAutoPush() {
      // 这一段执行一次轻量自动同步；没有密钥或地址时安静跳过，不打扰主界面。
      // Run one lightweight auto sync; missing keys or endpoints are skipped quietly to avoid interrupting the UI.
      if (isRunning || activePushPromise) return;
      const currentSettings = latestSettings || settings.getSettings();
      if (!currentSettings.enableConversationArchiveSync || !currentSettings.cloudSyncKey || !currentSettings.conversationArchiveEndpoint) return;
      const gate = runtime.systemModules.settingsMenu?.cloudSync?.getSyncLicenseGate?.(currentSettings.cloudSyncKey);
      if (!gate?.canSync) return;
      isRunning = true;
      try {
        emitConversationArchiveStatus(i18n.t("syncSidebar.status.uploading"), "", "uploading");
        const data = await pushLocalArchive({
          deviceName: currentSettings.conversationArchiveDeviceName,
          endpoint: currentSettings.conversationArchiveEndpoint,
          onProgress: (progress) => {
            // 这一段把自动上传进度转发给左下角侧栏，只包含计数和速度等非正文指标。
            // Forward auto-upload progress to the lower-left sidebar with only counts and speed metrics.
            emitConversationArchiveStatus(i18n.t("syncSidebar.status.uploading"), "", "uploading", null, progress);
          },
          profileName: currentSettings.conversationArchiveProfileName,
          syncKey: currentSettings.cloudSyncKey,
        });
        emitConversationArchiveStatus(i18n.t("syncSidebar.status.autoUploaded"), "success", "success", data);
      } catch (error) {
        console.warn("[Codex-Pro] conversation archive auto sync failed", error?.message || error);
        emitConversationArchiveStatus(error?.message || i18n.t("syncSidebar.status.autoUploadFailed"), "error", "error");
      } finally {
        isRunning = false;
      }
    }

    function scheduleAutoPush(delayMs = autoPushDelayMs) {
      // 这一段把频繁设置变化合并成一次后台同步，避免保存后立刻重复扫描。
      // Coalesce frequent setting changes into one background sync to avoid repeated scans after saves.
      window.clearTimeout(timeoutId);
      timeoutId = window.setTimeout(() => {
        timeoutId = 0;
        void runAutoPush();
      }, delayMs);
    }

    function didAutoPushConfigChange(previousSettings, nextSettings) {
      // 这一段只把会影响自动上传输入的设置变更视为触发条件，revision 元数据保存不再重新排队上传。
      // Treat only settings that affect auto-upload inputs as triggers; revision metadata saves should not queue another upload.
      const fields = [
        "cloudSyncKey",
        "conversationArchiveDeviceName",
        "conversationArchiveEndpoint",
        "conversationArchiveProfileName",
        "enableConversationArchiveSync",
      ];
      return fields.some((field) => previousSettings?.[field] !== nextSettings?.[field]);
    }

    const unsubscribe = settings.subscribe((nextSettings) => {
      const previousSettings = latestSettings;
      latestSettings = nextSettings;
      if (didAutoPushConfigChange(previousSettings, nextSettings)) scheduleAutoPush();
    }, controller.signal);
    intervalId = window.setInterval(() => void runAutoPush(), autoPushIntervalMs);
    scheduleAutoPush();

    controller.signal.addEventListener(
      "abort",
      () => {
        clearAutoPushTimers();
        unsubscribe?.();
      },
      { once: true },
    );
  }, { enableSetting: "enableConversationArchiveSync" });

  conversationArchive.getArchiveFile = getArchiveFile;
  conversationArchive.deleteRemoteDeviceArchive = deleteRemoteDeviceArchive;
  conversationArchive.listArchive = listArchive;
  conversationArchive.prepareArchiveFile = prepareArchiveFile;
  conversationArchive.prepareLocalThreadArchiveFile = prepareLocalThreadArchiveFile;
  conversationArchive.pushLocalArchive = pushLocalArchive;
  conversationArchive.resetRemoteArchive = resetRemoteArchive;
})();
