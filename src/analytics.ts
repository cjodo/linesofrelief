/**
 * Custom Google Analytics events. A no-op unless the build embedded a GA4 tag
 * (GA_ID set), so local builds and forks send nothing.
 */

declare global {
  interface Window {
    gtag?: (command: 'event', name: string, params?: Record<string, string | number>) => void;
  }
}

export function track(name: string, params?: Record<string, string | number>) {
  window.gtag?.('event', name, params);
}
