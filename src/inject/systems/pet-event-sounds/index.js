(() => {
  const runtime = window.__codexProRuntime;
  if (!runtime?.registerSystem) return;

  const channelName = "codex-pro:pet-event-sounds:v1";
  const settingsStorageKey = "codex-pro:settings";
  const avatarStateSelector = ".codex-avatar-root[data-avatar-state]";
  const loadTimeoutMs = 10000;

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

  function getConfiguredSoundPath(settings, stateId) {
    // 这一段按状态 id 读取音效路径，总开关关闭或路径无效时返回空。
    // Read the sound path for a state id, returning empty when the master switch is off or the path is invalid.
    if (settings?.enablePetEventSounds !== true) return "";
    const paths = settings.petEventSoundPaths && typeof settings.petEventSoundPaths === "object"
      ? settings.petEventSoundPaths
      : {};
    return normalizeText(paths[stateId], 1000);
  }

  function normalizeConfiguredStateId(settings, value) {
    // 这一段只接受设置模型公开的官方状态 id，让跨窗口消息不能携带任意文件路径。
    // Accept only official state ids exposed by the settings model so cross-window messages cannot carry arbitrary paths.
    const stateId = normalizeText(value, 40);
    const stateIds = Array.isArray(settings.petEventSoundStateIds) ? settings.petEventSoundStateIds : [];
    return stateIds.includes(stateId) ? stateId : "";
  }

  function startMainCoordinator(signal) {
    // 这一段在主窗口接收浮窗的音频读取请求，并交给 native bridge 读取本机文件。
    // In the main window, receive overlay audio-load requests and delegate local file reads to the native bridge.
    const channel = openBroadcastChannel();
    if (!channel) return;
    signal.addEventListener("abort", () => channel.close(), { once: true });

    channel.addEventListener("message", async (event) => {
      // 这一段只处理浮窗发来的 load 请求，其它消息直接忽略。
      // Handle only load requests from the overlay and ignore every other message.
      const message = event?.data;
      if (!message || message.source !== "avatar" || message.kind !== "load-sound") return;
      const requestId = normalizeText(message.requestId, 80);
      const stateId = normalizeConfiguredStateId(getSettingsApi(), message.stateId);
      if (!requestId || !stateId) return;

      // 这一段重新读取当前设置并按状态 id 解析路径，避免旧消息在设置变更后继续读取文件。
      // Re-read current settings and resolve the path by state id so stale messages cannot keep reading files after settings change.
      const settings = getSettings();
      if (!getConfiguredSoundPath(settings, stateId) || typeof runtime.nativeBridge?.requestPetEventSound !== "function") {
        channel.postMessage({ error: "unavailable", kind: "sound-response", ok: false, requestId, source: "main" });
        return;
      }
      const response = await runtime.nativeBridge.requestPetEventSound({ stateId });
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

  function createAvatarAudioRuntime(channel, signal) {
    // 这一段建立浮窗侧音频运行态，缓存解码结果并按请求 id 管理跨页面回包。
    // Build the overlay audio runtime, caching decoded buffers and tracking cross-page responses by request id.
    const AudioContextConstructor = window.AudioContext || window.webkitAudioContext;
    const audioContext = AudioContextConstructor ? new AudioContextConstructor() : null;
    const audioBufferCache = new Map();
    const pendingRequests = new Map();
    const lastPlayedAtByState = new Map();

    function finishRequest(requestId, response) {
      // 这一段完成一个等待中的音频读取请求，并清理定时器，避免浮窗长时间运行时泄漏。
      // Finish one pending audio-load request and clear its timer to avoid leaks in the long-lived overlay.
      const pending = pendingRequests.get(requestId);
      if (!pending) return;
      window.clearTimeout(pending.timeoutId);
      pendingRequests.delete(requestId);
      pending.resolve(response);
    }

    function requestSoundData(stateId) {
      // 这一段向主窗口请求音频文件内容，超时后返回 null，避免状态监听链路被卡住。
      // Request audio file content from the main window and return null on timeout so state handling cannot hang.
      const requestId = crypto.randomUUID();
      return new Promise((resolve) => {
        const timeoutId = window.setTimeout(() => finishRequest(requestId, null), loadTimeoutMs);
        pendingRequests.set(requestId, { resolve, timeoutId });
        channel.postMessage({ kind: "load-sound", requestId, source: "avatar", stateId });
      });
    }

    async function loadAudioBuffer(path, stateId) {
      // 这一段按路径缓存解码 Promise，同一个文件多次触发时不会重复读取和解码。
      // Cache decoded promises by path so repeated triggers of the same file do not re-read or re-decode it.
      if (!audioContext) return null;
      if (audioBufferCache.has(path)) return audioBufferCache.get(path);
      const promise = (async () => {
        const response = await requestSoundData(stateId);
        if (!response?.ok || typeof response.base64 !== "string") return null;
        const arrayBuffer = base64ToArrayBuffer(response.base64);
        return audioContext.decodeAudioData(arrayBuffer);
      })();
      audioBufferCache.set(path, promise);
      promise.then((buffer) => {
        if (!buffer) audioBufferCache.delete(path);
      }).catch(() => {
        audioBufferCache.delete(path);
      });
      return promise;
    }

    async function playPathForState(path, stateId) {
      // 这一段执行实际播放：先应用冷却，再恢复 AudioContext，最后创建一次性 BufferSource。
      // Perform playback: apply cooldown, resume AudioContext, then create a one-shot BufferSource.
      if (!audioContext || signal.aborted) return;
      const settings = getSettings();
      const cooldownMs = Number(settings.petEventSoundCooldownMs) || 0;
      const now = Date.now();
      if (now - (lastPlayedAtByState.get(stateId) || 0) < cooldownMs) return;
      lastPlayedAtByState.set(stateId, now);
      const buffer = await loadAudioBuffer(path, stateId);
      if (!buffer || signal.aborted) return;
      await audioContext.resume?.();
      const source = audioContext.createBufferSource();
      source.buffer = buffer;
      source.connect(audioContext.destination);
      source.addEventListener("ended", () => {
        // 这一段在音效结束后断开节点，避免重复触发时保留无用音频节点。
        // Disconnect the node after playback so repeated triggers do not keep unused audio nodes alive.
        try {
          source.disconnect();
        } catch {}
      }, { once: true });
      source.start();
    }

    function handleStateTrigger(stateId) {
      // 这一段按当前设置决定某个状态是否播放音效，未配置路径时直接跳过。
      // Decide from current settings whether a state should play sound, skipping states without configured paths.
      const settings = getSettings();
      const path = getConfiguredSoundPath(settings, stateId);
      if (!path) return;
      playPathForState(path, stateId).catch(() => {});
    }

    channel.addEventListener("message", (event) => {
      // 这一段接收主窗口回传的音频读取结果，并只唤醒匹配 request id 的等待者。
      // Receive main-window audio-load responses and wake only the waiter with the matching request id.
      const message = event?.data;
      if (!message || message.source !== "main" || message.kind !== "sound-response") return;
      const requestId = normalizeText(message.requestId, 80);
      if (!requestId) return;
      finishRequest(requestId, message);
    }, { signal });
    window.addEventListener("storage", (event) => {
      // 这一段在主窗口保存设置后清掉已解码缓存，让同一路径替换音频文件也能重新读取。
      // Clear decoded cache after settings are saved in the main window so replacing a file at the same path can reload.
      if (event.key === settingsStorageKey) audioBufferCache.clear();
    }, { signal });

    signal.addEventListener("abort", () => {
      // 这一段关闭时释放等待请求和 AudioContext，避免重复注入后残留旧播放链路。
      // On shutdown, release pending requests and the AudioContext so reinjection does not leave stale playback paths.
      for (const [requestId] of pendingRequests) finishRequest(requestId, null);
      audioBufferCache.clear();
      audioContext?.close?.().catch?.(() => {});
    }, { once: true });

    return { handleStateTrigger };
  }

  function normalizeAvatarState(value, settings) {
    // 这一段只接受 settings 模块公开的官方状态 id，避免 DOM 被其它值污染后误触发。
    // Accept only official state ids exposed by the settings model so polluted DOM values cannot trigger playback.
    const stateId = normalizeText(value, 40);
    const stateIds = Array.isArray(settings.petEventSoundStateIds) ? settings.petEventSoundStateIds : [];
    return stateIds.includes(stateId) ? stateId : "";
  }

  function startAvatarObserver(signal) {
    // 这一段在宠物浮窗里观察官方 data-avatar-state，并把状态变化交给音频运行态。
    // In the pet overlay, observe the official data-avatar-state and hand state changes to the audio runtime.
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
    // 这一段为主窗口和宠物浮窗分别启动协调器或状态观察器，不让主窗口承担播放工作。
    // Start the coordinator or state observer by page role, keeping actual playback inside the pet overlay.
    const controller = new AbortController();
    runtime.lifecycle?.replaceController?.("pet-event-sounds", controller);
    if (isAvatarOverlayPage()) {
      startAvatarObserver(controller.signal);
    } else {
      startMainCoordinator(controller.signal);
    }
  });
})();
