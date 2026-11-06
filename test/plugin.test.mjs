import test from "node:test";
import assert from "node:assert/strict";
import { mkdtemp, writeFile, readFile, readdir, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { createServer } from "node:http";
import { aggregate, normalize } from "../lib/aggregate.mjs";
import { run, submit } from "../lib/worker.mjs";
import { loadState, saveState } from "../lib/state.mjs";
import { startDailyScheduler } from "../lib/scheduler.mjs";
import { PluginError, errorSummary } from "../lib/errors.mjs";

const now = new Date("2026-11-06T00:10:00Z");
const record = { t: "2026-11-05T12:00:00Z", agent: "magpie", model: "test", in: 10, out: 5 };
async function fixture(t) {
  const dir = await mkdtemp(join(tmpdir(), "magpie-test-"));
  t.after(() => rm(dir, { recursive: true, force: true }));
  const config = { magpieDir: dir, usageFile: join(dir, "usage.jsonl"), stateDir: join(dir, "state"), deviceName: "Test", apiUrl: "https://unused.invalid" };
  await writeFile(config.usageFile, JSON.stringify(record) + "\n");
  await writeFile(join(dir, "plugin-auth.json"), JSON.stringify({ "tokens-ci-import": { type: "api", key: "test-token" } }));
  return config;
}
function mockSubmit(t, status = 200) {
  const calls = [];
  t.mock.method(globalThis, "fetch", async (url, options) => {
    calls.push({ url, options, payload: JSON.parse(options.body) });
    return new Response(JSON.stringify({ submissionId: "test-submission" }), { status });
  });
  return calls;
}

test("aggregation handles empty, missing, and unterminated files", async (t) => {
  const config = await fixture(t);
  assert.equal((await aggregate(config, { now })).summary.totalTokens, 15);
  await writeFile(config.usageFile, JSON.stringify(record));
  assert.equal((await aggregate(config, { now })).summary.totalTokens, 15);
  await writeFile(config.usageFile, "");
  assert.equal((await aggregate(config, { now })).contributions.length, 0);
  await rm(config.usageFile);
  assert.equal((await aggregate(config, { now })).contributions.length, 0);
});

test("multi-chunk UTF-8 records are counted exactly once", async (t) => {
  const config = await fixture(t);
  const row = JSON.stringify({ ...record, model: "测试模型" });
  await writeFile(config.usageFile, (row + "\r\n").repeat(6000) + row);
  const result = await aggregate(config, { now });
  assert.equal(result.summary.totalTokens, 6001 * 15);
  assert.equal(result.contributions[0].totals.messages, 6001);
  assert.deepEqual(result.summary.models, ["测试模型"]);
});

test("oversized lines are rejected with and without a newline", async (t) => {
  const config = await fixture(t);
  for (const ending of ["", "\n"]) {
    await writeFile(config.usageFile, "x".repeat(1024 * 1024 + 1) + ending);
    await assert.rejects(aggregate(config, { now }), /exceeds 1 MiB/);
  }
});

test("timestamps are validated and grouped by UTC date", () => {
  assert.equal(normalize({ ...record, t: "2026-11-06T00:30:00+08:00" }).date, "2026-11-05");
  assert.equal(normalize({ ...record, t: "2026-11-05T23:30:00-08:00" }).date, "2026-11-06");
  for (const t of ["2026-11-05TbadZ", "2026-02-30T12:00:00Z", "2026-11-05T99:00:00Z"]) {
    assert.throws(() => normalize({ ...record, t }), /Invalid timestamp/);
  }
});

test("only explicit Magpie sources enter the Claude compatibility bucket", async (t) => {
  const config = await fixture(t);
  const sources = ["magpie", " MAGPIE ", "claude", "codex", "opencode", "Charm-Crush", "curl", "RikkaHub-Android", "", null];
  const records = sources.map(agent => ({ ...record, agent }));
  records.push({ ...record, via: "codex" });
  await writeFile(config.usageFile, records.map(r => JSON.stringify(r)).join("\n"));
  const payload = await aggregate(config, { now });
  assert.equal(Object.hasOwn(payload, "timeMetrics"), false);
  assert.equal(Object.hasOwn(payload, "mcpServers"), false);
  assert.deepEqual(payload.summary.clients, ["claude"]);
  assert.equal(payload.summary.totalTokens, 30);
  assert.equal(payload.contributions[0].totals.messages, 2);
  assert.equal(payload.contributions[0].clients[0].client, "claude");
  await writeFile(config.usageFile, JSON.stringify({ ...record, agent: "opencode" }));
  assert.equal((await aggregate(config, { now })).contributions.length, 0);
});

test("invalid records and current UTC day are excluded", async (t) => {
  const config = await fixture(t);
  await writeFile(config.usageFile, ["bad json", JSON.stringify(record), JSON.stringify({ ...record, in: -1 }), JSON.stringify({ ...record, t: "2026-11-06T12:00:00Z" })].join("\n"));
  assert.equal((await aggregate(config, { now })).summary.totalTokens, 15);
});

test("automatic uploads honor opt-out and 00:10 UTC gate before reading files", async (t) => {
  const config = await fixture(t);
  const calls = mockSubmit(t);
  await writeFile(join(config.magpieDir, "plugin-auth.json"), "invalid");
  assert.equal((await run({ ...config, autoSubmit: false }, { scheduled: true, now })).status, "disabled");
  assert.equal((await run(config, { scheduled: true, now: new Date("2026-11-06T00:09:59Z") })).status, "not-due");
  assert.equal(calls.length, 0);
});

test("daily checkpoint survives restart and avoids rereading usage", async (t) => {
  const config = await fixture(t);
  const calls = mockSubmit(t);
  assert.equal((await run(config, { scheduled: true, now })).status, "submitted");
  await writeFile(config.usageFile, "x".repeat(1024 * 1024 + 1));
  assert.equal((await run({ ...config }, { scheduled: true, now })).status, "not-due");
  await writeFile(config.usageFile, JSON.stringify(record));
  assert.equal((await run(config, { scheduled: true, now: new Date("2026-11-07T00:10:00Z") })).status, "unchanged");
  assert.equal(calls.length, 1);
});

test("manual runs bypass schedule but deduplicate unless force is explicit", async (t) => {
  const config = await fixture(t);
  const calls = mockSubmit(t);
  const options = { now: new Date("2026-11-06T00:01:00Z") };
  assert.equal((await run({ ...config, autoSubmit: false }, options)).status, "submitted");
  assert.equal((await run(config, options)).status, "unchanged");
  assert.equal((await run(config, { ...options, force: true })).status, "submitted");
  assert.equal(calls.length, 2);
});

test("checkpoint scope changes for endpoint, device and credential", async (t) => {
  const config = await fixture(t);
  const calls = mockSubmit(t);
  for (const candidate of [config, { ...config, apiUrl: "https://another.invalid" }, { ...config, deviceName: "Another" }]) {
    assert.equal((await run(candidate, { scheduled: true, now })).status, "submitted");
  }
  await writeFile(join(config.magpieDir, "plugin-auth.json"), JSON.stringify({ "tokens-ci-import": { type: "api", key: "new-token" } }));
  assert.equal((await run(config, { scheduled: true, now })).status, "submitted");
  const state = await readFile(join(config.stateDir, "state.json"), "utf8");
  assert.ok(!state.includes("test-token") && !state.includes("new-token"));
  assert.equal(calls.length, 4);
});

test("overlapping scheduled runs submit once", async (t) => {
  const config = await fixture(t);
  const calls = mockSubmit(t);
  const results = await Promise.all([run(config, { scheduled: true, now }), run(config, { scheduled: true, now })]);
  assert.deepEqual(results.map(r => r.status), ["submitted", "not-due"]);
  assert.equal(calls.length, 1);
});

test("failed uploads do not checkpoint and can be retried", async (t) => {
  const config = await fixture(t);
  const calls = mockSubmit(t, 401);
  await assert.rejects(run(config, { scheduled: true, now }), /Upload: tokens.ci submit failed \(HTTP 401\)/);
  assert.deepEqual((await loadState(config.stateDir)).checked, {});
  t.mock.restoreAll();
  mockSubmit(t);
  assert.equal((await run(config, { scheduled: true, now })).status, "submitted");
  assert.equal(calls.length, 1);
});

test("state replacement is atomic and malformed checkpoints have actionable errors", async (t) => {
  const config = await fixture(t);
  await saveState(config.stateDir, { submitted: {}, checked: {} });
  await saveState(config.stateDir, { submitted: { test: { fingerprint: "abc" } }, checked: {} });
  assert.equal((await loadState(config.stateDir)).submitted.test.fingerprint, "abc");
  assert.deepEqual(await readdir(config.stateDir), ["state.json"]);
  const cyclic = {}; cyclic.self = cyclic;
  await assert.rejects(saveState(config.stateDir, cyclic), /circular/i);
  assert.equal((await loadState(config.stateDir)).submitted.test.fingerprint, "abc");
  await writeFile(join(config.stateDir, "state.json"), "{");
  await assert.rejects(loadState(config.stateDir), /Invalid checkpoint JSON/);
});

test("timeout covers a response body that stalls after headers", async (t) => {
  const server = createServer((req, res) => {
    req.resume();
    res.writeHead(200, { "Content-Type": "application/json" });
    res.flushHeaders();
    res.write("{");
  });
  await new Promise(resolve => server.listen(0, "127.0.0.1", resolve));
  t.after(() => { server.closeAllConnections(); server.close(); });
  await assert.rejects(submit({ apiUrl: `http://127.0.0.1:${server.address().port}`, requestTimeoutMs: 100 }, {}, "fake-token"), /timed out/);
});

test("environment credentials require explicit automatic opt-in", async (t) => {
  const config = await fixture(t);
  const before = process.env.TOKENS_API_TOKEN;
  process.env.TOKENS_API_TOKEN = "environment-test-token";
  t.after(() => { if (before === undefined) delete process.env.TOKENS_API_TOKEN; else process.env.TOKENS_API_TOKEN = before; });
  const calls = mockSubmit(t);
  assert.equal((await run(config, { scheduled: true, now })).status, "disabled");
  assert.equal((await run({ ...config, autoSubmit: true }, { scheduled: true, now })).status, "submitted");
  assert.equal(calls.length, 1);
});

test("diagnostics preserve stage/status but exclude arbitrary secret text", () => {
  assert.equal(errorSummary(new Error("Bearer super-secret")), "Error");
  assert.equal(errorSummary(new ReferenceError("private/path secret")), "ReferenceError");
  assert.equal(errorSummary(new PluginError("Upload: HTTP 401")), "Upload: HTTP 401");
  assert.equal(errorSummary(Object.assign(new Error("secret"), { code: "EACCES" })), "Error (EACCES)");
});

test("scheduler logs sanitized errors and can be stopped", async () => {
  let stop;
  const message = await new Promise(resolve => {
    stop = startDailyScheduler(async () => { throw new ReferenceError("secret-token"); }, resolve);
  });
  stop();
  assert.match(message, /ReferenceError/);
  assert.ok(!message.includes("secret-token"));
});
