/**
 * @module vision/analyzer
 * @description Visual design analyzer for Google Slides screenshots.
 *
 * Uses the sharp library for pixel-level image analysis: element boundary
 * detection, dominant color extraction, visual balance measurement, and
 * region-based gap analysis.  Combines pixel-based heuristics with
 * structural rules from {@link design-rules} to produce comprehensive
 * design recommendations.
 */

import sharp from 'sharp';
import type {
  SlideContent,
  VisionAnalysis,
  DesignIssue,
  DesignIssueType,
} from '../shared/types.js';
import {
  DEFAULT_PAGE_WIDTH,
  DEFAULT_PAGE_HEIGHT,
} from '../shared/constants.js';
import { createVisionError } from '../shared/errors.js';
import { createLogger } from '../shared/logger.js';
import {
  evaluateAllRules,
  calculateDesignScore,
  getRecommendedFix,
  contrastRatio as computeContrastRatio,
  classifySlide,
  MAX_WORDS_PER_SLIDE,
} from './design-rules.js';

const log = createLogger('vision.analyzer');

// ─────────────────────────────────────────────────────────────────────────────
// Internal Types
// ─────────────────────────────────────────────────────────────────────────────

/** An extracted color with its frequency (pixel count) and hex representation. */
export interface ExtractedColor {
  /** Hex color string (e.g. "#1A73E8"). */
  hex: string;
  /** Red channel (0–255). */
  r: number;
  /** Green channel (0–255). */
  g: number;
  /** Blue channel (0–255). */
  b: number;
  /** Number of pixels that mapped to this color cluster. */
  count: number;
  /** Fraction of total sampled pixels in [0, 1]. */
  percentage: number;
}

/** Bounding box of a detected visual region in pixel coordinates. */
interface RegionBounds {
  x: number;
  y: number;
  width: number;
  height: number;
}

/** Quadrant weight distribution for balance analysis. */
interface QuadrantWeights {
  topLeft: number;
  topRight: number;
  bottomLeft: number;
  bottomRight: number;
}

/** Result of visual balance analysis. */
export interface BalanceResult {
  /** Overall balance score from 0 (very imbalanced) to 100 (perfect). */
  score: number;
  /** Horizontal imbalance ratio (0 = perfect, 1 = fully one-sided). */
  horizontalImbalance: number;
  /** Vertical imbalance ratio (0 = perfect, 1 = fully one-sided). */
  verticalImbalance: number;
  /** Weight distribution by quadrant. */
  quadrants: QuadrantWeights;
  /** Description of the balance analysis. */
  description: string;
}

/** Result of text density analysis. */
export interface TextDensityResult {
  /** Density score from 0 (no text) to 100 (extremely dense). */
  score: number;
  /** Total word count. */
  wordCount: number;
  /** Maximum recommended word count for this slide type. */
  maxWords: number;
  /** The slide type classification used. */
  slideType: string;
  /** Whether text density is within acceptable bounds. */
  acceptable: boolean;
}

// ─────────────────────────────────────────────────────────────────────────────
// Image Decoding Helpers
// ─────────────────────────────────────────────────────────────────────────────

/**
 * Decode a base64 PNG screenshot into raw RGBA pixel data.
 *
 * @param screenshotBase64 - Base64-encoded PNG data (may or may not include the data URI prefix).
 * @returns An object with width, height, channels, and the raw pixel buffer.
 */
async function decodeScreenshot(screenshotBase64: string): Promise<{
  width: number;
  height: number;
  channels: number;
  data: Buffer;
}> {
  // Validate input before processing
  if (!screenshotBase64 || typeof screenshotBase64 !== 'string') {
    throw createVisionError(
      new Error('screenshotBase64 must be a non-empty string'),
      'decode',
    );
  }

  if (screenshotBase64.length < 100) {
    throw createVisionError(
      new Error(
        `screenshotBase64 is too short (${screenshotBase64.length} chars) to be a valid image`,
      ),
      'decode',
    );
  }

  // Strip data URI prefix if present (e.g. "data:image/png;base64,")
  const base64Data = screenshotBase64.replace(/^data:image\/\w+;base64,/, '');

  // Validate that the remaining string contains only valid base64 characters
  if (!/^[A-Za-z0-9+/\n\r]+=*$/.test(base64Data)) {
    throw createVisionError(
      new Error('screenshotBase64 contains invalid base64 characters'),
      'decode',
    );
  }

  const buffer = Buffer.from(base64Data, 'base64');

  const image = sharp(buffer);
  const metadata = await image.metadata();

  if (!metadata.width || !metadata.height) {
    throw createVisionError(new Error('Cannot read image dimensions'), 'decode');
  }

  const rawBuffer = await image
    .ensureAlpha()
    .raw()
    .toBuffer();

  return {
    width: metadata.width,
    height: metadata.height,
    channels: 4, // RGBA
    data: rawBuffer,
  };
}

