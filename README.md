# magpie-tokens-ci-import

Submit Magpie usage snapshots to [tokens.ci](https://tokens.ci).

This plugin runs inside Magpie. It reads `usage.jsonl`, aggregates by UTC day, and posts to `POST /api/submit` on tokens.ci.

## Install

### From GitHub

```bash
magpie plugin add github:Dalek-cell/magpie-tokens-ci-import
```

### Local folder

```bash
magpie plugin add /path/to/magpie-tokens-ci-import
```

After install, restart Magpie (or the Docker container).

## Configure

1. Get a tokens.ci API token:
   - Run `npx tokens-cli@latest login` (or `tokens login`)
   - Or set the environment variable `TOKENS_API_TOKEN`
2. In Magpie → Plugins → tokens.ci Import, paste the token and save.
3. Optional: set `autoSubmit: true` in plugin options (enabled by default after sign-in).

Uploads run daily at **00:10 UTC (08:10 China Standard Time)**. Only completed UTC days are submitted. If Magpie starts after that time, the plugin catches up on startup. After a successful upload or an unchanged-data check, it skips further scheduled work for that UTC day, including after a restart. Failed attempts are retried approximately once a minute; empty data is checked again later.

Set `autoSubmit: false` (or `TOKENS_CI_AUTO_SUBMIT=false`) to disable automatic uploads. A token saved through Magpie enables automatic uploads by default. When using `TOKENS_API_TOKEN`, explicitly set `autoSubmit: true` or `TOKENS_CI_AUTO_SUBMIT=true` to enable automatic uploads.

Requests time out after 30 seconds, including reading the response body. Errors identify the failing stage and HTTP status or error type without printing credentials or server response bodies.

## Manual upload

With Node.js 20+ available, run this from the plugin directory, using the same operating-system user and environment as Magpie:

```bash
node --input-type=module -e '
import { configuration } from "./lib/config.mjs";
import { run } from "./lib/worker.mjs";
console.log(await run(configuration()));
'
```

Manual uploads bypass the daily schedule and the automatic-upload switch, but still skip unchanged data and exclude the current UTC day. To intentionally resend unchanged data, call `run(configuration(), { force: true })`. If Magpie uses custom plugin options, pass the same options to `configuration(...)`; for example, `configuration({ magpieDir: "/config/magpie" })` in Docker. The standard Magpie image may not expose a standalone `node` command.

Checkpoints are isolated by API endpoint, token, device name, usage path and start date. A token change intentionally starts a new checkpoint scope; tokens themselves are never stored in the checkpoint. Upgrading from 0.1.0 can cause a one-time resend because its old checkpoints did not identify the destination. Run only one uploader process per state directory.

## Development

```bash
npm test
```

Tests use synthetic usage data, mocked uploads and a local HTTP server for timeout coverage. They do not submit data to tokens.ci.

## Environment variables

| Variable | Default | Description |
|----------|---------|-------------|
| `TOKENS_API_TOKEN` | — | Overrides saved token |
| `TOKENS_API_URL` | `https://tokens.ci` | API base URL |
| `TOKENS_CI_AUTO_SUBMIT` | — | `true` / `false` |
| `TOKENS_CI_START_DATE` | — | Only submit from this YYYY-MM-DD |
| `TOKENS_CI_DEVICE_NAME` | `Magpie` | Device name shown on tokens.ci |
| `TOKENS_CI_USAGE_FILE` | `~/.config/magpie/usage.jsonl` | Override usage path |

## Notes

- This uses tokens.ci’s private submit endpoint. It is not an official integration and may break if the payload format changes.
- Only aggregated totals (tokens, models, clients, timestamps) are sent. Prompts and responses never leave Magpie.
- State and checkpoints live in `~/.config/magpie/tokens-ci-import/`.

## License

MIT
