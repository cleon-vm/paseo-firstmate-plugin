import { mkdtemp, mkdir, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, beforeEach, describe, expect, it } from "vitest";

import { listWatches } from "./watch-files";
import { findGitBash, parseShebang, windowsLaunch, type LaunchEnv } from "./watch-launch";
import { runWatchScript } from "./watch-run";

/** A Windows machine that has exactly these files. */
function machine(files: string[], env: NodeJS.ProcessEnv = {}): LaunchEnv {
  const have = new Set(files.map((file) => file.toLowerCase()));
  return { env, isFile: (path) => have.has(path.toLowerCase()) };
}

const NODE = "C:\\Program Files\\nodejs\\node.exe";
const GIT_BASH = "C:\\Program Files\\Git\\bin\\bash.exe";
const SCRIPT = "C:\\Users\\me\\home\\watches\\pr-watch";

describe("parseShebang", () => {
  it("reads env and direct interpreters", () => {
    expect(parseShebang("#!/usr/bin/env node\n// x")).toEqual({ name: "node", args: [] });
    expect(parseShebang("#!/usr/bin/node\n")).toEqual({ name: "node", args: [] });
    expect(parseShebang("#!/usr/bin/env python3\r\nprint()")).toEqual({ name: "python3", args: [] });
    expect(parseShebang("#! /bin/bash -e\n")).toEqual({ name: "bash", args: ["-e"] });
    expect(parseShebang("#!C:\\Tools\\Node.EXE\n")).toEqual({ name: "node", args: [] });
  });

  it("skips env's options and assignments, and keeps the interpreter's own arguments", () => {
    expect(parseShebang("#!/usr/bin/env -S node --no-warnings\n")).toEqual({ name: "node", args: ["--no-warnings"] });
    expect(parseShebang("#!/usr/bin/env FOO=1 BAR=2 node\n")).toEqual({ name: "node", args: [] });
  });

  it("has none when the file does not start with #! or names nothing", () => {
    expect(parseShebang("// no shebang\n")).toBeNull();
    expect(parseShebang(" #!/usr/bin/env node\n")).toBeNull();
    expect(parseShebang("#!\n")).toBeNull();
    expect(parseShebang("#!/usr/bin/env\n")).toBeNull();
  });
});

describe("windowsLaunch", () => {
  it("runs node from PATH, never anything else, with the script as its argument", () => {
    const launch = machine([NODE], { Path: "C:\\Windows;C:\\Program Files\\nodejs" });
    expect(windowsLaunch(SCRIPT, parseShebang("#!/usr/bin/env node\n"), launch)).toEqual({ command: NODE, args: [SCRIPT] });
    expect(windowsLaunch(SCRIPT, parseShebang("#!/usr/bin/env -S node --x\n"), launch)).toEqual({
      command: NODE,
      args: ["--x", SCRIPT],
    });
  });

  it("falls back to the installer's folder when PATH does not list node", () => {
    const launch = machine([NODE], { PATH: "C:\\Windows", ProgramFiles: "C:\\Program Files" });
    expect(windowsLaunch(SCRIPT, parseShebang("#!/usr/bin/env node\n"), launch)).toEqual({ command: NODE, args: [SCRIPT] });
  });

  it("says which interpreter is missing", () => {
    const result = windowsLaunch(SCRIPT, parseShebang("#!/usr/bin/env node\n"), machine([], { PATH: "C:\\Windows" }));
    expect(result).toEqual({ error: expect.stringContaining("node was not found on PATH") });
  });

  it("has no launch without a #! line", () => {
    expect(windowsLaunch(SCRIPT, null, machine([NODE], { PATH: "C:\\Program Files\\nodejs" }))).toEqual({
      error: "it has no #! line saying what runs it",
    });
  });

  it("runs sh and bash with Git for Windows' bash, using forward slashes", () => {
    const launch = machine([GIT_BASH], { ProgramFiles: "C:\\Program Files" });
    expect(windowsLaunch(SCRIPT, parseShebang("#!/bin/sh\n"), launch)).toEqual({
      command: GIT_BASH,
      args: ["C:/Users/me/home/watches/pr-watch"],
    });
    expect(windowsLaunch(SCRIPT, parseShebang("#!/usr/bin/env bash\n"), launch)).toMatchObject({ command: GIT_BASH });
  });

  it("does not take WSL's bash, and says Git for Windows' is needed", () => {
    const launch = machine(["C:\\Windows\\System32\\bash.exe"], { PATH: "C:\\Windows\\System32" });
    expect(findGitBash(launch)).toBeNull();
    expect(windowsLaunch(SCRIPT, parseShebang("#!/bin/bash\n"), launch)).toEqual({
      error: expect.stringContaining("Git for Windows' bash was not found"),
    });
  });

  it("finds Git's bash from git.exe on PATH", () => {
    const launch = machine(["D:\\Tools\\Git\\cmd\\git.exe", "D:\\Tools\\Git\\bin\\bash.exe"], { PATH: "D:\\Tools\\Git\\cmd" });
    expect(findGitBash(launch)).toBe("D:\\Tools\\Git\\bin\\bash.exe");
  });

  it("maps python3 to python, then the py launcher, and skips the Store's stub", () => {
    const stub = "C:\\Users\\me\\AppData\\Local\\Microsoft\\WindowsApps\\python3.exe";
    const python = "C:\\Python\\python.exe";
    const path = "C:\\Users\\me\\AppData\\Local\\Microsoft\\WindowsApps;C:\\Python";
    expect(windowsLaunch(SCRIPT, parseShebang("#!/usr/bin/env python3\n"), machine([stub, python], { PATH: path }))).toEqual({
      command: python,
      args: [SCRIPT],
    });
    expect(windowsLaunch(SCRIPT, parseShebang("#!/usr/bin/env python3\n"), machine(["C:\\Windows\\py.exe"], { PATH: "C:\\Windows" }))).toEqual({
      command: "C:\\Windows\\py.exe",
      args: ["-3", SCRIPT],
    });
  });

  it("does not know an interpreter that is not on PATH", () => {
    expect(windowsLaunch(SCRIPT, parseShebang("#!/usr/bin/env ruby\n"), machine([], { PATH: "C:\\Windows" }))).toEqual({
      error: expect.stringContaining("ruby was not found on PATH"),
    });
  });
});

