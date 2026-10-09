import { describe, expect, it } from "vitest";

import {
  match,
  normalizePath,
  parsePermits,
  parseScript,
  unwrapCommand,
  type MatchContext,
  type MatchResult,
  type Permits,
  type PermitRequest,
} from "./permit-match";
import { MAX_ALLOWS_PER_HOUR, NEVER_AUTO, type NeverAutoCase } from "./permit-rules";

// A synthetic machine: every path, name and repository here is made up.
const USER = "C:\\Home\\example";
const HOME = `${USER}\\.paseo\\plugin-data\\firstmate\\home`;
const TASK = "demo-01-example";
const WORKTREE = `${USER}\\.paseo\\worktrees\\abc123\\demo-01-example`;
const NOTES = `${HOME}\\data\\demo-01-example`;
const REVIEW = `${HOME}\\data\\demo-02-reviewed`;
const SCRATCH = `${USER}\\AppData\\Local\\Temp\\fm-demo-01`;
const REPO = `${USER}\\.paseo\\worktrees\\def456\\demo-02-reviewed`;
const SHIM = `${USER}\\.codex\\tmp\\arg0\\codex-arg0Ab12\\apply_patch.bat`;
const PWSH = "C:\\Program Files\\PowerShell\\7\\pwsh.exe";
const OUTSIDE = "C:\\Outside\\place";

const PLACES: Record<string, string> = {
  "<worktree>": WORKTREE,
  "<home>": HOME,
  "<notes>": NOTES,
  "<review>": REVIEW,
  "<scratch>": SCRATCH,
  "<repo>": REPO,
  "<user>": USER,
  "<shim>": SHIM,
};

function fill(text: string): string {
  return text.replace(/<(?:worktree|home|notes|review|scratch|repo|user|shim)>/g, (place) => PLACES[place] ?? place);
}

/** Folders that exist, and junctions: `<root>\jx` in every root leads to a folder outside. */
const DIRS = new Set(
  [
    "C:\\",
    "C:\\Home",
    USER,
    `${USER}\\.paseo`,
    `${USER}\\.paseo\\plugin-data`,
    `${USER}\\.paseo\\plugin-data\\firstmate`,
    HOME,
    `${HOME}\\data`,
    `${HOME}\\data\\tools`,
    `${HOME}\\data\\permissions`,
    NOTES,
    REVIEW,
    `${USER}\\.paseo\\worktrees`,
    `${USER}\\.paseo\\worktrees\\abc123`,
    WORKTREE,
    `${USER}\\.paseo\\worktrees\\def456`,
    REPO,
    `${USER}\\AppData`,
    `${USER}\\AppData\\Local`,
    `${USER}\\AppData\\Local\\Temp`,
    SCRATCH,
    `${USER}\\.codex`,
    "C:\\Windows",
    "C:\\Outside",
    OUTSIDE,
  ].map((dir) => dir.toLowerCase()),
);
const JUNCTIONS = new Map([NOTES, REVIEW, SCRATCH, WORKTREE, REPO].map((root) => [`${root}\\jx`.toLowerCase(), OUTSIDE]));

function realpath(path: string): string | null {
  const lower = path.toLowerCase();
  for (const [link, target] of JUNCTIONS) {
    if (lower === link || lower.startsWith(`${link}\\`)) {
      const rest = path.slice(link.length);
      return DIRS.has(`${target}${rest}`.toLowerCase()) ? `${target}${rest}` : null;
    }
  }
  return DIRS.has(lower) || /^[a-z]:\\?$/.test(lower) ? path : null;
}

const BASE_EXEC: Permits["exec"] = [
  { in: "scratch", prefix: ["uv", "run", "--offline", "--no-project", "python"] },
  { in: "scratch", prefix: ["npm.cmd", "test"] },
  { in: "notes", prefix: ["node"] },
  { in: "worktree", prefix: ["uv", "run", "--offline", "--project", "tools/check", "python", "-X", "utf8", "-B", "-m", "unittest"] },
  { in: "notes", prefix: ["pwsh", "-NoProfile", "-File", `${HOME}\\data\\tools\\fmpy.ps1`] },
];

function permits(overrides: Partial<Permits> = {}): Permits {
  return {
    version: 1,
    task: TASK,
    live: true,
    writeDirs: ["data/demo-01-example", "data/demo-02-reviewed"],
    scratchDirs: [SCRATCH],
    readRepos: [REPO],
    netRead: { githubRepos: ["octo/example"], hosts: ["registry.npmjs.org", "registry.example.org"] },
    gitLocal: true,
    exec: BASE_EXEC,
    envNames: ["PYTHONUTF8", "PYTHONDONTWRITEBYTECODE", "UV_OFFLINE", "UV_CACHE_DIR"],
    ...overrides,
  };
}

/** Every root, every exec prefix the base has, and an exec entry in every place for the first word of each statement of `script`. */
function maximal(script = ""): Permits {
  const firsts = script
    .split(/[;\n]/)
    .map((statement) => statement.trim().replace(/^& /, "").split(/\s+/)[0]?.replace(/^'|'$/g, "") ?? "")
    .filter((word) => word !== "" && !word.startsWith("$"));
  const extra = firsts.flatMap((word) => (["scratch", "worktree", "notes"] as const).map((place) => ({ in: place, prefix: [word] })));
  return permits({ live: true, exec: [...BASE_EXEC, ...extra] });
}

