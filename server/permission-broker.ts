/**
 * The permission broker checks crew requests against task permits and the never-auto list. Shadow
 * logs without answering. Live, with live permits, reserves the request durably, repeats every gate
 * immediately before sending one allow, and logs the outcome. Failures and timeouts are never retried.
 * No mode sends messages or denies a request.
 *
 * - **Which requests.** Only an agent labelled `firstmate.role=crew`, not the first mate itself. A
 *   crewmate's labels are looked up once, through the crew relay's lookup, and kept for its life. An agent
 *   without the crew label is not looked at further and gets no log line.
 * - **Permits.** `data/permissions/permits/<task>.json` in the home, read on every request, so an edit
 *   takes effect at once. Missing, unreadable or invalid means nothing is allowed.
 * - **After a refusal (spec 3.7).** A crewmate becomes sticky for the rest of its life when a person denies
 *   one of its requests, when a turn of it ends on a `blocked:`, `needs-decision:` or `failed:` status
 *   line, or when a request of it hits `destructive`, `outward`, `credential` or `system`. From then on
 *   its requests relay as `never:after-refusal`. Kept in `permission-broker.json` in the plugin's data
 *   folder, with the allows of the last hour for the rate limit, so a reload forgets neither.
 * - **The log (spec 3.9).** `data/permissions/log-YYYY-MM.jsonl` in the home, appended one JSON line per
 *   request and per resolution, never edited. Commands are redacted and cut to 2000 characters; the
 *   crewmate's own description of the request is not logged. A failed write goes to stderr at most once
 *   an hour and changes nothing else.
 * - **Off is off.** With `permissionBroker` `"off"` when the plugin loads, no hook is registered. Each event
 *   reads the config again, so switching to `"off"` later stops the broker at once.
 *
 * Every hook is guarded: an error goes to stderr and costs at most that event's log line.
 */
import { createHash, randomUUID } from "node:crypto";
import { realpathSync } from "node:fs";
import { appendFile, mkdir, readFile, rename, writeFile } from "node:fs/promises";
import { homedir } from "node:os";
import { dirname, join, resolve } from "node:path";

import type { PluginLifecycleEvents, PluginLifecycleRegistration } from "@getpaseo/plugin/server";

import { CREW_LABELS, type FirstmateConfig } from "../shared/fleet";
import { resolveHome } from "./config";
import { isCrew, paseoRelayHost } from "./crew-relay";
import { parseCrewReport } from "./crew-report";
import { pluginDir } from "./data-dir";
import type { PaseoApi } from "./host-types";
import { match, neverId, parseNeverAutoExtra, taskIdOk, type MatchContext, type MatchResult } from "./permit-match";
import { neverAuto, STICKY_IDS } from "./permit-rules";
import { closingText } from "./report-cache";
import { serialized } from "./serialize";

/** The label a crewmate's plan is named by, when the first mate sets one. */
export const PLAN_LABEL = "firstmate.plan";
/** The most of a command a log line keeps. */
export const MAX_LOGGED_COMMAND = 2000;
/** How many crewmates' labels are kept, and how long an allow time is. */
const MAX_AGENTS = 2000;
const HOUR_MS = 60 * 60 * 1000;
const ANSWER_TIMEOUT_MS = 10_000;
const RESOLUTION_WINDOW_MS = 30_000;
const MAX_ATTEMPTS_PER_AGENT = 4096;
const STUCK_TURN_STATES: ReadonlySet<string> = new Set(["blocked", "needs-decision", "failed"]);

export interface BrokerState {
  /** Read/parse/schema failure; never answer live or save this state over the file. */
  broken?: boolean;
  /** Crewmates that may not be answered any more, with when and why. */
  sticky: Record<string, { at: string; reason: string }>;
  /** When each crewmate's requests were judged `allow` in the last hour (ISO). */
  allows: Record<string, string[]>;
  /** Live calls reserved before sending. Null is an exhausted ledger: relay for the agent's life. */
  attempts?: Record<string, string[] | null>;
}