describe("watch validity by platform", () => {
  let home: string;
  beforeEach(async () => {
    home = await mkdtemp(join(tmpdir(), "fm-watch-"));
    await mkdir(join(home, "watches"));
  });
  afterEach(() => rm(home, { recursive: true, force: true }));

  const write = (name: string, text: string) => writeFile(join(home, "watches", name), text, { mode: 0o644 });

  it("does not ask for an execute bit on Windows, but still for a #! line", async () => {
    await write("good", "#!/usr/bin/env node\n// schedule: */5 * * * *\n");
    await write("bare", "// schedule: */5 * * * *\n");
    const watches = new Map((await listWatches(home, "win32")).map((watch) => [watch.name, watch]));
    expect(watches.get("good")?.invalid).toBeNull();
    expect(watches.get("good")?.schedule === null).toBe(false);
    expect(watches.get("bare")?.invalid).toBe("it has no #! line saying what runs it");
  });

  it("still asks for it everywhere else", async () => {
    await write("good", "#!/usr/bin/env node\n// schedule: */5 * * * *\n");
    for (const platform of ["linux", "darwin"] as const) {
      const [watch] = await listWatches(home, platform);
      expect(watch?.invalid).toBe("it is not executable (chmod +x)");
    }
  });
});

describe("runWatchScript on Windows, before anything is started", () => {
  const options = (launchEnv: LaunchEnv) => ({
    cwd: tmpdir(),
    env: launchEnv.env,
    timeoutMs: 1000,
    maxOutputBytes: 1000,
    maxErrorBytes: 1000,
    platform: "win32" as const,
    launchEnv,
  });
  let dir: string;
  beforeEach(async () => {
    dir = await mkdtemp(join(tmpdir(), "fm-run-"));
  });
  afterEach(() => rm(dir, { recursive: true, force: true }));

  it("reports an unknown interpreter as a spawn error, not a crash", async () => {
    const path = join(dir, "watch");
    await writeFile(path, "#!/usr/bin/env ruby\nputs 1\n");
    const result = await runWatchScript(path, options(machine([], { PATH: "C:\\Windows" })));
    expect(result).toMatchObject({ code: null, timedOut: false, stdout: "", spawnError: expect.stringContaining("ruby was not found") });
  });

  it("reports a missing file as a spawn error", async () => {
    const result = await runWatchScript(join(dir, "gone"), options(machine([])));
    expect(result.code).toBeNull();
    expect(result.spawnError).toContain("ENOENT");
  });

  it("does not start anything once the plugin has stopped", async () => {
    const path = join(dir, "watch");
    await writeFile(path, "#!/usr/bin/env node\n");
    const result = await runWatchScript(path, { ...options(machine([NODE], { PATH: "C:\\Program Files\\nodejs" })), signal: AbortSignal.abort() });
    expect(result.spawnError).toBe("the plugin stopped");
  });
});

// Real processes: only meaningful (and only run) on a Windows host.
describe.skipIf(process.platform !== "win32")("runWatchScript on this Windows machine", () => {
  let dir: string;
  beforeEach(async () => {
    dir = await mkdtemp(join(tmpdir(), "fm-real-"));
  });
  afterEach(() => rm(dir, { recursive: true, force: true }));
  const options = { cwd: tmpdir(), env: process.env, timeoutMs: 20_000, maxOutputBytes: 1000, maxErrorBytes: 1000 };

  it("runs a node script by its #! line and keeps stdout and the exit code", async () => {
    const path = join(dir, "watch");
    await writeFile(path, '#!/usr/bin/env node\nconsole.log("hello " + process.argv.length);\nconsole.error("warn");\nprocess.exit(3);\n');
    const result = await runWatchScript(path, options);
    expect(result).toMatchObject({ code: 3, timedOut: false, stdout: "hello 2\n", spawnError: null });
    expect(result.stderr).toContain("warn");
  });

  it("stops a script that runs too long, and its children with it", async () => {
    const path = join(dir, "watch");
    const marker = join(dir, "child-pid");
    await writeFile(
      path,
      `#!/usr/bin/env node
const { spawn } = require("node:child_process");
const child = spawn(process.execPath, ["-e", "setInterval(() => {}, 1000)"], { stdio: "ignore" });
require("node:fs").writeFileSync(${JSON.stringify(marker)}, String(child.pid));
setInterval(() => {}, 1000);
`,
    );
    const result = await runWatchScript(path, { ...options, timeoutMs: 1500, killGraceMs: 500 });
    expect(result.timedOut).toBe(true);
    const { readFile } = await import("node:fs/promises");
    const pid = Number(await readFile(marker, "utf8"));
    expect(pid).toBeGreaterThan(0);
    expect(() => process.kill(pid, 0)).toThrow();
  }, 30_000);
});
