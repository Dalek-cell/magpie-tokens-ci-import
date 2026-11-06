import { homedir } from "node:os";
import { isAbsolute, join, resolve } from "node:path";
import { readFile } from "node:fs/promises";

export const AUTH_PROVIDER = "tokens-ci-import";
// tokens.ci persists meta.version in a varchar(20) column: send semver only.
export const VERSION = "0.1.3";
export const DEFAULT_API_URL = "https://tokens.ci";

export function validDate(value) {
  if (typeof value !== "string" || !/^\d{4}-\d{2}-\d{2}$/.test(value)) return false;
  const date = new Date(value + "T00:00:00Z");
  return Number.isFinite(date.getTime()) && date.toISOString().slice(0, 10) === value;
}

export function configuration(options = {}, directory) {
  if (!options || typeof options !== "object" || Array.isArray(options)) {
    throw new Error("Plugin options must be an object.");
  }
  for (const key of ["token", "apiKey", "apiToken", "key"]) {
    if (key in options) {
      throw new Error("Do not store secrets in plugin options. Use tokens.ci Import sign-in or TOKENS_API_TOKEN.");
    }
  }

  const env = process.env;
  const configHome = isAbsolute(env.XDG_CONFIG_HOME || "") ? env.XDG_CONFIG_HOME : join(homedir(), ".config");
  const path = (value, fallback) => {
    if (value !== undefined && (typeof value !== "string" || !value.trim())) {
      throw new Error("Configured paths must be nonempty strings.");
    }
    return resolve(value ?? fallback);
  };

  const magpieDir = path(options.magpieDir ?? env.MAGPIE_DIR, directory || join(configHome, "magpie"));
  const startDate = options.startDate ?? env.TOKENS_CI_START_DATE;
  if (startDate !== undefined && !validDate(startDate)) {
    throw new Error("startDate must be a real YYYY-MM-DD date.");
  }

  let autoSubmit = options.autoSubmit;
  if (autoSubmit !== undefined && typeof autoSubmit !== "boolean") {
    throw new Error("autoSubmit must be boolean.");
  }
  if (env.TOKENS_CI_AUTO_SUBMIT !== undefined) {
    if (!["true", "false"].includes(env.TOKENS_CI_AUTO_SUBMIT)) {
      throw new Error("TOKENS_CI_AUTO_SUBMIT must be true or false.");
    }
    autoSubmit = env.TOKENS_CI_AUTO_SUBMIT === "true";
  }

  const apiUrl = (options.apiUrl ?? env.TOKENS_API_URL ?? DEFAULT_API_URL).replace(/\/+$/, "");

  return {
    magpieDir,
    startDate,
    autoSubmit,
    apiUrl,
    usageFile: path(options.usageFile ?? env.TOKENS_CI_USAGE_FILE, join(magpieDir, "usage.jsonl")),
    stateDir: path(options.stateDir ?? env.TOKENS_CI_STATE_DIR, join(magpieDir, "tokens-ci-import")),
    deviceName: options.deviceName ?? env.TOKENS_CI_DEVICE_NAME ?? "Magpie",
  };
}

export async function readJSON(path, optional = false) {
  try {
    return JSON.parse(await readFile(path, "utf8"));
  } catch (error) {
    if (optional && error.code === "ENOENT") return undefined;
    throw new Error("Cannot read valid JSON from " + path + ".", { cause: error });
  }
}

export async function credentials(config) {
  const envToken = process.env.TOKENS_API_TOKEN;
  if (envToken !== undefined) {
    return { token: checkedToken(envToken), source: "environment" };
  }

  const auth = await readJSON(join(config.magpieDir, "plugin-auth.json"), true);
  if (auth === undefined) return {};

  if (!auth || typeof auth !== "object" || Array.isArray(auth)) {
    throw new Error("Invalid Magpie authentication storage.");
  }

  const entries = Object.entries(auth).filter(
    ([id]) => id === AUTH_PROVIDER || id.startsWith(AUTH_PROVIDER + "#")
  );
  if (!entries.length) return {};

  const value = entries[0][1];
  if (value?.type !== "api") throw new Error("tokens.ci sign-in must be an API key.");
  return { token: checkedToken(value.key), source: "saved", account: entries[0][0] };
}

function checkedToken(value) {
  if (typeof value !== "string" || !value || value.length > 4096 || /\s/.test(value)) {
    throw new Error("Invalid tokens.ci API token. Update sign-in or TOKENS_API_TOKEN.");
  }
  return value;
}
