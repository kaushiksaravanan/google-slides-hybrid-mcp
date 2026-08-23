/**
 * @module vision/design-rules
 * @description Professional design rules engine for slide analysis.
 *
 * Defines a comprehensive set of rules for evaluating professional slide
 * design quality. Each rule checks a specific aspect of design (typography,
 * color, spacing, alignment, etc.) and returns a structured result indicating
 * pass/fail, severity, and a human-readable message.
 */

import type {
  SlideContent,
  DesignIssue,
  DesignIssueType,
  DesignIssueSeverity,
} from '../shared/types.js';
import {
  DEFAULT_PAGE_WIDTH,
  DEFAULT_PAGE_HEIGHT,
} from '../shared/constants.js';

// ─────────────────────────────────────────────────────────────────────────────
// Slide Type Classification
// ─────────────────────────────────────────────────────────────────────────────

/** Classification of slide types for context-aware rules. */
export type SlideType = 'title' | 'content' | 'data' | 'image' | 'section' | 'blank';

/**
 * Classify a slide based on its content to apply context-aware rules.
 *
 * @param slide - The slide content to classify.
 * @returns The detected slide type.
 */
export function classifySlide(slide: SlideContent): SlideType {
  const textElements = slide.elements.filter((e) => e.type === 'text' || e.type === 'shape');
  const imageElements = slide.elements.filter((e) => e.type === 'image');
  const chartElements = slide.elements.filter((e) => e.type === 'chart' || e.type === 'table' || e.type === 'sheetsChart');

  if (slide.elements.length === 0) return 'blank';
  if (chartElements.length > 0) return 'data';
  if (imageElements.length > textElements.length) return 'image';

  const totalText = textElements
    .map((e) => e.text ?? '')
    .join(' ');
  const wordCount = totalText.split(/\s+/).filter(Boolean).length;

  if (wordCount <= 15 && textElements.length <= 2) return 'title';
  if (wordCount <= 20 && slide.slideIndex > 0 && textElements.length <= 2) return 'section';
  return 'content';
}

// ─────────────────────────────────────────────────────────────────────────────
// Design Thresholds
// ─────────────────────────────────────────────────────────────────────────────

/** Maximum word counts per slide type. */
export const MAX_WORDS_PER_SLIDE: Readonly<Record<SlideType, number>> = {
  title: 10,
  content: 50,
  data: 30,
  image: 20,
  section: 15,
  blank: 0,
};

/** WCAG AA contrast ratio requirements. */
export const WCAG_CONTRAST = {
  /** Minimum contrast ratio for normal text (< 18pt or < 14pt bold). */
  normalText: 4.5,
  /** Minimum contrast ratio for large text (>= 18pt or >= 14pt bold). */
  largeText: 3.0,
  /** Enhanced (AAA) minimum for normal text. */
  enhancedNormal: 7.0,
  /** Enhanced (AAA) minimum for large text. */
  enhancedLarge: 4.5,
} as const;

/** Alignment tolerance in points — elements within this tolerance are considered aligned. */
export const ALIGNMENT_TOLERANCE_PT = 5;

/** Minimum font sizes by semantic role (in points). */
export const MIN_FONT_SIZES = {
  title: 28,
  body: 18,
  caption: 14,
} as const;

/** Recommended font pairings. Title font -> acceptable body fonts. */
export const RECOMMENDED_FONT_PAIRINGS: ReadonlyArray<{
  titleFonts: string[];
  bodyFonts: string[];
}> = [
  { titleFonts: ['Roboto', 'Roboto Slab'], bodyFonts: ['Roboto', 'Open Sans', 'Lato'] },
  { titleFonts: ['Montserrat'], bodyFonts: ['Open Sans', 'Roboto', 'Lato'] },
  { titleFonts: ['Playfair Display'], bodyFonts: ['Source Sans Pro', 'Lato', 'Roboto'] },
  { titleFonts: ['Oswald'], bodyFonts: ['Open Sans', 'Lato', 'Roboto'] },
  { titleFonts: ['Raleway'], bodyFonts: ['Roboto', 'Open Sans', 'Merriweather'] },
  { titleFonts: ['Arial', 'Helvetica'], bodyFonts: ['Arial', 'Helvetica', 'Georgia'] },
  { titleFonts: ['Georgia', 'Times New Roman'], bodyFonts: ['Arial', 'Helvetica', 'Open Sans'] },
];

