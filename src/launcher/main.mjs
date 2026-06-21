import { parseArgs, printHelp } from "./args.mjs";
import {
  appUserModelIdFromExecutable,
  codexLaunchArgs,
  launchCodex,
  resolveCodexExecutable,
} from "./codex-app.mjs";
import { inject } from "./injection.mjs";
import { buildInjectionModulePaths } from "./injection-manifest.mjs";
import {
  createNativeBridgeConfig,
  decodeNativeBridgeWorkerPayload,
  getReusableNativeBridge,
  runNativeBridgeWorker,
  startNativeBridgeWorker,
  waitForNativeBridgeReady,
} from "./native-bridge.mjs";

export async function main(argv = process.argv.slice(2)) {
  // 这一段解析参数，并在请求帮助时提前退出。
  // Parse CLI options and exit early when help is requested.
  const options = parseArgs(argv);
  if (options.nativeBridgeWorker) {
    await runNativeBridgeWorker(decodeNativeBridgeWorkerPayload(options.nativeBridgeWorkerPayload));
    return;
  }
  if (options.help) {
    printHelp();
    return;
  }

  // 这一段只打印诊断信息，不启动或注入，供 doctor 命令使用。
  // Print diagnostics only for the doctor command without launching or injecting.
  if (options.dryRun) {
    // 这一段 dry-run 保留完整路径解析，确保诊断输出仍然能看到真实 Codex.exe。
    // Keep full path resolution for dry-run so diagnostics still show the real Codex.exe.
    const executable = resolveCodexExecutable(options.appPath);
    const appUserModelId = appUserModelIdFromExecutable(executable) || options.appUserModelId;
    const launch = {
      executable,
      args: codexLaunchArgs(options.debugPort),
      appUserModelId,
    };
    console.log(JSON.stringify({
      ...launch,
      debugPort: options.debugPort,
      disabledSystems: options.disabledSystems,
      injectionModules: buildInjectionModulePaths(options.disabledSystems).map((parts) => parts.join("/")),
      nativeBridge: options.nativeBridge,
      nativeBridgeMode: options.nativeBridge ? "background-worker" : "disabled",
    }, null, 2));
    return;
  }

  // 这一段在非 attach-only 模式下启动 Codex，再等待注入。
  // Start Codex in non-attach-only mode before waiting for injection.
  if (!options.attachOnly) {
    // 这一段冷启动优先用稳定 AppUserModelId，避免真正启动前扫描 WindowsApps。
    // Prefer the stable AppUserModelId on cold launch to avoid scanning WindowsApps before startup.
    const preferAppUserModelId = !options.appPath && Boolean(options.appUserModelId);
    let executable = preferAppUserModelId ? "" : resolveCodexExecutable(options.appPath);
    let appUserModelId = appUserModelIdFromExecutable(executable) || options.appUserModelId;
    if (!executable && !appUserModelId) {
      throw new Error("Codex launch target not found. Pass --app-path, --app-user-model-id, CODEX_APP_PATH, or CODEX_APP_USER_MODEL_ID.");
    }

    let started;
    try {
      started = launchCodex({ executable, appUserModelId }, options.debugPort);
    } catch (error) {
      // 这一段只在快速激活失败时恢复旧路径探测，避免牺牲兼容性。
      // Restore the old executable lookup only when fast activation fails, preserving compatibility.
      if (!preferAppUserModelId) throw error;
      executable = resolveCodexExecutable(options.appPath);
      appUserModelId = appUserModelIdFromExecutable(executable) || appUserModelId;
      if (!executable) throw error;
      started = launchCodex({ executable, appUserModelId }, options.debugPort);
    }
    console.log(`Started Codex method=${started.method} pid=${started.pid || "unknown"}`);
  }

  // 这一段把 Codex-Pro 注入模块注入到 Codex 页面，并输出结果。
  // Inject Codex-Pro modules into the Codex page and print the result.
  const reusableNativeBridge = options.nativeBridge
    ? await getReusableNativeBridge(options.debugPort)
    : null;
  const nativeBridge = reusableNativeBridge?.nativeBridge || createNativeBridgeConfig(options.nativeBridge);
  const { client, target } = await inject(options.debugPort, options.timeoutMs, options.disabledSystems, nativeBridge);
  console.log(`Injected Codex-Pro modules into target: ${target.title || target.url || target.id}`);
  client.close();

  if (!nativeBridge) {
    return;
  }

  // 这一段启动或复用隐藏后台桥；前台启动器可以退出，不再要求 CMD 长期停留。
  // Start or reuse the hidden background bridge so the foreground launcher can exit.
  if (reusableNativeBridge) {
    console.log(`Native shortcut bridge reused in background pid=${reusableNativeBridge.pid}`);
  } else {
    const pid = await startNativeBridgeWorker(options.debugPort, options.timeoutMs, nativeBridge);
    const readyBridge = await waitForNativeBridgeReady(options.debugPort, nativeBridge);
    if (!readyBridge) {
      throw new Error("Native shortcut bridge did not report a fresh heartbeat after startup.");
    }
    console.log(`Native shortcut bridge started in background pid=${readyBridge.pid || pid || "unknown"}`);
  }
}
