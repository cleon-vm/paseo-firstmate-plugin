/**
 * Runs one watch script: as it is, by its `#!` line, with its own process group so a timeout takes its
 * children (`gh`, `curl`) with it. Once a run is stopped — timed out, or the plugin shutting down — the
 * group gets SIGTERM and, after the grace period, SIGKILL whatever has happened in between: the script
 * exiting on SIGTERM does not mean a child that ignores it, and has let go of the pipes, is gone too.
 *
 * What it prints is kept up to a cap and read to the end regardless, so a chatty script never blocks on
 * a full pipe; stderr is kept as its last lines, which is where an error usually is.
 *
 * **Windows** has neither a `#!` line that means anything nor process groups: the interpreter the line
 * names is run explicitly (`watch-launch.ts`), without a console window, and a stopped run's whole
 * process tree is taken down at once with `taskkill /T /F`, which has no gentler first step.
 */
import { execFile, spawn, type ChildProcess } from "node:child_process";
import { open } from "node:fs/promises";
import { join } from "node:path";

import { parseShebang, realLaunchEnv, windowsLaunch, type LaunchEnv } from "./watch-launch";

export interface RunOptions {
  cwd: string;
  env: NodeJS.ProcessEnv;
  timeoutMs: number;
  /** The most of stdout kept, in bytes. */
  maxOutputBytes: number;
  /** The most of stderr kept, from its end, in bytes. */
  maxErrorBytes: number;
  /** After a timeout's SIGTERM, how long before SIGKILL. */
  killGraceMs?: number;
  /** Stops the script as a timeout would, for a plugin that is shutting down. */
  signal?: AbortSignal;
  /** Which platform's way of starting and stopping a script to use; the host's by default. For tests. */
  platform?: NodeJS.Platform;
  /** How Windows finds an interpreter; the real PATH and file system by default. For tests. */
  launchEnv?: LaunchEnv;
}

export interface RunResult {
  /** The exit code, or null when a signal ended it or it never started. */
  code: number | null;
  timedOut: boolean;
  stdout: string;
  /** stdout went past `maxOutputBytes` and was cut there. */
  truncated: boolean;
  stderr: string;
  /** Why it did not start — not found, not executable — or null. */
  spawnError: string | null;
}

function killGroup(pid: number | undefined, signal: NodeJS.Signals): void {
  if (pid === undefined) return;
  try {
    process.kill(-pid, signal);
  } catch {
    // Already gone.
  }
}

/**
 * Takes the process and everything it started down, on Windows. taskkill is run by its full path, since
 * PATH may not list System32; if it cannot be run, the script alone is killed so the run still ends.
 */
function killTree(child: ChildProcess): void {
  if (child.pid === undefined) return;
  const taskkill = join(process.env.SystemRoot ?? process.env.windir ?? "C:\\Windows", "System32", "taskkill.exe");
  execFile(taskkill, ["/PID", String(child.pid), "/T", "/F"], { windowsHide: true }, (error) => {
    // Exit 128 is "no such process": it was already gone. Anything else means taskkill itself failed.
    if (error !== null && (error.code as unknown) !== 128) child.kill("SIGKILL");
  });
}

/** The first bytes of a script, for its `#!` line. */
async function readHead(path: string): Promise<string> {
  const handle = await open(path, "r");
  try {
    const buffer = Buffer.alloc(512);
    const { bytesRead } = await handle.read(buffer, 0, buffer.length, 0);
    return buffer.subarray(0, bytesRead).toString("utf8");
  } finally {
    await handle.close();
  }
}

function notStarted(reason: string): RunResult {
  return { code: null, timedOut: false, stdout: "", truncated: false, stderr: "", spawnError: reason };
}

export async function runWatchScript(path: string, options: RunOptions): Promise<RunResult> {
  const windows = (options.platform ?? process.platform) === "win32";
  if (!windows) return spawnScript(path, [], options, false);
  if (options.signal?.aborted === true) return notStarted("the plugin stopped");
  let launch;
  try {
    launch = windowsLaunch(path, parseShebang(await readHead(path)), options.launchEnv ?? realLaunchEnv(options.env));
  } catch (error) {
    return notStarted(error instanceof Error ? error.message : String(error));
  }
  if ("error" in launch) return notStarted(launch.error);
  return spawnScript(launch.command, launch.args, options, true);
}

function spawnScript(command: string, args: string[], options: RunOptions, windows: boolean): Promise<RunResult> {
  return new Promise((resolve) => {
    // An abort that has already happened is never replayed to a listener added now, so check it here.
    if (options.signal?.aborted === true) {
      resolve(notStarted("the plugin stopped"));
      return;
    }
    const stdout: Buffer[] = [];
    let stdoutBytes = 0;
    let truncated = false;
    let stderr = Buffer.alloc(0);
    let timedOut = false;
    let spawnError: string | null = null;
    let settled = false;

    const child = spawn(command, args, {
      cwd: options.cwd,
      env: options.env,
      stdio: ["ignore", "pipe", "pipe"],
      // A process group on POSIX; on Windows it would only risk a console window.
      detached: !windows,
      windowsHide: true,
    });

    let killTimer: NodeJS.Timeout | undefined;
    function stop(): void {
      if (killTimer !== undefined) return;
      if (windows) {
        killTree(child);
        // The pid may be reused once the script is gone, so only a script still there is killed again.
        killTimer = setTimeout(() => {
          if (child.exitCode === null && child.signalCode === null) killTree(child);
        }, options.killGraceMs ?? 2000);
        return;
      }
      killGroup(child.pid, "SIGTERM");
      killTimer = setTimeout(() => killGroup(child.pid, "SIGKILL"), options.killGraceMs ?? 2000);
    }
    const timer = setTimeout(() => {
      timedOut = true;
      stop();
    }, options.timeoutMs);
    const abort = () => stop();
    options.signal?.addEventListener("abort", abort, { once: true });

    child.stdout.on("data", (chunk: Buffer) => {
      const room = options.maxOutputBytes - stdoutBytes;
      if (room <= 0) {
        truncated = true;
        return;
      }
      if (chunk.length > room) truncated = true;
      const kept = chunk.subarray(0, room);
      stdout.push(kept);
      stdoutBytes += kept.length;
    });
    child.stderr.on("data", (chunk: Buffer) => {
      stderr = Buffer.concat([stderr, chunk]);
      if (stderr.length > options.maxErrorBytes) stderr = stderr.subarray(stderr.length - options.maxErrorBytes);
    });

    function finish(code: number | null): void {
      if (settled) return;
      settled = true;
      clearTimeout(timer);
      // A pending SIGKILL is left to fire: it is for the group, not for the script alone.
      options.signal?.removeEventListener("abort", abort);
      resolve({
        code,
        timedOut,
        stdout: Buffer.concat(stdout).toString("utf8"),
        truncated,
        stderr: stderr.toString("utf8"),
        spawnError,
      });
    }

    child.on("error", (error) => {
      spawnError = error.message;
      finish(null);
    });
    child.on("close", (code) => finish(code));
  });
}