function wrap(script: string): string {
  return `"${PWSH}" -Command '${script.replace(/'/g, "''")}'`;
}

function request(script: string, cwd = WORKTREE, overrides: Partial<PermitRequest> = {}): PermitRequest {
  return { provider: "codex", name: "CodexBash", kind: "tool", input: { command: wrap(fill(script)), cwd: fill(cwd) }, ...overrides };
}

function context(overrides: Partial<MatchContext> = {}): MatchContext {
  return {
    crew: true,
    task: TASK,
    mode: "shadow",
    home: HOME,
    userHome: USER,
    worktree: WORKTREE,
    sticky: false,
    allowsLastHour: 0,
    realpath,
    extraHardware: [],
    ...overrides,
  };
}

function run(script: string, cwd = WORKTREE, file: unknown = permits(), ctx: Partial<MatchContext> = {}): MatchResult {
  return match(request(script, cwd), file, context(ctx));
}

// ---------------------------------------------------------------------------
// Allowed fixtures: at least one per answerable class of evidence.md
// ---------------------------------------------------------------------------

interface Fixture {
  name: string;
  cls: string;
  script: string;
  cwd?: string;
  rule: string;
  tier: 1 | 2;
  /** A target path in the script, and the root it lies in, for the path mutations. */
  target?: string;
  root?: string;
  /** A host or repository pair in the script, for the host mutation. */
  host?: string;
}

const PATCH = (header: string) => `$reviewPatch = @'
*** Begin Patch
${header}
+# Review round 1
+No blocking findings.
*** End Patch
'@
& '<shim>' $reviewPatch`;

