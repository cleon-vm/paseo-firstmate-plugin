import type { PluginTheme } from "@getpaseo/plugin";
import { createElement, type ElementType } from "react";
import { act, create, type ReactTestRenderer } from "react-test-renderer";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

const host = vi.hoisted(() => ({
  paths: {} as Record<string, { path: string; kind: "file" | "dir" }>,
  open: vi.fn(), toast: { error: vi.fn() },
}));
vi.mock("react-native", () => ({ Text: "Text", View: "View", Pressable: "Pressable", Platform: { select: () => "monospace" } }));
vi.mock("@getpaseo/plugin/client/react-native", () => ({ Icon: "Icon", TextInput: "TextInput", useToast: () => host.toast }));
vi.mock("@getpaseo/plugin/client", () => ({
  openExternalUrl: vi.fn(),
  useRpc: (rpc: { name: string }) => rpc.name === "firstmate.data.open" ? host.open : vi.fn(),
}));
vi.mock("@tanstack/react-query", () => ({
  useQuery: ({ queryKey }: { queryKey: unknown[] }) => ({ data: { paths: Object.fromEntries(
    (queryKey[3] as string[]).flatMap((path) => host.paths[path] === undefined ? [] : [[path, host.paths[path]]]),
  ) } }),
}));

import { DataFilesContext, DataText } from "./data-links";
import { dataMentions } from "./data-paths";
import { CrewCard } from "./card";
import { SuggestionList } from "./suggestions";
import { Markdown } from "./markdown";
import { parseBacklog } from "../server/backlog";

const theme = { colors: { foreground: "white", foregroundMuted: "gray", accent: "blue" } } as PluginTheme;
let renderer: ReactTestRenderer | undefined;
const Text = "Text" as ElementType;
async function mount(element: ReturnType<typeof createElement>) {
  await act(async () => { renderer = create(element); });
}
function links() { return renderer!.root.findAllByType(Text).filter((node) => node.props.accessibilityRole === "link"); }
beforeEach(() => {
  Object.assign(globalThis, { IS_REACT_ACT_ENVIRONMENT: true });
  vi.clearAllMocks();
  host.paths = {
    "data/task/report.md": { path: "data/task/report.md", kind: "file" },
    "data/task": { path: "data/task", kind: "dir" },
  };
  host.open.mockImplementation(async ({ path }: { path: string }) => ({ ...(host.paths[path] ?? { path: null, kind: null }), view: host.paths[path]?.kind === "file" }));
});
afterEach(async () => { if (renderer) await act(async () => renderer!.unmount()); renderer = undefined; });

describe("data path rendering", () => {
  it("recognizes punctuation, line suffixes, backslashes and quoted spaces without linking URL or absolute-path suffixes", () => {
    expect(dataMentions('See data/task/report.md:12, `data/a folder/` and data\\task. https://host/data/task /outside/data/task C:\\outside\\data\\task').map((entry) => entry.path))
      .toEqual(["data/task/report.md", "data/a folder/", "data\\task"]);
  });

  it.each(["done", "in-flight", "held"])("links artifacts, reports, holds, titles and outcomes on %s cards without changing backlog parsing", async (column) => {
    const backlog = parseBacklog(`## ${column === "in-flight" ? "In flight" : "Done"}\n- [x] task - result data/task/report.md (hold: inspect data/task) (done data/task)\n`)[0]!;
    await mount(createElement(CrewCard, {
      theme, compact: false, opener: null, onChanged: vi.fn(), toMate: null,
      card: { key: column, column: column === "in-flight" ? "working" : column === "held" ? "blocked" : "done", title: "Look data/task", project: null, kind: null,
        taskId: "task", agent: null, backlog, report: { state: "done", text: "Read data/task/report.md" }, url: null },
    }));
    expect(links().map((node) => node.children.join(""))).toEqual(expect.arrayContaining(["data/task", "data/task/report.md"]));
    const stopPropagation = vi.fn();
    await act(async () => links()[0]!.props.onPress({ stopPropagation }));
    expect(stopPropagation).toHaveBeenCalledOnce();
    expect(host.open).toHaveBeenCalledWith({ path: "data/task", revealFile: true });
    expect(backlog.reportPath).toBe("data/task/report.md");
  });

  it("opens suggestion paths without sending the suggestion", async () => {
    const onPick = vi.fn();
    await mount(createElement(SuggestionList, { theme, disabled: false, onPick, onRemove: vi.fn(), suggestions: [
      { label: "Read data/task", prompt: "Inspect data/task/report.md" },
    ] }));
    expect(links()).toHaveLength(2);
    await act(async () => links()[1]!.props.onPress({ stopPropagation: vi.fn() }));
    expect(onPick).not.toHaveBeenCalled();
    // Main's expanded suggestion remains independently selectable and linkable.
    const measurements = renderer!.root.findAllByType("View" as ElementType).filter((node) => node.props.onLayout);
    await act(async () => {
      measurements[0]!.props.onLayout({ nativeEvent: { layout: { height: 20 } } });
      measurements[1]!.props.onLayout({ nativeEvent: { layout: { height: 50 } } });
    });
    const chevron = renderer!.root.findAllByType("Pressable" as ElementType)
      .find((node) => node.props.accessibilityState?.expanded === false)!;
    await act(async () => chevron.props.onPress());
    expect(links()).toHaveLength(2);
    await act(async () => links()[1]!.props.onPress({ stopPropagation: vi.fn() }));
    expect(onPick).not.toHaveBeenCalled();
  });

  it("uses the inherited viewer for a file, and leaves missing or unsafe paths as text", async () => {
    const viewer = vi.fn();
    await mount(createElement(DataFilesContext.Provider, { value: viewer }, createElement(DataText, { theme },
      "data/task/report.md data/missing data/../secret")));
    expect(links()).toHaveLength(1);
    await act(async () => links()[0]!.props.onPress({ stopPropagation: vi.fn() }));
    expect(viewer).toHaveBeenCalledWith("data/task/report.md");
    expect(host.open).toHaveBeenCalledWith({ path: "data/task/report.md", revealFile: false });
    host.open.mockResolvedValue({ path: null, kind: null, view: false });
    viewer.mockClear();
    await act(async () => links()[0]!.props.onPress({ stopPropagation: vi.fn() }));
    expect(viewer).not.toHaveBeenCalled();
    expect(host.toast.error).not.toHaveBeenCalled();
  });

  it("links Markdown prose, code, bold, fenced code and local link labels, leaving missing links inert", async () => {
    const external = vi.fn();
    await mount(createElement(Markdown, { theme, onOpenLink: external, source:
      'data/task **data/task** `data/task/report.md` [Report](data/task/report.md) [missing](data/missing)\n\n```\ndata/task/report.md\n```',
    }));
    expect(links()).toHaveLength(5);
    expect(links().map((node) => node.children.join(""))).toContain("Report");
    await act(async () => links()[0]!.props.onPress({ stopPropagation: vi.fn() }));
    expect(host.open).toHaveBeenCalled();
    expect(external).not.toHaveBeenCalled();
  });
});
