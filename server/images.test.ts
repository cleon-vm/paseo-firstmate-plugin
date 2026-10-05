import { mkdir, mkdtemp, realpath, rm, symlink, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, beforeEach, describe, expect, it } from "vitest";

import { MAX_IMAGE_BYTES } from "../shared/images";
import { findMarkdownImage, imageCandidates, readHomeImageFile, readImageFile, sniffImageType } from "./images";

const PNG = Buffer.from([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a, 0, 0, 0, 13, 0x49, 0x48, 0x44, 0x52]);
const JPEG = Buffer.from([0xff, 0xd8, 0xff, 0xe0, 0, 16, 0x4a, 0x46, 0x49, 0x46]);
const GIF = Buffer.from("GIF89a\x01\x00\x01\x00", "latin1");
const WEBP = Buffer.concat([Buffer.from("RIFF"), Buffer.from([24, 0, 0, 0]), Buffer.from("WEBPVP8 ")]);
const HOSTILE_SVG = '<svg xmlns="http://www.w3.org/2000/svg" onload="alert(1)"><script>alert(2)</script></svg>';

let outer: string;
let home: string;

beforeEach(async () => {
  outer = await realpath(await mkdtemp(join(tmpdir(), "firstmate-images-")));
  home = join(outer, "home");
  await mkdir(join(home, "data", "scout"), { recursive: true });
  await writeFile(join(home, "data", "scout", "plot.png"), PNG);
  await writeFile(join(home, "data", "scout", "report.md"), "# Report\n");
  await writeFile(join(home, "top.png"), PNG);
  await writeFile(join(home, "data", "notes.txt"), "text");
  await writeFile(join(outer, "outside.png"), PNG);
});

afterEach(async () => {
  await rm(outer, { recursive: true, force: true });
});

describe("sniffImageType", () => {
  it("tells the raster types by their first bytes", () => {
    expect(sniffImageType(PNG)).toBe("image/png");
    expect(sniffImageType(JPEG)).toBe("image/jpeg");
    expect(sniffImageType(GIF)).toBe("image/gif");
    expect(sniffImageType(WEBP)).toBe("image/webp");
  });

  it("has no signature for SVG or text, nor for too few bytes", () => {
    expect(sniffImageType(Buffer.from(HOSTILE_SVG))).toBeNull();
    expect(sniffImageType(Buffer.from("hello"))).toBeNull();
    expect(sniffImageType(Buffer.from([0x89, 0x50]))).toBeNull();
    expect(sniffImageType(new Uint8Array())).toBeNull();
  });
});

describe("readImageFile", () => {
  it("reads an image in the home as base64, with its type, size and time", async () => {
    const image = await readImageFile(home, "data/scout/plot.png");
    expect(image).toMatchObject({ path: "data/scout/plot.png", mimeType: "image/png", size: PNG.length, tooLarge: false });
    expect(Buffer.from(image.data ?? "", "base64").equals(PNG)).toBe(true);
    expect(image.modifiedMs).toBeGreaterThan(0);
  });

  it("takes a Windows path with backslashes", async () => {
    const image = await readImageFile(home, "data\\scout\\plot.png");
    expect(image.path).toBe("data/scout/plot.png");
  });

  it("goes by the bytes, so a JPEG saved as .png draws as a JPEG", async () => {
    await writeFile(join(home, "photo.png"), JPEG);
    expect((await readImageFile(home, "photo.png")).mimeType).toBe("image/jpeg");
  });

  it("sends an SVG as an SVG image in base64, never as its markup", async () => {
    await writeFile(join(home, "drawing.svg"), HOSTILE_SVG);
    const image = await readImageFile(home, "drawing.svg");
    expect(image.mimeType).toBe("image/svg+xml");
    expect(image.data).not.toContain("<");
    expect(Buffer.from(image.data ?? "", "base64").toString("utf8")).toBe(HOSTILE_SVG);
  });

  it("never calls a raster-named file holding SVG markup an SVG", async () => {
    await writeFile(join(home, "sneaky.png"), HOSTILE_SVG);
    expect((await readImageFile(home, "sneaky.png")).mimeType).toBe("image/png");
  });

  it("holds back an image over the cap, with its size", async () => {
    await writeFile(join(home, "big.png"), Buffer.concat([PNG, Buffer.alloc(100)]));
    const image = await readImageFile(home, "big.png", PNG.length + 99);
    expect(image).toMatchObject({ path: "big.png", data: null, tooLarge: true, size: PNG.length + 100 });
    expect((await readImageFile(home, "big.png", PNG.length + 100)).tooLarge).toBe(false);
  });

  it("caps at 15 MB by default", async () => {
    expect(MAX_IMAGE_BYTES).toBe(15 * 1024 * 1024);
    await writeFile(join(home, "huge.png"), Buffer.alloc(MAX_IMAGE_BYTES + 1));
    expect(await readImageFile(home, "huge.png")).toMatchObject({ data: null, tooLarge: true });
  });

  it("refuses anything but an image, a folder, and what is missing", async () => {
    await expect(readImageFile(home, "data/notes.txt")).rejects.toThrow(/not an image/);
    await mkdir(join(home, "folder.png"));
    await expect(readImageFile(home, "folder.png")).rejects.toThrow(/not a file/);
    await expect(readImageFile(home, "missing.png")).rejects.toThrow();
  });

  it("refuses a path out of the home, as the text read does", async () => {
    await expect(readImageFile(home, "../outside.png")).rejects.toThrow(/outside the home/);
    await expect(readImageFile(home, "data/../../outside.png")).rejects.toThrow(/outside the home/);
    await expect(readImageFile(home, join(outer, "outside.png"))).rejects.toThrow(/not a path inside the home/);
    await expect(readImageFile(home, "C:\\Windows\\x.png")).rejects.toThrow(/not a path inside the home/);
  });

  it("refuses a link that leads out of the home", async () => {
    // A junction needs no privilege on Windows; elsewhere the type is ignored.
    await symlink(outer, join(home, "escape"), "junction");
    await expect(readImageFile(home, "escape/outside.png")).rejects.toThrow(/leads outside the home/);
  });
});

