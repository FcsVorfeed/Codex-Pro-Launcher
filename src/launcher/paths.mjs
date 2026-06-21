import path from "node:path";
import { fileURLToPath } from "node:url";

const launcherModuleDir = path.dirname(fileURLToPath(import.meta.url));

export const rootDir = path.resolve(launcherModuleDir, "..", "..");
export const launcherPath = path.join(rootDir, "src", "launcher.mjs");
export const defaultDebugPort = 9229;
export const defaultTimeoutMs = 30_000;
export const defaultAppUserModelId = process.platform === "win32"
  ? "OpenAI.Codex_2p2nqsd0c76g0!App"
  : "";