/** Maximum number of distinct colors recommended on a single slide. */
export const MAX_COLORS_PER_SLIDE = 4;

/** Minimum margin as a fraction of slide dimensions. */
export const MIN_MARGIN_FRACTION = 0.10;

/** Minimum image resolution (pixels) before quality degrades at presentation size. */
export const MIN_IMAGE_RESOLUTION = 150;

/** Maximum acceptable aspect ratio distortion (deviation from 1.0 = no stretch). */
export const MAX_ASPECT_RATIO_DISTORTION = 0.15;

// ─────────────────────────────────────────────────────────────────────────────
// Rule Evaluation Result
// ─────────────────────────────────────────────────────────────────────────────

/** Result of evaluating a single design rule. */
export interface RuleEvaluationResult {
  /** Whether the rule passed. */
  passed: boolean;
  /** Severity if the rule failed. */
  severity: DesignIssueSeverity;
  /** Human-readable message describing the result. */
  message: string;
  /** The design issue type this rule relates to. */
  type: DesignIssueType;
  /** Affected element ID, if applicable. */
  element?: string;
  /** Suggested fix description. */
  fix?: string;
}

// ─────────────────────────────────────────────────────────────────────────────
// Rule Definition
// ─────────────────────────────────────────────────────────────────────────────

/** A named design rule with an evaluation function. */
export interface DesignRule {
  /** Unique rule identifier. */
  id: string;
  /** Human-readable rule name. */
  name: string;
  /** The design issue category. */
  type: DesignIssueType;
  /** Rule description. */
  description: string;
  /** Evaluate the rule against slide data. Returns one or more results. */
  evaluate: (slide: SlideContent, pageWidth?: number, pageHeight?: number) => RuleEvaluationResult[];
}

// ─────────────────────────────────────────────────────────────────────────────
// Color Utility Functions
// ─────────────────────────────────────────────────────────────────────────────

/**
 * Parse a hex color string to RGB components (0–255).
 *
 * @param hex - A hex color string like "#FF5733" or "#FFF".
 * @returns An object with r, g, b in [0, 255].
 */
export function parseHexColor(hex: string): { r: number; g: number; b: number } {
  const cleaned = hex.replace('#', '');
  let r: number, g: number, b: number;

  if (cleaned.length === 3) {
    r = parseInt(cleaned[0]! + cleaned[0]!, 16);
    g = parseInt(cleaned[1]! + cleaned[1]!, 16);
    b = parseInt(cleaned[2]! + cleaned[2]!, 16);
  } else if (cleaned.length >= 6) {
    r = parseInt(cleaned.slice(0, 2), 16);
    g = parseInt(cleaned.slice(2, 4), 16);
    b = parseInt(cleaned.slice(4, 6), 16);
  } else {
    return { r: 0, g: 0, b: 0 };
  }

  return { r, g, b };
}

/**
 * Calculate the relative luminance of a color per WCAG 2.1 spec.
 * Uses the sRGB linearization formula.
 *
 * @see https://www.w3.org/TR/WCAG21/#dfn-relative-luminance
 * @param r - Red channel (0–255).
 * @param g - Green channel (0–255).
 * @param b - Blue channel (0–255).
 * @returns Relative luminance in [0, 1].
 */
export function relativeLuminance(r: number, g: number, b: number): number {
  const linearize = (channel: number): number => {
    const sRGB = channel / 255;
    return sRGB <= 0.03928 ? sRGB / 12.92 : Math.pow((sRGB + 0.055) / 1.055, 2.4);
  };

  const rLin = linearize(r);
  const gLin = linearize(g);
  const bLin = linearize(b);

  return 0.2126 * rLin + 0.7152 * gLin + 0.0722 * bLin;
}

