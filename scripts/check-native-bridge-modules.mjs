import { readFile, stat } from "node:fs/promises";
import path from "node:path";

const rootDir = path.resolve(import.meta.dirname, "..");
const mainPath = path.join(rootDir, "src", "launcher", "native-bridge.mjs");
const launcherMainPath = path.join(rootDir, "src", "launcher", "main.mjs");
const injectionPath = path.join(rootDir, "src", "launcher", "injection.mjs");
const overlayInjectionPath = path.join(rootDir, "src", "launcher", "pet-event-sound-overlay-injection.mjs");
const nativeBridgeCorePath = path.join(rootDir, "src", "inject", "core", "native-bridge.js");
const commonPath = path.join(rootDir, "src", "launcher", "native-bridge", "common.mjs");
const routerPath = path.join(rootDir, "src", "launcher", "native-bridge", "router.mjs");
const workerCleanupPath = path.join(rootDir, "src", "launcher", "native-bridge", "worker-cleanup.mjs");
const diffHoverPreviewPath = path.join(rootDir, "src", "launcher", "native-bridge", "handlers", "diff-hover-preview.mjs");
const mouseGesturesPath = path.join(rootDir, "src", "launcher", "native-bridge", "handlers", "mouse-gestures.mjs");
const todayTokenUsagePath = path.join(rootDir, "src", "launcher", "native-bridge", "handlers", "today-token-usage.mjs");
const petEventSoundPath = path.join(rootDir, "src", "launcher", "native-bridge", "handlers", "pet-event-sound.mjs");
const packagePath = path.join(rootDir, "package.json");
const buildLauncherScriptPath = path.join(rootDir, "scripts", "build-launcher-exe.ps1");
const buildReleaseInteractiveScriptPath = path.join(rootDir, "scripts", "build-release-interactive.ps1");
const buildRustScriptPath = path.join(rootDir, "scripts", "build-rust-single-exe.ps1");
const injectDevScriptPath = path.join(rootDir, "scripts", "inject-dev.ps1");
const releaseNotesScriptPath = path.join(rootDir, "scripts", "generate-release-notes.mjs");
const releaseVersionScriptPath = path.join(rootDir, "scripts", "prepare-release-version.mjs");
const rustArgsPath = path.join(rootDir, "crates", "codex-pro-core", "src", "args.rs");
const rustAssetsPath = path.join(rootDir, "crates", "codex-pro-core", "src", "assets.rs");
const rustDiagnosticsPath = path.join(rootDir, "crates", "codex-pro-core", "src", "diagnostics.rs");
const rustInjectionPath = path.join(rootDir, "crates", "codex-pro-core", "src", "injection.rs");
const rustProtocolPath = path.join(rootDir, "crates", "codex-pro-bridge", "src", "protocol.rs");
const rustWorkerPath = path.join(rootDir, "crates", "codex-pro-bridge", "src", "worker.rs");
const rustRouterPath = path.join(rootDir, "crates", "codex-pro-bridge", "src", "router.rs");
const rustPetSyncPath = path.join(rootDir, "crates", "codex-pro-bridge", "src", "handlers", "pet_sync.rs");
const rustPetEventSoundPath = path.join(rootDir, "crates", "codex-pro-bridge", "src", "handlers", "pet_event_sound.rs");
const rustUpdateCheckPath = path.join(rootDir, "crates", "codex-pro-bridge", "src", "handlers", "update_check.rs");
const rustConversationArchiveDir = path.join(rootDir, "crates", "codex-pro-bridge", "src", "handlers", "conversation_archive");
const rustConversationArchivePaths = [
  "codex_state.rs",
  "device_delete.rs",
  "identity.rs",
  "lifecycle.rs",
  "markdown.rs",
  "mod.rs",
  "package.rs",
  "preview.rs",
  "progress.rs",
  "project.rs",
  "remote.rs",
  "request.rs",
  "rollout_reader.rs",
  "session_index.rs",
  "state.rs",
].map((fileName) => path.join(rustConversationArchiveDir, fileName));
const rustLauncherMainPath = path.join(rootDir, "apps", "codex-pro-launcher", "src", "main.rs");

function assert(condition, message) {
  // 这一段用明确错误终止结构检查，让 native bridge 拆分回归更容易定位。
  // Fail with explicit messages so native bridge split regressions are easy to locate.
  if (!condition) throw new Error(message);
}

async function assertFileExists(filePath) {
  // 这一段确认目标模块已落盘，避免主 bridge import 指向不存在的 handler。
  // Confirm target modules exist so the main bridge cannot import missing handlers.
  const stats = await stat(filePath);
  assert(stats.isFile(), `${path.relative(rootDir, filePath)} must be a file`);
}

function assertIncludes(source, needle, label) {
  // 这一段检查关键导出或 import 是否存在，确保拆分边界可被后续维护者看见。
  // Check key exports or imports so the split boundary stays visible to future maintainers.
  assert(source.includes(needle), `Missing ${label}: ${needle}`);
}

function assertNotIncludes(source, needle, label) {
  // 这一段阻止大型业务实现滑回 native-bridge 主文件。
  // Prevent large business implementations from sliding back into the main native-bridge file.
  assert(!source.includes(needle), `Main native-bridge should not contain ${label}: ${needle}`);
}

async function flushAsyncHandlers() {
  // 这一段等待 router fire-and-forget promise 链完成，避免测试过早读取 fake sender 结果。
  // Wait for router fire-and-forget promise chains so checks do not read fake sender results too early.
  await Promise.resolve();
  await new Promise((resolve) => setTimeout(resolve, 0));
}

await Promise.all([
  assertFileExists(commonPath),
  assertFileExists(routerPath),
  assertFileExists(workerCleanupPath),
  assertFileExists(overlayInjectionPath),
  assertFileExists(diffHoverPreviewPath),
  assertFileExists(mouseGesturesPath),
  assertFileExists(todayTokenUsagePath),
  assertFileExists(petEventSoundPath),
  assertFileExists(buildLauncherScriptPath),
  assertFileExists(buildReleaseInteractiveScriptPath),
  assertFileExists(buildRustScriptPath),
  assertFileExists(injectDevScriptPath),
  assertFileExists(releaseVersionScriptPath),
  assertFileExists(rustArgsPath),
  assertFileExists(rustAssetsPath),
  assertFileExists(rustDiagnosticsPath),
  assertFileExists(rustInjectionPath),
  assertFileExists(rustProtocolPath),
  assertFileExists(rustWorkerPath),
  assertFileExists(rustRouterPath),
  assertFileExists(rustPetSyncPath),
  assertFileExists(rustPetEventSoundPath),
  assertFileExists(rustUpdateCheckPath),
  ...rustConversationArchivePaths.map((filePath) => assertFileExists(filePath)),
  assertFileExists(rustLauncherMainPath),
]);

