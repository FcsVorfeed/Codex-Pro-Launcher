import { readFile } from "node:fs/promises";
import path from "node:path";

import {
  CdpClient,
  isAuxiliaryCodexPageTarget,
  listTargets,
} from "./cdp-client.mjs";
import { buildPetEventSoundOverlayModulePaths } from "./injection-manifest.mjs";
import { readLocalConfig } from "./local-config.mjs";
import { rootDir } from "./paths.mjs";

const petEventSoundOverlayScanIntervalMs = 1500;

export async function readPetEventSoundOverlayScript(disabledSystems) {
  // 这一段读取宠物浮窗最小注入模块；禁用系统时返回空字符串。
  // Read the minimal pet-overlay injection modules; return an empty string when the system is disabled.
  const injectionModulePaths = buildPetEventSoundOverlayModulePaths(disabledSystems);
  if (!injectionModulePaths.length) return "";
  const localConfig = await readLocalConfig();
  const configModule = {
    relativePath: "codex-pro-pet-overlay-runtime-config",
    source: [
      `window.__codexProHardDisabledSystems = ${JSON.stringify(disabledSystems)};`,
      `window.__codexProLocalConfig = ${JSON.stringify(localConfig)};`,
      "window.__codexProNativeBridgeConfig = window.__codexProNativeBridgeConfig || null;",
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

  // 这一段拼成单段脚本给辅助窗口执行，保持和主注入相同的模块标记格式。
  // Join modules into one script for the auxiliary window, keeping the same module-marker format as main injection.
  return [configModule, ...modules]
    .map(({ relativePath, source }) => `\n// Codex-Pro module: ${relativePath}\n${source}`)
    .join("\n");
}

async function hasPetEventSoundOverlayRuntime(client) {
  // 这一段检查浮窗是否已经有宠物音效运行态，避免 watcher 重复执行同一 bundle。
  // Check whether the overlay already has the pet sound runtime so the watcher does not re-run the bundle.
  const response = await client.send("Runtime.evaluate", {
    allowUnsafeEvalBlockedByCSP: true,
    awaitPromise: true,
    expression: `
      (() => Boolean(
        window.__codexProRuntime?.systems?.some((system) => system?.name === "pet-event-sounds") &&
        window.__codexProRuntime?.systemStates?.["pet-event-sounds"]?.started === true &&
        window.__codexProPetEventSoundsOverlayMode === "main-window-playback-v1"
      ))()
    `,
    returnByValue: true,
  });
  return response?.result?.result?.value === true;
}

export async function injectPetEventSoundOverlayTarget(target, script) {
  // 这一段把最小宠物音效运行态注入单个辅助窗口，并在已有运行态时直接跳过。
  // Inject the minimal pet sound runtime into one auxiliary window and skip when it is already active.
  if (!script || !isAuxiliaryCodexPageTarget(target)) return false;
  const auxiliaryClient = new CdpClient(target.webSocketDebuggerUrl);
  try {
    await auxiliaryClient.connect();
    await auxiliaryClient.send("Runtime.enable");
    if (await hasPetEventSoundOverlayRuntime(auxiliaryClient)) return true;
    await auxiliaryClient.send("Page.addScriptToEvaluateOnNewDocument", { source: script });
    await auxiliaryClient.send("Runtime.evaluate", {
      expression: script,
      awaitPromise: false,
      allowUnsafeEvalBlockedByCSP: true,
    });
    return true;
  } finally {
    auxiliaryClient.close();
  }
}

export async function injectPetEventSoundOverlayTargets(debugPort, selectedTargetId, disabledSystems) {
  // 这一段一次性扫描并补注入当前已存在的宠物浮窗。
  // Scan once and inject pet overlays that already exist.
  const script = await readPetEventSoundOverlayScript(disabledSystems);
  if (!script) return;
  let targets = [];
  try {
    targets = (await listTargets(debugPort)).targets;
  } catch (error) {
    console.warn("[Codex-Pro] pet event sound overlay injection skipped", error?.message || error);
    return;
  }

  for (const target of targets.filter((item) => item.id !== selectedTargetId && isAuxiliaryCodexPageTarget(item))) {
    try {
      await injectPetEventSoundOverlayTarget(target, script);
    } catch (error) {
      console.warn("[Codex-Pro] pet event sound overlay injection failed", target.url || target.id, error?.message || error);
    }
  }
}

export function startPetEventSoundOverlayTargetWatcher(debugPort, selectedTargetId, disabledSystems, signal) {
  // 这一段在后台桥存活期间持续补注入晚创建的宠物浮窗，避免只扫描启动瞬间。
  // While the background bridge is alive, keep injecting pet overlays created after the initial scan.
  let stopped = false;
  let scanning = false;
  let scriptPromise = null;

  async function getScript() {
    // 这一段延迟读取浮窗 bundle，避免禁用系统或没有浮窗时做不必要文件读取。
    // Read the overlay bundle lazily so disabled systems or sessions without overlays avoid extra file IO.
    if (!scriptPromise) scriptPromise = readPetEventSoundOverlayScript(disabledSystems);
    return scriptPromise;
  }

  async function scan() {
    // 这一段串行执行 target 扫描，避免慢 CDP 连接造成重入和重复注入。
    // Run target scans serially so slow CDP connections do not cause reentry or duplicate injections.
    if (stopped || scanning) return;
    scanning = true;
    try {
      const script = await getScript();
      if (!script) return;
      const targets = (await listTargets(debugPort)).targets;
      for (const target of targets.filter((item) => item.id !== selectedTargetId && isAuxiliaryCodexPageTarget(item))) {
        // 这一段不能按 target id 记“已注入”；宠物关闭再打开时可能复用同一 target id，但页面运行态已经刷新。
        // Do not remember injection by target id; the pet overlay can reuse the same target id after reopening while its page runtime is fresh.
        if (stopped) continue;
        try {
          await injectPetEventSoundOverlayTarget(target, script);
        } catch (error) {
          console.warn("[Codex-Pro] pet event sound overlay watcher failed", target.url || target.id, error?.message || error);
        }
      }
    } catch (error) {
      console.warn("[Codex-Pro] pet event sound overlay watcher skipped", error?.message || error);
    } finally {
      scanning = false;
    }
  }

  const timerId = setInterval(() => {
    scan();
  }, petEventSoundOverlayScanIntervalMs);
  scan();
  signal?.addEventListener("abort", () => {
    stopped = true;
    clearInterval(timerId);
  }, { once: true });
  return () => {
    stopped = true;
    clearInterval(timerId);
  };
}
