import { mkdir, readFile, writeFile } from "node:fs/promises";
import { join } from "node:path";

export async function loadState(dir) {
  await mkdir(dir, { recursive: true });
  const path = join(dir, "state.json");
  try {
    return JSON.parse(await readFile(path, "utf8"));
  } catch (error) {
    if (error.code === "ENOENT") return { submitted: {} };
    throw error;
  }
}

export async function saveState(dir, state) {
  await mkdir(dir, { recursive: true });
  await writeFile(join(dir, "state.json"), JSON.stringify(state, null, 2));
}
