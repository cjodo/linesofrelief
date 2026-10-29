#!/usr/bin/env -S npx tsx

import { writeFileSync, mkdirSync } from 'node:fs';
import { resolve, dirname } from 'node:path';
import { fileURLToPath } from 'node:url';
import { LANDMARKS } from '../site/landmarks';

/**
 * Generate SVG representations of landmarks.
 * These SVGs can be used for icons, placeholders, or other visual elements.
 */

// Get the current directory
const __dirname = dirname(fileURLToPath(import.meta.url));

// Create a simple SVG for each landmark
function generateLandmarkSvg(landmark: typeof LANDMARKS[number]): string {
  const { slug, name, lat, lon, kind } = landmark;
  
  // Different SVG styles for different kinds of landmarks
  const getSvgStyle = () => {
    switch (kind) {
      case 'museum':
        return {
          color: '#4a6fa5',
          icon: 'M12 2L8 6H6V14H18V6H16L12 2Z M4 16V8H2V18H20V8H18V16H4Z', // Building with columns
        };
      case 'peak':
        return {
          color: '#5d4037',
          icon: 'M12 2L2 12H5V22H19V12H22L12 2Z', // Mountain
        };
      case 'lake':
        return {
          color: '#0288d1',
          icon: 'M2 12C2 6.48 6.48 2 12 2S22 6.48 22 12 17.52 22 12 22 2 17.52 2 12Z', // Circle (water)
        };
      case 'city':
        return {
          color: '#d32f2f',
          icon: 'M12 2C8.13 2 5 5.13 5 9C5 14.25 12 22 12 22S19 14.25 19 9C19 5.13 15.87 2 12 2Z', // City skyline
        };
      default:
        return {
          color: '#757575',
          icon: 'M12 2L2 7L12 12L22 7L12 2Z', // Default: diamond
        };
    }
  };
  
  const { color, icon } = getSvgStyle();
  
  return `<?xml version="1.0" encoding="UTF-8" standalone="no"?>
<svg xmlns="http://www.w3.org/2000/svg" viewBox="0 0 24 24" width="24" height="24">
  <path fill="${color}" d="${icon}"/>
  <title>${name} (${lat.toFixed(4)}, ${lon.toFixed(4)})</title>
</svg>`;
}

// Generate SVGs for all landmarks
function generateAllLandmarkSvgs() {
  const outputDir = resolve(__dirname, '../public/landmarks/svg');
  // Fix the path to be relative to the project root
  const correctOutputDir = resolve(__dirname, '../../public/landmarks/svg');
  
  // Create output directory if it doesn't exist
  mkdirSync(correctOutputDir, { recursive: true });
  
  for (const landmark of LANDMARKS) {
    const svg = generateLandmarkSvg(landmark);
    const outputPath = resolve(correctOutputDir, `${landmark.slug}.svg`);
    writeFileSync(outputPath, svg);
    console.log(`Generated SVG for ${landmark.name}: ${outputPath}`);
  }
  
  console.log(`Generated ${LANDMARKS.length} landmark SVGs in ${correctOutputDir}`);
}

// Run the script
generateAllLandmarkSvgs();