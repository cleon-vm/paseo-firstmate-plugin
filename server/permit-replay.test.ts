/**
 * The private replay (spec 3.11 item 8): every command of a labelled corpus of real permission requests
 * through the matcher under maximal permits. Skipped unless `PERMIT_REPLAY` names the corpus, a JSON
 * lines file of `{ command, cwd, label }` (also read: `cmd`, `cls2`, `cls`, `class`). The corpus stays on
 * the machine that made it; nothing of it belongs in this repository.
 *
 * Maximal permits are built from the corpus itself: every folder under the home's `data/` as a write dir,
 * the temporary folder as scratch, every `-C` folder and every Paseo worktree as a read repo, every GitHub pair and host it names,
 * and an exec entry in every place for the first word of every statement. So only the never-auto list and
 * the grammar can stop a command. It fails if a command labelled hardware, WSL, destructive, outward or
 * credential comes out `allow`, and prints coverage by label (counts and rules only, no commands).
 *
 * `PERMIT_REPLAY_DETAIL=1` also prints each relay's index, label, rule and detail (paths, no commands).
 *
 * `PERMIT_REPLAY_HOME` names the first mate's home; by default it is four folders above the corpus
 * (`<home>/data/<plan>/evidence/corpus.jsonl`).
 */
import { readdirSync, readFileSync, realpathSync } from "node:fs";
import { homedir, tmpdir } from "node:os";
import { dirname, join } from "node:path";

import { describe, expect, it } from "vitest";

import { match, parseScript, unwrapCommand, type MatchResult, type Permits } from "./permit-match";

const CORPUS = process.env.PERMIT_REPLAY ?? "";
const FORBIDDEN = /hardware|wsl|destructive|outward|credential/i;
const PWSH = "C:\\Program Files\\PowerShell\\7\\pwsh.exe";

interface Entry {
  command: string;
  cwd: string;
  label: string;
}

function text(record: Record<string, unknown>, ...names: string[]): string {
  for (const name of names) if (typeof record[name] === "string") return record[name] as string;
  return "";
}