export function emptyBrokerState(): BrokerState {
  return { sticky: {}, allows: {} };
}

export interface BrokerStore {
  /** Stable storage identity across reloads. Custom stores without a key share one conservative queue. */
  key?: string;
  load(): Promise<BrokerState>;
  save(state: BrokerState): Promise<void>;
}

/** What the broker needs of Paseo: an agent's labels, null when Paseo has no such agent. */
export interface BrokerHost {
  labels(agentId: string): Promise<Readonly<Record<string, string>> | null>;
}

interface CrewFacts {
  task: string | null;
  plan: string | null;
}

export interface PermissionBrokerOptions {
  host: BrokerHost;
  store: BrokerStore;
  readConfig: () => Promise<FirstmateConfig>;
  /** Appends text to a file, creating its folder. */
  append?: (path: string, text: string) => Promise<void>;
  now?: () => number;
  realpath?: (path: string) => string | null;
  userHome?: string;
}

// ---------------------------------------------------------------------------
// Redaction
// ---------------------------------------------------------------------------

const VALUE = String.raw`(?:\s*[=:]\s*|\s+)(?:'[^']*'|"[^"]*"|[^\s'";|,]+)`;
const SECRETS: readonly RegExp[] = [
  /\bgh[pousr]_[A-Za-z0-9]{20,}/g,
  /\bgithub_pat_[A-Za-z0-9_]{20,}/g,
  /\bxox[abposr]-[A-Za-z0-9-]{10,}/g,
  /[A-Za-z0-9+/=_-]{48,}/g,
  ...neverAuto("credential").patterns.map((pattern) => new RegExp(`(?:${pattern.source})(?:${VALUE})?`, "gi")),
];

/** Anything that looks like a credential, with the value after it, replaced by `[redacted]`. */
export function redact(text: string): string {
  return SECRETS.reduce((current, pattern) => current.replace(pattern, "[redacted]"), text);
}

function clip(text: string, max: number): string {
  return text.length <= max ? text : `${text.slice(0, max)}[cut ${text.length - max} chars]`;
}

// ---------------------------------------------------------------------------
// The broker
// ---------------------------------------------------------------------------

function defaultRealpath(path: string): string | null {
  try {
    return realpathSync.native(path);
  } catch (error) {
    const code = (error as NodeJS.ErrnoException).code;
    if (code === "ENOENT" || code === "ENOTDIR") return null;
    // Unsure where it leads: the request fails to match and is relayed.
    throw error;
  }
}

interface BrokerCoordination {
  run: typeof serialized;
  pendingSticky: Map<string, Map<string, { at: string; reason: string }>>;
}

// Retain the first queue function even when a plugin reload evaluates another copy of this module.
const COORDINATION = Symbol.for("firstmate.permission-broker.coordination");
const coordination = (globalThis as typeof globalThis & { [key: symbol]: BrokerCoordination | undefined })[COORDINATION]
  ??= { run: serialized, pendingSticky: new Map() };

/** The SDK has no per-call timeout or cancellation; stop waiting, never resend. */
async function answerOnce(paseo: PaseoApi, agentId: string, requestId: string): Promise<void> {
  let timer: ReturnType<typeof setTimeout> | undefined;
  try {
    const deadline = new Promise<never>((_resolve, reject) => {
      timer = setTimeout(() => reject(new DOMException("Permission answer timed out", "TimeoutError")), ANSWER_TIMEOUT_MS);
    });
    await Promise.race([
      paseo.agents.ref(agentId).respondToPermission({ requestId, response: { behavior: "allow" } }),
      deadline,
    ]);
  } finally {
    clearTimeout(timer);
  }
}

async function defaultAppend(path: string, text: string): Promise<void> {
  await mkdir(dirname(path), { recursive: true });
  await appendFile(path, text, "utf8");
}

