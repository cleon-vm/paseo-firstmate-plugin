import { describe, expect, it } from "vitest";

import { absolutePath, menuPosition, revealLabel } from "./reveal";

describe("absolutePath", () => {
  it("writes a home file's path with the home's own separators", () => {
    expect(absolutePath("C:\\Users\\cap\\fm", "data/scout, x/a b.md")).toBe("C:\\Users\\cap\\fm\\data\\scout, x\\a b.md");
    expect(absolutePath("/Users/cap/fm", "data/a b.md")).toBe("/Users/cap/fm/data/a b.md");
    expect(absolutePath("\\\\server\\share\\fm", "AGENTS.md")).toBe("\\\\server\\share\\fm\\AGENTS.md");
  });

  it("does not double a trailing separator, and keeps a root whole", () => {
    expect(absolutePath("C:\\Users\\cap\\fm\\", "AGENTS.md")).toBe("C:\\Users\\cap\\fm\\AGENTS.md");
    expect(absolutePath("C:\\", "AGENTS.md")).toBe("C:\\AGENTS.md");
    expect(absolutePath("/", "AGENTS.md")).toBe("/AGENTS.md");
  });

  it("is the home itself for the empty path", () => {
    expect(absolutePath("C:\\Users\\cap\\fm\\", "")).toBe("C:\\Users\\cap\\fm");
    expect(absolutePath("C:\\", "")).toBe("C:\\");
    expect(absolutePath("/home/cap/fm/", "")).toBe("/home/cap/fm");
  });
});

describe("revealLabel", () => {
  it("names Explorer for a Windows home, and the file manager otherwise or before the home is known", () => {
    expect(revealLabel("C:\\Users\\cap\\fm")).toBe("Reveal in Explorer");
    expect(revealLabel("\\\\server\\share")).toBe("Reveal in Explorer");
    expect(revealLabel("/Users/cap/fm")).toBe("Reveal in file manager");
    expect(revealLabel(null)).toBe("Reveal in file manager");
  });
});

describe("menuPosition", () => {
  const menu = { width: 250, height: 150 };
  const frame = { width: 800, height: 600 };

  it("opens at the pointer, relative to the frame", () => {
    expect(menuPosition({ x: 300, y: 200 }, { x: 100, y: 50 }, frame, menu)).toEqual({ left: 200, top: 150 });
  });

  it("moves left and up to stay inside the frame", () => {
    expect(menuPosition({ x: 890, y: 640 }, { x: 100, y: 50 }, frame, menu)).toEqual({ left: 546, top: 446 });
  });

  it("stays at the top-left when the frame is smaller than the menu", () => {
    expect(menuPosition({ x: 150, y: 90 }, { x: 100, y: 50 }, { width: 200, height: 100 }, menu)).toEqual({ left: 4, top: 4 });
  });

  it("never opens above or left of the frame", () => {
    expect(menuPosition({ x: 90, y: 40 }, { x: 100, y: 50 }, frame, menu)).toEqual({ left: 4, top: 4 });
  });
});
