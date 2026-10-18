/**
 * The review's bypass hunt (round 1), kept as regression tests: 47 commands that a maximal permits file
 * must still relay. Each case gets an exec entry in every place for the first word of each of its
 * statements, so only the never-auto list, the grammar and the rule shapes can stop it. Synthetic only;
 * the two hardware tool names the review used are replaced by generic stand-ins.
 *
 * The two hardware names come from a private supplement in the home (spec amendment 2026-10-09); here a
 * synthetic one, `permit-fixtures/never-auto-extra.json`. The -NoProfile wrapper and the extra read-only
 * local-read switches (attempts 42 and 44) are accepted by the same amendment and must allow.
 */
import { readFileSync } from "node:fs";

import { describe, expect, it } from "vitest";

import { LOCAL_READ_FORMS, match, parseNeverAutoExtra, parseScript, type MatchContext, type Permits } from "./permit-match";

const USER = String.raw`C:\Home\example`;
const HOME = `${USER}\\.paseo\\plugin-data\\firstmate\\home`;
const WORKTREE = String.raw`C:\Work\demo`;
const SCRATCH = String.raw`C:\Scratch\demo`;
const NOTES = `${HOME}\\data\\demo`;
const REPO = String.raw`C:\Review\demo`;
const SHIM = `${USER}\\.codex\\tmp\\arg0\\codex-arg0Ab12\\apply_patch.bat`;

/** Every path exists, except under a junction `<notes>\jx`, which leads to C:\Outside. */
function realpath(path: string): string | null {
  const lower = path.toLowerCase();
  if (lower === `${NOTES.toLowerCase()}\\jx`) return String.raw`C:\Outside`;
  return lower.includes("\\jx\\") ? null : path;
}

const CONTEXT: MatchContext = {
  crew: true,
  task: "demo",
  mode: "shadow",
  home: HOME,
  userHome: USER,
  worktree: WORKTREE,
  sticky: false,
  allowsLastHour: 0,
  realpath,
  extraHardware: parseNeverAutoExtra(JSON.parse(readFileSync(new URL("./permit-fixtures/never-auto-extra.json", import.meta.url), "utf8"))),
};

const patch = (header: string, shim = SHIM) => `$p = @'\n*** Begin Patch\n${header}\n+x\n*** End Patch\n'@\n& '${shim}' $p`;

interface Attempt {
  name: string;
  script: string;
  /** A flag before -Command in the wrapper. */
  wrapper?: string;
  /** The exec prefix to permit instead of each statement's first word. */
  prefix?: string[];
  /** Accepted by the spec amendment of 2026-10-09: allows. */
  accepted?: string;
}

