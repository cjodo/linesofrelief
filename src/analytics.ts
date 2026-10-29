/**
 * Custom analytics events. A no-op unless the build embedded a Google tag, so
 * dev builds and forks send nothing. With Tag Manager they're dataLayer events
 * (trigger on their names); with a GA4 tag, gtag events.
 */

type Params = Record<string, string | number>;

declare global {
  interface Window {
    topoAnalytics?: 'gtm';
    dataLayer?: unknown[];
    gtag?: (command: 'event', name: string, params?: Params) => void;
  }
}

export function track(name: string, params: Params = {}) {
  if (window.topoAnalytics === 'gtm') window.dataLayer?.push({ event: name, ...params });
  else window.gtag?.('event', name, params);
}
