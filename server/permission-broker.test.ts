import { mkdir, mkdtemp, readFile, readdir, writeFile } from "node:fs/promises";
import { readFileSync, realpathSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";

import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

import type { FirstmateConfig } from "../shared/fleet";
import { MAX_LOGGED_COMMAND, PermissionBroker, readBrokerState, redact, registerPermissionBroker, type BrokerState } from "./permission-broker";
import { NEVER_AUTO } from "./permit-rules";

// A synthetic machine inside a temporary folder: every name and repository here is made up.
const TASK = "demo-01-example";
const T0 = Date.parse("2026-10-12T09:14:03.120Z");

interface Machine {
  root: string;
  user: string;
  home: string;
  worktree: string;
  notes: string;
  scratch: string;
  stateFile: string;
}

async function machine(): Promise<Machine> {
  const root = realpathSync.native(await mkdtemp(join(tmpdir(), "permission-broker-")));
  const user = join(root, "Users", "example");
  const home = join(user, ".paseo", "plugin-data", "firstmate", "home");
  const worktree = join(user, ".paseo", "worktrees", "abc123", TASK);
  const notes = join(home, "data", TASK);
  const scratch = join(user, "AppData", "Local", "Temp", "fm-demo-01");
  for (const dir of [notes, worktree, scratch, join(home, "data", "permissions", "permits")]) await mkdir(dir, { recursive: true });
  return { root, user, home, worktree, notes, scratch, stateFile: join(root, "plugin-data", "permission-broker.json") };
}

async function writePermits(m: Machine, overrides: Record<string, unknown> = {}, task = TASK): Promise<void> {
  const permits = {
    version: 1,
    task,
    live: false,
    writeDirs: [`data/${TASK}`],
    scratchDirs: [m.scratch],
    readRepos: [],
    netRead: { githubRepos: ["octo/example"], hosts: [] },
    gitLocal: true,
    exec: [{ in: "scratch", prefix: ["npm.cmd", "test"] }],
    envNames: ["PYTHONUTF8"],
    ...overrides,
  };
  await writeFile(join(m.home, "data", "permissions", "permits", `${task}.json`), JSON.stringify(permits));
}

/** The command line Codex sends, from the Program Files pwsh. */
function wrap(script: string): string {
  return `"C:\\Program Files\\PowerShell\\7\\pwsh.exe" -Command '${script.replace(/'/g, "''")}'`;
}

type Handler = (event: unknown, context: { paseo: unknown; signal: AbortSignal }) => unknown;

class FakeServer {
  handlers = new Map<string, Set<Handler>>();
  on(name: string, handler: Handler) {
    const set = this.handlers.get(name) ?? new Set();
    set.add(handler);
    this.handlers.set(name, set);
    return () => set.delete(handler);
  }
  async emit(name: string, event: unknown, paseo: unknown) {
    for (const handler of this.handlers.get(name) ?? []) await handler(structuredClone(event), { paseo, signal: new AbortController().signal });
  }
  count(): number {
    return [...this.handlers.values()].reduce((sum, set) => sum + set.size, 0);
  }
}

/** A daemon whose every write to an agent is recorded: the broker must make none. */
class FakeDaemon {
  labels = new Map<string, Record<string, string>>();
  writes: string[] = [];
  lookups = 0;
  answers: Array<{ agentId: string; requestId: string; response: { behavior: string } }> = [];
  answerError: Error | null = null;
  answerPending = false;
  answerStarted = vi.fn();

  api() {
    const record = (what: string) => async () => {
      this.writes.push(what);
    };
    return {
      agents: {
        ref: (id: string) => ({
          refresh: async () => {
            this.lookups += 1;
            const labels = this.labels.get(id);
            if (labels === undefined) throw new Error(`Agent not found: ${id}`);
            return { agent: { id, labels, archivedAt: null, pendingPermissions: [] } };
          },
          respondToPermission: async (input: { requestId: string; response: { behavior: string } }) => {
            this.writes.push(`respondToPermission ${id}`);
            this.answers.push({ agentId: id, ...input });
            this.answerStarted();
            if (this.answerError !== null) throw this.answerError;
            if (this.answerPending) await new Promise(() => undefined);
          },
          send: record(`send ${id}`),
          interrupt: record(`interrupt ${id}`),
          archive: record(`archive ${id}`),
        }),
      },
    };
  }
}

function agent(m: Machine, id = "crew-1") {
  return { id, workspaceId: null, parentAgentId: "mate-1", provider: "codex", cwd: m.worktree, title: "Demo" };
}

function permissionRequested(m: Machine, script: string, options: { id?: string; requestId?: string; cwd?: string; request?: Record<string, unknown> } = {}) {
  return {
    agent: agent(m, options.id),
    request: {
      id: options.requestId ?? "permission-exec-1",
      provider: "codex",
      name: "CodexBash",
      kind: "tool",
      title: "Run command",
      description: "the crewmate's own reason, not to be logged",
      input: { command: wrap(script), cwd: options.cwd ?? m.worktree },
      ...options.request,
    },
  };
}

interface Setup {
  m: Machine;
  daemon: FakeDaemon;
  server: FakeServer;
  config: { current: FirstmateConfig };
  wired: ReturnType<typeof registerPermissionBroker>;
  paseo: unknown;
  lines: () => Promise<Array<Record<string, unknown>>>;
}

async function setup(mode: FirstmateConfig["permissionBroker"] = "shadow", options: { append?: (path: string, text: string) => Promise<void>; realpath?: (path: string) => string | null } = {}): Promise<Setup> {
  const m = await machine();
  const daemon = new FakeDaemon();
  daemon.labels.set("crew-1", { "firstmate.role": "crew", "firstmate.task": TASK, "firstmate.plan": "demo-plan" });
  daemon.labels.set("crew-2", { "firstmate.role": "crew", "firstmate.task": TASK });
  daemon.labels.set("mate-1", { "firstmate.role": "first-mate", "firstmate.task": TASK });
  daemon.labels.set("other-1", { "some.label": "x", "firstmate.task": TASK });
  daemon.labels.set("crew-reserved", { "firstmate.role": "crew", "firstmate.task": "permissions" });
  daemon.labels.set("crew-notask", { "firstmate.role": "crew" });
  const server = new FakeServer();
  const config = { current: { home: m.home, mateAgentId: "mate-1", permissionBroker: mode } as FirstmateConfig };
  const wired = registerPermissionBroker(server as never, async () => config.current, {
    stateFile: m.stateFile,
    userHome: m.user,
    now: () => T0,
    ...(options.append === undefined ? {} : { append: options.append }),
    ...(options.realpath === undefined ? {} : { realpath: options.realpath }),
  });
  await wired.ready;
  const lines = async () => {
    const dir = join(m.home, "data", "permissions");
    const files = (await readdir(dir)).filter((name) => name.endsWith(".jsonl"));
    const text = (await Promise.all(files.map((name) => readFile(join(dir, name), "utf8")))).join("");
    return text
      .split("\n")
      .filter((line) => line !== "")
      .map((line) => JSON.parse(line) as Record<string, unknown>);
  };
  return { m, daemon, server, config, wired, paseo: daemon.api(), lines };
}

const ALLOWED_SCRIPT = (m: Machine) => `New-Item -ItemType Directory -Path '${m.notes}\\review-scratch-1'`;

let errors: ReturnType<typeof vi.spyOn>;
beforeEach(() => {
  errors = vi.spyOn(console, "error").mockImplementation(() => undefined);
});
afterEach(() => {
  vi.useRealTimers();
  errors.mockRestore();
});

// ---------------------------------------------------------------------------
// 4. Shadow never answers
// ---------------------------------------------------------------------------

describe("shadow never answers", () => {
  it("never answers in shadow and only answers matching live fixtures with allow", async () => {
    for (const mode of ["shadow", "live"] as const) {
      const s = await setup(mode);
      await writePermits(s.m, { live: true, exec: [{ in: "worktree", prefix: ["node"] }] });
      const scripts = [
        ALLOWED_SCRIPT(s.m),
        "npm.cmd test",
        "git --no-optional-locks status",
        ...NEVER_AUTO.flatMap((entry) => entry.cases.map((testCase) => testCase.script ?? "Get-Date")),
      ];
      let index = 0;
      for (const script of scripts) {
        index += 1;
        await s.server.emit("agent.permission_requested", permissionRequested(s.m, script, { requestId: `permission-exec-${index}`, id: "crew-2" }), s.paseo);
        await s.server.emit("agent.permission_resolved", { agent: agent(s.m, "crew-2"), requestId: `permission-exec-${index}`, resolution: { behavior: "allow" } }, s.paseo);
      }
      const lines = await s.lines();
      expect(lines.filter((line) => line.event === "request")).toHaveLength(scripts.length);
      if (mode === "shadow") {
        expect(s.daemon.writes).toEqual([]);
        expect(lines.every((line) => line.event !== "request" || line.answered === false)).toBe(true);
      } else {
        const requests = lines.filter((line) => line.event === "request");
        expect(s.daemon.answers).toHaveLength(requests.filter((line) => line.verdict === "allow").length);
        expect(requests.every((line) => line.answered === (line.verdict === "allow"))).toBe(true);
        expect(s.daemon.answers.every((answer) => answer.response.behavior === "allow")).toBe(true);
        expect(s.daemon.writes.every((write) => write === "respondToPermission crew-2")).toBe(true);
      }
      expect(lines.some((line) => line.verdict === "allow")).toBe(true);
    }
    // Every fixture through real file I/O, twice: about 4 s alone, more beside the rest of the suite.
  }, 30_000);

  it("has no message path, and only the broker can name the answer SDK", async () => {
    for (const file of ["permission-broker.ts", "permit-match.ts", "permit-rules.ts"]) {
      const source = await readFile(join(import.meta.dirname, file), "utf8");
      expect(source, file).not.toMatch(/\.send\(|sendWithoutInterrupting/);
      if (file !== "permission-broker.ts") expect(source, file).not.toContain("respondToPermission");
    }
  });
});

describe("live answers", () => {
  it("answers a matching request once with allow", async () => {
    const s = await setup("live");
    await writePermits(s.m, { live: true });
    const event = permissionRequested(s.m, ALLOWED_SCRIPT(s.m));
    await s.server.emit("agent.permission_requested", event, s.paseo);
    expect(s.daemon.answers).toEqual([{ agentId: "crew-1", requestId: "permission-exec-1", response: { behavior: "allow" } }]);
    expect((await s.lines())[0]).toMatchObject({ mode: "live", verdict: "allow", answered: true });
    expect(s.daemon.writes).toEqual(["respondToPermission crew-1"]);
  });

  it("does not answer the same request twice, including concurrent hooks and a reload", async () => {
    const s = await setup("live");
    await writePermits(s.m, { live: true });
    const event = permissionRequested(s.m, ALLOWED_SCRIPT(s.m));
    await Promise.all([s.server.emit("agent.permission_requested", event, s.paseo), s.server.emit("agent.permission_requested", event, s.paseo)]);
    s.wired.stop();
    const reloaded = registerPermissionBroker(s.server as never, async () => s.config.current, { stateFile: s.m.stateFile, userHome: s.m.user, now: () => T0 });
    await reloaded.ready;
    await s.server.emit("agent.permission_requested", event, s.paseo);
    expect(s.daemon.answers).toHaveLength(1);
    expect((await s.lines()).filter((line) => line.answered === true)).toHaveLength(1);
  });

  it("logs a failed SDK call by error class only and never retries or sends a message", async () => {
    const s = await setup("live");
    await writePermits(s.m, { live: true });
    s.daemon.answerError = new TypeError("private SDK detail must not be logged");
    const event = permissionRequested(s.m, ALLOWED_SCRIPT(s.m));
    await s.server.emit("agent.permission_requested", event, s.paseo);
    await s.server.emit("agent.permission_requested", event, s.paseo);
    const lines = await s.lines();
    expect(lines[0]).toMatchObject({ answered: false, answerError: "TypeError" });
    expect(JSON.stringify(lines)).not.toContain("private SDK detail");
    expect(s.daemon.writes).toEqual(["respondToPermission crew-1"]);
  });

  it("times out a hanging SDK call after ten seconds and never retries", async () => {
    const s = await setup("live");
    await writePermits(s.m, { live: true });
    s.daemon.answerPending = true;
    const started = new Promise<void>((resolve) => s.daemon.answerStarted.mockImplementation(resolve));
    vi.useFakeTimers({ toFake: ["setTimeout", "clearTimeout"] });
    const event = permissionRequested(s.m, ALLOWED_SCRIPT(s.m));
    const hook = s.server.emit("agent.permission_requested", event, s.paseo);
    await started;
    await vi.advanceTimersByTimeAsync(10_000);
    await hook;
    expect((await s.lines())[0]).toMatchObject({ answered: false, answerError: "TimeoutError" });
    await s.server.emit("agent.permission_requested", event, s.paseo);
    expect(s.daemon.answers).toHaveLength(1);
  });

  it("rechecks paths after saving the reservation and relays a changed junction", async () => {
    let checks = 0;
    const s = await setup("live", { realpath: (path) => {
      if (path.endsWith("review-scratch-1")) return ++checks === 1 ? path : "C:\\Outside\\example";
      return path;
    } });
    await writePermits(s.m, { live: true });
    await s.server.emit("agent.permission_requested", permissionRequested(s.m, ALLOWED_SCRIPT(s.m)), s.paseo);
    expect(checks).toBeGreaterThanOrEqual(2);
    expect(s.daemon.answers).toEqual([]);
    expect((await s.lines())[0]).toMatchObject({ verdict: "relay", answered: false });
  });

  it.each(["shadow", "off"] as const)("honors switching live to %s during matching without reload", async (mode) => {
    let s: Setup;
    s = await setup("live", { realpath: (path) => {
      s.config.current = { ...s.config.current, permissionBroker: mode };
      return path;
    } });
    await writePermits(s.m, { live: true });
    await s.server.emit("agent.permission_requested", permissionRequested(s.m, ALLOWED_SCRIPT(s.m)), s.paseo);
    expect(s.daemon.answers).toEqual([]);
    expect((await s.lines())[0]).toMatchObject({ rule: "changed", answered: false });
  });

  it("never answers when the durable reservation cannot be saved", async () => {
    const s = await setup("live");
    await writePermits(s.m, { live: true });
    await mkdir(s.m.stateFile, { recursive: true });
    await s.server.emit("agent.permission_requested", permissionRequested(s.m, ALLOWED_SCRIPT(s.m)), s.paseo);
    expect(s.daemon.answers).toEqual([]);
    expect((await s.lines())[0]).toMatchObject({ rule: "state-error", answered: false });
  });

  it("attributes only an allow sent for this agent and request within thirty seconds", async () => {
    const s = await setup("live");
    await writePermits(s.m, { live: true });
    await s.server.emit("agent.permission_requested", permissionRequested(s.m, ALLOWED_SCRIPT(s.m)), s.paseo);
    for (const [id, requestId, behavior] of [["crew-1", "permission-exec-1", "allow"], ["crew-2", "permission-exec-1", "allow"], ["crew-1", "other", "allow"], ["crew-1", "permission-exec-1", "deny"]]) {
      await s.server.emit("agent.permission_resolved", { agent: agent(s.m, id), requestId, resolution: { behavior } }, s.paseo);
    }
    expect((await s.lines()).filter((line) => line.event === "resolved").map((line) => line.byBroker)).toEqual([true, false, false, false]);
  });

  it("never answers live:false or shadow even when the same command matches live:true", async () => {
    for (const [mode, live, count] of [["live", true, 1], ["live", false, 0], ["shadow", true, 0]] as const) {
      const s = await setup(mode);
      await writePermits(s.m, { live });
      await s.server.emit("agent.permission_requested", permissionRequested(s.m, ALLOWED_SCRIPT(s.m)), s.paseo);
      expect(s.daemon.answers).toHaveLength(count);
      expect((await s.lines())[0]?.answered).toBe(count === 1);
    }
  });

  it("never exceeds the hourly rate limit when matching hooks arrive together", async () => {
    const s = await setup("live");
    await writePermits(s.m, { live: true });
    await mkdir(join(s.m.root, "plugin-data"), { recursive: true });
    await writeFile(s.m.stateFile, JSON.stringify({ sticky: {}, allows: { "crew-1": Array.from({ length: 119 }, () => new Date(T0).toISOString()) } }));
    await Promise.all(["a", "b"].map((requestId) => s.server.emit("agent.permission_requested", permissionRequested(s.m, ALLOWED_SCRIPT(s.m), { requestId }), s.paseo)));
    expect(s.daemon.answers).toHaveLength(1);
    expect((await s.lines()).map((line) => [line.rule, line.answered])).toEqual([["notes-write", true], ["never:rate", false]]);
  });

  it("demonstrates one allowed command answered and one never-auto command left pending", async () => {
    const s = await setup("live");
    await writePermits(s.m, { live: true });
    await s.server.emit("agent.permission_requested", permissionRequested(s.m, ALLOWED_SCRIPT(s.m), { requestId: "demo-allowed" }), s.paseo);
    await s.server.emit("agent.permission_requested", permissionRequested(s.m, "Remove-Item x", { requestId: "demo-never" }), s.paseo);
    const summary = (await s.lines()).map(({ requestId, verdict, rule, answered }) => ({ requestId, verdict, rule, answered }));
    expect(summary).toEqual([
      { requestId: "demo-allowed", verdict: "allow", rule: "notes-write", answered: true },
      { requestId: "demo-never", verdict: "relay", rule: "never:destructive", answered: false },
    ]);
    expect(s.daemon.answers).toEqual([{ agentId: "crew-1", requestId: "demo-allowed", response: { behavior: "allow" } }]);
    console.log(summary.map((line) => JSON.stringify(line)).join("\n"));
  });
});

// ---------------------------------------------------------------------------
// 5. Sticky
// ---------------------------------------------------------------------------

describe("round 2 review regressions", () => {
  it("keeps a sticky agent unanswered after corruption and leaves the broken bytes intact", async () => {
    const s = await setup("live");
    await writePermits(s.m, { live: true });
    await s.server.emit("agent.permission_resolved", { agent: agent(s.m), requestId: "denied", resolution: { behavior: "deny" } }, s.paseo);
    await writeFile(s.m.stateFile, "{");
    await s.server.emit("agent.permission_requested", permissionRequested(s.m, ALLOWED_SCRIPT(s.m)), s.paseo);
    expect(s.daemon.answers).toEqual([]);
    expect((await s.lines()).at(-1)).toMatchObject({ rule: "state-error", answered: false });
    expect(await readFile(s.m.stateFile, "utf8")).toBe("{");
  });

  it("never answers an attempted request twice after corruption, including reload", async () => {
    const s = await setup("live");
    await writePermits(s.m, { live: true });
    const event = permissionRequested(s.m, ALLOWED_SCRIPT(s.m));
    await s.server.emit("agent.permission_requested", event, s.paseo);
    await writeFile(s.m.stateFile, "not json");
    s.wired.stop();
    const reloaded = registerPermissionBroker(s.server as never, async () => s.config.current, { stateFile: s.m.stateFile, userHome: s.m.user, now: () => T0 + 1000 });
    await reloaded.ready;
    await s.server.emit("agent.permission_requested", event, s.paseo);
    expect(s.daemon.answers).toHaveLength(1);
    expect((await s.lines()).at(-1)).toMatchObject({ rule: "state-error", answered: false });
    expect(await readFile(s.m.stateFile, "utf8")).toBe("not json");
  });

  it.each(["live", "shadow"] as const)("does not overwrite broken state in %s, retaining a pending deny after repair", async (mode) => {
    const s = await setup(mode);
    await writePermits(s.m, { live: true });
    await mkdir(join(s.m.root, "plugin-data"), { recursive: true });
    await writeFile(s.m.stateFile, "{");
    await s.server.emit("agent.permission_resolved", { agent: agent(s.m), requestId: "denied", resolution: { behavior: "deny" } }, s.paseo);
    await s.server.emit("agent.permission_requested", permissionRequested(s.m, ALLOWED_SCRIPT(s.m)), s.paseo);
    expect(await readFile(s.m.stateFile, "utf8")).toBe("{");
    expect(s.daemon.answers).toEqual([]);
    await writeFile(s.m.stateFile, JSON.stringify({ sticky: {}, allows: {} }));
    await s.server.emit("agent.permission_requested", permissionRequested(s.m, ALLOWED_SCRIPT(s.m), { requestId: "repaired" }), s.paseo);
    expect(s.daemon.answers).toEqual([]);
    expect((await readBrokerState(s.m.stateFile)).sticky["crew-1"]?.reason).toBe("deny");
  });

  it("starts fresh only when the state file is missing", async () => {
    const s = await setup("live");
    await writePermits(s.m, { live: true });
    expect(await readBrokerState(s.m.stateFile)).toEqual({ sticky: {}, allows: {} });
    await s.server.emit("agent.permission_requested", permissionRequested(s.m, ALLOWED_SCRIPT(s.m)), s.paseo);
    expect(s.daemon.answers).toHaveLength(1);
    expect((await readBrokerState(s.m.stateFile)).attempts?.["crew-1"]).toEqual(["permission-exec-1"]);
  });

  it("treats an unreadable state path as broken without replacing it", async () => {
    const s = await setup("live");
    await writePermits(s.m, { live: true });
    await mkdir(s.m.stateFile, { recursive: true });
    expect((await readBrokerState(s.m.stateFile)).broken).toBe(true);
    await s.server.emit("agent.permission_requested", permissionRequested(s.m, ALLOWED_SCRIPT(s.m)), s.paseo);
    expect(s.daemon.answers).toEqual([]);
    expect((await s.lines()).at(-1)).toMatchObject({ rule: "state-error", answered: false });
    expect(await readdir(s.m.stateFile)).toEqual([]);
  });

  it.each([
    "null", "[]", "{}", '{"sticky":{},"allows":[],"attempts":{}}',
    '{"sticky":{"crew-1":null},"allows":{}}',
    '{"sticky":{},"allows":{"crew-1":["bad-time"]}}',
    '{"sticky":{},"allows":{},"attempts":{"crew-1":[42]}}',
  ])("fails closed on malformed ledger shape %s without overwriting it", async (bytes) => {
    const s = await setup("live");
    await writePermits(s.m, { live: true });
    await mkdir(join(s.m.root, "plugin-data"), { recursive: true });
    await writeFile(s.m.stateFile, bytes);
    await s.server.emit("agent.permission_requested", permissionRequested(s.m, ALLOWED_SCRIPT(s.m)), s.paseo);
    expect(s.daemon.answers).toEqual([]);
    expect((await s.lines()).at(-1)).toMatchObject({ rule: "state-error", answered: false });
    expect(await readFile(s.m.stateFile, "utf8")).toBe(bytes);
  });

  it("does not save over corruption introduced during matching", async () => {
    let s: Setup;
    let corrupt: Promise<void> | undefined;
    s = await setup("live", { realpath: (path) => {
      if (corrupt === undefined && path.endsWith("review-scratch-1")) corrupt = writeFile(s.m.stateFile, "{");
      try { return realpathSync.native(path); } catch { return null; }
    } });
    await writePermits(s.m, { live: true });
    await mkdir(join(s.m.root, "plugin-data"), { recursive: true });
    await writeFile(s.m.stateFile, JSON.stringify({ sticky: {}, allows: {} }));
    await s.server.emit("agent.permission_requested", permissionRequested(s.m, ALLOWED_SCRIPT(s.m)), s.paseo);
    await corrupt;
    expect(s.daemon.answers).toEqual([]);
    expect((await s.lines()).at(-1)).toMatchObject({ rule: "state-error", answered: false });
    expect(await readFile(s.m.stateFile, "utf8")).toBe("{");
  });
});

describe("round 1 review regressions", () => {
  it.each([
    ["python '-cprint(1)'", "python"],
    ["python '-Icprint(1)'", "python"],
    ["node '-econsole.log(1)'", "node"],
  ])("never sends allow for the hunter's attached inline form %s", async (script, interpreter) => {
    const s = await setup("live");
    await writePermits(s.m, { live: true, exec: [{ in: "worktree", prefix: [interpreter] }] });
    await writeFile(join(s.m.home, "data", "permissions", "never-auto-extra.json"), await readFile(join(import.meta.dirname, "permit-fixtures", "never-auto-extra.json")));
    await s.server.emit("agent.permission_requested", permissionRequested(s.m, `${interpreter} example.js`, { requestId: "control" }), s.paseo);
    expect(s.daemon.answers.map((answer) => answer.requestId)).toEqual(["control"]);
    await s.server.emit("agent.permission_requested", permissionRequested(s.m, script, { requestId: "inline" }), s.paseo);
    expect(s.daemon.answers.map((answer) => answer.requestId)).toEqual(["control"]);
    expect((await s.lines()).at(-1)).toMatchObject({ verdict: "relay", answered: false });
  });

  it.each([
    "git add -- example.txt", "git branch example",
    "git --no-optional-locks status", "git --no-optional-locks diff",
    "git --no-optional-locks log", "git --no-optional-locks show",
    "git --no-optional-locks rev-parse HEAD",
  ])("relays repository-controlled execution in live: %s", async (script) => {
    const s = await setup("live");
    await writePermits(s.m, { live: true, exec: [{ in: "worktree", prefix: ["git"] }] });
    await s.server.emit("agent.permission_requested", permissionRequested(s.m, script), s.paseo);
    expect(s.daemon.answers).toEqual([]);
    expect((await s.lines()).at(-1)).toMatchObject({ verdict: "relay", answered: false });
    s.config.current = { ...s.config.current, permissionBroker: "shadow" };
    await s.server.emit("agent.permission_requested", permissionRequested(s.m, script, { requestId: "shadow" }), s.paseo);
    expect((await s.lines()).at(-1)).toMatchObject({ verdict: "allow", rule: "git-local", answered: false });
  });

  it.each(["log", "diff", "show", "rev-parse", "status", "archive"])("relays %s in a read repo in live, retaining its shadow judgment", async (verb) => {
    const s = await setup("live");
    const repo = join(s.m.root, "review-repo");
    await mkdir(repo);
    await writePermits(s.m, { live: true, readRepos: [repo] });
    const args = verb === "archive" ? `HEAD --output='${s.m.notes}\\example.zip'` : "HEAD";
    const script = `git --no-optional-locks -C '${repo}' ${verb} ${args}`;
    await s.server.emit("agent.permission_requested", permissionRequested(s.m, script), s.paseo);
    expect(s.daemon.answers).toEqual([]);
    s.config.current = { ...s.config.current, permissionBroker: "shadow" };
    await s.server.emit("agent.permission_requested", permissionRequested(s.m, script, { requestId: "shadow" }), s.paseo);
    expect((await s.lines()).at(-1)).toMatchObject({ verdict: "allow", rule: "git-read", answered: false });
  });

  it.each(["duplicate", "rate", "agents"])("coordinates overlapping file-store instances for %s", async (kind) => {
    const s = await setup("live");
    await writePermits(s.m, { live: true });
    if (kind === "rate") {
      await mkdir(join(s.m.root, "plugin-data"), { recursive: true });
      await writeFile(s.m.stateFile, JSON.stringify({ sticky: {}, allows: { "crew-1": Array(119).fill(new Date(T0 - 1).toISOString()) } }));
    }
    const other = registerPermissionBroker(new FakeServer() as never, async () => s.config.current, { stateFile: s.m.stateFile, userHome: s.m.user, now: () => T0, host: { labels: async () => s.daemon.labels.get("crew-1")! } });
    await other.ready;
    await Promise.all([s.wired.broker.snapshot(), other.broker.snapshot()]);
    const first = permissionRequested(s.m, ALLOWED_SCRIPT(s.m), { requestId: "first" });
    const second = permissionRequested(s.m, ALLOWED_SCRIPT(s.m), { requestId: kind === "duplicate" ? "first" : "second", id: kind === "agents" ? "crew-2" : "crew-1" });
    await Promise.all([
      s.server.emit("agent.permission_requested", first, s.paseo),
      other.broker.onPermissionRequested(second as never, s.paseo as never),
    ]);
    expect(s.daemon.answers).toHaveLength(kind === "agents" ? 2 : 1);
    const state = await readBrokerState(s.m.stateFile);
    expect(state.allows["crew-1"]).toHaveLength(kind === "rate" ? 120 : 1);
    expect(state.attempts?.["crew-1"]).toEqual(["first"]);
    if (kind === "agents") {
      expect(state.allows["crew-2"]).toHaveLength(1);
      expect(state.attempts?.["crew-2"]).toEqual(["second"]);
    }
    other.stop();
  });

  it("invalidates an in-flight request on stop before its SDK call", async () => {
    let s: Setup;
    let stopped = false;
    s = await setup("live", { realpath: (path) => {
      if (!stopped && path.endsWith("review-scratch-1")) {
        stopped = true;
        s.wired.stop();
      }
      try { return realpathSync.native(path); } catch { return null; }
    } });
    await writePermits(s.m, { live: true });
    await s.server.emit("agent.permission_requested", permissionRequested(s.m, ALLOWED_SCRIPT(s.m)), s.paseo);
    expect(stopped).toBe(true);
    expect(s.daemon.answers).toEqual([]);
    expect((await s.lines()).at(-1)).toMatchObject({ rule: "stopped", answered: false });
  });

  it.each(["duplicate", "rate"])("coordinates %s across reloaded modules wrapping the same custom store", async (kind) => {
    const s = await setup("live");
    await writePermits(s.m, { live: true });
    let saved: BrokerState = { sticky: {}, allows: kind === "rate" ? { "crew-1": Array(119).fill(new Date(T0 - 1).toISOString()) } : {} };
    const options = () => ({
      host: { labels: async () => s.daemon.labels.get("crew-1")! },
      store: { load: async () => structuredClone(saved), save: async (state: BrokerState) => { saved = structuredClone(state); } },
      readConfig: async () => s.config.current, userHome: s.m.user, now: () => T0,
      append: async () => undefined,
    });
    const old = new PermissionBroker(options());
    vi.resetModules();
    const { PermissionBroker: ReloadedBroker } = await import("./permission-broker");
    const reloaded = new ReloadedBroker(options());
    await Promise.all([old.snapshot(), reloaded.snapshot()]);
    await Promise.all([
      old.onPermissionRequested(permissionRequested(s.m, ALLOWED_SCRIPT(s.m), { requestId: "first" }) as never, s.paseo as never),
      reloaded.onPermissionRequested(permissionRequested(s.m, ALLOWED_SCRIPT(s.m), { requestId: kind === "duplicate" ? "first" : "second" }) as never, s.paseo as never),
    ]);
    expect(s.daemon.answers).toHaveLength(1);
    expect(saved.allows["crew-1"]).toHaveLength(kind === "rate" ? 120 : 1);
    expect(saved.attempts?.["crew-1"]).toEqual(["first"]);
  });

  it("invalidates queued work on stop while an already-sent SDK call reaches its deadline", async () => {
    const s = await setup("live");
    await writePermits(s.m, { live: true });
    s.daemon.answerPending = true;
    const started = new Promise<void>((resolve) => s.daemon.answerStarted.mockImplementation(resolve));
    vi.useFakeTimers({ toFake: ["setTimeout", "clearTimeout"] });
    const first = s.server.emit("agent.permission_requested", permissionRequested(s.m, ALLOWED_SCRIPT(s.m), { requestId: "sent" }), s.paseo);
    await started;
    const queued = s.server.emit("agent.permission_requested", permissionRequested(s.m, ALLOWED_SCRIPT(s.m), { requestId: "queued" }), s.paseo);
    s.wired.stop();
    await vi.advanceTimersByTimeAsync(10_000);
    await Promise.all([first, queued]);
    expect(s.daemon.answers.map((answer) => answer.requestId)).toEqual(["sent"]);
    expect((await s.lines()).map((line) => line.requestId)).toEqual(["sent"]);
    expect((await readBrokerState(s.m.stateFile)).attempts?.["crew-1"]).toEqual(["sent"]);
  });

  it.each(["missing", "live:false", "invalid", "other-task"])("keeps destructive stickiness under %s permits through reload", async (initial) => {
    const s = await setup("live");
    if (initial === "live:false") await writePermits(s.m);
    if (initial === "invalid") await writePermits(s.m, { version: 99 });
    if (initial === "other-task") await writePermits(s.m, { task: "demo-02-other" });
    await s.server.emit("agent.permission_requested", permissionRequested(s.m, "Remove-Item x", { requestId: "destructive" }), s.paseo);
    expect((await s.lines()).at(-1)).toMatchObject({ rule: "never:no-permits", answered: false });
    await writePermits(s.m, { live: true });
    s.wired.stop();
    const reloaded = registerPermissionBroker(s.server as never, async () => s.config.current, { stateFile: s.m.stateFile, userHome: s.m.user, now: () => T0 + 1000 });
    await reloaded.ready;
    await s.server.emit("agent.permission_requested", permissionRequested(s.m, ALLOWED_SCRIPT(s.m), { requestId: "later" }), s.paseo);
    expect(s.daemon.answers).toEqual([]);
    expect((await s.lines()).at(-1)).toMatchObject({ rule: "never:after-refusal", answered: false });
    expect((await readBrokerState(s.m.stateFile)).sticky["crew-1"]?.reason).toBe("never:destructive");
  });

  it.each([
    ["outward", "git push origin topic"],
    ["credential", "Get-Content .env"],
    ["system", "Set-ExecutionPolicy Unrestricted"],
  ])("keeps %s stickiness even without live permits", async (reason, script) => {
    const s = await setup("live");
    await s.server.emit("agent.permission_requested", permissionRequested(s.m, script), s.paseo);
    await writePermits(s.m, { live: true });
    await s.server.emit("agent.permission_requested", permissionRequested(s.m, ALLOWED_SCRIPT(s.m), { requestId: "later" }), s.paseo);
    expect(s.daemon.answers).toEqual([]);
    expect((await readBrokerState(s.m.stateFile)).sticky["crew-1"]?.reason).toBe(`never:${reason}`);
  });

  it.each(["deny", "blocked"])("rechecks stickiness when %s lands during matching", async (trigger) => {
    let s: Setup;
    let refusal: Promise<void> | undefined;
    s = await setup("live", { realpath: (path) => {
      if (refusal === undefined && path.endsWith("review-scratch-1")) {
        refusal = trigger === "deny"
          ? s.server.emit("agent.permission_resolved", { agent: agent(s.m), requestId: "other", resolution: { behavior: "deny" } }, s.paseo)
          : s.server.emit("agent.turn_ended", { agent: agent(s.m), turnId: "t1", outcome: { kind: "completed" }, timeline: [{ type: "assistant_message", text: "blocked: database unavailable" }] }, s.paseo);
      }
      try { return realpathSync.native(path); } catch { return null; }
    } });
    await writePermits(s.m, { live: true });
    await s.server.emit("agent.permission_requested", permissionRequested(s.m, ALLOWED_SCRIPT(s.m)), s.paseo);
    expect(refusal).toBeDefined();
    await refusal;
    expect(s.daemon.answers).toEqual([]);
    expect((await s.lines()).find((line) => line.event === "request")).toMatchObject({ rule: "never:after-refusal", answered: false });
  });

  it("rejects changed permits bytes even when both versions allow the request", async () => {
    let s: Setup;
    let changed: Promise<void> | undefined;
    s = await setup("live", { realpath: (path) => {
      if (changed === undefined && path.endsWith("review-scratch-1")) {
        changed = writePermits(s.m, { live: true, netRead: { githubRepos: ["octo/another"], hosts: [] } });
      }
      try { return realpathSync.native(path); } catch { return null; }
    } });
    await writePermits(s.m, { live: true });
    await s.server.emit("agent.permission_requested", permissionRequested(s.m, ALLOWED_SCRIPT(s.m)), s.paseo);
    expect(changed).toBeDefined();
    await changed;
    expect(s.daemon.answers).toEqual([]);
    expect((await s.lines()).at(-1)).toMatchObject({ rule: "changed", answered: false });
    // The replacement permits are valid and still authorize this command for another agent.
    await s.server.emit("agent.permission_requested", permissionRequested(s.m, ALLOWED_SCRIPT(s.m), { id: "crew-2", requestId: "fresh" }), s.paseo);
    expect(s.daemon.answers.map((answer) => answer.requestId)).toEqual(["fresh"]);
  });

  it("reserves the final attempt before compacting, retaining failures across reload", async () => {
    const s = await setup("live");
    await writePermits(s.m, { live: true });
    await mkdir(join(s.m.root, "plugin-data"), { recursive: true });
    await writeFile(s.m.stateFile, JSON.stringify({ sticky: {}, allows: {}, attempts: { "crew-1": Array.from({ length: 4095 }, (_, index) => `old-${index}`) } }));
    s.daemon.answerError = new Error("daemon unavailable");
    s.daemon.answerStarted.mockImplementation(() => {
      // Even the final permitted call has its no-retry marker durably saved before sending.
      expect(JSON.parse(readFileSync(s.m.stateFile, "utf8")).attempts["crew-1"]).toBeNull();
    });
    await s.server.emit("agent.permission_requested", permissionRequested(s.m, ALLOWED_SCRIPT(s.m), { requestId: "last" }), s.paseo);
    expect(s.daemon.answers.map((answer) => answer.requestId)).toEqual(["last"]);
    expect((await s.lines()).at(-1)).toMatchObject({ answered: false, answerError: "Error" });
    expect((await readBrokerState(s.m.stateFile)).attempts?.["crew-1"]).toBeNull();
    s.wired.stop();
    const reloaded = registerPermissionBroker(s.server as never, async () => s.config.current, { stateFile: s.m.stateFile, userHome: s.m.user, now: () => T0 + 1000 });
    await reloaded.ready;
    await s.server.emit("agent.permission_requested", permissionRequested(s.m, ALLOWED_SCRIPT(s.m), { requestId: "last" }), s.paseo);
    expect(s.daemon.answers).toHaveLength(1);
    expect((await s.lines()).at(-1)).toMatchObject({ rule: "attempt-cap", answered: false });
  });

  it("compacts a full attempt ledger and never retries an old ID after reload", async () => {
    const s = await setup("live");
    await writePermits(s.m, { live: true });
    await mkdir(join(s.m.root, "plugin-data"), { recursive: true });
    const ids = Array.from({ length: 4096 }, (_, index) => `old-${index}`);
    await writeFile(s.m.stateFile, JSON.stringify({ sticky: {}, allows: {}, attempts: { "crew-1": ids } }));
    await s.server.emit("agent.permission_requested", permissionRequested(s.m, ALLOWED_SCRIPT(s.m), { requestId: "overflow" }), s.paseo);
    expect(s.daemon.answers).toEqual([]);
    expect((await s.lines()).at(-1)).toMatchObject({ rule: "attempt-cap", answered: false });
    expect((await readBrokerState(s.m.stateFile)).attempts?.["crew-1"]).toBeNull();
    s.wired.stop();
    const reloaded = registerPermissionBroker(s.server as never, async () => s.config.current, { stateFile: s.m.stateFile, userHome: s.m.user, now: () => T0 + 31 * 24 * 60 * 60 * 1000 });
    await reloaded.ready;
    for (const requestId of ["old-0", "new-id"]) {
      await s.server.emit("agent.permission_requested", permissionRequested(s.m, ALLOWED_SCRIPT(s.m), { requestId }), s.paseo);
    }
    expect(s.daemon.answers).toEqual([]);
    expect((await readBrokerState(s.m.stateFile)).attempts?.["crew-1"]).toBeNull();
    await s.server.emit("agent.permission_requested", permissionRequested(s.m, ALLOWED_SCRIPT(s.m), { id: "crew-2", requestId: "other-agent" }), s.paseo);
    expect(s.daemon.answers.map((answer) => answer.requestId)).toEqual(["other-agent"]);
  });
});

describe("after a refusal", () => {
  async function stickyAfter(trigger: (s: Setup) => Promise<void>, mode: FirstmateConfig["permissionBroker"] = "shadow") {
    const s = await setup(mode);
    await writePermits(s.m, { live: true });
    await s.server.emit("agent.permission_requested", permissionRequested(s.m, ALLOWED_SCRIPT(s.m), { requestId: "before" }), s.paseo);
    await trigger(s);
    await s.server.emit("agent.permission_requested", permissionRequested(s.m, ALLOWED_SCRIPT(s.m), { requestId: "after" }), s.paseo);
    // A reload: a new broker on the same state file.
    s.wired.stop();
    const reloaded = registerPermissionBroker(s.server as never, async () => s.config.current, { stateFile: s.m.stateFile, userHome: s.m.user, now: () => T0 + 1000 });
    await reloaded.ready;
    await s.server.emit("agent.permission_requested", permissionRequested(s.m, ALLOWED_SCRIPT(s.m), { requestId: "after-reload" }), s.paseo);
    const verdicts = Object.fromEntries((await s.lines()).filter((line) => line.event === "request").map((line) => [line.requestId, line.rule]));
    return { s, verdicts };
  }

  const triggers: Array<[string, (s: Setup) => Promise<void>]> = [
    ["a deny", (s) => s.server.emit("agent.permission_resolved", { agent: agent(s.m), requestId: "x", resolution: { behavior: "deny", message: "no" } }, s.paseo)],
    [
      "a turn ending blocked",
      (s) =>
        s.server.emit(
          "agent.turn_ended",
          { agent: agent(s.m), turnId: "t1", outcome: { kind: "completed" }, timeline: [{ type: "assistant_message", text: "Cannot go on.\n\nblocked: tests need a database" }] },
          s.paseo,
        ),
    ],
    [
      "a turn ending needs-decision",
      (s) =>
        s.server.emit(
          "agent.turn_ended",
          { agent: agent(s.m), turnId: "t1", outcome: { kind: "completed" }, timeline: [{ type: "assistant_message", text: "needs-decision: keep the old API?" }] },
          s.paseo,
        ),
    ],
    ["a destructive hit", (s) => s.server.emit("agent.permission_requested", permissionRequested(s.m, "Remove-Item -LiteralPath x", { requestId: "bad" }), s.paseo)],
    ["an outward hit", (s) => s.server.emit("agent.permission_requested", permissionRequested(s.m, "git push origin topic", { requestId: "bad" }), s.paseo)],
  ];

  it.each(triggers)("relays every later request after %s, also after a reload", async (_name, trigger) => {
    const { s, verdicts } = await stickyAfter(trigger);
    expect(verdicts.before).toBe("notes-write");
    expect(verdicts.after).toBe("never:after-refusal");
    expect(verdicts["after-reload"]).toBe("never:after-refusal");
    expect((await readBrokerState(s.m.stateFile)).sticky["crew-1"]).toBeDefined();
    expect(s.daemon.writes).toEqual([]);
  });

  it.each(triggers)("never answers live after %s, including after reload", async (_name, trigger) => {
    const { s, verdicts } = await stickyAfter(trigger, "live");
    expect(verdicts.before).toBe("notes-write");
    expect(verdicts.after).toBe("never:after-refusal");
    expect(verdicts["after-reload"]).toBe("never:after-refusal");
    expect(s.daemon.answers).toHaveLength(1);
    expect(s.daemon.answers[0]?.requestId).toBe("before");
    expect(s.daemon.writes).toEqual(["respondToPermission crew-1"]);
  });

  it("is not set by a turn that ends done, or by an allow", async () => {
    const { verdicts } = await stickyAfter(async (s) => {
      await s.server.emit(
        "agent.turn_ended",
        { agent: agent(s.m), turnId: "t1", outcome: { kind: "completed" }, timeline: [{ type: "assistant_message", text: "done: PR https://github.com/octo/example/pull/1" }] },
        s.paseo,
      );
      await s.server.emit("agent.permission_resolved", { agent: agent(s.m), requestId: "x", resolution: { behavior: "allow" } }, s.paseo);
    });
    expect(verdicts.after).toBe("notes-write");
    expect(verdicts["after-reload"]).toBe("notes-write");
  });

  it("lasts the agent's life: still sticky 31 days later, after other requests and a reload", async () => {
    const s = await setup();
    await writePermits(s.m);
    await s.server.emit("agent.permission_resolved", { agent: agent(s.m, "crew-1"), requestId: "x", resolution: { behavior: "deny" } }, s.paseo);
    s.wired.stop();
    const later = T0 + 31 * 24 * 60 * 60 * 1000;
    const reloaded = registerPermissionBroker(s.server as never, async () => s.config.current, { stateFile: s.m.stateFile, userHome: s.m.user, now: () => later });
    await reloaded.ready;
    await s.server.emit("agent.permission_requested", permissionRequested(s.m, ALLOWED_SCRIPT(s.m), { id: "crew-2", requestId: "other" }), s.paseo);
    await s.server.emit("agent.permission_requested", permissionRequested(s.m, ALLOWED_SCRIPT(s.m), { id: "crew-1", requestId: "mine" }), s.paseo);
    expect((await readBrokerState(s.m.stateFile)).sticky["crew-1"]).toBeDefined();
    expect((await s.lines()).find((line) => line.requestId === "mine")?.rule).toBe("never:after-refusal");
  });

  it("is kept per agent: another crewmate is not sticky", async () => {
    const s = await setup();
    await writePermits(s.m);
    await s.server.emit("agent.permission_resolved", { agent: agent(s.m, "crew-1"), requestId: "x", resolution: { behavior: "deny" } }, s.paseo);
    await s.server.emit("agent.permission_requested", permissionRequested(s.m, ALLOWED_SCRIPT(s.m), { id: "crew-2" }), s.paseo);
    expect((await s.lines()).find((line) => line.event === "request")?.rule).toBe("notes-write");
  });
});

// ---------------------------------------------------------------------------
// 6. Gates
// ---------------------------------------------------------------------------

describe("gates", () => {
  it("registers nothing when the config says off", async () => {
    const s = await setup("off");
    expect(s.server.count()).toBe(0);
  });

  it("stops at once when switched off after it started", async () => {
    const s = await setup("shadow");
    await writePermits(s.m);
    s.config.current = { ...s.config.current, permissionBroker: "off" };
    await s.server.emit("agent.permission_requested", permissionRequested(s.m, ALLOWED_SCRIPT(s.m)), s.paseo);
    await expect(readdir(join(s.m.home, "data", "permissions"))).resolves.toEqual(["permits"]);
    expect(s.daemon.writes).toEqual([]);
  });

  it("does not look at an agent without the crew label, or at the first mate", async () => {
    const s = await setup();
    await writePermits(s.m);
    await s.server.emit("agent.permission_requested", permissionRequested(s.m, ALLOWED_SCRIPT(s.m), { id: "other-1" }), s.paseo);
    await s.server.emit("agent.permission_requested", permissionRequested(s.m, ALLOWED_SCRIPT(s.m), { id: "mate-1" }), s.paseo);
    await s.server.emit("agent.permission_requested", permissionRequested(s.m, ALLOWED_SCRIPT(s.m), { id: "unknown-1" }), s.paseo);
    await expect(readdir(join(s.m.home, "data", "permissions"))).resolves.toEqual(["permits"]);
    expect(s.daemon.writes).toEqual([]);
  });

  it("looks a crewmate's labels up once", async () => {
    const s = await setup();
    await writePermits(s.m);
    for (const requestId of ["a", "b", "c"]) {
      await s.server.emit("agent.permission_requested", permissionRequested(s.m, ALLOWED_SCRIPT(s.m), { requestId }), s.paseo);
    }
    expect(s.daemon.lookups).toBe(1);
  });

  const relays: Array<[string, (s: Setup) => Promise<void>, string, FirstmateConfig["permissionBroker"]?, string?]> = [
    ["a crewmate whose task is reserved", (s) => writePermits(s.m), "never:not-crew", "shadow", "crew-reserved"],
    ["a crewmate with no task label", (s) => writePermits(s.m), "never:not-crew", "shadow", "crew-notask"],
    ["no permits file", async () => undefined, "never:no-permits"],
    ["a permits file that is not JSON", (s) => writeFile(join(s.m.home, "data", "permissions", "permits", `${TASK}.json`), "{ not json"), "never:no-permits"],
    ["an invalid permits file", (s) => writePermits(s.m, { writeDirs: ["data/../tools"] }), "never:no-permits"],
    [
      "another task's permits",
      async (s) => {
        await writePermits(s.m, {}, "demo-03-other");
        await writeFile(
          join(s.m.home, "data", "permissions", "permits", `${TASK}.json`),
          await readFile(join(s.m.home, "data", "permissions", "permits", "demo-03-other.json")),
        );
      },
      "never:no-permits",
    ],
    ["live: false in live mode", (s) => writePermits(s.m, { live: false }), "never:no-permits", "live"],
  ];

  it.each(relays)("relays %s and answers nothing", async (_name, prepare, rule, mode = "shadow", id = "crew-1") => {
    const s = await setup(mode);
    await prepare(s);
    await s.server.emit("agent.permission_requested", permissionRequested(s.m, ALLOWED_SCRIPT(s.m), { id }), s.paseo);
    expect((await s.lines()).map((line) => [line.verdict, line.rule])).toEqual([["relay", rule]]);
    expect(s.daemon.writes).toEqual([]);
  });

  it("reads the permits on every request, so an edit counts at once", async () => {
    const s = await setup();
    await s.server.emit("agent.permission_requested", permissionRequested(s.m, ALLOWED_SCRIPT(s.m), { requestId: "a" }), s.paseo);
    await writePermits(s.m);
    await s.server.emit("agent.permission_requested", permissionRequested(s.m, ALLOWED_SCRIPT(s.m), { requestId: "b" }), s.paseo);
    expect((await s.lines()).map((line) => line.rule)).toEqual(["never:no-permits", "notes-write"]);
  });
});

// ---------------------------------------------------------------------------
// The private never-auto supplement (spec amendment 2026-10-09)
// ---------------------------------------------------------------------------

describe("the never-auto supplement", () => {
  const supplementPath = (m: Machine) => join(m.home, "data", "permissions", "never-auto-extra.json");
  const fixture = () => readFile(join(import.meta.dirname, "permit-fixtures", "never-auto-extra.json"));

  it("is read on every request: missing or invalid relays every exec statement, and a listed name relays as hardware", async () => {
    const s = await setup();
    await writePermits(s.m, { exec: [{ in: "scratch", prefix: ["npm.cmd", "test"] }, { in: "scratch", prefix: ["hwb"] }] });
    const ask = (script: string, requestId: string) =>
      s.server.emit("agent.permission_requested", permissionRequested(s.m, script, { requestId, cwd: s.m.scratch, id: "crew-2" }), s.paseo);
    await ask("npm.cmd test", "missing");
    await writeFile(supplementPath(s.m), await fixture());
    await ask("npm.cmd test", "present");
    await ask("hwb inspect", "listed");
    await ask(ALLOWED_SCRIPT(s.m), "notes");
    await writeFile(supplementPath(s.m), "{ not json");
    await ask("npm.cmd test", "invalid");
    const rules = Object.fromEntries((await s.lines()).map((line) => [line.requestId, line.rule]));
    expect(rules).toEqual({ missing: "never:hardware", present: "exec", listed: "never:hardware", notes: "notes-write", invalid: "never:hardware" });
    expect(JSON.stringify(await s.lines())).not.toContain("hwtool-a");
  });
});

// ---------------------------------------------------------------------------
// 7. The log
// ---------------------------------------------------------------------------

describe("the log", () => {
  it("writes one line per request and per resolution, in the spec's shape", async () => {
    const s = await setup();
    await writePermits(s.m);
    await s.server.emit("agent.permission_requested", permissionRequested(s.m, ALLOWED_SCRIPT(s.m), { requestId: "permission-exec-a" }), s.paseo);
    await s.server.emit("agent.permission_resolved", { agent: agent(s.m), requestId: "permission-exec-a", resolution: { behavior: "allow" } }, s.paseo);
    const [request, resolved, ...rest] = await s.lines();
    expect(rest).toEqual([]);
    expect(Object.keys(request ?? {})).toEqual([
      "v",
      "ts",
      "event",
      "mode",
      "agentId",
      "task",
      "plan",
      "provider",
      "name",
      "kind",
      "requestId",
      "cwd",
      "command",
      "verdict",
      "rule",
      "tier",
      "detail",
      "permitsSha256",
      "answered",
    ]);
    expect(request).toMatchObject({
      v: 1,
      ts: "2026-10-12T09:14:03.120Z",
      event: "request",
      mode: "shadow",
      agentId: "crew-1",
      task: TASK,
      plan: "demo-plan",
      provider: "codex",
      name: "CodexBash",
      kind: "tool",
      requestId: "permission-exec-a",
      verdict: "allow",
      rule: "notes-write",
      tier: 1,
      answered: false,
    });
    expect(request?.permitsSha256).toMatch(/^[0-9a-f]{64}$/);
    expect(JSON.stringify(request)).not.toContain("not to be logged");
    expect(resolved).toEqual({ v: 1, ts: "2026-10-12T09:14:03.120Z", event: "resolved", agentId: "crew-1", requestId: "permission-exec-a", behavior: "allow", byBroker: false });
    expect(await readdir(join(s.m.home, "data", "permissions"))).toContain("log-2026-10.jsonl");
  });

  it("redacts credentials and cuts the command", async () => {
    const s = await setup();
    await writePermits(s.m);
    const secret = `ghp_${"A1b2".repeat(9)}`;
    await s.server.emit("agent.permission_requested", permissionRequested(s.m, `gh api repos/octo/example -H 'Authorization: ${secret}' --password hunter2 ${"x".repeat(5000)}`), s.paseo);
    const [line] = await s.lines();
    const command = String(line?.command);
    expect(command).not.toContain(secret);
    expect(command).not.toContain("hunter2");
    expect(command).toContain("[redacted]");
    expect(command.length).toBeLessThanOrEqual(MAX_LOGGED_COMMAND + 30);
    expect(line?.verdict).toBe("relay");
  });

  it("redacts the forms of spec 3.9", () => {
    expect(redact(`x github_pat_${"a".repeat(30)} y`)).toBe("x [redacted] y");
    expect(redact("x xoxb-1234567890-abcdef y")).toBe("x [redacted] y");
    expect(redact(`x ${"QUJD".repeat(16)} y`)).toBe("x [redacted] y");
    expect(redact("$env:GH_TOKEN='abc123'; gh api x")).not.toContain("abc123");
    expect(redact("Get-Content C:\\Home\\example\\notes\\authority.md")).toBe("Get-Content C:\\Home\\example\\notes\\authority.md");
  });

  it("keeps the verdict when a write fails, and says so on stderr once an hour", async () => {
    let calls = 0;
    const s = await setup("shadow", {
      append: async () => {
        calls += 1;
        throw new Error("disk full");
      },
    });
    await writePermits(s.m);
    await s.server.emit("agent.permission_requested", permissionRequested(s.m, ALLOWED_SCRIPT(s.m), { requestId: "a" }), s.paseo);
    await s.server.emit("agent.permission_requested", permissionRequested(s.m, "Remove-Item x", { requestId: "b" }), s.paseo);
    expect(calls).toBe(2);
    const logged = errors.mock.calls.filter((call: unknown[]) => String(call[0]).includes("could not write"));
    expect(logged).toHaveLength(1);
    // The destructive hit still made the agent sticky, and the allow still counted for the rate limit.
    const state = await readBrokerState(s.m.stateFile);
    expect(state.sticky["crew-1"]?.reason).toBe("never:destructive");
    expect(state.allows["crew-1"]).toHaveLength(1);
    expect(s.daemon.writes).toEqual([]);
  });

  it("costs only a log line when a hook fails", async () => {
    const s = await setup();
    s.daemon.labels.delete("crew-1");
    const failing = { ...s.paseo as object, agents: { ref: () => ({ refresh: async () => { throw new Error("daemon gone"); } }) } };
    await expect(s.server.emit("agent.permission_requested", permissionRequested(s.m, ALLOWED_SCRIPT(s.m)), failing)).resolves.toBeUndefined();
    expect(errors.mock.calls.some((call: unknown[]) => String(call[0]).includes("permission broker could not handle"))).toBe(true);
  });

  it("counts allows for the rate limit across requests", async () => {
    const s = await setup();
    await writePermits(s.m);
    for (let index = 0; index < 121; index += 1) {
      await s.server.emit("agent.permission_requested", permissionRequested(s.m, ALLOWED_SCRIPT(s.m), { requestId: `r${index}` }), s.paseo);
    }
    const rules = (await s.lines()).map((line) => line.rule);
    expect(rules.filter((rule) => rule === "notes-write")).toHaveLength(120);
    expect(rules.at(-1)).toBe("never:rate");
  });
});
