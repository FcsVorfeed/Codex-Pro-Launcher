import { readFile, writeFile } from "node:fs/promises";
import path from "node:path";

const rootDir = path.resolve(import.meta.dirname, "..");
const packagePath = path.join(rootDir, "package.json");
const cargoTomlPath = path.join(rootDir, "Cargo.toml");
const cargoLockPath = path.join(rootDir, "Cargo.lock");
const runtimeVersionPath = path.join(rootDir, "src", "inject", "core", "runtime.js");
const workspacePackageNames = [
  "codex-pro-bridge",
  "codex-pro-core",
  "codex-pro-launcher",
];

// 这一段解析命令行参数，默认把当前正式版本递增一个 patch。
// Parse command-line arguments; by default the current release version bumps one patch.
function parseArgs(argv) {
  const options = {
    check: false,
    dryRun: false,
    next: "patch",
    version: null,
  };

  for (let index = 0; index < argv.length; index += 1) {
    const arg = argv[index];
    if (arg === "--check") {
      options.check = true;
      continue;
    }
    if (arg === "--dry-run") {
      options.dryRun = true;
      continue;
    }
    if (arg === "--help" || arg === "-h") {
      printUsage();
      process.exit(0);
    }
    if (arg === "--version") {
      options.version = requireValue(argv, index, arg);
      index += 1;
      continue;
    }
    if (arg.startsWith("--version=")) {
      options.version = arg.slice("--version=".length);
      continue;
    }
    if (arg === "--next") {
      options.next = requireValue(argv, index, arg);
      index += 1;
      continue;
    }
    if (arg.startsWith("--next=")) {
      options.next = arg.slice("--next=".length);
      continue;
    }
    throw new Error(`unknown argument: ${arg}`);
  }

  if (!["patch", "minor", "major"].includes(options.next)) {
    throw new Error(`--next must be patch, minor, or major: ${options.next}`);
  }
  if (options.check && (options.version || options.dryRun)) {
    throw new Error("--check cannot be combined with --version or --dry-run");
  }
  return options;
}

// 这一段读取带值参数，避免空版本号被当成有效发布版本。
// Read the value for an option so an empty release version cannot pass silently.
function requireValue(argv, index, optionName) {
  const value = argv[index + 1];
  if (!value || value.startsWith("--")) {
    throw new Error(`${optionName} requires a value`);
  }
  return value;
}

// 这一段打印人工执行入口，避免发布时记错版本命令。
// Print manual entrypoints so release operators do not have to remember the flags.
function printUsage() {
  console.log(`Usage:
  npm run release:version -- --version 1.0.0
  npm run release:version
  npm run release:version -- --next minor
  npm run check:release-version`);
}

// 这一段解析三段式正式版本，不接受预发布或构建元数据，避免 exe 文件名和 tag 出现歧义。
// Parse a three-part release version; prerelease/build metadata is rejected to keep exe names and tags unambiguous.
function parseReleaseVersion(version, label) {
  const match = /^([0-9]+)\.([0-9]+)\.([0-9]+)$/.exec(version);
  if (!match) {
    throw new Error(`${label} must use MAJOR.MINOR.PATCH: ${version}`);
  }
  return {
    major: Number(match[1]),
    minor: Number(match[2]),
    patch: Number(match[3]),
    text: version,
  };
}

// 这一段生成下一个正式版本；默认 patch 递增，minor/major 会清零更低位。
// Compute the next release version; patch is the default, minor/major reset lower parts.
function bumpVersion(current, bumpKind) {
  const version = parseReleaseVersion(current, "current version");
  if (bumpKind === "major") {
    return `${version.major + 1}.0.0`;
  }
  if (bumpKind === "minor") {
    return `${version.major}.${version.minor + 1}.0`;
  }
  return `${version.major}.${version.minor}.${version.patch + 1}`;
}

