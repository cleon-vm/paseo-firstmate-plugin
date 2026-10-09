/**
 * The never-auto list: what the permission broker relays to a person whatever a task's permits say.
 *
 * Data, not logic. `permit-match.ts` checks every entry before any allow rule: the raw-text patterns
 * against the command's script, the command names against each parsed statement, and the context
 * entries (crew, permits, provider, stickiness, rate) against the request. Each entry carries the cases
 * that prove it; `permit-match.test.ts` runs every case against a maximal permits file, so the entry is
 * the only thing that can stop it. Adding an entry is a reviewed plugin change.
 *
 * Case scripts use placeholders the test fills in: `<worktree>` (the agent's worktree), `<home>` (the
 * first mate's home), `<notes>` (the task's own `data/<task>` folder), `<scratch>` (its scratch folder),
 * `<repo>` (a read-only repository the permits name) and `<user>` (the user's profile folder).
 */

export type NeverAutoId =
  | "not-crew"
  | "no-permits"
  | "not-v1"
  | "destructive"
  | "outward"
  | "credential"
  | "outside"
  | "project-repo"
  | "non-get"
  | "hardware"
  | "system"
  | "after-refusal"
  | "unparsed"
  | "rate";

/** A change to the request or its context that a case makes. */
export type NeverAutoContext =
  | "no-crew-label"
  | "no-task-label"
  | "reserved-task"
  | "unsafe-task"
  | "no-permits-file"
  | "invalid-permits"
  | "other-task-permits"
  | "live-false-in-live"
  | "provider-claude"
  | "file-change"
  | "question"
  | "sticky"
  | "rate-limit"
  | "rate-limit-far"
  | "command-array";

/** A case that must relay with the entry's id: a script, a change of context, or both. */
export interface NeverAutoCase {
  script?: string;
  /** The working folder, when not the worktree. */
  cwd?: string;
  context?: NeverAutoContext;
}

export interface NeverAutoEntry {
  id: NeverAutoId;
  reason: string;
  /** Matched case-insensitively against the script (the command line with its pwsh wrapper taken off). */
  patterns: readonly RegExp[];
  /** Command names (lowercase, as the statement's first word) that hit the entry. */
  commands: readonly string[];
  cases: readonly NeverAutoCase[];
}

/** A hit on one of these makes the agent sticky for the rest of its life (spec 3.7). */
export const STICKY_IDS: ReadonlySet<NeverAutoId> = new Set(["destructive", "outward", "credential", "system"]);

/** The most automatic allows for one agent in one hour; past it a human decides. */
export const MAX_ALLOWS_PER_HOUR = 120;

/** Task ids that name no task: folders of `data/` the broker owns or protects, and Windows device names. */
export const RESERVED_TASKS: ReadonlySet<string> = new Set([
  "permissions",
  "tools",
  "con",
  "prn",
  "aux",
  "nul",
  ...Array.from({ length: 9 }, (_, index) => `com${index + 1}`),
  ...Array.from({ length: 9 }, (_, index) => `lpt${index + 1}`),
]);

/** Where a statement may stand: the start of the script or after a separator, a pipe, a call or an opening. */
const AT = String.raw`(?:^|[;\n|&{(]|-Command\s+')\s*`;

