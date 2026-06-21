import assert from "node:assert/strict";
import { readFileSync } from "node:fs";

const source = readFileSync(new URL("../src/inject/systems/usage-panel/view.js", import.meta.url), "utf8");

function bodyOfFunction(name) {
  // 这一段用轻量括号匹配提取函数体，避免只靠全文件字符串误判调用路径。
  // Extract a function body with lightweight brace matching so assertions do not only rely on whole-file text.
  const marker = `function ${name}`;
  const start = source.indexOf(marker);
  assert.notEqual(start, -1, `${name} must exist`);
  const openBrace = source.indexOf("{", start);
  assert.notEqual(openBrace, -1, `${name} must have a body`);
  let depth = 0;
  for (let index = openBrace; index < source.length; index += 1) {
    const char = source[index];
    if (char === "{") depth += 1;
    if (char === "}") depth -= 1;
    if (depth === 0) return source.slice(openBrace + 1, index);
  }
  throw new Error(`${name} body is not closed`);
}

const titleSyncBody = bodyOfFunction("syncEnvironmentUsageTitle");
assert.match(
  titleSyncBody,
  /const nextTitle\s*=\s*i18n\.t\("usage\.title"\)/u,
  "environment usage title sync must write the active usage.title translation",
);
assert.match(
  titleSyncBody,
  /dataset\.codexProUsageTitleLocale/u,
  "environment usage title sync must cache locale on the section",
);
assert.match(
  titleSyncBody,
  /dataset\.codexProUsageTitleText/u,
  "environment usage title sync must cache title text on the section",
);
assert.match(
  titleSyncBody,
  /return;\s*\}\s*const titleElement/u,
  "environment usage title sync must skip title-node lookup when locale and text are unchanged",
);

for (const name of [
  "ensureEnvironmentUsageSection",
  "renderEnvironmentUsageRows",
  "renderEnvironmentUsageStatus",
  "renderEnvironmentUsageSnapshot",
]) {
  assert.match(
    bodyOfFunction(name),
    /syncEnvironmentUsageTitle\(/u,
    `${name} must refresh the environment usage title so language changes cannot leave stale copy`,
  );
}

console.log("usage panel view checks passed");