const ATTEMPTS: Attempt[] = [
  { name: "1 quoted git push", script: "git 'push' origin topic" },
  { name: "2 escaped quote", script: "git commit -m 'x''; git push'" },
  { name: "3 comma sources, one outside", script: `Copy-Item -LiteralPath '${WORKTREE}\\a','C:\\Outside\\b' -Destination '${NOTES}\\x'` },
  { name: "4 alias ri", script: `ri '${NOTES}\\x'` },
  { name: "5 alias mi", script: `mi '${NOTES}\\x' '${NOTES}\\y'` },
  { name: "6 git.exe reset", script: "git.exe -C C:\\Work\\demo reset --hard" },
  { name: "7 path gh, attached method", script: `& '${SCRATCH}\\gh.exe' api repos/octo/example/issues -XPOST` },
  { name: "8 path curl, attached data", script: `& '${SCRATCH}\\curl.exe' -dvalue` },
  { name: "9 path git, output file", script: `& '${SCRATCH}\\git.exe' --no-optional-locks diff --output=result.txt` },
  { name: "10 path git, other repo", script: `& '${SCRATCH}\\git.exe' -C 'C:\\Outside\\repo' status` },
  { name: "11 path npm install", script: `& '${SCRATCH}\\npm.cmd' install left-pad@1.3.0 --ignore-scripts` },
  { name: "12 mixed-case Remove-Item", script: "rEmOvE-iTeM x" },
  { name: "13 fullwidth rm", script: "\uff52\uff4d x" },
  { name: "14 *> redirection", script: `Get-Content -LiteralPath '${NOTES}\\a' *> '${NOTES}\\b'` },
  { name: "15 > redirection", script: `Get-Content -LiteralPath '${NOTES}\\a' > '${NOTES}\\b'` },
  { name: "16 stop-parsing token", script: "git --% reset --hard" },
  { name: "17 PATH set, PATH permitted", script: `$env:PATH='${SCRATCH}'; node x.js` },
  { name: "18 junction", script: `New-Item -ItemType Directory -Path '${NOTES}\\jx\\x'` },
  { name: "19 apply_patch Delete File", script: patch(`*** Delete File: ${NOTES}/x`) },
  { name: "20 apply_patch Move to", script: patch(`*** Update File: ${NOTES}/x\n*** Move to: ${NOTES}/y`) },
  { name: "21 apply_patch shim in scratch", script: patch(`*** Add File: ${NOTES}/x`, `${SCRATCH}\\apply_patch.bat`) },
  { name: "22 apply_patch into data/permissions", script: patch(`*** Add File: ${HOME}/data/permissions/x`) },
  { name: "23 git -c alias", script: "git -c alias.x=push --no-optional-locks x" },
  { name: "24 git -C read repo reset", script: `git -C '${REPO}' reset --hard` },
  { name: "25 gh attached method", script: "gh api repos/octo/example/issues -XPOST" },
  { name: "26 gh --method=POST", script: "gh api repos/octo/example/issues --method=POST" },
  { name: "27 curl attached data", script: "curl.exe -dvalue" },
  { name: "28 path pwsh -Command", script: `& '${SCRATCH}\\pwsh.exe' -NoProfile -Command 'Get-Date'` },
  { name: "29 path powershell -Command", script: `& '${SCRATCH}\\powershell.exe' -Command 'Get-Date'` },
  { name: "30 omitted hardware A, bare", script: "hwtool-a inspect" },
  { name: "31 omitted hardware B, bare", script: "hwb inspect" },
  { name: "32 omitted hardware A.exe", script: "hwtool-a.exe inspect" },
  { name: "33 omitted hardware B.exe by path", script: `& '${SCRATCH}\\hwb.exe' inspect` },
  { name: "34 node of a file in C:\\Windows", script: "node 'C:\\Windows\\x.js'" },
  { name: "35 node of AGENTS.md", script: `node '${WORKTREE}\\AGENTS.md'` },
  { name: "36 long argument, then git push", script: `node '${SCRATCH}\\x.js' '${"a".repeat(16000)}'; git push` },
  { name: "37 path rm.exe", script: `& '${SCRATCH}\\rm.exe' x` },
  { name: "38 path ssh.exe", script: `& '${SCRATCH}\\ssh.exe' host.example.org` },
  { name: "39 Select-String positional path", script: `Get-Content -LiteralPath '${NOTES}\\a' | Select-String 'x' 'C:\\Outside\\b'` },
  { name: "40 Select-String credential word", script: `Get-Content -LiteralPath '${NOTES}\\a' | Select-String 'password'` },
  { name: "41 git diff of an outside path", script: "git --no-optional-locks diff -- C:/Outside/a" },
  { name: "42 -NoProfile wrapper", script: `Get-Content -LiteralPath '${NOTES}\\a'`, wrapper: "-NoProfile", accepted: "S2" },
  { name: "43 -NoLogo wrapper", script: `Get-Content -LiteralPath '${NOTES}\\a'`, wrapper: "-NoLogo" },
  { name: "44 local read with -Raw", script: `Get-Content -LiteralPath '${NOTES}\\a' -Raw`, accepted: "S3" },
  { name: "45 NODE under prefix node", script: "NODE x.js", prefix: ["node"] },
  { name: "46 python -b under prefix python -B", script: "python -b x.py", prefix: ["python", "-B"] },
  { name: "47 Select-String abbreviated -Pa", script: `Get-Content -LiteralPath '${NOTES}\\a' | Select-String -Pattern x -Pa 'C:\\Outside\\b'` },
];