/**
 * Calculate the WCAG contrast ratio between two colors.
 *
 * @param fg - Foreground hex color.
 * @param bg - Background hex color.
 * @returns Contrast ratio (1 to 21).
 */
export function contrastRatio(fg: string, bg: string): number {
  const fgRgb = parseHexColor(fg);
  const bgRgb = parseHexColor(bg);
  const fgLum = relativeLuminance(fgRgb.r, fgRgb.g, fgRgb.b);
  const bgLum = relativeLuminance(bgRgb.r, bgRgb.g, bgRgb.b);

  const lighter = Math.max(fgLum, bgLum);
  const darker = Math.min(fgLum, bgLum);

  return (lighter + 0.05) / (darker + 0.05);
}

// ─────────────────────────────────────────────────────────────────────────────
// Individual Rules
// ─────────────────────────────────────────────────────────────────────────────

/**
 * Rule: Text density — check for too many words on a slide.
 */
const textDensityRule: DesignRule = {
  id: 'text-density',
  name: 'Text Density',
  type: 'hierarchy',
  description: 'Checks whether the slide has too much text for its type.',
  evaluate(slide) {
    const slideType = classifySlide(slide);
    const maxWords = MAX_WORDS_PER_SLIDE[slideType];
    if (maxWords === 0) return [];

    const allText = slide.elements
      .filter((e) => e.type === 'text' || e.type === 'shape')
      .map((e) => e.text ?? '')
      .join(' ');
    const wordCount = allText.split(/\s+/).filter(Boolean).length;

    if (wordCount <= maxWords) {
      return [{
        passed: true,
        severity: 'low',
        message: `Text density OK: ${wordCount} words (max ${maxWords} for ${slideType} slide).`,
        type: 'hierarchy',
      }];
    }

    const overage = wordCount - maxWords;
    const severity: DesignIssueSeverity = overage > maxWords * 0.5 ? 'high' : 'medium';

    return [{
      passed: false,
      severity,
      message: `Slide has ${wordCount} words, exceeding the ${maxWords}-word limit for a ${slideType} slide by ${overage} words.`,
      type: 'hierarchy',
      fix: overage > maxWords
        ? `Consider splitting this slide into ${Math.ceil(wordCount / maxWords)} slides.`
        : 'Reduce text by removing non-essential words or moving details to speaker notes.',
    }];
  },
};

/**
 * Rule: Minimum font sizes — ensure text is readable.
 */
const fontSizeRule: DesignRule = {
  id: 'font-size',
  name: 'Font Size',
  type: 'font',
  description: 'Checks that all text elements meet minimum font size requirements.',
  evaluate(slide) {
    const results: RuleEvaluationResult[] = [];

    for (const element of slide.elements) {
      if (!element.styles?.fontSize) continue;
      const fontSize = element.styles.fontSize;

      // Determine whether this is a title element
      const isTitle = element.text?.toLowerCase() === slide.title?.toLowerCase() ||
        (element.position.y < 100 && fontSize >= 24);
      const isCaption = fontSize < 16 && !isTitle;

      const minSize = isTitle
        ? MIN_FONT_SIZES.title
        : isCaption
          ? MIN_FONT_SIZES.caption
          : MIN_FONT_SIZES.body;
      const role = isTitle ? 'title' : isCaption ? 'caption' : 'body';

      if (fontSize < minSize) {
        results.push({
          passed: false,
          severity: fontSize < minSize * 0.7 ? 'high' : 'medium',
          message: `Element "${element.id}" has font size ${fontSize}pt, below the ${minSize}pt minimum for ${role} text.`,
          type: 'font',
          element: element.id,
          fix: `Increase font size to at least ${minSize}pt.`,
        });
      }
    }

    if (results.length === 0) {
      results.push({
        passed: true,
        severity: 'low',
        message: 'All text elements meet minimum font size requirements.',
        type: 'font',
      });
    }

    return results;
  },
};

/**
 * Rule: Font hierarchy — check that title text is visually larger than body text.
 */