export class PermissionBroker {
  private readonly queueKey: string;
  private stopped = false;
  private readonly sent = new Map<string, number>();
  private readonly crew = new Map<string, CrewFacts | null>();
  private lastLogError = Number.NEGATIVE_INFINITY;
  private readonly host: BrokerHost;
  private readonly store: BrokerStore;
  private readonly readConfig: () => Promise<FirstmateConfig>;
  private readonly append: (path: string, text: string) => Promise<void>;
  private readonly now: () => number;
  private readonly realpath: (path: string) => string | null;
  private readonly userHome: string;

  constructor(options: PermissionBrokerOptions) {
    this.queueKey = `permission-broker:${options.store.key ?? "custom-stores"}`;
    this.host = options.host;
    this.store = options.store;
    this.readConfig = options.readConfig;
    this.append = options.append ?? defaultAppend;
    this.now = options.now ?? Date.now;
    this.realpath = options.realpath ?? defaultRealpath;
    this.userHome = options.userHome ?? homedir();
  }

  /** The config when the broker is on and the agent is a crewmate other than the first mate; else null. */
  private async crewmate(agentId: string): Promise<{ config: FirstmateConfig; facts: CrewFacts } | null> {
    const config = await this.readConfig();
    if (config.permissionBroker === "off") return null;
    const mateId = config.mateAgentId.trim();
    if (agentId === mateId) return null;
    let facts = this.crew.get(agentId);
    if (facts === undefined) {
      const labels = await this.host.labels(agentId);
      if (labels === null) return null;
      facts = isCrew(agentId, labels, mateId)
        ? { task: labels[CREW_LABELS.task] ?? null, plan: labels[PLAN_LABEL] ?? null }
        : null;
      this.crew.set(agentId, facts);
      if (this.crew.size > MAX_AGENTS) this.crew.delete(this.crew.keys().next().value as string);
    }
    return facts === null ? null : { config, facts };
  }

  async onPermissionRequested(event: PluginLifecycleEvents["agent.permission_requested"], paseo?: PaseoApi): Promise<void> {
    return coordination.run(this.queueKey, () => this.request(event, paseo));
  }

  /** Invalidates queued and in-flight work before an answer; an SDK call already sent cannot be recalled. */
  stop(): void {
    this.stopped = true;
  }