/**
 * Get the RGBA pixel value at a specific coordinate.
 *
 * @param data - Raw RGBA pixel buffer.
 * @param width - Image width.
 * @param x - X coordinate.
 * @param y - Y coordinate.
 * @returns An object with r, g, b, a channels (0–255).
 */
function getPixel(
  data: Buffer,
  width: number,
  x: number,
  y: number,
): { r: number; g: number; b: number; a: number } {
  const idx = (y * width + x) * 4;
  return {
    r: data[idx]!,
    g: data[idx + 1]!,
    b: data[idx + 2]!,
    a: data[idx + 3]!,
  };
}

// ─────────────────────────────────────────────────────────────────────────────
// Color Extraction
// ─────────────────────────────────────────────────────────────────────────────

/**
 * Quantize an RGB color to a reduced palette for clustering.
 * Divides each channel into buckets of 32 to group similar colors.
 */
function quantizeColor(r: number, g: number, b: number, bucketSize: number = 32): string {
  const qr = Math.floor(r / bucketSize) * bucketSize;
  const qg = Math.floor(g / bucketSize) * bucketSize;
  const qb = Math.floor(b / bucketSize) * bucketSize;
  return `${qr},${qg},${qb}`;
}

/**
 * Convert an RGB triple to a hex color string.
 */
function rgbToHex(r: number, g: number, b: number): string {
  const toHex = (n: number): string => {
    const clamped = Math.max(0, Math.min(255, Math.round(n)));
    return clamped.toString(16).padStart(2, '0');
  };
  return `#${toHex(r)}${toHex(g)}${toHex(b)}`.toUpperCase();
}

/**
 * Extract dominant colors from a screenshot using pixel sampling and quantization.
 *
 * Samples pixels on a grid pattern (every Nth pixel) and clusters them
 * by quantized color buckets. Returns the top colors sorted by frequency.
 *
 * @param screenshotBase64 - Base64-encoded PNG screenshot.
 * @param maxColors - Maximum number of colors to return (default 8).
 * @param sampleStep - Pixel sampling step size (default 4 = sample every 4th pixel).
 * @returns Array of extracted colors sorted by frequency.
 */
export async function extractDominantColors(
  screenshotBase64: string,
  maxColors: number = 8,
  sampleStep: number = 4,
): Promise<ExtractedColor[]> {
  try {
    const { width, height, data } = await decodeScreenshot(screenshotBase64);

    const colorCounts = new Map<string, { r: number; g: number; b: number; count: number }>();
    let totalSampled = 0;

    for (let y = 0; y < height; y += sampleStep) {
      for (let x = 0; x < width; x += sampleStep) {
        const pixel = getPixel(data, width, x, y);

        // Skip fully transparent pixels
        if (pixel.a < 128) continue;

        totalSampled++;
        const key = quantizeColor(pixel.r, pixel.g, pixel.b);
        const existing = colorCounts.get(key);

        if (existing) {
          // Running average for the cluster center
          const newCount = existing.count + 1;
          existing.r = (existing.r * existing.count + pixel.r) / newCount;
          existing.g = (existing.g * existing.count + pixel.g) / newCount;
          existing.b = (existing.b * existing.count + pixel.b) / newCount;
          existing.count = newCount;
        } else {
          colorCounts.set(key, { r: pixel.r, g: pixel.g, b: pixel.b, count: 1 });
        }
      }
    }

    // Sort by frequency and take top N
    const sorted = [...colorCounts.values()]
      .sort((a, b) => b.count - a.count)
      .slice(0, maxColors);

    return sorted.map((c) => ({
      hex: rgbToHex(c.r, c.g, c.b),
      r: Math.round(c.r),
      g: Math.round(c.g),
      b: Math.round(c.b),
      count: c.count,
      percentage: totalSampled > 0 ? c.count / totalSampled : 0,
    }));
  } catch (error) {
    throw createVisionError(error, 'extractDominantColors');
  }
}

// ─────────────────────────────────────────────────────────────────────────────
// Contrast Analysis
// ─────────────────────────────────────────────────────────────────────────────

