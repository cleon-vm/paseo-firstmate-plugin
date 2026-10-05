/**
 * A file or folder in the home, shown in the file manager of the machine the
 * daemon runs on — Explorer, Finder, or whatever `xdg-open` picks. That is
 * the captain's desktop when Paseo runs there; from a phone or another
 * computer, the window still opens on the daemon's machine.
 *
 * The path is confined exactly as a read is (`resolveInHome`: no `..`, no
 * absolute path, no symlink or junction that lands outside), and then
 * resolved to its real path, which is checked again and is what gets shown,
 * so the file manager is pointed at the very thing that was checked. Only an
 * existing file or folder is shown.
 *
 * The file manager is started from an argument list, never through a shell,
 * and not waited on: Explorer exits non-zero even when it worked, so all that
 * counts is that it started.
 */
import type { SpawnOptions } from "node:child_process";
import { spawn } from "node:child_process";
import { realpath, stat } from "node:fs/promises";
import { hostname } from "node:os";
import { isAbsolute, posix, relative, win32 } from "node:path";

import { resolveInHome } from "./files";

export type RevealKind = "file" | "dir";

/** How to show one path: a program and its arguments, as `spawn` takes them. */
export interface RevealCommand {
  command: string;
  args: string[];
  /**
   * Windows only: pass `args` to the program exactly as written. Node would
   * otherwise quote `/select,"C:\a b\x"` into a form Explorer does not read,
   * so the quotes are written here instead (see `explorerArgument`).
   */
  verbatim: boolean;
  /** What to call the program in a message. */
  manager: string;
}

/**
 * A path for Explorer's command line, in the double quotes that keep a
 * space or a comma — which Explorer otherwise splits its arguments at — inside
 * the path. A double quote cannot be in a Windows file name, so none can end
 * the quoted part early; one is refused all the same rather than trusted.
 */
export function explorerArgument(absolute: string): string {
  const path = win32.normalize(absolute);
  if (!win32.isAbsolute(path)) throw new Error(`"${absolute}" is not an absolute Windows path.`);
  if (path.includes('"')) throw new Error(`"${absolute}" has a double quote in it, which Explorer cannot be given.`);
  // A trailing backslash would escape the closing quote; only a drive's root keeps one.
  const trimmed = /^[a-zA-Z]:\\$/.test(path) ? path : path.replace(/\\+$/, "");
  return `"${trimmed}"`;
}

/**
 * The command that shows `absolute`, a file or a folder, on `platform`: on
 * Windows, Explorer with the file selected in its folder, or the folder
 * opened; on macOS, Finder the same way (`open -R`, `open`); elsewhere,
 * `xdg-open` on the file's folder, or on the folder itself.
 */
export function revealCommand(
  absolute: string,
  kind: RevealKind,
  platform: NodeJS.Platform = process.platform,
  env: NodeJS.ProcessEnv = process.env,
): RevealCommand {
  if (platform === "win32") {
    // By full path: the daemon's PATH may not have the Windows folder, and nothing else named explorer should run.
    const explorer = win32.join(env.SystemRoot ?? env.windir ?? "C:\\Windows", "explorer.exe");
    const target = explorerArgument(absolute);
    return { command: explorer, args: [kind === "file" ? `/select,${target}` : target], verbatim: true, manager: "Explorer" };
  }
  // An absolute POSIX path starts with `/`, so neither program can take it for an option.
  if (!posix.isAbsolute(absolute)) throw new Error(`"${absolute}" is not an absolute path.`);
  if (platform === "darwin") {
    return { command: "/usr/bin/open", args: kind === "file" ? ["-R", absolute] : [absolute], verbatim: false, manager: "Finder" };
  }
  return {
    command: "xdg-open",
    args: [kind === "file" ? posix.dirname(absolute) : absolute],
    verbatim: false,
    manager: "the file manager",
  };
}

/** The part of a child process a reveal uses: whether it started. */
export interface StartedProcess {
  once(event: "spawn", listener: () => void): unknown;
  once(event: "error", listener: (error: Error) => void): unknown;
  unref(): void;
}

export type Spawner = (command: string, args: string[], options: SpawnOptions) => StartedProcess;

/**
 * Starts `command` on its own and resolves once it has started, without
 * waiting for it to exit; rejects when it cannot start at all.
 */
export function startDetached(command: RevealCommand, spawner: Spawner = spawn): Promise<void> {
  return new Promise((resolve, reject) => {
    let child: StartedProcess;
    try {
      child = spawner(command.command, command.args, {
        detached: true,
        stdio: "ignore",
        // Explorer's window is the point, and it has no console to hide; hiding it could hide the window.
        windowsHide: false,
        windowsVerbatimArguments: command.verbatim,
        shell: false,
      });
    } catch (error) {
      reject(error);
      return;
    }
    child.once("error", (error) =>
      reject(
        (error as NodeJS.ErrnoException).code === "ENOENT"
          ? new Error(`${command.command} was not found, so ${command.manager} could not be opened.`)
          : error,
      ),
    );
    child.once("spawn", () => {
      child.unref();
      resolve();
    });
  });
}

function isInside(root: string, candidate: string): boolean {
  const between = relative(root, candidate);
  return between === "" || (!between.startsWith("..") && !isAbsolute(between));
}

/** The real path and kind of `path`, an existing file or folder in the home, or a clear refusal. */
export async function revealTarget(home: string, path: string): Promise<{ path: string; absolute: string; kind: RevealKind }> {
  const { absolute, relative: rel } = await resolveInHome(home, path);
  const shown = rel === "" ? "The home" : `"${rel}"`;
  let real: string;
  try {
    real = await realpath(absolute);
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code === "ENOENT") throw new Error(`${shown} does not exist, so there is nothing to show.`);
    throw error;
  }
  // `resolveInHome` checked this already; the real path is what is shown, so it is checked again as that.
  if (!isInside(await realpath(home), real)) throw new Error(`${shown} leads outside the home.`);
  const info = await stat(real);
  if (!info.isFile() && !info.isDirectory()) throw new Error(`${shown} is neither a file nor a folder.`);
  return { path: rel, absolute: real, kind: info.isDirectory() ? "dir" : "file" };
}

export interface RevealDeps {
  platform?: NodeJS.Platform;
  env?: NodeJS.ProcessEnv;
  spawner?: Spawner;
}

/** What `firstmate.files.reveal` does: shows `path` in the daemon machine's file manager. */
export async function revealInHome(
  home: string,
  path: string,
  deps: RevealDeps = {},
): Promise<{ path: string; kind: RevealKind; manager: string; host: string }> {
  const target = await revealTarget(home, path);
  const command = revealCommand(target.absolute, target.kind, deps.platform, deps.env);
  await startDetached(command, deps.spawner);
  return { path: target.path, kind: target.kind, manager: command.manager, host: hostname() };
}