  private async request(event: PluginLifecycleEvents["agent.permission_requested"], paseo?: PaseoApi): Promise<void> {
    if (this.stopped) return;
    const found = await this.crewmate(event.agent.id);
    if (found === null) return;
    const { config, facts } = found;
    const mode = config.permissionBroker === "live" ? "live" : "shadow";
    const home = resolveHome(config);
    const permits = facts.task !== null && taskIdOk(facts.task) ? await this.readPermits(home, facts.task) : { raw: undefined, sha: null };
    const extraHardware = await this.readSupplement(home);
    const state = await this.load();
    const now = this.now();
    const agentId = event.agent.id;
    const recent = (state.allows[agentId] ?? []).filter((at) => Date.parse(at) > now - HOUR_MS);
    const paths = new Map<string, string | null>();
    const recordPath = (path: string): string | null => {
      const real = this.realpath(path);
      if (paths.has(path) && paths.get(path) !== real) throw new Error("A path changed during matching");
      paths.set(path, real);
      return real;
    };
    const context: MatchContext = {
      crew: true,
      task: facts.task,
      mode,
      home,
      userHome: this.userHome,
      worktree: event.agent.cwd,
      sticky: state.sticky[agentId] !== undefined || this.pendingSticky(agentId),
      allowsLastHour: recent.length,
      realpath: mode === "live" ? recordPath : this.realpath,
      extraHardware,
    };
    let result: MatchResult;
    try {
      result = match(event.request, permits.raw, context);
    } catch (error) {
      result = { verdict: "relay", rule: "error", tier: null, detail: error instanceof Error ? error.message : String(error) };
    }

    const at = new Date(now).toISOString();
    // Permits stay the first verdict gate in live. Never-auto observations still make a crew
    // member sticky even while permits are missing or not live; shadow can never send an answer.
    let stickyId = neverId(result);
    if (mode === "live" && result.rule === "never:no-permits") {
      try {
        stickyId = neverId(match(event.request, permits.raw, { ...context, mode: "shadow" }));
      } catch {
        // The live verdict already relays; an incomplete observation cannot authorize anything.
      }
    }
    if (stickyId !== null && STICKY_IDS.has(stickyId) && state.sticky[agentId] === undefined) {
      state.sticky[agentId] = { at, reason: `never:${stickyId}` };
      if (state.broken) this.rememberSticky(agentId, at, `never:${stickyId}`);
    }
    const attempts = state.attempts?.[agentId];
    if (mode === "live" && attempts?.includes(event.request.id)) {
      result = { verdict: "relay", rule: "already-attempted", tier: null, detail: "a live answer was already attempted for this request" };
    }
    if (mode === "live" && (attempts === null || (attempts?.length ?? 0) >= MAX_ATTEMPTS_PER_AGENT)) {
      state.attempts![agentId] = null;
      result = { verdict: "relay", rule: "attempt-cap", tier: null, detail: "the agent's live attempt ledger is exhausted; relay for its remaining life" };
    }
    if (mode === "live" && state.broken) {
      result = { verdict: "relay", rule: "state-error", tier: null, detail: "the broker state is broken; repair it before live answering" };
    }
    if (result.verdict === "allow") state.allows[agentId] = [...recent, at];
    else if (recent.length !== (state.allows[agentId] ?? []).length) state.allows[agentId] = recent;
    if (mode === "live" && result.verdict === "allow") {
      state.attempts ??= {};
      state.attempts[agentId] = [...(state.attempts[agentId] ?? []), event.request.id];
      if (state.attempts[agentId]!.length >= MAX_ATTEMPTS_PER_AGENT) state.attempts[agentId] = null;
    }
    const saved = await this.persist(state, now);
    if (!saved && mode === "live" && result.verdict === "allow") {
      result = { verdict: "relay", rule: "state-error", tier: null, detail: "the answer reservation could not be saved" };
    }

    // Config and permits may have changed during file I/O; repeat the complete check order. Path
    // identities must match the first pass, including the roots themselves. No await separates the
    // final realpath checks from sending allow. The SDK cannot lock paths through command execution.
    if (mode === "live" && result.verdict === "allow") {
      const fresh = await this.readPermits(home, facts.task as string);
      const hardware = await this.readSupplement(home);
      const current = await this.readConfig();
      const finalState = await this.load();
      if (finalState.broken) {
        result = { verdict: "relay", rule: "state-error", tier: null, detail: "the broker state became broken before answering" };
      } else if (current.permissionBroker !== "live" || resolveHome(current) !== home || current.mateAgentId.trim() === agentId || fresh.sha !== permits.sha) {
        result = { verdict: "relay", rule: "changed", tier: null, detail: "the config or permits changed before answering" };
      } else {
        try {
          result = match(event.request, fresh.raw, {
            crew: true, task: facts.task, mode: "live", home, userHome: this.userHome,
            worktree: event.agent.cwd, sticky: finalState.sticky[agentId] !== undefined || this.pendingSticky(agentId),
            allowsLastHour: recent.length, extraHardware: hardware,
            realpath: (path) => {
              const real = this.realpath(path);
              if (!paths.has(path) || paths.get(path) !== real) throw new Error("A path changed before answering");
              return real;
            },
          });
        } catch {
          result = { verdict: "relay", rule: "changed", tier: null, detail: "a path changed before answering" };
        }
      }
    }

    let answered = false;
    let answerError: string | undefined;
    if (this.stopped) result = { verdict: "relay", rule: "stopped", tier: null, detail: "the broker stopped before answering" };
    if (mode === "live" && result.verdict === "allow") {
      try {
        if (paseo === undefined) throw new Error("Paseo unavailable");
        for (const [key, at] of this.sent) if (this.now() - at > RESOLUTION_WINDOW_MS) this.sent.delete(key);
        this.sent.set(JSON.stringify([agentId, event.request.id]), this.now());
        await answerOnce(paseo, agentId, event.request.id);
        answered = true;
      } catch (error) {
        answerError = error instanceof DOMException ? error.name : error instanceof Error ? error.constructor.name : "UnknownError";
      }
    }

    const input = (typeof event.request.input === "object" && event.request.input !== null ? event.request.input : {}) as Record<string, unknown>;
    const command = typeof input.command === "string" ? clip(redact(input.command), MAX_LOGGED_COMMAND) : null;
    const cwd = typeof input.cwd === "string" ? redact(input.cwd) : null;
    await this.log(home, now, {
      v: 1,
      ts: at,
      event: "request",
      mode,
      agentId,
      task: facts.task,
      plan: facts.plan,
      provider: event.request.provider,
      name: event.request.name,
      kind: event.request.kind,
      requestId: event.request.id,
      cwd,
      command,
      verdict: result.verdict,
      rule: result.rule,
      tier: result.tier,
      detail: clip(redact(result.detail), 500),
      permitsSha256: permits.sha,
      answered,
      ...(answerError === undefined ? {} : { answerError }),
    });
  }

