import { mkdir, readFile, writeFile, rename, rm } from "node:fs/promises";
import { randomUUID } from "node:crypto";
import { join } from "node:path";
import { PluginError } from "./errors.mjs";

function object(value) {
  return value !== null && typeof value === "object" && !Array.isArray(value);
}

export async function loadState(dir) {
  try {
    const state = JSON.parse(await readFile(join(dir, "state.json"), "utf8"));
    if (!object(state) || !object(state.submitted) ||
        (state.checked !== undefined && !object(state.checked))) {
      throw new PluginError("Invalid checkpoint structure; restore state.json from a backup.");
    }
    state.checked ??= {};
    return state;
  } catch (error) {
    if (error.code === "ENOENT") return { submitted: {}, checked: {} };
    if (error instanceof SyntaxError) {
      throw new PluginError("Invalid checkpoint JSON; restore state.json from a backup.", { cause: error });
    }
    throw error;
  }
}

export async function saveState(dir, state) {
  await mkdir(dir, { recursive: true, mode: 0o700 });
  const temporary = join(dir, `.state-${randomUUID()}.tmp`);
  try {
    await writeFile(temporary, JSON.stringify(state, null, 2), { mode: 0o600, flag: "wx" });
    await rename(temporary, join(dir, "state.json"));
  } finally {
    await rm(temporary, { force: true });
  }
}
