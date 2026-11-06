import { createHash } from "node:crypto";
import { credentials } from "./config.mjs";
import { aggregate, fingerprint, yesterday } from "./aggregate.mjs";
import { loadState, saveState } from "./state.mjs";
import { dailyUploadAt } from "./scheduler.mjs";
import { PluginError, inStage } from "./errors.mjs";

function deviceId(name) {
  const safe = name.toLowerCase().replace(/[^a-z0-9._:-]/g, "-").slice(0, 40);
  return "magpie-" + (safe || "gateway");
}

function checkpointScope(config, creds) {
  // Never persist the token itself. Token rotation intentionally starts a new scope.
  return createHash("sha256").update(JSON.stringify([
    config.apiUrl, creds.token, config.deviceName, config.usageFile, config.startDate ?? null,
  ])).digest("hex");
}

export async function buildPayload(config, now = new Date()) {
  const data = await aggregate(config, { now, through: yesterday(now) });
  return {
    ...data,
    device: { id: deviceId(config.deviceName), name: config.deviceName },
  };
}

export async function submit(config, payload, token) {
  const controller = new AbortController();
  const timer = setTimeout(() => controller.abort(), config.requestTimeoutMs ?? 30000);
  try {
    const res = await fetch(`${config.apiUrl}/api/submit`, {
      method: "POST",
      headers: { "Content-Type": "application/json", Authorization: `Bearer ${token}` },
      body: JSON.stringify(payload),
      signal: controller.signal,
      redirect: "error",
    });
    if (!res.ok) {
      await res.body?.cancel();
      throw new PluginError(`tokens.ci submit failed (HTTP ${res.status}).`);
    }
    const text = await res.text();
    try {
      return JSON.parse(text) ?? {};
    } catch {
      return {};
    }
  } catch (error) {
    if (controller.signal.aborted) throw new PluginError("tokens.ci submit timed out.");
    throw error;
  } finally {
    clearTimeout(timer);
  }
}

// Serialize calls in this process, including overlapping manual/scheduled runs.
const activeRuns = new Map();
export async function run(config, options = {}) {
  const key = config.stateDir;
  const previous = activeRuns.get(key) ?? Promise.resolve();
  const current = previous.catch(() => {}).then(() => execute(config, options));
  activeRuns.set(key, current);
  try {
    return await current;
  } finally {
    if (activeRuns.get(key) === current) activeRuns.delete(key);
  }
}

async function execute(config, { scheduled = false, now = new Date(), force = false } = {}) {
  const today = now.toISOString().slice(0, 10);
  if (scheduled && config.autoSubmit === false) return { status: "disabled" };
  if (scheduled && now.getTime() < dailyUploadAt(today)) return { status: "not-due" };

  const creds = await inStage("Authentication", () => credentials(config));
  if (!creds.token) return { status: "auth-blocked", reason: "no token" };
  // Environment tokens require explicit opt-in; saving a token enables by default.
  if (scheduled && creds.source === "environment" && config.autoSubmit !== true) {
    return { status: "disabled" };
  }

  const scope = checkpointScope(config, creds);
  const state = await inStage("Read checkpoint", () => loadState(config.stateDir));
  if (scheduled && state.checked[scope] >= today) return { status: "not-due" };

  const payload = await inStage("Read usage", () => buildPayload(config, now));
  // Retry later if the usage file has not appeared or has no eligible records yet.
  if (!payload.contributions.length) return { status: "empty", through: yesterday(now) };

  const fp = fingerprint(payload);
  const key = `${scope}:${payload.meta.dateRange.end}`;
  const last = state.submitted[key];
  if (!force && last?.fingerprint === fp) {
    if (scheduled) {
      state.checked[scope] = today;
      await inStage("Save checkpoint", () => saveState(config.stateDir, state));
    }
    return { status: "unchanged", date: payload.meta.dateRange.end };
  }

  const result = await inStage("Upload", () => submit(config, payload, creds.token));
  state.submitted[key] = {
    fingerprint: fp,
    submittedAt: now.toISOString(),
    submissionId: result.submissionId,
  };
  if (scheduled) state.checked[scope] = today;
  await inStage("Save checkpoint", () => saveState(config.stateDir, state));
  return {
    status: "submitted",
    date: payload.meta.dateRange.end,
    days: payload.contributions.length,
    totalTokens: payload.summary.totalTokens,
    submissionId: result.submissionId,
  };
}