  async onPermissionResolved(event: PluginLifecycleEvents["agent.permission_resolved"]): Promise<void> {
    const found = await this.crewmate(event.agent.id);
    if (found === null) return;
    const now = this.now();
    const at = new Date(now).toISOString();
    if (event.resolution.behavior === "deny") await this.makeSticky(event.agent.id, at, "deny", now);
    await this.log(resolveHome(found.config), now, {
      v: 1,
      ts: at,
      event: "resolved",
      agentId: event.agent.id,
      requestId: event.requestId,
      behavior: event.resolution.behavior,
      byBroker: event.resolution.behavior === "allow" && this.sent.has(JSON.stringify([event.agent.id, event.requestId])) &&
        now - (this.sent.get(JSON.stringify([event.agent.id, event.requestId])) ?? 0) <= RESOLUTION_WINDOW_MS,
    });
  }

  async onTurnEnded(event: PluginLifecycleEvents["agent.turn_ended"]): Promise<void> {
    const found = await this.crewmate(event.agent.id);
    if (found === null) return;
    const report = parseCrewReport(closingText(event.timeline));
    if (report === null || !STUCK_TURN_STATES.has(report.state)) return;
    const now = this.now();
    await this.makeSticky(event.agent.id, new Date(now).toISOString(), `turn:${report.state}`, now);
  }

  /** The saved state, for tests. */
  snapshot(): Promise<BrokerState> {
    return this.load();
  }

  private async makeSticky(agentId: string, at: string, reason: string, now: number): Promise<void> {
    const mark = this.rememberSticky(agentId, at, reason);
    // A refusal must be visible to a request holding the queue before its durable write can run.
    await coordination.run(this.queueKey, async () => {
      const state = await this.load();
      state.sticky[agentId] ??= mark;
      await this.persist(state, now);
    });
  }

  private rememberSticky(agentId: string, at: string, reason: string): { at: string; reason: string } {
    const pending = coordination.pendingSticky.get(this.queueKey) ?? new Map();
    coordination.pendingSticky.set(this.queueKey, pending);
    const mark = pending.get(agentId) ?? { at, reason };
    pending.set(agentId, mark);
    return mark;
  }

  private pendingSticky(agentId: string): boolean {
    return coordination.pendingSticky.get(this.queueKey)?.has(agentId) ?? false;
  }

  /**
   * The private never-auto supplement, `data/permissions/never-auto-extra.json` in the home (spec amendment
   * 2026-10-09), read on every request. Null when it is missing, unreadable or invalid: then no exec
   * statement is allowed. Its names are never logged.
   */
  private async readSupplement(home: string): Promise<string[] | null> {
    try {
      return parseNeverAutoExtra(JSON.parse(await readFile(join(home, "data", "permissions", "never-auto-extra.json"), "utf8")));
    } catch {
      return null;
    }
  }