const fontHierarchyRule: DesignRule = {
  id: 'font-hierarchy',
  name: 'Font Hierarchy',
  type: 'hierarchy',
  description: 'Checks that there is a clear visual hierarchy between title and body text.',
  evaluate(slide) {
    const textElements = slide.elements.filter(
      (e) => (e.type === 'text' || e.type === 'shape') && e.styles?.fontSize,
    );

    if (textElements.length < 2) {
      return [{
        passed: true,
        severity: 'low',
        message: 'Too few text elements to evaluate hierarchy.',
        type: 'hierarchy',
      }];
    }

    const fontSizes = textElements
      .map((e) => e.styles!.fontSize!)
      .sort((a, b) => b - a);

    const largest = fontSizes[0]!;
    const secondLargest = fontSizes.length > 1 ? fontSizes[1]! : largest;

    // The title should be at least 1.4x the body text size for clear hierarchy
    const ratio = largest / secondLargest;

    if (ratio < 1.2 && fontSizes.length > 2) {
      return [{
        passed: false,
        severity: 'medium',
        message: `Weak visual hierarchy: largest font (${largest}pt) is only ${ratio.toFixed(1)}x the next size (${secondLargest}pt). Aim for at least 1.4x ratio.`,
        type: 'hierarchy',
        fix: `Increase title font size to at least ${Math.ceil(secondLargest * 1.4)}pt, or reduce body text size.`,
      }];
    }

    return [{
      passed: true,
      severity: 'low',
      message: `Good hierarchy: ${ratio.toFixed(1)}x ratio between heading (${largest}pt) and body (${secondLargest}pt).`,
      type: 'hierarchy',
    }];
  },
};

/**
 * Rule: Contrast ratio — check WCAG AA compliance for text elements.
 */
const contrastRule: DesignRule = {
  id: 'contrast',
  name: 'Color Contrast',
  type: 'contrast',
  description: 'Checks WCAG AA contrast ratios between text and background colors.',
  evaluate(slide) {
    const results: RuleEvaluationResult[] = [];

    for (const element of slide.elements) {
      if (!element.styles?.foregroundColor || !element.styles.backgroundColor) continue;

      const fg = element.styles.foregroundColor;
      const bg = element.styles.backgroundColor;
      const ratio = contrastRatio(fg, bg);
      const fontSize = element.styles.fontSize ?? 18;
      const isBold = element.styles.bold ?? false;
      const isLargeText = fontSize >= 18 || (fontSize >= 14 && isBold);
      const requiredRatio = isLargeText ? WCAG_CONTRAST.largeText : WCAG_CONTRAST.normalText;

      if (ratio < requiredRatio) {
        results.push({
          passed: false,
          severity: ratio < requiredRatio * 0.6 ? 'high' : 'medium',
          message: `Element "${element.id}" has contrast ratio ${ratio.toFixed(2)}:1 (${fg} on ${bg}), below WCAG AA requirement of ${requiredRatio}:1 for ${isLargeText ? 'large' : 'normal'} text.`,
          type: 'contrast',
          element: element.id,
          fix: `Adjust text color or background to achieve at least ${requiredRatio}:1 contrast ratio.`,
        });
      }
    }

    if (results.length === 0) {
      results.push({
        passed: true,
        severity: 'low',
        message: 'All text elements with known colors meet WCAG AA contrast requirements.',
        type: 'contrast',
      });
    }

    return results;
  },
};

/**
 * Rule: Alignment — check that elements are aligned to each other or a grid.
 */