function localPath(cwd: string): string {
  if (!cwd.startsWith("file:")) return cwd;
  return decodeURIComponent(cwd.replace(/^file:\/\/\/?/, "")).replace(/\//g, "\\");
}

function readCorpus(path: string): Entry[] {
  return readFileSync(path, "utf8")
    .split(/\r?\n/)
    .filter((line) => line.trim() !== "")
    .map((line) => JSON.parse(line) as Record<string, unknown>)
    .map((record) => ({
      command: Array.isArray(record.command) ? String(record.command[record.command.length - 1]) : text(record, "command", "cmd"),
      cwd: localPath(text(record, "cwd")),
      label: text(record, "label", "cls2", "cls", "class") || "unlabelled",
    }));
}

/** The command line as Codex sends it: a bare script gets the pwsh wrapper. */
function wrapped(command: string, userHome: string): string {
  if (unwrapCommand(command, userHome) !== null) return command;
  return `"${PWSH}" -Command '${command.replace(/'/g, "''")}'`;
}

function maximalPermits(entries: readonly Entry[], home: string, userHome: string): Permits {
  const writeDirs = readdirSync(join(home, "data"), { withFileTypes: true })
    .filter((entry) => entry.isDirectory() && /^[A-Za-z0-9][A-Za-z0-9 ._-]*$/.test(entry.name) && !entry.name.includes(".."))
    .map((entry) => `data/${entry.name}`);
  const readRepos = new Set<string>();
  const pairs = new Set<string>();
  const hosts = new Set<string>();
  const envNames = new Set<string>();
  const firsts = new Set<string>();
  // Every worktree on the machine is a read repo: a reviewer's brief may name any of them.
  const worktrees = join(userHome, ".paseo", "worktrees");
  for (const group of safeList(worktrees)) for (const tree of safeList(join(worktrees, group))) readRepos.add(join(worktrees, group, tree));
  for (const entry of entries) {
    const script = unwrapCommand(wrapped(entry.command, userHome), userHome) ?? entry.command;
    for (const found of script.matchAll(/-C\s+'([A-Za-z]:\\[^']+)'/g)) readRepos.add(found[1] ?? "");
    for (const found of script.matchAll(/-C\s+([A-Za-z]:\\[^\s;']+)/g)) readRepos.add(found[1] ?? "");
    for (const found of script.matchAll(/(?:repos\/|github\.com\/)([A-Za-z0-9-]+\/[A-Za-z0-9._-]+?)(?:\.git)?(?=[/\s'"?]|$)/g)) pairs.add(found[1] ?? "");
    for (const found of script.matchAll(/https:\/\/([A-Za-z0-9.-]+)/g)) hosts.add((found[1] ?? "").toLowerCase());
    for (const found of script.matchAll(/\$env:([A-Za-z_][A-Za-z0-9_]*)/g)) envNames.add(found[1] ?? "");
    const parsed = parseScript(script);
    if (!parsed.ok) continue;
    for (const statement of parsed.statements) {
      if (statement.kind !== "command" || statement.words[0] === undefined) continue;
      // A pwsh -NoProfile -File <script> prefix names its script, as an fmpy entry does.
      const pwshFile = /^pwsh(?:\.exe)?$/i.test(statement.words[0].value) && statement.words.length >= 4;
      firsts.add(JSON.stringify((pwshFile ? statement.words.slice(0, 4) : statement.words.slice(0, 1)).map((word) => word.value)));
    }
  }
  return {
    version: 1,
    task: "replay",
    live: true,
    writeDirs,
    scratchDirs: [tmpdir()],
    readRepos: [...readRepos].filter((repo) => !repo.includes("..")),
    netRead: { githubRepos: [...pairs].filter((pair) => !pair.includes("..")), hosts: [...hosts].filter((host) => host.includes(".")) },
    gitLocal: true,
    exec: [...firsts].flatMap((prefix) => (["scratch", "worktree", "notes"] as const).map((place) => ({ in: place, prefix: JSON.parse(prefix) as string[] }))),
    envNames: [...envNames],
  };
}

function safeList(dir: string): string[] {
  try {
    return readdirSync(dir, { withFileTypes: true })
      .filter((entry) => entry.isDirectory())
      .map((entry) => entry.name);
  } catch {
    return [];
  }
}

function realpath(path: string): string | null {
  try {
    return realpathSync.native(path);
  } catch (error) {
    const code = (error as NodeJS.ErrnoException).code;
    if (code === "ENOENT" || code === "ENOTDIR") return null;
    throw error;
  }
}

describe.skipIf(CORPUS === "")("private replay of real permission requests", () => {
  it("allows nothing in a forbidden class, and reports coverage by label", () => {
    const home = process.env.PERMIT_REPLAY_HOME ?? dirname(dirname(dirname(dirname(CORPUS))));
    const userHome = homedir();
    const entries = readCorpus(CORPUS);
    const permits = maximalPermits(entries, home, userHome);
    const byLabel = new Map<string, { total: number; allowed: number; rules: Map<string, number> }>();
    const wrong: string[] = [];
    entries.forEach((entry, index) => {
      let result: MatchResult;
      try {
        result = match(
          { provider: "codex", name: "CodexBash", kind: "tool", input: { command: wrapped(entry.command, userHome), cwd: entry.cwd } },
          permits,
          { crew: true, task: "replay", mode: "shadow", home, userHome, worktree: entry.cwd, sticky: false, allowsLastHour: 0, realpath },
        );
      } catch (error) {
        result = { verdict: "relay", rule: "error", tier: null, detail: String(error) };
      }
      const row = byLabel.get(entry.label) ?? { total: 0, allowed: 0, rules: new Map<string, number>() };
      row.total += 1;
      if (result.verdict === "allow") row.allowed += 1;
      row.rules.set(result.rule, (row.rules.get(result.rule) ?? 0) + 1);
      byLabel.set(entry.label, row);
      if (process.env.PERMIT_REPLAY_DETAIL === "1" && result.verdict === "relay") console.log(`#${index} ${entry.label} ${result.rule}: ${result.detail}`);
      if (result.verdict === "allow" && FORBIDDEN.test(entry.label)) wrong.push(`#${index} ${entry.label} allowed by ${result.rule}`);
    });
    const lines = ["| Label | Commands | Allowed | Share | Rules |", "| --- | --- | --- | --- | --- |"];
    let total = 0;
    let allowed = 0;
    for (const [label, row] of [...byLabel].sort(([a], [b]) => a.localeCompare(b))) {
      total += row.total;
      allowed += row.allowed;
      const rules = [...row.rules].sort(([, a], [, b]) => b - a).map(([rule, count]) => `${rule} ${count}`).join(", ");
      lines.push(`| ${label} | ${row.total} | ${row.allowed} | ${Math.round((100 * row.allowed) / row.total)}% | ${rules} |`);
    }
    lines.push(`| all | ${total} | ${allowed} | ${total === 0 ? 0 : Math.round((100 * allowed) / total)}% | |`);
    console.log(`\n${lines.join("\n")}\n\nForbidden classes allowed: ${wrong.length === 0 ? "none" : wrong.join("; ")}\n`);
    expect(wrong).toEqual([]);
  }, 300_000);
});
