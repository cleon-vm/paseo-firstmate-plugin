import { readdirSync, readFileSync } from "node:fs";
import { join } from "node:path";
import { fileURLToPath } from "node:url";
import { describe, expect, it } from "vitest";

import { imageDataUri, imageTypeOf, isUrlTarget, isWebTarget, SVG_TYPE } from "../shared/images";
import { fileCandidates, inlineTokens, splitAtImages, type FileLookup } from "./file-links";
import { fittedSize, stepZoom, zoomLabel } from "./image-zoom";
import { isDirty, markSaved, openedImage } from "./open-file";

const none: FileLookup = () => null;

describe("imageTypeOf", () => {
  it("knows PNG, JPEG, GIF, WebP and SVG by extension, in any case", () => {
    expect(imageTypeOf("a.png")).toBe("image/png");
    expect(imageTypeOf("a.jpg")).toBe("image/jpeg");
    expect(imageTypeOf("a.JPEG")).toBe("image/jpeg");
    expect(imageTypeOf("a.gif")).toBe("image/gif");
    expect(imageTypeOf("a.webp")).toBe("image/webp");
    expect(imageTypeOf("drawings/a.Svg")).toBe(SVG_TYPE);
  });

  it("reads the name after either slash", () => {
    expect(imageTypeOf("data\\scout\\plot.png")).toBe("image/png");
    expect(imageTypeOf("C:\\Users\\captain\\plot.gif")).toBe("image/gif");
    expect(imageTypeOf("data.png/notes")).toBeNull();
    expect(imageTypeOf("data.png\\notes")).toBeNull();
  });

  it("is null for anything else", () => {
    for (const path of ["notes.md", "a.png.txt", "png", "svg", "a.tiff", "a.bmp", "a.html", "", "folder/"]) {
      expect(imageTypeOf(path)).toBeNull();
    }
  });
});