const [
  mainSource,
  launcherMainSource,
  injectionSource,
  overlayInjectionSource,
  nativeBridgeCoreSource,
  routerSource,
  workerCleanupSource,
  diffHoverPreviewSource,
  mouseGesturesSource,
  petEventSoundSource,
  packageSource,
  buildLauncherScriptSource,
  buildReleaseInteractiveScriptSource,
  buildRustScriptSource,
  injectDevScriptSource,
  releaseNotesScriptSource,
  releaseVersionScriptSource,
  rustArgsSource,
  rustAssetsSource,
  rustDiagnosticsSource,
  rustInjectionSource,
  rustProtocolSource,
  rustWorkerSource,
  rustRouterSource,
  rustPetSyncSource,
  rustPetEventSoundSource,
  rustUpdateCheckSource,
  rustLauncherMainSource,
] = await Promise.all([
  readFile(mainPath, "utf8"),
  readFile(launcherMainPath, "utf8"),
  readFile(injectionPath, "utf8"),
  readFile(overlayInjectionPath, "utf8"),
  readFile(nativeBridgeCorePath, "utf8"),
  readFile(routerPath, "utf8"),
  readFile(workerCleanupPath, "utf8"),
  readFile(diffHoverPreviewPath, "utf8"),
  readFile(mouseGesturesPath, "utf8"),
  readFile(petEventSoundPath, "utf8"),
  readFile(packagePath, "utf8"),
  readFile(buildLauncherScriptPath, "utf8"),
  readFile(buildReleaseInteractiveScriptPath, "utf8"),
  readFile(buildRustScriptPath, "utf8"),
  readFile(injectDevScriptPath, "utf8"),
  readFile(releaseNotesScriptPath, "utf8"),
  readFile(releaseVersionScriptPath, "utf8"),
  readFile(rustArgsPath, "utf8"),
  readFile(rustAssetsPath, "utf8"),
  readFile(rustDiagnosticsPath, "utf8"),
  readFile(rustInjectionPath, "utf8"),
  readFile(rustProtocolPath, "utf8"),
  readFile(rustWorkerPath, "utf8"),
  readFile(rustRouterPath, "utf8"),
  readFile(rustPetSyncPath, "utf8"),
  readFile(rustPetEventSoundPath, "utf8"),
  readFile(rustUpdateCheckPath, "utf8"),
  readFile(rustLauncherMainPath, "utf8"),
]);
const conversationArchiveSource = (await Promise.all(
  rustConversationArchivePaths.map((filePath) => readFile(filePath, "utf8")),
)).join("\n");

