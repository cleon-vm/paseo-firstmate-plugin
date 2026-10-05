# Windows watches (local patch to FirstMate 0.2.1)

| Files | Patch file |
| --- | --- |
| `server/watch-files.ts`, `server/watch-run.ts` modified; `server/watch-launch.ts`, `server/watch-launch.test.ts` new | `windows-watches.patch` |

`original/` holds the two stock files as shipped in 0.2.1; `modified/` holds every patched or new file. This patch and the quota pill touch different files, so they apply independently and in either order.

**Problem.** Every watch showed as invalid ("it is not executable (chmod +x)") and, even if it had run, `spawn(script)` cannot start a `#!` script on Windows and `process.kill(-pid)` is a POSIX process-group call.

**Changes.**
- `watch-files.ts`: the `0o111` execute-bit check is skipped when the platform is `win32`. The `#!` line is still required. `listWatches(home, platform = process.platform)` takes the platform only so tests can inject it.
- `watch-launch.ts` (new): parses the `#!` line (`/usr/bin/env [-S] [VAR=x] name args`, or a direct path) and picks the Windows command:
  - `node`/`nodejs` -> `node.exe` from PATH (never `process.execPath`, which inside Paseo is `Paseo.exe`); if PATH lacks it, `%ProgramFiles%\nodejs\node.exe`.
  - `sh`/`bash` -> **Git for Windows' bash** (`Program Files\Git\bin\bash.exe`, or derived from `git.exe` on PATH); WSL's `System32\bash.exe` is never used. Script path is passed with forward slashes. If Git bash is missing the run fails with "Git for Windows' bash was not found".
  - `python*` -> `python3`, `python`, then `py -3` (Store stubs in `WindowsApps` skipped).
  - anything else -> `<name>.exe`/`.com` on PATH, else a clear "`<name>` was not found on PATH" spawn error, which the watch card and the first mate's watch note report like any failed start.
- `watch-run.ts`: on Windows, reads the script's `#!` line and spawns the resolved interpreter with the script as argument, `windowsHide: true`, and **not** `detached`. Stop (timeout or plugin shutdown) runs `%SystemRoot%\System32\taskkill.exe /PID <pid> /T /F`, and again after the grace period only if the script is still alive; if taskkill itself cannot run, the script alone is killed so the run still ends. POSIX path (`detached: true`, `process.kill(-pid, SIGTERM/SIGKILL)`) is unchanged. Output caps, the two-minute timeout and the not-started-twice logic (in `watches.ts`) are untouched. `RunOptions` gained optional `platform` and `launchEnv` for tests.
- `cli.ts` was checked and needs no change: `access(X_OK)` on Windows behaves as an existence check.

**Tests** (`server/watch-launch.test.ts`, 19 tests; the `!**/*.test.ts` line in `package.json` keeps them out of the npm package): shebang parsing, Windows launch resolution with a fake file system, the Windows-vs-POSIX validity check by injected platform, spawn errors before anything starts, and (Windows host only) a real node script by its `#!` line plus a timeout that must also kill a child process. The installed copy has no dev dependencies, so they were run with an external vitest install: 33 passed (19 new, 14 quota). `tsc` reports only the unresolved `@getpaseo/plugin` module in `shared/fleet.ts`.

**End-to-end check** on the local machine (patched code bundled with esbuild): the existing watches listed as valid and ran to exit 0; a node script's stdout came back; a `#!/bin/sh` script ran under Git bash; an unknown interpreter gave a clean spawn error; a script that spawned two child node processes and slept was stopped at the timeout with `timedOut: true` and all three processes gone.

**Not verified until the plugin is reloaded:** that the daemon's own environment has `node.exe` on PATH (fallback to `Program Files\nodejs` exists), that no console window flashes (`windowsHide` is set), and the Watches card itself.

## Reapply after an npm update

From a shell in the installed plugin directory (`$P`, see `LOCAL-CHANGES.md`):
```
git -c core.autocrlf=false apply -p2 --directory=. <this-repo>/patches/windows-watches/windows-watches.patch
```
Add `--check` first. If the update changed `watch-files.ts` or `watch-run.ts` and it no longer applies, compare `original/server/*` with the new files; if the upstream files are otherwise unchanged copy `modified/server/*` over them, else redo the edits by hand (one condition in `watch-files.ts`, the spawn/kill block in `watch-run.ts`). Upstream may also fix this itself; check the plugin's CHANGELOG first. Then `paseo plugin reload firstmate`.

## Restore

Copy `original/server/watch-files.ts` and `watch-run.ts` back into `$P/server/`, delete `$P/server/watch-launch.ts` and `watch-launch.test.ts`, reload.