const alignmentRule: DesignRule = {
  id: 'alignment',
  name: 'Element Alignment',
  type: 'alignment',
  description: 'Checks whether elements are consistently aligned to each other.',
  evaluate(slide, _pageWidth = DEFAULT_PAGE_WIDTH) {
    const results: RuleEvaluationResult[] = [];
    const elements = slide.elements.filter((e) => e.position);

    if (elements.length < 2) {
      return [{
        passed: true,
        severity: 'low',
        message: 'Too few elements to evaluate alignment.',
        type: 'alignment',
      }];
    }

    // Collect all left edges, right edges, top edges, bottom edges, and centers
    const leftEdges = elements.map((e) => ({ id: e.id, value: e.position.x }));
    const topEdges = elements.map((e) => ({ id: e.id, value: e.position.y }));
    const centerXs = elements.map((e) => ({ id: e.id, value: e.position.x + e.position.width / 2 }));
    const centerYs = elements.map((e) => ({ id: e.id, value: e.position.y + e.position.height / 2 }));

    // For each pair of elements, check if they share an alignment edge
    const misaligned: Array<{ el1: string; el2: string; axis: string; offset: number }> = [];

    for (let i = 0; i < elements.length; i++) {
      for (let j = i + 1; j < elements.length; j++) {
        // Use pre-collected edge/center arrays
        const leftDiff = Math.abs(leftEdges[i]!.value - leftEdges[j]!.value);
        const topDiff = Math.abs(topEdges[i]!.value - topEdges[j]!.value);
        const centerXDiff = Math.abs(centerXs[i]!.value - centerXs[j]!.value);
        const centerYDiff = Math.abs(centerYs[i]!.value - centerYs[j]!.value);

        // Near-miss: within 2x tolerance but NOT within tolerance
        // This catches elements that look like they should be aligned but aren't
        if (leftDiff > ALIGNMENT_TOLERANCE_PT && leftDiff < ALIGNMENT_TOLERANCE_PT * 4) {
          misaligned.push({ el1: leftEdges[i]!.id, el2: leftEdges[j]!.id, axis: 'left edge', offset: leftDiff });
        }
        if (topDiff > ALIGNMENT_TOLERANCE_PT && topDiff < ALIGNMENT_TOLERANCE_PT * 4) {
          misaligned.push({ el1: topEdges[i]!.id, el2: topEdges[j]!.id, axis: 'top edge', offset: topDiff });
        }
        if (centerXDiff > ALIGNMENT_TOLERANCE_PT && centerXDiff < ALIGNMENT_TOLERANCE_PT * 4) {
          misaligned.push({ el1: centerXs[i]!.id, el2: centerXs[j]!.id, axis: 'horizontal center', offset: centerXDiff });
        }
        if (centerYDiff > ALIGNMENT_TOLERANCE_PT && centerYDiff < ALIGNMENT_TOLERANCE_PT * 4) {
          misaligned.push({ el1: centerYs[i]!.id, el2: centerYs[j]!.id, axis: 'vertical center', offset: centerYDiff });
        }
      }
    }

    // Report the most egregious misalignments (limit to 5)
    const reported = misaligned
      .sort((a, b) => a.offset - b.offset)
      .slice(0, 5);

    for (const item of reported) {
      results.push({
        passed: false,
        severity: item.offset > ALIGNMENT_TOLERANCE_PT * 3 ? 'medium' : 'low',
        message: `Elements "${item.el1}" and "${item.el2}" are nearly aligned on ${item.axis} but off by ${item.offset.toFixed(1)}pt.`,
        type: 'alignment',
        element: item.el1,
        fix: `Snap elements to a common ${item.axis} position (within ${ALIGNMENT_TOLERANCE_PT}pt tolerance).`,
      });
    }

    if (results.length === 0) {
      results.push({
        passed: true,
        severity: 'low',
        message: 'Elements are well-aligned.',
        type: 'alignment',
      });
    }

    return results;
  },
};

/**
 * Rule: Spacing — check for consistent margins and spacing between elements.
 */