assertIncludes(mainSource, "const nativeBridgeProtocolVersion = 71", "native bridge protocol version bump");
assertIncludes(rustProtocolSource, "NATIVE_BRIDGE_PROTOCOL_VERSION: u32 = 71", "Rust native bridge protocol version bump");
assertIncludes(mainSource, "protocolVersion === nativeBridgeProtocolVersion", "native bridge reusable worker version gate");
assertIncludes(mainSource, "startPetEventSoundOverlayTargetWatcher", "native bridge worker overlay watcher import");
assertIncludes(mainSource, "disabledSystems", "native bridge worker preserves disabled system list");
assertIncludes(mainSource, "workerHeartbeatAt", "native bridge worker heartbeat state");
assertIncludes(mainSource, "isNativeBridgeStateHeartbeatFresh", "native bridge reusable worker heartbeat gate");
assertIncludes(mainSource, "isNativeBridgePageHeartbeatFresh", "native bridge reusable page heartbeat gate");
assertIncludes(mainSource, "export async function waitForNativeBridgeReady", "native bridge startup readiness gate");
assertIncludes(mainSource, "ShellExecute", "native bridge Windows shell launch path");
assertIncludes(mainSource, "stopNativeBridgeProcess", "native bridge startup timeout cleanup");
assertIncludes(mainSource, 'return await client.send("Runtime.evaluate"', "native bridge heartbeat returns CDP evaluation result");
assertIncludes(mainSource, 'from "./native-bridge/router.mjs"', "native bridge router import");
assertIncludes(mainSource, 'from "./native-bridge/worker-cleanup.mjs"', "native bridge worker cleanup import");
assertIncludes(injectionSource, "updatedAt: 0", "native bridge starts unavailable until worker heartbeat");
assertIncludes(injectionSource, "injectPetEventSoundOverlayTargets", "pet event sound overlay target injection");
assertIncludes(overlayInjectionSource, "buildPetEventSoundOverlayModulePaths", "pet event sound overlay manifest builder");
assertIncludes(overlayInjectionSource, "readPetEventSoundOverlayScript", "pet event sound overlay script reader");
assertIncludes(overlayInjectionSource, "startPetEventSoundOverlayTargetWatcher", "pet event sound overlay late target watcher");
assertIncludes(overlayInjectionSource, "petEventSoundOverlayScanIntervalMs", "pet event sound overlay watcher interval");
assertNotIncludes(overlayInjectionSource, "injectedTargetIds", "target-id cached pet overlay watcher");
assertIncludes(launcherMainSource, "getReusableNativeBridge(options.debugPort, options.disabledSystems)", "native bridge reuse should honor disabled systems");
assertIncludes(launcherMainSource, "startNativeBridgeWorker(options.debugPort, options.timeoutMs, nativeBridge, options.disabledSystems)", "native bridge worker payload should include disabled systems");
assertIncludes(nativeBridgeCoreSource, "request.force = true", "conversation archive force flag bridge forwarding");
assertIncludes(nativeBridgeCoreSource, '"reset"', "conversation archive reset action bridge forwarding");
assertIncludes(nativeBridgeCoreSource, '"delete-device"', "conversation archive delete-device action bridge forwarding");
assertIncludes(nativeBridgeCoreSource, "request.deviceId = deviceId", "conversation archive device id bridge forwarding");
assertIncludes(nativeBridgeCoreSource, "requestTodayTokenUsage", "Today token usage bridge request");
assertIncludes(nativeBridgeCoreSource, "supportsUpdateCheck", "update-check bridge capability gate");
assertIncludes(nativeBridgeCoreSource, "requestUpdateCheck", "update-check bridge request");
assertIncludes(nativeBridgeCoreSource, "supportsPetEventSound", "pet event sound bridge capability gate");
assertIncludes(nativeBridgeCoreSource, "requestPetEventSound", "pet event sound bridge request");
assertIncludes(nativeBridgeCoreSource, "resolvePetEventSoundStateId", "pet event sound bridge should resolve state ids from settings");
assertIncludes(nativeBridgeCoreSource, "params?.stateId", "pet event sound bridge should expose state id requests instead of raw paths");
assertIncludes(nativeBridgeCoreSource, 'send("pet-event-sound", { requestId, stateId })', "pet event sound bridge should send only state ids to native");
assertIncludes(nativeBridgeCoreSource, "protocolVersion >= 70", "pet event sound bridge protocol gate");
assertIncludes(overlayInjectionSource, "main-window-playback-v1", "pet overlay watcher should require the main-window playback runtime marker");
assertIncludes(routerSource, '"today-token-usage"', "Today token usage router registration");
assertIncludes(routerSource, '"pet-event-sound"', "pet event sound router registration");
assertIncludes(rustRouterSource, "TodayTokenUsage", "Rust Today token usage router registration");
assertIncludes(rustRouterSource, "UpdateCheck", "Rust update-check router registration");
assertIncludes(rustRouterSource, "PetEventSound", "Rust pet event sound router registration");
assertIncludes(rustRouterSource, '"update-check"', "Rust update-check request type");
assertIncludes(rustRouterSource, '"pet-event-sound"', "Rust pet event sound request type");
assertIncludes(rustRouterSource, '"updateCheckFailed"', "Rust update-check returns a neutral page error");
assertIncludes(rustRouterSource, '"readFailed"', "Rust pet event sound returns a neutral page error");
assertIncludes(rustUpdateCheckSource, "pub fn parse_update_check_request", "Rust update-check request parser export");
assertIncludes(rustUpdateCheckSource, "pub async fn run_update_check_request", "Rust update-check runner export");
assertIncludes(rustUpdateCheckSource, "latest.json", "Rust update-check uses release index");
assertIncludes(rustUpdateCheckSource, "parser_rejects_page_supplied_url", "Rust update-check rejects page URL contract");
assertIncludes(rustPetEventSoundSource, "pub fn parse_pet_event_sound_request", "Rust pet event sound request parser export");
assertIncludes(rustPetEventSoundSource, "pub async fn run_pet_event_sound_request", "Rust pet event sound runner export");
assertIncludes(rustPetEventSoundSource, "PET_EVENT_SOUND_MAX_BYTES", "Rust pet event sound file size cap");
assertIncludes(rustPetEventSoundSource, "mime_from_path", "Rust pet event sound extension allow-list");
assertIncludes(rustAssetsSource, "src/inject/systems/update-check/settings.js", "Rust core assets should embed update-check settings");
assertIncludes(rustAssetsSource, "src/inject/systems/performance-fixes/settings.js", "Rust core assets should embed performance fixes settings");
assertIncludes(rustAssetsSource, "src/inject/systems/update-check/index.js", "Rust core assets should embed update-check runtime");
assertIncludes(rustAssetsSource, "src/inject/systems/pet-event-sounds/index.js", "Rust core assets should embed pet event sound runtime");
assertIncludes(rustAssetsSource, "src/inject/systems/settings-menu/sections/pet-status.js", "Rust core assets should embed pet status settings section");
assertIncludes(nativeBridgeCoreSource, 'detail.type === "conversation-archive-progress"', "conversation archive progress event listener");
assertIncludes(nativeBridgeCoreSource, "resetTimeout();", "conversation archive idle timeout refresh");
assertIncludes(conversationArchiveSource, 'join("pending-device-deletes.json")', "Rust conversation archive pending device delete state path");
assertIncludes(conversationArchiveSource, "pub async fn remember_pending_delete", "Rust conversation archive persists delete intent before remote request");
assertIncludes(conversationArchiveSource, "pub async fn retry_pending_deletes", "Rust conversation archive retries pending delete intents");
assertIncludes(conversationArchiveSource, '"deletePending"', "Rust conversation archive returns a pending delete success when remote confirmation is slow");
assertIncludes(conversationArchiveSource, '"deviceDeletePending"', "Rust conversation archive reports pending device deletes to the sidebar");
assertIncludes(conversationArchiveSource, "pub fn is_transient_delete_failure", "Rust conversation archive keeps retryable delete failures pending");
assertIncludes(conversationArchiveSource, "localDeviceUploadBlockedAfterDeleteAt", "Rust conversation archive blocks auto upload after deleting the local device");
assertIncludes(conversationArchiveSource, "had_local_pending_delete", "Rust conversation archive avoids duplicate pending delete retry during push");
assertIncludes(conversationArchiveSource, "localDeviceUploadSkippedForPendingDelete", "Rust conversation archive skips upload while local device delete is pending");
assertIncludes(conversationArchiveSource, "!options.pending_device_ids.contains(device_id)", "Rust conversation archive filters pending deleted devices from lists");
assertIncludes(launcherMainSource, "waitForNativeBridgeReady", "launcher waits for native bridge heartbeat");
assertIncludes(launcherMainSource, "did not report a fresh heartbeat", "launcher reports native bridge startup failure");
assertIncludes(routerSource, "export function parseNativeBridgeRequest", "native bridge parser export");
assertIncludes(routerSource, "export function dispatchNativeBridgeRequest", "native bridge dispatcher export");
assertIncludes(routerSource, "sendNativeBridgeResponse", "native bridge response sender usage");
assertIncludes(workerCleanupSource, "export async function runNativeBridgeWorkerCleanup", "native bridge worker cleanup export");
assertIncludes(workerCleanupSource, "clearExternalDiffTempRootOnWorkerExit", "external diff cleanup is registered outside main bridge");
assertNotIncludes(routerSource, '"cloud-sync"', "legacy Node cloud-sync route");
assertNotIncludes(routerSource, '"pet-sync"', "legacy Node pet-sync route");
assertIncludes(routerSource, 'from "./handlers/diff-hover-preview.mjs"', "diff hover preview handler import");
assertIncludes(routerSource, 'from "./handlers/mouse-gestures.mjs"', "mouse gestures handler import");
assertIncludes(routerSource, 'from "./handlers/pet-event-sound.mjs"', "pet event sound handler import");
assertIncludes(rustRouterSource, "dispatch_conversation_archive_request", "Rust conversation archive router dispatch");
assertIncludes(rustRouterSource, '"conversation-archive-progress"', "Rust conversation archive progress response type");
assertIncludes(diffHoverPreviewSource, "export function parseExternalDiffRequest", "external diff request parser export");
assertIncludes(diffHoverPreviewSource, "export function parseGitDiffSummaryRequest", "git diff summary request parser export");
assertIncludes(diffHoverPreviewSource, "export async function openExternalDiff", "external diff runner export");
assertIncludes(diffHoverPreviewSource, "export async function readGitDiffSummary", "git diff summary runner export");
assertIncludes(diffHoverPreviewSource, "export async function clearExternalDiffTempRootOnWorkerExit", "external diff cleanup export");
assertIncludes(diffHoverPreviewSource, "gitDiffSummaryCommandTimeoutMs", "git diff summary command timeout");
assertIncludes(diffHoverPreviewSource, "child.stderr?.resume?.()", "git command stderr drain");
assertIncludes(mouseGesturesSource, "export function parseShortcutRequest", "shortcut request parser export");
assertIncludes(mouseGesturesSource, "export async function dispatchNativeShortcut", "shortcut dispatcher export");
assertIncludes(petEventSoundSource, "export function parsePetEventSoundRequest", "pet event sound request parser export");
assertIncludes(petEventSoundSource, "export async function readPetEventSound", "pet event sound reader export");
assertIncludes(petEventSoundSource, "export async function resolvePetEventSoundPath", "pet event sound native resolver export");
assertIncludes(petEventSoundSource, "petEventSoundMaxBytes", "pet event sound file size cap");
assertIncludes(petEventSoundSource, "getPetEventSoundMime", "pet event sound extension allow-list");
assertIncludes(rustPetSyncSource, "pub fn parse_pet_sync_request", "Rust pet-sync request parser export");
assertIncludes(rustPetSyncSource, "pub async fn run_pet_sync_request", "Rust pet-sync runner export");
assertIncludes(rustPetSyncSource, "fn push_body_matches_legacy_pet_sync_contract", "Rust pet-sync upload contract test");
assertIncludes(rustPetSyncSource, "fn pulled_pet_package_uses_temp_url_contract", "Rust pet-sync pull URL contract test");
for (const [needle, label] of [
  ["pub fn parse_conversation_archive_request", "Rust conversation archive request parser export"],
  ["pub async fn run_conversation_archive_request", "Rust conversation archive runner export"],
  ["pub fn is_generated_title", "Rust conversation archive generated-title filter"],
  ["thread_source", "Rust conversation archive user-thread source filter"],
  ["fn sanitize_text_block", "Rust conversation archive synthetic text sanitizer"],
  ["strip_memory_citations", "Rust conversation archive memory citation sanitizer"],
  ["pub const MARKDOWN_FORMAT_VERSION: u64 = 15", "Rust conversation archive processed-duration markdown re-export version"],
  ["struct ProcessingGroup", "Rust conversation archive processed group"],
  ['payload.get("phase").and_then(Value::as_str) == Some("commentary")', "Rust conversation archive commentary processing export"],
  ["tool_summary_label", "Rust conversation archive tool summary export"],
  ['lines.push(body);', "Rust conversation archive repeated-speaker natural spacing"],
  ['lines.push("---".to_string());', "Rust conversation archive role block leading divider"],
  ['lines.push(format!("### {speaker}"));', "Rust conversation archive role heading body spacing"],
  ["serialize_reasoning_summary", "Rust conversation archive reasoning summary exporter"],
  ["serialize_processing_group", "Rust conversation archive processed attachment serializer"],
  ["thinking_link_name", "Rust conversation archive per-reasoning attachment path"],
  ["thread_archive_path", "Rust conversation archive grouped path builder"],
  ['home.join("sqlite").join("state_5.sqlite")', "Rust conversation archive current Codex sqlite layout"],
  ['home.join("state_5.sqlite")', "Rust conversation archive legacy Codex sqlite layout"],
  ["fn state_database_path", "Rust conversation archive active sqlite database selector"],
  ["project_salt", "Rust conversation archive private project grouping salt"],
  ["struct OfficialProjects", "Rust conversation archive project identity table"],
  ["fn project_from_assignment", "Rust conversation archive official thread project resolver"],
  ["fn project_by_path_key", "Rust conversation archive official project root descendant matcher"],
  ['normalized.starts_with(&format!("{project_path}/"))', "Rust conversation archive project root descendant boundary check"],
  ['normalized.starts_with(&format!("{project_path}\\\\"))', "Rust conversation archive Windows project root descendant boundary check"],
  ["removed_project_thread_count", "Rust conversation archive removed project diagnostics count"],
  ["fn read_official_state", "Rust conversation archive official project state reader"],
  ['"projectless-thread-ids"', "Rust conversation archive official projectless thread ids"],
  ['"thread-project-assignments"', "Rust conversation archive official thread project assignments"],
  ['"thread-workspace-root-hints"', "Rust conversation archive official workspace root hints"],
  ['"electron-saved-workspace-roots"', "Rust conversation archive official saved workspace roots"],
  ["archive sync stopped to avoid wrong grouping", "Rust conversation archive must fail closed when official project state is missing"],
  ["archive sync stopped, please retry later", "Rust conversation archive must fail closed when official project state is unreadable"],
  ['"archiveGroupDisplayName"', "Rust conversation archive project display names should match native labels"],
  ['lifecycle_status != "active"', "Rust conversation archive device lists should hide archived and deleted threads"],
  ["fn group_key", "Rust conversation archive group type/id map key"],
  ["fn project_group_id", "Rust conversation archive salted project identity key"],
  ["pub fn migration_paths", "Rust conversation archive stale path migration cleanup"],
  ["async fn mark_migration_paths_deleted", "Rust conversation archive grouped path tombstone cleanup"],
  ["fn should_prefer_thread_entry", "Rust conversation archive duplicate thread priority"],
  ["remote::reset_manifest", "Rust conversation archive remote reset action"],
  ["async fn reset_archive", "Rust conversation archive native reset runner"],
  ["pub async fn delete_device", "Rust conversation archive remote device delete action"],
  ["async fn delete_device_archive", "Rust conversation archive native device delete runner"],
  ['"projects"', "Rust conversation archive grouped project path"],
  ['"conversations"', "Rust conversation archive grouped conversation path"],
  ['"index.md"', "Rust conversation archive per-thread directory main path"],
  ["safe_file_name", "Rust conversation archive per-thread preview directory"],
  ["rewrite_related_links", "Rust conversation archive side-panel preview link rewriter"],
  ["related_files", "Rust conversation archive related preview writer"],
  ['"fileRole": "thinking"', "Rust conversation archive hidden thinking manifest marker"],
  ["pub struct ProgressReporter", "Rust conversation archive upload progress reporter"],
  ['"pendingThreadCount"', "Rust conversation archive pending thread progress count"],
  ['"uploadedFileCount"', "Rust conversation archive file-count upload result"],
  ["markdown_format_version", "Rust conversation archive markdown re-export trigger"],
  ['"skippedGeneratedTitleCount"', "Rust conversation archive generated-title skip counter"],
  ["MAX_UNSTABLE_DELAY_MS", "Rust conversation archive active-thread maximum unstable wait"],
  ["remember_unstable_thread", "Rust conversation archive active-thread unstable wait persistence"],
  ['"unstableForcedCount"', "Rust conversation archive active-thread forced sync counter"],
  ['"sourceCreatedAt"', "Rust conversation archive created-time list field"],
  ['"identity"', "Rust conversation archive local identity list field"],
  ["subagent_notification", "Rust conversation archive subagent notification filter"],
  ['"threadSource"', "Rust conversation archive thread source manifest field"],
  ["session_index.jsonl", "Rust conversation archive local session title index"],
  ['format!("index-{}.md", short_hash(&package.markdown))', "Rust conversation archive preview cache busting hash"],
  ["legacy_state_dirs", "Rust conversation archive legacy local state migration root"],
  ["seed_state_file_from_legacy", "Rust conversation archive legacy state migration helper"],
  ["tokio::fs::copy", "Rust conversation archive legacy state copy helper"],
  ['legacy_dir.join("identity.json")', "Rust conversation archive identity should migrate from legacy state"],
  ["legacy_dir.join(file_name)", "Rust conversation archive index should migrate after identity is known"],
]) {
  assertIncludes(conversationArchiveSource, needle, label);
}
assertNotIncludes(conversationArchiveSource, "readConversationArchiveGitProjectIdentity", "Rust conversation archive must not infer projects from live git");
assertNotIncludes(conversationArchiveSource, "identity: `cwd:${cwdKey}`", "Rust conversation archive must not infer projects from raw cwd");
assertNotIncludes(conversationArchiveSource, "cleanLegacyConversationArchiveMarkdown", "Rust conversation archive view-time markdown sanitizer");
assertNotIncludes(conversationArchiveSource, "getLegacyConversationArchiveThreadPath", "Rust conversation archive legacy remote path generator");
assertIncludes(packageSource, '"check:native-bridge"', "native bridge check package script");
assertIncludes(packageSource, '"check:release-version": "node scripts/prepare-release-version.mjs --check"', "release version consistency check package script");
assertIncludes(packageSource, '"build:launcher"', "Rust private launcher build package script");
assertIncludes(packageSource, '"doctor:rust:dev"', "Rust dev doctor package script");
assertIncludes(packageSource, '"inject:rust:dev"', "Rust dev inject package script");
assertIncludes(packageSource, '"release:version": "node scripts/prepare-release-version.mjs"', "release version bump package script");
assertIncludes(packageSource, '"release:notes": "node scripts/generate-release-notes.mjs"', "release notes generation package script");
assertIncludes(packageSource, '"inject": "powershell.exe -NoProfile -ExecutionPolicy Bypass -File scripts/inject-dev.ps1"', "default inject rebuilds and uses the private launcher");
assertIncludes(packageSource, '"inject:rust:dev": "powershell.exe -NoProfile -ExecutionPolicy Bypass -File scripts/inject-dev.ps1"', "Rust dev inject uses the private launcher script");
assertIncludes(packageSource, '"check:rust-bridge": "cargo test --target-dir private/target -p codex-pro-bridge"', "Rust bridge checks keep Cargo output under private");
assertIncludes(packageSource, '"doctor": "cargo run --target-dir private/target --bin Codex-Pro-Launcher -- --dry-run"', "Rust doctor keeps Cargo output under private");
assertIncludes(packageSource, '"inject:rust": "cargo run --target-dir private/target --bin Codex-Pro-Launcher -- --attach-only --native-bridge"', "Rust inject keeps Cargo output under private");
assertIncludes(packageSource, "--target-dir private/target/codex-pro-dev", "Rust dev scripts use isolated private target dir");
assertIncludes(packageSource, "--dev-runtime --source-root .", "Rust dev scripts enable disk source root");
assertNotIncludes(packageSource, "node src/launcher.mjs", "legacy Node launcher npm entry");
assertNotIncludes(packageSource, '"build:portable"', "legacy Node/.NET portable build entry");
assertIncludes(buildLauncherScriptSource, "cargo build --target-dir $targetDir --bin Codex-Pro-Launcher", "private launcher build uses Rust dev target");
assertIncludes(buildLauncherScriptSource, "cargo test --target-dir $targetDir --workspace", "private launcher tests use Rust dev target");
assertIncludes(buildLauncherScriptSource, "\"private\\target\\codex-pro-dev\"", "private launcher build keeps Cargo dev output under private");
assertIncludes(buildLauncherScriptSource, "Assert-LastExitCode", "private launcher build checks native command exit codes");
assertIncludes(buildLauncherScriptSource, "Remove-Item -LiteralPath $builtExe -Force", "private launcher build removes stale build output before cargo build");
assertIncludes(buildLauncherScriptSource, "$targetExe = Join-Path $privateBinDir \"Codex-Pro-Launcher.exe\"", "private launcher build replaces private exe");
assertNotIncludes(buildLauncherScriptSource, "dotnet", "private launcher build must not use legacy .NET shell");
assertIncludes(buildRustScriptSource, "$targetDir = Join-Path $repoRoot \"private\\target\"", "release build keeps Cargo output under private");
assertIncludes(buildRustScriptSource, "$releaseConfigEnvName = \"CODEX_PRO_RELEASE_CONFIG_JSON\"", "release build defines embedded config env var");
assertIncludes(buildRustScriptSource, "Get-ReleaseRuntimeConfigJson", "release build extracts public runtime config");
assertIncludes(buildRustScriptSource, "Assert-HttpsUrl $cloudSyncEndpoint", "release build validates settings sync URL");
assertIncludes(buildRustScriptSource, "Assert-HttpsUrl $licenseApiBase", "release build validates license API URL");
assertIncludes(buildRustScriptSource, "Assert-LicensePublishableKey $licenseApiKey", "release build validates license publishable key");
assertIncludes(buildRustScriptSource, "Assert-LicenseProductSlug $licenseProductSlug", "release build validates license product slug");
assertIncludes(buildRustScriptSource, "Set-Item -Path \"Env:$releaseConfigEnvName\" -Value $releaseConfigJson", "release build exports embedded runtime config to cargo");
assertIncludes(buildRustScriptSource, "Get-WorkspacePackageVersion", "release build reads the workspace package version");
assertIncludes(buildRustScriptSource, "Get-WorkspaceRepositoryUrl", "release build reads the workspace repository URL");
assertIncludes(buildRustScriptSource, "Write-Utf8NoBomText", "release build writes latest.json without PowerShell 7-only encodings");
assertIncludes(buildRustScriptSource, "$versionedOutputZip = Join-Path $outputDir \"Codex-Pro-Launcher-v$releaseVersion-windows.zip\"", "release build names the primary zip asset with the version");
assertIncludes(buildRustScriptSource, "$latestJsonPath = Join-Path $outputDir \"latest.json\"", "release build names the update index");
assertIncludes(buildRustScriptSource, "$releaseNotesPath = Join-Path $outputDir \"release-notes-v$releaseVersion.md\"", "release build names the release notes file");
assertIncludes(buildRustScriptSource, "cargo test --target-dir $targetDir", "release build tests use private Cargo target");
assertIncludes(buildRustScriptSource, "cargo clippy --target-dir $targetDir --all-targets -- -D warnings", "release build clippy uses private Cargo target");
assertIncludes(buildRustScriptSource, "cargo build --target-dir $targetDir --release --bin Codex-Pro-Launcher", "release build uses private Cargo target");
assertIncludes(buildRustScriptSource, "Join-Path $targetDir \"release\\Codex-Pro-Launcher.exe\"", "release build copies from private Cargo target");
assertIncludes(buildRustScriptSource, "$legacyDirectExeAsset", "release build removes stale versioned direct exe asset");
assertIncludes(buildRustScriptSource, "Compress-Archive -LiteralPath $outputExe -DestinationPath $versionedOutputZip", "release build writes a versioned zip asset");
assertIncludes(buildRustScriptSource, "scripts\\generate-release-notes.mjs", "release build generates release notes");
assertIncludes(buildRustScriptSource, "Get-ReleaseNotesBody", "release build reads generated release notes");
assertIncludes(buildRustScriptSource, "Write-ReleaseLatestJson -Path $latestJsonPath", "release build writes latest.json");
assertIncludes(buildRustScriptSource, "-ReleaseNotesPath $releaseNotesPath", "release build writes release notes into latest.json");
assertNotIncludes(buildRustScriptSource, "Codex-Pro-Launcher-v$releaseVersion.exe", "versioned direct exe release asset");
assertNotIncludes(buildRustScriptSource, 'body = ""', "empty latest.json release notes body");
assertIncludes(buildRustScriptSource, "Assert-HttpsUrl $updateLatestJsonUrl", "release build validates custom update index URL");
assertIncludes(buildReleaseInteractiveScriptSource, "Release Index Asset", "interactive release build prints latest.json asset");
assertIncludes(buildReleaseInteractiveScriptSource, "Release Notes", "interactive release build prints release notes metadata");
assertIncludes(buildReleaseInteractiveScriptSource, "latest.json index", "interactive release build completion mentions latest.json");
assertIncludes(releaseVersionScriptSource, "Release index: private/build/rust/latest.json", "release version summary includes latest.json");
assertIncludes(buildReleaseInteractiveScriptSource, "Write-ArtifactInfo -ArtifactPath $releaseZipAssetPath -Title \"Primary ZIP Asset\"", "interactive release build prints the primary zip metadata");
assertIncludes(buildReleaseInteractiveScriptSource, "\"Codex-Pro-Launcher-v$artifactVersion-windows.zip\"", "interactive release build locates the zip asset by executable metadata");
assertIncludes(releaseVersionScriptSource, "workspacePackageNames", "release version script updates workspace packages");
assertIncludes(releaseVersionScriptSource, "runtimeVersionPath", "release version script updates injected runtime version");
assertIncludes(releaseVersionScriptSource, "readRuntimeVersion", "release version script checks injected runtime version");
assertIncludes(releaseVersionScriptSource, "official release version must be >= 1.0.0", "release version script enforces official 1.x+ versions");
assertIncludes(releaseVersionScriptSource, "Primary release asset: private/build/rust/Codex-Pro-Launcher-v${targetVersion}-windows.zip", "release version script prints the primary zip asset path");
assertNotIncludes(releaseVersionScriptSource, "Fallback exe asset", "release version summary direct exe asset");
assertIncludes(releaseNotesScriptSource, "getPreviousReleaseTag", "release notes script chooses previous semantic tag");
assertIncludes(releaseNotesScriptSource, "^v\\d+\\.\\d+\\.\\d+$", "release notes script filters stable semantic tags");
assertIncludes(releaseNotesScriptSource, "shouldSkipCommit", "release notes script filters release-process noise");
assertIncludes(releaseNotesScriptSource, "release-notes-v${version}.md", "release notes script writes versioned notes under private build");
assertIncludes(injectDevScriptSource, "$privateLauncher = Join-Path $repoRoot \"private\\bin\\Codex-Pro-Launcher.exe\"", "dev inject resolves the private launcher");
assertIncludes(injectDevScriptSource, "-File $buildScript -SkipTests", "dev inject rebuilds the private launcher first");
assertIncludes(injectDevScriptSource, "Start-Process -FilePath $privateLauncher", "dev inject starts the GUI launcher");
assertIncludes(injectDevScriptSource, "$launcherProcess.WaitForExit()", "dev inject waits only for the foreground private launcher");
assertIncludes(injectDevScriptSource, '"--attach-only"', "dev inject passes attach-only to the private launcher");
assertIncludes(injectDevScriptSource, '"--native-bridge"', "dev inject passes native bridge mode to the private launcher");
assertIncludes(injectDevScriptSource, '"--dev-runtime"', "dev inject passes dev runtime mode to the private launcher");
assertIncludes(injectDevScriptSource, '"--source-root"', "dev inject passes the source root to the private launcher");
assertIncludes(injectDevScriptSource, "Assert-LastExitCode", "dev inject checks native command exit codes");
assertIncludes(rustArgsSource, "dev_runtime", "Rust args expose dev runtime flag");
assertIncludes(rustArgsSource, '"--dev-runtime"', "Rust args parse dev runtime flag");
assertIncludes(rustArgsSource, '"--source-root"', "Rust args parse source root");
assertIncludes(rustArgsSource, "CODEX_PRO_DEV_RUNTIME", "Rust args support dev runtime env");
assertIncludes(rustArgsSource, "discover_implicit_development_source_root", "Rust args auto-discover dev source root for double-click");
assertIncludes(rustArgsSource, "is_development_launcher_location", "Rust args keep private/build/rust releases out of implicit dev mode");
assertIncludes(rustArgsSource, "return None;", "Rust args do not fall back to cwd after a non-dev current exe is known");
assertIncludes(rustInjectionSource, "source_root: Option<&Path>", "Rust injection accepts optional disk source root");
assertIncludes(rustInjectionSource, "load_local_config(source_root)", "Rust injection reads local or embedded runtime config");
assertIncludes(rustInjectionSource, "read_injection_module_source_from_disk", "Rust injection can read dev modules from disk");
assertIncludes(rustInjectionSource, "read_pet_event_sound_overlay_script", "Rust injection builds pet event sound overlay script");
assertIncludes(rustInjectionSource, "inject_pet_event_sound_overlay_targets", "Rust injection targets pet event sound overlay");
assertIncludes(rustWorkerSource, "PET_EVENT_SOUND_OVERLAY_SCAN_INTERVAL_MS", "Rust worker scans late pet overlay targets");
assertIncludes(rustWorkerSource, "scan_pet_event_sound_overlay_targets", "Rust worker pet overlay watcher");
assertIncludes(rustWorkerSource, "read_pet_event_sound_overlay_script", "Rust worker reads pet overlay script");
assertIncludes(rustWorkerSource, "disabledSystems", "Rust worker payload preserves disabled system list");
assertIncludes(rustWorkerSource, "main-window-playback-v1", "Rust worker should replace old overlay playback runtimes");
assertNotIncludes(rustWorkerSource, "injected_overlay_target_ids", "Rust target-id cached pet overlay watcher");
assertIncludes(rustWorkerSource, "dev-runtime", "Rust worker uses dev-runtime copy directory");
assertIncludes(rustWorkerSource, "prepare_dev_worker_executable", "Rust worker prepares a dev exe copy");
assertIncludes(rustWorkerSource, "configure_worker_source_root", "Rust worker configures source root for private config discovery");
assertIncludes(rustWorkerSource, 'command.env("CODEX_PRO_SOURCE_ROOT", source_root)', "Rust worker forwards source root env");
assertIncludes(rustWorkerSource, "command.current_dir(source_root)", "Rust worker runs from source root when available");
assertIncludes(rustWorkerSource, '.join("private")', "Rust worker copies private target dev artifact first");
assertIncludes(rustWorkerSource, '.join("codex-pro-dev")', "Rust worker still targets the isolated dev artifact");
assertIncludes(rustWorkerSource, "tokio::fs::copy", "Rust worker copies exe before dev worker spawn");
assertIncludes(rustWorkerSource, "configure_worker_stdio", "Rust dev worker captures startup logs");
assertIncludes(rustWorkerSource, "native-bridge-worker-", "Rust dev worker log files are bridge scoped");
assertIncludes(rustLauncherMainSource, "development_source_root", "Rust launcher resolves dev source root");
assertIncludes(rustLauncherMainSource, "run_native_bridge_worker_from_payload_on_dedicated_thread", "Rust worker mode runs on a dedicated stack");
assertIncludes(rustLauncherMainSource, ".stack_size(16 * 1024 * 1024)", "Rust worker mode avoids GUI main thread stack overflow");
assertIncludes(rustLauncherMainSource, "try_reuse_running_codex", "Rust launcher reuses and foregrounds running Codex");
assertIncludes(rustLauncherMainSource, "probe_existing_runtime", "Rust launcher probes existing runtime before skipping normal reinjection");
assertIncludes(rustLauncherMainSource, "skip_injection", "Rust launcher can foreground an already usable Codex-Pro runtime without reinjecting");
assertNotIncludes(rustLauncherMainSource, "state.native_bridge.protocol_version != NATIVE_BRIDGE_PROTOCOL_VERSION", "protocol-gated native bridge port hints");
assertIncludes(rustInjectionSource, "existing_runtime_probe_expression", "Rust injection can inspect an existing page runtime without DOM mutation");
assertIncludes(rustLauncherMainSource, "source_root.as_deref()", "Rust launcher passes dev source root into injection");
assertIncludes(rustLauncherMainSource, "&options.disabled_systems", "Rust launcher passes disabled systems into native bridge worker");
assertIncludes(rustDiagnosticsSource, '"devRuntime"', "Rust dry-run reports dev runtime");
assertIncludes(rustDiagnosticsSource, "rust-dev-background-worker", "Rust dry-run reports dev bridge mode");
assertIncludes(rustDiagnosticsSource, '"sourceRoot"', "Rust dry-run reports source root");

