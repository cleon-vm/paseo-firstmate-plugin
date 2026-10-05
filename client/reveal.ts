/**
 * The Files view's Reveal and Copy path, as pure functions: the path a home
 * file has on the daemon's machine, what Reveal is called there, and where
 * the right-click menu goes.
 */

/** A drive letter or a `\\server\share` path: the daemon runs on Windows. */
function isWindowsPath(path: string): boolean {
  return /^[a-zA-Z]:[\\/]/.test(path) || path.startsWith("\\\\");
}

/**
 * The path `rel` (home-relative, `/`-separated) has on the machine the
 * daemon runs on, written the way `home` is: with backslashes when the home
 * is a Windows path, slashes otherwise. `""` is the home itself.
 */
export function absolutePath(home: string, rel: string): string {
  const separator = isWindowsPath(home) ? "\\" : "/";
  const base = home.replace(/[\\/]+$/, "");
  // Trimming would leave a drive's root as `C:` and the POSIX root as nothing.
  const root = base === "" || /^[a-zA-Z]:$/.test(base) ? `${base}${separator}` : base;
  if (rel === "") return root;
  return `${root.endsWith(separator) ? root : `${root}${separator}`}${rel.split("/").join(separator)}`;
}

/**
 * What Reveal is called for a home on the daemon's machine: Explorer's name
 * when the home is a Windows path, which says where it opens. A POSIX path
 * does not tell macOS from Linux, so there it is the file manager.
 */
export function revealLabel(home: string | null): string {
  return home !== null && isWindowsPath(home) ? "Reveal in Explorer" : "Reveal in file manager";
}

export interface Point {
  x: number;
  y: number;
}

export interface Size {
  width: number;
  height: number;
}

/** Room kept between the menu and the frame's edge. */
const MARGIN = 4;

/**
 * Where a menu of `menu` size opens for a click at `click` (window
 * coordinates) inside a frame at `origin` of `frame` size: at the pointer,
 * moved left or up just enough to stay inside the frame, and never past its
 * top-left corner when the frame is smaller than the menu.
 */
export function menuPosition(click: Point, origin: Point, frame: Size, menu: Size): { left: number; top: number } {
  const clamp = (value: number, room: number) => Math.max(MARGIN, Math.min(value, room - MARGIN));
  return {
    left: clamp(click.x - origin.x, frame.width - menu.width),
    top: clamp(click.y - origin.y, frame.height - menu.height),
  };
}
