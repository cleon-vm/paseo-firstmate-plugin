# Files images (local patch to FirstMate 0.2.1)

| Files | Patch file |
| --- | --- |
| `client/file-links.ts`, `client/files.tsx`, `client/markdown.tsx`, `client/open-file.ts`, `index.server.ts`, `shared/files.ts` modified; `client/image-view.tsx`, `client/image-zoom.ts`, `client/images.test.ts`, `server/images.ts`, `server/images.test.ts`, `shared/images.ts`, `shared/rpc-names.test.ts` new | `files-images.patch` (whole patch, fix included); `read-image-rename.patch` (the fix alone, for a tree that has the first version) |

`original/` holds the six files as they were before this patch (stock 0.2.1 plus the quota pill and Windows watches patches, so `original/index.server.ts` already has the quota pill's line); `modified/` holds every patched or new file.

**Order matters.** This patch is based on the tree with both earlier patches applied (`index.server.ts` is touched by the quota pill too). After an npm update, apply the quota pill and Windows watches first, then this one.

**What it does.**
- **Files view:** opening a `.png`, `.jpg`/`.jpeg`, `.gif`, `.webp` or `.svg` shows the image (view only) instead of "not a text file": fit to the pane (never enlarged past its own size), zoom 10%–800% with scrolling, pixel size, byte size and type. Images over 15 MB show a size message; an image that fails to decode shows a message. SVG has **Edit source** (opens the text editor as before) and **View image**. Images reload on the list's 10-second poll.
- **Server:** new RPC `firstmate.files.read-image` `{ path, relativeTo? }` returning base64 data up to 15 MB. It goes through the existing `resolveInHome` confinement (lexical and realpath checks), requires a regular file with one of the five extensions, and takes the MIME type from the magic bytes when there are any (so an SVG named `.png` is never typed as SVG). `firstmate.files.read` is unchanged.
- **Markdown preview:** `![alt](path)` draws an image in the home, looked up beside the Markdown file, then from the home root, then as an absolute path that lands inside the home. Remote `http(s)` images are never fetched (shown as a link with the alt text); other URL schemes show the alt text only; HTML is still not rendered. Clicking an image opens it in the Files view. The chat's rendering is unchanged.
- **SVG safety:** SVG is only drawn by `Image` from a `data:image/svg+xml;base64,...` URI (restricted image mode: no scripts, no external loads). It is never inlined as markup. On native iOS/Android, where `Image` can't decode SVG, the message with Edit source appears instead.

**Tests** (`server/images.test.ts` 25, `client/images.test.ts` 21, `shared/rpc-names.test.ts` 4; kept out of the npm package by `package.json`'s `!**/*.test.ts`). Run with an external vitest install, since the installed copy has no dev dependencies: 83 passed (50 new, 14 quota, 19 watch-launch).

**The RPC name fix.** The first version named the RPC `firstmate.files.readImage`. The daemon refuses that: `server.handle` checks every name against `^[a-z][a-z0-9._-]*$` (Paseo's `server/plugins/plugin-process.js`, `validateMethod`), so the capital `I` threw `Invalid plugin RPC method: firstmate.files.readImage` and `paseo plugin reload firstmate` failed for the whole plugin. It is now `firstmate.files.read-image`; only the name and two comments changed. `shared/rpc-names.test.ts` checks every `defineRpc` name in the source against that pattern, and that no name is used twice. `files-images.patch` includes the fix.

**Not verified until the plugin is reloaded:** the actual layout and rendering in the host UI, and whether `Image.getSize` works on a data URI there (without it the pixel size is omitted and Fit uses a 4:3 box).

## Reapply after an npm update

From a shell in the installed plugin directory (`$P`, see `LOCAL-CHANGES.md`), after the other two patches:
```
git -c core.autocrlf=false apply --check <this-repo>/patches/files-images/files-images.patch
git -c core.autocrlf=false apply <this-repo>/patches/files-images/files-images.patch
```
This patch uses plain `a/`/`b/` paths, so no `-p2 --directory=.` (unlike the other two). It already has the RPC name fix. If the check fails, compare `original/*` with the new files; if upstream didn't otherwise change them copy `modified/*` over `$P`, else redo the edits by hand. Check upstream's CHANGELOG first in case it added image viewing itself. Then `paseo plugin reload firstmate`.

**A tree that has the first version** (`readImage`, reload fails with `Invalid plugin RPC method`) needs only the fix. From `$P`:
```
git -c core.autocrlf=false apply --check <this-repo>/patches/files-images/read-image-rename.patch
git -c core.autocrlf=false apply <this-repo>/patches/files-images/read-image-rename.patch
```
Don't also apply `files-images.patch` there; it would fail as already applied. Then reload.

## Restore

From `$P`:
```
git -c core.autocrlf=false apply --reverse <this-repo>/patches/files-images/files-images.patch
```
or copy the six files in `original/` back into `$P` and delete the seven new files listed above. Then reload.