// 这一段读取所有公开版本源头，确保发布版本只有一个事实来源。
// Read every public version source so the release version has one coherent truth.
async function readVersionState() {
  const [packageSource, cargoTomlSource, cargoLockSource, runtimeVersionSource] = await Promise.all([
    readFile(packagePath, "utf8"),
    readFile(cargoTomlPath, "utf8"),
    readFile(cargoLockPath, "utf8"),
    readFile(runtimeVersionPath, "utf8"),
  ]);
  const packageJson = JSON.parse(packageSource);
  const cargoVersion = readCargoWorkspaceVersion(cargoTomlSource);
  const cargoLockVersions = readCargoLockWorkspaceVersions(cargoLockSource);
  const runtimeVersion = readRuntimeVersion(runtimeVersionSource);
  return {
    packageJson,
    packageSource,
    packageVersion: packageJson.version,
    cargoTomlSource,
    cargoVersion,
    cargoLockSource,
    cargoLockVersions,
    runtimeVersionSource,
    runtimeVersion,
  };
}

// 这一段只读取 workspace.package 的 version，不碰依赖版本。
// Read only workspace.package version and leave dependency versions alone.
function readCargoWorkspaceVersion(source) {
  const workspacePackageSection = getTomlSection(source, "workspace.package");
  const versionMatch = /^version\s*=\s*"([^"]+)"$/m.exec(workspacePackageSection);
  if (!versionMatch) {
    throw new Error("Cargo.toml missing [workspace.package] version");
  }
  return versionMatch[1];
}

// 这一段提取 TOML 指定 section，避免正则误改其它段落。
// Extract a TOML section so later edits do not hit unrelated sections.
function getTomlSection(source, sectionName) {
  const sectionHeader = `[${sectionName}]`;
  const start = source.indexOf(sectionHeader);
  if (start < 0) {
    throw new Error(`Cargo.toml missing ${sectionHeader}`);
  }
  const nextSection = source.indexOf("\n[", start + sectionHeader.length);
  return nextSection < 0 ? source.slice(start) : source.slice(start, nextSection);
}

// 这一段读取 Cargo.lock 中本 workspace 包的版本，防止锁文件落后。
// Read workspace package versions from Cargo.lock so stale lock files are caught.
function readCargoLockWorkspaceVersions(source) {
  const versions = new Map();
  for (const packageName of workspacePackageNames) {
    const match = cargoLockPackageVersionRegExp(packageName).exec(source);
    if (!match) {
      throw new Error(`Cargo.lock missing workspace package: ${packageName}`);
    }
    versions.set(packageName, match[2]);
  }
  return versions;
}

// 这一段读取注入运行时版本，避免页面诊断版本和发布版本脱节。
// Read the injected runtime version so page diagnostics do not drift from the release version.
function readRuntimeVersion(source) {
  const match = /^\s*runtime\.version\s*=\s*"([^"]+)";$/m.exec(source);
  if (!match) {
    throw new Error("runtime.js missing runtime.version");
  }
  return match[1];
}

// 这一段为 Cargo.lock 本地包构造定点匹配，保持依赖包版本不被误改。
// Build a targeted Cargo.lock match so dependency package versions are never changed.
function cargoLockPackageVersionRegExp(packageName) {
  const escapedPackageName = packageName.replace(/[.*+?^${}()|[\]\\]/g, "\\$&");
  return new RegExp(
    `(\\[\\[package\\]\\]\\r?\\nname = "${escapedPackageName}"\\r?\\nversion = ")([^"]+)(")`,
    "m",
  );
}

// 这一段校验所有源头版本一致，避免 Git tag、源码和 exe 属性分裂。
// Validate that all version sources match so Git tags, source, and exe metadata cannot drift apart.
function assertVersionStateConsistent(state, { requireOfficialMajor = true } = {}) {
  const versionEntries = [
    ["package.json", state.packageVersion],
    ["Cargo.toml", state.cargoVersion],
    ["src/inject/core/runtime.js", state.runtimeVersion],
    ...[...state.cargoLockVersions.entries()].map(([name, version]) => [
      `Cargo.lock ${name}`,
      version,
    ]),
  ];
  for (const [label, version] of versionEntries) {
    parseReleaseVersion(version, label);
  }

  const uniqueVersions = new Set(versionEntries.map(([, version]) => version));
  if (uniqueVersions.size !== 1) {
    throw new Error(
      `release version mismatch:\n${versionEntries
        .map(([label, version]) => `  ${label}: ${version}`)
        .join("\n")}`,
    );
  }

  const currentVersion = versionEntries[0][1];
  if (
    requireOfficialMajor &&
    parseReleaseVersion(currentVersion, "current version").major < 1
  ) {
    throw new Error(`official release version must be >= 1.0.0: ${currentVersion}`);
  }
  return currentVersion;
}

