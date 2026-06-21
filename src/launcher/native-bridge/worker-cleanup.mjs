import { clearExternalDiffTempRootOnWorkerExit } from "./handlers/diff-hover-preview.mjs";

const nativeBridgeWorkerCleanupTasks = [
  clearExternalDiffTempRootOnWorkerExit,
];

export async function runNativeBridgeWorkerCleanup() {
  // 这一段集中执行 worker 退出清理，避免主 bridge 直接耦合具体 handler 的临时文件细节。
  // Run worker-exit cleanup centrally so the main bridge does not depend on handler-specific temp-file details.
  for (const cleanupTask of nativeBridgeWorkerCleanupTasks) {
    try {
      await cleanupTask();
    } catch {
      // 这一段保持清理失败不影响 worker 退出，避免诊断路径掩盖真实生命周期。
      // Keep cleanup failures from blocking worker exit so diagnostics do not obscure the real lifecycle.
    }
  }
}
