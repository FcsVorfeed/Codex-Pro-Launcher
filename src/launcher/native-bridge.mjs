import { spawn, spawnSync } from "node:child_process";
import { appendFile, mkdir, readFile, unlink, writeFile } from "node:fs/promises";
import path from "node:path";

import { CdpClient, delay, waitForTarget } from "./cdp-client.mjs";
import { nativeBridgeStateDir } from "./native-bridge/common.mjs";
import {
  dispatchNativeBridgeRequest,
  parseNativeBridgeRequest,
} from "./native-bridge/router.mjs";
import { runNativeBridgeWorkerCleanup } from "./native-bridge/worker-cleanup.mjs";
import { startPetEventSoundOverlayTargetWatcher } from "./pet-event-sound-overlay-injection.mjs";
import { launcherPath, rootDir } from "./paths.mjs";

const nativeBridgeBindingName = "__codexProNativeBridge";
const nativeBridgeProtocolVersion = 71;
const nativeBridgeResponseEventName = "codex-pro:native-bridge-response";
const nativeBridgeMaxPayloadLength = 24_000;
const nativeBridgeHeartbeatMs = 2000;
const nativeBridgeMissingTargetExitMs = 120_000;
const nativeBridgeReconnectDelayMs = 1000;
const nativeBridgeStateHeartbeatMaxAgeMs = 12_000;
const nativeBridgeWorkerReadyTimeoutMs = 8_000;
const nativeBridgeWorkerTargetTimeoutMs = 5000;

export function createNativeBridgeConfig(enabled) {
  // 这一段为本次注入生成桥接配置；禁用时返回 null 让页面侧自动走降级逻辑。
  // Generate bridge config for this injection; return null when disabled so the page falls back automatically.
  if (!enabled) return null;
  const bridgeId = crypto.randomUUID();
  return {
    bindingName: `${nativeBridgeBindingName}_${bridgeId.replace(/-/g, "")}`,
    bridgeId,
    protocolVersion: nativeBridgeProtocolVersion,
  };
}

function nativeBridgeStatePath(debugPort) {
  // 这一段把调试端口映射到固定状态文件，用于复用同一 Codex 会话的后台桥。
  // Map the debugging port to a stable state file so one Codex session can reuse its background bridge.
  return path.join(nativeBridgeStateDir, `native-bridge-${debugPort}.json`);
}

function normalizeDisabledSystems(value) {
  // 这一段把 worker 载荷里的禁用系统列表规整成稳定数组，避免复用错误 watcher 配置。
  // Normalize disabled-system lists from worker payloads so watcher reuse cannot keep a stale configuration.
  if (!Array.isArray(value)) return [];
  return Array.from(new Set(value.map((item) => String(item || "").trim().toLowerCase()).filter(Boolean))).sort();
}

function areDisabledSystemsEqual(left, right) {
  // 这一段比较禁用系统列表，决定已有后台桥是否还能复用。
  // Compare disabled-system lists to decide whether an existing background bridge is still reusable.
  const leftSystems = normalizeDisabledSystems(left);
  const rightSystems = normalizeDisabledSystems(right);
  return leftSystems.length === rightSystems.length && leftSystems.every((item, index) => item === rightSystems[index]);
}

function isNativeBridgeConfig(value) {
  // 这一段校验状态文件里的桥接配置形状，避免损坏文件影响注入流程。
  // Validate bridge config shape from the state file so corrupted files do not affect injection.
  return (
    value &&
    typeof value === "object" &&
    typeof value.bindingName === "string" &&
    typeof value.bridgeId === "string" &&
    value.protocolVersion === nativeBridgeProtocolVersion &&
    value.bindingName.startsWith(`${nativeBridgeBindingName}_`)
  );
}

function isProcessAlive(pid) {
  // 这一段用系统进程表判断记录的 worker 是否还在，EPERM 也按“存在”处理。
  // Use the process table to check whether the recorded worker still exists; EPERM also means alive.
  if (!Number.isInteger(pid) || pid <= 0 || pid === process.pid) return false;
  try {
    process.kill(pid, 0);
    return true;
  } catch (error) {
    return error?.code === "EPERM";
  }
}

