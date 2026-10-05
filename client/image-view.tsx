/**
 * Images from the first mate's home, drawn: the Files view's viewer for an
 * open image, and an image a Markdown preview names.
 *
 * Both draw with `Image` from a base64 data URI (`shared/images.ts`), SVG
 * included, so an SVG is only ever an image — never markup in the page, never
 * run. Images are view-only; nothing here writes.
 */
import type { PluginTheme } from "@getpaseo/plugin";
import { useQuery } from "@tanstack/react-query";
import { useEffect, useMemo, useState } from "react";
import { Image, Pressable, ScrollView, Text, View, type LayoutChangeEvent } from "react-native";

import { imageDataUri, MAX_IMAGE_BYTES, SVG_TYPE } from "../shared/images";
import { formatBytes } from "./attachments";
import { errorText } from "./format";
import { fittedSize, stepZoom, zoomLabel, type Zoom } from "./image-zoom";
import { IconButton } from "./ui";

type Size = { width: number; height: number };

/** The data URI for an image, or null when its data is not an image's. */
function dataUriOf(mimeType: string, data: string): string | null {
  try {
    return imageDataUri(mimeType, data);
  } catch {
    return null;
  }
}

/** The image's own size in pixels, once known; null until then, or when it cannot be told (an SVG without one). */
function useNaturalSize(uri: string | null): Size | null {
  const [size, setSize] = useState<Size | null>(null);
  useEffect(() => {
    setSize(null);
    if (uri === null) return;
    let live = true;
    Image.getSize(
      uri,
      (width, height) => {
        if (live && width > 0 && height > 0) setSize({ width, height });
      },
      () => {},
    );
    return () => {
      live = false;
    };
  }, [uri]);
  return size;
}

function useLayoutSize(): [Size, (event: LayoutChangeEvent) => void] {
  const [size, setSize] = useState<Size>({ width: 0, height: 0 });
  return [
    size,
    (event) => {
      const { width, height } = event.nativeEvent.layout;
      setSize((current) => (current.width === width && current.height === height ? current : { width, height }));
    },
  ];
}

function failedText(path: string, mimeType: string): string {
  return mimeType === SVG_TYPE
    ? `${path} could not be drawn. Not every device draws SVG images; Edit source shows its text.`
    : `${path} could not be drawn: it may be damaged, or in a form this device does not read.`;
}

/** The open image in the Files view: fitted to the pane, or zoomed and scrollable. */
export function ImageViewer({
  theme,
  path,
  mimeType,
  size,
  data,
}: {
  theme: PluginTheme;
  path: string;
  mimeType: string;
  size: number;
  data: string;
}) {
  const uri = useMemo(() => dataUriOf(mimeType, data), [mimeType, data]);
  const natural = useNaturalSize(uri);
  const [pane, onPaneLayout] = useLayoutSize();
  const [zoom, setZoom] = useState<Zoom>("fit");
  const [failed, setFailed] = useState(false);
  useEffect(() => setFailed(false), [uri]);

  const styles = useMemo(() => {
    const { colors } = theme;
    return {
      root: { flex: 1, minHeight: 0 },
      toolbar: {
        flexDirection: "row" as const,
        flexWrap: "wrap" as const,
        alignItems: "center" as const,
        gap: 6,
        paddingHorizontal: 10,
        paddingVertical: 6,
        borderBottomWidth: 1,
        borderBottomColor: colors.border,
      },
      facts: { flex: 1, minWidth: 120, color: colors.foregroundMuted, fontSize: 11 },
      zoom: { minWidth: 40, textAlign: "center" as const, color: colors.foreground, fontSize: 12 },
      fitPane: { flex: 1, minHeight: 0, alignItems: "center" as const, justifyContent: "center" as const, padding: 12 },
      scroll: { flex: 1, minHeight: 0 },
      scrollContent: { padding: 12 },
      muted: { color: colors.foregroundMuted, fontSize: 12, padding: 12, lineHeight: 17 },
      image: { backgroundColor: colors.surface1 },
    };
  }, [theme]);

  const facts = [natural === null ? null : `${natural.width} × ${natural.height} px`, formatBytes(size), mimeType]
    .filter((fact) => fact !== null)
    .join(" · ");

  let body;
  if (uri === null || failed) {
    body = <Text style={styles.muted}>{failedText(path, mimeType)}</Text>;
  } else if (zoom === "fit") {
    const box = fittedSize(natural, Math.max(0, pane.width - 24), Math.max(0, pane.height - 24));
    body = (
      <View style={styles.fitPane} onLayout={onPaneLayout}>
        {pane.width === 0 ? null : (
          <Image
            source={{ uri }}
            style={[styles.image, box]}
            resizeMode="contain"
            accessibilityLabel={`Image ${path}`}
            accessibilityIgnoresInvertColors
            onError={() => setFailed(true)}
          />
        )}
      </View>
    );
  } else {
    // An SVG that declares no size has none to scale; it is drawn at a size of its own.
    const base = natural ?? { width: 800, height: 600 };
    const drawn = { width: Math.round(base.width * zoom), height: Math.round(base.height * zoom) };
    body = (
      <ScrollView style={styles.scroll} contentContainerStyle={styles.scrollContent}>
        <ScrollView horizontal>
          <Image
            source={{ uri }}
            style={[styles.image, drawn]}
            resizeMode="contain"
            accessibilityLabel={`Image ${path}`}
            accessibilityIgnoresInvertColors
            onError={() => setFailed(true)}
          />
        </ScrollView>
      </ScrollView>
    );
  }

  return (
    <View style={styles.root}>
      <View style={styles.toolbar}>
        <Text style={styles.facts} numberOfLines={1}>
          {facts}
        </Text>
        <IconButton icon="ZoomOut" label="Zoom out" theme={theme} onPress={() => setZoom(stepZoom(zoom, "out"))} />
        <Text style={styles.zoom}>{zoomLabel(zoom)}</Text>
        <IconButton icon="ZoomIn" label="Zoom in" theme={theme} onPress={() => setZoom(stepZoom(zoom, "in"))} />
        <IconButton
          icon={zoom === "fit" ? "Maximize" : "Shrink"}
          label={zoom === "fit" ? "Actual size" : "Fit to the pane"}
          showLabel
          theme={theme}
          onPress={() => setZoom(zoom === "fit" ? 1 : "fit")}
        />
      </View>
      {body}
    </View>
  );
}

