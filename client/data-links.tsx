import type { PluginTheme } from "@getpaseo/plugin";
import { useRpc } from "@getpaseo/plugin/client";
import { useToast } from "@getpaseo/plugin/client/react-native";
import { useQuery } from "@tanstack/react-query";
import { Children, createContext, useContext, useMemo, type ReactNode } from "react";
import { Text, type TextProps } from "react-native";

import { findDataPaths, MAX_FILE_CANDIDATES, MAX_FILE_PATH_LENGTH, openDataPath } from "../shared/files";
import { pathMentions } from "./data-paths";

/** The fleet lends its existing Files viewer; standalone panels safely reveal files instead. */
export const DataFilesContext = createContext<((path: string) => void) | null>(null);

export function useDataLinks(source: string, viewer?: ((path: string) => void) | null) {
  const inheritedViewer = useContext(DataFilesContext);
  const onOpenFile = viewer ?? inheritedViewer;
  const find = useRpc(findDataPaths);
  const open = useRpc(openDataPath);
  const toast = useToast();
  const candidates = useMemo(
    () => [...new Set(pathMentions(source).map((mention) => mention.path))]
      .filter((path) => path.length <= MAX_FILE_PATH_LENGTH).slice(-MAX_FILE_CANDIDATES),
    [source],
  );
  const result = useQuery({
    queryKey: ["firstmate", "data", "find", candidates],
    queryFn: () => find({ paths: candidates }),
    enabled: candidates.length > 0,
    refetchInterval: 10_000,
  });
  const paths = result.data?.paths ?? {};
  function openPath(path: string): void {
    // A folder link names its action, so the daemon checks it as a folder and nothing else.
    const folder = paths[path]?.action === "folder";
    void open({ path, revealFile: onOpenFile === null, ...(folder ? { action: "folder" as const } : {}) })
      .then((target) => {
        if (target.path !== null && target.view) onOpenFile?.(target.path);
      })
      .catch((error: unknown) => toast.error(error instanceof Error ? error.message : String(error)));
  }
  return { paths, openPath };
}

/** A Text replacement where paths may occur; nested styles and line limits stay intact. */
export function DataText({ theme, children, ...props }: TextProps & { theme: PluginTheme }) {
  const source = Children.toArray(children).filter((child) => typeof child === "string").join("\n");
  const links = useDataLinks(props.onPress === undefined ? source : "");
  function render(child: ReactNode): ReactNode {
    if (typeof child !== "string" || props.onPress !== undefined) return child;
    const parts: ReactNode[] = [];
    let at = 0;
    for (const mention of pathMentions(child)) {
      const target = links.paths[mention.path];
      if (target === undefined) continue;
      parts.push(child.slice(at, mention.start));
      parts.push(
        <Text
          key={mention.start}
          accessibilityRole="link"
          accessibilityHint={target.kind === "dir"
            ? "Opens in the file manager on the daemon machine"
            : "Opens in Files or reveals in the file manager"}
          style={{ color: theme.colors.accent, textDecorationLine: "underline" }}
          onPress={(event) => {
            event.stopPropagation();
            links.openPath(mention.path);
          }}
        >
          {mention.text}
        </Text>,
      );
      at = mention.start + mention.text.length;
    }
    parts.push(child.slice(at));
    return parts;
  }
  return <Text {...props}>{Children.map(children, render)}</Text>;
}
