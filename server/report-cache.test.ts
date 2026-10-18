import { mkdir, readFile, rename, stat, writeFile } from "node:fs/promises";
import { join } from "node:path";
import { randomUUID } from "node:crypto";
import { afterEach, describe, expect, it, vi } from "vitest";
import type { PluginLifecycleEvents, PluginLifecycleRegistration } from "@getpaseo/plugin/server";
import { FirstmateConfigSchema } from "../shared/fleet";
import { loadFleet, ReportCache } from "./fleet";
import { REPORT_CONCURRENCY, REPORT_DEADLINE_MS, registerReportCache } from "./report-cache";
import type { PaseoAgent, PaseoApi, TimelinePage } from "./host-types";

vi.mock("node:fs/promises", async (importOriginal) => {
  const actual = await importOriginal<typeof import("node:fs/promises")>();
  return { ...actual, rename: vi.fn(actual.rename) };
});

const caches: ReportCache[] = [];
const cache = (file: string | null = null) => { const value = new ReportCache(file); caches.push(value); return value; };
const agent = (id: string, updatedAt = "v1") => ({
  id, updatedAt, status: "idle", cwd: process.cwd(), archivedAt: null, workspaceId: null,
  title: id, provider: "codex", model: null, labels: { "firstmate.role": "crew" },
  pendingPermissions: [],
}) as unknown as PaseoAgent;
const page = (text: string) => ({ entries: [{ item: { type: "assistant_message", text } }] }) as TimelinePage;
const ended = (id: string, text: string) => ({
  agent: { id, workspaceId: null, parentAgentId: null, provider: "codex", cwd: process.cwd(), title: id },
  timeline: page(text).entries.map((entry) => entry.item), outcome: { kind: "completed" }, turnId: "turn",
}) as PluginLifecycleEvents["agent.turn_ended"];
function host(read: (id: string) => Promise<TimelinePage>, crew: PaseoAgent[] = []): PaseoApi {
  return {
    agents: {
      ref: (id: string) => ({ timeline: { refetch: () => read(id) } }),
      list: async () => ({ entries: crew.map((agent) => ({ agent })), pageInfo: { nextCursor: null } }),
    },
    config: { get: async () => ({ config: { mcp: { injectIntoAgents: true } } }) },
  } as unknown as PaseoApi;
}
async function settled() { for (let n = 0; n < 12; n += 1) await Promise.resolve(); }
afterEach(() => {
  caches.splice(0).forEach((value) => value.stop());
  vi.useRealTimers();
  vi.unstubAllEnvs();
  vi.mocked(rename).mockClear();
});

