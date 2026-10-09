# Permission broker (shadow mode)

This overlay applies after the steer-notify overlay. It adds a permission broker that checks every crew
permission request against the task's permits and a fixed never-auto list, and logs the answer it would
give next to the answer a person gave. **It never answers a request.** No code in this overlay calls the
SDK's permission answer or sends anything to an agent, in any mode.

## What it does

- **Which requests.** Only agents labelled `firstmate.role=crew`, never the first mate itself. Labels are
  looked up once per crewmate through the crew relay's lookup. An agent without the crew label is not
  looked at further and gets no log line. A crewmate whose `firstmate.task` is missing, reserved
  (`permissions`, `tools`, a device name) or not a path-safe slug is logged as `never:not-crew`.
- **Permits.** `data/permissions/permits/<task>.json` in the first mate's home, read on every request, so
  an edit counts at once. Missing, unreadable, invalid or written for another task: nothing is allowed
  (`never:no-permits`). The format is the planning spec's (version 1: `writeDirs`, `scratchDirs`,
  `readRepos`, `netRead`, `gitLocal`, `exec`, `envNames`, `live`).
- **The matcher** (`server/permit-match.ts`) is pure, with one injected `realpath`. The command line must be
  exactly `"<pwsh dir>\pwsh.exe" -Command '<script>'` (or `-NoProfile -Command`, which Codex also sends
  and which only runs less; accepted by the planning spec's amendment of 2026-10-09) from one of the two
  known pwsh folders. A line it cannot unwrap relays as
  `never:unparsed`; the wrapper's own `-Command` never counts as a nested shell. The
  script is split into statements: allowed `$env:NAME='literal'` assignments, apply_patch envelopes, or one
  plain command of bare words and quoted strings, at most piped into one formatting cmdlet (Select-String
  only as a filter: its pattern and a short list of switches, never a file). Every statement
  must match an allow rule (`notes-write`, `local-read`, `net-read`, `git-local`, `git-read`, `home-tool`,
  and the tier-2 `exec` and `package`); any doubt relays. `local-read` accepts the parameters listed in
  `LOCAL_READ_FORMS`: the path parameters and the read-only switches `-Raw`, `-Tail`, `-TotalCount`,
  `-Encoding`, `-Recurse`, `-File`, `-Directory`, `-Name`, `-Depth`, `-PathType` (spec amendment of
  2026-10-09). An `exec` prefix matches its words exactly; only an absolute program path compares in any
  case and with either slash. A git, gh, curl or npm install run by path from the roots answers to its own
  rule first, then to `exec`. Paths are normalized, refused with `..`, `~`, `%`,
  `$`, wildcards, UNC or device forms, colons past the drive, or names ending in a dot or space, and
  resolved through `realpath` at the nearest existing folder, so a junction cannot lead out of a root.
- **The never-auto list** (`server/permit-rules.ts`) is data: each entry has an id, a reason, its
  patterns and command names, and the cases that prove it. It is checked before any rule, against the
  script and against each statement: `not-crew`, `no-permits`, `not-v1`, `destructive`, `outward`,
  `credential`, `outside`, `project-repo`, `non-get`, `hardware`, `system`, `after-refusal`, `unparsed`,
  `rate`. A native program is recognized with `.exe` or by path too (`rm.exe` is `rm`).
- **The private supplement** (spec amendment of 2026-10-09). Hardware tool names that may not appear in a
  public repository live in `data/permissions/never-auto-extra.json` in the home:
  `{ "version": 1, "neverAuto": { "hardware": { "commandBasenames": [...] } } }`. It is read on every
  request. A listed name, compared case-folded with and without `.exe`, bare, by path or as any word of a
  statement (so also inside an `exec` prefix), relays as `never:hardware` whatever the permits say. If the
  file is missing, unreadable or invalid, every `exec` statement relays (`never:hardware`); the other rules
  are unaffected. Its names are never logged. The tests use a synthetic one,
  `server/permit-fixtures/never-auto-extra.json`.
- **After a refusal.** A crewmate becomes sticky for the rest of its life when a person denies one of its
  requests, when a turn of it ends on a `blocked:`, `needs-decision:` or `failed:` line, or when a request
  of it hits `destructive`, `outward`, `credential` or `system`. Its later requests relay as
  `never:after-refusal`. A sticky mark is never pruned by age. Sticky marks and the last hour's allow times (for the 120-an-hour `rate` cap) are
  kept in `plugin-data/firstmate/permission-broker.json`, so a reload forgets neither.
- **The log.** One JSON line per request and per resolution in `data/permissions/log-YYYY-MM.jsonl` in the
  home, appended, never edited. Commands, working folders and details are redacted (credential words with
  their values, `ghp_…`, `github_pat_…`, `xox…-`, long base64 runs) and commands are cut to 2000
  characters. The crewmate's own description of a request is not logged. A failed write goes to stderr at
  most once an hour and changes nothing else. `answered` is always `false` and `byBroker` always `false`.
- **Guarded.** Every hook catches its own errors and writes them to stderr: a failure costs that event's
  log line and nothing else.

## The config field

`permissionBroker` in `plugin-data/firstmate/config.json`: `"off"` (the default), `"shadow"` or `"live"`.
There is no setting on the board for it; edit the file.

- `"off"`: when the plugin loads, no hook is registered.
- `"shadow"`: every crew request is judged and logged; nothing is answered.
- `"live"`: **in this build, exactly like shadow: nothing is answered.** The only differences are the
  `mode` written in the log and that a permits file without `"live": true` relays as `never:no-permits`,
  so the log shows what live mode will judge. Answering arrives with a later, separately reviewed change.

A value that is not one of the three is reported on stderr and treated as `"off"`; it does not reset the
rest of the config. The mode is read again on every event, so switching to `"off"` stops the broker at
once; switching on from `"off"` needs a plugin reload (`paseo plugin reload firstmate`).

## How to undo

Set `permissionBroker` to `"off"` (or remove it). Or reverse this overlay, before any earlier one:

```sh
git -c core.autocrlf=false apply --reverse patches/permission-broker/permission-broker.patch
```

The log in `data/permissions/` and `permission-broker.json` are left where they are; nothing reads them
when the broker is off.

## Records

`original/` holds the three files it changes as they were before this overlay (`index.server.ts` is the
steer-notify overlay's result; `server/config.ts` and `shared/fleet.ts` are stock 0.3.4). `modified/`
holds them after it, and the eight new files: `server/permission-broker.ts`, `server/permit-match.ts`,
`server/permit-rules.ts`, their tests `server/permission-broker.test.ts`, `server/permit-match.test.ts`,
`server/permit-bypass.test.ts` and `server/permit-replay.test.ts`, and the synthetic supplement
`server/permit-fixtures/never-auto-extra.json`. `permission-broker.patch` reproduces that snapshot. Run
`sh patches/permission-broker/check.sh` (with TMPDIR set to an allowed temporary folder; it keeps its
scratch copy) to check reproduction and all eleven root files. Because this overlay
edits `index.server.ts`, the steer-notify check compares that file with this overlay's `original/`.

Check and apply from the plugin directory:

```sh
git -c core.autocrlf=false apply --check patches/permission-broker/permission-broker.patch
git -c core.autocrlf=false apply patches/permission-broker/permission-broker.patch
```

## Checks

`npm test -- --exclude 'patches/**'` runs, with synthetic paths and names only:

- `server/permit-match.test.ts`: every allowed fixture (at least one per class of the planning evidence)
  allows with its rule and tier; the never-auto table (at least three cases per id, each against a maximal
  permits file with an exec entry for the case's own command, so only the list can stop it); 22 mutations
  of every allowed fixture, each of which must relay; 10 000 seeded random statement sequences, which must
  relay whenever they hold a forbidden token and allow otherwise; the grammar, paths and permits format.
- `server/permit-bypass.test.ts`: the review's 47 bypass attempts (round 1), each under maximal permits,
  and the round-1 fixes: attached and bundled write flags, tools run by path, native destructive names, the
  supplement (names, fail-closed, format), Select-String as a filter only, the accepted local-read switches,
  exact exec prefixes.
- `server/permission-broker.test.ts`: against a fake daemon that records every write to an agent and a
  temporary home: no write in shadow or live across every fixture, and no module of the broker naming the
  SDK's answer; stickiness after a deny, a blocked or needs-decision turn, a destructive or outward hit,
  also after a reload and 31 days later; the supplement read on every request (missing, present, listed,
  invalid); the gates (off registers nothing, switching off stops at once, non-crew and the first
  mate are not looked at, reserved task, no task, missing, non-JSON, invalid and other-task permits,
  `live: false` in live mode); the log's shape, redaction, a failing write, a failing hook and the rate cap.
- `server/permit-replay.test.ts`: skipped unless `PERMIT_REPLAY` names a JSON lines corpus of real requests
  (`{ command, cwd, label }`, with optional `labels` tags and the `launcher` argv). It replays them under
  maximal permits built from the corpus, prints coverage by label, and fails if anything labelled or tagged
  hardware, WSL, destructive, outward or credential is allowed. The corpus stays on the machine that made
  it; nothing of it belongs in this repository.

No dependency change of its own; the Paseo requirement is upstream's `>=0.11.0`. Not run in a live Paseo
app.
