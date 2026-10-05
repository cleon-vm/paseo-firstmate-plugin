import { EventEmitter } from "node:events";
import { mkdir, mkdtemp, realpath, rm, symlink, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, beforeEach, describe, expect, it } from "vitest";

import { explorerArgument, revealCommand, revealInHome, revealTarget, startDetached, type Spawner } from "./reveal";

let outer: string;
let home: string;

beforeEach(async () => {
  outer = await realpath(await mkdtemp(join(tmpdir(), "firstmate-reveal-")));
  home = join(outer, "home");
  await mkdir(join(home, "data", "scout, the second"), { recursive: true });
  await writeFile(join(home, "data", "scout, the second", "my report, v2.md"), "# Report\n");
  await writeFile(join(home, "AGENTS.md"), "charter");
  await writeFile(join(outer, "outside.md"), "not the home's");
});

afterEach(async () => {
  await rm(outer, { recursive: true, force: true });
});

/** A spawner that records what it was asked to start, and then starts, fails to start, or throws. */
function fakeSpawner(outcome: "spawn" | Error | "throw" = "spawn") {
  const calls: { command: string; args: string[]; options: Parameters<Spawner>[2] }[] = [];
  let unrefs = 0;
  const spawner: Spawner = (command, args, options) => {
    calls.push({ command, args, options });
    if (outcome === "throw") throw new Error("spawn EINVAL");
    const child = Object.assign(new EventEmitter(), { unref: () => void (unrefs += 1) });
    queueMicrotask(() => (outcome === "spawn" ? child.emit("spawn") : child.emit("error", outcome)));
    return child;
  };
  return { spawner, calls, unrefs: () => unrefs };
}

describe("explorerArgument", () => {
  it("quotes the path whole, so a space or a comma stays in it", () => {
    expect(explorerArgument("C:\\Users\\cap\\my files, old\\a b.md")).toBe('"C:\\Users\\cap\\my files, old\\a b.md"');
  });

  it("writes it with backslashes, normalized", () => {
    expect(explorerArgument("C:/Users/cap/./data/../AGENTS.md")).toBe('"C:\\Users\\cap\\AGENTS.md"');
  });

  it("drops a trailing backslash, which would escape the closing quote, except on a drive's root", () => {
    expect(explorerArgument("C:\\Users\\cap\\data\\")).toBe('"C:\\Users\\cap\\data"');
    expect(explorerArgument("D:\\")).toBe('"D:\\"');
  });

  it("keeps a network path", () => {
    expect(explorerArgument("\\\\server\\share\\a, b.txt")).toBe('"\\\\server\\share\\a, b.txt"');
  });

  it("refuses a relative path and one with a double quote", () => {
    expect(() => explorerArgument("data\\x.md")).toThrow(/not an absolute Windows path/);
    expect(() => explorerArgument('C:\\a"b.md')).toThrow(/double quote/);
  });
});

describe("revealCommand", () => {
  const env = { SystemRoot: "C:\\Windows" };

  it("selects a file in Explorer, by Explorer's full path, with the quotes passed verbatim", () => {
    expect(revealCommand("C:\\Users\\cap\\home\\data\\a, b c.md", "file", "win32", env)).toEqual({
      command: "C:\\Windows\\explorer.exe",
      args: ['/select,"C:\\Users\\cap\\home\\data\\a, b c.md"'],
      verbatim: true,
      manager: "Explorer",
    });
  });

  it("opens a folder in Explorer", () => {
    expect(revealCommand("C:\\Users\\cap\\home\\data", "dir", "win32", env)).toMatchObject({
      command: "C:\\Windows\\explorer.exe",
      args: ['"C:\\Users\\cap\\home\\data"'],
      verbatim: true,
    });
  });

  it("finds the Windows folder from windir, or assumes C:\\Windows", () => {
    expect(revealCommand("C:\\x.md", "file", "win32", { windir: "E:\\WINNT" }).command).toBe("E:\\WINNT\\explorer.exe");
    expect(revealCommand("C:\\x.md", "file", "win32", {}).command).toBe("C:\\Windows\\explorer.exe");
  });

  it("reveals a file in Finder and opens a folder there, one argument each", () => {
    expect(revealCommand("/Users/cap/home/a, b c.md", "file", "darwin")).toEqual({
      command: "/usr/bin/open",
      args: ["-R", "/Users/cap/home/a, b c.md"],
      verbatim: false,
      manager: "Finder",
    });
    expect(revealCommand("/Users/cap/home/data", "dir", "darwin").args).toEqual(["/Users/cap/home/data"]);
  });

  it("opens a file's folder, or the folder itself, with xdg-open elsewhere", () => {
    expect(revealCommand("/home/cap/fm/data/a b.md", "file", "linux")).toEqual({
      command: "xdg-open",
      args: ["/home/cap/fm/data"],
      verbatim: false,
      manager: "the file manager",
    });
    expect(revealCommand("/home/cap/fm/data", "dir", "freebsd").args).toEqual(["/home/cap/fm/data"]);
  });

  it("refuses a relative path on POSIX, which could be read as an option", () => {
    expect(() => revealCommand("-R", "file", "darwin")).toThrow(/not an absolute path/);
    expect(() => revealCommand("data/a.md", "file", "linux")).toThrow(/not an absolute path/);
  });
});

