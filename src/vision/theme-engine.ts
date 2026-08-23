/**
 * @module vision/theme-engine
 * @description Professional theme application engine for Google Slides.
 *
 * Provides 5 pre-built professional themes and utilities to apply them
 * via Google Slides API batch update requests. Currently, theme application
 * sets slide background colors only.  Title and body text styling requires
 * element-level targeting via {@link applyFontScheme} (which needs
 * discovered element IDs from a `presentations.get` call).
 */

import type { BatchUpdateRequest } from '../shared/types.js';
import {
  DEFAULT_TITLE_FONT_SIZE,
  DEFAULT_SUBTITLE_FONT_SIZE,
  DEFAULT_BODY_FONT_SIZE,
  DEFAULT_LINE_SPACING,
  COLOR_THEMES,
} from '../shared/constants.js';
import { createLogger } from '../shared/logger.js';
import { hexToGoogleRgb } from '../shared/validators.js';

const log = createLogger('vision.theme-engine');

// ─────────────────────────────────────────────────────────────────────────────
// Theme Definition
// ─────────────────────────────────────────────────────────────────────────────

/** Complete theme definition with all visual properties. */
export interface ThemeDefinition {
  /** Unique theme identifier. */
  id: string;
  /** Human-readable theme name. */
  name: string;
  /** Short description of the theme. */
  description: string;
  /** Color palette. */
  colors: {
    /** Primary brand color (hex). */
    primary: string;
    /** Secondary accent color (hex). */
    secondary: string;
    /** Highlight/accent color (hex). */
    accent: string;
    /** Slide background color (hex). */
    background: string;
    /** Surface/card background color (hex). */
    surface: string;
    /** Primary text color (hex). */
    textPrimary: string;
    /** Secondary/muted text color (hex). */
    textSecondary: string;
    /** Border/separator color (hex). */
    border: string;
  };
  /** Typography settings. */
  fonts: {
    /** Font family for titles/headings. */
    titleFamily: string;
    /** Font family for body text. */
    bodyFamily: string;
    /** Title font size in points. */
    titleSize: number;
    /** Subtitle font size in points. */
    subtitleSize: number;
    /** Body text font size in points. */
    bodySize: number;
    /** Line spacing multiplier. */
    lineSpacing: number;
  };
}

// ─────────────────────────────────────────────────────────────────────────────
// Pre-built Themes
// ─────────────────────────────────────────────────────────────────────────────

/** Corporate Blue — clean, professional, trustworthy. */
const corporateBlueTheme: ThemeDefinition = {
  id: 'corporate-blue',
  name: 'Corporate Blue',
  description: 'Clean corporate theme with a professional blue palette. Ideal for business presentations, quarterly reviews, and client pitches.',
  colors: {
    primary: COLOR_THEMES.corporate.primary,
    secondary: COLOR_THEMES.corporate.secondary,
    accent: COLOR_THEMES.corporate.accent,
    background: COLOR_THEMES.corporate.background,
    surface: COLOR_THEMES.corporate.surface,
    textPrimary: COLOR_THEMES.corporate.textPrimary,
    textSecondary: COLOR_THEMES.corporate.textSecondary,
    border: COLOR_THEMES.corporate.border,
  },
  fonts: {
    titleFamily: 'Roboto',
    bodyFamily: 'Roboto',
    titleSize: DEFAULT_TITLE_FONT_SIZE,
    subtitleSize: DEFAULT_SUBTITLE_FONT_SIZE,
    bodySize: DEFAULT_BODY_FONT_SIZE,
    lineSpacing: DEFAULT_LINE_SPACING,
  },
};

/** Dark Professional — modern dark theme for tech and creative presentations. */
const darkProfessionalTheme: ThemeDefinition = {
  id: 'dark-professional',
  name: 'Dark Professional',
  description: 'Modern dark theme with high contrast and sleek aesthetics. Perfect for tech demos, product launches, and creative showcases.',
  colors: {
    primary: COLOR_THEMES.dark.primary,
    secondary: COLOR_THEMES.dark.secondary,
    accent: COLOR_THEMES.dark.accent,
    background: COLOR_THEMES.dark.background,
    surface: COLOR_THEMES.dark.surface,
    textPrimary: COLOR_THEMES.dark.textPrimary,
    textSecondary: COLOR_THEMES.dark.textSecondary,
    border: COLOR_THEMES.dark.border,
  },
  fonts: {
    titleFamily: 'Montserrat',
    bodyFamily: 'Open Sans',
    titleSize: DEFAULT_TITLE_FONT_SIZE,
    subtitleSize: DEFAULT_SUBTITLE_FONT_SIZE,
    bodySize: DEFAULT_BODY_FONT_SIZE,
    lineSpacing: 1.2,
  },
};

