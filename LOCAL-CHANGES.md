# Local changes

This is a private working copy of the FirstMate plugin for Paseo, **`@gpambrozio/paseo-firstmate` 0.2.1**, as installed from npm on the local machine, with six local patches applied. It is not a fork and nothing here has been sent upstream.

- Upstream: https://github.com/gpambrozio/paseo-plugins (monorepo, plugin in `firstmate/`)
- The upstream code, the MIT license and its copyright notice (see `LICENSE`) belong to the upstream author, Gustavo Ambrozio. Only the six patches below are local.
- `README.md` and `CHANGELOG.md` are upstream's; `README.md` has local-source install instructions.

Every file outside `patches/`, `LOCAL-CHANGES.md` and `.gitignore` is stock 0.2.1 plus all six patches. The installed npm copy still has the first five until the captain installs this private source. The package version remains 0.2.1; each patch README records its local version note.

## The patches

| Patch | What it does | Files | Details |
| --- | --- | --- | --- |
| Quota pill | Shows Codex and Claude usage (provider icons + percent used) beside Bearings and Ahoy in the FirstMate chat, with a detail card. Reads Usage Monitor's local `~/.paseo/usage-limits/last-readings.json`; reads no credentials and calls no vendor. | modified `index.server.ts`, `client/chat.tsx`; new `client/quota-pill.tsx`, `server/quota.ts`, `server/quota.test.ts`, `shared/quota.ts`, `shared/quota-logos.ts` | [patches/quota-pill/README.md](patches/quota-pill/README.md) |
| Windows watches | Makes watch scripts run on Windows: skips the execute-bit check on `win32`, launches a `#!` script through the right interpreter (node, Git for Windows' bash, python, or a named exe), and stops it with `taskkill /T /F` instead of POSIX process groups. | modified `server/watch-files.ts`, `server/watch-run.ts`; new `server/watch-launch.ts`, `server/watch-launch.test.ts` | [patches/windows-watches/README.md](patches/windows-watches/README.md) |
| Files images | Shows PNG, JPEG, GIF, WebP and SVG files as view-only images in the Files view (fit and zoom; SVG keeps an Edit source button), and draws `![alt](path)` images from the home in the Markdown preview. A new `firstmate.files.read-image` RPC reads them through the existing home confinement, capped at 15 MB. Remote images are never fetched; SVG is only drawn as a base64 data-URI image, never as markup. (First shipped as `firstmate.files.readImage`, which the daemon refuses: RPC names must be lowercase. See its README.) | modified `client/file-links.ts`, `client/files.tsx`, `client/markdown.tsx`, `client/open-file.ts`, `index.server.ts`, `shared/files.ts`; new `client/image-view.tsx`, `client/image-zoom.ts`, `client/images.test.ts`, `server/images.ts`, `server/images.test.ts`, `shared/images.ts`, `shared/rpc-names.test.ts` | [patches/files-images/README.md](patches/files-images/README.md) |
| Notification relay | After a Restart, relays the Paseo notes (finished, errored, needs permission, was closed) of crewmates whose creator is gone — such as the previous first mate — to the current first mate as `<firstmate-crew>` notes worded like Paseo's own, from the plugin's lifecycle hooks with no model turn spent on looking. Skips crewmates whose creator is live and notes Paseo already delivered; dedupes, rate-limits and persists its queue in `plugin-data/firstmate/crew-relay.json`. | modified `client/transcript-rows.ts`, `index.server.ts`, `server/templates.ts`, `templates/data/charter.md`, `templates/messages/restart-note.md`; new `server/crew-relay.ts`, `server/crew-relay.test.ts`, `templates/messages/crew-relay*.md` (4) | [patches/notification-relay/README.md](patches/notification-relay/README.md) |
| Reveal in explorer | Reveals a file (selected) or a folder of the home in the file manager of the machine running Paseo — Explorer, Finder or `xdg-open` — through a new `firstmate.files.reveal` RPC, confined like a read and started from an argument list. The Files view gets Reveal and Copy path on the open file's toolbar, Reveal for the current folder, and a right-click menu (long press on native) on rows and the open file's header, with a note that it opens on the machine running Paseo. | modified `client/files.tsx`, `client/web.ts`, `index.server.ts`, `shared/files.ts`; new `client/reveal.ts`, `client/reveal.test.ts`, `server/reveal.ts`, `server/reveal.test.ts` | [patches/reveal-in-explorer/README.md](patches/reveal-in-explorer/README.md) |
| Chat input lag | Keeps composer keystrokes from rebuilding the history Markdown and inline tokens by stabilizing history callbacks and memoizing the history JSX. Includes a render-count regression and history/link/streaming invalidation checks. | modified `client/chat.tsx`; new `client/chat.test.ts` | [patches/chat-input-lag/README.md](patches/chat-input-lag/README.md) |

The quota pill and Windows watches touch different files and apply independently, in either order. Files images is based on the tree with both of them applied (it also edits `index.server.ts`), the notification relay on the tree with all three, reveal in explorer on the tree with all four, and chat input lag on the tree with all five. On a fresh npm install the order is: quota pill, Windows watches, files images (with the read-image fix), notification relay, reveal in explorer, chat input lag. Each `patches/<name>/` folder holds the `.patch` file, `original/` (the files it changes, as they were before it) and `modified/` (every patched or new file).

## Where the plugin lives

The installed copy (`$P`) is under the Paseo plugins folder:

```
%USERPROFILE%\.paseo\plugins\firstmate\<install-id>\node_modules\@gpambrozio\paseo-firstmate
```

The `<install-id>` folder can change on reinstall; use the current one.

## Reapply after an upstream / npm update

An npm update of the plugin overwrites `$P` and drops all six patches. From a shell in `$P` (Git Bash or PowerShell), with `<repo>` being this repository:

```
git -c core.autocrlf=false apply -p2 --directory=. --check <repo>/patches/quota-pill/quota-pill.patch
git -c core.autocrlf=false apply -p2 --directory=. --check <repo>/patches/windows-watches/windows-watches.patch
```

If both checks pass, run the same two commands without `--check`. Then apply files images (plain paths, no `-p2 --directory=.`), checking first:

```
git -c core.autocrlf=false apply --check <repo>/patches/files-images/files-images.patch
git -c core.autocrlf=false apply <repo>/patches/files-images/files-images.patch
```

Then the notification relay (`-p2 --directory=.` again), checking first:

```
git -c core.autocrlf=false apply -p2 --directory=. --check <repo>/patches/notification-relay/notification-relay.patch
git -c core.autocrlf=false apply -p2 --directory=. <repo>/patches/notification-relay/notification-relay.patch
```

Then reveal in explorer (plain paths again), checking first:

```
git -c core.autocrlf=false apply --check <repo>/patches/reveal-in-explorer/reveal-in-explorer.patch
git -c core.autocrlf=false apply <repo>/patches/reveal-in-explorer/reveal-in-explorer.patch
```

Then chat input lag (plain paths), checking first:

```
git -c core.autocrlf=false apply --check <repo>/patches/chat-input-lag/chat-input-lag.patch
git -c core.autocrlf=false apply <repo>/patches/chat-input-lag/chat-input-lag.patch
```

Then `paseo plugin reload firstmate`. To install the private working copy over the npm source instead, once the reviewed change is available in `<plugin-dir>`, remove FirstMate, then install the directory with its existing ID and reload:

```
paseo plugin remove firstmate
paseo plugin install <plugin-dir> --id firstmate
paseo plugin reload firstmate
```

Removing FirstMate ends its running session. Back up `%USERPROFILE%\.paseo\plugin-data\firstmate\home` first: it was kept intact when this was done on 2026-10-02, but `plugin remove` is described only as removing plugin configuration. After reinstalling, the first mate resumes from its records; keep `--id firstmate` so the plugin data folder is reused. A plain install while the plugin exists fails with `already configured`. To install a branch instead, use the private Git URL with `--ref`, for example `paseo plugin install 'https://github.com/cleon-vm/paseo-firstmate-plugin.git' --id firstmate --ref fm/chat-input-lag`; see the patch README. Installation is the captain's step and was not run while making this patch.

If a check fails, the update changed a patched file. Check upstream's `CHANGELOG.md` first (upstream may have fixed the issue itself), then follow the per-patch README: compare the new file with `original/`, and either copy `modified/` over it (if upstream didn't otherwise change the file) or redo the small edit by hand. To refresh this repo afterwards, copy the new `$P` over the working tree (without `node_modules`), keep `patches/`, `LOCAL-CHANGES.md` and `.gitignore`, and commit.

## Restore the stock version

Either switch the plugin back to npm (which overwrites `$P` with stock files):

```
paseo plugin remove firstmate
paseo plugin install npm:@gpambrozio/paseo-firstmate --id firstmate
paseo plugin reload firstmate
```

Or undo the patches in place from `$P`, newest first:

```
git -c core.autocrlf=false apply --reverse <repo>/patches/chat-input-lag/chat-input-lag.patch
git -c core.autocrlf=false apply --reverse <repo>/patches/reveal-in-explorer/reveal-in-explorer.patch
git -c core.autocrlf=false apply -p2 --directory=. --reverse <repo>/patches/notification-relay/notification-relay.patch
git -c core.autocrlf=false apply --reverse <repo>/patches/files-images/files-images.patch
git -c core.autocrlf=false apply -p2 --directory=. --reverse <repo>/patches/quota-pill/quota-pill.patch
git -c core.autocrlf=false apply -p2 --directory=. --reverse <repo>/patches/windows-watches/windows-watches.patch
```

Reverse-applying removes the new files and restores the originals (the same content as `patches/*/original/`). Then `paseo plugin reload firstmate`.
