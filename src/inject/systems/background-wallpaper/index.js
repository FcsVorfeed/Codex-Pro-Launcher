(() => {
  const runtime = window.__codexProRuntime;
  if (!runtime) return;

  const systemName = "background-wallpaper";
  const rootId = "codex-pro-background-wallpaper-root";
  const styleId = "codex-pro-background-wallpaper-style";
  const layerSelector = ".codex-pro-background-wallpaper-layer";

  function installStyles() {
    // 这一段安装全屏背景容器样式，层级低于 Codex-Pro 自己的设置和用量面板。
    // Install fullscreen wallpaper styles below Codex-Pro's own settings and usage panels.
    runtime.dom.upsertStyle(
      styleId,
      `
        #${rootId} {
          position: fixed;
          inset: 0;
          z-index: 2147482000;
          overflow: hidden;
          opacity: var(--codex-pro-background-wallpaper-opacity, .12);
          pointer-events: none;
          user-select: none;
          -webkit-user-select: none;
        }
        #${rootId}[hidden] {
          display: none;
        }
        #${rootId} ${layerSelector} {
          position: absolute;
          inset: 0;
          background-position: var(--codex-pro-background-wallpaper-position, center);
          background-repeat: no-repeat;
          background-size: var(--codex-pro-background-wallpaper-size, cover);
          opacity: 0;
          transition: opacity 700ms ease;
          will-change: opacity;
        }
        #${rootId} ${layerSelector}.codex-pro-background-wallpaper-active {
          opacity: 1;
        }
      `,
    );
  }

  function installRoot() {
    // 这一段复用固定根节点，避免重复注入时生成多个背景层。
    // Reuse a stable root node so reinjection does not create multiple wallpaper layers.
    const root = runtime.dom.ensureRoot(rootId);
    root.innerHTML = `
      <div class="codex-pro-background-wallpaper-layer" aria-hidden="true"></div>
      <div class="codex-pro-background-wallpaper-layer" aria-hidden="true"></div>
    `;
    return root;
  }

  function uninstall() {
    // 这一段移除背景 DOM 和样式，关闭系统后不留下任何覆盖层。
    // Remove the wallpaper DOM and stylesheet so disabling the system leaves no overlay.
    document.getElementById(rootId)?.remove();
    document.getElementById(styleId)?.remove();
  }

  function getImageUrls(settings) {
    // 这一段读取已经由设置模块校验过的图片 URL 列表，空列表表示不显示背景。
    // Read the image URLs already normalized by settings; an empty list means no wallpaper.
    return String(settings?.backgroundWallpaperImages || "")
      .split("\n")
      .map((url) => url.trim())
      .filter(Boolean);
  }

  function pickNextIndex(urls, currentIndex, shouldRandomize) {
    // 这一段根据随机开关选择下一张，随机模式下避免连续重复同一张。
    // Pick the next image from the random switch, avoiding immediate repeats in random mode.
    if (urls.length <= 0) return -1;
    if (urls.length === 1) return 0;
    if (!shouldRandomize) return (currentIndex + 1) % urls.length;

    let nextIndex = currentIndex;
    while (nextIndex === currentIndex) {
      nextIndex = Math.floor(Math.random() * urls.length);
    }
    return nextIndex;
  }

  function applyVisualSettings(root, settings) {
    // 这一段把可视参数写成 CSS 变量，避免每张图切换时重复改整段样式。
    // Write visual options as CSS variables so image switches do not rewrite the stylesheet.
    root.style.setProperty("--codex-pro-background-wallpaper-opacity", String(settings?.backgroundWallpaperOpacity ?? 0.12));
    root.style.setProperty("--codex-pro-background-wallpaper-position", settings?.backgroundWallpaperPosition || "center");
    root.style.setProperty("--codex-pro-background-wallpaper-size", settings?.backgroundWallpaperSize || "cover");
  }

  function clearLayers(root) {
    // 这一段清空两层背景，图片列表被清空或系统关闭时立即回到原生界面。
    // Clear both wallpaper layers so empty settings or disable returns to the native interface.
    for (const layer of root.querySelectorAll(layerSelector)) {
      layer.classList.remove("codex-pro-background-wallpaper-active");
      layer.style.backgroundImage = "";
    }
  }

  function waitForFrame(signal) {
    // 这一段等待一帧，让隐藏层先拿到新背景图，再开始透明度过渡。
    // Wait one frame so the hidden layer receives the new background before opacity transitions start.
    return new Promise((resolve, reject) => {
      const abortFrame = () => {
        window.cancelAnimationFrame(frameId);
        reject(new DOMException("Aborted", "AbortError"));
      };
      const frameId = window.requestAnimationFrame(() => {
        signal?.removeEventListener("abort", abortFrame);
        resolve();
      });
      signal?.addEventListener("abort", abortFrame, { once: true });
    });
  }

  function preloadImage(url, signal) {
    // 这一段先加载并解码下一张图片，避免旧图淡出后新图才突然完成绘制。
    // Load and decode the next image first so the old image does not fade out before the new one can paint.
    return new Promise((resolve, reject) => {
      if (signal?.aborted) {
        reject(new DOMException("Aborted", "AbortError"));
        return;
      }

      const image = new Image();
      const abortImage = () => {
        cleanup();
        image.src = "";
        reject(new DOMException("Aborted", "AbortError"));
      };
      const cleanup = () => {
        image.onload = null;
        image.onerror = null;
        signal?.removeEventListener("abort", abortImage);
      };
      const finish = () => {
        cleanup();
        const decodeResult = typeof image.decode === "function" ? image.decode() : Promise.resolve();
        decodeResult.then(resolve, resolve);
      };
      image.onload = finish;
      image.onerror = () => {
        cleanup();
        reject(new Error("背景图片加载失败"));
      };
      signal?.addEventListener("abort", abortImage, { once: true });
      image.decoding = "async";
      image.src = url;
    });
  }

  runtime.registerSystem(systemName, () => {
    const settingsApi = runtime.systemModules.settingsMenu?.settings;
    const controller = new AbortController();
    runtime.lifecycle.replaceController(systemName, controller);
    runtime.lifecycle.replaceWindowController("__codexProBackgroundWallpaperController", controller);

    installStyles();
    const root = installRoot();
    const layers = Array.from(root.querySelectorAll(layerSelector));
    let activeLayerIndex = 0;
    let carouselVersion = 0;
    let currentImageIndex = -1;
    let intervalId = 0;
    let isSwitching = false;
    let currentSettings = settingsApi?.getSettings?.() || {};

    async function showNextImage(urls, version) {
      // 这一段串行处理切换请求，避免慢网络下多个预加载同时改同一组图层。
      // Serialize switch requests so slow network loads cannot race over the same pair of layers.
      if (isSwitching || version !== carouselVersion) return;
      const nextImageIndex = pickNextIndex(urls, currentImageIndex, currentSettings.backgroundWallpaperRandom);
      if (nextImageIndex < 0 || !layers.length) return;
      isSwitching = true;

      try {
        // 这一段确认下一张图片已经可绘制，然后才启动旧图和新图的交叉淡入淡出。
        // Ensure the next image can paint before starting the crossfade between old and new layers.
        await preloadImage(urls[nextImageIndex], controller.signal);
        if (version !== carouselVersion || controller.signal.aborted) return;

        currentImageIndex = nextImageIndex;
        activeLayerIndex = (activeLayerIndex + 1) % layers.length;

        const activeLayer = layers[activeLayerIndex];
        const inactiveLayer = layers[(activeLayerIndex + 1) % layers.length];
        activeLayer.style.backgroundImage = `url(${JSON.stringify(urls[currentImageIndex])})`;
        await waitForFrame(controller.signal);
        if (version !== carouselVersion || controller.signal.aborted) return;
        activeLayer.classList.add("codex-pro-background-wallpaper-active");
        inactiveLayer?.classList.remove("codex-pro-background-wallpaper-active");
      } catch (error) {
        if (error?.name !== "AbortError") console.warn("[Codex-Pro] background wallpaper image skipped", error);
      } finally {
        isSwitching = false;
      }
    }

    function restartCarousel(nextSettings) {
      // 这一段按最新设置重建轮播定时器，保存设置后不需要刷新 Codex。
      // Rebuild the carousel timer from current settings so saving does not require a Codex reload.
      currentSettings = nextSettings || settingsApi?.getSettings?.() || {};
      const urls = getImageUrls(currentSettings);
      carouselVersion += 1;
      const version = carouselVersion;
      window.clearInterval(intervalId);
      intervalId = 0;
      applyVisualSettings(root, currentSettings);

      if (!urls.length || currentSettings.backgroundWallpaperOpacity <= 0) {
        root.hidden = true;
        currentImageIndex = -1;
        clearLayers(root);
        return;
      }

      root.hidden = false;
      if (currentImageIndex >= urls.length) currentImageIndex = -1;
      showNextImage(urls, version);

      if (urls.length > 1) {
        intervalId = window.setInterval(() => showNextImage(urls, version), currentSettings.backgroundWallpaperIntervalSeconds * 1000);
      }
    }

    const unsubscribeSettings = settingsApi?.subscribe?.(restartCarousel, controller.signal);

    // 这一段清理轮播定时器、订阅和 DOM，避免重复注入后多个轮播同时运行。
    // Clean up the carousel timer, subscription, and DOM so reinjection cannot leave duplicate carousels.
    controller.signal.addEventListener(
      "abort",
      () => {
        window.clearInterval(intervalId);
        unsubscribeSettings?.();
        uninstall();
      },
      { once: true },
    );

    restartCarousel(currentSettings);
  }, { enableSetting: "enableBackgroundWallpaper" });
})();
