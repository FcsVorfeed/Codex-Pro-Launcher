import { readFile } from "node:fs/promises";
import path from "node:path";

import {
  CdpClient,
  isAuxiliaryCodexPageTarget,
  listTargets,
  waitForTarget,
} from "./cdp-client.mjs";
import { buildInjectionModulePaths } from "./injection-manifest.mjs";
import { readLocalConfig } from "./local-config.mjs";
import { ensureNativeBridgeBinding } from "./native-bridge.mjs";
import { injectPetEventSoundOverlayTargets } from "./pet-event-sound-overlay-injection.mjs";
import { rootDir } from "./paths.mjs";

export async function inject(debugPort, timeoutMs, disabledSystems, nativeBridge) {
  // 这一段等待 Codex 页面目标，并读取当前注入模块源码。
  // Wait for the Codex page target and read the current injection module sources.
  const target = await waitForTarget(debugPort, timeoutMs);
  const script = await readInjectionScript(disabledSystems, nativeBridge);

  // 这一段连接 CDP 页面目标，准备执行注入命令。
  // Connect to the CDP page target before running injection commands.
  const client = new CdpClient(target.webSocketDebuggerUrl);
  await client.connect();
  try {
    await client.send("Runtime.enable");
    await ensureNativeBridgeBinding(client, nativeBridge);

    // 这一段注册新页面自动注入，并立即在当前页面执行一次。
    // Register injection for future documents and execute it immediately in the current page.
    await client.send("Page.addScriptToEvaluateOnNewDocument", { source: script });
    await client.send("Runtime.evaluate", {
      expression: script,
      awaitPromise: false,
      allowUnsafeEvalBlockedByCSP: true,
    });
    await cleanupAuxiliaryCodexTargets(debugPort, target.id);
    await injectPetEventSoundOverlayTargets(debugPort, target.id, disabledSystems);
  } catch (error) {
    client.close();
    throw error;
  }

  // 这一段返回目标和仍保持连接的客户端，供原生快捷键桥接继续监听。
  // Return the target and still-open client so the native shortcut bridge can keep listening.
  return { client, target };
}

async function cleanupAuxiliaryCodexTargets(debugPort, selectedTargetId) {
  // 这一段清理过去误注入到宠物悬浮窗里的 Codex-Pro DOM 和定时器。
  // Clean Codex-Pro DOM and timers that older injections may have placed in the avatar overlay.
  let targets = [];
  try {
    targets = (await listTargets(debugPort)).targets;
  } catch (error) {
    console.warn("[Codex-Pro] auxiliary target cleanup skipped", error?.message || error);
    return;
  }

  for (const target of targets.filter((item) => item.id !== selectedTargetId && isAuxiliaryCodexPageTarget(item))) {
    const auxiliaryClient = new CdpClient(target.webSocketDebuggerUrl);
    try {
      await auxiliaryClient.connect();
      await auxiliaryClient.send("Runtime.enable");
      await auxiliaryClient.send("Runtime.evaluate", {
        expression: `
          (() => {
            const runtime = window.__codexProRuntime;
            if (runtime?.controllers) {
              for (const controller of Object.values(runtime.controllers)) {
                try { controller?.abort?.(); } catch {}
              }
            }

            const ids = [
              "codex-pro-mvp-root",
              "codex-pro-mvp-style",
              "codex-pro-settings-root",
              "codex-pro-settings-style",
              "codex-pro-background-wallpaper-root",
              "codex-pro-background-wallpaper-style",
              "codex-pro-chat-width-resizer-handle",
              "codex-pro-chat-width-resizer-style",
              "codex-pro-font-override-style",
              "codex-pro-mouse-gesture-root",
              "codex-pro-mouse-gesture-style",
              "codex-pro-diff-hover-preview",
              "codex-pro-diff-hover-preview-style",
              "codex-pro-conversation-archive-sidebar-root",
              "codex-pro-conversation-archive-sidebar-panel",
              "codex-pro-conversation-archive-sidebar-style",
              "codex-pro-native-thread-drag-to-chat-ghost",
              "codex-pro-native-thread-drag-to-chat-style",
              "codex-pro-context-usage-inline-style"
            ];
            for (const id of ids) document.getElementById(id)?.remove();
            for (const node of document.querySelectorAll("[data-codex-pro-context-usage-inline]")) node.remove();
            window.__codexProRuntime = undefined;
          })();
        `,
        awaitPromise: false,
        allowUnsafeEvalBlockedByCSP: true,
      });
    } catch (error) {
      console.warn("[Codex-Pro] auxiliary target cleanup failed", target.url || target.id, error?.message || error);
    } finally {
      auxiliaryClient.close();
    }
  }
}

export async function readInjectionScript(disabledSystems, nativeBridge) {
  // 这一段按固定顺序读取注入模块，确保核心能力先于具体系统加载。
  // Read injection modules in a fixed order so core capabilities load before systems.
  const injectionModulePaths = buildInjectionModulePaths(disabledSystems);
  const localConfig = await readLocalConfig();
  const configModule = {
    relativePath: "codex-pro-runtime-config",
    source: [
      `window.__codexProHardDisabledSystems = ${JSON.stringify(disabledSystems)};`,
      `window.__codexProLocalConfig = ${JSON.stringify(localConfig)};`,
      nativeBridge
        ? [
          `window.__codexProNativeBridgeConfig = ${JSON.stringify(nativeBridge)};`,
          `window.__codexProNativeBridgeStatus = { bridgeId: ${JSON.stringify(nativeBridge.bridgeId)}, updatedAt: 0 };`,
        ].join("\n")
        : "window.__codexProNativeBridgeConfig = window.__codexProNativeBridgeConfig || null;",
    ].join("\n"),
  };
  const modules = await Promise.all(
    injectionModulePaths.map(async (parts) => {
      const filePath = path.join(rootDir, ...parts);
      const source = await readFile(filePath, "utf8");
      return {
        relativePath: parts.join("/"),
        source,
      };
    }),
  );

  // 这一段拼成单段脚本给 CDP 注入，避免浏览器页面直接 import 本地文件。
  // Join modules into one script for CDP injection so the browser page never imports local files.
  return [configModule, ...modules]
    .map(({ relativePath, source }) => `\n// Codex-Pro module: ${relativePath}\n${source}`)
    .join("\n");
}