const ALLOWED: Fixture[] = [
  {
    name: "New-Item a folder in the notes",
    cls: "notes write",
    script: "New-Item -ItemType Directory -Force -Path '<notes>\\review-scratch-1'",
    rule: "notes-write",
    tier: 1,
    target: "<notes>\\review-scratch-1",
    root: "<notes>",
  },
  {
    name: "Copy-Item a report into the reviewed ticket's folder",
    cls: "notes write",
    script: "Copy-Item -LiteralPath '<worktree>\\report.md' -Destination '<review>\\review-1.md'",
    rule: "notes-write",
    tier: 1,
    target: "<review>\\review-1.md",
    root: "<review>",
  },
  {
    name: "Expand-Archive from scratch into the notes",
    cls: "notes write",
    script: "Expand-Archive -LiteralPath '<scratch>\\head.zip' -DestinationPath '<notes>\\head'",
    rule: "notes-write",
    tier: 1,
    target: "<notes>\\head",
    root: "<notes>",
  },
  {
    name: "apply_patch adds a review file",
    cls: "notes write",
    script: PATCH("*** Add File: <notes>/review-1.md"),
    rule: "notes-write",
    tier: 1,
    target: "<notes>/review-1.md",
    root: "<notes>",
  },
  {
    name: "apply_patch updates a scratch file",
    cls: "notes write",
    script: PATCH("*** Update File: <scratch>/plan.md\n@@\n-old line"),
    rule: "notes-write",
    tier: 1,
    target: "<scratch>/plan.md",
    root: "<scratch>",
  },
  {
    name: "New-Item with -WhatIf",
    cls: "dry run",
    script: "New-Item -ItemType Directory -Path '<notes>\\a','<notes>\\b' -WhatIf",
    rule: "notes-write",
    tier: 1,
    target: "<notes>\\b",
    root: "<notes>",
  },
  {
    name: "Get-Content of the brief, piped into Select-Object",
    cls: "local read",
    script: "Get-Content -LiteralPath '<notes>\\authority.md' -Raw | Select-Object -First 20",
    rule: "local-read",
    tier: 1,
    target: "<notes>\\authority.md",
    root: "<notes>",
  },
  {
    name: "Test-Path in the read repo",
    cls: "local read",
    script: "Test-Path -LiteralPath '<repo>\\README.md'",
    rule: "local-read",
    tier: 1,
    target: "<repo>\\README.md",
    root: "<repo>",
  },
  {
    name: "gh api GET on a listed repo",
    cls: "public read-only network",
    script: "gh api repos/octo/example/pulls/7 --jq '.head.sha'",
    rule: "net-read",
    tier: 1,
    host: "octo/example",
  },
  {
    name: "gh pr view on a listed repo",
    cls: "public read-only network",
    script: "gh pr view https://github.com/octo/example/pull/7 --json 'title,state'",
    rule: "net-read",
    tier: 1,
    host: "octo/example",
  },
  {
    name: "curl from a listed host into scratch",
    cls: "public read-only network",
    script: "curl.exe -fLsS https://registry.npmjs.org/left-pad -o '<scratch>\\left-pad.json'",
    rule: "net-read",
    tier: 1,
    target: "<scratch>\\left-pad.json",
    root: "<scratch>",
    host: "registry.npmjs.org",
  },
  {
    name: "Invoke-RestMethod from a listed host",
    cls: "public read-only network",
    script: "Invoke-RestMethod -Uri 'https://registry.example.org/v1/info'",
    rule: "net-read",
    tier: 1,
    host: "registry.example.org",
  },
  {
    name: "a shallow public clone into scratch",
    cls: "public read-only network",
    script: "git clone --depth 1 https://github.com/octo/example.git '<scratch>\\example'",
    cwd: "<scratch>",
    rule: "net-read",
    tier: 1,
    target: "<scratch>\\example",
    root: "<scratch>",
    host: "octo/example",
  },
  {
    name: "git add in the own worktree",
    cls: "git in own worktree",
    script: "git add -- '<worktree>\\server\\parser.ts'",
    rule: "git-local",
    tier: 1,
    target: "<worktree>\\server\\parser.ts",
    root: "<worktree>",
  },
  { name: "git commit", cls: "git in own worktree", script: "git commit -m 'Add the parser'", rule: "git-local", tier: 1 },
  { name: "git branch", cls: "git in own worktree", script: "git branch demo-topic HEAD", rule: "git-local", tier: 1 },
  {
    name: "git status in the own worktree",
    cls: "git in own worktree",
    script: "git --no-optional-locks status --short",
    rule: "git-local",
    tier: 1,
  },
  {
    name: "a scratch run with env names",
    cls: "scratch runs",
    script:
      "$env:PYTHONUTF8='1'; $env:UV_CACHE_DIR='<scratch>\\uv-cache'; uv run --offline --no-project python '<scratch>\\probe.py' --out '<scratch>\\out.json'",
    cwd: "<scratch>",
    rule: "exec",
    tier: 2,
    target: "<scratch>\\out.json",
    root: "<scratch>",
  },
  { name: "npm test in scratch", cls: "scratch runs", script: "npm.cmd test", cwd: "<scratch>", rule: "exec", tier: 2 },
  {
    name: "node in a notes scratch folder",
    cls: "scratch runs",
    script: "node '<notes>\\review-scratch-1\\check.js'",
    cwd: "<notes>\\review-scratch-1",
    rule: "exec",
    tier: 2,
    target: "<notes>\\review-scratch-1\\check.js",
    root: "<notes>",
  },
  {
    name: "unit tests in the own worktree",
    cls: "tests in own worktree",
    script: "uv run --offline --project tools/check python -X utf8 -B -m unittest discover",
    rule: "exec",
    tier: 2,
  },
  {
    name: "privacy-check through pwsh -File",
    cls: "home tools",
    script: "pwsh -NoProfile -File '<home>\\data\\tools\\privacy-check.ps1' '<repo>' origin/main",
    rule: "home-tool",
    tier: 1,
    target: "<repo>",
    root: "<repo>",
  },
  {
    name: "privacy-check through the call operator",
    cls: "home tools",
    script: "& '<home>\\data\\tools\\privacy-check.ps1' '<worktree>' origin/main",
    rule: "home-tool",
    tier: 1,
    target: "<worktree>",
    root: "<worktree>",
  },
  {
    name: "fmpy as an exec prefix",
    cls: "home tools",
    script: "pwsh -NoProfile -File '<home>\\data\\tools\\fmpy.ps1' '<notes>\\calc.py'",
    cwd: "<notes>",
    rule: "exec",
    tier: 2,
    target: "<notes>\\calc.py",
    root: "<notes>",
  },
  {
    name: "a pinned npm install into scratch",
    cls: "package installs",
    script: "npm.cmd install left-pad@1.3.0 --no-save --package-lock=false --ignore-scripts --cache '<scratch>\\npm-cache'",
    cwd: "<scratch>",
    rule: "package",
    tier: 2,
    target: "<scratch>\\npm-cache",
    root: "<scratch>",
  },
  {
    name: "git log in the reviewed worktree",
    cls: "git reads on another worktree",
    script: "git --no-optional-locks -C '<repo>' log --oneline -5",
    rule: "git-read",
    tier: 1,
    target: "<repo>",
    root: "<repo>",
  },
  {
    name: "git archive of the reviewed worktree into the notes",
    cls: "git archive",
    script: "git --no-optional-locks -C '<repo>' archive --format=zip HEAD -o '<notes>\\head.zip'",
    rule: "git-read",
    tier: 1,
    target: "<notes>\\head.zip",
    root: "<notes>",
  },
  {
    name: "two notes writes chained",
    cls: "notes write",
    script: "New-Item -ItemType Directory -Path '<notes>\\r2'; Copy-Item -LiteralPath '<worktree>\\a.md' -Destination '<notes>\\r2\\a.md'",
    rule: "notes-write",
    tier: 1,
    target: "<notes>\\r2\\a.md",
    root: "<notes>",
  },
];

/** The classes evidence.md never answers, each with a synthetic case. */
const FORBIDDEN_CLASSES: Array<{ cls: string; script: string; cwd?: string; rule: string }> = [
  { cls: "hardware", script: "& '<scratch>\\STM32_Programmer_CLI.exe' -c port=SWD -w '<scratch>\\fw.bin'", rule: "never:hardware" },
  { cls: "WSL builds and tests", script: "wsl.exe -d Ubuntu --exec cmake --build build", rule: "never:hardware" },
  { cls: "destructive", script: "git reset --hard origin/main", rule: "never:destructive" },
  { cls: "other", script: "1..6 | ForEach-Object { Get-Date }", rule: "never:unparsed" },
];

const EVIDENCE_CLASSES = [
  "notes write",
  "dry run",
  "local read",
  "public read-only network",
  "git in own worktree",
  "scratch runs",
  "tests in own worktree",
  "home tools",
  "package installs",
  "git reads on another worktree",
  "git archive",
  "hardware",
  "WSL builds and tests",
  "destructive",
  "other",
];