/** Warm Minimal — warm tones with clean whitespace. */
const warmMinimalTheme: ThemeDefinition = {
  id: 'warm-minimal',
  name: 'Warm Minimal',
  description: 'Warm, inviting theme with generous whitespace and soft colors. Great for educational content, workshops, and storytelling.',
  colors: {
    primary: COLOR_THEMES.warm.primary,
    secondary: COLOR_THEMES.warm.secondary,
    accent: COLOR_THEMES.warm.accent,
    background: COLOR_THEMES.warm.background,
    surface: COLOR_THEMES.warm.surface,
    textPrimary: COLOR_THEMES.warm.textPrimary,
    textSecondary: COLOR_THEMES.warm.textSecondary,
    border: COLOR_THEMES.warm.border,
  },
  fonts: {
    titleFamily: 'Playfair Display',
    bodyFamily: 'Lato',
    titleSize: 38,
    subtitleSize: 22,
    bodySize: DEFAULT_BODY_FONT_SIZE,
    lineSpacing: 1.3,
  },
};

/** Nature Fresh — nature-inspired green palette. */
const natureFreshTheme: ThemeDefinition = {
  id: 'nature-fresh',
  name: 'Nature Fresh',
  description: 'Nature-inspired green palette conveying growth and sustainability. Ideal for environmental topics, health, and wellness presentations.',
  colors: {
    primary: COLOR_THEMES.nature.primary,
    secondary: COLOR_THEMES.nature.secondary,
    accent: COLOR_THEMES.nature.accent,
    background: COLOR_THEMES.nature.background,
    surface: COLOR_THEMES.nature.surface,
    textPrimary: COLOR_THEMES.nature.textPrimary,
    textSecondary: COLOR_THEMES.nature.textSecondary,
    border: COLOR_THEMES.nature.border,
  },
  fonts: {
    titleFamily: 'Raleway',
    bodyFamily: 'Open Sans',
    titleSize: DEFAULT_TITLE_FONT_SIZE,
    subtitleSize: DEFAULT_SUBTITLE_FONT_SIZE,
    bodySize: DEFAULT_BODY_FONT_SIZE,
    lineSpacing: DEFAULT_LINE_SPACING,
  },
};

/** Slate Modern — neutral, professional slate tones. */
const slateModernTheme: ThemeDefinition = {
  id: 'slate-modern',
  name: 'Slate Modern',
  description: 'Neutral slate palette with a modern feel. Versatile theme suitable for any professional context — from engineering to finance.',
  colors: {
    primary: COLOR_THEMES.slate.primary,
    secondary: COLOR_THEMES.slate.secondary,
    accent: COLOR_THEMES.slate.accent,
    background: COLOR_THEMES.slate.background,
    surface: COLOR_THEMES.slate.surface,
    textPrimary: COLOR_THEMES.slate.textPrimary,
    textSecondary: COLOR_THEMES.slate.textSecondary,
    border: COLOR_THEMES.slate.border,
  },
  fonts: {
    titleFamily: 'Oswald',
    bodyFamily: 'Roboto',
    titleSize: 34,
    subtitleSize: 22,
    bodySize: DEFAULT_BODY_FONT_SIZE,
    lineSpacing: DEFAULT_LINE_SPACING,
  },
};

// ─────────────────────────────────────────────────────────────────────────────
// Theme Registry
// ─────────────────────────────────────────────────────────────────────────────

/** All available themes indexed by ID. */
const THEME_REGISTRY = new Map<string, ThemeDefinition>([
  [corporateBlueTheme.id, corporateBlueTheme],
  [darkProfessionalTheme.id, darkProfessionalTheme],
  [warmMinimalTheme.id, warmMinimalTheme],
  [natureFreshTheme.id, natureFreshTheme],
  [slateModernTheme.id, slateModernTheme],
]);

/**
 * Name aliases for convenient lookup (supports various formats).
 */
const THEME_ALIASES = new Map<string, string>([
  // ID forms
  ['corporate-blue', 'corporate-blue'],
  ['dark-professional', 'dark-professional'],
  ['warm-minimal', 'warm-minimal'],
  ['nature-fresh', 'nature-fresh'],
  ['slate-modern', 'slate-modern'],
  // Space-separated forms
  ['corporate blue', 'corporate-blue'],
  ['dark professional', 'dark-professional'],
  ['warm minimal', 'warm-minimal'],
  ['nature fresh', 'nature-fresh'],
  ['slate modern', 'slate-modern'],
  // Short forms
  ['corporate', 'corporate-blue'],
  ['dark', 'dark-professional'],
  ['warm', 'warm-minimal'],
  ['nature', 'nature-fresh'],
  ['slate', 'slate-modern'],
]);