/**
 * Check the WCAG contrast ratio between a foreground and background color.
 *
 * Uses proper sRGB linearization for relative luminance calculation.
 *
 * @param foreground - Foreground (text) hex color.
 * @param background - Background hex color.
 * @returns An object with the ratio, WCAG level achieved, and pass/fail status.
 */
export function checkContrastRatio(
  foreground: string,
  background: string,
): {
  ratio: number;
  wcagAA: boolean;
  wcagAALargeText: boolean;
  wcagAAA: boolean;
  wcagAAALargeText: boolean;
  foreground: string;
  background: string;
} {
  const ratio = computeContrastRatio(foreground, background);

  return {
    ratio: Math.round(ratio * 100) / 100,
    wcagAA: ratio >= 4.5,
    wcagAALargeText: ratio >= 3.0,
    wcagAAA: ratio >= 7.0,
    wcagAAALargeText: ratio >= 4.5,
    foreground,
    background,
  };
}

// ─────────────────────────────────────────────────────────────────────────────
// Text Density Analysis
// ─────────────────────────────────────────────────────────────────────────────

/**
 * Analyze the text density of a slide.
 *
 * @param slideContent - The structured slide content.
 * @returns Text density analysis result.
 */
export function analyzeTextDensity(slideContent: SlideContent): TextDensityResult {
  const slideType = classifySlide(slideContent);
  const maxWords = MAX_WORDS_PER_SLIDE[slideType];

  const allText = slideContent.elements
    .filter((e) => e.type === 'text' || e.type === 'shape')
    .map((e) => e.text ?? '')
    .join(' ');
  const wordCount = allText.split(/\s+/).filter(Boolean).length;

  // Score: 0 means no text, 100 means extremely dense
  const score = maxWords > 0
    ? Math.min(100, Math.round((wordCount / maxWords) * 100))
    : 0;

  return {
    score,
    wordCount,
    maxWords,
    slideType,
    acceptable: wordCount <= maxWords,
  };
}

// ─────────────────────────────────────────────────────────────────────────────
// Visual Balance Analysis
// ─────────────────────────────────────────────────────────────────────────────

/**
 * Analyze the visual balance of a slide screenshot by measuring pixel
 * luminance weight distribution across quadrants.
 *
 * Non-background pixels (pixels that differ from the dominant background
 * color) contribute visual weight. The weight distribution across the
 * four quadrants determines balance.
 *
 * @param screenshotBase64 - Base64-encoded PNG screenshot.
 * @returns Balance analysis result.
 */
