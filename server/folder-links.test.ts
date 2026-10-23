import { EventEmitter } from "node:events";
import { mkdir, mkdtemp, realpath, symlink, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join, parse } from "node:path";
import { beforeAll, describe, expect, it, vi } from "vitest";

import {
  cleanFolderPath,
  findLinkPaths,
  folderTarget,
  isDeniedFolder,
  openLinkPath,
  type FolderLinkSettings,
} from "./folder-links";
import { findDataPaths, openDataPath } from "../shared/files";
import { FirstmateConfigPatchSchema, FirstmateConfigSchema } from "../shared/fleet";
import { revealCommand, type Spawner } from "./reveal";

const on: FolderLinkSettings = { enabled: true, deny: [] };
let outer: string;
let home: string;
beforeAll(async () => {
  outer = await realpath(await mkdtemp(join(tmpdir(), "folder-links-")));
  home = join(outer, "home");
  await mkdir(join(home, "data", "task"), { recursive: true });
  await writeFile(join(home, "data", "task", "report.md"), "# Report");
  await mkdir(join(outer, "projects", "demo app"), { recursive: true });
  await mkdir(join(outer, "projects", "other"), { recursive: true });
  await mkdir(join(outer, "keys", ".ssh"), { recursive: true });
  await mkdir(join(outer, "work", ".git", "hooks"), { recursive: true });
  await mkdir(join(outer, "work", ".github"), { recursive: true });
  await writeFile(join(outer, "projects", "notes.txt"), "plain file");
  await writeFile(join(outer, "projects", "run.cmd"), "echo MUST_NOT_RUN");
});

function spawner() {
  return vi.fn<Spawner>(() => {
    const child = Object.assign(new EventEmitter(), { unref: vi.fn() });
    queueMicrotask(() => child.emit("spawn"));
    return child;
  });
}

describe("cleanFolderPath", () => {
  it.each([
    ["C:\\projects\\demo", "C:\\projects\\demo"],
    ["C:/projects/demo", "C:\\projects\\demo"],
    ["  D:\\a\\\\b  ", "D:\\a\\b"],
    ["C:\\", "C:\\"],
    ["C:/", "C:\\"],
  ])("accepts the Windows path %s", (input, clean) => {
    expect(cleanFolderPath(input, { platform: "win32" })).toBe(clean);
  });

  it.each([
    "\\\\server\\share\\x", "//server/share/x", "\\\\.\\C:\\", "\\\\?\\C:\\x", "//./C:/x", "//?/C:/x",
    "C:\\a\\..\\b", "C:\\..", "C:relative", "C:", "\\x", "/x", "projects\\demo", "..\\x", "", "   ", "~user\\x",
    "C:\\a:stream", "C:\\a<b", "C:\\a\u0000b", `C:\\${"a".repeat(1100)}`,
  ])("refuses %j on Windows", (input) => {
    expect(cleanFolderPath(input, { platform: "win32", homeDirectory: "C:\\Users\\demo" })).toBeNull();
  });

  it("expands ~ and ~/ against the daemon's home directory on Windows", () => {
    expect(cleanFolderPath("~\\Downloads", { platform: "win32", homeDirectory: "C:\\Users\\demo" })).toBe("C:\\Users\\demo\\Downloads");
    expect(cleanFolderPath("~/Downloads", { platform: "win32", homeDirectory: "C:\\Users\\demo" })).toBe("C:\\Users\\demo\\Downloads");
  });

  it("accepts POSIX paths and ~, and refuses what is not absolute there", () => {
    expect(cleanFolderPath("/home/user/projects/demo", { platform: "linux" })).toBe("/home/user/projects/demo");
    expect(cleanFolderPath("//home//user/", { platform: "linux" })).toBeNull();
    expect(cleanFolderPath("/home//user/x", { platform: "linux" })).toBe("/home/user/x");
    expect(cleanFolderPath("/", { platform: "linux" })).toBe("/");
    expect(cleanFolderPath("~/projects", { platform: "linux", homeDirectory: "/home/user" })).toBe("/home/user/projects");
    expect(cleanFolderPath("~", { platform: "linux", homeDirectory: "/home/user" })).toBe("/home/user");
    for (const bad of ["/a/../b", "a/b", "C:\\projects", "~root/x", "./x", "/a\nb"]) {
      expect(cleanFolderPath(bad, { platform: "linux", homeDirectory: "/home/user" })).toBeNull();
    }
  });
});