const commonSource = await readFile(commonPath, "utf8");
assertIncludes(commonSource, 'export const codexProDataDirName = ".Codex-Pro-Launcher"', "Codex-Pro unified data directory name");
assertIncludes(commonSource, "getCodexProDataRootDir", "Codex-Pro unified data root helper");
assertIncludes(commonSource, "path.join(getCodexHomeDir(), codexProDataDirName)", "Codex-Pro data root under Codex home");
assertIncludes(commonSource, "randomUUID()", "unique atomic temp file suffix");
assertIncludes(commonSource, "await unlink(tempPath)", "atomic temp cleanup on failure");

for (const [needle, label] of [
  ["clearExternalDiffTempRootOnWorkerExit", "handler-specific external diff cleanup"],
  ["const externalDiff", "external diff constants"],
  ["const gitDiffSummary", "git diff summary constants"],
  ["function normalizeExternalDiff", "external diff parser implementation"],
  ["async function openExternalDiff", "external diff runner implementation"],
  ["async function readGitDiffSummary", "git diff summary runner implementation"],
  ["async function runGitText", "git diff summary git runner implementation"],
  ["if (request.type === \"external-diff\")", "external diff dispatch branch"],
  ["if (request.type === \"git-diff-summary\")", "git diff summary dispatch branch"],
  ["const nativeShortcut", "shortcut constants"],
  ["function parseNativeShortcut", "shortcut parser implementation"],
  ["function createKeyEventParams", "shortcut CDP key event implementation"],
  ["async function dispatchNativeShortcut", "shortcut dispatcher implementation"],
  ["const conversationArchiveIndexVersion", "conversation archive constants"],
  ["function sanitizeConversationArchiveRequest", "conversation archive parser implementation"],
  ["async function runConversationArchiveRequest", "conversation archive runner implementation"],
  ["async function postConversationArchiveJson", "conversation archive HTTP implementation"],
  ["DatabaseSync", "conversation archive SQLite dependency"],
  ["createReadStream", "conversation archive rollout stream dependency"],
]) {
  assertNotIncludes(mainSource, needle, label);
}

