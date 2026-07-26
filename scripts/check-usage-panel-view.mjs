import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import vm from "node:vm";

const source = readFileSync(new URL("../src/inject/systems/usage-panel/view.js", import.meta.url), "utf8");
const apiSource = readFileSync(new URL("../src/inject/systems/usage-panel/usage-api.js", import.meta.url), "utf8");
const formatSource = readFileSync(new URL("../src/inject/systems/usage-panel/format.js", import.meta.url), "utf8");
const indexSource = readFileSync(new URL("../src/inject/systems/usage-panel/index.js", import.meta.url), "utf8");

// 这一段在隔离上下文中加载格式化模块，直接验证真实额度响应的归一化结果。
// Load the formatter in an isolated context so real quota response shapes are validated directly.
const formatRuntime = {
  i18n: {
    resolveLocale: () => "zh-CN",
    t: (key) => ({
      "usage.date.monthDay": "{month}月{day}日",
      "usage.window.fiveHours": "5 小时",
      "usage.window.oneWeek": "1 周",
    })[key] || key,
  },
  systemModules: {},
};
vm.runInNewContext(formatSource, { window: { __codexProRuntime: formatRuntime } });
const normalizeUsageRows = formatRuntime.systemModules.usagePanel.format.normalizeUsageRows;

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
assert.match(
  apiSource,
  /expiresAtList,/u,
  "reset credits API must expose the sanitized expiry list for hover details",
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
assert.match(
  formatSource,
  /function formatResetCreditTooltip[\s\S]*join\("\\n"\)/u,
  "reset credit hover title must format every expiry as multiline text",
);
assert.match(
  formatSource,
  /title:\s*formatResetCreditTooltip\(resetCredits\)/u,
  "reset credits row must carry hover title details",
);
assert.doesNotMatch(
  formatSource,
  /YYYY-MM-DD|formatIsoDate/u,
  "reset credit expiry must not use a fixed year-including ISO date format",
);

// 这一段覆盖官方暂时移除 5 小时额度、只把周额度放进 primary 的当前响应。
// Cover the current response where five-hour quota is absent and weekly quota is placed in primary.
const weeklyOnlyRows = normalizeUsageRows({
  rate_limit: {
    primary_window: {
      limit_window_seconds: 604_800,
      reset_at: 1_785_672_595,
      used_percent: 28,
    },
    secondary_window: null,
  },
});
assert.equal(weeklyOnlyRows[0].label, "5 小时", "missing five-hour quota must keep the five-hour label");
assert.equal(weeklyOnlyRows[0].value, "--% --:--", "missing five-hour quota must keep placeholder values");
assert.equal(weeklyOnlyRows[1].label, "1 周", "weekly quota must keep the weekly label");
assert.match(weeklyOnlyRows[1].value, /^72% /u, "weekly quota must keep its real remaining percentage");

// 这一段覆盖官方恢复两种额度后的正常响应，并验证字段顺序变化不会影响固定展示顺序。
// Cover the restored two-quota response and verify field order changes cannot affect the fixed display order.
const restoredRows = normalizeUsageRows({
  rate_limit: {
    primary_window: {
      limit_window_seconds: 604_800,
      reset_at: 1_785_672_595,
      used_percent: 28,
    },
    secondary_window: {
      limit_window_seconds: 18_000,
      reset_at: 1_785_672_595,
      used_percent: 10,
    },
  },
});
assert.equal(restoredRows[0].label, "5 小时", "restored five-hour quota must return to the first row");
assert.match(restoredRows[0].value, /^90% /u, "restored five-hour quota must use its real percentage");
assert.equal(restoredRows[1].label, "1 周", "restored weekly quota must remain in the second row");
assert.match(restoredRows[1].value, /^72% /u, "restored weekly quota must use its real percentage");
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
assert.match(
  source,
  /rowElement\.title\s*=\s*row\.title/u,
  "usage rows must apply row title text for native hover details",
);
assert.match(
  source,
  /removeAttribute\("title"\)/u,
  "usage rows must remove stale native title text when details disappear",
);

console.log("usage panel view checks passed");