function permitsFor(attempt: Attempt): Permits {
  const parsed = parseScript(attempt.script);
  const firsts = parsed.ok ? parsed.statements.flatMap((statement) => (statement.kind === "command" ? [statement.words[0]?.value ?? ""] : [])) : [];
  const prefixes = attempt.prefix !== undefined ? [attempt.prefix] : firsts.map((word) => [word]);
  return {
    version: 1,
    task: "demo",
    live: true,
    writeDirs: ["data/demo"],
    scratchDirs: [SCRATCH],
    readRepos: [REPO],
    netRead: { githubRepos: ["octo/example"], hosts: ["registry.npmjs.org"] },
    gitLocal: true,
    exec: prefixes.flatMap((prefix) => (["scratch", "notes", "worktree"] as const).map((place) => ({ in: place, prefix }))),
    envNames: ["PATH"],
  };
}

function judge(attempt: Attempt, mode: MatchContext["mode"] = "shadow") {
  const wrapper = attempt.wrapper === undefined ? "" : ` ${attempt.wrapper}`;
  const command = `"C:\\Program Files\\PowerShell\\7\\pwsh.exe"${wrapper} -Command '${attempt.script.replace(/'/g, "''")}'`;
  return match({ provider: "codex", name: "CodexBash", kind: "tool", input: { command, cwd: WORKTREE } }, permitsFor(attempt), { ...CONTEXT, mode });
}

describe("live execution follow-ups", () => {
  it.each([
    ["python -Ec 'print(1)'", ["python"]],
    ["python '-Ecprint(1)'", ["python"]],
    ["python -Pc 'print(1)'", ["python"]],
    ["python -Rc 'print(1)'", ["python"]],
    ["python -hc 'print(1)'", ["python"]],
    ["perl -E 'say 1'", ["perl"]],
    ["perl -we 'print 1'", ["perl"]],
    ["perl -lne 'print'", ["perl"]],
    ["ruby -we 'puts 1'", ["ruby"]],
    ["uv run --offline python -Ec 'print(1)'", ["uv", "run"]],
  ] as Array<[string, string[]]>)("relays round-2 bundled inline form %s", (script, prefix) => {
    const attempt = { name: "round-2 inline", script, prefix };
    expect(judge(attempt, "live").verdict).toBe("relay");
    expect(judge(attempt, "shadow").verdict).toBe("allow");
  });

  it.each([
    ["python -X utf8 -B -m unittest", ["python"]],
    ["uv run --offline --no-project python example.py", ["uv", "run"]],
    ["perl -w example.pl", ["perl"]],
    ["ruby -w example.rb", ["ruby"]],
  ] as Array<[string, string[]]>)("keeps named-script/module control %s live", (script, prefix) => {
    expect(judge({ name: "named program", script, prefix }, "live").verdict).toBe("allow");
  });

  it.each([
    ["python '-cprint(1)'", ["python"]],
    ["python '-Bcprint(1)'", ["python"]],
    ["node -p '1+1'", ["node"]],
    ["deno eval 'console.log(1)'", ["deno"]],
    ["deno --quiet eval 'console.log(1)'", ["deno"]],
    ["uv run deno eval 'console.log(1)'", ["uv", "run"]],
  ] as Array<[string, string[]]>)("relays inline code form %s in live", (script, prefix) => {
    const attempt = { name: "inline code", script, prefix };
    expect(judge(attempt, "live").verdict).toBe("relay");
    expect(judge(attempt, "shadow").verdict).toBe("allow");
  });

  it("checks task and live permits before never-auto and rules", () => {
    const request = { provider: "codex", name: "CodexBash", kind: "tool", input: { command: '"C:\\Program Files\\PowerShell\\7\\pwsh.exe" -Command \'git push\'', cwd: WORKTREE } };
    const permits = permitsFor({ name: "order", script: "git push" });
    expect(match(request, { ...permits, live: false }, { ...CONTEXT, mode: "live" }).rule).toBe("never:no-permits");
    expect(match(request, permits, { ...CONTEXT, mode: "live", task: "permissions" }).rule).toBe("never:not-crew");
    expect(match(request, permits, { ...CONTEXT, mode: "live" }).rule).toBe("never:outward");
  });
  it("leaves git commits to a person because crew-controlled hooks can execute outside the brief", () => {
    const attempt = { name: "git hooks", script: "git commit -m 'example'" };
    expect(judge(attempt, "shadow").verdict).toBe("allow");
    expect(judge(attempt, "live").verdict).toBe("relay");
  });

  it("relays inline interpreter code in live mode even with an exact matching exec prefix", () => {
    for (const [script, prefix] of [
      ["python -c 'print(1)'", ["python", "-c"]],
      ["uv run --offline python -Ic 'print(1)'", ["uv", "run", "--offline", "python", "-Ic"]],
      ["node --eval 'console.log(1)'", ["node", "--eval"]],
      ["node -e 'console.log(1)'", ["node", "-e"]],
      ["node -pe '1'", ["node", "-pe"]],
    ] as Array<[string, string[]]>) {
      const attempt = { name: "inline code", script, prefix };
      expect(judge(attempt, "shadow").verdict, script).toBe("allow");
      expect(judge(attempt, "live").verdict, script).toBe("relay");
    }
  });
});

