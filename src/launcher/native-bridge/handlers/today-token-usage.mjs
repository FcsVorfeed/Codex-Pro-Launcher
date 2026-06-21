import { createReadStream } from "node:fs";
import { readdir, stat } from "node:fs/promises";
import path from "node:path";
import { createInterface } from "node:readline";

import {
  getCodexHomeDir,
  normalizeNativeBridgeRequestId,
} from "../common.mjs";

const todayTokenUsageMaxDateLength = 10;
const todayTokenUsageMaxIsoLength = 40;
const todayTokenUsageMaxFiles = 2000;
const todayTokenUsageMaxLineBytes = 2 * 1024 * 1024;

function normalizeTodayTokenUsageDate(value) {
  // 这一段只接受 YYYY-MM-DD 日期，避免页面传入任意筛选表达式。
  // Accept only YYYY-MM-DD dates so the page cannot pass arbitrary filters.
  const date = String(value || "").trim().slice(0, todayTokenUsageMaxDateLength);
  return /^\d{4}-\d{2}-\d{2}$/u.test(date) ? date : "";
}

function normalizeTodayTokenUsageIso(value) {
  // 这一段只接受短 ISO 时间文本，供 current_date 缺失时做兜底时间窗判断。
  // Accept only short ISO timestamps for fallback window checks when current_date is absent.
  const text = String(value || "").trim().slice(0, todayTokenUsageMaxIsoLength);
  if (!text || Number.isNaN(Date.parse(text))) return "";
  return text;
}

export function parseTodayTokenUsageRequest(request) {
  // 这一段解析 Today token 聚合请求，只允许日期、时间窗和 request id。
  // Parse a Today token aggregation request, allowing only date, time window, and request id.
  const requestId = normalizeNativeBridgeRequestId(request?.requestId);
  const date = normalizeTodayTokenUsageDate(request?.date);
  const startIso = normalizeTodayTokenUsageIso(request?.startIso);
  const endIso = normalizeTodayTokenUsageIso(request?.endIso);
  const startMs = finiteTokenCount(request?.startMs);
  const endMs = finiteTokenCount(request?.endMs);
  if (!requestId || !date || !startIso || !endIso) return null;
  if (Date.parse(startIso) >= Date.parse(endIso)) return null;
  if (startMs == null || endMs == null || startMs >= endMs) return null;
  return {
    date,
    endIso,
    endMs,
    requestId,
    startIso,
    startMs,
    type: "today-token-usage",
  };
}

function finiteTokenCount(value) {
  // 这一段把日志里的 token 字段规整成非负整数，异常值直接视为缺失。
  // Normalize logged token fields into non-negative integers and treat invalid values as missing.
  const count = Number(value);
  return Number.isFinite(count) && count >= 0 ? Math.round(count) : null;
}

function isJsonlFileName(filePath) {
  // 这一段只扫描 Codex 会话 JSONL，避免读取其它本地文件。
  // Scan only Codex session JSONL files so unrelated local files are not read.
  return String(filePath || "").toLowerCase().endsWith(".jsonl");
}

async function collectJsonlFiles(rootDir) {
  // 这一段有界递归收集 JSONL 文件，限制文件数避免异常目录拖慢页面刷新。
  // Recursively collect JSONL files with a cap so unusual directories cannot slow page refreshes.
  const files = [];
  const pending = [rootDir];
  while (pending.length > 0 && files.length < todayTokenUsageMaxFiles) {
    const currentDir = pending.pop();
    let entries = [];
    try {
      entries = await readdir(currentDir, { withFileTypes: true });
    } catch {
      continue;
    }
    for (const entry of entries) {
      const entryPath = path.join(currentDir, entry.name);
      if (entry.isDirectory()) {
        pending.push(entryPath);
      } else if (entry.isFile() && isJsonlFileName(entry.name)) {
        files.push(entryPath);
        if (files.length >= todayTokenUsageMaxFiles) break;
      }
    }
  }
  return files;
}

function isEventInRequestDay({ currentDate, endMs, eventTimestamp, requestDate, startMs }) {
  // 这一段优先使用 Codex turn_context 的 current_date；缺失时才用事件时间兜底。
  // Prefer Codex turn_context current_date and only fall back to event timestamp when it is missing.
  if (currentDate) return currentDate === requestDate;
  const timestampMs = Date.parse(eventTimestamp || "");
  return Number.isFinite(timestampMs) && timestampMs >= startMs && timestampMs < endMs;
}

function readEventPayload(envelope) {
  // 这一段兼容 JSONL 外层 envelope 和少量直接 payload 形态，只返回对象。
  // Support JSONL envelopes and a few direct-payload shapes, returning objects only.
  const payload = envelope?.payload;
  return payload && typeof payload === "object" && !Array.isArray(payload) ? payload : null;
}

function readUsageBreakdown(value) {
  // 这一段只读取 token_count 的数值字段，不保留或返回任何正文内容。
  // Read only numeric token_count fields without retaining or returning transcript content.
  const source = value && typeof value === "object" && !Array.isArray(value) ? value : {};
  return {
    cachedInputTokens: finiteTokenCount(source.cached_input_tokens),
    inputTokens: finiteTokenCount(source.input_tokens),
    outputTokens: finiteTokenCount(source.output_tokens),
    reasoningOutputTokens: finiteTokenCount(source.reasoning_output_tokens),
    totalTokens: finiteTokenCount(source.total_tokens),
  };
}

