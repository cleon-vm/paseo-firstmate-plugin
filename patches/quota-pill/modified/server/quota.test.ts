import { mkdtemp, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { describe, expect, it } from "vitest";

import { formatAge, isStale, quotaCell, quotaCells, type QuotaProvider } from "../shared/quota";
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

  it("leaves a missing provider empty without hiding the other", () => {
    const snapshot = parseQuotaFile(
      file({ claude: { fetchedAt: minutesAgo(1), readings: [quota("session", 5)] } }),
      NOW,
    );
    expect(snapshot.state).toBe("ok");
    expect(snapshot.providers[0]).toEqual({ id: "codex", session: null, weekly: null, fetchedAt: null });
    expect(quotaCells(snapshot, NOW).map((c) => c.text)).toEqual(["—", "5%"]);
  });

  it.each([
    ["not json", "{nope"],
    ["wrong version", file({}, 2)],
    ["array root", "[]"],
    ["no providers", JSON.stringify({ version: 1 })],
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

  it("uses source-aware staleness thresholds", () => {
    expect(isStale("codex", minutesAgo(11), NOW)).toBe(true);
    expect(isStale("codex", minutesAgo(9), NOW)).toBe(false);
    expect(isStale("claude", minutesAgo(30), NOW)).toBe(false);
    expect(isStale("claude", minutesAgo(46), NOW)).toBe(true);
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
