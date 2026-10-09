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
import { dirname, join } from "node:path";

import type { PluginLifecycleEvents, PluginLifecycleRegistration } from "@getpaseo/plugin/server";

import { CREW_LABELS, type FirstmateConfig } from "../shared/fleet";
import { resolveHome } from "./config";
import { isCrew, paseoRelayHost } from "./crew-relay";
import { parseCrewReport } from "./crew-report";
import { pluginDir } from "./data-dir";
import type { PaseoApi } from "./host-types";
import { match, neverId, parseNeverAutoExtra, taskIdOk, type MatchResult } from "./permit-match";
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
const STUCK_TURN_STATES: ReadonlySet<string> = new Set(["blocked", "needs-decision", "failed"]);

export interface BrokerState {
  /** Crewmates that may not be answered any more, with when and why. */
  sticky: Record<string, { at: string; reason: string }>;
  /** When each crewmate's requests were judged `allow` in the last hour (ISO). */
  allows: Record<string, string[]>;
  /** Live calls reserved before sending, including failures; never retried after reload. */
  attempts?: Record<string, string[]>;
}

export function emptyBrokerState(): BrokerState {
  return { sticky: {}, allows: {} };
}

export interface BrokerStore {
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
  private readonly queueKey = randomUUID();
  private readonly sent = new Map<string, number>();
  private state: BrokerState | null = null;
  private loading: Promise<BrokerState> | null = null;
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
    return serialized(`${this.queueKey}:${event.agent.id}`, () => this.request(event, paseo));
  }

  private async request(event: PluginLifecycleEvents["agent.permission_requested"], paseo?: PaseoApi): Promise<void> {
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
    let result: MatchResult;
    try {
      result = match(event.request, permits.raw, {
        crew: true,
        task: facts.task,
        mode,
        home,
        userHome: this.userHome,
        worktree: event.agent.cwd,
        sticky: state.sticky[agentId] !== undefined,
        allowsLastHour: recent.length,
        realpath: mode === "live" ? recordPath : this.realpath,
        extraHardware,
      });
    } catch (error) {
      result = { verdict: "relay", rule: "error", tier: null, detail: error instanceof Error ? error.message : String(error) };
    }

    const at = new Date(now).toISOString();
    if (mode === "live" && state.attempts?.[agentId]?.includes(event.request.id)) {
      result = { verdict: "relay", rule: "already-attempted", tier: null, detail: "a live answer was already attempted for this request" };
    }
    if (result.verdict === "allow") state.allows[agentId] = [...recent, at];
    else if (recent.length !== (state.allows[agentId] ?? []).length) state.allows[agentId] = recent;
    const id = neverId(result);
    if (id !== null && STICKY_IDS.has(id) && state.sticky[agentId] === undefined) {
      state.sticky[agentId] = { at, reason: result.rule };
    }
    if (mode === "live" && result.verdict === "allow") {
      state.attempts ??= {};
      state.attempts[agentId] = [...(state.attempts[agentId] ?? []), event.request.id];
    }
    const saved = await this.persist(now);
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
      if (current.permissionBroker !== "live" || resolveHome(current) !== home || current.mateAgentId.trim() === agentId || fresh.sha !== permits.sha) {
        result = { verdict: "relay", rule: "changed", tier: null, detail: "the config or permits changed before answering" };
      } else {
        try {
          result = match(event.request, fresh.raw, {
            crew: true, task: facts.task, mode: "live", home, userHome: this.userHome,
            worktree: event.agent.cwd, sticky: state.sticky[agentId] !== undefined,
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
    const state = await this.load();
    if (state.sticky[agentId] !== undefined) return;
    state.sticky[agentId] = { at, reason };
    await this.persist(now);
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
    if (this.state !== null) return Promise.resolve(this.state);
    this.loading ??= this.store.load().then((state) => {
      this.state = state;
      return state;
    });
    return this.loading;
  }

  private async persist(now: number): Promise<boolean> {
    const state = this.state;
    if (state === null) return false;
    // Sticky marks are never pruned by age: an agent stays sticky for its whole life (spec 3.7).
    for (const [agentId, times] of Object.entries(state.allows)) {
      const recent = times.filter((at) => Date.parse(at) > now - HOUR_MS);
      if (recent.length === 0) delete state.allows[agentId];
      else state.allows[agentId] = recent;
    }
    return this.store.save(state).then(() => true).catch((error: unknown) => {
      console.error("[firstmate] could not save the permission broker's state:", error);
      return false;
    });
  }
}

// ---------------------------------------------------------------------------
// The file, and Paseo
// ---------------------------------------------------------------------------

/** The saved state, leniently: anything it cannot read starts afresh. */
export async function readBrokerState(path: string): Promise<BrokerState> {
  let raw: unknown;
  try {
    raw = JSON.parse(await readFile(path, "utf8"));
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code !== "ENOENT") console.error(`[firstmate] ${path} could not be read, starting afresh:`, error);
    return emptyBrokerState();
  }
  const object = (typeof raw === "object" && raw !== null ? raw : {}) as Record<string, unknown>;
  const state = emptyBrokerState();
  if (typeof object.sticky === "object" && object.sticky !== null) {
    for (const [agentId, mark] of Object.entries(object.sticky)) {
      const { at, reason } = (mark ?? {}) as { at?: unknown; reason?: unknown };
      if (typeof at === "string" && typeof reason === "string") state.sticky[agentId] = { at, reason };
    }
  }
  if (typeof object.allows === "object" && object.allows !== null) {
    for (const [agentId, times] of Object.entries(object.allows)) {
      if (Array.isArray(times)) state.allows[agentId] = times.filter((at): at is string => typeof at === "string");
    }
  }
  if (typeof object.attempts === "object" && object.attempts !== null) {
    state.attempts = {};
    for (const [agentId, ids] of Object.entries(object.attempts)) {
      if (Array.isArray(ids)) state.attempts[agentId] = ids.filter((id): id is string => typeof id === "string");
    }
  }
  return state;
}

/** `permission-broker.json`, written whole to a temporary file and renamed into place. */
export function brokerFileStore(path: string): BrokerStore {
  return {
    load: () => readBrokerState(path),
    save: (state) =>
      serialized(path, async () => {
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
      offs.forEach((off) => off());
      offs = [];
    },
  };
}