describe("fixtures", () => {
  it("cover every class of evidence.md", () => {
    const covered = new Set([...ALLOWED.map((fixture) => fixture.cls), ...FORBIDDEN_CLASSES.map((fixture) => fixture.cls)]);
    expect(EVIDENCE_CLASSES.filter((cls) => !covered.has(cls))).toEqual([]);
  });

  it.each(ALLOWED.map((fixture) => [fixture.name, fixture] as const))("allows: %s", (_name, fixture) => {
    const result = run(fixture.script, fixture.cwd ?? "<worktree>");
    expect(result).toMatchObject({ verdict: "allow", rule: fixture.rule, tier: fixture.tier });
  });

  it.each(FORBIDDEN_CLASSES.map((fixture) => [fixture.cls, fixture] as const))("relays the %s class under maximal permits", (_cls, fixture) => {
    const result = run(fixture.script, fixture.cwd ?? "<worktree>", maximal(fill(fixture.script)));
    expect(result).toMatchObject({ verdict: "relay", rule: fixture.rule });
  });
});

// ---------------------------------------------------------------------------
// 1. The never-auto table
// ---------------------------------------------------------------------------

const DEFAULT_SCRIPT = "New-Item -ItemType Directory -Path '<notes>\\x'";

function runCase(entry: (typeof NEVER_AUTO)[number], testCase: NeverAutoCase): MatchResult {
  const script = fill(testCase.script ?? DEFAULT_SCRIPT);
  let req = request(script, testCase.cwd ?? "<worktree>");
  let file: unknown = maximal(script);
  const ctx: Partial<MatchContext> = {};
  switch (testCase.context) {
    case "no-crew-label":
      ctx.crew = false;
      break;
    case "no-task-label":
      ctx.task = null;
      break;
    case "reserved-task":
      ctx.task = "permissions";
      file = { ...maximal(script), task: "permissions" };
      break;
    case "unsafe-task":
      ctx.task = "..\\tools";
      file = { ...maximal(script), task: "..\\tools" };
      break;
    case "no-permits-file":
      file = undefined;
      break;
    case "invalid-permits":
      file = { ...maximal(script), writeDirs: ["data/../tools"] };
      break;
    case "other-task-permits":
      file = { ...maximal(script), task: "demo-03-sibling" };
      break;
    case "live-false-in-live":
      ctx.mode = "live";
      file = { ...maximal(script), live: false };
      break;
    case "provider-claude":
      req = { ...req, provider: "claude", name: "Bash" };
      break;
    case "file-change":
      req = { ...req, name: "CodexFileChange", input: { reason: "edit a file" } };
      break;
    case "question":
      req = { ...req, name: "request_user_input", kind: "question" };
      break;
    case "sticky":
      ctx.sticky = true;
      break;
    case "rate-limit":
      ctx.allowsLastHour = MAX_ALLOWS_PER_HOUR;
      break;
    case "rate-limit-far":
      ctx.allowsLastHour = MAX_ALLOWS_PER_HOUR * 4;
      break;
    case "command-array":
      req = { ...req, input: { command: ["pwsh.exe", "-Command", script], cwd: WORKTREE } };
      break;
    case undefined:
      break;
  }
  void entry;
  return match(req, file, context(ctx));
}

describe("the never-auto list", () => {
  it("has at least three cases for every id, each with a reason", () => {
    for (const entry of NEVER_AUTO) {
      expect(entry.cases.length, entry.id).toBeGreaterThanOrEqual(3);
      expect(entry.reason, entry.id).not.toBe("");
    }
  });

  const cases = NEVER_AUTO.flatMap((entry) => entry.cases.map((testCase, index) => [`${entry.id} #${index + 1}`, entry, testCase] as const));
  it.each(cases)("relays %s with its id under maximal permits", (_label, entry, testCase) => {
    const result = runCase(entry, testCase);
    expect(result.verdict).toBe("relay");
    expect(result.rule).toBe(`never:${entry.id}`);
  });

  it("would allow each context case's script if the context did not stop it", () => {
    for (const entry of NEVER_AUTO) {
      for (const testCase of entry.cases) {
        if (testCase.context === undefined || testCase.context === "command-array") continue;
        const script = testCase.script ?? DEFAULT_SCRIPT;
        expect(run(script, testCase.cwd ?? "<worktree>", maximal(fill(script))).verdict, `${entry.id} ${script}`).toBe("allow");
      }
    }
  });
});

// ---------------------------------------------------------------------------
// 2. Mutations of every allowed fixture
// ---------------------------------------------------------------------------

type Mutation = { name: string; applies: (fixture: Fixture) => boolean; mutate: (fixture: Fixture) => { script: string; overrides?: Partial<PermitRequest> } };