const spacingRule: DesignRule = {
  id: 'spacing',
  name: 'Element Spacing',
  type: 'spacing',
  description: 'Checks for consistent margins and spacing between elements.',
  evaluate(slide, pageWidth = DEFAULT_PAGE_WIDTH, pageHeight = DEFAULT_PAGE_HEIGHT) {
    const results: RuleEvaluationResult[] = [];
    const elements = slide.elements.filter((e) => e.position);

    if (elements.length === 0) {
      return [{
        passed: true,
        severity: 'low',
        message: 'No elements to evaluate spacing.',
        type: 'spacing',
      }];
    }

    const minMarginX = pageWidth * MIN_MARGIN_FRACTION;
    const minMarginY = pageHeight * MIN_MARGIN_FRACTION;

    // Check elements against slide margins
    for (const element of elements) {
      const { x, y, width, height } = element.position;
      const rightEdge = x + width;
      const bottomEdge = y + height;

      if (x < minMarginX) {
        results.push({
          passed: false,
          severity: x < minMarginX * 0.5 ? 'high' : 'medium',
          message: `Element "${element.id}" is ${x.toFixed(1)}pt from the left edge, below the recommended ${minMarginX.toFixed(0)}pt minimum margin.`,
          type: 'spacing',
          element: element.id,
          fix: `Move element right to at least x=${minMarginX.toFixed(0)}pt.`,
        });
      }

      if (y < minMarginY) {
        results.push({
          passed: false,
          severity: y < minMarginY * 0.5 ? 'high' : 'medium',
          message: `Element "${element.id}" is ${y.toFixed(1)}pt from the top edge, below the recommended ${minMarginY.toFixed(0)}pt minimum margin.`,
          type: 'spacing',
          element: element.id,
          fix: `Move element down to at least y=${minMarginY.toFixed(0)}pt.`,
        });
      }

      if (rightEdge > pageWidth - minMarginX) {
        results.push({
          passed: false,
          severity: 'medium',
          message: `Element "${element.id}" right edge (${rightEdge.toFixed(1)}pt) extends past the recommended right margin (${(pageWidth - minMarginX).toFixed(0)}pt).`,
          type: 'spacing',
          element: element.id,
          fix: `Resize or reposition element to stay within right margin.`,
        });
      }

      if (bottomEdge > pageHeight - minMarginY) {
        results.push({
          passed: false,
          severity: 'medium',
          message: `Element "${element.id}" bottom edge (${bottomEdge.toFixed(1)}pt) extends past the recommended bottom margin (${(pageHeight - minMarginY).toFixed(0)}pt).`,
          type: 'spacing',
          element: element.id,
          fix: `Resize or reposition element to stay within bottom margin.`,
        });
      }
    }

    // Check inter-element spacing consistency
    if (elements.length >= 3) {
      // Sort elements by vertical position
      const sorted = [...elements].sort((a, b) => a.position.y - b.position.y);
      const gaps: number[] = [];

      for (let i = 0; i < sorted.length - 1; i++) {
        const current = sorted[i]!;
        const next = sorted[i + 1]!;
        const gap = next.position.y - (current.position.y + current.position.height);
        if (gap > 0) {
          gaps.push(gap);
        }
      }

      if (gaps.length >= 2) {
        const avgGap = gaps.reduce((a, b) => a + b, 0) / gaps.length;
        const maxDeviation = Math.max(...gaps.map((g) => Math.abs(g - avgGap)));

        if (maxDeviation > avgGap * 0.5 && maxDeviation > 10) {
          results.push({
            passed: false,
            severity: 'medium',
            message: `Inconsistent vertical spacing between elements: gaps range from ${Math.min(...gaps).toFixed(0)}pt to ${Math.max(...gaps).toFixed(0)}pt (avg ${avgGap.toFixed(0)}pt).`,
            type: 'spacing',
            fix: `Normalize vertical spacing to approximately ${avgGap.toFixed(0)}pt between all elements.`,
          });
        }
      }
    }

    if (results.length === 0) {
      results.push({
        passed: true,
        severity: 'low',
        message: 'Element spacing and margins are within recommended bounds.',
        type: 'spacing',
      });
    }

    return results;
  },
};

/**
 * Rule: Color palette — check that the slide doesn't use too many distinct colors.
 */
