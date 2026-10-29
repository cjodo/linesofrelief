/**
 * Coordinates typed or pasted into search, in the common shapes:
 *   51.1784, -115.5708          decimal, latitude first
 *   51.1784° N 115.5708° W      the map's own readout (either order)
 *   51°10'42"N 115°34'15"W      degrees, minutes, seconds
 *   -115.5708 51.1784           longitude first, when only that reads right
 */

/** One coordinate: optional hemisphere either side, degrees, then minutes and seconds. */
const PART =
  /\s*([NSEW])?\s*(-?\d+(?:\.\d+)?)\s*°?\s*(?:(\d+(?:\.\d+)?)\s*['′]\s*)?(?:(\d+(?:\.\d+)?)\s*(?:["″]|'')\s*)?([NSEW])?\s*[,;/]?/y;

interface Part {
  value: number;
  axis: 'lat' | 'lon' | null;
}

function readPart(s: string, from: number): [Part, number] | null {
  PART.lastIndex = from;
  const m = PART.exec(s);
  if (!m) return null;
  const [, before, deg, min, sec] = m;
  let [after, end]: [string | undefined, number] = [m[5], PART.lastIndex];
  // "N 51 W 115": a trailing letter after a leading one starts the next part.
  if (before && after) [after, end] = [undefined, m.index + m[0].lastIndexOf(after)];
  const minutes = Number(min ?? 0);
  const seconds = Number(sec ?? 0);
  if (minutes >= 60 || seconds >= 60) return null;
  const hemi = before ?? after;
  let value = Math.abs(Number(deg)) + minutes / 60 + seconds / 3600;
  if (deg.startsWith('-') || hemi === 'S' || hemi === 'W') value = -value;
  // A sign and a hemisphere that disagree ("-51 N") is a typo, not a place.
  if (deg.startsWith('-') && (hemi === 'N' || hemi === 'E')) return null;
  const axis = hemi === 'N' || hemi === 'S' ? 'lat' : hemi ? 'lon' : null;
  return [{ value, axis }, end];
}

/** Latitude and longitude, or null when `text` isn't a pair of coordinates. */
export function parseCoords(text: string): { lat: number; lon: number } | null {
  const s = text.trim().toUpperCase().replace(/[’‘]/g, "'").replace(/[”“]/g, '"');
  const first = readPart(s, 0);
  if (!first) return null;
  const second = readPart(s, first[1]);
  if (!second || second[1] !== s.length) return null;
  let [a, b] = [first[0], second[0]];
  if (a.axis && a.axis === b.axis) return null;
  // Hemisphere letters decide; without them it's latitude first, unless
  // only the other way round is on Earth.
  if (a.axis === 'lon' || b.axis === 'lat') [a, b] = [b, a];
  else if (!a.axis && !b.axis && Math.abs(a.value) > 90 && Math.abs(b.value) <= 90) [a, b] = [b, a];
  const [lat, lon] = [a.value, b.value];
  if (Math.abs(lat) > 90 || Math.abs(lon) > 180) return null;
  return { lat, lon };
}
