# Responsive status reports

This overlay applies after the seven existing patches, on their 0.3.4 base. It
does not change their UI, labels, notifications, or relay behavior.

The board returns persistent cached reports immediately and queues stale reads.
At most four host timeline reads run at once. Each result has a five-second
deadline; misses keep the prior report, or null (the existing unknown state).
Late replies still fill the cache unless a newer event, removal, or shutdown
invalidated the read.
Because the SDK cannot cancel a timeline refetch, a timed-out request retains its
concurrency slot until the host settles. A daemon that never settles its reads
can delay future refreshes, but cannot stall the board or exceed the read cap.

Reports restore from `plugin-data/firstmate/crew-reports.json` during startup.
Writes are serialized and replace that file by rename. A missing or malformed
file falls back to an empty cache; write failures leave the in-memory cache usable.
Turn-end timelines from known crew update the cache directly; events from other
agents are ignored. Board listings and report lookups establish membership,
including running crew with no previous report. A closed-agent event invalidates
the report for a later bounded refresh without discarding the last known text.

SDK source at Paseo v0.11.0: `packages/plugin/src/server/lifecycle.ts:49-54`
defines `agent.turn_ended` and its timeline; `:63` defines `agent.closed`.
The latter is absent in v0.9.0. The host's registration feature check throws
`Unknown lifecycle event: agent.closed` on older versions
(`packages/server/src/server/plugins/lifecycle/index.ts:174-179` at v0.9.0).
The plugin catches only that unsupported-event error and uses turn-end events
and polling instead. With 0.3.4 the minimum supported Paseo version is 0.11.0,
which has `agent.closed`, so that fallback is no longer expected to run; it is
kept unchanged.

`original/` holds the two existing source files before this overlay. `modified/`
holds all four changed or new source/test files. `status-line-reads.patch`
reproduces that snapshot.

Run `sh patches/status-line-reads/check.sh` to check reproduction and the files.
It compares the three files no later overlay edits with the repository root, and
`index.server.ts`, which the steer-notify overlay edits next, with that overlay's
`original/`. Set TMPDIR to an allowed temporary directory; the check retains its
scratch copy for inspection.

Check and apply from the plugin directory:

```sh
git -c core.autocrlf=false apply --check patches/status-line-reads/status-line-reads.patch
git -c core.autocrlf=false apply patches/status-line-reads/status-line-reads.patch
```

To undo, reverse this overlay before reversing the seven older patches:

```sh
git -c core.autocrlf=false apply --reverse patches/status-line-reads/status-line-reads.patch
```

Re-cut on 0.3.4: first cut on 0.2.1. Upstream did not change `index.server.ts`
or `server/fleet.ts` between 0.2.1 and 0.3.4, so the patch and both snapshots
are byte-identical to the 0.2.1 cut. On 0.3.4 the 15 report-cache tests pass.
Upstream 0.3.0's sidebar row now polls the fleet even with the screen and panels
closed, so these bounded, cached reads matter more than before.

After merge, deploy with `paseo plugin update firstmate`, on Paseo 0.11.0 or newer.
