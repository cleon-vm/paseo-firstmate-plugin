/**
 * The permission broker's matcher: would a crewmate's permission request be answered `allow` under its
 * task's permits, or relayed to a person? Pure: no I/O but the injected `realpath`, no clock.
 *
 * Literal and default-relay (spec 3.5). A Codex command approval's command line must be exactly
 * `"<dir>\pwsh.exe" [-NoProfile] -Command '<script>'`; the script is split into statements, each of which must be an
 * allowed `$env:` assignment, an apply_patch envelope, or one plain command of bare words and quoted
 * strings, at most piped into a formatting cmdlet. Every statement must match an allow rule; any doubt
 * relays. The never-auto list (`permit-rules.ts`) is checked before any rule: its patterns against the
 * script, its command names against each statement.
 */
import {
  MAX_ALLOWS_PER_HOUR,
  NEVER_AUTO,
  RESERVED_TASKS,
  type NeverAutoId,
  neverAuto,
} from "./permit-rules";

// ---------------------------------------------------------------------------
// Permits (spec 3.4)
// ---------------------------------------------------------------------------

export type ExecPlace = "scratch" | "worktree" | "notes";

export interface ExecEntry {
  in: ExecPlace;
  prefix: string[];
}

export interface Permits {
  version: 1;
  task: string;
  live: boolean;
  /** Home-relative folders under `data/`. */
  writeDirs: string[];
  scratchDirs: string[];
  readRepos: string[];
  netRead: { githubRepos: string[]; hosts: string[] };
  gitLocal: boolean;
  exec: ExecEntry[];
  envNames: string[];
}

const SEGMENT = /^[A-Za-z0-9][A-Za-z0-9 ._-]*$/;
const ABSOLUTE = /^[A-Za-z]:[\\/]/;

function strings(value: unknown): string[] | null {
  if (value === undefined) return [];
  if (!Array.isArray(value) || !value.every((item) => typeof item === "string" && item !== "")) return null;
  return value as string[];
}

function writeDirOk(dir: string): boolean {
  const parts = dir.replace(/\\/g, "/").split("/");
  return parts.length >= 2 && parts[0] === "data" && parts.slice(1).every((part) => SEGMENT.test(part) && !part.includes(".."));
}

/** The permits file's JSON as permits, or null when it is not a valid version 1 file. */
export function parsePermits(raw: unknown): Permits | null {
  if (typeof raw !== "object" || raw === null || Array.isArray(raw)) return null;
  const file = raw as Record<string, unknown>;
  if (file.version !== 1 || typeof file.task !== "string") return null;
  if (file.live !== undefined && typeof file.live !== "boolean") return null;
  if (file.gitLocal !== undefined && typeof file.gitLocal !== "boolean") return null;
  const writeDirs = strings(file.writeDirs);
  const scratchDirs = strings(file.scratchDirs);
  const readRepos = strings(file.readRepos);
  const envNames = strings(file.envNames);
  const net = file.netRead === undefined ? {} : file.netRead;
  if (typeof net !== "object" || net === null || Array.isArray(net)) return null;
  const githubRepos = strings((net as Record<string, unknown>).githubRepos);
  const hosts = strings((net as Record<string, unknown>).hosts);
  if (writeDirs === null || scratchDirs === null || readRepos === null || envNames === null) return null;
  if (githubRepos === null || hosts === null) return null;
  if (!writeDirs.every(writeDirOk)) return null;
  if (![...scratchDirs, ...readRepos].every((dir) => ABSOLUTE.test(dir))) return null;
  if (!githubRepos.every((pair) => /^[A-Za-z0-9-]+\/[A-Za-z0-9._-]+$/.test(pair) && !pair.includes(".."))) return null;
  if (!hosts.every((host) => /^[A-Za-z0-9-]+(?:\.[A-Za-z0-9-]+)+$/.test(host))) return null;
  if (!envNames.every((name) => /^[A-Za-z_][A-Za-z0-9_]*$/.test(name))) return null;
  const execRaw = file.exec === undefined ? [] : file.exec;
  if (!Array.isArray(execRaw)) return null;
  const exec: ExecEntry[] = [];
  for (const entry of execRaw) {
    if (typeof entry !== "object" || entry === null) return null;
    const place = (entry as Record<string, unknown>).in;
    const prefix = strings((entry as Record<string, unknown>).prefix);
    if (place !== "scratch" && place !== "worktree" && place !== "notes") return null;
    if (prefix === null || prefix.length === 0) return null;
    exec.push({ in: place, prefix });
  }
  return {
    version: 1,
    task: file.task,
    live: file.live === true,
    writeDirs,
    scratchDirs,
    readRepos,
    netRead: { githubRepos, hosts },
    gitLocal: file.gitLocal === true,
    exec,
    envNames,
  };
}

/**
 * The private never-auto supplement (`data/permissions/never-auto-extra.json` in the home, spec amendment
 * 2026-10-09): hardware command names kept out of this public repository. Its names as `nativeName` gives
 * them (lowercase, no executable suffix), or null when the file is not a valid version 1 supplement.
 */
export function parseNeverAutoExtra(raw: unknown): string[] | null {
  if (typeof raw !== "object" || raw === null || (raw as { version?: unknown }).version !== 1) return null;
  const names = (raw as { neverAuto?: { hardware?: { commandBasenames?: unknown } } }).neverAuto?.hardware?.commandBasenames;
  if (!Array.isArray(names) || !names.every((name) => typeof name === "string" && /^[A-Za-z0-9][A-Za-z0-9._-]*$/.test(name))) return null;
  return names.map((name: string) => nativeName(name));
}

/** A word's native name: last path part, lowercase, without a Windows executable suffix (.exe, .com, .bat, .cmd). */
function nativeName(word: string): string {
  return (word.replace(/\//g, "\\").split("\\").pop() ?? word).toLowerCase().replace(/\.(?:exe|com|bat|cmd)$/, "");
}

// ---------------------------------------------------------------------------
// The request and the answer
// ---------------------------------------------------------------------------

export interface PermitRequest {
  provider: string;
  name: string;
  kind: string;
  input?: unknown;
}

export interface MatchContext {
  /** Whether the agent carries the crew role label. */
  crew: boolean;
  /** Its `firstmate.task` label, null when it has none. */
  task: string | null;
  /** The broker's mode; in `live` a permits file with `"live": false` relays. */
  mode: "shadow" | "live";
  /** The first mate's home, absolute. */
  home: string;
  /** The user's profile folder (where `.codex` and `.paseo` live). */
  userHome: string;
  /** The agent's worktree: `agent.cwd` from the hook, never a value from the permits. */
  worktree: string;
  /** The agent is sticky after a refusal (spec 3.7). */
  sticky: boolean;
  /** Automatic allows for this agent in the last hour. */
  allowsLastHour: number;
  /** The real path of an existing path, null when it does not exist. */
  realpath: (path: string) => string | null;
  /** The supplement's hardware basenames (`parseNeverAutoExtra`); null when it is missing or invalid, which relays every exec statement. */
  extraHardware: readonly string[] | null;
}

export type Verdict = "allow" | "relay";

export interface MatchResult {
  verdict: Verdict;
  /** The allow rule(s) joined by `+`, `never:<id>` for a never-auto hit, or `no-rule`. */
  rule: string;
  tier: 1 | 2 | null;
  detail: string;
}

function never(id: NeverAutoId, detail: string): MatchResult {
  return { verdict: "relay", rule: `never:${id}`, tier: null, detail };
}

/** The never-auto id a relay came from, or null. */
export function neverId(result: Pick<MatchResult, "rule">): NeverAutoId | null {
  return result.rule.startsWith("never:") ? (result.rule.slice("never:".length) as NeverAutoId) : null;
}

/** A task id that names a task: a path-safe slug, not a folder the broker owns or a device name. */
export function taskIdOk(task: string): boolean {
  return /^[A-Za-z0-9][A-Za-z0-9_-]{0,119}$/.test(task) && !RESERVED_TASKS.has(task.toLowerCase());
}

// ---------------------------------------------------------------------------
// Unwrap (step 1)
// ---------------------------------------------------------------------------

/** The two places pwsh is installed: the Store's alias folder and Program Files. */
export function pwshDirs(userHome: string): string[] {
  return [`${userHome}\\AppData\\Local\\Microsoft\\WindowsApps`, "C:\\Program Files\\PowerShell\\7"].map(canon);
}

/** Lowercase, backslashes, no trailing backslash: for comparing literal paths and words. */
function canon(path: string): string {
  return path.replace(/\//g, "\\").replace(/\\+$/, "").toLowerCase();
}

/**
 * The script inside `"<dir>\pwsh.exe" -Command '<script>'` (or `-NoProfile -Command`, which Codex also
 * sends and which only runs less; accepted by the spec amendment of 2026-10-09), or null when the line is
 * not exactly that.
 */
export function unwrapCommand(command: string, userHome: string): string | null {
  const match = /^"([^"]+)\\pwsh\.exe" (?:-NoProfile )?-Command '([\s\S]*)'$/i.exec(command);
  if (match === null) return null;
  if (!pwshDirs(userHome).includes(canon(match[1] ?? ""))) return null;
  const inner = match[2] ?? "";
  let script = "";
  for (let index = 0; index < inner.length; index += 1) {
    const char = inner[index];
    if (char === "'") {
      if (inner[index + 1] !== "'") return null;
      index += 1;
    }
    script += char;
  }
  return script;
}

/** The text the never-auto patterns read when the line could not be unwrapped: without a leading shell. */
function stripShell(command: string): string {
  return command.replace(/^\s*(?:"[^"]*\\(?:pwsh|powershell)(?:\.exe)?"|(?:[^"\s]*\\)?(?:pwsh|powershell)(?:\.exe)?)(?:\s+-[A-Za-z]+)*?\s+-Command\s+/i, "");
}

