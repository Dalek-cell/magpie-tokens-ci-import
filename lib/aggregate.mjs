import { createReadStream } from "node:fs";
import { createHash } from "node:crypto";
import { VERSION, validDate } from "./config.mjs";

const BUCKETS = ["input", "output", "cacheRead", "cacheWrite", "reasoning"];
const emptyTokens = () => Object.fromEntries(BUCKETS.map((key) => [key, 0]));

function safeInteger(value) {
  return Number.isSafeInteger(value) && value >= 0;
}

function sum(tokens) {
  return BUCKETS.reduce((value, key) => value + (tokens[key] || 0), 0);
}

export function yesterday(now) {
  const today = now.toISOString().slice(0, 10);
  return new Date(new Date(today + "T00:00:00Z").getTime() - 86400000).toISOString().slice(0, 10);
}

function normalizeClient(raw) {
  if (typeof raw !== "string" || !raw.trim()) return "unknown";
  const lower = raw.toLowerCase().trim();
  const aliases = {
    "claude-code": "claude",
    "claude code": "claude",
    "hermes-agent": "hermes",
    "pi-coding-agent": "pi",
  };
  return aliases[lower] || lower.replace(/[^a-z0-9._-]/g, "-").slice(0, 40);
}

export function normalize(record) {
  if (!record || typeof record !== "object" || Array.isArray(record)) {
    throw new Error("Invalid record.");
  }
  if (typeof record.t !== "string" || !/^\d{4}-\d\d-\d\dT.*(?:Z|[+-]\d\d:\d\d)$/.test(record.t)) {
    throw new Error("Invalid timestamp.");
  }
  const date = record.t.slice(0, 10);
  if (!validDate(date)) throw new Error("Invalid timestamp.");

  const counts = ["in", "out", "cache_read", "cache_write", "reasoning"].map((key) => record[key] ?? 0);
  if (!counts.every(safeInteger)) throw new Error("Invalid tokens.");

  const [input, output, cacheRead, cacheWrite, reasoning] = counts;
  const tokens = { input, output, cacheRead, cacheWrite, reasoning };

  return {
    date,
    client: normalizeClient(record.via || record.agent || "magpie"),
    model: typeof record.model === "string" && record.model ? record.model : "unknown",
    tokens,
    messages: 1,
    cost: typeof record.cost === "number" && Number.isFinite(record.cost) && record.cost >= 0 ? record.cost : 0,
  };
}

async function* lines(path) {
  let pending = Buffer.alloc(0);
  for await (const chunk of createReadStream(path)) {
    pending = pending.length ? Buffer.concat([pending, chunk]) : chunk;
    let offset = 0;
    let index;
    while ((index = pending.indexOf(10, offset)) !== -1) {
      if (index - offset > 1024 * 1024) throw new Error("Usage line exceeds 1 MiB.");
      yield pending.subarray(offset, index).toString("utf8");
      offset = index + 1;
    }
  }
  if (pending.length > offset) {
    yield pending.subarray(offset).toString("utf8");
  }
}

export async function aggregate(config, { now = new Date(), through = yesterday(now) } = {}) {
  const byDay = new Map();

  try {
    for await (const line of lines(config.usageFile)) {
      const trimmed = line.trim();
      if (!trimmed) continue;
      let record;
      try {
        record = normalize(JSON.parse(trimmed));
      } catch {
        continue;
      }
      if (config.startDate && record.date < config.startDate) continue;
      if (record.date > through) continue;

      let day = byDay.get(record.date);
      if (!day) {
        day = {
          date: record.date,
          totals: { tokens: 0, cost: 0, messages: 0 },
          tokenBreakdown: emptyTokens(),
          clients: new Map(),
        };
        byDay.set(record.date, day);
      }

      const total = sum(record.tokens);
      day.totals.tokens += total;
      day.totals.cost += record.cost;
      day.totals.messages += record.messages;
      for (const key of BUCKETS) day.tokenBreakdown[key] += record.tokens[key] || 0;

      const key = record.client + "\0" + record.model;
      let entry = day.clients.get(key);
      if (!entry) {
        entry = {
          client: record.client,
          modelId: record.model,
          tokens: emptyTokens(),
          cost: 0,
          messages: 0,
        };
        day.clients.set(key, entry);
      }
      for (const k of BUCKETS) entry.tokens[k] += record.tokens[k] || 0;
      entry.cost += record.cost;
      entry.messages += record.messages;
    }
  } catch (error) {
    if (error.code !== "ENOENT") throw error;
  }

  const contributions = [...byDay.values()]
    .sort((a, b) => a.date.localeCompare(b.date))
    .map((day) => ({
      date: day.date,
      totals: day.totals,
      intensity: Math.min(4, Math.floor(Math.log10(Math.max(1, day.totals.tokens)))),
      tokenBreakdown: day.tokenBreakdown,
      clients: [...day.clients.values()],
    }));

  const allClients = new Set();
  const allModels = new Set();
  let totalTokens = 0;
  let totalCost = 0;
  let maxCost = 0;

  for (const day of contributions) {
    totalTokens += day.totals.tokens;
    totalCost += day.totals.cost;
    maxCost = Math.max(maxCost, day.totals.cost);
    for (const c of day.clients) {
      allClients.add(c.client);
      allModels.add(c.modelId);
    }
  }

  const dates = contributions.map((d) => d.date);
  const start = dates[0] || through;
  const end = dates[dates.length - 1] || through;

  return {
    meta: {
      generatedAt: now.toISOString(),
      version: VERSION,
      dateRange: { start, end },
    },
    summary: {
      totalTokens,
      totalCost,
      totalDays: contributions.length,
      activeDays: contributions.length,
      averagePerDay: contributions.length ? totalTokens / contributions.length : 0,
      maxCostInSingleDay: maxCost,
      clients: [...allClients],
      models: [...allModels],
    },
    years: [],
    contributions,
    timeMetrics: null,
    mcpServers: null,
  };
}

export function fingerprint(payload) {
  return createHash("sha256").update(JSON.stringify(payload.contributions)).digest("hex").slice(0, 16);
}
