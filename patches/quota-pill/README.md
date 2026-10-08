# Quota pill (local patch to FirstMate 0.3.4)

Adds an icon and percent for each provider Usage Monitor tracks, e.g. `[Codex] 32% · [Claude] 61%` (percent USED, session window) beside Bearings and Ahoy in the FirstMate chat. Tap it for a card with session and weekly use, reset times and freshness. Data is read from Usage Monitor's `~/.paseo/usage-limits/last-readings.json` by a new FirstMate daemon handler; no credentials are read and no vendor is called. Missing/invalid file: `Quota unavailable`.

Providers are the keys present in that file, not a fixed list, and Usage Monitor's own config is not read. Codex and Claude come first, in that order, with their own names and icons; any other key follows alphabetically, named from its id (`opencode-go` shows as `Opencode Go`) with its initial in a ring as the icon. A provider the file does not have is not shown; a good file with no providers shows `Quota —`. A key that is not a valid id (empty, over 40 characters, surrounding whitespace or control characters) is skipped. Stale: Codex over 10 min, Claude over 45 min, any other provider over 10 min (shows last value plus age).

## Changed
- Modified: `index.server.ts` (registers handler), `client/chat.tsx` (mounts pill after Ahoy)
- New: `shared/quota-logos.ts` (Usage Monitor's Claude/Codex PNG marks, tinted from theme via `tintColor`; no react-native-svg or host provider-icon component exists for plugins), `shared/quota.ts`, `server/quota.ts`, `server/quota.test.ts`, `client/quota-pill.tsx`, `client/quota-pill.test.ts`

`original/` holds the two stock files as shipped in 0.3.4; `modified/` holds every patched or new file.

**Type scale.** The pill and its card use upstream's `FONT_SIZE` roles (`client/type-scale.ts`, new in 0.3.3), the way upstream moved its own text one step up: the pill's text and the card's title are `small` (13, like the Bearings and Ahoy labels beside it and the context meter's title), the card's lines `caption` (12, like the context meter's detail). They were 12 and 11. The fallback icon's initial stays sized from the icon.

**Re-cut on 0.3.4.** First cut on 0.2.1. Upstream 0.3.3 changed only `client/chat.tsx`'s font sizes, away from this patch's two lines, so the patch carried over unchanged apart from its context; the type-scale change above is the only new edit.

## Reapply after an npm update overwrites the plugin
From a shell in the installed plugin directory (`$P`, see `LOCAL-CHANGES.md`):
```
git -c core.autocrlf=false apply -p2 --directory=. <this-repo>/patches/quota-pill/quota-pill.patch
```
Add `--check` first. The npm package's files have LF line endings, and so must the patch: `.gitattributes` pins everything under `patches/quota-pill/` to LF in every checkout, whatever `core.autocrlf` says. Don't copy the patch or `original/` through a tool that converts them to CRLF, because a CRLF patch fails on LF files (and an LF patch on CRLF files) with `patch failed: client/chat.tsx:30` and `index.server.ts:49`. If the update changed `chat.tsx` or `index.server.ts` and the patch no longer applies, copy the new files from `modified/` and redo the two small edits by hand (an import + one line in each). Then `paseo plugin reload firstmate`.

## Restore
Copy `original/index.server.ts` and `original/client/chat.tsx` back into `$P`, delete the new files, reload.

## Verify the patch
From the repository root (Git Bash on Windows, any POSIX shell elsewhere):
```
sh patches/quota-pill/check.sh
```
It copies `original/` (stock 0.3.4, byte-identical to the npm package's `client/chat.tsx` and `index.server.ts`) to a scratch folder and runs the preflight above, then the apply. It then checks that every resulting file is byte-identical to `modified/`, and that the files this patch adds match the repository root, ignoring line endings there. `chat.tsx` and `index.server.ts` are edited again by later patches, so they are compared with the `original/` of the next patch that edits them instead of the root. It prints `ok: ...` and exits 0, or names each differing file and exits 1. The scratch copy is kept for inspection. To check against a real npm install instead, run the preflight above in a copy of `npm pack @gpambrozio/paseo-firstmate@0.3.4`'s `package/` folder.

## Checks
The installed copy has no dev dependencies, so `npm run typecheck`/`npm test` were not run there. In this repository `npm test -- --exclude 'patches/**'` runs `server/quota.test.ts` (21, synthetic fixtures) and `client/quota-pill.test.ts` (3, renders the pill); the client test needs the test-only `react-test-renderer`, installed without saving as in `patches/chat-input-lag/README.md`. On the 0.3.4 re-cut both pass (21 and 3), and a focused `tsc --noEmit` over the sources, with the 0.11.0 SDK installed as dev dependencies, reports nothing in these files. Icon rendering not visually verified in the UI; a11y labels name each provider in words.
