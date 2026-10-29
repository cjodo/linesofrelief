/**
 * Hover done the way a good menu does it, shared by everything that opens on
 * hover (a town's museum list, a museum's hover window) and the docking that
 * places them and the museum card:
 * - Resting on a target for a moment opens it; sweeping past doesn't.
 * - Once something is open, moving onto another target switches at once.
 * - It stays open while the pointer is anywhere in its corridor (say the
 *   convex hull of a badge and its list), so reaching for it never races a
 *   timer, and closes shortly after the pointer leaves.
 */

export interface Point {
  x: number;
  y: number;
}

/** Screen px: left, top, right, bottom. */
export type Rect = [number, number, number, number];

export interface Intent<T extends { key: string }> {
  /** The pointer moved: the target under it, if any, and where it is. */
  hover(target: T | null, at: Point): void;
  /** Open at once (a click, or a tap: touch has no hover). */
  open(target: T): void;
  hide(): void;
  /** While open, the area that keeps it open besides its target. */
  setCorridor(area: Point[]): void;
  /** The pointer is on the opened thing itself (or has left it). */
  hold(): void;
  release(): void;
  readonly openKey: string | null;
}

export function createIntent<T extends { key: string }>({
  openMs,
  closeMs,
  onOpen,
  onClose,
  onPending,
}: {
  /** Resting this long on a target opens it. */
  openMs: number;
  /** Leaving closes it after this long (jitter at the edge). */
  closeMs: number;
  onOpen: (target: T) => void;
  onClose: () => void;
  /** A target is under the pointer, waiting to open (or none is any more). */
  onPending?: (key: string | null) => void;
}): Intent<T> {
  let openKey: string | null = null;
  let pendingKey: string | null = null;
  let openTimer = 0;
  let closeTimer = 0;
  let corridor: Point[] = [];

  const cancelOpen = () => {
    clearTimeout(openTimer);
    if (pendingKey !== null) onPending?.(null);
    pendingKey = null;
  };
  const cancelClose = () => clearTimeout(closeTimer);
  const closeSoon = () => {
    clearTimeout(closeTimer);
    closeTimer = window.setTimeout(hide, closeMs);
  };

  function open(target: T) {
    cancelOpen();
    cancelClose();
    if (target.key === openKey) return;
    openKey = target.key;
    corridor = [];
    onOpen(target);
  }

  function hide() {
    const was = openKey;
    cancelOpen();
    cancelClose();
    openKey = null;
    corridor = [];
    if (was !== null) onClose();
  }

  return {
    get openKey() {
      return openKey;
    },
    hover(target, at) {
      if (openKey !== null) {
        if (target && target.key !== openKey) open(target);
        else if (target || inside(corridor, at)) cancelClose();
        else closeSoon();
        return;
      }
      if (!target) return cancelOpen();
      if (pendingKey === target.key) return;
      cancelOpen();
      pendingKey = target.key;
      onPending?.(target.key);
      openTimer = window.setTimeout(() => open(target), openMs);
    },
    open,
    hide,
    setCorridor(area) {
      corridor = area;
    },
    hold: cancelClose,
    release() {
      if (openKey !== null) closeSoon();
    },
  };
}

/**
 * Place `el` (position: fixed at 0, 0) by `anchor`, inside the viewport:
 * `beside` it (right, else left), with the point `lead` px down `el` level
 * with the anchor's middle; or `above` it (else below), centred.
 */
export function dock(
  el: HTMLElement,
  anchor: Rect,
  side: 'beside' | 'above',
  { gap = 12, edge = 12, lead, minTop = edge }: { gap?: number; edge?: number; lead?: number; minTop?: number } = {},
) {
  el.style.translate = '0px 0px';
  // Layout size: offset sizes ignore a closed element's scale.
  const [w, h] = [el.offsetWidth, el.offsetHeight];
  const [x0, y0, x1, y1] = anchor;
  let left: number;
  let top: number;
  let flipped: boolean;
  if (side === 'beside') {
    flipped = x1 + gap + w > innerWidth - edge;
    left = flipped ? x0 - gap - w : x1 + gap;
    top = (y0 + y1) / 2 - (lead ?? h / 2);
  } else {
    flipped = y0 - gap - h < minTop;
    left = (x0 + x1) / 2 - w / 2;
    top = flipped ? y1 + gap : y0 - gap - h;
  }
  left = Math.max(edge, Math.min(left, innerWidth - w - edge));
  top = Math.max(minTop, Math.min(top, innerHeight - h - edge));
  el.style.translate = `${left}px ${top}px`;
  return { left, top, w, h, flipped };
}

/** A rect's corners, grown by `pad`. */
export function corners([x0, y0, x1, y1]: Rect, pad = 0): Point[] {
  return [
    { x: x0 - pad, y: y0 - pad },
    { x: x1 + pad, y: y0 - pad },
    { x: x1 + pad, y: y1 + pad },
    { x: x0 - pad, y: y1 + pad },
  ];
}

const cross = (o: Point, a: Point, b: Point) => (a.x - o.x) * (b.y - o.y) - (a.y - o.y) * (b.x - o.x);

/** Convex hull, its corners in order (monotone chain). */
export function hull(points: Point[]): Point[] {
  const p = [...points].sort((a, b) => a.x - b.x || a.y - b.y);
  const half = (list: Point[]) => {
    const out: Point[] = [];
    for (const q of list) {
      while (out.length >= 2 && cross(out[out.length - 2], out[out.length - 1], q) <= 0) out.pop();
      out.push(q);
    }
    out.pop();
    return out;
  };
  return [...half(p), ...half([...p].reverse())];
}

/** Inside a convex polygon (edges included), whichever way it winds: screen y runs down. */
function inside(poly: Point[], q: Point) {
  if (poly.length < 3) return false;
  const sides = poly.map((a, i) => cross(a, poly[(i + 1) % poly.length], q));
  return sides.every((c) => c >= 0) || sides.every((c) => c <= 0);
}