describe("isDeniedFolder", () => {
  it.each([
    "/home/user/.ssh", "/home/user/.SSH/keys", "C:\\Users\\demo\\.gnupg", "/home/user/.aws/sso", "/x/.azure", "/x/.kube/cache",
    "/x/.docker", "/work/.git", "/work/.git/hooks", "C:\\work\\.git\\objects", "/home/user/.password-store",
    "C:\\Users\\demo\\AppData\\Local\\Google\\Chrome\\User Data\\Default", "/home/user/.mozilla/firefox",
    "/home/user/.config/google-chrome", "/Users/demo/Library/Keychains", "C:\\Users\\demo\\AppData\\Roaming\\Mozilla\\Firefox\\Profiles\\x",
  ])("refuses %s", (path) => {
    expect(isDeniedFolder(path)).toBe(true);
  });

  it.each(["/home/user/projects/demo", "/work/.github", "/work/gitrepo", "/home/user/ssh", "C:\\projects\\.gitignore-notes", "/home/user/.config/other", "/x/chrome"])("allows %s", (path) => {
    expect(isDeniedFolder(path)).toBe(false);
  });

  it("adds the configured patterns, with wildcards and multi-segment names, case-insensitively", () => {
    expect(isDeniedFolder("/x/Vault/a", ["vault"])).toBe(true);
    expect(isDeniedFolder("/x/team/secrets-2024", ["secrets-*"])).toBe(true);
    expect(isDeniedFolder("/x/a/b/c", ["a/b"])).toBe(true);
    expect(isDeniedFolder("/x/b/a", ["a/b"])).toBe(false);
    expect(isDeniedFolder("C:\\private\\x", ["C:\\private"])).toBe(true);
    expect(isDeniedFolder("D:\\private\\x", ["C:\\private"])).toBe(false);
    expect(isDeniedFolder("/x/a.b", ["a.b"])).toBe(true);
    expect(isDeniedFolder("/x/axb", ["a.b"])).toBe(false);
    expect(isDeniedFolder("/x/y", ["", "  ", "/"])).toBe(false);
  });
});

describe("folderTarget", () => {
  it("accepts an existing folder, with spaces and a trailing separator, as its real path", async () => {
    expect(await folderTarget(join(outer, "projects", "demo app"), on)).toEqual({ path: join(outer, "projects", "demo app"), absolute: join(outer, "projects", "demo app") });
    expect(await folderTarget(`${join(outer, "projects")}/`, on)).toMatchObject({ path: join(outer, "projects") });
  });

  it("allows a drive or filesystem root", async () => {
    const root = parse(outer).root;
    expect(await folderTarget(root, on)).toMatchObject({ path: root });
  });

  it("leaves files, missing paths and relative or escaping input unlinked", async () => {
    for (const path of [join(outer, "projects", "notes.txt"), join(outer, "projects", "run.cmd"), join(outer, "missing"),
      `${join(outer, "projects", "other")}${"/"}..${"/"}other`, "projects/demo", "..", "", ".", "~nobody/x"]) {
      expect(await folderTarget(path, on)).toBeNull();
    }
  });

  it("is off when the setting is off", async () => {
    expect(await folderTarget(join(outer, "projects"), { enabled: false, deny: [] })).toBeNull();
  });

  it("refuses credential locations and anything inside them, and the extra patterns", async () => {
    expect(await folderTarget(join(outer, "keys", ".ssh"), on)).toBeNull();
    expect(await folderTarget(join(outer, "work", ".git"), on)).toBeNull();
    expect(await folderTarget(join(outer, "work", ".git", "hooks"), on)).toBeNull();
    // The repository's working folder and look-alike names stay linkable.
    expect(await folderTarget(join(outer, "work"), on)).not.toBeNull();
    expect(await folderTarget(join(outer, "work", ".github"), on)).not.toBeNull();
    expect(await folderTarget(join(outer, "projects", "other"), { enabled: true, deny: ["other"] })).toBeNull();
  });

  it("resolves a link or junction to its real folder, and judges that target", async () => {
    await symlink(join(outer, "projects", "other"), join(outer, "alias"), "junction");
    expect(await folderTarget(join(outer, "alias"), on)).toEqual({ path: join(outer, "projects", "other"), absolute: join(outer, "projects", "other") });
    // An innocent name that leads to a credential folder is refused, as is one the extra list names after resolution.
    await symlink(join(outer, "keys", ".ssh"), join(outer, "innocent"), "junction");
    expect(await folderTarget(join(outer, "innocent"), on)).toBeNull();
    expect(await folderTarget(join(outer, "alias"), { enabled: true, deny: ["other"] })).toBeNull();
    // A link to a file is not a folder.
    await symlink(join(outer, "projects", "notes.txt"), join(outer, "filelink"), "file").catch(() => undefined);
    expect(await folderTarget(join(outer, "filelink"), on)).toBeNull();
  });
});

