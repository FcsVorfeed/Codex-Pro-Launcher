import assert from "node:assert/strict";
import { readFileSync } from "node:fs";

const source = readFileSync(new URL("../src/inject/systems/usage-panel/view.js", import.meta.url), "utf8");
const apiSource = readFileSync(new URL("../src/inject/systems/usage-panel/usage-api.js", import.meta.url), "utf8");
const formatSource = readFileSync(new URL("../src/inject/systems/usage-panel/format.js", import.meta.url), "utf8");
const indexSource = readFileSync(new URL("../src/inject/systems/usage-panel/index.js", import.meta.url), "utf8");

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

assert.match(
  apiSource,
  /const resetCreditsEndpoint\s*=\s*"\/wham\/rate-limit-reset-credits"/u,
  "reset credits API must use the read-only reset-credit endpoint",
);
assert.match(
  apiSource,
  /requestJson\(resetCreditsEndpoint,\s*\{\s*method:\s*"GET",\s*signal\s*\}\)/u,
  "reset credits API must explicitly use GET",
);
assert.doesNotMatch(
  apiSource,
  /rate-limit-reset-credits\/consume/u,
  "reset credits API must not reference the consuming endpoint",
);
assert.match(
  formatSource,
  /key:\s*"reset-credits"/u,
  "reset credits must render as its own usage row",
);
assert.match(
  formatSource,
  /function formatResetCreditExpiry[\s\S]*formatUsageDate\(date,\s*"--"\)/u,
  "reset credit expiry must reuse the quota-window date formatter",
);
assert.doesNotMatch(
  formatSource,
  /YYYY-MM-DD|formatIsoDate/u,
  "reset credit expiry must not use a fixed year-including ISO date format",
);
assert.match(
  indexSource,
  /showUsagePanelResetCredits !== false/u,
  "reset credits row must be controlled by an explicit visible-by-default setting",
);
assert.match(
  indexSource,
  /usagePanelResetCreditsRefreshSeconds/u,
  "reset credits refresh interval must be configurable",
);
assert.match(
  source,
  /onPanelVisible/u,
  "environment panel binding must notify when the panel becomes visible",
);

console.log("usage panel view checks passed");
