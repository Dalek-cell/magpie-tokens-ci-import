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

Uploads run daily at **00:10 UTC**. Only completed UTC days are submitted.

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
