import { createGlobe } from './globe';

// /why/: the globe beside the reasons (site/pages.ts renders the canvas).
const canvas = document.querySelector<HTMLCanvasElement>('canvas.globe');
if (canvas?.dataset.texture) createGlobe(canvas, canvas.dataset.texture).catch(reportError);