const {
  parseExternalDiffRequest,
  parseGitDiffHunks,
  parseGitDiffSummaryRequest,
} = await import("../src/launcher/native-bridge/handlers/diff-hover-preview.mjs");
const { parseShortcutRequest } = await import("../src/launcher/native-bridge/handlers/mouse-gestures.mjs");
const {
  parsePetEventSoundRequest,
  readPetEventSound,
} = await import("../src/launcher/native-bridge/handlers/pet-event-sound.mjs");
const {
  dispatchNativeBridgeRequest,
  parseNativeBridgeRequest,
} = await import("../src/launcher/native-bridge/router.mjs");

const bridge = { bindingName: "__codexProNativeBridge_test", bridgeId: "bridge_test" };

const externalDiffRequest = parseExternalDiffRequest({
  changeKind: "modified",
  cwd: rootDir,
  path: "src/launcher/native-bridge.mjs",
  toolPath: process.execPath,
});
assert(externalDiffRequest?.type === "external-diff", "valid external diff request should parse");
assert(
  parseExternalDiffRequest({
    changeKind: "modified",
    cwd: rootDir,
    path: "../secret.txt",
    toolPath: process.execPath,
  }) === null,
  "external diff parser should reject workspace escapes",
);
assert(
  parseExternalDiffRequest({
    changeKind: "modified",
    cwd: rootDir,
    path: "src/launcher/native-bridge.mjs",
    toolPath: "git diff",
  }) === null,
  "external diff parser should reject non-absolute tools",
);
const routedExternalDiffRequest = parseNativeBridgeRequest(
  {
    name: bridge.bindingName,
    payload: JSON.stringify({
      bridgeId: bridge.bridgeId,
      changeKind: "modified",
      cwd: rootDir,
      path: "src/launcher/native-bridge.mjs",
      toolPath: process.execPath,
      type: "external-diff",
    }),
  },
  bridge,
);
assert(routedExternalDiffRequest?.type === "external-diff", "router should parse external diff requests");