describe("background status reports", () => {
  it("keeps the per-read deadline well below the board's 30-second timeout", () => {
    expect(REPORT_DEADLINE_MS).toBeGreaterThan(0);
    expect(REPORT_DEADLINE_MS).toBeLessThan(30_000);
  });

  it("fills every crew report across repeated polls when all reads exceed the deadline", async () => {
    vi.useFakeTimers();
    let active = 0;
    let peak = 0;
    const read = vi.fn((id: string) => new Promise<TimelinePage>((resolve) => {
      active += 1;
      peak = Math.max(peak, active);
      setTimeout(() => {
        active -= 1;
        resolve(page(`done: report ${id}`));
      }, REPORT_DEADLINE_MS + 1_000);
    }));
    const paseo = host(read);
    const reports = cache();
    const crew = Array.from({ length: 12 }, (_, n) => agent(String(n)));
    for (let poll = 0; poll < 5; poll += 1) {
      crew.forEach((member) => reports.reportFor(paseo, member));
      await vi.advanceTimersByTimeAsync(REPORT_DEADLINE_MS);
    }
    expect(crew.map((member) => reports.reportFor(paseo, member)?.text))
      .toEqual(crew.map((member) => `report ${member.id}`));
    expect(read).toHaveBeenCalledTimes(crew.length);
    expect(peak).toBeLessThanOrEqual(REPORT_CONCURRENCY);
  });

  it("wires lifecycle hooks and plugin storage through registerReportCache", async () => {
    const home = join(process.cwd(), "scratch", "wiring", randomUUID());
    vi.stubEnv("PASEO_HOME", home);
    const handlers = new Map<string, (event: unknown) => void>();
    const server = { on: (name: string, handler: (event: unknown) => void) => {
      handlers.set(name, handler); return () => handlers.delete(name);
    } } as unknown as PluginLifecycleRegistration;
    const reports = registerReportCache(server);
    caches.push(reports);
    expect([...handlers.keys()]).toEqual(["agent.turn_ended", "agent.closed"]);
    reports.retain(new Set(["crew"]));
    handlers.get("agent.turn_ended")!(ended("crew", "done: wired"));
    await reports.flush();
    const file = join(home, "plugin-data", "firstmate", "crew-reports.json");
    expect(JSON.parse(await readFile(file, "utf8"))).toEqual([
      { id: "crew", updatedAt: "", report: { state: "done", text: "wired" } },
    ]);
    expect(cache(file).reportFor(host(() => new Promise(() => {})), { ...agent("crew"), status: "running" })?.text)
      .toBe("wired");
    reports.stop();
    expect(handlers.size).toBe(0);
  });

  it("ignores non-crew turn-end status lines, including after membership is pruned", async () => {
    const file = join(process.cwd(), "scratch", "reports", `${randomUUID()}.json`);
    const reports = cache(file);
    const paseo = host(() => new Promise(() => {}));
    reports.reportFor(paseo, { ...agent("crew"), status: "running" });
    reports.turnEnded(ended("unrelated", "done: unrelated task"));
    reports.turnEnded(ended("crew", "paused: crew task"));
    await reports.flush();
    expect(JSON.parse(await readFile(file, "utf8"))).toEqual([
      { id: "crew", updatedAt: "", report: { state: "paused", text: "crew task" } },
    ]);
    reports.retain(new Set());
    reports.turnEnded(ended("crew", "done: no longer crew"));
    await reports.flush();
    expect(JSON.parse(await readFile(file, "utf8"))).toEqual([]);
  });

  it("replaces the saved cache atomically and leaves no temporary file after success", async () => {
    const folder = join(process.cwd(), "scratch", "reports");
    await mkdir(folder, { recursive: true });
    const file = join(folder, `${randomUUID()}.json`);
    const original = JSON.stringify([{ id: "crew", updatedAt: "v1", report: { state: "paused", text: "old" } }]);
    await writeFile(file, original);
    const reports = cache(file);
    const actual = await vi.importActual<typeof import("node:fs/promises")>("node:fs/promises");
    let savedBeforeRename: string | undefined;
    let replacement: string | undefined;
    vi.mocked(rename).mockImplementationOnce(async (from, to) => {
      savedBeforeRename = await readFile(file, "utf8");
      replacement = await readFile(from, "utf8");
      return actual.rename(from, to);
    });
    reports.turnEnded(ended("crew", "done: new"));
    await reports.flush();
    expect(savedBeforeRename).toBe(original);
    expect(JSON.parse(replacement!)[0].report.text).toBe("new");
    expect(vi.mocked(rename)).toHaveBeenCalledWith(`${file}.tmp`, file);
    expect(await readFile(file, "utf8")).toBe(replacement);
    await expect(stat(`${file}.tmp`)).rejects.toMatchObject({ code: "ENOENT" });
  });

  it("rethrows unexpected lifecycle registration errors instead of treating them as old-host fallback", () => {
    const reports = cache();
    const server = { on: (name: string) => {
      if (name === "agent.closed") throw new Error("lifecycle registration failed");
      return () => {};
    } } as unknown as PluginLifecycleRegistration;
    expect(() => reports.register(server)).toThrow("lifecycle registration failed");
  });

  it("caps actual reads across repeated polls, including reads past their deadline", async () => {
    vi.useFakeTimers();
    const finish: Array<(value: TimelinePage) => void> = [];
    const read = vi.fn(() => new Promise<TimelinePage>((resolve) => finish.push(resolve)));
    const paseo = host(read);
    const reports = cache();
    const crew = Array.from({ length: 20 }, (_, n) => agent(String(n)));
    crew.forEach((member) => expect(reports.reportFor(paseo, member)).toBeNull());
    await settled();
    expect(read).toHaveBeenCalledTimes(REPORT_CONCURRENCY);
    await vi.advanceTimersByTimeAsync(REPORT_DEADLINE_MS * 3);
    crew.forEach((member) => reports.reportFor(paseo, member));
    await settled();
    expect(read).toHaveBeenCalledTimes(REPORT_CONCURRENCY);
    finish[0]!(page("done: late"));
    await settled();
    expect(read).toHaveBeenCalledTimes(REPORT_CONCURRENCY + 1);
    expect(reports.reportFor(paseo, crew[0]!)).toEqual({ state: "done", text: "late" });
  });

  it("applies each read's deadline from its own start, and keeps cached reports on timeout", async () => {
    vi.useFakeTimers();
    const finish: Array<(value: TimelinePage) => void> = [];
    const read = vi.fn(() => new Promise<TimelinePage>((resolve) => finish.push(resolve)));
    const paseo = host(read);
    const reports = cache();
    reports.retain(new Set(["0"]));
    reports.turnEnded(ended("0", "blocked: awaiting review"));
    for (let n = 0; n < 5; n += 1) reports.reportFor(paseo, agent(String(n)));
    await settled();
    await vi.advanceTimersByTimeAsync(REPORT_DEADLINE_MS - 1);
    finish[1]!(page("done: on time"));
    await settled();
    expect(read).toHaveBeenCalledTimes(5);
    await vi.advanceTimersByTimeAsync(2);
    expect(reports.reportFor(paseo, agent("0"))).toEqual({ state: "blocked", text: "awaiting review" });
    reports.turnEnded(ended("0", "paused: newer event"));
    finish[0]!(page("done: stale late reply"));
    finish[4]!(page("paused: queued read started later"));
    await settled();
    expect(reports.reportFor(paseo, agent("0"))).toEqual({ state: "paused", text: "newer event" });
    expect(reports.reportFor(paseo, agent("1"))).toEqual({ state: "done", text: "on time" });
    expect(reports.reportFor(paseo, agent("4"))).toEqual({ state: "paused", text: "queued read started later" });
  });

  it("restores persistent status immediately after a simulated restart", async () => {
    const file = join(process.cwd(), "scratch", "reports", `${randomUUID()}.json`);
    const first = cache(file);
    first.retain(new Set(["crew"]));
    first.turnEnded(ended("crew", "done: PR https://example.com/pull/1"));
    await first.flush();
    first.stop();
    const restarted = cache(file);
    const paseo = host(() => new Promise(() => {}));
    expect(restarted.reportFor(paseo, agent("crew"))).toEqual({ state: "done", text: "PR https://example.com/pull/1" });
    expect(JSON.parse(await readFile(file, "utf8"))).toHaveLength(1);
  });

  it("refreshes events and prevents an older timeline from overwriting a turn-end report", async () => {
    let finish!: (value: TimelinePage) => void;
    const read = vi.fn(() => new Promise<TimelinePage>((resolve) => { finish = resolve; }));
    const paseo = host(read);
    const reports = cache();
    const handlers = new Map<string, (event: unknown) => void>();
    const server = { on: (name: string, handler: (event: unknown) => void) => {
      handlers.set(name, handler); return () => handlers.delete(name);
    } } as unknown as PluginLifecycleRegistration;
    reports.register(server);
    reports.reportFor(paseo, agent("crew"));
    await settled();
    handlers.get("agent.turn_ended")!(ended("crew", "paused: new report"));
    finish(page("done: stale report"));
    await settled();
    expect(reports.reportFor(paseo, agent("crew", "v2"))).toEqual({ state: "paused", text: "new report" });
    handlers.get("agent.closed")!({ agent: { id: "crew" } });
    expect(reports.reportFor(paseo, { ...agent("crew"), status: "running" })).toEqual({ state: "paused", text: "new report" });
    reports.stop();
    expect(handlers.size).toBe(0);
  });

  it("falls back on older hosts that do not support agent.closed", () => {
    const reports = cache();
    const names: string[] = [];
    const server = { on: (name: string) => {
      if (name === "agent.closed") throw new Error("Unknown lifecycle event: agent.closed");
      names.push(name); return () => {};
    } } as unknown as PluginLifecycleRegistration;
    expect(() => reports.register(server)).not.toThrow();
    expect(names).toEqual(["agent.turn_ended"]);
  });

  it("uses a fresh persisted cache without polling and leaves running agents alone", async () => {
    const file = join(process.cwd(), "scratch", "reports", `${randomUUID()}.json`);
    const first = cache(file);
    const read = vi.fn(async () => page("done: cached"));
    const paseo = host(read);
    first.reportFor(paseo, agent("crew"));
    await settled();
    await first.flush();
    const restarted = cache(file);
    expect(restarted.reportFor(paseo, agent("crew"))?.text).toBe("cached");
    expect(restarted.reportFor(paseo, { ...agent("crew", "v2"), status: "running" })?.text).toBe("cached");
    await settled();
    expect(read).toHaveBeenCalledTimes(1);
  });

  it("returns the whole board when every status read hangs, rejects or throws", async () => {
    const home = join(process.cwd(), "scratch", "board", randomUUID());
    await mkdir(join(home, "data"), { recursive: true });
    const crew = [agent("hang"), agent("reject"), agent("throw")];
    const paseo = host((id) => {
      if (id === "reject") return Promise.reject(new Error("daemon restarting"));
      if (id === "throw") throw new Error("disconnected");
      return new Promise(() => {});
    }, crew);
    const reports = cache();
    reports.retain(new Set(["hang"]));
    reports.turnEnded(ended("hang", "blocked: cached"));
    const fleet = await loadFleet(paseo, FirstmateConfigSchema.parse({ home }), reports);
    expect(fleet.cards).toHaveLength(3);
    expect(fleet.cards.find((card) => card.agent?.id === "hang")?.report?.text).toBe("cached");
    await settled();
    expect((await loadFleet(paseo, FirstmateConfigSchema.parse({ home }), reports)).cards).toHaveLength(3);
  });

  it("does not erase persisted reports when crew listing fails", async () => {
    const home = join(process.cwd(), "scratch", "board", randomUUID());
    const reports = cache();
    reports.retain(new Set(["crew"]));
    reports.turnEnded(ended("crew", "paused: remembered"));
    const paseo = host(() => new Promise(() => {}));
    paseo.agents.list = async () => { throw new Error("offline"); };
    const fleet = await loadFleet(paseo, FirstmateConfigSchema.parse({ home }), reports);
    expect(fleet.warnings.some((warning) => warning.includes("offline"))).toBe(true);
    expect(reports.reportFor(paseo, { ...agent("crew"), status: "running" })?.text).toBe("remembered");
  });

  it("tolerates malformed storage and ignores invalid records", async () => {
    const folder = join(process.cwd(), "scratch", "reports");
    await mkdir(folder, { recursive: true });
    const file = join(folder, `${randomUUID()}.json`);
    await writeFile(file, JSON.stringify([{ id: "bad", updatedAt: "v1", report: { state: "bogus" } }]));
    expect(cache(file).reportFor(host(() => new Promise(() => {})), agent("bad"))).toBeNull();
  });
});
