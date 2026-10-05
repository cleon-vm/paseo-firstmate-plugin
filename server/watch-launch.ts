/**
 * How a watch script is started on Windows, where a `#!` line means nothing to the OS and there is no
 * execute bit: the line is read here and the interpreter it names is run explicitly, with the script as
 * its argument. POSIX runs the script as it is and never comes through here.
 *
 * `node` is always the one on PATH, never `process.execPath`: the plugin runs inside Paseo's own
 * Electron process, whose execPath is `Paseo.exe`; when PATH lacks it, the installer's own folder is tried.
 * `sh` and `bash` mean Git for Windows' bash; the
 * `bash.exe` in System32 is WSL's, which cannot read Windows paths, and is not used.
 */
import { statSync } from "node:fs";
import { win32 } from "node:path";

export interface Shebang {
  /** The interpreter's name: lower case, without directory or `.exe` (`node`, `python3`, `bash`). */
  name: string;
  /** Whatever followed the interpreter on the line. */
  args: string[];
}

/** The `#!` line of a script's text, or null when it has none. */
export function parseShebang(head: string): Shebang | null {
  if (!head.startsWith("#!")) return null;
  const line = head.slice(2).split(/\r\n|\r|\n/, 1)[0] ?? "";
  const tokens = line.trim().split(/\s+/).filter((token) => token !== "");
  const program = tokens.shift();
  if (program === undefined) return null;
  if (baseName(program) === "env") {
    // `#!/usr/bin/env [-S] [NAME=value ...] interpreter args`: the interpreter is the first thing that
    // is neither an option nor an assignment.
    while (tokens.length > 0 && (tokens[0]!.startsWith("-") || /^[A-Za-z_][A-Za-z0-9_]*=/.test(tokens[0]!))) {
      tokens.shift();
    }
    const named = tokens.shift();
    return named === undefined ? null : { name: baseName(named), args: tokens };
  }
  return { name: baseName(program), args: tokens };
}

function baseName(program: string): string {
  const last = program.split(/[\\/]/).pop() ?? program;
  return last.toLowerCase().replace(/\.exe$/, "");
}

export interface LaunchEnv {
  env: NodeJS.ProcessEnv;
  /** Whether a file exists there. */
  isFile: (path: string) => boolean;
}

export const realLaunchEnv = (env: NodeJS.ProcessEnv): LaunchEnv => ({
  env,
  isFile: (path) => {
    try {
      return statSync(path).isFile();
    } catch {
      return false;
    }
  },
});

/** A variable of the environment by name, whatever the case: Windows spells it `Path`, `PATH` or `path`. */
function variable(env: NodeJS.ProcessEnv, name: string): string | undefined {
  const key = Object.keys(env).find((candidate) => candidate.toLowerCase() === name.toLowerCase());
  return key === undefined ? undefined : env[key];
}

function pathDirectories(env: NodeJS.ProcessEnv): string[] {
  return (variable(env, "PATH") ?? "")
    .split(";")
    .map((entry) => entry.trim().replace(/^"(.*)"$/, "$1"))
    .filter((entry) => entry !== "");
}

/** Every `<name>.exe` (or `.com`) on PATH, in order. */
function onPath(name: string, launch: LaunchEnv): string[] {
  const found: string[] = [];
  for (const directory of pathDirectories(launch.env)) {
    for (const extension of [".exe", ".com"]) {
      const candidate = win32.join(directory, name + extension);
      if (launch.isFile(candidate)) found.push(candidate);
    }
  }
  return found;
}

/** Git for Windows' bash, or null. */
export function findGitBash(launch: LaunchEnv): string | null {
  const roots = [
    variable(launch.env, "ProgramFiles"),
    variable(launch.env, "ProgramW6432"),
    variable(launch.env, "ProgramFiles(x86)"),
    variable(launch.env, "LOCALAPPDATA") === undefined ? undefined : win32.join(variable(launch.env, "LOCALAPPDATA")!, "Programs"),
  ];
  for (const root of roots) {
    if (root === undefined) continue;
    for (const relative of ["Git\\bin\\bash.exe", "Git\\usr\\bin\\bash.exe"]) {
      const candidate = win32.join(root, relative);
      if (launch.isFile(candidate)) return candidate;
    }
  }
  // A git on PATH is at <Git>\cmd\git.exe (or <Git>\bin\git.exe): its bash is at <Git>\bin\bash.exe.
  for (const git of onPath("git", launch)) {
    const candidate = win32.join(win32.dirname(win32.dirname(git)), "bin", "bash.exe");
    if (launch.isFile(candidate)) return candidate;
  }
  // Any other bash on PATH, except WSL's launcher in System32 and the Store's alias stubs.
  return onPath("bash", launch).find((candidate) => !/\\(system32|windowsapps)\\/i.test(candidate)) ?? null;
}

/** Node.js where its installer puts it, for a PATH that does not list it. */
function installedNode(launch: LaunchEnv): string | undefined {
  const local = variable(launch.env, "LOCALAPPDATA");
  const roots = [
    variable(launch.env, "ProgramFiles"),
    variable(launch.env, "ProgramW6432"),
    local === undefined ? undefined : win32.join(local, "Programs"),
  ];
  return roots
    .filter((root): root is string => root !== undefined)
    .map((root) => win32.join(root, "nodejs", "node.exe"))
    .find((candidate) => launch.isFile(candidate));
}

export type Launch = { command: string; args: string[] } | { error: string };

/** The command that runs `script`, given its `#!` line; or why it cannot be run. */
export function windowsLaunch(script: string, shebang: Shebang | null, launch: LaunchEnv): Launch {
  if (shebang === null) return { error: "it has no #! line saying what runs it" };
  const { name } = shebang;
  const tail = [...shebang.args, script];
  if (name === "sh" || name === "bash") {
    const bash = findGitBash(launch);
    if (bash === null) return { error: `Git for Windows' bash was not found, and "#!/…/${name}" scripts need it` };
    return { command: bash, args: [...shebang.args, script.replace(/\\/g, "/")] };
  }
  if (/^python[0-9.]*$/.test(name)) {
    // `python3` does not exist on Windows unless it was made to; `python` and the `py` launcher do.
    const real = (candidate: string) => !/\\windowsapps\\/i.test(candidate);
    for (const candidate of [name, "python"]) {
      const python = onPath(candidate, launch).find(real);
      if (python !== undefined) return { command: python, args: tail };
    }
    const py = onPath("py", launch)[0];
    if (py !== undefined) return { command: py, args: name === "python2" ? ["-2", ...tail] : ["-3", ...tail] };
    return { error: `${name} was not found on PATH (needed for "#!/…/${name}")` };
  }
  const wanted = name === "nodejs" ? "node" : name;
  const found = onPath(wanted, launch)[0] ?? (wanted === "node" ? installedNode(launch) : undefined);
  if (found === undefined) return { error: `${wanted} was not found on PATH (needed for "#!/…/${name}")` };
  return { command: found, args: tail };
}