const gitSummaryRequest = parseGitDiffSummaryRequest({
  cwd: rootDir,
  requestId: "req_git",
});
assert(gitSummaryRequest?.type === "git-diff-summary", "valid git diff summary request should parse");
assert(
  parseGitDiffSummaryRequest({
    cwd: "relative-workspace",
    requestId: "req_git",
  }) === null,
  "git diff summary parser should reject relative cwd",
);
const gitHunkRanges = parseGitDiffHunks(`
diff --git a/src/app.js b/src/app.js
--- a/src/app.js
+++ b/src/app.js
@@ -8,0 +10,2 @@
+const first = true;
+const second = true;
@@ -28,2 +30,1 @@
-const oldValue = false;
+const newValue = true;
diff --git a/src/delete-only.js b/src/delete-only.js
--- a/src/delete-only.js
+++ b/src/delete-only.js
@@ -4,1 +4,0 @@
-const removed = true;
`);
assert(
  JSON.stringify(gitHunkRanges.get("src/app.js")) === JSON.stringify([
    { line: 10, endLine: 11 },
    { line: 30, endLine: 30 },
  ]),
  "git hunk parser should keep modified file navigation ranges",
);
assert(
  JSON.stringify(gitHunkRanges.get("src/delete-only.js")) === JSON.stringify([{ line: 4, endLine: 4 }]),
  "git hunk parser should keep delete-only navigation anchors",
);

