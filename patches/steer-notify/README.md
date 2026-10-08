# Steer notify

This overlay applies after the status-report overlay. It makes the board's steer box keep its
promise that the first mate hears about a steer.

Before this overlay, the first mate was told about a steer only when the crewmate's turn that read
the words ended. That note was held in memory. A crewmate that stopped on a permission prompt
never ended its turn, so the first mate heard nothing. Paseo arms its own finish and permission
notes only for prompts the first mate sends through its MCP tools (`setupFinishNotification`, called
from `send_agent_prompt` and `create_agent` in Paseo 0.11.0). A plugin send has no caller field, so
the plugin cannot arm one.

Now:

- **At once.** `steerCrew` sends the crewmate the words, then sends the live first mate a
  `<firstmate-board>` note (`templates/messages/steer-relay.md`). The note has the captain's words,
  quoted and clipped at 4000 characters, and the crewmate's id and title. If that note fails, the error
  is logged and the steer still counts as sent.
- **From then on.** Before the send, the crewmate is added to `touched` in the notification relay's
  `plugin-data/firstmate/crew-relay.json`. The relay then treats its finishes, errors, permission
  requests and close as it treats an orphan's, even though its creator is live. They use the same
  keys, queue, rate limit, persistence and quoting, in a `<firstmate-crew>` block worded for a steered
  crewmate (`templates/messages/crew-relay-steered.md`).
- **Not twice.** A steered crewmate's note uses the steer time, or its last finish if that is later, as
  `since`. If the first mate sends a notifying `send_agent_prompt` after that, Paseo tells it itself,
  and the existing timeline check drops the relay's copy. If the first mate prompted the crewmate
  before the steer and that turn is still running, both may report the turn's end once.
- **Bounded.** `touched` is pruned like `finished` (14 days, 500 crewmates) and cleared when the
  crewmate is archived. Agents without the crew label are never relayed.
- The old turn-end steer relay (`CaptainSteers`, `registerSteerRelay`) is removed. Otherwise the
  steered turn's answer would reach the first mate twice. The charter's descriptions of
  `<firstmate-board>` and `<firstmate-crew>` notes say what each now carries.

A crewmate the captain types into in its own Paseo tab is not covered. The plugin's
`agent.turn_started` hook does not say who started a turn.

`original/` holds the ten files as they were before this overlay (`index.server.ts` is the
status-report overlay's result; `crew-relay*`, `templates.ts` and `charter.md` are the notification
relay's; the rest are stock 0.2.1). `modified/` holds all ten after it, including the new
`templates/messages/crew-relay-steered.md`. `steer-notify.patch` reproduces that snapshot.

Run `sh patches/steer-notify/check.sh` to check reproduction, the base, and all ten root files. Set
TMPDIR to an allowed temporary directory; the check keeps its scratch copy for inspection. Because
this overlay edits `index.server.ts` later, the status-report check no longer compares that file
with the root. This check compares its `original/index.server.ts` with that overlay's `modified/`.

Check and apply from the plugin directory:

```sh
git -c core.autocrlf=false apply --check patches/steer-notify/steer-notify.patch
git -c core.autocrlf=false apply patches/steer-notify/steer-notify.patch
```

To undo, reverse this overlay first:

```sh
git -c core.autocrlf=false apply --reverse patches/steer-notify/steer-notify.patch
```

## Checks

`npm test -- --exclude 'patches/**'` runs `server/crew-relay.test.ts`. Eight tests are new and one is
extended (the state file round-trip). Against the code before this overlay, all nine fail. With it, all
nine pass. They cover:

- a steer's immediate note (words, id, title, quoting, the `steer` send);
- a steered crewmate's permission request and finish relayed once, also after a reload between the
  steer and the event;
- no copy when the first mate prompted the crewmate after the steer;
- a prompt from before the steer treated as used up;
- nothing for an agent without the crew label or for crew nobody steered;
- `touched` cleared on archive;
- the steered wording, quoted as before;
- `touched` round-tripping through the file.

No version bump and no dependency change. After merge, deploy with
`paseo plugin update firstmate`.