/** What a Markdown preview's images are read with: the file they are written in, and how to open one in Files. */
export interface MarkdownImages {
  /** The Markdown file's home-relative path; a relative target is looked up beside it first. */
  from: string;
  load: (target: string) => Promise<{ path: string; mimeType: string; data: string | null; size: number }>;
  onOpen: ((path: string) => void) | null;
}

/**
 * An image a Markdown file names by a path in the home, as wide as the text
 * at most and never wider than itself. One the home does not have is its alt
 * text, with why.
 */
export function MarkdownImage({
  theme,
  alt,
  target,
  images,
  fontSize,
}: {
  theme: PluginTheme;
  alt: string;
  target: string;
  images: MarkdownImages;
  fontSize: number;
}) {
  const image = useQuery({
    queryKey: ["firstmate", "files", "markdown-image", images.from, target],
    queryFn: () => images.load(target),
    retry: false,
  });
  const uri = image.data?.data == null ? null : dataUriOf(image.data.mimeType, image.data.data);
  const natural = useNaturalSize(uri);
  const [box, onLayout] = useLayoutSize();
  const [failed, setFailed] = useState(false);
  useEffect(() => setFailed(false), [uri]);

  const muted = { color: theme.colors.foregroundMuted, fontSize: fontSize - 1, fontStyle: "italic" as const };
  const name = alt.trim() === "" ? target : alt;

  let content;
  if (image.isPending) {
    content = <Text style={muted}>Loading image {name}…</Text>;
  } else if (image.error !== null) {
    content = (
      <Text style={muted}>
        Image not shown: {name} — {errorText(image.error)}
      </Text>
    );
  } else if (image.data.data === null) {
    content = (
      <Text style={muted}>
        Image not shown: {name} is {formatBytes(image.data.size)}, over the {formatBytes(MAX_IMAGE_BYTES)} limit for images in the
        preview.
      </Text>
    );
  } else if (uri === null || failed) {
    content = <Text style={muted}>{failedText(image.data.path, image.data.mimeType)}</Text>;
  } else {
    const found = image.data;
    const drawn = fittedSize(natural, box.width);
    content =
      box.width === 0 ? null : (
        <Pressable
          accessibilityRole={images.onOpen === null ? "image" : "button"}
          accessibilityLabel={name}
          accessibilityHint={images.onOpen === null ? undefined : `Opens ${found.path} in Files`}
          disabled={images.onOpen === null}
          onPress={() => images.onOpen?.(found.path)}
          style={{ alignSelf: "flex-start" }}
        >
          <Image
            source={{ uri }}
            style={[{ backgroundColor: theme.colors.surface1, borderRadius: 4 }, drawn]}
            resizeMode="contain"
            accessibilityIgnoresInvertColors
            onError={() => setFailed(true)}
          />
        </Pressable>
      );
  }
  return (
    <View style={{ alignSelf: "stretch" }} onLayout={onLayout}>
      {content}
    </View>
  );
}
