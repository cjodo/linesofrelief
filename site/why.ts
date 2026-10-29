/**
 * The words of /why/, kept apart from the markup (site/pages.ts) so they can
 * be edited freely. Paragraphs are HTML: plain text, with <a href> links where
 * wanted.
 */

export interface WhySection {
  heading: string;
  paragraphs: string[];
}

export const WHY = {
  title: 'Why',
  lede: 'Most maps try to show you everything. This one shows you the shape of the ground, and almost nothing else.',
  sections: [
    {
      heading: 'Contours, and nothing else',
      paragraphs: [
        'A contour line joins every point at one height. Draw enough of them and the land appears: ridges as tight ' +
          'ripples, valleys as long loose curves, a summit as a small closed ring. You read the mountain the way a ' +
          'climber does, by how steep it is and where it turns.',
        'So that is all I draw. No satellite photos, no shaded relief, no roads to speak of. Water, borders and a few ' +
          'names are there to orient you; the lines do the rest.',
      ],
    },
    {
      heading: 'One palette',
      paragraphs: [
        'Every line is coloured by its height, from teal valleys through iris and rose to gold summits, on a dark ' +
          'page. It is <a href="https://rosepinetheme.com">Rosé Pine</a>, and there is no other theme. One look, held ' +
          'everywhere, means a colour always means the same thing: gold is high, wherever you are.',
      ],
    },
    {
      heading: 'A handful of scales',
      paragraphs: [
        'There is no zoom slider. There are six steps, from a whole range to a single ridge, and at each one the ' +
          'lines are spaced so the page is never empty and never black with ink. Fewer choices, each one drawn well.',
      ],
    },
    {
      heading: 'Discovery over menus',
      paragraphs: [
        'Wander far enough and the map tells you where you are: a summit that matters at your scale, a new country, ' +
          'an ocean. Towns with museums wear a small badge. I would rather you find things than look them up.',
      ],
    },
    {
      heading: 'Your machine draws it',
      paragraphs: [
        'The contours are traced in your browser, from raw elevation, by a small Rust program compiled to ' +
          'WebAssembly. The server only fetches and caches. The whole site is a few dozen kilobytes of code, so it ' +
          'opens fast and stays out of the way.',
      ],
    },
  ] satisfies WhySection[],
  closing:
    'Start anywhere: <a href="/">search the whole world</a>, or begin with <a href="/mountains/">the summits</a>.',
};
