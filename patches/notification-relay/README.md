# Notification relay (local patch to FirstMate 0.2.1)

| Files | Patch file |
| --- | --- |
| `client/transcript-rows.ts`, `index.server.ts`, `server/templates.ts`, `templates/data/charter.md`, `templates/messages/restart-note.md` modified; `server/crew-relay.ts`, `server/crew-relay.test.ts`, `templates/messages/crew-relay.md`, `crew-relay-dropped.md`, `crew-relay-earlier.md`, `crew-relay-permission.md` new | `notification-relay.patch` |

`original/` holds the five files as they were before this patch (stock 0.2.1 plus the quota pill, Windows watches and files images patches, files images including the read-image fix); `modified/` holds every patched or new file.

**Order matters.** This patch is based on the tree with all three earlier patches applied (`index.server.ts` is touched by the quota pill and files images too). On a fresh npm install the order is: quota pill, Windows watches, files images (with the read-image fix), notification relay. The relay does not touch the files the read-image fix changes, so it would also apply over the first files images version, but that tree does not load (the daemon refuses the `readImage` RPC name); make sure the fix is in first.

**Problem.** Paseo sends a crewmate's `<paseo-system>` note (finished, errored, was closed, needs permission) only to the agent that created or prompted it, and sends nothing when that agent is archived (`setupFinishNotification` in Paseo's `agent-prompt` module, read in the 0.10.2 daemon). A Restart archives the first mate and starts a new one, so every crewmate the old one started finishes silently until the next 30-minute heartbeat.

**What it does.** `server/crew-relay.ts` listens to the plugin hooks `agent.turn_ended`, `agent.permission_requested`, `agent.permission_resolved` and `agent.archived`, and sends the current first mate a `<firstmate-crew>` note worded like Paseo's own (first line `Agent <id> (<title>) finished.`, then the crewmate's last message in `<agent-response>`, or the permission request to answer) when:

- the agent has `firstmate.role=crew`, is not the first mate, and has a `paseo.parent-agent-id` (its creator);
- that creator is gone or archived (a live creator, above all the current first mate, gets Paseo's own note);
- the event is a completed turn (finished), a failed turn (errored), a permission request, or an archive of a crewmate the relay saw finish (was closed). Canceled turns are ignored.

Guards:
- **No duplicates.** Each event has a key (turn id plus timeline length; permission request id; close) kept with the queue in `$PASEO_HOME/plugin-data/firstmate/crew-relay.json`, so a plugin reload neither loses a queued note nor sends one twice. A note leaves the queue and is saved before it is sent (a crash loses it, never repeats it).
- **Not what Paseo already said.** Just before sending, the first mate's timeline is read back to the crewmate's previous finish; if the first mate prompted that crewmate itself with `send_agent_prompt` (notify on, the default), Paseo armed its own note and the relay drops its copy. A permission already answered, or whose crewmate is archived, is dropped too.
- **No floods.** Waits while the first mate is mid-turn or missing (tried again after its turn ends and every minute); gathers a burst for 5 s into one message; at least 30 s between messages and at most 20 an hour; a crewmate that ends several turns while its note waits is relayed once, with the latest; 20 notes queued at most, the oldest dropped and counted; a message is at most 32,000 characters, the rest waiting for the next.
- The crewmate's text is escaped the way watch output is, so it cannot open or close `<firstmate-crew>`, `<paseo-system>` or any other tag.

Also: the chat folds a `<firstmate-crew>` note to its first line, as it does Paseo's notes; the charter's §7 lists the new note and keeps the heartbeat as the backstop; the restart note tells a new first mate about the relay.

**Tests** (`server/crew-relay.test.ts`, 32 tests): the decisions (which events, keys, the "told by Paseo" window, tool-name parsing for Claude and Codex, rate limit, coalescing, pruning), the message text and escaping, the state file, the relay with an injected clock, timers, store and host, and an end-to-end run of `registerCrewRelay` against a fake hook source and fake daemon with the real file store. Run with an external vitest, as for the other patches: 115 passed (32 new), on the tree with the read-image fix. `tsc` against the 0.8.0 SDK types finds nothing in the plugin code; the only errors are vitest's `.not` typings in the scratch setup, which `quota.test.ts` shows too.

**Checked against the daemon's own load-time code** (Paseo 0.10.2): the relay adds no RPC and no manifest field. It subscribes to `agent.turn_started`, `agent.turn_ended`, `agent.permission_requested`, `agent.permission_resolved` and `agent.archived`; the last three are new to the plugin, and all five are in the daemon's `lifecycleEventNames`, which `server.on` checks (it throws `Unknown lifecycle event` otherwise, failing the load). The daemon's `compilePlugin` builds both bundles, and the server bundle, loaded the way the daemon loads it with its own `register` and hook registry, registers 30 RPC names (all accepted) and those five hooks, and cleans up to an empty hook list.

**Not verified until the plugin is reloaded:** a real Restart with a crewmate in flight; that the hook's `parentAgentId` and the first mate's timeline tool calls look on the live daemon as they do in its code; and the chat's folded line.

## Reapply after an npm update

From a shell in the installed plugin directory (`$P`, see `LOCAL-CHANGES.md`), after the other three patches:
```
git -c core.autocrlf=false apply -p2 --directory=. --check <repo>/patches/notification-relay/notification-relay.patch
git -c core.autocrlf=false apply -p2 --directory=. <repo>/patches/notification-relay/notification-relay.patch
```
Then `paseo plugin reload firstmate`. If the check fails, compare the new files with `original/` and either copy `modified/` over them or redo the small edits by hand (one import, one registration line, one `remember` and one `stop` in `index.server.ts`; one envelope name in `transcript-rows.ts`; four template names in `templates.ts`; the §7 text and the restart note).

## Restore

```
git -c core.autocrlf=false apply -p2 --directory=. --reverse <repo>/patches/notification-relay/notification-relay.patch
```
Then reload. `crew-relay.json` in the plugin's data folder can be deleted; nothing else reads it.