// ---------------------------------------------------------------------------
// Statements (step 2)
// ---------------------------------------------------------------------------

/** One argument: its value with quotes removed, and its comma-separated parts. */
export interface Word {
  value: string;
  parts: string[];
  /** It starts with a quoted string. */
  quoted: boolean;
}

export type Statement =
  | { kind: "env"; name: string; value: string; text: string }
  | { kind: "command"; call: boolean; words: Word[]; pipes: Word[][]; text: string }
  | { kind: "patch"; variable: string; body: string; shim: string; text: string };

export type Parsed = { ok: true; statements: Statement[]; masked: string } | { ok: false; reason: string };

const FORMATTERS = new Set([
  "select-object",
  "select-string",
  "format-list",
  "format-table",
  "out-string",
  "measure-object",
  "sort-object",
]);
const BARE = /[A-Za-z0-9._\-:\\/=+@%~^!?*]/;

/** Reads a quoted string at `start`; returns its value and where it ends, or a reason. */
function readQuoted(text: string, start: number): { value: string; end: number } | { reason: string } {
  const quote = text[start];
  let value = "";
  for (let index = start + 1; index < text.length; index += 1) {
    const char = text[index];
    if (char === quote) {
      if (text[index + 1] === quote) {
        value += quote;
        index += 1;
        continue;
      }
      return { value, end: index + 1 };
    }
    if (quote === '"' && (char === "$" || char === "`")) return { reason: `a ${char} inside a double-quoted string` };
    value += char;
  }
  return { reason: "an unclosed quote" };
}

/** Splits one statement into pipe segments of words. */
function tokenize(text: string): { call: boolean; segments: Word[][] } | { reason: string } {
  const segments: Word[][] = [[]];
  let call = false;
  let word: Word | null = null;
  let part = "";
  let partStart = true;
  const finish = (): string | null => {
    if (word === null) return null;
    if (partStart) return "a comma with nothing after it";
    word.parts.push(part);
    segments[segments.length - 1]?.push(word);
    word = null;
    part = "";
    partStart = true;
    return null;
  };
  for (let index = 0; index < text.length; ) {
    const char = text[index] ?? "";
    if (char === " " || char === "\t") {
      const error = finish();
      if (error !== null) return { reason: error };
      index += 1;
      continue;
    }
    if (char === "|") {
      const error = finish();
      if (error !== null) return { reason: error };
      segments.push([]);
      index += 1;
      continue;
    }
    if (char === "&" && word === null && segments.length === 1 && segments[0]?.length === 0 && !call) {
      if (text[index + 1] !== " ") return { reason: "a call operator without a space" };
      call = true;
      index += 1;
      continue;
    }
    if (word === null && text.startsWith("2>&1", index) && /^(?:\s|\||$)/.test(text.slice(index + 4))) {
      segments[segments.length - 1]?.push({ value: "2>&1", parts: ["2>&1"], quoted: false });
      index += 4;
      continue;
    }
    if (char === "'" || char === '"') {
      // `--name='value'` is one argument; any other quote inside a word is refused.
      if (!partStart && !/^-{1,2}[A-Za-z][A-Za-z0-9-]*=$/.test(part)) return { reason: "a quote inside a word" };
      const read = readQuoted(text, index);
      if ("reason" in read) return read;
      const next = text[read.end];
      if (next !== undefined && next !== " " && next !== "\t" && next !== "|" && next !== ",") {
        return { reason: "a word that goes on after a quoted string" };
      }
      word ??= { value: "", parts: [], quoted: true };
      word.value += read.value;
      part += read.value;
      partStart = false;
      index = read.end;
      continue;
    }
    if (char === ",") {
      if (word === null || partStart) return { reason: "a comma with nothing before it" };
      word.parts.push(part);
      word.value += ",";
      part = "";
      partStart = true;
      index += 1;
      continue;
    }
    if (!BARE.test(char)) return { reason: `the character ${JSON.stringify(char)}` };
    if (char === "@" && partStart) return { reason: "an @ starting a word" };
    word ??= { value: "", parts: [], quoted: false };
    word.value += char;
    part += char;
    partStart = false;
    index += 1;
  }
  const error = finish();
  if (error !== null) return { reason: error };
  return { call, segments };
}

/**
 * Select-String reads files given by -Path, -LiteralPath (or any abbreviation) or a second positional
 * argument. In a pipe it may only filter: its pattern, by -Pattern or as the one positional argument, and
 * these switches and valued parameters, spelled in full.
 */
const SELECT_STRING = {
  valued: ["-pattern", "-context"],
  switches: ["-simplematch", "-casesensitive", "-notmatch", "-allmatches", "-quiet", "-list", "-raw"],
};

function selectStringFilters(args: readonly Word[]): boolean {
  let pattern = false;
  for (let index = 0; index < args.length; index += 1) {
    const word = args[index];
    if (word === undefined) return false;
    const value = word.value.toLowerCase();
    if (!word.quoted && value.startsWith("-")) {
      if (SELECT_STRING.switches.includes(value)) continue;
      if (!SELECT_STRING.valued.includes(value) || args[index + 1] === undefined) return false;
      if (value === "-pattern") {
        if (pattern) return false;
        pattern = true;
      }
      index += 1;
      continue;
    }
    if (pattern) return false;
    pattern = true;
  }
  return true;
}

function parseCommand(text: string): Statement | { reason: string } {
  const tokens = tokenize(text);
  if ("reason" in tokens) return tokens;
  const [first, ...pipes] = tokens.segments;
  if (first === undefined || first.length === 0) return { reason: "an empty command" };
  if (pipes.some((segment) => segment.length === 0)) return { reason: "an empty pipe" };
  if (pipes.length > 1) return { reason: "more than one pipe" };
  const words = [...first];
  if (words.some((word) => word.value === "--%")) return { reason: "the stop-parsing token" };
  // 2>&1 only at the end of the command, before any pipe.
  const redirect = words.findIndex((word) => word.value === "2>&1" && !word.quoted);
  if (redirect !== -1 && redirect !== words.length - 1) return { reason: "a 2>&1 before the end" };
  if (redirect !== -1) words.pop();
  if (words.length === 0) return { reason: "an empty command" };
  for (const segment of pipes) {
    if (segment.some((word) => word.value === "2>&1" && !word.quoted)) return { reason: "a 2>&1 after a pipe" };
  }
  if (!tokens.call && words[0]?.quoted) return { reason: "a quoted string in command position" };
  // A comma list given to a program, not a cmdlet, reaches it as separate arguments; every check here reads words.
  const name = words[0]?.value ?? "";
  const cmdlet = /^[A-Za-z]+-[A-Za-z]+$/.test(name);
  if (!cmdlet && words.some((word) => word.parts.length > 1)) return { reason: "a comma list given to a program" };
  if (words[0]?.value === ".") return { reason: "dot-sourcing" };
  for (const segment of pipes) {
    const [name, ...rest] = segment;
    if (name === undefined || name.quoted || !FORMATTERS.has(name.value.toLowerCase())) {
      return { reason: `a pipe into ${name?.value ?? "nothing"}` };
    }
    if (rest.some((word) => /^-(?:literal)?path$/i.test(word.value))) return { reason: "a pipe that reads a file" };
    if (name.value.toLowerCase() === "select-string" && !selectStringFilters(rest)) return { reason: "a Select-String that may read a file" };
  }
  return { kind: "command", call: tokens.call, words, pipes, text };
}