export async function analyzeVisualBalance(
  screenshotBase64: string,
): Promise<BalanceResult> {
  try {
    const { width, height, data } = await decodeScreenshot(screenshotBase64);
    const sampleStep = Math.max(2, Math.floor(Math.min(width, height) / 200));

    // First pass: detect dominant background color (most common color in border region)
    const borderColors = new Map<string, number>();
    const borderWidth = Math.floor(width * 0.05);
    const borderHeight = Math.floor(height * 0.05);

    for (let y = 0; y < height; y += sampleStep) {
      for (let x = 0; x < width; x += sampleStep) {
        if (x < borderWidth || x >= width - borderWidth || y < borderHeight || y >= height - borderHeight) {
          const px = getPixel(data, width, x, y);
          const key = quantizeColor(px.r, px.g, px.b, 48);
          borderColors.set(key, (borderColors.get(key) ?? 0) + 1);
        }
      }
    }

    // Find dominant background color
    let bgKey = '';
    let bgMax = 0;
    for (const [key, count] of borderColors) {
      if (count > bgMax) {
        bgMax = count;
        bgKey = key;
      }
    }

    const bgParts = bgKey.split(',').map(Number);
    const bgR = bgParts[0] ?? 255;
    const bgG = bgParts[1] ?? 255;
    const bgB = bgParts[2] ?? 255;

    // Second pass: measure visual weight per quadrant
    const centerX = Math.floor(width / 2);
    const centerY = Math.floor(height / 2);

    const quadrants: QuadrantWeights = { topLeft: 0, topRight: 0, bottomLeft: 0, bottomRight: 0 };
    let totalWeight = 0;

    for (let y = 0; y < height; y += sampleStep) {
      for (let x = 0; x < width; x += sampleStep) {
        const px = getPixel(data, width, x, y);
        if (px.a < 128) continue;

        // Distance from background color (Euclidean in RGB space)
        const dist = Math.sqrt(
          (px.r - bgR) ** 2 +
          (px.g - bgG) ** 2 +
          (px.b - bgB) ** 2,
        );

        // Only count pixels significantly different from background
        if (dist < 30) continue;

        // Visual weight is proportional to distance from background
        const weight = dist;
        totalWeight += weight;

        if (x < centerX) {
          if (y < centerY) quadrants.topLeft += weight;
          else quadrants.bottomLeft += weight;
        } else {
          if (y < centerY) quadrants.topRight += weight;
          else quadrants.bottomRight += weight;
        }
      }
    }

    // Calculate imbalance
    const leftWeight = quadrants.topLeft + quadrants.bottomLeft;
    const rightWeight = quadrants.topRight + quadrants.bottomRight;
    const topWeight = quadrants.topLeft + quadrants.topRight;
    const bottomWeight = quadrants.bottomLeft + quadrants.bottomRight;

    const horizontalImbalance = totalWeight > 0
      ? Math.abs(leftWeight - rightWeight) / totalWeight
      : 0;
    const verticalImbalance = totalWeight > 0
      ? Math.abs(topWeight - bottomWeight) / totalWeight
      : 0;

    // Score: 100 = perfectly balanced, 0 = maximally imbalanced
    const combinedImbalance = (horizontalImbalance + verticalImbalance) / 2;
    const score = Math.round(Math.max(0, Math.min(100, (1 - combinedImbalance) * 100)));

    let description: string;
    if (score >= 80) {
      description = 'Well-balanced layout with evenly distributed visual weight.';
    } else if (score >= 60) {
      const heavySide = leftWeight > rightWeight ? 'left' : 'right';
      const heavyVert = topWeight > bottomWeight ? 'top' : 'bottom';
      description = `Slightly ${heavySide}-heavy and ${heavyVert}-heavy layout.`;
    } else {
      const heavySide = leftWeight > rightWeight ? 'left' : 'right';
      const heavyVert = topWeight > bottomWeight ? 'top' : 'bottom';
      description = `Significantly imbalanced layout: ${heavySide}-heavy (${(horizontalImbalance * 100).toFixed(0)}%) and ${heavyVert}-heavy (${(verticalImbalance * 100).toFixed(0)}%).`;
    }

    return {
      score,
      horizontalImbalance: Math.round(horizontalImbalance * 1000) / 1000,
      verticalImbalance: Math.round(verticalImbalance * 1000) / 1000,
      quadrants: {
        topLeft: Math.round(quadrants.topLeft),
        topRight: Math.round(quadrants.topRight),
        bottomLeft: Math.round(quadrants.bottomLeft),
        bottomRight: Math.round(quadrants.bottomRight),
      },
      description,
    };
  } catch (error) {
    throw createVisionError(error, 'analyzeVisualBalance');
  }
}

// ─────────────────────────────────────────────────────────────────────────────
// Element Boundary Detection (pixel-based)
// ─────────────────────────────────────────────────────────────────────────────

/**
 * Detect element boundary regions in a screenshot by scanning for
 * contiguous non-background pixel clusters.
 *
 * This is a lightweight approach: scan rows and columns for transitions
 * between background and foreground, then merge overlapping bounding boxes.
 *
 * @param screenshotBase64 - Base64-encoded PNG screenshot.
 * @returns Array of detected region bounding boxes.
 */