describe("imageDataUri", () => {
  it("is a base64 data URI, SVG included", () => {
    const svg = Buffer.from('<svg xmlns="http://www.w3.org/2000/svg"><script>alert(1)</script></svg>').toString("base64");
    const uri = imageDataUri(SVG_TYPE, svg);
    expect(uri).toBe(`data:image/svg+xml;base64,${svg}`);
    expect(uri).not.toMatch(/[<>"']/);
  });

  it("refuses markup, or any data that is not base64, so nothing but base64 reaches the URI", () => {
    expect(() => imageDataUri(SVG_TYPE, "<svg><script>alert(1)</script></svg>")).toThrow(/not base64/);
    expect(() => imageDataUri(SVG_TYPE, "PHN2Zz4=,<svg>")).toThrow(/not base64/);
  });

  it("refuses a type that is not an image's", () => {
    expect(() => imageDataUri("text/html", "AAAA")).toThrow(/not an image type/);
    expect(() => imageDataUri("image/png;charset=utf8,<svg>", "AAAA")).toThrow(/not an image type/);
  });
});

describe("isUrlTarget / isWebTarget", () => {
  it("tells a URL from a path, a drive letter being a path", () => {
    expect(isUrlTarget("https://example.com/a.png")).toBe(true);
    expect(isUrlTarget("data:image/png;base64,AAAA")).toBe(true);
    expect(isUrlTarget("file:///c:/a.png")).toBe(true);
    expect(isUrlTarget("C:\\plots\\a.png")).toBe(false);
    expect(isUrlTarget("c:/plots/a.png")).toBe(false);
    expect(isUrlTarget("plots/a.png")).toBe(false);
    expect(isWebTarget("HTTPS://example.com/a.png")).toBe(true);
    expect(isWebTarget("data:image/png;base64,AAAA")).toBe(false);
  });
});

describe("inlineTokens with images", () => {
  it("is an image for a path, only when images are asked for", () => {
    expect(inlineTokens("see ![the plot](plots/a.png) here", none, { images: true })).toEqual([
      { kind: "text", text: "see " },
      { kind: "image", alt: "the plot", target: "plots/a.png" },
      { kind: "text", text: " here" },
    ]);
  });

  it("leaves the chat's tokens as they were without images", () => {
    expect(inlineTokens("![the plot](plots/a.png)", none)).toEqual([
      { kind: "text", text: "!" },
      { kind: "link", text: "the plot", url: "plots/a.png" },
    ]);
    expect(fileCandidates("![p](plots/a.png)")).toEqual(["plots/a.png"]);
  });

  it("keeps a Windows path whole", () => {
    expect(inlineTokens("![p](C:\\Users\\captain\\plot.png)", none, { images: true })).toEqual([
      { kind: "image", alt: "p", target: "C:\\Users\\captain\\plot.png" },
    ]);
  });

  it("never fetches a web image: its alt text links to it", () => {
    expect(inlineTokens("![chart](https://example.com/c.png)", none, { images: true })).toEqual([
      { kind: "link", text: "chart", url: "https://example.com/c.png" },
    ]);
    expect(inlineTokens("![](http://example.com/c.png)", none, { images: true })).toEqual([
      { kind: "link", text: "http://example.com/c.png", url: "http://example.com/c.png" },
    ]);
  });

  it("draws no other URL either, data: included: only its alt text", () => {
    expect(inlineTokens("![x](data:image/svg+xml;base64,PHN2Zz4=)", none, { images: true })).toEqual([
      { kind: "text", text: "x" },
    ]);
    expect(inlineTokens("![x](javascript:alert(1))", none, { images: true })[0]).toEqual({ kind: "text", text: "x" });
  });

  it("leaves HTML as text", () => {
    expect(inlineTokens('<img src="a.png" onerror="alert(1)">', none, { images: true })).toEqual([
      { kind: "text", text: '<img src="a.png" onerror="alert(1)">' },
    ]);
  });

  it("still finds links and code around an image", () => {
    const tokens = inlineTokens("`x` ![a](a.png) [b](https://b.example)", none, { images: true });
    expect(tokens.map((token) => token.kind)).toEqual(["code", "text", "image", "text", "link"]);
  });
});

describe("splitAtImages", () => {
  it("puts each image on its own, between runs of text without the line breaks around it", () => {
    const tokens = inlineTokens("Before\n![a](a.png)\n![b](b.png)\nAfter **bold**", none, { images: true });
    expect(splitAtImages(tokens)).toEqual([
      [{ kind: "text", text: "Before" }],
      { kind: "image", alt: "a", target: "a.png" },
      { kind: "image", alt: "b", target: "b.png" },
      [
        { kind: "text", text: "After " },
        { kind: "bold", text: "bold" },
      ],
    ]);
  });

  it("is one run for text with no image", () => {
    const tokens = inlineTokens("just **text**", none, { images: true });
    expect(splitAtImages(tokens)).toEqual([tokens]);
  });
});

describe("image zoom", () => {
  it("steps in and out of fit, and between steps, stopping at the ends", () => {
    expect(stepZoom("fit", "in")).toBe(1);
    expect(stepZoom("fit", "out")).toBe(0.5);
    expect(stepZoom(1, "in")).toBe(1.5);
    expect(stepZoom(1, "out")).toBe(0.75);
    expect(stepZoom(8, "in")).toBe(8);
    expect(stepZoom(0.1, "out")).toBe(0.1);
    expect(zoomLabel("fit")).toBe("Fit");
    expect(zoomLabel(1.5)).toBe("150%");
  });

  it("fits an image to the box without enlarging it, keeping its shape", () => {
    expect(fittedSize({ width: 2000, height: 1000 }, 500, 400)).toEqual({ width: 500, height: 250 });
    expect(fittedSize({ width: 1000, height: 2000 }, 500, 400)).toEqual({ width: 200, height: 400 });
    expect(fittedSize({ width: 100, height: 50 }, 500, 400)).toEqual({ width: 100, height: 50 });
    expect(fittedSize(null, 400)).toEqual({ width: 400, height: 300 });
    expect(fittedSize({ width: 0, height: 0 }, 400)).toEqual({ width: 400, height: 300 });
  });
});

describe("an open image", () => {
  const result = { path: "plots/a.png", mimeType: "image/png", data: "AAAA", size: 3, modifiedMs: 7 };

  it("opens as a view-only image, or as too large", () => {
    expect(openedImage(result)).toEqual({
      kind: "image",
      path: "plots/a.png",
      mimeType: "image/png",
      data: "AAAA",
      size: 3,
      modifiedMs: 7,
    });
    expect(openedImage({ ...result, data: null, size: 20e6 })).toEqual({
      kind: "unreadable",
      path: "plots/a.png",
      reason: "imageTooLarge",
      size: 20e6,
    });
  });

  it("is never dirty, and a save leaves it alone", () => {
    const image = openedImage(result);
    expect(isDirty(image)).toBe(false);
    expect(markSaved(image, { path: "plots/a.png", content: "x", modifiedMs: 9 })).toBe(image);
  });
});

describe("SVG is never markup", () => {
  it("no client file injects HTML or embeds a web view", () => {
    const dir = fileURLToPath(new URL(".", import.meta.url));
    for (const name of readdirSync(dir).filter((file) => /\.tsx?$/.test(file) && !file.endsWith(".test.ts"))) {
      const source = readFileSync(join(dir, name), "utf8");
      expect(source, name).not.toMatch(/dangerouslySetInnerHTML|innerHTML|outerHTML|WebView|<iframe|from "react-native-svg"|SvgXml/);
      expect(source, name).not.toMatch(/svg\+xml;(utf8|charset)/);
    }
  });
});