describe.each(["shadow", "live"] as const)("the review's bypass hunt, round 1 (%s)", (mode) => {
  for (const attempt of ATTEMPTS.filter((candidate) => candidate.accepted === undefined)) {
    it(`relays ${attempt.name}`, () => {
      const result = judge(attempt, mode);
      expect(result.verdict, `${result.rule}: ${result.detail}`).toBe("relay");
    });
  }
  for (const attempt of ATTEMPTS.filter((candidate) => candidate.accepted !== undefined)) {
    it(`allows ${attempt.name} (accepted widening ${attempt.accepted}, spec amendment 2026-10-09)`, () => {
      expect(judge(attempt, mode).verdict).toBe("allow");
    });
  }

  it("has all 47 attempts", () => {
    expect(ATTEMPTS).toHaveLength(47);
  });
});

describe.each(["shadow", "live"] as const)("round 1 fixes (%s)", (mode) => {
  const exec = (prefix: string[], place: "scratch" | "notes" | "worktree" = "worktree"): Permits => ({
    ...permitsFor({ name: "", script: "Get-Date" }),
    exec: prefix.length === 0 ? [] : [{ in: place, prefix }],
  });
  const run = (script: string, permits: Permits) =>
    match(
      { provider: "codex", name: "CodexBash", kind: "tool", input: { command: `"C:\\Program Files\\PowerShell\\7\\pwsh.exe" -Command '${script.replace(/'/g, "''")}'`, cwd: WORKTREE } },
      permits,
      { ...CONTEXT, mode },
    );

  it("B1: takes attached and bundled write flags of gh and curl as outward", () => {
    expect(run("gh api repos/octo/example/issues -XPOST", exec(["gh"])).rule).toBe("never:outward");
    expect(run("gh api repos/octo/example/issues -ftitle=x", exec(["gh"])).rule).toBe("never:outward");
    expect(run("curl.exe -dvalue", exec(["curl.exe"])).rule).toBe("never:outward");
    expect(run("curl.exe -fLd value https://registry.npmjs.org/x", exec(["curl.exe"])).rule).toBe("never:outward");
    expect(run(`& '${SCRATCH}\\curl.exe' -sXPOST https://registry.npmjs.org/x`, exec([`${SCRATCH}\\curl.exe`])).rule).toBe("never:outward");
  });

  it("B1: sends a git, gh or npm run by path through its own policy, and through exec as well", () => {
    const gitPath = `${SCRATCH}\\git.exe`;
    expect(run(`& '${gitPath}' --no-optional-locks diff --output=result.txt`, exec([gitPath])).rule).toBe("never:project-repo");
    // Shadow judges the rooted binary's exact prefix as tier 2. Live requires a person for
    // repository-controlled helpers even when an exec prefix names the binary.
    expect(run(`& '${gitPath}' --no-optional-locks status`, exec([gitPath]))).toMatchObject(mode === "live"
      ? { verdict: "relay", rule: "no-rule", tier: null }
      : { verdict: "allow", rule: "exec", tier: 2 });
    // Its own policy allows it, but no exec prefix names the binary: relayed.
    expect(run(`& '${gitPath}' --no-optional-locks status`, exec(["node"])).verdict).toBe("relay");
    const ghPath = `${SCRATCH}\\gh.exe`;
    expect(run(`& '${ghPath}' api repos/octo/unlisted/pulls`, exec([ghPath])).rule).toBe("never:non-get");
    const npmPath = `${SCRATCH}\\npm.cmd`;
    expect(run(`& '${npmPath}' install left-pad@1.3.0 --ignore-scripts`, exec([npmPath])).rule).toBe("no-rule");
  });

  it("B2: takes a native destructive program with .exe or a path as destructive", () => {
    expect(run(`& '${SCRATCH}\\rm.exe' x`, exec([`${SCRATCH}\\rm.exe`])).rule).toBe("never:destructive");
    expect(run("rm.exe x", exec(["rm.exe"])).rule).toBe("never:destructive");
    expect(run(`& '${SCRATCH}\\rmdir.exe' x`, exec([`${SCRATCH}\\rmdir.exe`])).rule).toBe("never:destructive");
  });

  it("B4: lets Select-String only filter the pipe, not read a file", () => {
    const read = `Get-Content -LiteralPath '${NOTES}\\a'`;
    expect(run(`${read} | Select-String x`, exec([])).verdict).toBe("allow");
    expect(run(`${read} | Select-String -Pattern x -SimpleMatch -Context 2`, exec([])).verdict).toBe("allow");
    for (const tail of ["Select-String x y", "Select-String -Pattern x y", "Select-String -Pattern x -Path y", "Select-String -Pattern x -LiteralPath y", "Select-String -Pattern x -Pa y", "Select-String -Pattern x -Encoding utf8"]) {
      expect(run(`${read} | ${tail}`, exec([])).rule, tail).toBe("never:unparsed");
    }
  });

  it("B3: relays a supplement hardware name bare, with .exe, by path, in any case, or named by a prefix", () => {
    for (const [script, prefix] of [
      ["hwtool-a inspect", ["hwtool-a"]],
      ["HWTOOL-A.EXE inspect", ["HWTOOL-A.EXE"]],
      [`& '${SCRATCH}\\hwb.exe' inspect`, [`${SCRATCH}\\hwb.exe`]],
      ["uv run hwtool-a inspect", ["uv", "run", "hwtool-a"]],
    ] as const) {
      expect(run(script, exec([...prefix])).rule, script).toBe("never:hardware");
    }
  });

  it("B3: relays every exec statement when the supplement is missing or invalid, and nothing else", () => {
    const failClosed = (extraHardware: MatchContext["extraHardware"]) =>
      match(
        { provider: "codex", name: "CodexBash", kind: "tool", input: { command: `"C:\\Program Files\\PowerShell\\7\\pwsh.exe" -Command 'node x.js'`, cwd: WORKTREE } },
        exec(["node"]),
        { ...CONTEXT, mode, extraHardware },
      );
    expect(failClosed(null)).toMatchObject({ verdict: "relay", rule: "never:hardware" });
    expect(failClosed([]).verdict).toBe("allow");
    const notes = match(
      { provider: "codex", name: "CodexBash", kind: "tool", input: { command: `"C:\\Program Files\\PowerShell\\7\\pwsh.exe" -Command 'New-Item -ItemType Directory -Path ''${NOTES}\\x'''`, cwd: WORKTREE } },
      exec(["node"]),
      { ...CONTEXT, mode, extraHardware: null },
    );
    expect(notes.verdict).toBe("allow");
  });

  it("B3: reads only a valid version 1 supplement, case-folded and without .exe", () => {
    expect(parseNeverAutoExtra({ version: 1, neverAuto: { hardware: { commandBasenames: ["Tool.EXE", "b"] } } })).toEqual(["tool", "b"]);
    for (const bad of [null, {}, { version: 2, neverAuto: { hardware: { commandBasenames: [] } } }, { version: 1, neverAuto: { hardware: { commandBasenames: "x" } } }, { version: 1, neverAuto: { hardware: { commandBasenames: [""] } } }]) {
      expect(parseNeverAutoExtra(bad)).toBeNull();
    }
  });

  it("S3: accepts exactly the listed local-read switches (spec amendment 2026-10-09)", () => {
    expect(LOCAL_READ_FORMS).toEqual({
      "get-content": { valued: ["-literalpath", "-path", "-tail", "-totalcount", "-encoding"], switches: ["-raw"] },
      "get-item": { valued: ["-literalpath", "-path"], switches: [] },
      "get-childitem": { valued: ["-literalpath", "-path", "-depth"], switches: ["-recurse", "-file", "-directory", "-name"] },
      "test-path": { valued: ["-literalpath", "-path", "-pathtype"], switches: [] },
    });
    const at = `'${NOTES}\\a'`;
    for (const script of [
      `Get-Content -LiteralPath ${at} -Raw`,
      `Get-Content -LiteralPath ${at} -Tail 5`,
      `Get-Content -LiteralPath ${at} -TotalCount 5`,
      `Get-Content -LiteralPath ${at} -Encoding utf8`,
      `Get-ChildItem -LiteralPath ${at} -Recurse -File -Depth 2`,
      `Get-ChildItem -LiteralPath ${at} -Directory -Name`,
      `Test-Path -LiteralPath ${at} -PathType Leaf`,
    ]) {
      expect(run(script, exec([])).verdict, script).toBe("allow");
    }
    expect(run(`Get-Content -LiteralPath ${at} -Stream x`, exec([])).verdict).toBe("relay");
  });

  it("R2-B1: sends git, gh and curl with any Windows executable suffix through their own policy", () => {
    const cases: Array<[string, string, string]> = [];
    for (const suffix of [".com", ".bat", ".cmd", ".EXE", ".Com"]) {
      cases.push(
        [`gh${suffix}`, "api repos/octo/example/issues -XPOST", "never:outward"],
        [`curl${suffix}`, "-dvalue", "never:outward"],
        [`git${suffix}`, "push origin topic", "never:outward"],
        [`git${suffix}`, "--no-optional-locks diff --output=result.txt", "never:project-repo"],
      );
    }
    for (const [tool, args, rule] of cases) {
      const path = `${SCRATCH}\\${tool}`;
      expect(run(`& '${path}' ${args}`, exec([path])).rule, `${tool} ${args}`).toBe(rule);
    }
    // The same suffixes on a destructive or hardware name, too.
    expect(run(`& '${SCRATCH}\\rm.bat' x`, exec([`${SCRATCH}\\rm.bat`])).rule).toBe("never:destructive");
    expect(run(`& '${SCRATCH}\\hwb.cmd' inspect`, exec([`${SCRATCH}\\hwb.cmd`])).rule).toBe("never:hardware");
  });

  it("S1: compares exec prefix tokens exactly, except an absolute program path", () => {
    expect(run("node x.js", exec(["node"])).verdict).toBe("allow");
    expect(run("NODE x.js", exec(["node"])).verdict).toBe("relay");
    expect(run("python -b x.py", exec(["python", "-B"])).verdict).toBe("relay");
    expect(run("python -B x.py", exec(["python", "-B"])).verdict).toBe("allow");
    expect(run("uv run --project tools\\check python", exec(["uv", "run", "--project", "tools/check"])).verdict).toBe("relay");
    // An absolute program path names the same file in any case and with either slash.
    expect(run(`& '${SCRATCH.toUpperCase()}/tool.exe' x`, exec([`${SCRATCH}\\tool.exe`]))).toMatchObject({ verdict: "allow", rule: "exec" });
  });
});