assert(
  parseNativeBridgeRequest(
    {
      name: bridge.bindingName,
      payload: JSON.stringify({
        bridgeId: "wrong_bridge",
        cwd: rootDir,
        requestId: "req_git",
        type: "git-diff-summary",
      }),
    },
    bridge,
  ) === null,
  "router should reject mismatched bridge ids",
);
assert(
  parseNativeBridgeRequest(
    {
      name: bridge.bindingName,
      payload: JSON.stringify({
        bridgeId: bridge.bridgeId,
        requestId: "req_large",
        type: "git-diff-summary",
        value: "x".repeat(120),
      }),
    },
    bridge,
    { maxPayloadLength: 80 },
  ) === null,
  "router should reject oversized payloads",
);
const routedGitRequest = parseNativeBridgeRequest(
  {
    name: bridge.bindingName,
    payload: JSON.stringify({
      bridgeId: bridge.bridgeId,
      cwd: rootDir,
      requestId: "req_git",
      type: "git-diff-summary",
    }),
  },
  bridge,
);
assert(routedGitRequest?.type === "git-diff-summary", "router should parse git diff summary requests");
const routedShortcutRequest = parseNativeBridgeRequest(
  {
    name: bridge.bindingName,
    payload: JSON.stringify({
      bridgeId: bridge.bridgeId,
      shortcut: "Ctrl+Shift+P",
      type: "shortcut",
    }),
  },
  bridge,
);
assert(routedShortcutRequest?.type === "shortcut", "router should parse shortcut requests");
assert(routedShortcutRequest.shortcut.description === "Ctrl+Shift+P", "router should preserve normalized shortcut request");