async function readTokenUsageFile(filePath, request) {
  // 这一段流式读取单个 JSONL，只聚合 token_count 行，避免把原始文本载入内存。
  // Stream one JSONL file and aggregate only token_count rows without loading raw text into memory.
  let currentDate = "";
  let lastCumulativeTotal = -1;
  let events = 0;
  let skipped = 0;
  const totals = {
    cachedInputTokens: 0,
    inputTokens: 0,
    outputTokens: 0,
    reasoningOutputTokens: 0,
    totalTokens: 0,
  };
  const startMs = request.startMs;
  const endMs = request.endMs;
  const reader = createInterface({
    crlfDelay: Infinity,
    input: createReadStream(filePath, { encoding: "utf8" }),
  });
  for await (const line of reader) {
    if (!line || line.length > todayTokenUsageMaxLineBytes) {
      skipped += 1;
      continue;
    }
    let envelope = null;
    try {
      envelope = JSON.parse(line);
    } catch {
      skipped += 1;
      continue;
    }
    const payload = readEventPayload(envelope);
    if (!payload) continue;
    if (envelope.type === "turn_context") {
      const nextDate = normalizeTodayTokenUsageDate(payload.current_date);
      if (nextDate) currentDate = nextDate;
      continue;
    }
    if (envelope.type !== "event_msg" || payload.type !== "token_count") continue;
    const info = payload.info && typeof payload.info === "object" && !Array.isArray(payload.info)
      ? payload.info
      : null;
    const totalUsage = info?.total_token_usage;
    const lastUsage = info?.last_token_usage;
    const cumulativeTotal = finiteTokenCount(totalUsage?.total_tokens);
    const lastBreakdown = readUsageBreakdown(lastUsage);
    if (cumulativeTotal == null || lastBreakdown.totalTokens == null) {
      skipped += 1;
      continue;
    }
    if (cumulativeTotal <= lastCumulativeTotal) continue;
    lastCumulativeTotal = cumulativeTotal;
    if (!isEventInRequestDay({
      currentDate,
      endMs,
      eventTimestamp: envelope.timestamp,
      requestDate: request.date,
      startMs,
    })) {
      continue;
    }
    events += 1;
    totals.cachedInputTokens += lastBreakdown.cachedInputTokens ?? 0;
    totals.inputTokens += lastBreakdown.inputTokens ?? 0;
    totals.outputTokens += lastBreakdown.outputTokens ?? 0;
    totals.reasoningOutputTokens += lastBreakdown.reasoningOutputTokens ?? 0;
    totals.totalTokens += lastBreakdown.totalTokens;
  }
  return { events, skipped, totals };
}

async function maybeRecentJsonlFile(filePath, startMs, endMs) {
  // 这一段用 mtime 预筛近期文件，保留一天余量避免文件系统时间轻微漂移导致漏计。
  // Use mtime to prefilter recent files with a one-day margin to avoid minor filesystem clock drift.
  try {
    const info = await stat(filePath);
    const marginMs = 24 * 60 * 60 * 1000;
    return info.isFile() && info.mtimeMs >= startMs - marginMs && info.mtimeMs < endMs + marginMs;
  } catch {
    return false;
  }
}

export async function readTodayTokenUsage(request) {
  // 这一段从本机 Codex 会话日志聚合 Today token，只返回聚合数字和诊断计数。
  // Aggregate Today tokens from local Codex session logs and return only totals plus diagnostic counts.
  const codexHome = getCodexHomeDir();
  const roots = [
    path.join(codexHome, "sessions"),
    path.join(codexHome, "archived_sessions"),
  ];
  const startMs = request.startMs;
  const endMs = request.endMs;
  const files = [];
  for (const root of roots) {
    files.push(...await collectJsonlFiles(root));
  }
  const totals = {
    cachedInputTokens: 0,
    inputTokens: 0,
    outputTokens: 0,
    reasoningOutputTokens: 0,
    totalTokens: 0,
  };
  let scannedFiles = 0;
  let eventCount = 0;
  let skippedEvents = 0;
  for (const filePath of files) {
    if (!await maybeRecentJsonlFile(filePath, startMs, endMs)) continue;
    scannedFiles += 1;
    try {
      const result = await readTokenUsageFile(filePath, request);
      eventCount += result.events;
      skippedEvents += result.skipped;
      totals.cachedInputTokens += result.totals.cachedInputTokens;
      totals.inputTokens += result.totals.inputTokens;
      totals.outputTokens += result.totals.outputTokens;
      totals.reasoningOutputTokens += result.totals.reasoningOutputTokens;
      totals.totalTokens += result.totals.totalTokens;
    } catch {
      skippedEvents += 1;
    }
  }
  return {
    data: {
      date: request.date,
      eventCount,
      scannedFiles,
      skippedEvents,
      source: "observer",
      ...totals,
    },
    error: "",
    ok: true,
    status: 200,
  };
}