  private async readPermits(home: string, task: string): Promise<{ raw: unknown; sha: string | null }> {
    let bytes: Buffer;
    try {
      bytes = await readFile(join(home, "data", "permissions", "permits", `${task}.json`));
    } catch (error) {
      if ((error as NodeJS.ErrnoException).code !== "ENOENT") console.error(`[firstmate] permission broker could not read the permits of ${task}:`, error);
      return { raw: undefined, sha: null };
    }
    const sha = createHash("sha256").update(bytes).digest("hex");
    try {
      return { raw: JSON.parse(bytes.toString("utf8")), sha };
    } catch {
      // Not JSON: invalid, which relays everything.
      return { raw: null, sha };
    }
  }

  private async log(home: string, now: number, line: Record<string, unknown>): Promise<void> {
    const month = new Date(now).toISOString().slice(0, 7);
    const path = join(home, "data", "permissions", `log-${month}.jsonl`);
    try {
      await this.append(path, `${JSON.stringify(line)}\n`);
    } catch (error) {
      if (now - this.lastLogError >= HOUR_MS) {
        this.lastLogError = now;
        console.error(`[firstmate] permission broker could not write ${path}:`, error);
      }
    }
  }

  private load(): Promise<BrokerState> {
    return this.store.load();
  }

  private async persist(state: BrokerState, now: number): Promise<boolean> {
    if (state.broken) return false;
    const pending = coordination.pendingSticky.get(this.queueKey);
    const marks = [...(pending?.entries() ?? [])];
    for (const [agentId, mark] of marks) state.sticky[agentId] ??= mark;
    // Sticky marks are never pruned by age: an agent stays sticky for its whole life (spec 3.7).
    for (const [agentId, times] of Object.entries(state.allows)) {
      const recent = times.filter((at) => Date.parse(at) > now - HOUR_MS);
      if (recent.length === 0) delete state.allows[agentId];
      else state.allows[agentId] = recent;
    }
    return this.store.save(state).then(() => {
      for (const [agentId, mark] of marks) if (pending?.get(agentId) === mark) pending.delete(agentId);
      if (pending?.size === 0 && coordination.pendingSticky.get(this.queueKey) === pending) coordination.pendingSticky.delete(this.queueKey);
      return true;
    }).catch((error: unknown) => {
      console.error("[firstmate] could not save the permission broker's state:", error);
      return false;
    });
  }
}

// ---------------------------------------------------------------------------
// The file, and Paseo
// ---------------------------------------------------------------------------

function stateRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}

/** Only a missing file starts fresh. A broken ledger is left intact for recovery. */
export async function readBrokerState(path: string): Promise<BrokerState> {
  try {
    const object: unknown = JSON.parse(await readFile(path, "utf8"));
    const invalid = (): never => { throw new Error("Invalid permission broker state"); };
    if (!stateRecord(object) || object.broken || !stateRecord(object.sticky) || !stateRecord(object.allows)) return invalid();
    const state = emptyBrokerState();
    for (const [agentId, mark] of Object.entries(object.sticky)) {
      if (!stateRecord(mark) || typeof mark.at !== "string" || !Number.isFinite(Date.parse(mark.at)) || typeof mark.reason !== "string") return invalid();
      state.sticky[agentId] = { at: mark.at, reason: mark.reason };
    }
    for (const [agentId, times] of Object.entries(object.allows)) {
      if (!Array.isArray(times) || !times.every((at) => typeof at === "string" && Number.isFinite(Date.parse(at)))) return invalid();
      state.allows[agentId] = times;
    }
    if (object.attempts !== undefined) {
      if (!stateRecord(object.attempts)) return invalid();
      state.attempts = {};
      for (const [agentId, ids] of Object.entries(object.attempts)) {
        if (ids === null) state.attempts[agentId] = null;
        else if (Array.isArray(ids)) {
          if (!ids.every((id) => typeof id === "string")) return invalid();
          state.attempts[agentId] = ids.length >= MAX_ATTEMPTS_PER_AGENT ? null : ids;
        } else return invalid();
      }
    }
    return state;
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code === "ENOENT") return emptyBrokerState();
    console.error(`[firstmate] ${path} could not be read; leaving the broker state unchanged:`, error);
    return { ...emptyBrokerState(), broken: true };
  }
}