const every = () => true;
const appendTo = (suffix: string) => (fixture: Fixture) => ({ script: `${fixture.script}${suffix}` });
const retarget = (to: (fixture: Fixture) => string) => (fixture: Fixture) => ({
  script: fixture.script.split(fixture.target ?? "").join(to(fixture)),
});
const hasTarget = (fixture: Fixture) => fixture.target !== undefined && fixture.root !== undefined;
const isPatch = (fixture: Fixture) => fixture.script.includes("*** Begin Patch");
const quote = (script: string) => script.replace(/'/g, "''");

const MUTATIONS: Mutation[] = [
  { name: "append ; Remove-Item x", applies: every, mutate: appendTo("; Remove-Item x") },
  { name: "append | Out-File x", applies: every, mutate: appendTo(" | Out-File x") },
  { name: "append && git push", applies: every, mutate: appendTo(" && git push") },
  {
    name: "insert ..\\..\\ into a target",
    applies: hasTarget,
    mutate: retarget((fixture) => (fixture.target ?? "").replace(fixture.root ?? "", `${fixture.root}\\..\\..`)),
  },
  {
    name: "point a target at a sibling task folder",
    applies: hasTarget,
    mutate: retarget((fixture) => (fixture.target ?? "").replace(fixture.root ?? "", "<home>\\data\\demo-03-sibling")),
  },
  {
    name: "point a target at data\\permissions",
    applies: hasTarget,
    mutate: retarget((fixture) => (fixture.target ?? "").replace(fixture.root ?? "", "<home>\\data\\permissions\\permits")),
  },
  {
    name: "point a target at data\\tools",
    applies: hasTarget,
    mutate: retarget((fixture) => (fixture.target ?? "").replace(fixture.root ?? "", "<home>\\data\\tools")),
  },
  { name: "add -X POST", applies: every, mutate: appendTo(" -X POST") },
  {
    name: "change the host",
    applies: (fixture) => fixture.host !== undefined,
    mutate: (fixture) => ({
      script: fixture.script.split(fixture.host ?? "").join((fixture.host ?? "").includes("/") ? "octo/unlisted" : "evil.example.net"),
    }),
  },
  { name: "add $(...)", applies: every, mutate: appendTo(" $(Get-Date)") },
  { name: "add a backtick", applies: every, mutate: appendTo(" `n") },
  { name: "add --force", applies: every, mutate: appendTo(" --force") },
  { name: "add a credential word", applies: every, mutate: appendTo(" secret") },
  { name: "wrap in cmd /c", applies: every, mutate: (fixture) => ({ script: `cmd /c "${fixture.script}"` }) },
  {
    name: "use Start-Process",
    applies: every,
    mutate: (fixture) => ({ script: `Start-Process pwsh -ArgumentList '-Command', '${quote(fixture.script)}'` }),
  },
  { name: "use Invoke-Expression", applies: every, mutate: (fixture) => ({ script: `Invoke-Expression '${quote(fixture.script)}'` }) },
  {
    name: "replace the apply_patch shim path",
    applies: isPatch,
    mutate: (fixture) => ({ script: fixture.script.replace("<shim>", "<scratch>\\apply_patch.bat") }),
  },
  {
    name: "add a *** Delete File header",
    applies: isPatch,
    mutate: (fixture) => ({ script: fixture.script.replace("*** Begin Patch\n", "*** Begin Patch\n*** Delete File: <notes>/old.md\n") }),
  },
  {
    name: "add a *** Move to header",
    applies: isPatch,
    mutate: (fixture) => ({
      script: fixture.script.replace("*** Begin Patch\n", "*** Begin Patch\n*** Update File: <notes>/a.md\n*** Move to: <notes>/b.md\n"),
    }),
  },
  {
    name: "use a junction out of a root",
    applies: hasTarget,
    mutate: retarget((fixture) => (fixture.target ?? "").replace(fixture.root ?? "", `${fixture.root}\\jx`)),
  },
  { name: "switch the provider to claude", applies: every, mutate: (fixture) => ({ script: fixture.script, overrides: { provider: "claude" } }) },
  { name: "switch the kind to question", applies: every, mutate: (fixture) => ({ script: fixture.script, overrides: { kind: "question" } }) },
];

describe("mutations of every allowed fixture", () => {
  const pairs = ALLOWED.flatMap((fixture) =>
    MUTATIONS.filter((mutation) => mutation.applies(fixture)).map((mutation) => [`${fixture.name} / ${mutation.name}`, fixture, mutation] as const),
  );

  it("cover every mutation of the spec", () => {
    for (const mutation of MUTATIONS) expect(pairs.some(([, , applied]) => applied === mutation), mutation.name).toBe(true);
  });

  it.each(pairs)("relays %s", (_label, fixture, mutation) => {
    const { script, overrides } = mutation.mutate(fixture);
    const result = match(request(script, fixture.cwd ?? "<worktree>", overrides), permits(), context());
    expect(result.verdict, `${result.rule}: ${result.detail}`).toBe("relay");
  });
});

// ---------------------------------------------------------------------------
// 3. Property test: random statement sequences
// ---------------------------------------------------------------------------

function mulberry32(seed: number): () => number {
  let state = seed >>> 0;
  return () => {
    state = (state + 0x6d2b79f5) >>> 0;
    let t = state;
    t = Math.imul(t ^ (t >>> 15), t | 1);
    t ^= t + Math.imul(t ^ (t >>> 7), t | 61);
    return ((t ^ (t >>> 14)) >>> 0) / 4294967296;
  };
}

const ALLOWED_STATEMENTS = [
  "New-Item -ItemType Directory -Path '<notes>\\p1'",
  "Copy-Item -LiteralPath '<worktree>\\a.md' -Destination '<notes>\\a.md'",
  "Get-Content -LiteralPath '<notes>\\brief.md'",
  "gh api repos/octo/example/pulls --paginate",
  "git --no-optional-locks status --short",
  "git add -- README.md",
  "git commit -m 'Update the notes'",
  "$env:PYTHONUTF8='1'",
  "uv run --offline --project tools/check python -X utf8 -B -m unittest discover",
  "& '<home>\\data\\tools\\privacy-check.ps1' '<worktree>' origin/main",
  "Test-Path -LiteralPath '<repo>\\README.md'",
  "git --no-optional-locks -C '<repo>' diff HEAD~1",
];

/** Forbidden anywhere; these only as a command (as an argument they name a file). */
const COMMAND_ONLY_TOKENS = ["rm x", "del x", "paseo ls"];
const FORBIDDEN_TOKENS = [
  "Remove-Item x",
  "git push",
  "git reset --hard",
  "cmd /c dir",
  "Start-Process x",
  "iex x",
  "wsl.exe -l",
  "Get-PnpDevice",
  "Stop-Process -Id 1",
  "gh pr create",
  "$(Get-Date)",
  "`n",
  "> out.txt",
  "| Out-File x",
  "&& git push",
  "{ x }",
  "@(1)",
  "--force",
  "token",
  "..\\..\\x",
  "COM3",
  "secret",
  "C:\\Windows\\x",
  "-EncodedCommand x",
];

describe("random statement sequences", () => {
  it("relay whenever they hold a forbidden token, and allow otherwise (10 000 seeded)", () => {
    const random = mulberry32(20261009);
    const pick = <T,>(items: readonly T[]): T => items[Math.floor(random() * items.length)] as T;
    let forbidden = 0;
    const failures: string[] = [];
    for (let round = 0; round < 10_000; round += 1) {
      const statements = Array.from({ length: 1 + Math.floor(random() * 4) }, () => pick(ALLOWED_STATEMENTS));
      // Not only $env: lines: a script of assignments alone is relayed with no rule.
      if (statements.every((statement) => statement.startsWith("$env:"))) statements.push(ALLOWED_STATEMENTS[0] ?? "");
      const injected = random() < 0.5;
      if (injected) {
        forbidden += 1;
        const commandOnly = random() < 0.1;
        const token = commandOnly ? pick(COMMAND_ONLY_TOKENS) : pick(FORBIDDEN_TOKENS);
        const at = Math.floor(random() * statements.length);
        const mode = commandOnly ? 0 : Math.floor(random() * 3);
        const target = statements[at] ?? "";
        if (mode === 0) statements.splice(at, 0, token);
        else if (mode === 1 || !target.includes(" ")) statements[at] = `${target} ${token}`;
        else statements[at] = target.replace(" ", ` ${token} `);
      }
      const script = statements.join(random() < 0.5 ? "; " : "\n");
      const result = run(script);
      if (result.verdict !== (injected ? "relay" : "allow")) failures.push(`${result.verdict} ${result.rule}: ${script}`);
    }
    expect(forbidden).toBeGreaterThan(4000);
    expect(failures.slice(0, 5)).toEqual([]);
  }, 60_000);
});

// ---------------------------------------------------------------------------
// The parts
// ---------------------------------------------------------------------------

describe("unwrapping the command line", () => {
  it("takes the script from either pwsh location, with doubled quotes undone", () => {
    expect(unwrapCommand(`"${PWSH}" -Command 'git commit -m ''x'''`, USER)).toBe("git commit -m 'x'");
    expect(unwrapCommand(`"${USER}\\AppData\\Local\\Microsoft\\WindowsApps\\pwsh.exe" -Command 'Get-Date'`, USER)).toBe("Get-Date");
  });

  it("takes -NoProfile -Command too, which only runs less", () => {
    expect(unwrapCommand(`"${PWSH}" -NoProfile -Command 'Get-Date'`, USER)).toBe("Get-Date");
    expect(unwrapCommand(`"${PWSH}" -NoProfile -ExecutionPolicy Bypass -Command 'Get-Date'`, USER)).toBeNull();
  });

  it("never counts the wrapper itself against a line it cannot unwrap: unparsed, not system", () => {
    const line = `"${PWSH}" -NoLogo -NoProfile -Command 'git --no-optional-locks status'`;
    expect(match({ ...request("x"), input: { command: line, cwd: WORKTREE } }, permits(), context()).rule).toBe("never:unparsed");
  });

  it("refuses any other shape", () => {
    expect(unwrapCommand(`"C:\\Tools\\pwsh.exe" -Command 'Get-Date'`, USER)).toBeNull();
    expect(unwrapCommand(`"${PWSH}" -Command 'a' ; rm x '`, USER)).toBeNull();
    expect(unwrapCommand(`"${PWSH}" -c 'Get-Date'`, USER)).toBeNull();
    expect(unwrapCommand(`${PWSH} -Command 'Get-Date'`, USER)).toBeNull();
    expect(run("Get-Date", "<worktree>").rule).not.toBe("never:unparsed");
    expect(match({ ...request("x"), input: { command: "pwsh -Command 'Get-Date'", cwd: WORKTREE } }, permits(), context()).rule).toBe("never:unparsed");
  });
});

describe("the statement grammar", () => {
  it("reads quoted strings, comma lists, 2>&1 at the end and pipes into formatters", () => {
    const parsed = parseScript("git --no-optional-locks log -3 2>&1 | Select-Object -First 3; New-Item -ItemType Directory -Path 'a','b'");
    expect(parsed.ok).toBe(true);
    if (!parsed.ok) return;
    expect(parsed.statements).toHaveLength(2);
    const second = parsed.statements[1];
    expect(second?.kind === "command" && second.words[4]?.parts).toEqual(["a", "b"]);
  });

  it.each([
    ["a smart quote", "Get-Content -LiteralPath \u2018x\u2019"],
    ["a comment", "Get-Date # note"],
    ["a subexpression", "Get-Date $(x)"],
    ["a variable", "Get-Content $path"],
    ["a script block", "Get-Date { }"],
    ["a redirection", "Get-Date > x"],
    ["2>&1 before the end", "Get-Date 2>&1 -Format x"],
    ["a word that goes on after a quote", "Get-Content -LiteralPath 'a'b"],
    ["the stop-parsing token", "git --% log"],
    ["dot-sourcing", ". x.ps1"],
    ["a quoted command name", "'git' log"],
    ["a lone carriage return", "Get-Date\rRemove-Item x"],
    ["a pipe into a writer", "Get-Date | Set-Content x"],
    ["two pipes", "git log | Sort-Object | Select-Object -First 3"],
    ["a here-string that is not an envelope", "$x = @'\nhello\n'@\nWrite-Output $x"],
  ])("refuses %s", (_name, script) => {
    expect(parseScript(script).ok).toBe(false);
  });
});

describe("paths", () => {
  it("are normalized, joined to the working folder and folded", () => {
    expect(normalizePath("sub/File.txt", "C:\\Work")).toEqual({ ok: true, path: "c:\\work\\sub\\file.txt" });
    expect(normalizePath("C:/Work/./a", "C:\\x")).toEqual({ ok: true, path: "c:\\work\\a" });
  });

  it.each(["..\\x", "a\\..\\b", "~\\x", "%TEMP%\\x", "$HOME", "a*", "a?", "a[1]", "\\\\server\\share", "\\\\?\\C:\\x", "\\Windows", "C:x", "C:\\a:b", "C:\\tools.\\x", "C:\\tools \\x"])(
    "refuse %s",
    (raw) => {
      expect(normalizePath(raw, "C:\\Work").ok).toBe(false);
    },
  );

  it("follow a junction to where it really leads", () => {
    expect(run("New-Item -ItemType Directory -Path '<notes>\\jx\\a'")).toMatchObject({ verdict: "relay", rule: "never:outside" });
  });

  it("match roots on folder boundaries only", () => {
    expect(run(`New-Item -ItemType Directory -Path '${NOTES}-evil\\a'`)).toMatchObject({ verdict: "relay", rule: "never:outside" });
  });
});

describe("the permits file", () => {
  it("parses the spec's example shape", () => {
    expect(parsePermits(JSON.parse(JSON.stringify(permits())))).toEqual(permits());
  });

  it.each([
    ["a writeDir outside data/", { writeDirs: ["notes"] }],
    ["a writeDir that is data/ itself", { writeDirs: ["data"] }],
    ["a writeDir with ..", { writeDirs: ["data/../x"] }],
    ["a relative scratch dir", { scratchDirs: ["Temp\\x"] }],
    ["an exec entry with no prefix", { exec: [{ in: "scratch", prefix: [] }] }],
    ["an exec entry in an unknown place", { exec: [{ in: "home", prefix: ["node"] }] }],
    ["a bad repo pair", { netRead: { githubRepos: ["octo"], hosts: [] } }],
    ["live as a string", { live: "yes" }],
    ["another version", { version: 2 }],
  ])("is invalid with %s", (_name, change) => {
    expect(parsePermits({ ...permits(), ...change })).toBeNull();
  });

  it("enables tier 2 and git-read only when it lists them", () => {
    const bare = permits({ exec: [], readRepos: [], netRead: { githubRepos: [], hosts: [] }, gitLocal: false });
    expect(run("uv run --offline --no-project python '<scratch>\\probe.py'", "<scratch>", bare).rule).toBe("no-rule");
    expect(run("git --no-optional-locks -C '<repo>' log -1", "<worktree>", bare).rule).toBe("never:project-repo");
    expect(run("npm.cmd install left-pad@1.3.0 --no-save --package-lock=false --ignore-scripts --cache '<scratch>\\c'", "<scratch>", bare).rule).toBe("no-rule");
    expect(run("git commit -m 'x'", "<worktree>", bare).rule).toBe("no-rule");
    expect(run("gh api repos/octo/example/pulls", "<worktree>", bare).rule).toBe("never:non-get");
  });
});

describe("rule details", () => {
  it("relays a statement no rule knows", () => {
    expect(run("Get-Date")).toMatchObject({ verdict: "relay", rule: "no-rule" });
  });

  it("relays an env name the permits do not list, and a cache dir outside scratch", () => {
    expect(run("$env:FOO='1'; npm.cmd test", "<scratch>")).toMatchObject({ verdict: "relay", rule: "no-rule" });
    expect(run("$env:UV_CACHE_DIR='C:\\Outside\\cache'; npm.cmd test", "<scratch>")).toMatchObject({ verdict: "relay", rule: "never:outside" });
  });

  it("relays an exec prefix used outside its place", () => {
    expect(run("npm.cmd test", "<worktree>")).toMatchObject({ verdict: "relay", rule: "no-rule" });
  });

  it("relays an exec argument that is an address, or an option with a path attached", () => {
    expect(run("npm.cmd test https://example.org/x", "<scratch>")).toMatchObject({ rule: "never:non-get" });
    expect(run("npm.cmd test -o\\Windows\\x", "<scratch>")).toMatchObject({ rule: "never:outside" });
    expect(run("npm.cmd test --out=\\Windows\\x", "<scratch>")).toMatchObject({ rule: "never:outside" });
  });

  it("names the tier: 2 when any statement runs code", () => {
    expect(run("$env:PYTHONUTF8='1'; uv run --offline --no-project python '<scratch>\\p.py'; New-Item -ItemType Directory -Path '<scratch>\\o'", "<scratch>")).toMatchObject({
      verdict: "allow",
      rule: "exec+notes-write",
      tier: 2,
    });
  });

  it("refuses git write verbs on a read repo, and git in a folder that is not the worktree", () => {
    expect(run("git --no-optional-locks -C '<repo>' commit -m x").rule).toBe("never:project-repo");
    expect(run("git --no-optional-locks status", "<notes>").rule).toBe("never:project-repo");
    expect(run("git --no-optional-locks -C '<repo>' diff --output=x").rule).toBe("never:project-repo");
  });

  it("does not take authority.md for a credential, but takes auth.json", () => {
    expect(run("Get-Content -LiteralPath '<notes>\\authority.md'").verdict).toBe("allow");
    expect(run("Get-Content -LiteralPath '<notes>\\auth.json'").rule).toBe("never:credential");
  });

  it("does not read the contents of an apply_patch file as commands, but does read its headers", () => {
    const words = PATCH("*** Add File: <notes>/review-2.md").replace("+No blocking findings.", "+Remove-Item and git push were checked; no token found.");
    expect(run(words)).toMatchObject({ verdict: "allow", rule: "notes-write" });
    expect(run(PATCH("*** Add File: <home>/data/tools/x.py"))).toMatchObject({ verdict: "relay", rule: "never:outside" });
  });

  it("relays a program run by path from outside the roots", () => {
    expect(run("& 'C:\\Tools\\thing.exe'", "<worktree>", maximal("C:\\Tools\\thing.exe")).rule).toBe("never:outside");
  });

  it("relays a comma list given to a program, which reaches it as separate arguments", () => {
    expect(run("npm.cmd test x,\\Windows\\y", "<scratch>")).toMatchObject({ rule: "never:unparsed" });
    expect(run("git add -- a.md,\\Windows\\b")).toMatchObject({ rule: "never:unparsed" });
  });

  it("relays git, curl or gh run by path from outside the roots", () => {
    expect(run("& 'C:\\Program Files\\Git\\cmd\\git.exe' --no-optional-locks status")).toMatchObject({ rule: "never:outside" });
    expect(run("& 'C:\\Windows\\System32\\curl.exe' -fL https://registry.npmjs.org/x -o '<scratch>\\x'")).toMatchObject({ rule: "never:outside" });
  });

  it("reads the working folder for credentials and devices too", () => {
    expect(run("New-Item -ItemType Directory -Path '<notes>\\secrets\\a'", "<notes>\\secrets")).toMatchObject({ rule: "never:credential" });
  });

  it("reads --name='value' as one argument, and checks the value", () => {
    expect(run("git --no-optional-locks -C '<repo>' archive --format=zip HEAD --output='<notes>\\head.zip'")).toMatchObject({ verdict: "allow", rule: "git-read" });
    expect(run("git --no-optional-locks -C '<repo>' archive --format=zip HEAD --output='C:\\Outside\\head.zip'").rule).toBe("never:outside");
    expect(parseScript("git log 'a'--output=x").ok).toBe(false);
  });

  it("relays git -c without making the agent sticky", () => {
    expect(run("git -c core.autocrlf=false --no-optional-locks status")).toMatchObject({ verdict: "relay", rule: "no-rule" });
  });

  it("takes paseo only as a program, not as a folder name", () => {
    expect(run("Copy-Item -LiteralPath '<worktree>\\docs\\paseo' -Destination '<notes>\\paseo'").verdict).toBe("allow");
    expect(run("& '<user>\\AppData\\Local\\Programs\\Paseo\\paseo.cmd' ls").rule).toBe("never:outward");
    expect(run("paseo.cmd send x y").rule).toBe("never:outward");
  });

  it("relays the rate limit only on what it would allow", () => {
    expect(run("Get-Date", "<worktree>", permits(), { allowsLastHour: 500 }).rule).toBe("no-rule");
    expect(run(DEFAULT_SCRIPT, "<worktree>", permits(), { allowsLastHour: MAX_ALLOWS_PER_HOUR - 1 }).verdict).toBe("allow");
  });

  it("relays live permits only in live mode", () => {
    const shadowOnly = permits({ live: false });
    expect(run(DEFAULT_SCRIPT, "<worktree>", shadowOnly, { mode: "shadow" }).verdict).toBe("allow");
    expect(run(DEFAULT_SCRIPT, "<worktree>", shadowOnly, { mode: "live" }).rule).toBe("never:no-permits");
  });
});