describe("findLinkPaths and openLinkPath", () => {
  it("keeps data paths as data links and adds folders anywhere as folder links", async () => {
    const demo = join(outer, "projects", "demo app");
    const found = await findLinkPaths(home, ["data/task", "data/task/report.md", "data/missing", demo, join(outer, "projects", "notes.txt"), join(outer, "keys", ".ssh"), "\\\\server\\share"], on);
    expect(found).toEqual({ paths: {
      "data/task": { path: "data/task", kind: "dir", action: "data" },
      "data/task/report.md": { path: "data/task/report.md", kind: "file", action: "data" },
      [demo]: { path: demo, kind: "dir", action: "folder" },
    } });
  });

  it("finds no folder links when the setting is off, and still finds data paths", async () => {
    const found = await findLinkPaths(home, ["data/task", join(outer, "projects")], { enabled: false, deny: [] });
    expect(Object.keys(found.paths)).toEqual(["data/task"]);
  });

  it("opens only a folder, in the file manager, never through a shell", async () => {
    const spawn = spawner();
    const demo = join(outer, "projects", "demo app");
    expect(await openLinkPath(home, { path: demo, revealFile: false, action: "folder" }, on, { spawner: spawn }))
      .toEqual({ path: demo, kind: "dir", view: false });
    expect(spawn).toHaveBeenCalledOnce();
    // The folder itself is shown (never `/select` or `open -R`, which pick a file), by an argument list.
    const shown = revealCommand(demo, "dir");
    expect(spawn.mock.calls[0]?.slice(0, 2)).toEqual([shown.command, shown.args]);
    expect(spawn.mock.calls[0]?.[1]).not.toContain("-R");
    expect(spawn.mock.calls[0]?.[1][0]).not.toMatch(/^\/select/);
    expect(spawn.mock.calls[0]?.[2]).toMatchObject({ shell: false, detached: true });
  });

  it("refuses every click that is not a linkable folder, without starting anything", async () => {
    const spawn = spawner();
    const deps = { platform: "win32" as const, spawner: spawn };
    const refused = { path: null, kind: null, view: false };
    for (const path of [join(outer, "projects", "run.cmd"), join(outer, "projects", "notes.txt"), join(outer, "missing"), join(outer, "keys", ".ssh"),
      join(outer, "work", ".git"), "..", "C:\\a\\..\\b", "\\\\server\\share", "\\\\.\\C:\\", "\\\\?\\C:\\", "", "projects/demo"]) {
      expect(await openLinkPath(home, { path, revealFile: false, action: "folder" }, on, deps)).toEqual(refused);
    }
    expect(await openLinkPath(home, { path: join(outer, "projects"), revealFile: false, action: "folder" }, { enabled: false, deny: [] }, deps)).toEqual(refused);
    // A folder click never takes the data route, and a data click never opens a folder outside data/.
    expect(await openLinkPath(home, { path: "data/task", revealFile: false, action: "folder" }, on, deps)).toEqual(refused);
    expect(await openLinkPath(home, { path: join(outer, "projects"), revealFile: false, action: "data" }, on, deps)).toEqual(refused);
    expect(spawn).not.toHaveBeenCalled();
  });

  it("leaves the data click unchanged and ignores the folder setting for it", async () => {
    const spawn = spawner();
    expect(await openLinkPath(home, { path: "data/task/report.md", revealFile: false, action: "data" }, { enabled: false, deny: [] }, { spawner: spawn }))
      .toEqual({ path: "data/task/report.md", kind: "file", view: true });
    expect(await openLinkPath(home, { path: "data/task", revealFile: false, action: "data" }, { enabled: false, deny: [] }, { platform: "win32", spawner: spawn }))
      .toEqual({ path: "data/task", kind: "dir", view: false });
    expect(spawn).toHaveBeenCalledOnce();
  });
});

describe("settings and the link contract", () => {
  it("defaults to folder links on with no extra patterns, and the patch carries both fields", () => {
    expect(FirstmateConfigSchema.parse({})).toMatchObject({ folderLinks: true, folderLinkDeny: [] });
    expect(FirstmateConfigPatchSchema.parse({ folderLinks: false, folderLinkDeny: ["vault"] })).toEqual({ folderLinks: false, folderLinkDeny: ["vault"] });
    expect(FirstmateConfigPatchSchema.parse({})).toEqual({});
  });

  it("keeps the old data click and find shapes valid, defaulting to the data action", () => {
    expect(openDataPath.input.parse({ path: "data/x" })).toEqual({ path: "data/x", revealFile: false, action: "data" });
    expect(openDataPath.input.parse({ path: "C:/x", action: "folder" })).toMatchObject({ action: "folder" });
    expect(openDataPath.input.safeParse({ path: "C:/x", action: "file" }).success).toBe(false);
    expect(findDataPaths.output.parse({ paths: { "data/x": { path: "data/x", kind: "dir" } } }).paths["data/x"]?.action).toBe("data");
  });
});
