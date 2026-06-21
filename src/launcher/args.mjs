import {
  defaultAppUserModelId,
  defaultDebugPort,
  defaultTimeoutMs,
} from "./paths.mjs";
import {
  parseDisabledSystems,
  splitSystemNames,
} from "./injection-manifest.mjs";

export function parseArgs(argv) {
  // 这一段建立默认参数，允许环境变量覆盖 Codex 安装位置。
  // Build default options and allow environment variables to override the Codex target.
  const options = {
    appPath: process.env.CODEX_APP_PATH || "",
    appUserModelId: process.env.CODEX_APP_USER_MODEL_ID || defaultAppUserModelId,
    attachOnly: false,
    debugPort: defaultDebugPort,
    disabledSystems: parseDisabledSystems(process.env.CODEX_PRO_DISABLED_SYSTEMS),
    dryRun: false,
    nativeBridge: process.env.CODEX_PRO_NATIVE_BRIDGE === "0" ? false : null,
    nativeBridgeWorker: false,
    nativeBridgeWorkerPayload: "",
    timeoutMs: defaultTimeoutMs,
  };

  // 这一段解析命令行参数，保持启动、检查、只注入三种模式共用一个入口。
  // Parse CLI arguments so launch, doctor, and attach-only modes share one entrypoint.
  for (let index = 0; index < argv.length; index += 1) {
    const arg = argv[index];
    if (arg === "--app-path") {
      options.appPath = argv[++index] || "";
    } else if (arg === "--app-user-model-id") {
      options.appUserModelId = argv[++index] || "";
    } else if (arg === "--debug-port") {
      options.debugPort = Number(argv[++index] || defaultDebugPort);
    } else if (arg === "--timeout-ms") {
      options.timeoutMs = Number(argv[++index] || defaultTimeoutMs);
    } else if (arg === "--disable-system") {
      options.disabledSystems = parseDisabledSystems([
        ...options.disabledSystems,
        ...splitSystemNames(argv[++index]),
      ].join(","));
    } else if (arg === "--attach-only") {
      options.attachOnly = true;
    } else if (arg === "--dry-run") {
      options.dryRun = true;
    } else if (arg === "--native-bridge") {
      options.nativeBridge = true;
    } else if (arg === "--no-native-bridge") {
      options.nativeBridge = false;
    } else if (arg === "--native-bridge-worker") {
      options.nativeBridgeWorker = true;
      options.nativeBridgeWorkerPayload = argv[++index] || "";
    } else if (arg === "-h" || arg === "--help") {
      options.help = true;
    }
  }

  if (!options.nativeBridgeWorker && options.nativeBridge === null) {
    options.nativeBridge = !options.attachOnly;
  }

  // 这一段返回标准化配置，后续流程只读取 options。
  // Return normalized options so the remaining flow only reads one object.
  return options;
}

export function printHelp() {
  // 这一段输出人工可读的命令帮助，便于直接运行 node 脚本时排查参数。
  // Print human-readable help for direct node script usage.
  console.log(`Codex-Pro launcher

Usage:
  npm run doctor
  npm run launch
  npm run inject

Options:
  --app-path <path>     Codex.exe path, app directory, or WindowsApps package app directory
  --app-user-model-id <id>
                        MSIX AppUserModelId fallback, default ${defaultAppUserModelId || "(none)"}
  --debug-port <port>   CDP port, default ${defaultDebugPort}
  --disable-system <names>
                        Comma, space, or semicolon separated system names to skip
  --attach-only         Do not launch Codex; inject into an already running CDP target
  --dry-run             Print resolved paths and launch arguments without starting Codex
  --native-bridge       Keep the CDP native shortcut bridge open after attach-only injection
  --no-native-bridge    Inject without creating a new native shortcut bridge

Environment:
  CODEX_PRO_DISABLED_SYSTEMS
                        Same format as --disable-system, useful for emergency hard-disable
  CODEX_PRO_NATIVE_BRIDGE=0
                        Do not create a new native shortcut bridge by default
`);
}