async function readNativeBridgeState(debugPort) {
  // 这一段读取后台桥状态文件，读取或解析失败都当作没有可复用桥。
  // Read the background bridge state file; read or parse failures mean no reusable bridge.
  try {
    const state = JSON.parse(await readFile(nativeBridgeStatePath(debugPort), "utf8"));
    const pid = Number(state?.pid);
    if (!Number.isInteger(pid) || !isNativeBridgeConfig(state?.nativeBridge)) return null;
    return {
      disabledSystems: normalizeDisabledSystems(state?.disabledSystems),
      nativeBridge: state.nativeBridge,
      pid,
      startedAt: typeof state.startedAt === "string" ? state.startedAt : "",
      workerHeartbeatAt: typeof state.workerHeartbeatAt === "string" ? state.workerHeartbeatAt : "",
    };
  } catch {
    return null;
  }
}

function isNativeBridgeStateHeartbeatFresh(state) {
  // 这一段要求状态文件有 worker 自己写入的新鲜心跳，避免复用只剩 pid 的陈旧记录。
  // Require a fresh heartbeat written by the worker itself so stale pid-only records are not reused.
  const heartbeatTime = Date.parse(state?.workerHeartbeatAt || "");
  return Number.isFinite(heartbeatTime) && Date.now() - heartbeatTime <= nativeBridgeStateHeartbeatMaxAgeMs;
}

async function isNativeBridgePageHeartbeatFresh(debugPort, nativeBridge) {
  // 这一段直接读取页面里的 worker 心跳；状态文件写入失败时仍能安全判断可复用性。
  // Read the worker heartbeat from the page directly so reuse remains safe when state-file writes fail.
  let client = null;
  try {
    const target = await waitForTarget(debugPort, nativeBridgeWorkerTargetTimeoutMs);
    client = new CdpClient(target.webSocketDebuggerUrl);
    await client.connect();
    const response = await client.send("Runtime.evaluate", {
      allowUnsafeEvalBlockedByCSP: true,
      awaitPromise: true,
      expression: `
        (() => {
          const config = window.__codexProNativeBridgeConfig;
          const status = window.__codexProNativeBridgeStatus;
          return Boolean(
            config &&
            status &&
            config.bridgeId === ${JSON.stringify(nativeBridge.bridgeId)} &&
            status.bridgeId === ${JSON.stringify(nativeBridge.bridgeId)} &&
            Number.isFinite(status.updatedAt) &&
            Date.now() - status.updatedAt <= ${nativeBridgeStateHeartbeatMaxAgeMs}
          );
        })()
      `,
      returnByValue: true,
    });
    return response?.result?.result?.value === true;
  } catch {
    return false;
  } finally {
    client?.close();
  }
}

async function clearNativeBridgeState(debugPort, bridgeId = "") {
  // 这一段只清理当前 bridgeId 对应的状态文件，避免新 worker 被旧 worker 误删记录。
  // Clear only the state file for the matching bridgeId so an old worker cannot remove a new worker record.
  const state = await readNativeBridgeState(debugPort);
  if (bridgeId && state?.nativeBridge?.bridgeId && state.nativeBridge.bridgeId !== bridgeId) return;
  try {
    await unlink(nativeBridgeStatePath(debugPort));
  } catch {
    // 这一段忽略文件已经不存在的情况，worker 退出路径必须保持无副作用。
    // Ignore already-missing files so worker shutdown remains side-effect free.
  }
}

async function writeNativeBridgeState(debugPort, nativeBridge, pid, state = {}) {
  // 这一段记录后台桥 pid 和 bridgeId，后续重新注入可以复用而不是重复启动 worker。
  // Record the background bridge pid and bridgeId so reinjection can reuse it instead of spawning duplicates.
  await mkdir(nativeBridgeStateDir, { recursive: true });
  await writeFile(
    nativeBridgeStatePath(debugPort),
    JSON.stringify({
      debugPort,
      disabledSystems: normalizeDisabledSystems(state.disabledSystems),
      nativeBridge,
      pid,
      startedAt: state.startedAt || new Date().toISOString(),
      workerHeartbeatAt: state.workerHeartbeatAt || "",
    }, null, 2),
    "utf8",
  );
}

