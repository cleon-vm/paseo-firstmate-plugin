# Chat input lag (local patch to FirstMate 0.3.4)

| Files | Patch file |
| --- | --- |
| `client/chat.tsx` modified; `client/chat.test.ts` new | `chat-input-lag.patch` |

`original/` holds the chat before this patch (stock 0.3.4 plus the five earlier local patches, of which only the quota pill edits the chat); `modified/` holds the patched chat and its regression test. The test snapshot is named `client/chat.test.ts.txt` so Vitest does not collect the incomplete archival tree; remove `.txt` when copying it back. First cut on 0.2.1 at base commit `6d5736b`. Apply after reveal in explorer; the quota pill also edits the chat. The package version is upstream's (0.3.4) and upstream's README/CHANGELOG are upstream's text; this document is the local version note.

**Re-cut on 0.3.4.** Upstream 0.3.3 moved the chat's styles to its type scale, away from this patch's hunks, so the old patch still applied to LF 0.3.4 files (it failed only from a CRLF checkout, now prevented by `.gitattributes`). The snapshots are re-cut so `original/` and `modified/` carry upstream's chat. The callback and memo edits are unchanged, and upstream's `FONT_SIZE` styles are kept: they live in `styles`, which `renderGroup` already lists as a dependency, so the memo still invalidates on a theme or compact change. Upstream has not adopted this fix. On 0.3.4 the four chat tests pass.

**Problem.** The composer draft belongs to `MateChat`, alongside the transcript. Every character rebuilt all history Markdown and inline tokens even though the history had not changed. A 150-entry regression fixture renders 75 assistant Markdown rows per keystroke before the fix.

**Change.** Stabilize `openLink` with `useCallback`, stabilize `renderGroup` on every value it captures, and memoize the mapped history JSX. Groups, expanded tools, theme, compact-dependent styles, file lookup, file-open callback and toast-backed URL callback invalidate the memo. Composer edits now cause zero history Markdown renders and zero inline-token calls. Draft persistence, attachments, ordering and scrolling retain their existing paths.

This uses the investigation's callback-wrapped equivalent of its smallest diff, so hook dependencies remain explicit. Other input findings are recorded in the task notes: panel cards and Files lists/preview need a separate scoped follow-up.

## Tests

The regression uses Vitest and React 19.1's test renderer. To keep the production package manifest unchanged, install the test-only renderer locally without saving it:

```powershell
npm install --ignore-scripts --no-audit --no-fund --package-lock=false --cache ./node_modules/.npm-cache
npm install --dry-run --no-save --package-lock=false --ignore-scripts --no-audit --no-fund --cache ./node_modules/.npm-cache react-test-renderer@19.1.0 @types/react-test-renderer@19.1.0
npm install --no-save --package-lock=false --ignore-scripts --no-audit --no-fund --cache ./node_modules/.npm-cache react-test-renderer@19.1.0 @types/react-test-renderer@19.1.0
npm test -- --exclude 'patches/**'
./node_modules/.bin/tsc.cmd --noEmit --jsx react-jsx --module esnext --moduleResolution bundler --target es2022 --lib es2022 --types node --skipLibCheck client/chat.tsx client/chat.test.ts
```

Four chat tests cover zero renders/tokenization while typing, new replies and streaming tails, history replacement/order, URL/file links and callback replacement, theme/compact styles, folded-tool expansion and streaming status. The real chat, timeline hook, draft stores and Markdown renderer execute; daemon/query/native-host boundaries use fixtures. The renderer's deprecation warning is nonfatal; timings are not production latency measurements.

All 151 active tests and the focused TypeScript check passed on the 0.2.1 cut; on the 0.3.4 re-cut all 195 active tests and the focused check pass. Unfiltered `npm test` already fails on incomplete historical copies in `patches/`; those are patch records rather than independent modules. `npm run typecheck` already lacks a `tsconfig.json`; `npm run lint` already lacks a script. No CI workflow exists in this copy. No installed plugin was changed or reloaded, and no live performance recording was taken.

## Reapply after an npm update

From the plugin directory (`$P` in `LOCAL-CHANGES.md`), after the five earlier patches; plain paths, no `-p2 --directory=.`:

```
git -c core.autocrlf=false apply --check <repo>/patches/chat-input-lag/chat-input-lag.patch
git -c core.autocrlf=false apply <repo>/patches/chat-input-lag/chat-input-lag.patch
```

Then reload FirstMate. If the check fails, compare the updated chat with `original/client/chat.tsx`; copy `modified/client/chat.tsx` only if there are no other upstream changes, otherwise redo the callback/memo edits. The test-only renderer is needed to run the regression, not to install the plugin.

## Install this source

Paseo accepts a directory, Git repository or npm package as its install source. From a clone at `<plugin-dir>`, you can replace the npm source with that directory:

```powershell
paseo plugin remove firstmate
paseo plugin install <plugin-dir> --id firstmate
paseo plugin reload firstmate
```

Removing FirstMate ends its running session. Back up `%USERPROFILE%\.paseo\plugin-data\firstmate\home` first: `plugin remove` is described only as removing plugin configuration. After reinstalling, the first mate resumes from its records; keep `--id firstmate` so the plugin data folder is reused. A plain install while the plugin exists fails with `already configured`.

Or install from GitHub directly with `paseo plugin remove firstmate`, then `paseo plugin install 'https://github.com/cleon-vm/paseo-firstmate-plugin.git' --id firstmate --ref main` and `paseo plugin reload firstmate`.

## Restore

```
git -c core.autocrlf=false apply --reverse --check <repo>/patches/chat-input-lag/chat-input-lag.patch
git -c core.autocrlf=false apply --reverse <repo>/patches/chat-input-lag/chat-input-lag.patch
```

Or restore `original/client/chat.tsx` and remove `client/chat.test.ts`, then reload. No stored data changes.

## Verify the patch

From the repository root (Git Bash on Windows, any POSIX shell elsewhere): `sh patches/chat-input-lag/check.sh`. It applies the patch to a scratch copy of `original/` with the command above and checks the result is byte-identical to `modified/`. It then checks each file against the repository root (line endings ignored there) or, where a later patch edits that file again, against that patch's `original/`. It prints `ok: ...` and exits 0, or names each differing file and exits 1; the scratch copy is kept for inspection. `.gitattributes` pins this folder to LF, so a CRLF checkout does not break the patch.