/** `permission-broker.json`, written whole to a temporary file and renamed into place. */
export function brokerFileStore(path: string): BrokerStore {
  const absolute = resolve(path);
  return {
    key: process.platform === "win32" ? absolute.toLowerCase() : absolute,
    load: () => readBrokerState(path),
    save: (state) =>
      serialized(path, async () => {
        // A hand edit may have broken the file after the request loaded it. Never replace known
        // broken bytes, including when shadow or a pending refusal tries to save.
        if (state.broken || (await readBrokerState(path)).broken) throw new Error("Refusing to replace broken permission broker state");
        await mkdir(dirname(path), { recursive: true });
        const temporary = `${path}.${randomUUID()}.tmp`;
        await writeFile(temporary, `${JSON.stringify(state, null, 2)}\n`, "utf8");
        await rename(temporary, path);
      }),
  };
}

/** Paseo for the broker: the crew relay's lookup of an agent's labels. */
export function paseoBrokerHost(handle: () => PaseoApi | null, readConfig: () => Promise<FirstmateConfig>): BrokerHost {
  const relayHost = paseoRelayHost(handle, readConfig);
  return {
    async labels(agentId) {
      return (await relayHost.crewFacts(agentId))?.labels ?? null;
    },
  };
}

export interface RegisterPermissionBrokerOptions {
  stateFile?: string;
  append?: PermissionBrokerOptions["append"];
  now?: PermissionBrokerOptions["now"];
  realpath?: PermissionBrokerOptions["realpath"];
  userHome?: string;
  host?: BrokerHost;
}

/**
 * Wires the broker to Paseo's hooks, unless the config says `"off"` when it loads. `ready` settles once
 * that is decided. Returns what stops it.
 */
export function registerPermissionBroker(
  server: PluginLifecycleRegistration,
  readConfig: () => Promise<FirstmateConfig>,
  options: RegisterPermissionBrokerOptions = {},
): { broker: PermissionBroker; ready: Promise<void>; stop: () => void } {
  let paseo: PaseoApi | null = null;
  let stopped = false;
  let offs: Array<() => void> = [];
  const broker = new PermissionBroker({
    host: options.host ?? paseoBrokerHost(() => paseo, readConfig),
    store: brokerFileStore(options.stateFile ?? join(pluginDir(), "permission-broker.json")),
    readConfig,
    ...(options.append === undefined ? {} : { append: options.append }),
    ...(options.now === undefined ? {} : { now: options.now }),
    ...(options.realpath === undefined ? {} : { realpath: options.realpath }),
    ...(options.userHome === undefined ? {} : { userHome: options.userHome }),
  });
  const guard =
    <E>(name: string, run: (event: E, api: PaseoApi) => Promise<void>) =>
    async (event: E, context: { paseo: PaseoApi }) => {
      try {
        paseo = context.paseo;
        await run(event, context.paseo);
      } catch (error) {
        console.error(`[firstmate] permission broker could not handle ${name}:`, error);
      }
    };
  const ready = readConfig()
    .then((config) => {
      if (stopped || config.permissionBroker === "off") return;
      offs = [
        server.on(
          "agent.permission_requested",
          guard<PluginLifecycleEvents["agent.permission_requested"]>("a permission request", (event, api) => broker.onPermissionRequested(event, api)),
        ),
        server.on(
          "agent.permission_resolved",
          guard<PluginLifecycleEvents["agent.permission_resolved"]>("a resolved permission", (event) => broker.onPermissionResolved(event)),
        ),
        server.on("agent.turn_ended", guard<PluginLifecycleEvents["agent.turn_ended"]>("a turn's end", (event) => broker.onTurnEnded(event))),
      ];
    })
    .catch((error: unknown) => {
      console.error("[firstmate] permission broker could not read the config; it stays off:", error);
    });
  return {
    broker,
    ready,
    stop() {
      stopped = true;
      broker.stop();
      offs.forEach((off) => off());
      offs = [];
    },
  };
}