export const NEVER_AUTO: readonly NeverAutoEntry[] = [
  {
    id: "not-crew",
    reason: "only crew have briefs",
    patterns: [],
    commands: [],
    cases: [{ context: "no-crew-label" }, { context: "no-task-label" }, { context: "reserved-task" }, { context: "unsafe-task" }],
  },
  {
    id: "no-permits",
    reason: "default deny: no valid permits file for this task",
    patterns: [],
    commands: [],
    cases: [
      { context: "no-permits-file" },
      { context: "invalid-permits" },
      { context: "other-task-permits" },
      { context: "live-false-in-live" },
    ],
  },
  {
    id: "not-v1",
    reason: "nothing literal to check: not a Codex command approval",
    patterns: [],
    commands: [],
    cases: [{ context: "provider-claude" }, { context: "file-change" }, { context: "question" }],
  },
  {
    id: "destructive",
    reason: "not reversible",
    patterns: [
      /\bRemove-Item\b/i,
      /\bClear-Content\b/i,
      /\bMove-Item\b/i,
      /\bRename-Item\b/i,
      /\bgit\s+(?:reset|clean|restore)\b/i,
      /\bgit\s+checkout\s+--(?:\s|$)/i,
      /\bgit\s+branch\s+-[dD]\b/i,
      /\bgit\s+stash\s+(?:drop|clear)\b/i,
      /\bgit\s+worktree\s+(?:remove|prune)\b/i,
      /^\*\*\* Delete File/im,
      /^\*\*\* Move to/im,
      /\bdiskpart\b/i,
      /\brmdir\b/i,
      /\bformat(?:\.com)?\s+[a-z]:/i,
      /(?:^|\s)--force(?:-with-lease)?(?:\s|=|$)/i,
      new RegExp(`${AT}(?:rm|del|erase|rd|ri|mi|mv|move|ren|rni|clc|format)(?:\\s|$)`, "i"),
    ],
    commands: [
      "remove-item",
      "ri",
      "rm",
      "del",
      "erase",
      "rd",
      "rmdir",
      "clear-content",
      "clc",
      "clear-item",
      "cli",
      "move-item",
      "mi",
      "move",
      "mv",
      "rename-item",
      "rni",
      "ren",
      "format",
      "format.com",
      "format-volume",
      "diskpart",
      "diskpart.exe",
    ],
    cases: [
      { script: "Remove-Item -LiteralPath '<notes>\\old.md'" },
      { script: "New-Item -ItemType Directory -Path '<notes>\\a'; rm '<notes>\\b'" },
      { script: "git reset --hard HEAD~1" },
      { script: "git clean -fdx" },
      { script: "git branch -D topic" },
      { script: "Copy-Item -LiteralPath '<worktree>\\a.md' -Destination '<notes>\\a.md' -Force" },
      { script: "Move-Item -LiteralPath '<notes>\\a.md' -Destination '<notes>\\b.md'" },
      { script: "git checkout -- README.md" },
      { script: "git stash drop" },
      { script: "git push --force origin topic" },
    ],
  },
  {
    id: "outward",
    reason: "leaves the machine or acts for the captain",
    patterns: [
      /\bgit\s+(?:push|remote)\b/i,
      /\bgh\s+(?:pr\s+(?:create|merge|edit|comment|review|close|reopen|ready)|issue|release|repo|gist|secret|workflow)\b/i,
      /\bgh\s+api\b[^;\n|]*\s(?:-X|--method|-f|-F|--field|--raw-field|--input)(?:\s|=|$)/i,
      /\bcurl(?:\.exe)?\b[^;\n|]*\s(?:-X|--request|-d|--data[\w-]*|-F|--form[\w-]*|-T|--upload-file|--json)(?:\s|=|$)/i,
      /\b(?:Invoke-RestMethod|Invoke-WebRequest|irm|iwr)\b[^;\n|]*\s-(?:Method|Body|InFile|Form)\b/i,
      /(?:^|\s)(?:-X|--request|--method|-Method)(?:\s+|=)['"]?(?:POST|PUT|PATCH|DELETE)\b/i,
      /\bnpm(?:\.cmd)?\s+publish\b/i,
      /\bSend-MailMessage\b/i,
      new RegExp(`${AT}(?:&\\s*)?['"]?(?:[^'"\\s;|]*[\\\\/])?paseo(?:\\.cmd|\\.exe)?['"]?(?:\\s|$)`, "i"),
      new RegExp(`${AT}(?:ssh|scp|sftp)(?:\\.exe)?(?:\\s|$)`, "i"),
    ],
    commands: ["ssh", "ssh.exe", "scp", "scp.exe", "sftp", "sftp.exe", "send-mailmessage", "paseo", "paseo.cmd", "paseo.exe"],
    cases: [
      { script: "git push origin topic" },
      { script: "git remote add up https://github.com/octo/example.git" },
      { script: "gh pr create --title x --body y" },
      { script: "gh api repos/octo/example/issues -X POST -f title=x" },
      { script: "curl.exe -fLsS https://registry.example.org/x -o '<scratch>\\x' -X POST" },
      { script: "Invoke-RestMethod -Uri 'https://registry.example.org/x' -Method Post" },
      { script: "paseo send someone hello" },
      { script: "npm.cmd publish" },
      { script: "ssh host.example.org" },
    ],
  },
  {
    id: "credential",
    reason: "never near credentials",
    patterns: [
      /\b(?:tokens?|auth|login|credentials?|secrets?|passwords?|passwd|apikey|api_key|bearer|cookies?|keyring|cmdkey|local-credential|GH_TOKEN|GITHUB_TOKEN)\b/i,
      /\bGet-StoredCredential\b/i,
      /\.(?:env|npmrc|netrc|ssh)\b/i,
      /\bid_(?:rsa|ed25519)/i,
      /\bauth\.json\b/i,
      /\bbitbucket-watch\.env\b/i,
    ],
    commands: ["cmdkey", "cmdkey.exe", "get-storedcredential"],
    cases: [
      { script: "gh auth status" },
      { script: "Get-Content -LiteralPath '<user>\\.ssh\\id_ed25519'" },
      { script: "Copy-Item -LiteralPath '<worktree>\\.env' -Destination '<notes>\\env.txt'" },
      { script: "Get-Content -LiteralPath '<worktree>\\token.txt'" },
      { script: "$env:GH_TOKEN='x'; gh api repos/octo/example" },
      { script: "cmdkey /list" },
    ],
  },
  {
    id: "outside",
    reason: "the brief's paths only",
    patterns: [],
    commands: [],
    cases: [
      { script: "New-Item -ItemType Directory -Path '<home>\\data\\other-task\\x'" },
      { script: "New-Item -ItemType Directory -Path '<home>\\data\\tools\\x'" },
      { script: "Copy-Item -LiteralPath '<worktree>\\a.md' -Destination '<home>\\data\\permissions\\permits\\x.json'" },
      { script: "Copy-Item -LiteralPath 'C:\\Windows\\win.ini' -Destination '<notes>\\win.ini'" },
      { script: "New-Item -ItemType Directory -Path '<notes>\\a'", cwd: "C:\\Home\\example\\Desktop" },
      { script: "& 'C:\\Tools\\thing.exe' run" },
      { script: "New-Item -ItemType Directory -Path '<user>\\.codex\\x'" },
    ],
  },
  {
    id: "project-repo",
    reason: "other repos are read-only, and only when named",
    patterns: [],
    commands: [],
    cases: [
      { script: "git --no-optional-locks -C 'C:\\src\\other' log -1" },
      { script: "git --no-optional-locks -C '<repo>' commit -m x" },
      { script: "git add -- README.md", cwd: "<notes>" },
      { script: "Copy-Item -LiteralPath '<worktree>\\a.md' -Destination '<repo>\\a.md'" },
    ],
  },
  {
    id: "non-get",
    reason: "only the listed read-only network forms, to listed places",
    patterns: [],
    commands: [],
    cases: [
      { script: "gh api repos/octo/unlisted/pulls" },
      { script: "curl.exe -fL https://unlisted.example.org/x -o '<scratch>\\x'" },
      { script: "git fetch origin" },
      { script: "Invoke-WebRequest -Uri 'https://registry.example.org/x'" },
      { script: "gh pr view 5" },
    ],
  },
  {
    id: "hardware",
    reason: "physical effects",
    patterns: [
      /\bSTM32_Programmer_CLI\b/i,
      /\bJLink\w*/i,
      /\bopenocd\b/i,
      /\bnrfjprog\b/i,
      /\busbipd\b/i,
      /\bwsl(?:\.exe)?\b/i,
      /\bCOM\d+\b/i,
      /\bSerialPort\b/i,
      /\bGet-PnpDevice\b/i,
      /-c\s+port=/i,
      /\bport=COM/i,
    ],
    commands: ["wsl", "wsl.exe", "usbipd", "usbipd.exe", "openocd", "openocd.exe", "nrfjprog", "nrfjprog.exe", "get-pnpdevice"],
    cases: [
      { script: "& '<scratch>\\STM32_Programmer_CLI.exe' -c port=SWD -w fw.bin" },
      { script: "wsl.exe -d Ubuntu --exec make" },
      { script: "Get-PnpDevice -Class Ports" },
      { script: "uv run --offline --no-project python '<scratch>\\read.py' COM7" },
      { script: "usbipd list" },
    ],
  },
  {
    id: "system",
    reason: "escapes the grammar or the machine's setup",
    patterns: [
      /\bStart-Process\b/i,
      /\bInvoke-Expression\b/i,
      /(?:^|[^\w-])iex\b/i,
      /\bcmd(?:\.exe)?\s+\/[ckr]\b/i,
      /\bcmd\.exe\b/i,
      /\b(?:powershell|pwsh)(?:\.exe)?\b[^;\n|]*\s-(?:c|command|e|ec|enc|encodedcommand)\b/i,
      /-EncodedCommand\b/i,
      /\bSet-ExecutionPolicy\b/i,
      /-ExecutionPolicy\b/i,
      /\breg(?:\.exe)?\s+(?:add|delete|import|load|restore|save|copy|export|query|unload)\b/i,
      /\bschtasks\b/i,
      /\bsc\.exe\b/i,
      /\bStop-Process\b/i,
      /\btaskkill\b/i,
      /\bwinget\b/i,
      /\bchoco\b/i,
      /\bnpm(?:\.cmd)?\s[^;\n|]*\s(?:-g|--global)\b/i,
      /\bpip3?(?:\.exe)?\s+install\b/i,
      /\buv\s+(?:tool|pip)\b/i,
      /\bAdd-Type\b/i,
      /\bNew-Service\b/i,
      /\brunas\b/i,
      /-Verb\s+RunAs\b/i,
      /\bSet-Item\b[^;\n|]*\bEnv:/i,
      /\[System\./i,
      /\bInvoke-Command\b/i,
      /\bInvoke-Item\b/i,
      /\bStart-Job\b/i,
      /\bRegister-ScheduledTask\b/i,
    ],
    commands: [
      "start-process",
      "saps",
      "start",
      "invoke-expression",
      "iex",
      "cmd",
      "cmd.exe",
      "powershell",
      "powershell.exe",
      "set-executionpolicy",
      "reg",
      "reg.exe",
      "schtasks",
      "schtasks.exe",
      "sc",
      "sc.exe",
      "stop-process",
      "spps",
      "kill",
      "taskkill",
      "taskkill.exe",
      "winget",
      "winget.exe",
      "choco",
      "choco.exe",
      "pip",
      "pip.exe",
      "pip3",
      "pip3.exe",
      "add-type",
      "new-service",
      "runas",
      "runas.exe",
      "invoke-command",
      "icm",
      "invoke-item",
      "ii",
      "start-job",
      "sajb",
      "register-scheduledtask",
      "set-item",
      "si",
    ],
    cases: [
      { script: "cmd /c dir" },
      { script: "Start-Process notepad.exe" },
      { script: "Invoke-Expression 'Get-Date'" },
      { script: "pwsh -Command Get-Date" },
      { script: "npm.cmd install left-pad@1.3.0 --no-save --package-lock=false --cache '<scratch>\\npm'", cwd: "<scratch>" },
      { script: "$env:PATH='<scratch>'; node x.js", cwd: "<scratch>" },
      { script: "uv pip install requests" },
    ],
  },
  {
    id: "after-refusal",
    reason: "crew rule 12: after a refusal only a person may let the work go on",
    patterns: [],
    commands: [],
    cases: [
      { context: "sticky" },
      { context: "sticky", script: "git --no-optional-locks status" },
      { context: "sticky", script: "uv run --offline --no-project python '<scratch>\\probe.py'", cwd: "<scratch>" },
    ],
  },
  {
    id: "unparsed",
    reason: "default deny: the command does not fit the statement grammar",
    patterns: [],
    commands: [],
    cases: [
      { script: "New-Item -ItemType Directory -Path \"<notes>\\$(Get-Date)\"" },
      { script: "1..3 | ForEach-Object { New-Item -ItemType Directory -Path '<notes>\\x' }" },
      { script: "Get-Content -LiteralPath '<notes>\\a.md' | Out-File '<notes>\\b.md'" },
      { script: "git status `\n; Get-Date" },
      { script: "Get-Content -LiteralPath '<notes>\\a.md' > '<notes>\\b.md'" },
      { context: "command-array" },
    ],
  },
  {
    id: "rate",
    reason: "a runaway loop is a human's call",
    patterns: [],
    commands: [],
    cases: [
      { context: "rate-limit" },
      { context: "rate-limit-far" },
      { context: "rate-limit", script: "gh api repos/octo/example/pulls --paginate" },
    ],
  },
];

export function neverAuto(id: NeverAutoId): NeverAutoEntry {
  const entry = NEVER_AUTO.find((candidate) => candidate.id === id);
  if (entry === undefined) throw new Error(`no never-auto entry ${id}`);
  return entry;
}
