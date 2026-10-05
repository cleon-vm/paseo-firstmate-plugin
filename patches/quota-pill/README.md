# Quota pill (local patch to FirstMate 0.2.1)

Adds the Codex and Claude icons with their percent, e.g. `[Codex] 32% · [Claude] 61%` (percent USED, session window) beside Bearings and Ahoy in the FirstMate chat. Tap it for a card with session and weekly use, reset times and freshness. Data is read from Usage Monitor's `~/.paseo/usage-limits/last-readings.json` by a new FirstMate daemon handler; no credentials are read and no vendor is called. Stale: Codex over 10 min, Claude over 45 min (shows last value plus age). Missing/invalid file: `Quota unavailable`.

## Changed
- Modified: `index.server.ts` (registers handler), `client/chat.tsx` (mounts pill after Ahoy)
- New: `shared/quota-logos.ts` (Usage Monitor's Claude/Codex PNG marks, tinted from theme via `tintColor`; no react-native-svg or host provider-icon component exists for plugins), `shared/quota.ts`, `server/quota.ts`, `server/quota.test.ts`, `client/quota-pill.tsx`

`original/` holds the two stock files as shipped in 0.2.1; `modified/` holds every patched or new file.

## Reapply after an npm update overwrites the plugin
From a shell in the installed plugin directory (`$P`, see `LOCAL-CHANGES.md`):
```
git -c core.autocrlf=false apply -p2 --directory=. <this-repo>/patches/quota-pill/quota-pill.patch
```
Add `--check` first. If the update changed `chat.tsx` or `index.server.ts` and the patch no longer applies, copy the new files from `modified/` and redo the two small edits by hand (an import + one line in each). Then `paseo plugin reload firstmate`.

## Restore
Copy `original/index.server.ts` and `original/client/chat.tsx` back into `$P`, delete the new files, reload.

## Checks
The installed copy has no dev dependencies, so `npm run typecheck`/`npm test` were not run. Tests (14, synthetic fixtures) were run with an external vitest install. Full typecheck is not possible without the host SDK types; only unresolved-module errors remain. Icon rendering not visually verified in the UI; a11y labels still say Claude/Codex.