async function writeNativeBridgeWorkerHeartbeat(debugPort, nativeBridge, disabledSystems) {
  // 这一段由 worker 会话写入状态心跳，只有真正接上 CDP 后才允许后续注入复用。
  // Let the worker session write a state heartbeat so later injections reuse only a real CDP-backed worker.
  const state = await readNativeBridgeState(debugPort);
  await writeNativeBridgeState(debugPort, nativeBridge, process.pid, {
    disabledSystems: state?.disabledSystems || disabledSystems,
    startedAt: state?.startedAt || new Date().toISOString(),
    workerHeartbeatAt: new Date().toISOString(),
  });
}

export async function getReusableNativeBridge(debugPort, disabledSystems = []) {
  // 这一段复用仍存活的后台桥；发现陈旧记录时顺手删除，避免状态文件残留。
  // Reuse a still-alive background bridge; remove stale records to avoid state-file residue.
  const state = await readNativeBridgeState(debugPort);
  if (!state) return null;
  if (!areDisabledSystemsEqual(state.disabledSystems, disabledSystems)) {
    await clearNativeBridgeState(debugPort, state.nativeBridge.bridgeId);
    return null;
  }
  if (
    isProcessAlive(state.pid) &&
    (isNativeBridgeStateHeartbeatFresh(state) || await isNativeBridgePageHeartbeatFresh(debugPort, state.nativeBridge))
  ) return state;
  await clearNativeBridgeState(debugPort, state.nativeBridge.bridgeId);
  return null;
}

export async function waitForNativeBridgeReady(debugPort, nativeBridge, timeoutMs = nativeBridgeWorkerReadyTimeoutMs) {
  // 这一段等待新启动 worker 写入首个心跳，和页面侧 updatedAt=0 的可用性门槛保持一致。
  // Wait for the new worker's first heartbeat so it matches the page-side updatedAt=0 availability gate.
  const deadline = Date.now() + Math.max(1000, Math.min(timeoutMs, nativeBridgeWorkerReadyTimeoutMs));
  while (Date.now() <= deadline) {
    const state = await readNativeBridgeState(debugPort);
    const stateMatchesBridge = state?.nativeBridge?.bridgeId === nativeBridge?.bridgeId;
    if (
      stateMatchesBridge &&
      isProcessAlive(state.pid) &&
      (isNativeBridgeStateHeartbeatFresh(state) || await isNativeBridgePageHeartbeatFresh(debugPort, nativeBridge))
    ) {
      return state;
    }
    await delay(250);
  }
  const state = await readNativeBridgeState(debugPort);
  if (state?.nativeBridge?.bridgeId === nativeBridge?.bridgeId && isProcessAlive(state.pid)) {
    stopNativeBridgeProcess(state.pid);
  }
  await clearNativeBridgeState(debugPort, nativeBridge?.bridgeId);
  return null;
}

function encodeNativeBridgeWorkerPayload(payload) {
  // 这一段把 worker 参数编码成单个命令行参数，避免 JSON 引号影响 Windows 命令行解析。
  // Encode worker options into one command-line argument so JSON quotes cannot disturb Windows parsing.
  return Buffer.from(JSON.stringify(payload), "utf8").toString("base64url");
}

export function decodeNativeBridgeWorkerPayload(value) {
  // 这一段解析内部 worker 参数，异常时抛出明确错误方便诊断。
  // Decode internal worker options and throw a clear error when they are malformed.
  try {
    const payload = JSON.parse(Buffer.from(value || "", "base64url").toString("utf8"));
    if (!Number.isFinite(payload?.debugPort) || !Number.isFinite(payload?.timeoutMs)) {
      throw new Error("missing debugPort or timeoutMs");
    }
    if (!isNativeBridgeConfig(payload?.nativeBridge)) {
      throw new Error("missing native bridge config");
    }
    return {
      ...payload,
      disabledSystems: normalizeDisabledSystems(payload.disabledSystems),
    };
  } catch (error) {
    throw new Error(`Invalid native bridge worker payload: ${error?.message || error}`);
  }
}

