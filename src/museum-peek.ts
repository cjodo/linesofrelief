import { createIntent, dock, type Point, type Rect } from './hover';
import { museumInfo, renderMuseum, type MuseumSpot } from './museum-card';

/**
 * A museum's hover window: its card in compact form, beside whatever the
 * pointer rests on (an icon on the map, a row in a list). It opens on hover
 * the way everything here does (src/hover.ts); it never takes the pointer,
 * and a click opens the full card.
 */

export interface PeekTarget {
  /** Names what's hovered, so moving within it doesn't restart the wait. */
  key: string;
  spot: MuseumSpot;
  /** What it's beside, screen px. */
  anchor: Rect;
  side: 'above' | 'beside';
}

export function createPeek(root: HTMLElement) {
  let showing: string | null = null;

  const intent = createIntent<PeekTarget>({
    openMs: 160,
    closeMs: 60,
    onOpen: (target) => {
      showing = target.key;
      const place = () => dock(root, target.anchor, target.side, { gap: 10, lead: 28 });
      let ready: Awaited<ReturnType<typeof museumInfo>> | undefined;
      const info = museumInfo(target.spot).then((i) => (ready = i));
      // Usually fetched already (hovering fetches ahead): then no shimmer.
      queueMicrotask(() => {
        if (showing !== target.key) return;
        renderMuseum(root, target.spot, ready, { compact: true });
        place();
        root.classList.add('open');
        if (ready !== undefined) return;
        info.then((i) => {
          if (showing !== target.key) return;
          renderMuseum(root, target.spot, i, { compact: true });
          place();
        });
      });
    },
    onClose: () => {
      showing = null;
      root.classList.remove('open');
    },
  });

  return {
    /** The pointer moved: the museum it's on, if any, and where it is. */
    hover: (target: PeekTarget | null, at: Point) => intent.hover(target, at),
    hide: intent.hide,
  };
}
