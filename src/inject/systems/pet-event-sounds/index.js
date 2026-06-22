(() => {
  const runtime = window.__codexProRuntime;
  if (!runtime?.registerSystem) return;

  const channelName = "codex-pro:pet-event-sounds:v1";
  const settingsStorageKey = "codex-pro:settings";
  const avatarStateSelector = ".codex-avatar-root[data-avatar-state]";
  const overlayPlaybackMode = "main-window-playback-v1";
  const defaultSoundVolume = 100;

  function getSettingsApi() {
    // 这一段延迟读取设置 API，让主窗口和宠物浮窗复用同一个模块。
    // Read the settings API lazily so the main window and avatar overlay can share this module.
    return runtime.systemModules.settingsMenu?.settings || null;
  }

  function getSettings() {
    // 这一段获取规范化设置；缺失时回到空对象，避免浮窗页面因设置模块异常崩溃。
    // Get normalized settings, falling back to an empty object so the overlay does not crash if settings are missing.
    return getSettingsApi()?.getSettings?.() || {};
  }

  function normalizeText(value, maxLength) {
    // 这一段规范化跨页面传输的短文本，避免异常大字符串或控制字符进入后续流程。
    // Normalize short text passed across pages so oversized strings or control characters do not continue.
    const text = String(value || "").trim();
    if (!text || text.length > maxLength || /[\0\r\n]/u.test(text)) return "";
    return text;
  }

  function isAvatarOverlayPage() {
    // 这一段用官方 initialRoute 参数区分宠物浮窗，避免把主窗口误当成播放端。
    // Use the official initialRoute parameter to identify the pet overlay without mistaking the main window for it.
    try {
      return new URLSearchParams(window.location.search).get("initialRoute") === "/avatar-overlay";
    } catch {
      return false;
    }
  }

  function openBroadcastChannel() {
    // 这一段创建同源 BroadcastChannel；不支持时返回 null，让调用方安静禁用音效桥。
    // Create the same-origin BroadcastChannel; return null when unsupported so callers can disable the sound bridge quietly.
    if (typeof window.BroadcastChannel !== "function") return null;
    try {
      return new BroadcastChannel(channelName);
    } catch {
      return null;
    }
  }

  async function requestConfiguredSoundData(stateId) {
    // 这一段统一走 stateId 到本机路径的 native bridge 解析，不让页面层直接传文件路径。
    // Resolve local audio through the stateId native bridge path so page code never sends raw file paths directly.
    const settings = getSettings();
    if (!getConfiguredSoundPath(settings, stateId) || typeof runtime.nativeBridge?.requestPetEventSound !== "function") {
      return null;
    }
    return runtime.nativeBridge.requestPetEventSound({ stateId });
  }

  function getConfiguredSoundPath(settings, stateId) {
    // 这一段按状态 id 读取音效路径，总开关关闭或路径无效时返回空。
    // Read the sound path for a state id, returning empty when the master switch is off or the path is invalid.
    if (settings?.enablePetEventSounds !== true) return "";
    const paths = settings.petEventSoundPaths && typeof settings.petEventSoundPaths === "object"
      ? settings.petEventSoundPaths
      : {};
    return normalizeText(paths[stateId], 1000);
  }

  function normalizeSoundVolume(value) {
    // 这一段把设置或试听传入的音量统一限制到 0-100。
    // Clamp configured or preview-supplied volume values to 0-100.
    const number = Number(value);
    if (!Number.isFinite(number)) return defaultSoundVolume;
    return Math.round(Math.min(defaultSoundVolume, Math.max(0, number)));
  }

  function getConfiguredSoundVolume(settings, stateId, volumeOverride) {
    // 这一段读取状态专属音量；试听传入 override 时优先使用当前按钮旁的数值。
    // Read the state-specific volume; preview override wins so the adjacent input is honored immediately.
    if (volumeOverride !== undefined) return normalizeSoundVolume(volumeOverride);
    const volumes = settings.petEventSoundVolumes && typeof settings.petEventSoundVolumes === "object"
      ? settings.petEventSoundVolumes
      : {};
    return normalizeSoundVolume(volumes[stateId]);
  }

  function normalizeConfiguredStateId(settings, value) {
    // 这一段只接受设置模型公开的官方状态 id，让跨窗口消息不能携带任意文件路径。
    // Accept only official state ids exposed by the settings model so cross-window messages cannot carry arbitrary paths.
    const stateId = normalizeText(value, 40);
    const stateIds = Array.isArray(settings?.petEventSoundStateIds) ? settings.petEventSoundStateIds : [];
    return stateIds.includes(stateId) ? stateId : "";
  }

  function startMainCoordinator(signal) {
    // 这一段在主窗口提供设置页试听，并接收浮窗的音频读取请求。
    // In the main window, provide settings-page preview and receive overlay audio-load requests.
    const playbackRuntime = createAudioPlaybackRuntime(signal, requestConfiguredSoundData);
    const petEventSoundsModule = runtime.systemModules.petEventSounds ??= {};
    petEventSoundsModule.previewState = (stateId, options = {}) => {
      playbackRuntime.clearCache();
      return playbackRuntime.playState(stateId, { ignoreCooldown: true, volume: options.volume });
    };
    signal.addEventListener("abort", () => {
      if (petEventSoundsModule.previewState) delete petEventSoundsModule.previewState;
    }, { once: true });

    // 这一段只在支持 BroadcastChannel 时桥接宠物浮窗，设置页试听不依赖这个通道。
    // Bridge the pet overlay only when BroadcastChannel exists; settings preview does not depend on it.
    const channel = openBroadcastChannel();
    if (!channel) return;
    signal.addEventListener("abort", () => channel.close(), { once: true });

    channel.addEventListener("message", async (event) => {
      // 这一段只处理浮窗发来的 load 请求，其它消息直接忽略。
      // Handle only known overlay requests and ignore every other message.
      const message = event?.data;
      if (!message || message.source !== "avatar") return;
      const requestId = normalizeText(message.requestId, 80);
      const stateId = normalizeConfiguredStateId(getSettingsApi(), message.stateId);
      if (!stateId) return;

      if (message.kind === "play-state") {
        // 这一段让主窗口承担真实播放，避开宠物小窗未聚焦时 WebAudio 被用户手势策略拦截的问题。
        // Let the main window perform playback so the avatar overlay is not blocked by user-activation audio policy.
        playbackRuntime.playState(stateId).catch(() => {});
        return;
      }
      if (message.kind !== "load-sound" || !requestId) return;

      // 这一段重新读取当前设置并按状态 id 解析路径，避免旧消息在设置变更后继续读取文件。
      // Re-read current settings and resolve the path by state id so stale messages cannot keep reading files after settings change.
      const settings = getSettings();
      if (!getConfiguredSoundPath(settings, stateId) || typeof runtime.nativeBridge?.requestPetEventSound !== "function") {
        channel.postMessage({ error: "unavailable", kind: "sound-response", ok: false, requestId, source: "main" });
        return;
      }
      const response = await requestConfiguredSoundData(stateId);
      if (signal.aborted) return;
      channel.postMessage({
        bytes: Number(response?.bytes) || 0,
        error: response?.error || "",
        kind: "sound-response",
        mime: response?.mime || "",
        ok: response?.ok === true && typeof response?.base64 === "string",
        requestId,
        source: "main",
        base64: typeof response?.base64 === "string" ? response.base64 : "",
      });
    }, { signal });
  }

  function base64ToArrayBuffer(base64) {
    // 这一段把原生桥回传的 base64 音频解成 ArrayBuffer，供 WebAudio 解码缓存。
    // Convert base64 audio from the native bridge into an ArrayBuffer for WebAudio decoding and caching.
    const binary = window.atob(base64);
    const bytes = new Uint8Array(binary.length);
    for (let index = 0; index < binary.length; index += 1) {
      bytes[index] = binary.charCodeAt(index);
    }
    return bytes.buffer;
  }

  function createAudioPlaybackRuntime(signal, requestSoundData) {
    // 这一段建立共享音频播放运行态，让主窗口试听和浮窗事件播放复用缓存、冷却和音量逻辑。
    // Build a shared playback runtime so main-window preview and overlay event playback reuse cache, cooldown, and volume logic.
    const AudioContextConstructor = window.AudioContext || window.webkitAudioContext;
    let audioContext = null;
    const audioBufferCache = new Map();
    const lastPlayedAtByState = new Map();

    function getAudioContext() {
      // 这一段按需创建 AudioContext，避免未使用音效时提前占用音频资源。
      // Create the AudioContext lazily so unused sound settings do not reserve audio resources.
      if (!AudioContextConstructor || signal.aborted) return null;
      if (!audioContext) audioContext = new AudioContextConstructor();
      return audioContext;
    }

    async function loadAudioBuffer(path, stateId) {
      // 这一段按状态和路径缓存解码 Promise，路径变更后会自动形成新缓存键。
      // Cache decoded promises by state and path so path changes naturally produce a new cache key.
      const context = getAudioContext();
      if (!context) return null;
      const cacheKey = `${stateId}\n${path}`;
      if (audioBufferCache.has(cacheKey)) return audioBufferCache.get(cacheKey);
      const promise = (async () => {
        const response = await requestSoundData(stateId);
        if (!response?.ok || typeof response.base64 !== "string") return null;
        const arrayBuffer = base64ToArrayBuffer(response.base64);
        return context.decodeAudioData(arrayBuffer);
      })();
      audioBufferCache.set(cacheKey, promise);
      promise.then((buffer) => {
        if (!buffer) audioBufferCache.delete(cacheKey);
      }).catch(() => {
        audioBufferCache.delete(cacheKey);
      });
      return promise;
    }

    async function playState(stateId, options = {}) {
      // 这一段执行实际播放：解析设置、应用冷却、恢复 AudioContext，并用 GainNode 控制音量。
      // Perform playback by resolving settings, applying cooldown, resuming AudioContext, and using a GainNode for volume.
      const normalizedStateId = normalizeConfiguredStateId(getSettingsApi(), stateId);
      if (!normalizedStateId || signal.aborted) return false;
      const settings = getSettings();
      const path = getConfiguredSoundPath(settings, normalizedStateId);
      if (!path) return false;
      const volume = getConfiguredSoundVolume(settings, normalizedStateId, options.volume);
      if (volume <= 0) return false;
      const cooldownMs = Number(settings.petEventSoundCooldownMs) || 0;
      const now = Date.now();
      if (!options.ignoreCooldown && now - (lastPlayedAtByState.get(normalizedStateId) || 0) < cooldownMs) return false;
      lastPlayedAtByState.set(normalizedStateId, now);
      const context = getAudioContext();
      if (!context) return false;
      const buffer = await loadAudioBuffer(path, normalizedStateId);
      if (!buffer || signal.aborted) return false;
      await context.resume?.();
      const source = context.createBufferSource();
      const gain = context.createGain();
      source.buffer = buffer;
      gain.gain.value = volume / defaultSoundVolume;
      source.connect(gain);
      gain.connect(context.destination);
      source.addEventListener("ended", () => {
        // 这一段在音效结束后断开节点，避免重复触发时保留无用音频节点。
        // Disconnect nodes after playback so repeated triggers do not keep unused audio nodes alive.
        try {
          source.disconnect();
          gain.disconnect();
        } catch {}
      }, { once: true });
      source.start();
      return true;
    }

    window.addEventListener("storage", (event) => {
      // 这一段在主窗口保存设置后清掉已解码缓存，让同一路径替换音频文件也能重新读取。
      // Clear decoded cache after settings are saved in the main window so replacing a file at the same path can reload.
      if (event.key === settingsStorageKey) audioBufferCache.clear();
    }, { signal });

    signal.addEventListener("abort", () => {
      // 这一段关闭时释放解码缓存和 AudioContext，避免重复注入后残留旧播放链路。
      // On shutdown, release decoded buffers and the AudioContext so reinjection does not leave stale playback paths.
      audioBufferCache.clear();
      audioContext?.close?.().catch?.(() => {});
    }, { once: true });

    return {
      clearCache() {
        // 这一段给设置页试听提供显式清缓存入口，确保同一路径替换文件后能立刻重读。
        // Provide an explicit preview cache reset so replacing a file at the same path is heard immediately.
        audioBufferCache.clear();
      },
      playState,
    };
  }

  function createAvatarAudioRuntime(channel, signal) {
    // 这一段让宠物浮窗只上报状态事件，不在浮窗内创建 AudioContext，避免必须先点击宠物窗口。
    // Let the avatar overlay report state events only and avoid creating an AudioContext inside the unfocused overlay.
    return {
      handleStateTrigger(stateId) {
        // 这一段把状态变化交给主窗口播放；主窗口会重新读取设置并应用冷却和音量。
        // Hand the state change to the main window, which re-reads settings and applies cooldown and volume.
        channel.postMessage({ kind: "play-state", source: "avatar", stateId });
      },
    };
  }

  function normalizeAvatarState(value, settings) {
    // 这一段只接受 settings 模块公开的官方状态 id，避免 DOM 被其它值污染后误触发。
    // Accept only official state ids exposed by the settings model so polluted DOM values cannot trigger playback.
    const stateId = normalizeText(value, 40);
    const stateIds = Array.isArray(settings?.petEventSoundStateIds) ? settings.petEventSoundStateIds : [];
    return stateIds.includes(stateId) ? stateId : "";
  }

  function startAvatarObserver(signal) {
    // 这一段在宠物浮窗里观察官方 data-avatar-state，并把状态变化交给音频运行态。
    // In the pet overlay, observe the official data-avatar-state and hand state changes to the audio runtime.
    window.__codexProPetEventSoundsOverlayMode = overlayPlaybackMode;
    const channel = openBroadcastChannel();
    if (!channel) return;
    signal.addEventListener("abort", () => channel.close(), { once: true });
    const audioRuntime = createAvatarAudioRuntime(channel, signal);
    let stateObserver = null;
    let bodyObserver = null;
    let lastState = "";

    function attachAvatarRoot(root) {
      // 这一段绑定当前宠物根节点，初始状态只记录不播放，后续变化才视为事件。
      // Bind the current avatar root; record the initial state without playing, and treat later changes as events.
      if (!root || stateObserver || signal.aborted) return;
      lastState = normalizeAvatarState(root.getAttribute("data-avatar-state"), getSettingsApi());
      stateObserver = new MutationObserver(() => {
        const nextState = normalizeAvatarState(root.getAttribute("data-avatar-state"), getSettingsApi());
        if (!nextState || nextState === lastState) return;
        lastState = nextState;
        audioRuntime.handleStateTrigger(nextState);
      });
      stateObserver.observe(root, { attributeFilter: ["data-avatar-state"], attributes: true });
      bodyObserver?.disconnect();
      signal.addEventListener("abort", () => stateObserver?.disconnect(), { once: true });
    }

    // 这一段优先绑定已有根节点；如果官方浮窗稍后才渲染，再用 body 观察器补绑一次。
    // Prefer an existing root; if the official overlay renders later, use a body observer to bind once.
    attachAvatarRoot(document.querySelector(avatarStateSelector));
    if (!stateObserver) {
      const observerRoot = document.documentElement || document.body;
      if (!observerRoot) return;
      bodyObserver = new MutationObserver(() => attachAvatarRoot(document.querySelector(avatarStateSelector)));
      bodyObserver.observe(observerRoot, { childList: true, subtree: true });
      signal.addEventListener("abort", () => bodyObserver?.disconnect(), { once: true });
    }
  }

  runtime.registerSystem("pet-event-sounds", () => {
    // 这一段为主窗口和宠物浮窗分别启动协调器或状态观察器，实际播放由主窗口承担以避开浮窗音频激活限制。
    // Start the coordinator or state observer by page role, with actual playback in the main window to avoid overlay audio activation limits.
    const controller = new AbortController();
    runtime.lifecycle?.replaceController?.("pet-event-sounds", controller);
    if (isAvatarOverlayPage()) {
      startAvatarObserver(controller.signal);
    } else {
      startMainCoordinator(controller.signal);
    }
  });
})();
