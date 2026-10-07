# Responsive status reports

This overlay applies after the six existing patches, on their original 0.2.1
base. It does not change their UI, labels, notifications, or relay behavior.

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
and polling instead. The minimum supported Paseo version remains 0.9.0.

`original/` holds the two existing source files before this overlay. `modified/`
holds all four changed or new source/test files, matching the repository with
line endings normalized. `status-line-reads.patch` reproduces that snapshot.

Run `sh patches/status-line-reads/check.sh` to check reproduction and all four
root files. Set TMPDIR to an allowed temporary directory; the check retains its
scratch copy for inspection.

Check and apply from the plugin directory:

```sh
git -c core.autocrlf=false apply --check patches/status-line-reads/status-line-reads.patch
git -c core.autocrlf=false apply patches/status-line-reads/status-line-reads.patch
```

To undo, reverse this overlay before reversing the six older patches:

```sh
git -c core.autocrlf=false apply --reverse patches/status-line-reads/status-line-reads.patch
```

After merge, deploy with `paseo plugin update firstmate`. No version bump or
upstream rebase is included here.