describe("startDetached", () => {
  it("starts the program detached, without a shell or a window hidden, and does not wait for it", async () => {
    const fake = fakeSpawner();
    await startDetached(revealCommand("C:\\a b.md", "file", "win32", {}), fake.spawner);
    expect(fake.calls).toHaveLength(1);
    expect(fake.calls[0]!.options).toMatchObject({
      detached: true,
      stdio: "ignore",
      shell: false,
      windowsHide: false,
      windowsVerbatimArguments: true,
    });
    expect(fake.unrefs()).toBe(1);
  });

  it("passes POSIX arguments for Node to quote", async () => {
    const fake = fakeSpawner();
    await startDetached(revealCommand("/a b.md", "file", "darwin"), fake.spawner);
    expect(fake.calls[0]!.options.windowsVerbatimArguments).toBe(false);
  });

  it("says which program was missing", async () => {
    const missing = Object.assign(new Error("spawn xdg-open ENOENT"), { code: "ENOENT" });
    const fake = fakeSpawner(missing);
    await expect(startDetached(revealCommand("/a.md", "file", "linux"), fake.spawner)).rejects.toThrow(
      "xdg-open was not found, so the file manager could not be opened.",
    );
  });

  it("passes on any other failure to start, thrown or reported", async () => {
    await expect(startDetached(revealCommand("/a.md", "file", "linux"), fakeSpawner(new Error("EACCES")).spawner)).rejects.toThrow("EACCES");
    await expect(startDetached(revealCommand("/a.md", "file", "linux"), fakeSpawner("throw").spawner)).rejects.toThrow("EINVAL");
  });
});

describe("revealTarget", () => {
  it("finds a file in the home, by its real path", async () => {
    await expect(revealTarget(home, "data/scout, the second/my report, v2.md")).resolves.toEqual({
      path: "data/scout, the second/my report, v2.md",
      absolute: join(home, "data", "scout, the second", "my report, v2.md"),
      kind: "file",
    });
  });

  it("takes backslashes, and finds folders and the home itself", async () => {
    await expect(revealTarget(home, "data\\scout, the second")).resolves.toMatchObject({ path: "data/scout, the second", kind: "dir" });
    await expect(revealTarget(home, "")).resolves.toMatchObject({ path: "", absolute: home, kind: "dir" });
  });

  it("refuses anything missing", async () => {
    await expect(revealTarget(home, "data/nothing.md")).rejects.toThrow('"data/nothing.md" does not exist');
  });

  it("refuses paths outside the home: up, absolute, or a drive", async () => {
    await expect(revealTarget(home, "../outside.md")).rejects.toThrow(/outside the home/);
    await expect(revealTarget(home, "data/../../outside.md")).rejects.toThrow(/outside the home/);
    await expect(revealTarget(home, join(outer, "outside.md"))).rejects.toThrow(/not a path inside the home/);
    await expect(revealTarget(home, "C:\\Windows\\explorer.exe")).rejects.toThrow(/not a path inside the home/);
    await expect(revealTarget(home, "/etc/passwd")).rejects.toThrow(/not a path inside the home/);
  });

  it("refuses a junction or symlink that leads out of the home, and anything through it", async () => {
    // A junction needs no privilege on Windows; elsewhere the type is ignored.
    await symlink(outer, join(home, "escape"), "junction");
    await expect(revealTarget(home, "escape")).rejects.toThrow(/leads outside the home/);
    await expect(revealTarget(home, "escape/outside.md")).rejects.toThrow(/leads outside the home/);
  });

  it("shows a link inside the home as what it points to", async () => {
    await symlink(join(home, "data"), join(home, "shortcut"), "junction");
    await expect(revealTarget(home, "shortcut")).resolves.toMatchObject({ absolute: join(home, "data"), kind: "dir" });
  });

  it("refuses a dangling link", async () => {
    await symlink(join(home, "gone"), join(home, "dangling"), "junction");
    await expect(revealTarget(home, "dangling")).rejects.toThrow(/does not exist/);
  });
});

describe("revealInHome", () => {
  it("starts Explorer on the file with it selected, and says where", async () => {
    const fake = fakeSpawner();
    const result = await revealInHome(home, "data/scout, the second/my report, v2.md", {
      platform: "win32",
      env: { SystemRoot: "C:\\Windows" },
      spawner: fake.spawner,
    });
    expect(result).toMatchObject({ path: "data/scout, the second/my report, v2.md", kind: "file", manager: "Explorer" });
    expect(result.host.length).toBeGreaterThan(0);
    const absolute = join(home, "data", "scout, the second", "my report, v2.md");
    expect(fake.calls[0]!.args).toEqual([`/select,${explorerArgument(absolute)}`]);
  });

  it("starts nothing for a path it refuses", async () => {
    const fake = fakeSpawner();
    await expect(revealInHome(home, "../outside.md", { platform: "win32", spawner: fake.spawner })).rejects.toThrow();
    await expect(revealInHome(home, "missing.md", { platform: "darwin", spawner: fake.spawner })).rejects.toThrow();
    expect(fake.calls).toEqual([]);
  });
});
