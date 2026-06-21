import { main } from "./launcher/main.mjs";
import { writeNativeBridgeWorkerError } from "./launcher/native-bridge.mjs";

main().catch(async (error) => {
  // 这一段统一打印未处理错误，并让命令行返回失败退出码。
  // Print unhandled errors consistently and return a failing process exit code.
  await writeNativeBridgeWorkerError(error);
  console.error(error?.stack || error?.message || String(error));
  process.exitCode = 1;
});
