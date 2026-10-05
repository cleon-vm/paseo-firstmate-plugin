# Reveal in Explorer (local patch to FirstMate 0.2.1)

| Files | Patch file |
| --- | --- |
| `client/files.tsx`, `client/web.ts`, `index.server.ts`, `shared/files.ts` modified; `client/reveal.ts`, `client/reveal.test.ts`, `server/reveal.ts`, `server/reveal.test.ts` new | `reveal-in-explorer.patch` |

`original/` holds the four files as they were before this patch (stock 0.2.1 plus the quota pill, Windows watches, files images with the read-image fix, and notification relay patches); `modified/` holds every patched or new file.

**Order matters.** This patch is based on the tree with all four earlier patches applied (`client/files.tsx`, `shared/files.ts` and `index.server.ts` are touched by files images, and `index.server.ts` by the quota pill and the relay too). On a fresh npm install the order is: quota pill, Windows watches, files images (with the read-image fix), notification relay, reveal in explorer.

**Problem.** Paseo's own file view has "Reveal in Explorer", but the plugin runtime gives a plugin no way to call it (a plugin client gets `openExternalUrl`, `copyText`, `useToast` and basic UI), so the FirstMate Files view had no way to get from a file to the folder it is in.

**What it does.**
- **Server:** a new RPC, `firstmate.files.reveal` (lowercase letters and dots, as the daemon requires), takes a home-relative path. `server/reveal.ts` confines it exactly as `firstmate.files.read` does (`resolveInHome`: no `..`, no absolute path or drive, no symlink or junction that leads out), resolves it to its real path, checks that again, and refuses anything that is not an existing file or folder with a clear message. It then starts, detached, from an argument list, without a shell, and without waiting for it to exit:
  - Windows: `%SystemRoot%\explorer.exe /select,"<path>"` for a file (selected in its folder), `explorer.exe "<path>"` for a folder. The argument is passed with `windowsVerbatimArguments`, because Node's own quoting turns it into `"/select,\"…\""`, which Explorer does not read. The quotes keep spaces and commas inside the path; a trailing backslash is dropped so it cannot escape the closing quote. Explorer exits non-zero even when it worked, so only a failure to start counts. `windowsHide` is off: Explorer's window is the point, and it has no console to hide.
  - macOS: `/usr/bin/open -R <path>` for a file, `open <path>` for a folder.
  - Elsewhere: `xdg-open <folder>` (the file's folder, or the folder itself).
  The answer names the program and the machine (`Opened Explorer on <host>`).
- **Client (`client/files.tsx`):** the open file's toolbar gets **Reveal** and **Copy path** (the full path on the daemon's machine, built from the home the file list reports). The file list's header gets a Reveal for the current folder. A **right-click** on a file or folder row, or on the open file's header, opens a small menu with Reveal, Copy path and Copy relative path (on native, a long press). The menu stays inside the view and closes on a click or right-click anywhere else. The Files view's empty-state text and the menu both say that Reveal opens on the machine running Paseo, which may not be this one. Errors show as toasts.
- **Right-click works through the host:** react-native-web forwards `onContextMenu` from `Pressable` and `View` to the element (it is in its forwarded click props, and Paseo's own context menus use it the same way). `client/web.ts` holds the one handler, which reads the pointer from the DOM event, holds back the browser's menu, and stops the event there. A right-click is not a press in react-native-web, so a row does not also open.
- Icons are `FolderOpen` and `Copy`, both exports of the lucide set the host's `Icon` resolves names against (an unknown name draws nothing).

**Not added:** a Reveal action on file links in the chat. Those links are inline `Text` spans in `client/markdown.tsx`, and a menu there would mean threading a new callback through the Markdown renderer and the chat. A link opens the file in Files, where Reveal is one press away.

**Tests** (`server/reveal.test.ts`, 24 tests; `client/reveal.test.ts`, 8 tests): Explorer quoting (spaces, commas, trailing backslash, drive root, network path, refusing a relative path or a double quote), the command per platform with an injected platform and environment, the detached start with an injected spawner (options, a missing program, other failures), path resolution against a real temporary home (a file with spaces and commas, backslashes, a folder, the home, missing, `..`, absolute, a drive path, a junction out of the home and a path through it, a junction inside it, a dangling link), and nothing started for a refused path; the client's full path, label and menu placement. 147 passed with an external vitest, as for the other patches.

**Checked against the daemon's own load-time code** (Paseo 0.10.2): the daemon's `validateMethod` and `register` accept all 28 `defineRpc` names, including `firstmate.files.reveal`. The daemon's `compilePlugin` builds both bundles; the server bundle, loaded as the daemon loads it, registers 31 methods and the relay's five hooks, and reveal requests sent through the daemon's own RPC dispatch (input schema, handler, output schema) start Explorer with the expected arguments for a file, a folder and the home, and start nothing for a missing path, `..`, an absolute path outside, a missing path field or an over-long one.

**Not verified until the plugin is reloaded:** Explorer actually opening with the file selected (no window was opened during the checks), and the right-click menu in the running app.

## Reapply after an npm update

From a shell in the installed plugin directory (`$P`, see `LOCAL-CHANGES.md`), after the other four patches. This patch has plain `a/`/`b/` paths, so no `-p2 --directory=.`:
```
git -c core.autocrlf=false apply --check <repo>/patches/reveal-in-explorer/reveal-in-explorer.patch
git -c core.autocrlf=false apply <repo>/patches/reveal-in-explorer/reveal-in-explorer.patch
```
Then `paseo plugin reload firstmate`. If the check fails, compare the new files with `original/` and either copy `modified/` over them (if upstream did not otherwise change those files) or redo the edits by hand: one contract at the end of `shared/files.ts`, one import and one `server.handle` line in `index.server.ts`, `contextMenuProps` at the end of `client/web.ts`, and the toolbar buttons, menu and note in `client/files.tsx`.

## Restore

```
git -c core.autocrlf=false apply --reverse <repo>/patches/reveal-in-explorer/reveal-in-explorer.patch
```
Or copy `original/*` back into `$P` and delete `client/reveal.ts`, `client/reveal.test.ts`, `server/reveal.ts` and `server/reveal.test.ts`. Then reload. The patch stores nothing.