export async function detectElementBoundaries(
  screenshotBase64: string,
): Promise<RegionBounds[]> {
  const { width, height, data } = await decodeScreenshot(screenshotBase64);
  const sampleStep = Math.max(1, Math.floor(Math.min(width, height) / 300));

  // Detect background color (most common in first and last rows)
  const bgCounts = new Map<string, number>();
  for (let x = 0; x < width; x += sampleStep) {
    for (const row of [0, 1, height - 2, height - 1]) {
      const px = getPixel(data, width, x, row);
      const key = quantizeColor(px.r, px.g, px.b, 48);
      bgCounts.set(key, (bgCounts.get(key) ?? 0) + 1);
    }
  }

  let bgKey = '';
  let bgMax = 0;
  for (const [key, count] of bgCounts) {
    if (count > bgMax) { bgMax = count; bgKey = key; }
  }
  const bgParts = bgKey.split(',').map(Number);
  const bgR = bgParts[0] ?? 255;
  const bgG = bgParts[1] ?? 255;
  const bgB = bgParts[2] ?? 255;

  // Create a binary mask: 1 = foreground, 0 = background
  const maskWidth = Math.ceil(width / sampleStep);
  const maskHeight = Math.ceil(height / sampleStep);
  const mask = new Uint8Array(maskWidth * maskHeight);

  for (let my = 0; my < maskHeight; my++) {
    for (let mx = 0; mx < maskWidth; mx++) {
      const px = getPixel(data, width, mx * sampleStep, my * sampleStep);
      const dist = Math.sqrt((px.r - bgR) ** 2 + (px.g - bgG) ** 2 + (px.b - bgB) ** 2);
      mask[my * maskWidth + mx] = dist > 35 ? 1 : 0;
    }
  }

  // Connected component labeling (simple scan-line approach)
  const labels = new Int32Array(maskWidth * maskHeight);
  let nextLabel = 1;
  const equivalences = new Map<number, number>();

  function findRoot(label: number): number {
    let root = label;
    while (equivalences.has(root)) {
      root = equivalences.get(root)!;
    }
    return root;
  }

  for (let my = 0; my < maskHeight; my++) {
    for (let mx = 0; mx < maskWidth; mx++) {
      const idx = my * maskWidth + mx;
      if (mask[idx] === 0) continue;

      const above = my > 0 ? labels[(my - 1) * maskWidth + mx] : 0;
      const left = mx > 0 ? labels[my * maskWidth + (mx - 1)] : 0;

      if (above === 0 && left === 0) {
        labels[idx] = nextLabel++;
      } else if (above > 0 && left === 0) {
        labels[idx] = findRoot(above);
      } else if (above === 0 && left > 0) {
        labels[idx] = findRoot(left);
      } else {
        const rootA = findRoot(above);
        const rootL = findRoot(left);
        const minRoot = Math.min(rootA, rootL);
        const maxRoot = Math.max(rootA, rootL);
        labels[idx] = minRoot;
        if (minRoot !== maxRoot) {
          equivalences.set(maxRoot, minRoot);
        }
      }
    }
  }

  // Collect bounding boxes per component
  const componentBounds = new Map<number, { minX: number; minY: number; maxX: number; maxY: number; count: number }>();

  for (let my = 0; my < maskHeight; my++) {
    for (let mx = 0; mx < maskWidth; mx++) {
      const label = labels[my * maskWidth + mx];
      if (label === 0) continue;
      const root = findRoot(label);

      const existing = componentBounds.get(root);
      if (existing) {
        existing.minX = Math.min(existing.minX, mx);
        existing.minY = Math.min(existing.minY, my);
        existing.maxX = Math.max(existing.maxX, mx);
        existing.maxY = Math.max(existing.maxY, my);
        existing.count++;
      } else {
        componentBounds.set(root, { minX: mx, minY: my, maxX: mx, maxY: my, count: 1 });
      }
    }
  }

  // Filter out tiny regions (noise) and convert to pixel coordinates
  const minComponentPixels = 20;
  const regions: RegionBounds[] = [];

  for (const bounds of componentBounds.values()) {
    if (bounds.count < minComponentPixels) continue;

    regions.push({
      x: bounds.minX * sampleStep,
      y: bounds.minY * sampleStep,
      width: (bounds.maxX - bounds.minX + 1) * sampleStep,
      height: (bounds.maxY - bounds.minY + 1) * sampleStep,
    });
  }

  return regions;
}

// ─────────────────────────────────────────────────────────────────────────────
// Screenshot-Based Design Checks
// ─────────────────────────────────────────────────────────────────────────────

/**
 * Run pixel-based alignment analysis on detected element boundaries.
 *
 * @param regions - Detected region bounding boxes.
 * @param imageWidth - Image width in pixels.
 * @param imageHeight - Image height in pixels.
 * @returns Array of alignment issues found.
 */
function checkPixelAlignment(
  regions: RegionBounds[],
  imageWidth: number,
  _imageHeight: number,
): DesignIssue[] {
  if (regions.length < 2) return [];

  const issues: DesignIssue[] = [];

  // Collect left edges and check for near-misses
  const leftEdges = regions.map((r) => r.x);
  const tolerance = imageWidth * 0.01; // 1% of image width

  for (let i = 0; i < leftEdges.length; i++) {
    for (let j = i + 1; j < leftEdges.length; j++) {
      const diff = Math.abs(leftEdges[i]! - leftEdges[j]!);
      if (diff > tolerance && diff < tolerance * 5) {
        issues.push({
          type: 'alignment',
          severity: 'low',
          description: `Two regions have left edges misaligned by ${diff.toFixed(0)}px (near-miss alignment).`,
          fix: 'Snap region left edges to a common x-coordinate.',
        });
        break; // Only report once
      }
    }
  }

  // Check for margin consistency
  const leftMargins = regions.map((r) => r.x);
  const rightMargins = regions.map((r) => imageWidth - (r.x + r.width));

  const avgLeftMargin = leftMargins.reduce((a, b) => a + b, 0) / leftMargins.length;
  const avgRightMargin = rightMargins.reduce((a, b) => a + b, 0) / rightMargins.length;

  if (Math.abs(avgLeftMargin - avgRightMargin) > imageWidth * 0.1) {
    issues.push({
      type: 'alignment',
      severity: 'medium',
      description: `Asymmetric margins: average left margin ${avgLeftMargin.toFixed(0)}px vs right margin ${avgRightMargin.toFixed(0)}px.`,
      fix: 'Center content or equalize left and right margins.',
    });
  }

  return issues;
}

