import { AUTH_PROVIDER, configuration } from "./lib/config.mjs";
import { DAILY_UPLOAD_TIME, startDailyScheduler } from "./lib/scheduler.mjs";
import { run } from "./lib/worker.mjs";

export default {
  id: "magpie-tokens-ci-import",
  async server(input, options = {}) {
    if (input?.project?.id !== "magpie") {
      throw new Error("This plugin needs Magpie. Use it inside Magpie.");
    }

    const settings = configuration(options, input.directory);
    let stopScheduler;
    let lastLog;

    const log = async (message, level = "info") => {
      if (message === lastLog) return;
      try {
        await input.client.app.log({ body: { service: "tokens-ci-import", level, message } });
      } catch {
        console.error("[tokens-ci-import] " + message);
      }
      lastLog = message;
    };

    return {
      async config(config) {
        config.provider ??= {};
        config.provider[AUTH_PROVIDER] ??= { name: "tokens.ci Import", models: {} };

        stopScheduler ??= startDailyScheduler(async (now) => {
          const result = await run(settings, { scheduled: true, now });
          if (["not-due", "unchanged", "empty"].includes(result.status)) return;
          const level = result.status === "auth-blocked" ? "error" : "info";
          await log(JSON.stringify(result), level);
        }, (message) => log(message, "error"));
      },
      auth: {
        provider: AUTH_PROVIDER,
        methods: [
          {
            type: "api",
            label: process.env.TOKENS_API_TOKEN
              ? `API token — TOKENS_API_TOKEN overrides saved keys. Daily uploads are ${settings.autoSubmit === true ? `enabled (${DAILY_UPLOAD_TIME} UTC)` : "disabled; set autoSubmit to true"}.`
              : settings.autoSubmit === false
                ? "API token — automatic uploads are disabled."
                : `API token — saving enables daily uploads to tokens.ci at ${DAILY_UPLOAD_TIME} UTC.`,
            placeholder: "Paste your tokens.ci API token (from tokens login or TOKENS_API_TOKEN)",
          },
        ],
      },
    };
  },
};
