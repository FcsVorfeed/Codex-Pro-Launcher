(() => {
  const runtime = window.__codexProRuntime;
  if (!runtime) return;
  const petSync = runtime.systemModules.petSync ??= {};
  const i18n = runtime.i18n;

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

  function createPetSyncError(message, status, data) {
    // 这一段把宠物同步失败统一成带状态码的错误，设置页只需要处理一种形态。
    // Normalize pet-sync failures into status-bearing errors so the settings UI handles one shape.
    const error = new Error(message);
    error.status = status;
    error.data = data;
    error.conflict = status === 409 || data?.conflict === true;
    return error;
  }

  function getDisplayResponseError(responseData, data, fallbackKey) {
    // 这一段避免把远端或 launcher 的原始错误文案直接透出到非中文 UI。
    // Avoid leaking raw remote or launcher error copy directly into non-Chinese UI.
    const messageKey = String(data?.messageKey || "").trim();
    if (messageKey) return i18n.t(messageKey, { detail: String(data?.messageDetail || "").trim() });
    const rawMessage = String(responseData?.error || data?.message || "").trim();
    if (rawMessage && i18n.resolveLocale() === "zh-CN") return rawMessage;
    return i18n.t(fallbackKey);
  }

  function normalizeEndpoint(endpoint) {
    // 这一段规范化请求地址；设置模块已做过保存校验，这里负责请求前兜底。
    // Normalize the request endpoint; settings already validates it and this guards before requests.
    const value = typeof endpoint === "string" ? endpoint.trim() : "";
    if (!value) throw createPetSyncError(i18n.t("settings.petSync.error.endpointRequired"), 0, null);
    return value;
  }

  function validateSyncKey(syncKey) {
    // 这一段复用设置同步密钥规则，但不把密钥写入日志或本地宠物文件。
    // Reuse the settings sync-key rules without logging the key or writing it into pet files.
    const value = typeof syncKey === "string" ? syncKey.trim() : "";
    const compactValue = value.replace(/[\s_-]+/g, "").toLowerCase();
    const hasSingleRepeatedChar = compactValue.length > 0 && /^(.)(\1)+$/.test(compactValue);
    if (value.length < 16) {
      throw createPetSyncError(i18n.t("sync.error.keyTooShort"), 0, null);
    }
    if (commonWeakSyncKeys.has(compactValue) || hasSingleRepeatedChar) {
      throw createPetSyncError(i18n.t("sync.error.weakKey"), 0, null);
    }
    return value;
  }

  function readResponseData(response) {
    // 这一段统一解析 native bridge 响应，保留冲突标记给设置页二次确认覆盖。
    // Normalize native bridge responses while preserving conflict flags for UI overwrite confirmation.
    const responseData = response && typeof response === "object" ? response : {};
    const data = responseData?.data || null;
    if (!responseData.ok) {
      throw createPetSyncError(getDisplayResponseError(responseData, data, "settings.petSync.error.requestFailed"), responseData?.status || 0, data);
    }
    return data || {};
  }

  async function requestPetSync({ action, endpoint, syncKey, baseRevision }) {
    // 这一段只给 launcher 发送小型控制请求，宠物文件读写和大资源上传都留在本机桥接层。
    // Send only a small control request to the launcher; file IO and large resource transfer stay in the native bridge.
    const bridge = runtime.nativeBridge;
    if (!bridge?.supportsPetSync?.() || typeof bridge.requestPetSync !== "function") {
      throw createPetSyncError(i18n.t("settings.petSync.error.launcherUnsupported"), 0, null);
    }
    const request = {
      action,
      endpoint: normalizeEndpoint(endpoint),
      syncKey: validateSyncKey(syncKey),
    };
    if (Number.isInteger(baseRevision) && baseRevision >= 0) {
      request.baseRevision = baseRevision;
    }
    try {
      const data = readResponseData(await bridge.requestPetSync(request));
      runtime.systemModules.settingsMenu?.cloudSync?.markSyncLicenseAuthorized?.(request.syncKey);
      return data;
    } catch (error) {
      runtime.systemModules.settingsMenu?.cloudSync?.markSyncLicenseInvalid?.(request.syncKey, error);
      throw error;
    }
  }

  function pullPets({ endpoint, syncKey }) {
    // 这一段拉取云端宠物包，由本机桥接层写入 ~/.codex/pets 和选中宠物配置。
    // Pull cloud pet packages and let the native bridge write ~/.codex/pets plus the selected avatar setting.
    return requestPetSync({ action: "pull", endpoint, syncKey });
  }

  function pushPets({ endpoint, syncKey, baseRevision }) {
    // 这一段上传本机自定义宠物包，页面侧不会读取 spritesheet 或 pet.json 内容。
    // Upload local custom pet packages without the page reading spritesheets or pet.json contents.
    return requestPetSync({ action: "push", baseRevision, endpoint, syncKey });
  }

  petSync.pullPets = pullPets;
  petSync.pushPets = pushPets;
})();