function quotePowerShellString(value) {
  // 这一段生成 PowerShell 单引号字符串，避免路径里的空格影响后台 worker 启动。
  // Create a PowerShell single-quoted string so spaces in paths do not affect worker launch.
  return `'${String(value).replace(/'/g, "''")}'`;
}

function quotePowerShellArray(values) {
  // 这一段生成 PowerShell 字符串数组，避免 Start-Process 单字符串参数重新拆分。
  // Build a PowerShell string array so Start-Process does not re-split one combined argument string.
  return `@(${values.map(quotePowerShellString).join(", ")})`;
}

function quoteWindowsCommandArgument(value) {
  // 这一段按 Windows 命令行规则转义参数，供 ShellExecute 的单字符串 Arguments 使用。
  // Escape one argument for Windows command-line parsing, used by ShellExecute's single Arguments string.
  const rawValue = String(value);
  if (!rawValue) return '""';
  if (!/[\s"]/u.test(rawValue)) return rawValue;
  return `"${rawValue.replace(/(\\*)"/g, '$1$1\\"').replace(/\\+$/u, "$&$&")}"`;
}

function startNativeBridgeWorkerWithShellExecute(payload) {
  // 这一段通过 Windows Shell 拉起 worker，避免受当前终端 job 生命周期影响。
  // Launch the worker through the Windows Shell so it is not tied to the current terminal job lifetime.
  const argumentList = ["--no-warnings", launcherPath, "--native-bridge-worker", payload]
    .map(quoteWindowsCommandArgument)
    .join(" ");
  const command = [
    "$shell = New-Object -ComObject Shell.Application",
    `$shell.ShellExecute(${quotePowerShellString(process.execPath)}, ${quotePowerShellString(argumentList)}, ${quotePowerShellString(rootDir)}, 'open', 0)`,
  ].join("; ");
  const result = spawnSync(
    "powershell.exe",
    ["-NoProfile", "-Command", command],
    { encoding: "utf8" },
  );
  if (result.status !== 0) {
    throw new Error((result.stderr || result.stdout || "Native bridge shell launch failed").trim());
  }
  return null;
}

function startNativeBridgeWorkerWithPowerShell(payload) {
  // 这一段通过 PowerShell 参数数组启动隐藏 worker，不使用重定向以免 Start-Process 等待子进程退出。
  // Start the hidden worker through a PowerShell argument array without redirection so Start-Process does not wait for the child.
  const workerArgumentList = quotePowerShellArray(["--no-warnings", launcherPath, "--native-bridge-worker", payload]);
  const command = [
    `$process = Start-Process -FilePath ${quotePowerShellString(process.execPath)} -ArgumentList ${workerArgumentList} -WorkingDirectory ${quotePowerShellString(rootDir)} -WindowStyle Hidden -PassThru`,
    "$process.Id",
  ].join("; ");
  const result = spawnSync(
    "powershell.exe",
    ["-NoProfile", "-Command", command],
    { encoding: "utf8" },
  );
  if (result.status !== 0) {
    throw new Error((result.stderr || result.stdout || "Native bridge worker start failed").trim());
  }
  return Number(result.stdout.trim()) || null;
}

function startNativeBridgeWorkerDetached(payload) {
  // 这一段选择当前平台稳定的后台启动方式，Windows 优先交给系统 Shell 脱离当前终端生命周期。
  // Choose the stable background launch path; Windows prefers the system Shell to escape the current terminal lifetime.
  if (process.platform === "win32") {
    try {
      return startNativeBridgeWorkerWithShellExecute(payload);
    } catch (error) {
      console.warn("[Codex-Pro] native bridge shell launch failed, falling back to Start-Process", error?.message || error);
      return startNativeBridgeWorkerWithPowerShell(payload);
    }
  }
  const child = spawn(process.execPath, [launcherPath, "--native-bridge-worker", payload], {
    cwd: rootDir,
    detached: true,
    stdio: "ignore",
    windowsHide: true,
  });
  child.unref();
  return child.pid || null;
}

export async function startNativeBridgeWorker(debugPort, timeoutMs, nativeBridge, disabledSystems = []) {
  // 这一段启动隐藏后台 worker，并记录 pid；worker 持有 CDP 连接，CMD 不需要继续停留。
  // Start a hidden background worker and record its pid; the worker owns CDP so CMD can exit.
  const normalizedDisabledSystems = normalizeDisabledSystems(disabledSystems);
  const payload = encodeNativeBridgeWorkerPayload({
    debugPort,
    disabledSystems: normalizedDisabledSystems,
    nativeBridge,
    timeoutMs,
  });
  await mkdir(nativeBridgeStateDir, { recursive: true });
  const pid = startNativeBridgeWorkerDetached(payload);
  if (pid) await writeNativeBridgeState(debugPort, nativeBridge, pid, {
    disabledSystems: normalizedDisabledSystems,
  });
  return pid;
}

function stopNativeBridgeProcess(pid) {
  // 这一段只停止当前启动契约里识别出的 bridge worker，避免超时后留下旧 bridgeId 后台进程。
  // Stop only the bridge worker identified by this startup contract so a timed-out bridgeId does not linger.
  if (!Number.isInteger(pid) || pid <= 0 || pid === process.pid) return false;
  try {
    process.kill(pid, "SIGTERM");
    return true;
  } catch {
    return false;
  }
}

export async function ensureNativeBridgeBinding(client, nativeBridge) {
  // 这一段注册页面到 launcher 的 CDP binding；重复注入时已存在也可以继续使用。
  // Register the page-to-launcher CDP binding; existing bindings remain usable across reinjection.
  if (!nativeBridge) return;
  try {
    await client.send("Runtime.addBinding", { name: nativeBridge.bindingName });
  } catch (error) {
    if (!String(error?.message || error).includes("already exists")) throw error;
  }
}

async function sendNativeBridgeResponse(client, nativeBridge, requestId, type, response) {
  // 这一段通过页面事件回传异步 native bridge 响应，只发结构化 JSON 数据。
  // Return async native bridge responses through a page event, sending only structured JSON data.
  await client.send("Runtime.evaluate", {
    allowUnsafeEvalBlockedByCSP: true,
    expression: `
      (() => {
        const bridgeId = ${JSON.stringify(nativeBridge.bridgeId)};
        if (window.__codexProNativeBridgeConfig?.bridgeId !== bridgeId) return false;
        window.dispatchEvent(new CustomEvent(${JSON.stringify(nativeBridgeResponseEventName)}, {
          detail: ${JSON.stringify({ requestId, response, type })}
        }));
        return true;
      })()
    `,
    awaitPromise: false,
  });
}

function bindNativeBridgeRequests(client, nativeBridge) {
  // 这一段监听页面桥接请求，并把合法请求分发到受限原生能力。
  // Listen for page bridge requests and dispatch valid requests to constrained native capabilities.
  if (!nativeBridge) return () => {};
  return client.on("Runtime.bindingCalled", (params) => {
    const request = parseNativeBridgeRequest(params, nativeBridge, {
      maxPayloadLength: nativeBridgeMaxPayloadLength,
    });
    if (!request) return;
    dispatchNativeBridgeRequest(client, nativeBridge, request, {
      sendNativeBridgeResponse,
    });
  });
}

async function updateNativeBridgeHeartbeat(client, nativeBridge) {
  // 这一段把后台桥心跳写到页面全局状态，页面侧据此判断 binding 是否只是残留函数。
  // Write the background bridge heartbeat into page global state so the page can detect stale bindings.
  return await client.send("Runtime.evaluate", {
    allowUnsafeEvalBlockedByCSP: true,
    expression: `
      (() => {
        const bridgeId = ${JSON.stringify(nativeBridge.bridgeId)};
        if (window.__codexProNativeBridgeConfig?.bridgeId !== bridgeId) return false;
        window.__codexProNativeBridgeStatus = { bridgeId, updatedAt: Date.now() };
        return true;
      })()
    `,
    awaitPromise: false,
  });
}

function startNativeBridgeHeartbeat(client, nativeBridge, debugPort, disabledSystems) {
  // 这一段定时刷新页面心跳；断线时忽略单次失败，连接关闭会由主等待路径处理。
  // Refresh the page heartbeat periodically; ignore single failures because the close wait handles disconnects.
  let stopped = false;
  const tick = () => {
    if (stopped) return;
    updateNativeBridgeHeartbeat(client, nativeBridge)
      .then((result) => {
        if (result?.result?.result?.value === true) return writeNativeBridgeWorkerHeartbeat(debugPort, nativeBridge, disabledSystems);
        return null;
      })
      .catch(() => {});
  };
  tick();
  const timerId = setInterval(tick, nativeBridgeHeartbeatMs);
  return () => {
    stopped = true;
    clearInterval(timerId);
  };
}

async function runNativeBridgeSession(debugPort, timeoutMs, nativeBridge, disabledSystems) {
  // 这一段运行单次 CDP 会话，连接断开时返回给 worker 外层决定是否重连。
  // Run one CDP session and return to the worker loop when the connection disconnects.
  const target = await waitForTarget(debugPort, timeoutMs);
  const client = new CdpClient(target.webSocketDebuggerUrl);
  const controller = new AbortController();
  let unbindNativeBridge = () => {};
  let stopHeartbeat = () => {};
  let stopOverlayWatcher = () => {};
  await client.connect();
  try {
    await client.send("Runtime.enable");
    await ensureNativeBridgeBinding(client, nativeBridge);
    unbindNativeBridge = bindNativeBridgeRequests(client, nativeBridge);
    stopHeartbeat = startNativeBridgeHeartbeat(client, nativeBridge, debugPort, disabledSystems);
    stopOverlayWatcher = startPetEventSoundOverlayTargetWatcher(debugPort, target.id, disabledSystems, controller.signal);
    await client.waitForClose();
  } finally {
    controller.abort();
    stopOverlayWatcher();
    stopHeartbeat();
    unbindNativeBridge();
    client.close();
  }
}

export async function runNativeBridgeWorker(payload) {
  // 这一段作为隐藏后台 worker 运行，短暂断线会自动重连，长期找不到 Codex 才退出。
  // Run as the hidden background worker, reconnecting through brief disconnects and exiting only after a long missing-target window.
  const { debugPort, disabledSystems, nativeBridge, timeoutMs } = payload;
  let missingTargetSince = 0;
  try {
    while (true) {
      try {
        await runNativeBridgeSession(
          debugPort,
          Math.min(timeoutMs, nativeBridgeWorkerTargetTimeoutMs),
          nativeBridge,
          disabledSystems,
        );
        missingTargetSince = 0;
      } catch (error) {
        const isMissingTarget = String(error?.message || error).startsWith("Timed out waiting for CDP target");
        if (isMissingTarget) {
          missingTargetSince ||= Date.now();
          if (Date.now() - missingTargetSince >= nativeBridgeMissingTargetExitMs) return;
        } else {
          missingTargetSince = 0;
        }
      }
      await delay(nativeBridgeReconnectDelayMs);
    }
  } finally {
    await clearNativeBridgeState(debugPort, nativeBridge.bridgeId);
    await runNativeBridgeWorkerCleanup();
  }
}

export async function writeNativeBridgeWorkerError(error) {
  // 这一段把隐藏 worker 的未处理错误写入忽略目录，避免无窗口后台失败时完全不可诊断。
  // Write hidden worker failures into the ignored state directory so background failures remain diagnosable.
  if (!process.argv.includes("--native-bridge-worker")) return;
  try {
    await mkdir(nativeBridgeStateDir, { recursive: true });
    await appendFile(
      path.join(nativeBridgeStateDir, "native-bridge-worker.err.log"),
      `[${new Date().toISOString()}] ${error?.stack || error?.message || String(error)}\n`,
      "utf8",
    );
  } catch {
    // 这一段忽略诊断日志写入失败，避免掩盖原始错误退出。
    // Ignore diagnostic log write failures so the original failure remains the exit reason.
  }
}