const colorPaletteRule: DesignRule = {
  id: 'color-palette',
  name: 'Color Palette',
  type: 'color',
  description: 'Checks that the slide uses a cohesive color palette (max 4 distinct colors).',
  evaluate(slide) {
    const colors = new Set<string>();

    for (const element of slide.elements) {
      if (element.styles?.foregroundColor) {
        colors.add(element.styles.foregroundColor.toLowerCase());
      }
      if (element.styles?.backgroundColor) {
        colors.add(element.styles.backgroundColor.toLowerCase());
      }
      if (element.styles?.borderColor) {
        colors.add(element.styles.borderColor.toLowerCase());
      }
    }

    // Filter out pure black/white/transparent as they don't count toward the palette limit
    const significantColors = new Set<string>();
    for (const color of colors) {
      const cleaned = color.replace('#', '').toLowerCase();
      if (cleaned !== '000000' && cleaned !== 'ffffff' && cleaned !== '000' && cleaned !== 'fff') {
        significantColors.add(color);
      }
    }

    if (significantColors.size > MAX_COLORS_PER_SLIDE) {
      return [{
        passed: false,
        severity: significantColors.size > MAX_COLORS_PER_SLIDE + 2 ? 'high' : 'medium',
        message: `Slide uses ${significantColors.size} distinct colors (${[...significantColors].join(', ')}), exceeding the recommended maximum of ${MAX_COLORS_PER_SLIDE}.`,
        type: 'color',
        fix: `Reduce the color palette to ${MAX_COLORS_PER_SLIDE} or fewer distinct colors for a cohesive look.`,
      }];
    }

    return [{
      passed: true,
      severity: 'low',
      message: `Color palette is cohesive with ${significantColors.size} distinct colors.`,
      type: 'color',
    }];
  },
};

/**
 * Rule: Visual balance — check for left-heavy or top-heavy layouts.
 */
const balanceRule: DesignRule = {
  id: 'balance',
  name: 'Visual Balance',
  type: 'balance',
  description: 'Checks whether the layout has balanced visual weight distribution.',
  evaluate(slide, pageWidth = DEFAULT_PAGE_WIDTH, pageHeight = DEFAULT_PAGE_HEIGHT) {
    const elements = slide.elements.filter((e) => e.position);
    if (elements.length < 2) {
      return [{
        passed: true,
        severity: 'low',
        message: 'Too few elements to evaluate balance.',
        type: 'balance',
      }];
    }

    const centerX = pageWidth / 2;
    const centerY = pageHeight / 2;

    // Calculate visual weight for each element (area-based)
    let leftWeight = 0;
    let rightWeight = 0;
    let topWeight = 0;
    let bottomWeight = 0;
    let totalWeight = 0;

    for (const element of elements) {
      const area = element.position.width * element.position.height;
      const elementCenterX = element.position.x + element.position.width / 2;
      const elementCenterY = element.position.y + element.position.height / 2;

      totalWeight += area;

      if (elementCenterX < centerX) {
        leftWeight += area;
      } else {
        rightWeight += area;
      }

      if (elementCenterY < centerY) {
        topWeight += area;
      } else {
        bottomWeight += area;
      }
    }

    const results: RuleEvaluationResult[] = [];

    if (totalWeight > 0) {
      const horizontalImbalance = Math.abs(leftWeight - rightWeight) / totalWeight;
      const verticalImbalance = Math.abs(topWeight - bottomWeight) / totalWeight;

      if (horizontalImbalance > 0.6) {
        const heavySide = leftWeight > rightWeight ? 'left' : 'right';
        results.push({
          passed: false,
          severity: horizontalImbalance > 0.8 ? 'high' : 'medium',
          message: `Layout is ${heavySide}-heavy (${(horizontalImbalance * 100).toFixed(0)}% horizontal imbalance). Aim for more balanced distribution.`,
          type: 'balance',
          fix: `Redistribute elements more evenly across the horizontal axis, or add a visual element to the ${heavySide === 'left' ? 'right' : 'left'} side.`,
        });
      }

      if (verticalImbalance > 0.7) {
        const heavySide = topWeight > bottomWeight ? 'top' : 'bottom';
        results.push({
          passed: false,
          severity: verticalImbalance > 0.85 ? 'high' : 'medium',
          message: `Layout is ${heavySide}-heavy (${(verticalImbalance * 100).toFixed(0)}% vertical imbalance).`,
          type: 'balance',
          fix: `Redistribute elements vertically for better visual balance.`,
        });
      }
    }

    if (results.length === 0) {
      results.push({
        passed: true,
        severity: 'low',
        message: 'Layout has balanced visual weight distribution.',
        type: 'balance',
      });
    }

    return results;
  },
};

