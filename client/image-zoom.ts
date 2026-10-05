/** How the Files view draws an open image: fitted to the pane, or at a scale of its own size. Pure, so it is testable. */
export type Zoom = "fit" | number;

export const ZOOM_STEPS: readonly number[] = [0.1, 0.25, 0.5, 0.75, 1, 1.5, 2, 3, 4, 6, 8];

/**
 * One step in or out. Out of "fit", in is the image's own size and out is half
 * of it, since how large "fit" draws depends on the pane; at either end the
 * zoom stays where it is.
 */
export function stepZoom(current: Zoom, direction: "in" | "out"): Zoom {
  if (current === "fit") return direction === "in" ? 1 : 0.5;
  if (direction === "in") return ZOOM_STEPS.find((step) => step > current + 1e-9) ?? current;
  return [...ZOOM_STEPS].reverse().find((step) => step < current - 1e-9) ?? current;
}

export function zoomLabel(zoom: Zoom): string {
  return zoom === "fit" ? "Fit" : `${Math.round(zoom * 100)}%`;
}

/**
 * The box an image is drawn in to fit within `maxWidth` by `maxHeight`, never
 * larger than its own size, keeping its shape. An image whose size is not
 * known yet — or an SVG that declares none — gets a 4:3 box.
 */
export function fittedSize(
  natural: { width: number; height: number } | null,
  maxWidth: number,
  maxHeight: number = Number.POSITIVE_INFINITY,
): { width: number; height: number } {
  const known = natural !== null && natural.width > 0 && natural.height > 0;
  const ratio = known ? natural.height / natural.width : 3 / 4;
  const width = Math.max(1, Math.min(maxWidth, known ? natural.width : maxWidth, maxHeight / ratio));
  return { width: Math.round(width), height: Math.round(width * ratio) };
}