/**
 * Run pixel-based spacing analysis on detected regions.
 *
 * @param regions - Detected region bounding boxes.
 * @param imageWidth - Image width in pixels.
 * @param imageHeight - Image height in pixels.
 * @returns Array of spacing issues found.
 */
function checkPixelSpacing(
  regions: RegionBounds[],
  imageWidth: number,
  imageHeight: number,
): DesignIssue[] {
  if (regions.length < 2) return [];

  const issues: DesignIssue[] = [];

  // Sort regions by vertical position and check gaps
  const sorted = [...regions].sort((a, b) => a.y - b.y);
  const verticalGaps: number[] = [];

  for (let i = 0; i < sorted.length - 1; i++) {
    const current = sorted[i]!;
    const next = sorted[i + 1]!;
    const gap = next.y - (current.y + current.height);
    if (gap > 0) {
      verticalGaps.push(gap);
    }
  }

  if (verticalGaps.length >= 2) {
    const avgGap = verticalGaps.reduce((a, b) => a + b, 0) / verticalGaps.length;
    const maxDev = Math.max(...verticalGaps.map((g) => Math.abs(g - avgGap)));

    if (maxDev > avgGap * 0.6 && maxDev > imageHeight * 0.02) {
      issues.push({
        type: 'spacing',
        severity: 'medium',
        description: `Inconsistent vertical gaps between regions: ${Math.min(...verticalGaps).toFixed(0)}px to ${Math.max(...verticalGaps).toFixed(0)}px (${maxDev.toFixed(0)}px deviation from average ${avgGap.toFixed(0)}px).`,
        fix: 'Normalize vertical spacing between content regions.',
      });
    }
  }

  // Check if any region is too close to an edge
  const edgeThreshold = Math.min(imageWidth, imageHeight) * 0.03;
  for (const region of regions) {
    if (region.x < edgeThreshold && region.width < imageWidth * 0.9) {
      issues.push({
        type: 'spacing',
        severity: 'medium',
        description: `A content region is only ${region.x}px from the left edge (minimum recommended: ${edgeThreshold.toFixed(0)}px).`,
        fix: 'Add more padding on the left side.',
      });
    }
    if (region.y < edgeThreshold && region.height < imageHeight * 0.9) {
      issues.push({
        type: 'spacing',
        severity: 'medium',
        description: `A content region is only ${region.y}px from the top edge (minimum recommended: ${edgeThreshold.toFixed(0)}px).`,
        fix: 'Add more padding on the top.',
      });
    }
  }

  return issues;
}

// ─────────────────────────────────────────────────────────────────────────────
// Color Contrast Analysis (pixel-based)
// ─────────────────────────────────────────────────────────────────────────────

/**
 * Analyze color contrast from extracted colors.
 * Assumes the most dominant color is the background and checks contrast
 * of other dominant colors against it.
 *
 * @param colors - Extracted dominant colors (sorted by frequency).
 * @returns Array of contrast issues found.
 */
function checkExtractedColorContrast(colors: ExtractedColor[]): DesignIssue[] {
  if (colors.length < 2) return [];

  const issues: DesignIssue[] = [];
  const bgColor = colors[0]!; // Most dominant = likely background

  for (let i = 1; i < Math.min(colors.length, 6); i++) {
    const fgColor = colors[i]!;
    // Skip colors that are too similar to background (likely background variants)
    const colorDist = Math.sqrt(
      (fgColor.r - bgColor.r) ** 2 +
      (fgColor.g - bgColor.g) ** 2 +
      (fgColor.b - bgColor.b) ** 2,
    );
    if (colorDist < 40) continue;

    const ratio = computeContrastRatio(fgColor.hex, bgColor.hex);

    if (ratio < 3.0 && fgColor.percentage > 0.02) {
      issues.push({
        type: 'contrast',
        severity: ratio < 2.0 ? 'high' : 'medium',
        description: `Low contrast between ${fgColor.hex} (${(fgColor.percentage * 100).toFixed(1)}% of pixels) and background ${bgColor.hex}: ratio ${ratio.toFixed(2)}:1. WCAG AA requires at least 3:1 for large text, 4.5:1 for normal text.`,
        fix: `Darken or lighten the foreground color ${fgColor.hex} to achieve at least 4.5:1 contrast against ${bgColor.hex}.`,
      });
    }
  }

  return issues;
}