describe("imageCandidates", () => {
  const userHome = "/users/captain";

  it("looks beside the Markdown file first, then from the home", () => {
    expect(imageCandidates("plot.png", "data/scout/report.md", userHome)).toEqual([
      "data/scout/plot.png",
      "plot.png",
    ]);
    expect(imageCandidates("data/scout/plot.png", "data/scout/report.md", userHome)).toEqual([
      "data/scout/data/scout/plot.png",
      "data/scout/plot.png",
    ]);
    expect(imageCandidates("./plot.png", "README.md", userHome)).toEqual(["./plot.png"]);
  });

  it("turns backslashes into slashes in a relative path", () => {
    expect(imageCandidates("figs\\plot.png", "data\\scout\\report.md", userHome)).toEqual([
      "data/scout/figs/plot.png",
      "figs/plot.png",
    ]);
  });

  it("keeps a drive-letter or UNC path absolute, for the daemon to confine", () => {
    expect(imageCandidates("C:\\Users\\captain\\plot.png", "r.md", userHome)).toEqual(["C:\\Users\\captain\\plot.png"]);
    expect(imageCandidates("C:/Users/captain/plot.png", "r.md", userHome)).toEqual(["C:/Users/captain/plot.png"]);
    expect(imageCandidates("\\\\server\\share\\plot.png", "r.md", userHome)).toEqual(["\\\\server\\share\\plot.png"]);
  });

  it("tries /… both as given and from the home", () => {
    expect(imageCandidates("/data/plot.png", "r.md", userHome)).toEqual(["/data/plot.png", "data/plot.png"]);
  });

  it("expands ~/ to the user's home folder", () => {
    expect(imageCandidates("~/pics/a.png", "r.md", userHome)).toEqual([join(userHome, "pics/a.png")]);
  });

  it("has none for a URL of any kind", () => {
    for (const url of ["https://example.com/a.png", "http://x/a.png", "data:image/png;base64,AAAA", "file:///c:/a.png", "javascript:alert(1)"]) {
      expect(imageCandidates(url, "r.md", userHome)).toEqual([]);
    }
  });

  it("also tries a percent-decoded spelling, and unwraps <…>", () => {
    expect(imageCandidates("my%20plot.png", "r.md", userHome)).toEqual(["my%20plot.png", "my plot.png"]);
    expect(imageCandidates("<plot.png>", "d/r.md", userHome)).toEqual(["d/plot.png", "plot.png"]);
    expect(imageCandidates("bad%zz.png", "r.md", userHome)).toEqual(["bad%zz.png"]);
  });
});

describe("findMarkdownImage", () => {
  const from = "data/scout/report.md";

  it("finds an image beside the Markdown file, or from the home", async () => {
    expect(await findMarkdownImage(home, "plot.png", from)).toBe("data/scout/plot.png");
    expect(await findMarkdownImage(home, "./plot.png", from)).toBe("data/scout/plot.png");
    expect(await findMarkdownImage(home, "data/scout/plot.png", from)).toBe("data/scout/plot.png");
    expect(await findMarkdownImage(home, "top.png", from)).toBe("top.png");
    expect(await findMarkdownImage(home, "../../top.png", from)).toBe("top.png");
    expect(await findMarkdownImage(home, "/top.png", from)).toBe("top.png");
  });

  it("finds one by an absolute path inside the home, in either slash", async () => {
    expect(await findMarkdownImage(home, join(home, "data", "scout", "plot.png"), from)).toBe("data/scout/plot.png");
    expect(await findMarkdownImage(home, join(home, "top.png").replace(/\\/g, "/"), from)).toBe("top.png");
  });

  it("finds none outside the home, even when the file is there", async () => {
    expect(await findMarkdownImage(home, "../../../outside.png", from)).toBeNull();
    expect(await findMarkdownImage(home, "..\\..\\..\\outside.png", from)).toBeNull();
    expect(await findMarkdownImage(home, join(outer, "outside.png"), from)).toBeNull();
    await symlink(outer, join(home, "escape"), "junction");
    expect(await findMarkdownImage(home, "escape/outside.png", "report.md")).toBeNull();
  });

  it("finds none for a URL, a file that is not an image, or one that is missing", async () => {
    expect(await findMarkdownImage(home, "https://example.com/top.png", from)).toBeNull();
    expect(await findMarkdownImage(home, "file:///top.png", from)).toBeNull();
    expect(await findMarkdownImage(home, "../notes.txt", from)).toBeNull();
    expect(await findMarkdownImage(home, "missing.png", from)).toBeNull();
  });
});

describe("readHomeImageFile", () => {
  it("reads a Files path as it is, and a Markdown target by what it names", async () => {
    expect((await readHomeImageFile(home, { path: "top.png" })).path).toBe("top.png");
    expect((await readHomeImageFile(home, { path: "plot.png", relativeTo: "data/scout/report.md" })).path).toBe(
      "data/scout/plot.png",
    );
  });

  it("says so when a Markdown target names no image in the home", async () => {
    await expect(readHomeImageFile(home, { path: "../../../outside.png", relativeTo: "data/scout/report.md" })).rejects.toThrow(
      /not an image in the first mate's home/,
    );
    await expect(readHomeImageFile(home, { path: "https://example.com/a.png", relativeTo: "r.md" })).rejects.toThrow();
  });
});