// ─────────────────────────────────────────────────────────────────────────────
// Rule Registry
// ─────────────────────────────────────────────────────────────────────────────

/** All registered design rules. */
export const DESIGN_RULES: readonly DesignRule[] = [
  textDensityRule,
  fontSizeRule,
  fontHierarchyRule,
  contrastRule,
  alignmentRule,
  spacingRule,
  colorPaletteRule,
  balanceRule,
] as const;

/** Map of rule ID to rule definition for O(1) lookups. */
export const DESIGN_RULE_MAP = new Map<string, DesignRule>(
  DESIGN_RULES.map((rule) => [rule.id, rule]),
);

// ─────────────────────────────────────────────────────────────────────────────
// Public API
// ─────────────────────────────────────────────────────────────────────────────

/**
 * Evaluate a single design rule against slide data.
 *
 * @param rule - The design rule to evaluate.
 * @param slide - The slide content to evaluate.
 * @param pageWidth - Page width in points (defaults to 720).
 * @param pageHeight - Page height in points (defaults to 405).
 * @returns Array of evaluation results.
 */
export function evaluateRule(
  rule: DesignRule,
  slide: SlideContent,
  pageWidth: number = DEFAULT_PAGE_WIDTH,
  pageHeight: number = DEFAULT_PAGE_HEIGHT,
): RuleEvaluationResult[] {
  return rule.evaluate(slide, pageWidth, pageHeight);
}

/**
 * Evaluate all registered design rules against slide data.
 *
 * @param slide - The slide content to evaluate.
 * @param pageWidth - Page width in points (defaults to 720).
 * @param pageHeight - Page height in points (defaults to 405).
 * @param filterTypes - Optional filter to only run specific issue types.
 * @returns Array of all design issues found (failed rules only).
 */
export function evaluateAllRules(
  slide: SlideContent,
  pageWidth: number = DEFAULT_PAGE_WIDTH,
  pageHeight: number = DEFAULT_PAGE_HEIGHT,
  filterTypes?: DesignIssueType[],
): DesignIssue[] {
  const issues: DesignIssue[] = [];

  for (const rule of DESIGN_RULES) {
    if (filterTypes && !filterTypes.includes(rule.type)) continue;

    const results = rule.evaluate(slide, pageWidth, pageHeight);

    for (const result of results) {
      if (!result.passed) {
        issues.push({
          type: result.type,
          severity: result.severity,
          element: result.element,
          description: result.message,
          fix: result.fix,
        });
      }
    }
  }

  return issues;
}

/**
 * Get a recommended fix action for a specific design issue.
 *
 * @param issue - The design issue to generate a fix for.
 * @returns A human-readable fix description.
 */
export function getRecommendedFix(issue: DesignIssue): string {
  if (issue.fix) return issue.fix;

  // Fallback generic recommendations by type
  const genericFixes: Record<DesignIssueType, string> = {
    alignment: 'Use the align/distribute tools to snap elements to a consistent grid.',
    spacing: 'Adjust element positions to maintain consistent margins (minimum 10% of slide dimensions on each edge).',
    color: 'Simplify the color palette to 3-4 colors that complement each other.',
    font: 'Ensure title text is at least 28pt, body text at least 18pt, and captions at least 14pt.',
    hierarchy: 'Create a clear size hierarchy: title should be at least 1.4x the body text size.',
    contrast: 'Adjust text/background colors to achieve at least 4.5:1 contrast ratio for normal text (3:1 for large text).',
    balance: 'Redistribute visual elements more evenly across the slide area.',
  };

  return genericFixes[issue.type];
}

/**
 * Calculate an overall design score from a list of issues.
 *
 * Starts at 100 and deducts points based on issue count and severity.
 *
 * @param issues - Array of design issues.
 * @returns A score from 0 to 100.
 */
export function calculateDesignScore(issues: DesignIssue[]): number {
  let score = 100;

  const severityPenalties: Record<DesignIssueSeverity, number> = {
    low: 3,
    medium: 8,
    high: 15,
  };

  for (const issue of issues) {
    score -= severityPenalties[issue.severity];
  }

  return Math.max(0, Math.min(100, score));
}