assert(parseShortcutRequest({ shortcut: "Ctrl+Alt+T" })?.type === "shortcut", "valid shortcut request should parse");
assert(parseShortcutRequest({ shortcut: "Ctrl" }) === null, "shortcut parser should reject modifier-only shortcuts");
assert(parseShortcutRequest({ shortcut: "Ctrl+K+P" }) === null, "shortcut parser should reject multi-key macros");
assert(
  parsePetEventSoundRequest({ stateId: "running-left", requestId: "req_sound" })?.type === "pet-event-sound",
  "valid pet event sound request should parse",
);
assert(
  parsePetEventSoundRequest({ path: "C:/Sounds/running.mp3", requestId: "req_sound" }) === null,
  "pet event sound parser should reject raw path requests",
);
assert(
  parsePetEventSoundRequest({ stateId: "running\nC:/secret.txt", requestId: "req_sound" }) === null,
  "pet event sound parser should reject unsafe state ids",
);
assert(
  (await readPetEventSound({ path: "//server/share/sound.wav", requestId: "req_sound" })).error === "invalidPath",
  "pet event sound reader should reject UNC-style network paths",
);
const routedPetEventSoundRequest = parseNativeBridgeRequest(
  {
    name: bridge.bindingName,
    payload: JSON.stringify({
      bridgeId: bridge.bridgeId,
      requestId: "req_sound",
      stateId: "running",
      type: "pet-event-sound",
    }),
  },
  bridge,
);
assert(routedPetEventSoundRequest?.type === "pet-event-sound", "router should parse pet event sound requests");

const shortcutDispatches = [];
assert(
  dispatchNativeBridgeRequest(
    {},
    bridge,
    {
      shortcut: { description: "Ctrl+Shift+P", keys: [] },
      type: "shortcut",
    },
    {
      dispatchShortcut: async (client, shortcut) => {
        shortcutDispatches.push(shortcut.description);
      },
    },
  ) === true,
  "router should dispatch shortcut requests",
);
await flushAsyncHandlers();
assert(shortcutDispatches[0] === "Ctrl+Shift+P", "router should call injected shortcut dispatcher");

const defaultShortcutEvents = [];
assert(
  dispatchNativeBridgeRequest(
    {
      send: async (method, params) => {
        defaultShortcutEvents.push({ method, params });
      },
    },
    bridge,
    parseShortcutRequest({ shortcut: "Ctrl+Alt+T" }),
    {},
  ) === true,
  "router should dispatch shortcuts through the default mouse gesture handler",
);
await flushAsyncHandlers();
assert(defaultShortcutEvents.length === 2, "default shortcut dispatcher should send keyDown and keyUp events");
assert(
  defaultShortcutEvents.every((event) => event.method === "Input.dispatchKeyEvent"),
  "default shortcut dispatcher should use CDP Input.dispatchKeyEvent",
);

assert(
  parseNativeBridgeRequest(
    {
      name: bridge.bindingName,
      payload: JSON.stringify({
        action: "push",
        bridgeId: bridge.bridgeId,
        endpoint: "https://example.com/pet-sync",
        requestId: "req_pet_routed",
        syncKey: "1234567890123456",
        type: "pet-sync",
      }),
    },
    bridge,
  ) === null,
  "legacy Node router should not parse pet-sync requests",
);
assert(
  parseNativeBridgeRequest(
    {
      name: bridge.bindingName,
      payload: JSON.stringify({
        action: "push",
        bridgeId: bridge.bridgeId,
        endpoint: "https://example.com/pet-sync",
        requestId: "bad request id",
        syncKey: "1234567890123456",
        type: "pet-sync",
      }),
    },
    bridge,
  ) === null,
  "legacy Node router should reject pet-sync requests after Rust migration",
);
assert(
  parseNativeBridgeRequest(
    {
      name: bridge.bindingName,
      payload: JSON.stringify({
        action: "push",
        bridgeId: bridge.bridgeId,
        endpoint: "https://example.com/pet-sync",
        requestId: "req_pet",
        syncKey: "1234567890123456",
        type: "pet-sync",
      }),
    },
    bridge,
  ) === null,
  "legacy Node router should not validate pet-sync endpoint or sync key locally",
);

console.log("native bridge module split checks passed");
