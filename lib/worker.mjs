import { credentials } from "./config.mjs";
import { aggregate, fingerprint, yesterday } from "./aggregate.mjs";
import { loadState, saveState } from "./state.mjs";

function deviceId(name) {
  // Stable, tokens.ci-safe device id
  const safe = name.toLowerCase().replace(/[^a-z0-9._:-]/g, "-").slice(0, 40);
  return "magpie-" + (safe || "gateway");
}

export async function buildPayload(config, now = new Date()) {
  const through = yesterday(now);
  const data = await aggregate(config, { now, through });
  return {
    ...data,
    device: {
      id: deviceId(config.deviceName),
      name: config.deviceName,
    },
  };
}

export async function submit(config, payload, token) {
  const res = await fetch(`${config.apiUrl}/api/submit`, {
    method: "POST",
    headers: {
      "Content-Type": "application/json",
      Authorization: `Bearer ${token}`,
    },
    body: JSON.stringify(payload),
  });

  const text = await res.text();
  let body;
  try {
    body = JSON.parse(text);
  } catch {
    body = { raw: text };
  }

  if (!res.ok) {
    throw new Error(`tokens.ci submit failed (${res.status}): ${text.slice(0, 500)}`);
  }
  return body;
}

export async function run(config, { scheduled = false, now = new Date() } = {}) {
  const creds = await credentials(config);
  if (!creds.token) {
    return { status: "auth-blocked", reason: "no token" };
  }

  const payload = await buildPayload(config, now);
  if (!payload.contributions.length) {
    return { status: "empty", through: yesterday(now) };
  }

  const fp = fingerprint(payload);
  const state = await loadState(config.stateDir);
  const last = state.submitted[payload.meta.dateRange.end];

  if (scheduled && last?.fingerprint === fp) {
    return { status: "unchanged", date: payload.meta.dateRange.end };
  }

  const result = await submit(config, payload, creds.token);
  state.submitted[payload.meta.dateRange.end] = {
    fingerprint: fp,
    submittedAt: now.toISOString(),
    submissionId: result.submissionId,
  };
  await saveState(config.stateDir, state);

  return {
    status: "submitted",
    date: payload.meta.dateRange.end,
    days: payload.contributions.length,
    totalTokens: payload.summary.totalTokens,
    submissionId: result.submissionId,
  };
}