// ─────────────────────────────────────────────────────────────────────────────
// Main Analysis Functions
// ─────────────────────────────────────────────────────────────────────────────

/**
 * Perform a comprehensive visual design analysis of a slide screenshot.
 *
 * Combines pixel-level analysis (color extraction, balance measurement,
 * element boundary detection, spacing/alignment checks) with structural
 * design rules (from the rules engine) when slide context is available.
 *
 * @param screenshotBase64 - Base64-encoded PNG screenshot of the slide.
 * @param slideContext - Optional structured slide content for rule-based analysis.
 * @param pageWidth - Page width in points (defaults to 720).
 * @param pageHeight - Page height in points (defaults to 405).
 * @returns A comprehensive VisionAnalysis result.
 */
export async function analyzeSlideDesign(
  screenshotBase64: string,
  slideContext?: SlideContent,
  pageWidth: number = DEFAULT_PAGE_WIDTH,
  pageHeight: number = DEFAULT_PAGE_HEIGHT,
): Promise<VisionAnalysis> {
  log.info('Starting slide design analysis', {
    hasSlideContext: !!slideContext,
    screenshotLength: screenshotBase64.length,
  });

  const allIssues: DesignIssue[] = [];
  const suggestions: string[] = [];

  try {
    // ── Pixel-based analysis ────────────────────────────────────────────

    // 1. Extract dominant colors
    const colors = await extractDominantColors(screenshotBase64, 10, 3);
    log.debug('Extracted dominant colors', { count: colors.length });

    // 2. Analyze visual balance
    const balance = await analyzeVisualBalance(screenshotBase64);
    log.debug('Visual balance analysis complete', { score: balance.score });

    if (balance.score < 60) {
      allIssues.push({
        type: 'balance',
        severity: balance.score < 40 ? 'high' : 'medium',
        description: balance.description,
        fix: 'Redistribute visual elements more evenly across the slide.',
      });
      suggestions.push(balance.description);
    }

    // 3. Detect element boundaries
    const regions = await detectElementBoundaries(screenshotBase64);
    log.debug('Detected element regions', { count: regions.length });

    // 4. Pixel-based alignment checks
    const { width: imgWidth, height: imgHeight } = await decodeScreenshot(screenshotBase64).then(
      (img) => ({ width: img.width, height: img.height }),
    );
    const alignmentIssues = checkPixelAlignment(regions, imgWidth, imgHeight);
    allIssues.push(...alignmentIssues);

    // 5. Pixel-based spacing checks
    const spacingIssues = checkPixelSpacing(regions, imgWidth, imgHeight);
    allIssues.push(...spacingIssues);

    // 6. Color contrast checks
    const contrastIssues = checkExtractedColorContrast(colors);
    allIssues.push(...contrastIssues);

    // ── Structure-based analysis (requires slide context) ───────────────

    if (slideContext) {
      const ruleIssues = evaluateAllRules(slideContext, pageWidth, pageHeight);
      allIssues.push(...ruleIssues);

      // Text density analysis
      const density = analyzeTextDensity(slideContext);
      if (!density.acceptable) {
        suggestions.push(
          `Slide has ${density.wordCount} words (recommended max: ${density.maxWords} for ${density.slideType} slides). Consider splitting content across multiple slides.`,
        );
      }
    }

    // ── Generate suggestions ────────────────────────────────────────────

    // Aggregate suggestions from issues
    const issuesByType = new Map<DesignIssueType, DesignIssue[]>();
    for (const issue of allIssues) {
      const existing = issuesByType.get(issue.type) ?? [];
      existing.push(issue);
      issuesByType.set(issue.type, existing);
    }

    for (const [type, issues] of issuesByType) {
      const highSeverity = issues.filter((i) => i.severity === 'high');
      if (highSeverity.length > 0) {
        suggestions.push(
          `High-priority ${type} issues found (${highSeverity.length}). ${getRecommendedFix(highSeverity[0]!)}`,
        );
      } else if (issues.length >= 3) {
        suggestions.push(
          `Multiple ${type} issues found (${issues.length}). Consider a systematic review of ${type} across the slide.`,
        );
      }
    }

    // Add color palette suggestion if many distinct colors
    if (colors.length > 5) {
      const significantColors = colors.filter((c) => c.percentage > 0.03);
      if (significantColors.length > 4) {
        suggestions.push(
          `Slide uses ${significantColors.length} significant colors. Consider simplifying to a 3-4 color palette for a more cohesive look.`,
        );
      }
    }

    // Calculate final score
    const score = calculateDesignScore(allIssues);

    // Add a general quality suggestion based on score
    if (score >= 90) {
      suggestions.unshift('Excellent design quality. Minor refinements may further polish the slide.');
    } else if (score >= 70) {
      suggestions.unshift('Good design quality with some areas for improvement.');
    } else if (score >= 50) {
      suggestions.unshift('Design needs moderate improvements. Address high-severity issues first.');
    } else {
      suggestions.unshift('Significant design issues found. Consider a comprehensive redesign or applying a professional theme.');
    }

    log.info('Design analysis complete', {
      issueCount: allIssues.length,
      score,
      suggestionCount: suggestions.length,
    });

    return { issues: allIssues, score, suggestions };
  } catch (error) {
    log.error('Design analysis failed', { error: String(error) });
    throw createVisionError(error, 'analyzeSlideDesign');
  }
}

