# Quota pill (local patch to FirstMate 0.2.1)

Adds an icon and percent for each provider Usage Monitor tracks, e.g. `[Codex] 32% · [Claude] 61%` (percent USED, session window) beside Bearings and Ahoy in the FirstMate chat. Tap it for a card with session and weekly use, reset times and freshness. Data is read from Usage Monitor's `~/.paseo/usage-limits/last-readings.json` by a new FirstMate daemon handler; no credentials are read and no vendor is called. Missing/invalid file: `Quota unavailable`.

Providers are the keys present in that file, not a fixed list, and Usage Monitor's own config is not read. Codex and Claude come first, in that order, with their own names and icons; any other key follows alphabetically, named from its id (`opencode-go` shows as `Opencode Go`) with its initial in a ring as the icon. A provider the file does not have is not shown; a good file with no providers shows `Quota —`. A key that is not a valid id (empty, over 40 characters, surrounding whitespace or control characters) is skipped. Stale: Codex over 10 min, Claude over 45 min, any other provider over 10 min (shows last value plus age).

## Changed
- Modified: `index.server.ts` (registers handler), `client/chat.tsx` (mounts pill after Ahoy)
- New: `shared/quota-logos.ts` (Usage Monitor's Claude/Codex PNG marks, tinted from theme via `tintColor`; no react-native-svg or host provider-icon component exists for plugins), `shared/quota.ts`, `server/quota.ts`, `server/quota.test.ts`, `client/quota-pill.tsx`, `client/quota-pill.test.ts`

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
The installed copy has no dev dependencies, so `npm run typecheck`/`npm test` were not run there. In this repository `npm test -- --exclude 'patches/**'` runs `server/quota.test.ts` (21, synthetic fixtures) and `client/quota-pill.test.ts` (3, renders the pill); the client test needs the test-only `react-test-renderer`, installed without saving as in `patches/chat-input-lag/README.md`. Full typecheck is not possible without the host SDK types; only unresolved-module errors remain. Icon rendering not visually verified in the UI; a11y labels still say Claude/Codex.