function parseStatement(text: string): Statement | { reason: string } {
  const env = /^\$env:([A-Za-z_][A-Za-z0-9_]*)\s*=\s*(.+)$/s.exec(text);
  if (env !== null) {
    const raw = (env[2] ?? "").trim();
    if (raw[0] !== "'" && raw[0] !== '"') return { reason: "an $env: value that is not a quoted literal" };
    const read = readQuoted(raw, 0);
    if ("reason" in read) return read;
    if (read.end !== raw.length) return { reason: "an $env: value with more after it" };
    return { kind: "env", name: env[1] ?? "", value: read.value, text };
  }
  if (text.startsWith("$")) return { reason: "a variable" };
  return parseCommand(text);
}

/**
 * The script as statements. An apply_patch envelope is read whole; every other statement ends at a `;`
 * or a newline outside quotes. `masked` is the script with the envelopes' file contents blanked: what
 * the never-auto patterns read, since a file's text is data, not a command (its headers stay).
 */
export function parseScript(script: string): Parsed {
  if (/\r(?!\n)/.test(script)) return { ok: false, reason: "a carriage return" };
  const text = script.replace(/\r\n/g, "\n");
  if (/[^\x20-\x7e\n\t]/.test(text)) return { ok: false, reason: "a character outside printable ASCII" };
  const statements: Statement[] = [];
  let masked = "";
  let index = 0;
  while (index < text.length) {
    const char = text[index];
    if (char === " " || char === "\t" || char === "\n" || char === ";") {
      masked += char;
      index += 1;
      continue;
    }
    const rest = text.slice(index);
    const envelope = /^\$([A-Za-z_][A-Za-z0-9_]*)[ \t]*=[ \t]*@'\n/.exec(rest);
    if (envelope !== null) {
      const variable = envelope[1] ?? "";
      const bodyStart = envelope[0].length;
      const close = rest.indexOf("\n'@", bodyStart - 1);
      if (close === -1) return { ok: false, reason: "an unclosed here-string" };
      const body = rest.slice(bodyStart, close);
      const after = /^\n'@[ \t]*\n[ \t]*& '([^'\n]+)'[ \t]+\$([A-Za-z_][A-Za-z0-9_]*)[ \t]*(?=\n|;|$)/.exec(rest.slice(close));
      if (after === null || after[2] !== variable) return { ok: false, reason: "a here-string that is not an apply_patch envelope" };
      const length = close + after[0].length;
      const statementText = rest.slice(0, length);
      statements.push({ kind: "patch", variable, body, shim: after[1] ?? "", text: statementText });
      const headers = body
        .split("\n")
        .map((line) => (line.startsWith("*** ") ? line : ""))
        .join("\n");
      masked += rest.slice(0, bodyStart) + headers + rest.slice(close, length);
      index += length;
      continue;
    }
    let end = index;
    let quote: string | null = null;
    for (; end < text.length; end += 1) {
      const current = text[end];
      if (quote !== null) {
        if (current === quote) {
          if (text[end + 1] === quote) end += 1;
          else quote = null;
        } else if (quote === '"' && (current === "$" || current === "`")) {
          return { ok: false, reason: `a ${current} inside a double-quoted string` };
        }
        continue;
      }
      if (current === "'" || current === '"') quote = current;
      else if (current === ";" || current === "\n") break;
    }
    if (quote !== null) return { ok: false, reason: "an unclosed quote" };
    const statementText = text.slice(index, end).trim();
    const statement = parseStatement(statementText);
    if ("reason" in statement) return { ok: false, reason: `${statement.reason} in ${JSON.stringify(statementText.slice(0, 80))}` };
    statements.push(statement);
    masked += text.slice(index, end);
    index = end;
  }
  if (statements.length === 0) return { ok: false, reason: "an empty script" };
  return { ok: true, statements, masked };
}

// ---------------------------------------------------------------------------
// Paths (step 3)
// ---------------------------------------------------------------------------

type PathResult = { ok: true; path: string } | { ok: false; reason: string };

/**
 * A path token as an absolute, lowercase, backslashed path: relative ones joined to `base`. Refused with
 * `..`, `~`, `%`, `$`, a wildcard, a UNC or device prefix, a rooted or drive-relative form, a colon past
 * the drive, or a name ending in a dot or space (Windows drops those, so `tools.` would be `tools`).
 */
export function normalizePath(raw: string, base: string): PathResult {
  let path = raw.replace(/\//g, "\\");
  if (path === "") return { ok: false, reason: "an empty path" };
  if (/[~%$*?[\]"<>|]/.test(path) || path.includes("..")) return { ok: false, reason: `the path ${raw}` };
  if (path.startsWith("\\")) return { ok: false, reason: `the rooted or UNC path ${raw}` };
  if (/^[A-Za-z]:/.test(path)) {
    if (!/^[A-Za-z]:\\/.test(path)) return { ok: false, reason: `the drive-relative path ${raw}` };
  } else {
    path = `${base.replace(/\//g, "\\").replace(/\\+$/, "")}\\${path}`;
  }
  if (path.slice(2).includes(":")) return { ok: false, reason: `the path ${raw}` };
  const segments: string[] = [];
  for (const segment of path.slice(3).split("\\")) {
    if (segment === "" || segment === ".") continue;
    if (/[. ]$/.test(segment)) return { ok: false, reason: `the path ${raw}` };
    segments.push(segment);
  }
  return { ok: true, path: `${path.slice(0, 2)}\\${segments.join("\\")}`.toLowerCase().replace(/\\$/, "") };
}

function within(path: string, root: string): boolean {
  const prefix = root.endsWith("\\") ? root : `${root}\\`;
  return path === root || path.startsWith(prefix);
}

function parentOf(path: string): string | null {
  const cut = path.lastIndexOf("\\");
  if (cut <= 2) return path.length > 3 ? `${path.slice(0, 2)}\\` : null;
  return path.slice(0, cut);
}

/** The normalized path with its nearest existing ancestor resolved through `realpath`, so a junction cannot lead out. */
function resolveReal(path: string, realpath: MatchContext["realpath"]): PathResult {
  const rest: string[] = [];
  let current: string | null = path;
  while (current !== null) {
    const real = realpath(current);
    if (real !== null) {
      const resolved = real.replace(/\//g, "\\");
      if (resolved.startsWith("\\\\") || !/^[A-Za-z]:\\?/.test(resolved)) {
        return { ok: false, reason: `the path ${path} resolves to ${resolved}` };
      }
      const joined = [resolved.replace(/\\+$/, ""), ...rest].join("\\");
      return { ok: true, path: joined.toLowerCase() };
    }
    const parent = parentOf(current);
    if (parent === null || parent === current) break;
    rest.unshift(current.slice(parent.length).replace(/^\\/, ""));
    current = parent;
  }
  return { ok: true, path };
}

type Access = "read" | "write";
type PathCheck = { ok: true; path: string } | { ok: false; id: NeverAutoId; reason: string };

/** The permitted roots of one request, resolved. */
class Roots {
  readonly worktree: string;
  readonly writes: string[];
  readonly scratch: string[];
  readonly reads: string[];
  readonly home: string;
  private readonly protectedRoots: string[];
  readonly homeTools: { privacyCheck: string; fmpy: string };
  readonly shim: RegExp;

  constructor(
    private readonly context: MatchContext,
    permits: Permits,
  ) {
    const root = (raw: string): string => {
      const normal = normalizePath(raw, "C:\\");
      if (!normal.ok) return "\u0000unusable";
      const real = resolveReal(normal.path, context.realpath);
      return real.ok ? real.path : "\u0000unusable";
    };
    this.home = root(context.home);
    this.worktree = root(context.worktree);
    this.writes = permits.writeDirs.map((dir) => root(`${context.home}\\${dir.replace(/\//g, "\\")}`));
    this.scratch = permits.scratchDirs.map(root);
    this.reads = permits.readRepos.map(root);
    const user = root(context.userHome);
    this.protectedRoots = [
      `${this.home}\\data\\permissions`,
      `${this.home}\\data\\tools`,
      `${this.home}\\data\\crew-rules.md`,
      `${this.home}\\data\\captain.md`,
      `${this.home}\\agents.md`,
      `${this.home}\\watches`,
      `${user}\\.paseo\\plugins`,
      `${user}\\.codex`,
      `${user}\\.claude`,
      "c:\\windows",
    ];
    this.homeTools = {
      privacyCheck: `${this.home}\\data\\tools\\privacy-check.ps1`,
      fmpy: `${this.home}\\data\\tools\\fmpy.ps1`,
    };
    const shimDir = canon(`${context.userHome}\\.codex\\tmp\\arg0`).replace(/[.*+?^${}()|[\]\\]/g, "\\$&");
    this.shim = new RegExp(`^${shimDir}\\\\codex-arg0[a-z0-9]+\\\\apply_patch\\.bat$`);
  }

  /** A path token resolved against `cwd`. */
  resolve(raw: string, cwd: string): PathResult {
    const normal = normalizePath(raw, cwd);
    if (!normal.ok) return normal;
    return resolveReal(normal.path, this.context.realpath);
  }

  isProtected(path: string): boolean {
    return (
      this.protectedRoots.some((root) => within(path, root)) ||
      /^c:\\program files/.test(path) ||
      path.split("\\").includes("agents.md")
    );
  }

  inAny(path: string, roots: readonly string[]): boolean {
    return roots.some((root) => within(path, root));
  }

  /** A read stays in the worktree, a write or scratch folder, or a read repo; a write in a write or scratch folder. */
  check(raw: string, cwd: string, access: Access, only?: readonly string[]): PathCheck {
    const resolved = this.resolve(raw, cwd);
    if (!resolved.ok) return { ok: false, id: "outside", reason: resolved.reason };
    const path = resolved.path;
    if (access === "write") {
      if (this.isProtected(path)) return { ok: false, id: "outside", reason: `a write into the protected ${path}` };
      if (this.inAny(path, this.reads)) return { ok: false, id: "project-repo", reason: `a write into the read-only repo at ${path}` };
      const allowed = only ?? [...this.writes, ...this.scratch];
      if (!this.inAny(path, allowed)) return { ok: false, id: "outside", reason: `a write to ${path}, outside the permitted folders` };
      return { ok: true, path };
    }
    const allowed = only ?? [this.worktree, ...this.writes, ...this.scratch, ...this.reads];
    if (!this.inAny(path, allowed)) return { ok: false, id: "outside", reason: `a read of ${path}, outside the permitted folders` };
    return { ok: true, path };
  }

  /** Where the request may run: the worktree, a write folder or a scratch folder. */
  cwd(raw: string): PathCheck {
    const resolved = this.resolve(raw, "C:\\");
    if (!resolved.ok || !ABSOLUTE.test(raw)) return { ok: false, id: "outside", reason: `the working folder ${raw}` };
    if (!this.inAny(resolved.path, [this.worktree, ...this.writes, ...this.scratch])) {
      return { ok: false, id: "outside", reason: `the working folder ${resolved.path}, outside the permitted folders` };
    }
    return { ok: true, path: resolved.path };
  }
}

// ---------------------------------------------------------------------------
// Never-auto, per statement (step 5)
// ---------------------------------------------------------------------------

type Hit = { id: NeverAutoId; detail: string };

function commandList(id: NeverAutoId): ReadonlySet<string> {
  return new Set(neverAuto(id).commands);
}
const COMMANDS = {
  destructive: commandList("destructive"),
  outward: commandList("outward"),
  credential: commandList("credential"),
  hardware: commandList("hardware"),
  system: commandList("system"),
};

/** The program a command runs, lowercase: a bare name, or the last part of a path. */
/**
 * The program a command runs, lowercase: `name` as written, `base` its last path part, and `native` that
 * part without a Windows executable suffix (.exe, .com, .bat, .cmd). Every check of which tool runs reads
 * `native`, so no suffix variant of git, gh, curl or npm reaches exec without its own policy.
 */
function programOf(words: readonly Word[]): { name: string; base: string; native: string; path: boolean } {
  const value = (words[0]?.value ?? "").toLowerCase();
  const path = /[\\/]|^[a-z]:/.test(value);
  const base = value.replace(/\//g, "\\").split("\\").pop() ?? value;
  return { name: value, base, native: nativeName(base), path };
}

/** A git command's global options and its subcommand. */
interface GitCommand {
  noOptionalLocks: boolean;
  dir: string | null;
  other: string[];
  sub: string;
  args: Word[];
}

function parseGit(words: readonly Word[]): GitCommand | null {
  const git: GitCommand = { noOptionalLocks: false, dir: null, other: [], sub: "", args: [] };
  let index = 1;
  for (; index < words.length; index += 1) {
    const value = words[index]?.value ?? "";
    if (value === "--no-optional-locks") git.noOptionalLocks = true;
    else if (value === "-C") {
      if (git.dir !== null) return null;
      git.dir = words[index + 1]?.value ?? null;
      if (git.dir === null) return null;
      index += 1;
    } else if (value.startsWith("-")) {
      git.other.push(value);
      if (value === "-c") index += 1;
    } else break;
  }
  git.sub = (words[index]?.value ?? "").toLowerCase();
  git.args = words.slice(index + 1);
  return git;
}

const NPM_INSTALL = new Set(["install", "i", "ci", "add", "isntall", "in"]);
const DANGEROUS_ENV = /^(?:path|pathext|comspec|psmodulepath|node_options|git_.*|npm_config_.*)$/i;

function isNpm(native: string): boolean {
  return native === "npm";
}

function statementHit(statement: Statement, extraHardware: readonly string[] | null): Hit | null {
  if (statement.kind === "env") {
    if (DANGEROUS_ENV.test(statement.name)) return { id: "system", detail: `sets $env:${statement.name}` };
    return null;
  }
  if (statement.kind === "patch") {
    if (/^\*\*\* (?:Delete File|Move to)/m.test(statement.body)) return { id: "destructive", detail: "an apply_patch delete or move" };
    return null;
  }
  const words = statement.words;
  const program = programOf(words);
  const values = words.map((word) => word.value.toLowerCase());
  const lower = (index: number) => values[index] ?? "";
  // A native program by path or with an executable suffix is the same program: rm.exe is rm.
  const native = program.native;
  for (const [id, names] of Object.entries(COMMANDS) as Array<[keyof typeof COMMANDS, ReadonlySet<string>]>) {
    if (names.has(program.name) || names.has(program.base) || names.has(native)) return { id, detail: `runs ${program.base}` };
  }
  // The private supplement's hardware names, as any word: bare, with .exe, by path, or run through another program.
  if (extraHardware !== null) {
    const listed = words.flatMap((word) => word.parts).find((part) => extraHardware.includes(nativeName(part)));
    if (listed !== undefined) return { id: "hardware", detail: "a hardware tool the never-auto supplement names" };
  }
  // destructive
  const newDirectory =
    program.name === "new-item" && values.some((value, index) => value === "-itemtype" && lower(index + 1) === "directory");
  if (!newDirectory && values.some((value) => value === "-force" || value.startsWith("-force:"))) {
    return { id: "destructive", detail: `-Force on ${program.base}` };
  }
  if (values.some((value) => value === "--force" || value === "--force-with-lease" || value.startsWith("--force"))) {
    return { id: "destructive", detail: `--force on ${program.base}` };
  }
  if (program.native === "git") {
    const git = parseGit(words);
    if (git === null) return null;
    const args = git.args.map((word) => word.value);
    const destructive =
      ["reset", "clean", "restore", "rm"].includes(git.sub) ||
      (git.sub === "checkout" && args.some((arg) => arg === "--" || arg === "-f")) ||
      (git.sub === "branch" && args.some((arg) => ["-d", "-D", "--delete", "-f", "-M"].includes(arg))) ||
      (git.sub === "stash" && ["drop", "clear"].includes(args[0] ?? "")) ||
      (git.sub === "worktree" && ["remove", "prune"].includes(args[0] ?? ""));
    if (destructive) return { id: "destructive", detail: `git ${git.sub}` };
    if (["push", "remote", "send-email"].includes(git.sub)) return { id: "outward", detail: `git ${git.sub}` };
  }
  if (program.native === "gh") {
    const sub = lower(1);
    if (sub === "api") {
      // -X and -f/-F take their value attached too (-XPOST, -ftitle=x).
      const writes = values.slice(2).some((value) => /^-[xf]|^(?:--method|--field|--raw-field|--input)(?:=|$)/.test(value));
      if (writes) return { id: "outward", detail: "gh api with a method or fields" };
    } else if (!(sub === "pr" && lower(2) === "view")) {
      return { id: "outward", detail: `gh ${sub}` };
    }
  }
  if (program.native === "curl") {
    const writes = words
      .slice(1)
      // Short options bundle and take their value attached: -dvalue, -XPOST, -fLd value.
      .some((word) => /^-[A-Za-z]*[XdFT]|^(?:--request|--data[\w-]*|--form[\w-]*|--upload-file|--json)(?:=|$)/.test(word.value));
    if (writes) return { id: "outward", detail: "curl with a method or data" };
  }
  if (["invoke-restmethod", "irm", "invoke-webrequest", "iwr"].includes(program.name)) {
    if (values.some((value) => /^-(?:method|body|infile|form)$/.test(value))) return { id: "outward", detail: `${program.name} with a method or body` };
  }
  if (isNpm(program.native)) {
    if (lower(1) === "publish") return { id: "outward", detail: "npm publish" };
    if (values.includes("-g") || values.includes("--global")) return { id: "system", detail: "a global npm command" };
    if (NPM_INSTALL.has(lower(1)) && !values.includes("--ignore-scripts")) return { id: "system", detail: "npm install without --ignore-scripts" };
  }
  // system
  if (program.native === "pwsh") {
    if (!(lower(1) === "-noprofile" && lower(2) === "-file" && words.length >= 4)) return { id: "system", detail: "a nested pwsh" };
  }
  if (program.native === "uv") {
    if (lower(1) === "tool" || lower(1) === "pip") return { id: "system", detail: `uv ${lower(1)}` };
  }
  if (/^python3?$/.test(program.native) && values.some((value, index) => value === "-m" && lower(index + 1) === "pip")) {
    return { id: "system", detail: "python -m pip" };
  }
  return null;
}

/** The first never-auto pattern hit in `text`, in list order. */
export function patternHit(text: string): Hit | null {
  for (const entry of NEVER_AUTO) {
    for (const pattern of entry.patterns) {
      const found = pattern.exec(text);
      if (found !== null) return { id: entry.id, detail: `matches ${pattern.source.slice(0, 60)} at ${JSON.stringify(found[0].trim().slice(0, 40))}` };
    }
  }
  return null;
}

// ---------------------------------------------------------------------------
// Rules (step 4)
// ---------------------------------------------------------------------------

type RuleName =
  | "notes-write"
  | "local-read"
  | "net-read"
  | "git-local"
  | "git-read"
  | "home-tool"
  | "exec"
  | "package";

type StatementResult =
  | { ok: true; rule: RuleName | "env"; tier: 0 | 1 | 2; detail: string }
  | { ok: false; rule: string; detail: string };

const TIER: Record<RuleName, 1 | 2> = {
  "notes-write": 1,
  "local-read": 1,
  "net-read": 1,
  "git-local": 1,
  "git-read": 1,
  "home-tool": 1,
  exec: 2,
  package: 2,
};

function allow(rule: RuleName, detail: string): StatementResult {
  return { ok: true, rule, tier: TIER[rule], detail };
}
function refuse(id: NeverAutoId, detail: string): StatementResult {
  return { ok: false, rule: `never:${id}`, detail };
}
function noRule(detail: string): StatementResult {
  return { ok: false, rule: "no-rule", detail };
}

/** A cmdlet's named parameters, exactly as spelled (case-insensitive); null when anything else is there. */
function cmdletParams(
  words: readonly Word[],
  valued: readonly string[],
  switches: readonly string[],
): Map<string, Word | true> | null {
  const params = new Map<string, Word | true>();
  for (let index = 1; index < words.length; index += 1) {
    const word = words[index];
    if (word === undefined || word.quoted || !word.value.startsWith("-")) return null;
    const name = word.value.toLowerCase();
    if (params.has(name)) return null;
    if (switches.includes(name)) params.set(name, true);
    else if (valued.includes(name)) {
      const value = words[index + 1];
      if (value === undefined || (!value.quoted && value.value.startsWith("-"))) return null;
      params.set(name, value);
      index += 1;
    } else return null;
  }
  return params;
}

function valueOf(params: Map<string, Word | true>, name: string): Word | null {
  const value = params.get(name);
  return value === undefined || value === true ? null : value;
}

interface RuleContext {
  roots: Roots;
  permits: Permits;
  extraHardware: readonly string[] | null;
  cwd: string;
  cwdRaw: string;
}

/** Each path in `paths` checked; the first refusal, or the paths. */
function checkAll(rc: RuleContext, paths: readonly string[], access: Access, only?: readonly string[]): { ok: true; paths: string[] } | { ok: false; result: StatementResult } {
  const out: string[] = [];
  for (const raw of paths) {
    const checked = rc.roots.check(raw, rc.cwdRaw, access, only);
    if (!checked.ok) return { ok: false, result: refuse(checked.id, checked.reason) };
    out.push(checked.path);
  }
  return { ok: true, paths: out };
}

function notesWrite(rc: RuleContext, statement: Extract<Statement, { kind: "command" }>): StatementResult | null {
  const name = statement.words[0]?.value.toLowerCase() ?? "";
  const words = statement.words;
  if (name === "new-item") {
    const params = cmdletParams(words, ["-itemtype", "-path"], ["-force", "-whatif"]);
    const path = params === null ? null : valueOf(params, "-path");
    if (params === null || path === null || valueOf(params, "-itemtype")?.value.toLowerCase() !== "directory") {
      return noRule("New-Item other than -ItemType Directory -Path");
    }
    const checked = checkAll(rc, path.parts, "write");
    return checked.ok ? allow("notes-write", `New-Item into ${checked.paths.join(", ")}`) : checked.result;
  }
  if (name === "copy-item") {
    const params = cmdletParams(words, ["-literalpath", "-destination"], ["-whatif"]);
    const sources = params === null ? null : valueOf(params, "-literalpath");
    const destination = params === null ? null : valueOf(params, "-destination");
    if (sources === null || destination === null || destination.parts.length !== 1) {
      return noRule("Copy-Item other than -LiteralPath -Destination");
    }
    const read = checkAll(rc, sources.parts, "read");
    if (!read.ok) return read.result;
    const write = checkAll(rc, destination.parts, "write");
    return write.ok ? allow("notes-write", `Copy-Item into ${write.paths.join(", ")}`) : write.result;
  }
  if (name === "expand-archive") {
    const params = cmdletParams(words, ["-literalpath", "-destinationpath"], ["-whatif"]);
    const source = params === null ? null : valueOf(params, "-literalpath");
    const destination = params === null ? null : valueOf(params, "-destinationpath");
    if (source === null || destination === null || source.parts.length !== 1 || destination.parts.length !== 1) {
      return noRule("Expand-Archive other than -LiteralPath -DestinationPath");
    }
    const read = checkAll(rc, source.parts, "read");
    if (!read.ok) return read.result;
    const write = checkAll(rc, destination.parts, "write");
    return write.ok ? allow("notes-write", `Expand-Archive into ${write.paths.join(", ")}`) : write.result;
  }
  return null;
}

function applyPatch(rc: RuleContext, statement: Extract<Statement, { kind: "patch" }>): StatementResult {
  if (!rc.roots.shim.test(canon(statement.shim))) return refuse("outside", `the apply_patch shim ${statement.shim}`);
  const lines = statement.body.split("\n");
  if (lines[0] !== "*** Begin Patch" || lines[lines.length - 1] !== "*** End Patch") return refuse("unparsed", "an apply_patch body without Begin and End");
  const targets: string[] = [];
  for (const line of lines.slice(1, -1)) {
    if (!line.startsWith("*** ")) continue;
    const header = /^\*\*\* (Add File|Update File): (.+)$/.exec(line);
    if (header !== null) targets.push((header[2] ?? "").trim());
    else if (line !== "*** End of File") return refuse("unparsed", `the apply_patch header ${line.slice(0, 60)}`);
  }
  if (targets.length === 0) return refuse("unparsed", "an apply_patch with no file");
  const checked = checkAll(rc, targets, "write");
  return checked.ok ? allow("notes-write", `apply_patch into ${checked.paths.join(", ")}`) : checked.result;
}

/**
 * The local-read cmdlets and every parameter they may carry. Beyond -LiteralPath and -Path (spec 3.5),
 * the read-only switches -Raw, -Tail, -TotalCount, -Encoding, -Recurse, -File, -Directory, -Name, -Depth
 * and -PathType are accepted by the spec amendment of 2026-10-09.
 */
export const LOCAL_READ_FORMS: Readonly<Record<string, { valued: string[]; switches: string[] }>> = {
  "get-content": { valued: ["-literalpath", "-path", "-tail", "-totalcount", "-encoding"], switches: ["-raw"] },
  "get-item": { valued: ["-literalpath", "-path"], switches: [] },
  "get-childitem": { valued: ["-literalpath", "-path", "-depth"], switches: ["-recurse", "-file", "-directory", "-name"] },
  "test-path": { valued: ["-literalpath", "-path", "-pathtype"], switches: [] },
};

function localRead(rc: RuleContext, statement: Extract<Statement, { kind: "command" }>): StatementResult | null {
  const name = statement.words[0]?.value.toLowerCase() ?? "";
  const form = LOCAL_READ_FORMS[name];
  if (form === undefined) return null;
  const params = cmdletParams(statement.words, form.valued, form.switches);
  if (params === null) return noRule(`${name} with other parameters`);
  for (const numeric of ["-tail", "-totalcount", "-depth"]) {
    const value = valueOf(params, numeric);
    if (value !== null && !/^\d{1,6}$/.test(value.value)) return noRule(`${name} ${numeric} ${value.value}`);
  }
  const encoding = valueOf(params, "-encoding");
  if (encoding !== null && !/^[A-Za-z0-9-]+$/.test(encoding.value)) return noRule("an odd -Encoding");
  const pathType = valueOf(params, "-pathtype");
  if (pathType !== null && !/^(?:leaf|container|any)$/i.test(pathType.value)) return noRule("an odd -PathType");
  const paths = [valueOf(params, "-literalpath"), valueOf(params, "-path")].filter((word): word is Word => word !== null);
  if (paths.length !== 1) return noRule(`${name} needs one -LiteralPath or -Path`);
  const checked = checkAll(rc, paths[0]?.parts ?? [], "read");
  return checked.ok ? allow("local-read", `${name} of ${checked.paths.join(", ")}`) : checked.result;
}

function githubPair(pair: string, permits: Permits): boolean {
  return permits.netRead.githubRepos.some((listed) => listed.toLowerCase() === pair.toLowerCase());
}

function hostOf(url: string, permits: Permits): string | null {
  const parsed = /^https:\/\/([A-Za-z0-9.-]+)(?:\/[A-Za-z0-9._~\-/?=&%+,]*)?$/.exec(url);
  if (parsed === null || url.includes("..")) return null;
  const host = (parsed[1] ?? "").toLowerCase();
  return permits.netRead.hosts.some((listed) => listed.toLowerCase() === host) ? host : null;
}

/** Network programs by native name; only net-read may allow them. */
const NETWORK = new Set(["curl", "wget", "invoke-restmethod", "irm", "invoke-webrequest", "iwr", "start-bitstransfer", "gh"]);

function netRead(rc: RuleContext, statement: Extract<Statement, { kind: "command" }>): StatementResult {
  const words = statement.words;
  const values = words.map((word) => word.value);
  const program = programOf(words);
  const permits = rc.permits;
  if (program.native === "gh") {
    if (values[1] === "api") {
      let path: string | null = null;
      for (let index = 2; index < values.length; index += 1) {
        const value = values[index] ?? "";
        if (value === "--paginate") continue;
        if (value === "-H" && /^Accept:/i.test(values[index + 1] ?? "")) {
          index += 1;
          continue;
        }
        if (value === "--jq" && values[index + 1] !== undefined) {
          index += 1;
          continue;
        }
        if (value.startsWith("-") || path !== null) return refuse("non-get", `gh api with ${value}`);
        path = value;
      }
      const parsed = path === null ? null : /^\/?repos\/([A-Za-z0-9-]+)\/([A-Za-z0-9._-]+)(?:[/?][A-Za-z0-9._\-/?=&%,+]*)?$/.exec(path);
      if (parsed === null || path?.includes("..")) return refuse("non-get", `gh api ${path ?? ""}`);
      const pair = `${parsed[1]}/${parsed[2]}`;
      if (!githubPair(pair, permits)) return refuse("non-get", `gh api on ${pair}, not listed`);
      return allow("net-read", `gh api ${pair}`);
    }
    // gh pr view <n|url> [--repo o/r] [--json fields]
    let target: string | null = null;
    let repo: string | null = null;
    for (let index = 3; index < values.length; index += 1) {
      const value = values[index] ?? "";
      if (value === "--repo" && repo === null && values[index + 1] !== undefined) {
        repo = values[index + 1] ?? null;
        index += 1;
      } else if (value === "--json" && /^[A-Za-z,]+$/.test(values[index + 1] ?? "")) {
        index += 1;
      } else if (!value.startsWith("-") && target === null) {
        target = value;
      } else return refuse("non-get", `gh pr view with ${value}`);
    }
    const url = target === null ? null : /^https:\/\/github\.com\/([A-Za-z0-9-]+\/[A-Za-z0-9._-]+)\/pull\/\d+$/.exec(target);
    const pair = url !== null ? (url[1] ?? null) : repo;
    if (target === null || (url === null && !/^\d+$/.test(target))) return refuse("non-get", "gh pr view of no pull request");
    if (pair === null) return refuse("non-get", "gh pr view without --repo");
    if (repo !== null && url !== null && repo.toLowerCase() !== pair.toLowerCase()) return refuse("non-get", "gh pr view of two repos");
    if (!githubPair(pair, permits)) return refuse("non-get", `gh pr view on ${pair}, not listed`);
    return allow("net-read", `gh pr view on ${pair}`);
  }
  if (program.base === "curl.exe") {
    let flags = 0;
    let url: string | null = null;
    let output: string | null = null;
    for (let index = 1; index < values.length; index += 1) {
      const value = values[index] ?? "";
      if (/^-fL[sS]{0,2}$/.test(value)) flags += 1;
      else if (value === "-o" && output === null && values[index + 1] !== undefined) {
        output = values[index + 1] ?? null;
        index += 1;
      } else if (/^https:\/\//.test(value) && url === null) url = value;
      else return refuse("non-get", `curl with ${value}`);
    }
    if (flags !== 1 || url === null || output === null) return refuse("non-get", "curl other than -fL <url> -o <scratch>");
    const host = hostOf(url, permits);
    if (host === null) return refuse("non-get", "curl to a host not listed");
    const checked = checkAll(rc, [output], "write", rc.roots.scratch);
    return checked.ok ? allow("net-read", `curl from ${host} into ${checked.paths[0]}`) : checked.result;
  }
  if (program.name === "invoke-restmethod") {
    if (words.length !== 3 || values[1]?.toLowerCase() !== "-uri") return refuse("non-get", "Invoke-RestMethod with other parameters");
    const host = hostOf(values[2] ?? "", permits);
    return host === null ? refuse("non-get", "Invoke-RestMethod to a host not listed") : allow("net-read", `Invoke-RestMethod from ${host}`);
  }
  return refuse("non-get", `${program.base} is not one of the read-only network forms`);
}

function gitClone(rc: RuleContext, git: GitCommand): StatementResult {
  const args = git.args.map((word) => word.value);
  let index = 0;
  if (args[index] !== "--depth" || args[index + 1] !== "1") return refuse("non-get", "git clone without --depth 1");
  index += 2;
  if (args[index] === "--branch") {
    if (!/^[A-Za-z0-9][A-Za-z0-9._/-]*$/.test(args[index + 1] ?? "") || (args[index + 1] ?? "").includes("..")) {
      return refuse("non-get", "git clone --branch with an odd ref");
    }
    index += 2;
  }
  const url = /^https:\/\/github\.com\/([A-Za-z0-9-]+\/[A-Za-z0-9._-]+?)\.git$/.exec(args[index] ?? "");
  const destination = args[index + 1];
  if (url === null || destination === undefined || args.length !== index + 2 || git.dir !== null || git.other.length > 0) {
    return refuse("non-get", "git clone other than --depth 1 https://github.com/<o>/<r>.git <scratch>");
  }
  if (!githubPair(url[1] ?? "", rc.permits)) return refuse("non-get", `git clone of ${url[1]}, not listed`);
  const checked = checkAll(rc, [destination], "write", rc.roots.scratch);
  return checked.ok ? allow("net-read", `git clone of ${url[1]} into ${checked.paths[0]}`) : checked.result;
}

const READ_VERBS = new Set(["log", "diff", "show", "rev-parse", "status"]);

/** A read-only git verb's arguments: no output file, external diff, text conversion or no-index read; path tokens inside `root`. */
function gitReadArgs(rc: RuleContext, git: GitCommand, root: string, base: string): StatementResult | null {
  for (const word of git.args) {
    const value = word.value;
    if (/^(?:--output|-o$|--ext-diff|--textconv|--no-index|--exec)/.test(value)) return refuse("project-repo", `git ${git.sub} ${value}`);
    if (value.includes("\\") || /^[A-Za-z]:/.test(value)) {
      const checked = rc.roots.check(value, base, "read", [root]);
      if (!checked.ok) return refuse(checked.id, checked.reason);
    }
  }
  return null;
}

function gitRule(rc: RuleContext, statement: Extract<Statement, { kind: "command" }>): StatementResult {
  const git = parseGit(statement.words);
  if (git === null) return refuse("unparsed", "a git command with a lone -C");
  if (git.other.some((option) => /^--(?:git-dir|work-tree)/.test(option))) return refuse("project-repo", "git with --git-dir or --work-tree");
  if (["fetch", "pull", "ls-remote", "submodule"].includes(git.sub)) return refuse("non-get", `git ${git.sub}`);
  if (git.sub === "clone") return gitClone(rc, git);
  const roots = rc.roots;
  if (git.dir !== null) {
    const dir = roots.resolve(git.dir, rc.cwdRaw);
    if (!dir.ok) return refuse("outside", dir.reason);
    if (dir.path === roots.worktree) return noRule("git -C on the own worktree");
    const repo = roots.reads.find((root) => within(dir.path, root));
    if (repo === undefined) return refuse("project-repo", `git -C ${dir.path}, not a repo the permits name`);
    if (!git.noOptionalLocks || git.other.length > 0) return refuse("project-repo", "git -C without --no-optional-locks alone");
    if (READ_VERBS.has(git.sub)) {
      const bad = gitReadArgs(rc, git, repo, git.dir);
      return bad ?? allow("git-read", `git ${git.sub} in ${repo}`);
    }
    if (git.sub === "archive") {
      let output: string | null = null;
      let rev: string | null = null;
      const args = git.args.map((word) => word.value);
      for (let index = 0; index < args.length; index += 1) {
        const value = args[index] ?? "";
        if (/^--format=(?:zip|tar)$/.test(value)) continue;
        if (value === "-o" && output === null && args[index + 1] !== undefined) {
          output = args[index + 1] ?? null;
          index += 1;
        } else if (value.startsWith("--output=") && output === null) output = value.slice("--output=".length);
        else if (!value.startsWith("-") && rev === null && /^[A-Za-z0-9._/~^-]+$/.test(value) && !value.includes("..")) rev = value;
        else return refuse("project-repo", `git archive with ${value}`);
      }
      if (output === null || rev === null) return refuse("project-repo", "git archive without a rev and -o");
      const checked = checkAll(rc, [output], "write");
      return checked.ok ? allow("git-read", `git archive of ${repo} into ${checked.paths[0]}`) : checked.result;
    }
    return refuse("project-repo", `git ${git.sub} in the read-only ${repo}`);
  }
  if (rc.cwd !== roots.worktree) {
    if (within(rc.cwd, roots.worktree)) return noRule("git in a folder of the worktree, not its root");
    return refuse("project-repo", `git in ${rc.cwd}, not the agent's worktree`);
  }
  if (!rc.permits.gitLocal) return noRule("git in the worktree, and the permits do not allow it");
  const args = git.args.map((word) => word.value);
  if (git.noOptionalLocks && git.other.length === 0 && READ_VERBS.has(git.sub)) {
    const bad = gitReadArgs(rc, git, roots.worktree, rc.cwdRaw);
    return bad ?? allow("git-local", `git ${git.sub}`);
  }
  if (git.other.length > 0 || git.noOptionalLocks) return noRule(`git ${git.other.join(" ")} ${git.sub}`);
  if (git.sub === "add") {
    const rest = args[0] === "--dry-run" ? args.slice(1) : args;
    if (rest[0] !== "--" || rest.length < 2) return noRule("git add other than [--dry-run] -- <paths>");
    const checked = checkAll(rc, rest.slice(1), "read", [roots.worktree]);
    return checked.ok ? allow("git-local", `git add ${rest.length - 1} path(s)`) : checked.result;
  }
  if (git.sub === "commit") {
    const rest = args[0] === "--dry-run" ? args.slice(1) : args;
    if (rest.length !== 2 || rest[0] !== "-m") return noRule("git commit other than [--dry-run] -m '<message>'");
    return allow("git-local", "git commit");
  }
  if (git.sub === "branch") {
    const ref = /^[A-Za-z0-9][A-Za-z0-9._/-]*$/;
    const rev = /^[A-Za-z0-9][A-Za-z0-9._/~^-]*$/;
    if (args.length < 1 || args.length > 2 || !ref.test(args[0] ?? "") || (args[1] !== undefined && !rev.test(args[1]))) {
      return noRule("git branch other than <name> [<rev>]");
    }
    if (args.some((arg) => arg.includes(".."))) return noRule("git branch with ..");
    return allow("git-local", `git branch ${args[0]}`);
  }
  return noRule(`git ${git.sub}`);
}

function homeTool(rc: RuleContext, script: Word, args: readonly Word[]): StatementResult | null {
  const path = rc.roots.resolve(script.value, rc.cwdRaw);
  if (!path.ok || path.path !== rc.roots.homeTools.privacyCheck) return null;
  if (args.length !== 2) return noRule("privacy-check.ps1 with other arguments");
  const [target, ref] = args;
  const checked = checkAll(rc, [target?.value ?? ""], "read", [rc.roots.worktree, ...rc.roots.reads]);
  if (!checked.ok) return checked.result;
  if (!/^[A-Za-z0-9._/-]+$/.test(ref?.value ?? "") || (ref?.value ?? "").includes("..")) return noRule("privacy-check.ps1 with an odd ref");
  return allow("home-tool", `privacy-check of ${checked.paths[0]}`);
}

/** Whether a word is a path token; for `name=value` forms the value is. */
function pathPart(value: string): { path: string } | { url: true } | { attached: true } | null {
  const assigned = /^[^=\\/:]*=(.*)$/.exec(value);
  const candidate = assigned !== null ? (assigned[1] ?? "") : value;
  if (/^[A-Za-z][A-Za-z0-9+.-]*:\/\//.test(candidate)) return { url: true };
  if (!(candidate.includes("\\") || candidate.includes("/") || /^[A-Za-z]:/.test(candidate))) return null;
  if (assigned === null && value.startsWith("-")) return { attached: true };
  return { path: candidate };
}

/**
 * An exec prefix token matches its word exactly: flags, module names and values keep their case. The one
 * exception is an absolute path, which names the same file in any case and with either slash.
 */
function prefixToken(token: string, word: string | undefined): boolean {
  if (word === undefined) return false;
  return ABSOLUTE.test(token) ? canon(token) === canon(word) : token === word;
}

function execRule(rc: RuleContext, statement: Extract<Statement, { kind: "command" }>): StatementResult {
  const words = statement.words;
  const roots = rc.roots;
  const toolPaths = [roots.homeTools.fmpy, roots.homeTools.privacyCheck];
  if (rc.extraHardware === null) return refuse("hardware", "the never-auto supplement is missing or invalid, so no exec statement is allowed");
  let refusal: StatementResult | null = null;
  for (const entry of rc.permits.exec) {
    if (entry.prefix.length > words.length) continue;
    if (!entry.prefix.every((token, index) => prefixToken(token, words[index]?.value))) continue;
    const place = entry.in === "scratch" ? roots.scratch : entry.in === "worktree" ? [roots.worktree] : roots.writes;
    if (!roots.inAny(rc.cwd, place)) {
      refusal ??= noRule(`exec ${entry.prefix.join(" ")} outside its ${entry.in} folder`);
      continue;
    }
    // A program named by path, in the prefix or not, runs from the roots or is one of the home tools.
    const result = ((): StatementResult | null => {
      for (const [index, word] of words.entries()) {
        const kind = pathPart(word.value);
        if (kind === null) continue;
        if ("url" in kind) return refuse("non-get", `exec with the address ${word.value.slice(0, 60)}`);
        if ("attached" in kind) return refuse("outside", `exec with the option ${word.value.slice(0, 60)}`);
        const resolved = roots.resolve(kind.path, rc.cwdRaw);
        if (index < entry.prefix.length && resolved.ok && toolPaths.includes(resolved.path)) continue;
        const checked = roots.check(kind.path, rc.cwdRaw, "write", [roots.worktree, ...roots.writes, ...roots.scratch]);
        if (!checked.ok) return refuse(checked.id, checked.reason);
      }
      return null;
    })();
    if (result !== null) return result;
    return allow("exec", `exec ${entry.prefix.join(" ")} in ${entry.in}`);
  }
  return refusal ?? noRule(`no rule for ${programOf(words).base}`);
}

function packageRule(rc: RuleContext, statement: Extract<Statement, { kind: "command" }>): StatementResult {
  const values = statement.words.map((word) => word.value);
  if (!rc.permits.netRead.hosts.some((host) => host.toLowerCase() === "registry.npmjs.org")) {
    return noRule("npm install, and the permits do not list registry.npmjs.org");
  }
  if (programOf(statement.words).base !== "npm.cmd" || values[1] !== "install") return noRule("npm other than npm.cmd install");
  if (!rc.roots.inAny(rc.cwd, rc.roots.scratch)) return noRule("npm install outside a scratch folder");
  const seen = new Set<string>();
  const packages: string[] = [];
  let cache: string | null = null;
  for (let index = 2; index < values.length; index += 1) {
    const value = values[index] ?? "";
    if (["--no-save", "--package-lock=false", "--ignore-scripts"].includes(value)) {
      if (seen.has(value)) return noRule(`npm install with ${value} twice`);
      seen.add(value);
    } else if (value === "--cache" && cache === null && values[index + 1] !== undefined) {
      cache = values[index + 1] ?? null;
      index += 1;
    } else if (/^(?:@[a-z0-9-~][a-z0-9-._~]*\/)?[a-z0-9-~][a-z0-9-._~]*@\d+\.\d+\.\d+(?:-[0-9A-Za-z.-]+)?$/.test(value)) {
      packages.push(value);
    } else return noRule(`npm install with ${value}`);
  }
  if (seen.size !== 3 || cache === null || packages.length === 0) return noRule("npm install without its pinned form");
  const checked = checkAll(rc, [cache], "write", rc.roots.scratch);
  return checked.ok ? allow("package", `npm install ${packages.join(" ")}`) : checked.result;
}


function ruleFor(rc: RuleContext, statement: Statement): StatementResult {
  if (statement.kind === "env") {
    if (!rc.permits.envNames.some((name) => name.toLowerCase() === statement.name.toLowerCase())) {
      return noRule(`$env:${statement.name} is not a permitted name`);
    }
    if (/^(?:uv_cache_dir|temp|tmp)$/i.test(statement.name)) {
      const checked = checkAll(rc, [statement.value], "write", rc.roots.scratch);
      if (!checked.ok) return checked.result;
    }
    return { ok: true, rule: "env", tier: 0, detail: `$env:${statement.name}` };
  }
  if (statement.kind === "patch") return applyPatch(rc, statement);
  const words = statement.words;
  const program = programOf(words);
  // A program named by path is a home tool, or runs from the roots under an exec prefix; nothing else.
  if (program.path) {
    const first = words[0];
    if (first !== undefined) {
      const home = homeTool(rc, first, words.slice(1));
      if (home !== null) return home;
    }
    const resolved = rc.roots.resolve(program.name, rc.cwdRaw);
    const inRoots = resolved.ok && rc.roots.inAny(resolved.path, [rc.roots.worktree, ...rc.roots.writes, ...rc.roots.scratch]);
    if (!inRoots) return refuse("outside", `runs ${program.name}, outside the permitted folders`);
    // A git, gh, curl or npm install from the roots answers to its own policy first, then runs as exec.
    const own =
      program.native === "git"
        ? gitRule(rc, statement)
        : NETWORK.has(program.native)
          ? netRead(rc, statement)
          : isNpm(program.native) && NPM_INSTALL.has((words[1]?.value ?? "").toLowerCase())
            ? packageRule(rc, statement)
            : null;
    if (own !== null && !own.ok) return own;
    return execRule(rc, statement);
  }
  if (program.native === "git") return gitRule(rc, statement);
  if (NETWORK.has(program.native)) return netRead(rc, statement);
  if (isNpm(program.native) && NPM_INSTALL.has((words[1]?.value ?? "").toLowerCase())) return packageRule(rc, statement);
  if (program.native === "pwsh") {
    const tool = words[3];
    if (tool !== undefined) {
      const home = homeTool(rc, tool, words.slice(4));
      if (home !== null) return home;
    }
    return execRule(rc, statement);
  }
  if (statement.call) return refuse("unparsed", "a call of a bare name");
  return notesWrite(rc, statement) ?? localRead(rc, statement) ?? execRule(rc, statement);
}

// ---------------------------------------------------------------------------
// match
// ---------------------------------------------------------------------------

/**
 * The broker's answer to one request: `allow` only when the agent is crew with a valid task, the request
 * is a Codex command approval, the agent is not sticky, nothing on the never-auto list is hit, the
 * permits file is valid for the task, every statement matches an allow rule, and the agent is under the
 * hourly allow cap. Anything else relays.
 */
export function match(request: PermitRequest, permitsRaw: unknown, context: MatchContext): MatchResult {
  if (!context.crew) return never("not-crew", "the agent has no crew label");
  if (context.task === null) return never("not-crew", "the agent has no task label");
  if (!taskIdOk(context.task)) return never("not-crew", `the task id ${JSON.stringify(context.task.slice(0, 80))} is reserved or not a slug`);
  if (request.provider !== "codex" || request.name !== "CodexBash" || request.kind !== "tool") {
    return never("not-v1", `${request.provider} ${request.name} ${request.kind}`);
  }
  if (context.sticky) return never("after-refusal", "the agent is sticky after a refusal");
  const input = (typeof request.input === "object" && request.input !== null ? request.input : {}) as Record<string, unknown>;
  const command = input.command;
  const cwdRaw = input.cwd;
  if (typeof command !== "string" || typeof cwdRaw !== "string") return never("unparsed", "no command line and working folder");

  const script = unwrapCommand(command, context.userHome);
  const parsed = script === null ? null : parseScript(script);
  // The working folder too: a credential or device in its path is as telling as in the command.
  const patternText = `${parsed?.ok === true ? parsed.masked : (script ?? stripShell(command))}\n${cwdRaw}`;
  const raw = patternHit(patternText);
  if (raw !== null) return never(raw.id, raw.detail);
  if (script === null) return never("unparsed", "not exactly \"<pwsh>\" -Command '<script>'");
  if (parsed === null || !parsed.ok) return never("unparsed", parsed?.reason ?? "unparsed");
  for (const statement of parsed.statements) {
    const hit = statementHit(statement, context.extraHardware);
    if (hit !== null) return never(hit.id, hit.detail);
  }

  if (permitsRaw === undefined) return never("no-permits", "no permits file");
  const permits = parsePermits(permitsRaw);
  if (permits === null) return never("no-permits", "the permits file is invalid");
  if (permits.task !== context.task) return never("no-permits", "the permits file is for another task");
  if (context.mode === "live" && !permits.live) return never("no-permits", "the permits file is not live");

  const roots = new Roots(context, permits);
  const cwd = roots.cwd(cwdRaw);
  if (!cwd.ok) return never(cwd.id, cwd.reason);
  const rc: RuleContext = { roots, permits, extraHardware: context.extraHardware, cwd: cwd.path, cwdRaw };
  const results = parsed.statements.map((statement) => ruleFor(rc, statement));
  const refused = results.find((result) => !result.ok && result.rule.startsWith("never:")) ?? results.find((result) => !result.ok);
  if (refused !== undefined && !refused.ok) {
    return { verdict: "relay", rule: refused.rule, tier: null, detail: refused.detail };
  }
  const allowed = results.filter((result): result is Extract<StatementResult, { ok: true }> => result.ok && result.rule !== "env");
  if (allowed.length === 0) return { verdict: "relay", rule: "no-rule", tier: null, detail: "only $env: assignments" };
  if (context.allowsLastHour >= MAX_ALLOWS_PER_HOUR) {
    return never("rate", `${context.allowsLastHour} automatic allows in the last hour`);
  }
  const rule = [...new Set(allowed.map((result) => result.rule))].join("+");
  const tier = allowed.some((result) => result.tier === 2) ? 2 : 1;
  return { verdict: "allow", rule, tier, detail: allowed.map((result) => result.detail).join("; ") };
}