// 这一段生成改完版本后的文件内容，保持改动范围只落在版本字段。
// Generate updated file contents while keeping edits scoped to version fields.
function buildUpdatedSources(state, targetVersion) {
  state.packageJson.version = targetVersion;
  const packageSource = `${JSON.stringify(state.packageJson, null, 2)}\n`;
  const cargoTomlSource = replaceCargoWorkspaceVersion(
    state.cargoTomlSource,
    targetVersion,
  );
  const runtimeVersionSource = replaceRuntimeVersion(
    state.runtimeVersionSource,
    targetVersion,
  );
  let cargoLockSource = state.cargoLockSource;
  for (const packageName of workspacePackageNames) {
    cargoLockSource = cargoLockSource.replace(
      cargoLockPackageVersionRegExp(packageName),
      `$1${targetVersion}$3`,
    );
  }
  return { packageSource, cargoTomlSource, cargoLockSource, runtimeVersionSource };
}

// 这一段替换 workspace.package 的 version，不触碰 dependency version。
// Replace workspace.package version without touching dependency versions.
function replaceCargoWorkspaceVersion(source, targetVersion) {
  const section = getTomlSection(source, "workspace.package");
  const updatedSection = section.replace(
    /^version\s*=\s*"[^"]+"$/m,
    `version = "${targetVersion}"`,
  );
  if (section === updatedSection) {
    throw new Error("failed to update Cargo.toml workspace package version");
  }
  return source.replace(section, updatedSection);
}

// 这一段替换注入运行时版本，保持页面运行态诊断和发布版本一致。
// Replace the injected runtime version so page runtime diagnostics match the release version.
function replaceRuntimeVersion(source, targetVersion) {
  const updatedSource = source.replace(
    /^(\s*runtime\.version\s*=\s*)"[^"]+";$/m,
    `$1"${targetVersion}";`,
  );
  if (source === updatedSource) {
    throw new Error("failed to update runtime.version");
  }
  return updatedSource;
}

// 这一段写回公开版本源文件；private 构建产物仍由构建脚本生成，不进入 Git。
// Write public version files; private build artifacts are still generated only by build scripts.
async function writeVersionState(sources) {
  await Promise.all([
    writeFile(packagePath, sources.packageSource, "utf8"),
    writeFile(cargoTomlPath, sources.cargoTomlSource, "utf8"),
    writeFile(cargoLockPath, sources.cargoLockSource, "utf8"),
    writeFile(runtimeVersionPath, sources.runtimeVersionSource, "utf8"),
  ]);
}

// 这一段打印发布后要使用的 tag 和带版本号产物路径，方便截图核对。
// Print the tag and versioned asset paths operators should use after the release build.
function printReleaseSummary(currentVersion, targetVersion, dryRun) {
  const prefix = dryRun ? "Would update" : "Updated";
  console.log(`${prefix} release version: ${currentVersion} -> ${targetVersion}`);
  console.log(`Git tag: v${targetVersion}`);
  console.log(`Primary release asset: private/build/rust/Codex-Pro-Launcher-v${targetVersion}-windows.zip`);
  console.log("Release index: private/build/rust/latest.json");
}

try {
  const options = parseArgs(process.argv.slice(2));
  const state = await readVersionState();
  const currentVersion = options.check
    ? assertVersionStateConsistent(state)
    : assertVersionStateConsistent(state, { requireOfficialMajor: false });

  if (options.check) {
    console.log(`Release version check passed: ${currentVersion}`);
    process.exit(0);
  }

  const targetVersion = options.version ?? bumpVersion(currentVersion, options.next);
  parseReleaseVersion(targetVersion, "target version");
  const target = parseReleaseVersion(targetVersion, "target version");
  if (target.major < 1) {
    throw new Error(`official release version must be >= 1.0.0: ${targetVersion}`);
  }
  const sources = buildUpdatedSources(state, targetVersion);
  if (!options.dryRun) {
    await writeVersionState(sources);
  }
  printReleaseSummary(currentVersion, targetVersion, options.dryRun);
} catch (error) {
  console.error(error.message);
  process.exit(1);
}
