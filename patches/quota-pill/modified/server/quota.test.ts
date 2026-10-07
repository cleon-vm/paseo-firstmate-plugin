import { mkdtemp, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { describe, expect, it } from "vitest";

import {
  MAX_PROVIDER_ID,
  QuotaSnapshotSchema,
  formatAge,
  isQuotaProviderId,
  isStale,
  providerName,
  quotaCell,
  quotaCells,
  sortProviderIds,
  type QuotaProvider,
} from "../shared/quota";
import { MAX_FILE_BYTES, parseQuotaFile, readQuotaSnapshot } from "./quota";

const NOW = Date.parse("2026-01-01T12:00:00.000Z");
const minutesAgo = (m: number) => new Date(NOW - m * 60_000).toISOString();

function quota(id: string, percent: unknown, label = "Session", resetsAt: string | null = "2026-01-01T15:00:00Z") {
  return { kind: "quota", id, label, percent, window: { label, resetsAt, durationMs: 1 } };
}
function file(providers: Record<string, unknown>, version: unknown = 1) {
  return JSON.stringify({ version, providers });
}
const good = file({
  codex: { fetchedAt: minutesAgo(2), readings: [quota("session", 32), quota("weekly", 10, "Weekly", null)] },
  claude: { fetchedAt: minutesAgo(1), readings: [quota("session", 61.4), quota("weekly", 4, "Weekly")] },
});

describe("parseQuotaFile", () => {
  it("keeps percent, window, reset and read time only", () => {
    const snapshot = parseQuotaFile(good, NOW);
    expect(snapshot.state).toBe("ok");
    expect(snapshot.providers[0]).toEqual({
      id: "codex",
      session: { usedPercent: 32, window: "Session", resetsAt: "2026-01-01T15:00:00.000Z" },
      weekly: { usedPercent: 10, window: "Weekly", resetsAt: null },
      fetchedAt: minutesAgo(2),
    });
  });

  it("does not list a provider the file does not have", () => {
    const snapshot = parseQuotaFile(
      file({ claude: { fetchedAt: minutesAgo(1), readings: [quota("session", 5)] } }),
      NOW,
    );
    expect(snapshot.state).toBe("ok");
    expect(snapshot.providers.map((p) => p.id)).toEqual(["claude"]);
    expect(quotaCells(snapshot, NOW).map((c) => c.text)).toEqual(["5%"]);
  });

  it("shows every provider in the file: known ones first, the rest alphabetically", () => {
    const snapshot = parseQuotaFile(
      file({
        "opencode-go": { fetchedAt: minutesAgo(1), readings: [quota("session", 12)] },
        zeta: { fetchedAt: minutesAgo(1), readings: [] },
        codex: { fetchedAt: minutesAgo(2), readings: [quota("session", 76)] },
        alpha: { fetchedAt: minutesAgo(1), readings: [quota("session", 3)] },
      }),
      NOW,
    );
    expect(snapshot.state).toBe("ok");
    expect(snapshot.providers.map((p) => p.id)).toEqual(["codex", "alpha", "opencode-go", "zeta"]);
    expect(quotaCells(snapshot, NOW).map((c) => [c.id, c.text])).toEqual([
      ["codex", "76%"],
      ["alpha", "3%"],
      ["opencode-go", "12%"],
      ["zeta", "—"],
    ]);
    expect(QuotaSnapshotSchema.parse(snapshot)).toEqual(snapshot);
  });

  it("skips keys that are not provider ids and keeps the rest", () => {
    const entry = { fetchedAt: minutesAgo(1), readings: [quota("session", 1)] };
    const snapshot = parseQuotaFile(
      file({ "": entry, " codex": entry, ["x".repeat(MAX_PROVIDER_ID + 1)]: entry, "bad\nid": entry, claude: entry }),
      NOW,
    );
    expect(snapshot.providers.map((p) => p.id)).toEqual(["claude"]);
  });

  it("treats prototype-named keys as plain providers", () => {
    const text = '{"version":1,"providers":{"__proto__":{"fetchedAt":"' + minutesAgo(1) + '","readings":[]},"constructor":{}}}';
    const snapshot = parseQuotaFile(text, NOW);
    expect(snapshot.providers.map((p) => p.id)).toEqual(["__proto__", "constructor"]);
    expect(quotaCells(snapshot, NOW).map((c) => c.label)).toEqual([
      "Proto: no quota reading",
      "Constructor: no quota reading",
    ]);
  });

  it.each([
    ["not json", "{nope"],
    ["wrong version", file({}, 2)],
    ["array root", "[]"],
    ["no providers", JSON.stringify({ version: 1 })],
    ["providers as an array", JSON.stringify({ version: 1, providers: [{ id: "codex" }] })],
    ["providers as a string", JSON.stringify({ version: 1, providers: "codex" })],
  ])("is unavailable for %s", (_name, text) => {
    expect(parseQuotaFile(text, NOW)).toEqual({ state: "unavailable", providers: [] });
  });

  it("drops bad readings: out-of-range or non-numeric percent, bad or future timestamp", () => {
    const snapshot = parseQuotaFile(
      file({
        codex: { fetchedAt: minutesAgo(1), readings: [quota("session", 140), quota("weekly", "12")] },
        claude: { fetchedAt: new Date(NOW + 3_600_000).toISOString(), readings: [quota("session", 5)] },
      }),
      NOW,
    );
    expect(snapshot.providers[0]?.session).toBeNull();
    expect(snapshot.providers[0]?.weekly).toBeNull();
    expect(snapshot.providers[1]?.session).toBeNull();
    const badTime = parseQuotaFile(file({ codex: { fetchedAt: "garbage", readings: [quota("session", 1)] } }), NOW);
    expect(badTime.providers[0]?.session).toBeNull();
  });

  it("passes on no extra fields", () => {
    const text = file({
      codex: { fetchedAt: minutesAgo(1), token: "secret-value", readings: [{ ...quota("session", 3), token: "secret-value" }] },
    });
    expect(JSON.stringify(parseQuotaFile(text, NOW))).not.toContain("secret-value");
  });
});

describe("readQuotaSnapshot", () => {
  it("is unavailable for a missing file and an oversized one, ok for a good one", async () => {
    const dir = await mkdtemp(join(tmpdir(), "quota-"));
    expect((await readQuotaSnapshot(join(dir, "none.json"), NOW)).state).toBe("unavailable");
    const big = join(dir, "big.json");
    await writeFile(big, " ".repeat(MAX_FILE_BYTES + 1));
    expect((await readQuotaSnapshot(big, NOW)).state).toBe("unavailable");
    const ok = join(dir, "ok.json");
    await writeFile(ok, good);
    expect((await readQuotaSnapshot(ok, NOW)).state).toBe("ok");
  });
});

describe("formatting", () => {
  const codex = (fetchedAt: string | null, percent = 32): QuotaProvider => ({
    id: "codex",
    session: { usedPercent: percent, window: "Session", resetsAt: null },
    weekly: null,
    fetchedAt,
  });

  it("shows percent used for both providers", () => {
    expect(quotaCells(parseQuotaFile(good, NOW), NOW).map((c) => c.text)).toEqual(["32%", "61%"]);
  });

  it("uses source-aware staleness thresholds, 10 minutes for providers without their own", () => {
    expect(isStale("codex", minutesAgo(11), NOW)).toBe(true);
    expect(isStale("codex", minutesAgo(9), NOW)).toBe(false);
    expect(isStale("claude", minutesAgo(30), NOW)).toBe(false);
    expect(isStale("claude", minutesAgo(46), NOW)).toBe(true);
    expect(isStale("opencode-go", minutesAgo(9), NOW)).toBe(false);
    expect(isStale("opencode-go", minutesAgo(11), NOW)).toBe(true);
    expect(isStale("toString", minutesAgo(11), NOW)).toBe(true);
  });

  it("names known providers as before and others from their id", () => {
    expect(["codex", "claude", "opencode-go", "my_tool.v2", "toString"].map(providerName)).toEqual([
      "Codex",
      "Claude",
      "Opencode Go",
      "My Tool V2",
      "ToString",
    ]);
    const cell = quotaCell({ ...codex(minutesAgo(1), 40), id: "opencode-go" }, "opencode-go", NOW);
    expect(cell.label).toBe("Opencode Go: 40 percent used, Session window, updated 1m ago");
  });

  it("validates provider ids and orders them", () => {
    expect(["codex", "opencode-go", "x".repeat(MAX_PROVIDER_ID)].every(isQuotaProviderId)).toBe(true);
    expect(["", " a", "a ", "a\u0007b", "x".repeat(MAX_PROVIDER_ID + 1), 3, null].some(isQuotaProviderId)).toBe(false);
    expect(sortProviderIds(["zed", "claude", "beta", "codex", "beta"])).toEqual(["codex", "claude", "beta", "zed"]);
    expect(() => QuotaSnapshotSchema.parse({ state: "ok", providers: [{ id: "", session: null, weekly: null, fetchedAt: null }] })).toThrow();
  });

  it("keeps the last value and shows its age when stale", () => {
    const cell = quotaCell(codex(minutesAgo(125)), "codex", NOW);
    expect(cell.text).toBe("32% · 2h old");
    expect(cell.stale).toBe(true);
    expect(cell.tone).toBe("warning");
    expect(cell.label).toBe("Codex: 32 percent used, Session window, stale, updated 2h ago");
  });

  it("colours by how much is used", () => {
    expect(quotaCell(codex(minutesAgo(1), 80), "codex", NOW).tone).toBe("warning");
    expect(quotaCell(codex(minutesAgo(1), 95), "codex", NOW).tone).toBe("danger");
  });

  it("formats ages", () => {
    expect([0, 5 * 60_000, 3 * 3_600_000, 72 * 3_600_000].map(formatAge)).toEqual(["just now", "5m", "3h", "3d"]);
  });
});
