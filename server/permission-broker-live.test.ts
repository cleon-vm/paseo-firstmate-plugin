/** Round-3 hunt regressions: synthetic files and fake answers; no command executes. */
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

import type { FirstmateConfig } from "../shared/fleet";
import { PermissionBroker, brokerFileStore, emptyBrokerState } from "./permission-broker";

const disk = vi.hoisted(() => ({ files: {} as Record<string, string>, errors: {} as Record<string, string>, writes: 0 }));
vi.mock("node:fs/promises", async (actual) => ({
  ...await actual<typeof import("node:fs/promises")>(),
  mkdir: async () => undefined,
  writeFile: async (path: unknown, text: unknown) => { disk.writes += 1; disk.files[String(path)] = String(text); },
  rename: async (from: unknown, to: unknown) => { disk.files[String(to)] = disk.files[String(from)]; },
  readFile: async (path: unknown, encoding?: unknown) => {
    const name = String(path);
    const code = disk.errors[name] ?? (disk.files[name] === undefined ? "ENOENT" : undefined);
    if (code !== undefined) throw Object.assign(new Error("Synthetic filesystem fault"), { code });
    return encoding === undefined ? Buffer.from(disk.files[name]) : disk.files[name];
  },
}));

const USER = String.raw`C:\Home\example`;
const HOME = `${USER}\\.paseo\\plugin-data\\firstmate\\home`;
const WORK = String.raw`C:\Work\demo`;
const SCRATCH = String.raw`C:\Scratch\demo`;
const STATE = `${SCRATCH}\\permission-broker.json`;

beforeEach(() => {
  disk.files = {}; disk.errors = {}; disk.writes = 0;
  vi.spyOn(console, "error").mockImplementation(() => undefined);
});
afterEach(() => { vi.restoreAllMocks(); });

function rig(script: string, prefix: string[]) {
  disk.files[STATE] = JSON.stringify(emptyBrokerState());
  disk.files[`${HOME}\\data\\permissions\\permits\\demo.json`] = JSON.stringify({
    version: 1, task: "demo", live: true, writeDirs: ["data/demo"], scratchDirs: [SCRATCH], readRepos: [],
    netRead: { githubRepos: ["octo/example"], hosts: [] }, gitLocal: true,
    exec: [{ in: "worktree", prefix }], envNames: [],
  });
  disk.files[`${HOME}\\data\\permissions\\never-auto-extra.json`] = JSON.stringify({
    version: 1, neverAuto: { hardware: { commandBasenames: ["hwtool-a", "hwb"] } },
  });
  const logs: Array<Record<string, unknown>> = [];
  const answers: unknown[] = [];
  let configReads = 0;
  let onConfig = (_read: number): void => undefined;
  const broker = new PermissionBroker({
    host: { labels: async () => ({ "firstmate.role": "crew", "firstmate.task": "demo" }) },
    store: brokerFileStore(STATE),
    readConfig: async () => {
      onConfig(++configReads);
      return { home: HOME, mateAgentId: "mate-1", permissionBroker: "live" } as FirstmateConfig;
    },
    userHome: USER, now: () => Date.parse("2026-10-12T09:00:00Z"), realpath: path => path,
    append: async (_path, text) => { logs.push(JSON.parse(text)); },
  });
  const event = {
    agent: { id: "crew-1", cwd: WORK },
    request: { id: "request-1", provider: "codex", name: "CodexBash", kind: "tool", input: {
      command: `"C:\\Program Files\\PowerShell\\7\\pwsh.exe" -Command '${script.replace(/'/g, "''")}'`, cwd: WORK,
    } },
  };
  const api = { agents: { ref: () => ({ respondToPermission: async (answer: unknown) => { answers.push(answer); } }) } };
  return { answers, logs, event, onConfig: (callback: typeof onConfig) => { onConfig = callback; },
    run: () => broker.onPermissionRequested(event as never, api as never) };
}

describe("round 3 interpreter bundles", () => {
  it.each([
    ["perl '-0e' 'print(1)'", "perl"],
    ["perl '-0777ne' 'print(1)'", "perl"],
    ["ruby '-0e' 'print(1)'", "ruby"],
    ["ruby '-00e' 'print(1)'", "ruby"],
    ["py '-Ec' 'print(1)'", "py"],
    ["pythonw '-Ec' 'print(1)'", "pythonw"],
    ["pypy3 '-Ec' 'print(1)'", "pypy3"],
    ["py -3 -Ec 'print(1)'", "py"],
  ])("relays inline code %s without a fake allow", async (script, interpreter) => {
    const r = rig(script, [interpreter]);
    await r.run();
    expect(r.answers).toEqual([]);
    expect(r.logs.at(-1)).toMatchObject({ verdict: "relay", rule: "no-rule", answered: false });
  });

  it.each([
    ["py -3 example.py", "py"],
    ["pythonw example.py", "pythonw"],
    ["pypy3 example.py", "pypy3"],
    ["perl -0777 example.pl", "perl"],
    ["ruby -00 example.rb", "ruby"],
  ])("keeps named-script control %s live", async (script, interpreter) => {
    const r = rig(script, [interpreter]);
    await r.run();
    expect(r.answers).toEqual([{ requestId: "request-1", response: { behavior: "allow" } }]);
    expect(r.logs.at(-1)).toMatchObject({ verdict: "allow", rule: "exec", answered: true });
  });
});

describe("round 3 final state validation", () => {
  it.each(["bad JSON", "EISDIR", "ELOOP"])("relays %s introduced in the final config reread without overwriting state", async (fault) => {
    const r = rig(`Get-Content -LiteralPath '${HOME}\\data\\demo\\example.txt'`, ["node"]);
    let faultBytes = "";
    let writesAtFault = 0;
    r.onConfig(read => {
      if (read !== 2) return;
      expect(JSON.parse(disk.files[STATE]).attempts["crew-1"]).toContain("request-1");
      if (fault === "bad JSON") disk.files[STATE] = "{";
      else disk.errors[STATE] = fault;
      faultBytes = disk.files[STATE];
      writesAtFault = disk.writes;
    });
    await r.run();
    expect(writesAtFault).toBe(1);
    expect(r.answers).toEqual([]);
    expect(r.logs.at(-1)).toMatchObject({ verdict: "relay", rule: "state-error", answered: false });
    expect(disk.files[STATE]).toBe(faultBytes);
    expect(disk.writes).toBe(writesAtFault);
    if (fault !== "bad JSON") expect(disk.errors[STATE]).toBe(fault);
    await r.run();
    expect(r.answers).toEqual([]);
    expect(disk.files[STATE]).toBe(faultBytes);
    expect(disk.writes).toBe(writesAtFault);
  });
});