/**
 * Compare two slides for design consistency by analyzing their screenshots
 * and comparing dominant colors, balance, and spacing characteristics.
 *
 * @param screenshot1Base64 - First slide screenshot (base64 PNG).
 * @param screenshot2Base64 - Second slide screenshot (base64 PNG).
 * @returns Consistency analysis result.
 */
export async function compareSlideConsistency(
  screenshot1Base64: string,
  screenshot2Base64: string,
): Promise<{
  consistent: boolean;
  score: number;
  differences: string[];
}> {
  try {
    const [colors1, colors2, balance1, balance2] = await Promise.all([
      extractDominantColors(screenshot1Base64, 6),
      extractDominantColors(screenshot2Base64, 6),
      analyzeVisualBalance(screenshot1Base64),
      analyzeVisualBalance(screenshot2Base64),
    ]);

    const differences: string[] = [];

    // Compare background colors
    if (colors1.length > 0 && colors2.length > 0) {
      const bg1 = colors1[0]!;
      const bg2 = colors2[0]!;
      const bgDist = Math.sqrt((bg1.r - bg2.r) ** 2 + (bg1.g - bg2.g) ** 2 + (bg1.b - bg2.b) ** 2);

      if (bgDist > 40) {
        differences.push(
          `Background colors differ significantly: ${bg1.hex} vs ${bg2.hex} (distance: ${bgDist.toFixed(0)}).`,
        );
      }
    }

    // Compare color palettes (check if top colors are similar)
    const colors1Top = new Set(colors1.slice(0, 4).map((c) => quantizeColor(c.r, c.g, c.b, 48)));
    const colors2Top = new Set(colors2.slice(0, 4).map((c) => quantizeColor(c.r, c.g, c.b, 48)));
    let sharedColors = 0;
    for (const c of colors1Top) {
      if (colors2Top.has(c)) sharedColors++;
    }
    const paletteSimilarity = colors1Top.size > 0 ? sharedColors / colors1Top.size : 1;

    if (paletteSimilarity < 0.5) {
      differences.push(
        `Color palettes are inconsistent: only ${(paletteSimilarity * 100).toFixed(0)}% overlap in dominant colors.`,
      );
    }

    // Compare balance
    const balanceDiff = Math.abs(balance1.score - balance2.score);
    if (balanceDiff > 30) {
      differences.push(
        `Significant layout balance difference: slide 1 score ${balance1.score} vs slide 2 score ${balance2.score}.`,
      );
    }

    // Overall consistency score
    let consistencyScore = 100;
    consistencyScore -= differences.length * 15;
    consistencyScore -= (1 - paletteSimilarity) * 30;
    consistencyScore -= balanceDiff * 0.3;
    consistencyScore = Math.max(0, Math.min(100, Math.round(consistencyScore)));

    return {
      consistent: consistencyScore >= 70,
      score: consistencyScore,
      differences,
    };
  } catch (error) {
    throw createVisionError(error, 'compareSlideConsistency');
  }
}