// ─────────────────────────────────────────────────────────────────────────────
// Public API
// ─────────────────────────────────────────────────────────────────────────────

/**
 * Get a theme by name or ID.
 *
 * Supports exact IDs ("corporate-blue"), space-separated names
 * ("Corporate Blue"), and short names ("corporate").
 *
 * @param name - The theme name or ID.
 * @returns The theme definition, or undefined if not found.
 */
export function getTheme(name: string): ThemeDefinition | undefined {
  const normalized = name.toLowerCase().trim();

  // Direct ID lookup
  const direct = THEME_REGISTRY.get(normalized);
  if (direct) return direct;

  // Alias lookup
  const aliasId = THEME_ALIASES.get(normalized);
  if (aliasId) return THEME_REGISTRY.get(aliasId);

  return undefined;
}

/**
 * List all available themes.
 *
 * @returns Array of all theme definitions.
 */
export function listThemes(): ThemeDefinition[] {
  return [...THEME_REGISTRY.values()];
}

/**
 * Get all available theme names for display.
 *
 * @returns Array of theme name strings.
 */
export function listThemeNames(): string[] {
  return [...THEME_REGISTRY.values()].map((t) => t.name);
}

// ─────────────────────────────────────────────────────────────────────────────
// Batch Update Generation
// ─────────────────────────────────────────────────────────────────────────────

/**
 * Generate Google Slides API batch update requests to apply a theme to slides.
 *
 * Currently generates requests to set page background color only using
 * `updatePageProperties` with a `solidFill`.  Title and body text styles
 * are **not** applied here because the Google Slides API requires
 * element-level targeting (specific placeholder object IDs) which must
 * first be discovered via `presentations.get`.  Use {@link applyFontScheme}
 * with discovered element IDs to apply text styles.
 *
 * @param _presentationId - Unused. Retained for API compatibility but the
 *   presentation ID is not needed for generating batch-update request objects.
 * @param theme - The theme to apply.
 * @param slideIds - Array of slide page object IDs to apply the theme to.
 * @returns Array of Google Slides API batch update requests.
 */
export function applyTheme(
  _presentationId: string,
  theme: ThemeDefinition,
  slideIds: string[],
): BatchUpdateRequest[] {
  log.info('Generating theme application requests', {
    themeId: theme.id,
    slideCount: slideIds.length,
  });

  const requests: BatchUpdateRequest[] = [];

  const bgRgb = hexToGoogleRgb(theme.colors.background);

  for (const slideId of slideIds) {
    // 1. Set page background
    requests.push({
      updatePageProperties: {
        objectId: slideId,
        pageProperties: {
          pageBackgroundFill: {
            solidFill: {
              color: {
                rgbColor: {
                  red: bgRgb.red,
                  green: bgRgb.green,
                  blue: bgRgb.blue,
                },
              },
            },
          },
        },
        fields: 'pageBackgroundFill.solidFill.color',
      },
    });
  }

  log.debug('Generated theme requests', {
    themeId: theme.id,
    requestCount: requests.length,
  });

  return requests;
}

/**
 * Generate batch update requests to apply a custom color scheme to slides.
 *
 * Only sets page background colors.  The `primaryColor`, `secondaryColor`,
 * and `accentColor` fields are accepted for future use but currently only
 * `backgroundColor` is applied.
 *
 * @param _presentationId - Unused. Retained for API compatibility.
 * @param colors - Custom color scheme with primary, secondary, accent, and background colors.
 * @param slideIds - Slide page object IDs.
 * @returns Array of batch update requests.
 */
export function applyColorScheme(
  _presentationId: string,
  colors: {
    primaryColor: string;
    secondaryColor: string;
    accentColor: string;
    backgroundColor: string;
  },
  slideIds: string[],
): BatchUpdateRequest[] {
  log.info('Generating custom color scheme requests', {
    slideCount: slideIds.length,
  });

  const requests: BatchUpdateRequest[] = [];
  const bgRgb = hexToGoogleRgb(colors.backgroundColor);

  for (const slideId of slideIds) {
    // Set page background
    requests.push({
      updatePageProperties: {
        objectId: slideId,
        pageProperties: {
          pageBackgroundFill: {
            solidFill: {
              color: {
                rgbColor: {
                  red: bgRgb.red,
                  green: bgRgb.green,
                  blue: bgRgb.blue,
                },
              },
            },
          },
        },
        fields: 'pageBackgroundFill.solidFill.color',
      },
    });
  }

  log.debug('Generated color scheme requests', {
    requestCount: requests.length,
  });

  return requests;
}

