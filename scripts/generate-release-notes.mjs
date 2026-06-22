import { mkdir, readFile, writeFile } from "node:fs/promises";
import { execFileSync } from "node:child_process";
import path from "node:path";

const rootDir = path.resolve(import.meta.dirname, "..");
const packagePath = path.join(rootDir, "package.json");
const defaultOutputDir = path.join(rootDir, "private", "build", "rust");

// 这一段解析命令行参数，让发布说明可以自动生成，也可以人工指定比较范围。
// Parse command-line options so release notes can be automatic or use a manual comparison range.
function parseArgs(argv) {
  const options = {
    from: null,
    output: null,
    to: "HEAD",
    version: null,
  };

  for (let index = 0; index < argv.length; index += 1) {
    const arg = argv[index];
    if (arg === "--from") {
      options.from = requireValue(argv, index, arg);
      index += 1;
      continue;
    }
    if (arg.startsWith("--from=")) {
      options.from = arg.slice("--from=".length);
      continue;
    }
    if (arg === "--output") {
      options.output = requireValue(argv, index, arg);
      index += 1;
      continue;
    }
    if (arg.startsWith("--output=")) {
      options.output = arg.slice("--output=".length);
      continue;
    }
    if (arg === "--to") {
      options.to = requireValue(argv, index, arg);
      index += 1;
      continue;
    }
    if (arg.startsWith("--to=")) {
      options.to = arg.slice("--to=".length);
      continue;
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
    if (arg === "--help" || arg === "-h") {
      printUsage();
      process.exit(0);
    }
    throw new Error(`unknown argument: ${arg}`);
  }

  return options;
}

// 这一段读取带值参数，避免空范围或空输出路径通过。
// Read option values so empty ranges or output paths cannot pass silently.
function requireValue(argv, index, optionName) {
  const value = argv[index + 1];
  if (!value || value.startsWith("--")) {
    throw new Error(`${optionName} requires a value`);
  }
  return value;
}

// 这一段打印人工执行入口，方便发布前单独预览说明内容。
// Print manual entrypoints so release notes can be previewed before publishing.
function printUsage() {
  console.log(`Usage:
  npm run release:notes
  npm run release:notes -- --from v1.0.0 --version 1.0.2
  node scripts/generate-release-notes.mjs --output private/build/rust/release-notes-v1.0.2.md`);
}

// 这一段执行 Git 命令并返回文本结果，统一控制工作目录和编码。
// Run a Git command and return text with one cwd and encoding policy.
function git(args) {
  return execFileSync("git", args, {
    cwd: rootDir,
    encoding: "utf8",
    stdio: ["ignore", "pipe", "pipe"],
  }).trim();
}

// 这一段读取 package 版本，保持发布说明文件名和正式版本一致。
// Read the package version so the notes filename matches the release version.
async function readPackageVersion() {
  const packageJson = JSON.parse(await readFile(packagePath, "utf8"));
  return String(packageJson.version);
}

// 这一段校验正式版本格式，避免生成含有歧义 tag 名称的文件。
// Validate release version format so generated tag names stay unambiguous.
function assertReleaseVersion(version) {
  if (!/^[0-9]+\.[0-9]+\.[0-9]+$/.test(version)) {
    throw new Error(`release version must use MAJOR.MINOR.PATCH: ${version}`);
  }
}

// 这一段选择默认比较起点：当前版本 tag 的前一个语义化 tag。
// Select the default comparison base: the semantic tag before the current version tag.
function getPreviousReleaseTag(version) {
  const currentTag = `v${version}`;
  const tags = git(["tag", "--list", "v[0-9]*.[0-9]*.[0-9]*", "--sort=v:refname"])
    .split(/\r?\n/u)
    .map((tag) => tag.trim())
    .filter((tag) => /^v\d+\.\d+\.\d+$/u.test(tag));
  const currentIndex = tags.indexOf(currentTag);
  if (currentIndex > 0) {
    return tags[currentIndex - 1];
  }
  if (currentIndex < 0 && tags.length > 0) {
    return tags[tags.length - 1];
  }
  return null;
}

// 这一段读取提交列表，保留 hash 便于发布说明追溯到源码提交。
// Read commits with hashes so release notes can be traced back to source commits.
function readCommits(from, to) {
  const range = from ? `${from}..${to}` : to;
  const output = git(["log", "--format=%h%x09%s", "--reverse", range]);
  if (!output) {
    return [];
  }
  return output.split(/\r?\n/u).map((line) => {
    const [hash, ...subjectParts] = line.split("\t");
    return {
      hash,
      subject: subjectParts.join("\t").trim(),
    };
  });
}

// 这一段过滤发布流程噪音，避免 Release 说明被版本 bump 和代理指令占满。
// Filter release-process noise so notes are not dominated by version bumps or agent instructions.
function shouldSkipCommit(subject) {
  return (
    subject === "Agents" ||
    /^Prepare [0-9]+\.[0-9]+\.[0-9]+ release$/u.test(subject) ||
    /^Bump release version to [0-9]+\.[0-9]+\.[0-9]+$/u.test(subject)
  );
}

// 这一段按提交标题做保守分类，不把标题改写成未验证的产品承诺。
// Categorize commit subjects conservatively without rewriting them into unverified product claims.
function categorizeCommit(subject) {
  if (/^Add /u.test(subject)) return "Added";
  if (/^Fix /u.test(subject) || /^Restore /u.test(subject)) return "Fixed";
  if (/README|docs|quick start|image links|localized/u.test(subject)) return "Docs";
  return "Changed";
}

// 这一段生成 Markdown 正文，GitHub Release 和 latest.json 复用同一份内容。
// Build one Markdown body that both GitHub Release and latest.json can reuse.
function buildReleaseNotes({ commits, from, to, version }) {
  const grouped = new Map([
    ["Added", []],
    ["Changed", []],
    ["Fixed", []],
    ["Docs", []],
  ]);

  for (const commit of commits) {
    if (shouldSkipCommit(commit.subject)) {
      continue;
    }

    const category = categorizeCommit(commit.subject);
    grouped.get(category).push(`- ${commit.subject} (${commit.hash})`);
  }

  const rangeText = from ? `${from}..${to}` : to;
  const lines = [`## Changes in v${version}`, "", `Range: \`${rangeText}\``];
  let hasVisibleChanges = false;
  for (const [category, bullets] of grouped) {
    if (bullets.length === 0) {
      continue;
    }
    hasVisibleChanges = true;
    lines.push("", `### ${category}`, "", ...bullets);
  }
  if (!hasVisibleChanges) {
    lines.push("", "- Release packaging and version metadata update.");
  }

  const buildCommit = git(["rev-parse", to]);
  lines.push("", `Build commit: \`${buildCommit}\``, "");
  return lines.join("\n");
}

try {
  const options = parseArgs(process.argv.slice(2));
  const version = options.version ?? (await readPackageVersion());
  assertReleaseVersion(version);
  const from = options.from ?? getPreviousReleaseTag(version);
  const outputPath = path.resolve(
    rootDir,
    options.output ?? path.join(defaultOutputDir, `release-notes-v${version}.md`),
  );

  // 这一段生成并写入 private 构建目录，避免发布说明副产物混进公开源码树。
  // Generate and write under the private build directory so notes artifacts do not enter public source.
  const commits = readCommits(from, options.to);
  const notes = buildReleaseNotes({ commits, from, to: options.to, version });
  await mkdir(path.dirname(outputPath), { recursive: true });
  await writeFile(outputPath, notes, "utf8");
  console.log(`Release notes: ${path.relative(rootDir, outputPath)}`);
  console.log(`Version: ${version}`);
  console.log(`Range: ${from ? `${from}..${options.to}` : options.to}`);
} catch (error) {
  console.error(error.message);
  process.exit(1);
}
