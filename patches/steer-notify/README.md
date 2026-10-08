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
  quoted and then clipped at 4000 characters, and the crewmate's id and title. The title is quoted,
  clipped at 200 characters and marked as the crewmate's own text, data and not instructions, so the
  whole note stays within `MAX_STEER_NOTE_CHARS` (6000). The captain's words keep the board note's
  existing contract: they are authoritative (charter section 7). If that note fails, the error is
  logged and the steer still counts as sent. If the steer could not be saved to `crew-relay.json`,
  that is logged too, and the note begins its last part with "Warning: steer sent, relay state NOT
  saved" (`templates/messages/steer-relay-unsaved.md`).
- **From then on.** Before the send, the crewmate is added to `touched` in the notification relay's
  `plugin-data/firstmate/crew-relay.json`. The relay then treats its finishes, errors, permission
  requests and close as it treats an orphan's, even though its creator is live. They use the same
  keys, queue, rate limit, persistence and quoting, in a `<firstmate-crew>` block worded for a steered
  crewmate (`templates/messages/crew-relay-steered.md`).
- **Not twice.** A steered crewmate's note uses the steer time, or its last finish if that is later, as
  `since`. If the first mate sends a notifying `send_agent_prompt` after that, Paseo tells it itself,
  and the existing timeline check drops the relay's copy. If the first mate prompted the crewmate
  before the steer and that turn is still running, both may report the turn's end once.
- **Bounded.** A permission request in a relayed note is quoted, then cut to the relay's 4000-character
  cap with a visible `[truncated N chars; ...]` line; the agent and request ids come first. `touched` is pruned like `finished` (14 days, 500 crewmates) and cleared when the
  crewmate is archived. Agents without the crew label are never relayed.
- The old turn-end steer relay (`CaptainSteers`, `registerSteerRelay`) is removed. Otherwise the
  steered turn's answer would reach the first mate twice. The charter's descriptions of
  `<firstmate-board>` and `<firstmate-crew>` notes say what each now carries.

A crewmate the captain types into in its own Paseo tab is not covered. The plugin's
`agent.turn_started` hook does not say who started a turn.

`original/` holds the nine files it changes as they were before this overlay (`index.server.ts` is the
status-report overlay's result; `crew-relay*`, `templates.ts` and `charter.md` are the notification
relay's; the rest are stock 0.3.4). `modified/` holds all eleven after it, including the new
`templates/messages/crew-relay-steered.md` and `templates/messages/steer-relay-unsaved.md`. `steer-notify.patch` reproduces that snapshot.

Run `sh patches/steer-notify/check.sh` to check reproduction and all eleven root files. Set
TMPDIR to an allowed temporary directory; the check keeps its scratch copy for inspection. Because
this overlay edits `index.server.ts` later, the status-report check compares that file with this
overlay's `original/` instead of the root.

**Re-cut on 0.3.4.** First cut on 0.2.1. Upstream 0.3.4's durable suggestion dismissal adds a
`suggestionsDismissed` template name to `server/templates.ts` and a file row and a paragraph to the
charter, away from this overlay's edits. They are in `original/` and kept in `modified/`; only the
patch's context changed. `index.server.ts`, `server/crew.ts`, the relay and the steer-relay templates
were not changed upstream. Upstream's `server/send.ts` now passes `activeTurnBehavior: "steer"`
through the released typed SDK; it does not tell the first mate about a steer, so this overlay is still needed.
On 0.3.4 the 45 tests in `server/crew-relay.test.ts` pass.

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
- `touched` round-tripping through the file;
- the whole immediate note bounded, a long title and escaping included, with the title marked as data;
- a large permission request clipped to the relay cap with a `[truncated` marker;
- a failed save of the steer: the steer still goes, the failure is logged, and the first mate is warned;
- the steer saved before the worker gets the words, and the queue saved without a note before the
  first mate gets it. These two fail if either save is moved after its send.

No dependency change of its own. After merge, deploy with `paseo plugin update firstmate`, on Paseo
0.11.0 or newer.