/**
 * Generate batch update requests to apply a custom font scheme to slides.
 *
 * Creates updateTextStyle requests for title and body placeholders on each
 * slide. Note: this targets placeholder elements by type. If the slide
 * doesn't use standard placeholders, these requests may not have effect.
 *
 * @param presentationId - The presentation ID.
 * @param titleFont - Font family for titles.
 * @param bodyFont - Font family for body text.
 * @param slideIds - Slide page object IDs.
 * @param elementIds - Optional array of element descriptors with their IDs and
 *   roles ('title' or 'body'). When provided, generates updateTextStyle
 *   requests for each element. When omitted, returns an empty array (caller
 *   must first discover element IDs via presentations.get).
 * @returns Array of batch update requests.
 */
export function applyFontScheme(
  _presentationId: string,
  titleFont: string,
  bodyFont: string,
  _slideIds: string[],
  elementIds?: Array<{ elementId: string; type: 'title' | 'body' }>,
): BatchUpdateRequest[] {
  log.info('Generating font scheme requests', {
    titleFont,
    bodyFont,
    elementIdCount: elementIds?.length ?? 0,
  });

  const requests: BatchUpdateRequest[] = [];

  if (elementIds && elementIds.length > 0) {
    // Generate updateTextStyle requests for each known element
    for (const { elementId, type } of elementIds) {
      const fontFamily = type === 'title' ? titleFont : bodyFont;
      const fontSize = type === 'title' ? DEFAULT_TITLE_FONT_SIZE : DEFAULT_BODY_FONT_SIZE;

      requests.push({
        updateTextStyle: {
          objectId: elementId,
          textRange: { type: 'ALL' },
          style: {
            fontFamily,
            fontSize: { magnitude: fontSize, unit: 'PT' },
          },
          fields: 'fontFamily,fontSize',
        },
      });
    }

    log.info('Generated font scheme requests for elements', {
      requestCount: requests.length,
      titleFont,
      bodyFont,
    });
  } else {
    // Without element IDs we cannot generate valid requests.
    // The caller should first fetch the presentation via presentations.get
    // to discover placeholder element IDs on each slide.
    log.debug('No element IDs provided — font scheme requests require element-level targeting', {
      titleFont,
      bodyFont,
    });
  }

  return requests;
}

/**
 * Generate a human-readable markdown preview of a theme.
 *
 * @param theme - The theme to preview.
 * @returns A markdown string describing the theme.
 */
export function generateThemePreview(theme: ThemeDefinition): string {
  const lines: string[] = [
    `## ${theme.name}`,
    '',
    theme.description,
    '',
    '### Colors',
    `| Role | Color | Hex |`,
    `|------|-------|-----|`,
    `| Primary | ${colorSwatch(theme.colors.primary)} | \`${theme.colors.primary}\` |`,
    `| Secondary | ${colorSwatch(theme.colors.secondary)} | \`${theme.colors.secondary}\` |`,
    `| Accent | ${colorSwatch(theme.colors.accent)} | \`${theme.colors.accent}\` |`,
    `| Background | ${colorSwatch(theme.colors.background)} | \`${theme.colors.background}\` |`,
    `| Surface | ${colorSwatch(theme.colors.surface)} | \`${theme.colors.surface}\` |`,
    `| Text Primary | ${colorSwatch(theme.colors.textPrimary)} | \`${theme.colors.textPrimary}\` |`,
    `| Text Secondary | ${colorSwatch(theme.colors.textSecondary)} | \`${theme.colors.textSecondary}\` |`,
    `| Border | ${colorSwatch(theme.colors.border)} | \`${theme.colors.border}\` |`,
    '',
    '### Typography',
    `- **Title font:** ${theme.fonts.titleFamily} (${theme.fonts.titleSize}pt)`,
    `- **Subtitle font:** ${theme.fonts.titleFamily} (${theme.fonts.subtitleSize}pt)`,
    `- **Body font:** ${theme.fonts.bodyFamily} (${theme.fonts.bodySize}pt)`,
    `- **Line spacing:** ${theme.fonts.lineSpacing}x`,
  ];

  return lines.join('\n');
}

/**
 * Generate a simple text swatch indicator for a color.
 */
function colorSwatch(hex: string): string {
  return `[${hex}]`;
}
