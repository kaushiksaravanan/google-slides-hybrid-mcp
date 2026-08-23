/**
 * @module shared/validators
 * @description Zod schemas for validating all tool inputs across the
 * Google Slides Hybrid MCP server.  Every schema is exported individually
 * and also re-exported via convenience objects for grouped access.
 */

import { z } from 'zod';

// ─────────────────────────────────────────────────────────────────────────────
// Primitives & Scalars
// ─────────────────────────────────────────────────────────────────────────────

/**
 * A Google Slides presentation ID.
 * Typically a 44-character alphanumeric string extracted from the URL.
 */
export const presentationIdSchema = z
  .string()
  .min(1, 'Presentation ID must not be empty')
  .max(128, 'Presentation ID is too long')
  .regex(
    /^[a-zA-Z0-9_-]+$/,
    'Presentation ID must contain only alphanumeric characters, hyphens, and underscores',
  )
  .describe('Google Slides presentation ID');

/**
 * A Google Slides page (slide) object ID.
 * Same character constraints as presentation IDs but scoped to a page.
 */
export const slideIdSchema = z
  .string()
  .min(1, 'Slide ID must not be empty')
  .max(128, 'Slide ID is too long')
  .regex(
    /^[a-zA-Z0-9_-]+$/,
    'Slide ID must contain only alphanumeric characters, hyphens, and underscores',
  )
  .describe('Google Slides page/slide object ID');

/**
 * A page element object ID within a slide.
 */
export const elementIdSchema = z
  .string()
  .min(1, 'Element ID must not be empty')
  .max(128, 'Element ID is too long')
  .describe('Page element object ID');

// ─────────────────────────────────────────────────────────────────────────────
// Colour
// ─────────────────────────────────────────────────────────────────────────────

/**
 * A CSS hex colour value.
 * Accepts 3-digit (#RGB), 6-digit (#RRGGBB), and 8-digit (#RRGGBBAA) forms.
 */
export const colorSchema = z
  .string()
  .regex(
    /^#([0-9a-fA-F]{3}|[0-9a-fA-F]{6}|[0-9a-fA-F]{8})$/,
    'Color must be a valid hex color (e.g. #FF5733, #fff, #FF573380)',
  )
  .describe('Hex color value');

/**
 * RGB colour components, each in the range [0, 1] as used by the
 * Google Slides API.
 */
export const rgbColorSchema = z.object({
  red: z.number().min(0).max(1).describe('Red channel (0–1)'),
  green: z.number().min(0).max(1).describe('Green channel (0–1)'),
  blue: z.number().min(0).max(1).describe('Blue channel (0–1)'),
});

// ─────────────────────────────────────────────────────────────────────────────
// Typography
// ─────────────────────────────────────────────────────────────────────────────

/**
 * Font specification.
 */
export const fontSchema = z
  .object({
    family: z
      .string()
      .min(1)
      .describe('Font family name (e.g. "Roboto", "Arial")'),
    size: z
      .number()
      .positive()
      .max(400)
      .describe('Font size in points'),
    bold: z.boolean().optional().describe('Bold weight'),
    italic: z.boolean().optional().describe('Italic style'),
    underline: z.boolean().optional().describe('Underline decoration'),
    color: colorSchema.optional().describe('Text color'),
  })
  .describe('Font specification');

// ─────────────────────────────────────────────────────────────────────────────
// Position & Dimensions
// ─────────────────────────────────────────────────────────────────────────────

/**
 * Position and size of an element on a slide, in points.
 * Origin is the top-left corner of the slide.
 */
export const positionSchema = z
  .object({
    x: z
      .number()
      .min(0, 'x must be >= 0')
      .describe('Horizontal offset from the left edge, in points'),
    y: z
      .number()
      .min(0, 'y must be >= 0')
      .describe('Vertical offset from the top edge, in points'),
    width: z
      .number()
      .positive('Width must be positive')
      .describe('Element width, in points'),
    height: z
      .number()
      .positive('Height must be positive')
      .describe('Element height, in points'),
  })
  .describe('Position and size of an element on the slide');

// ─────────────────────────────────────────────────────────────────────────────
// Markdown Content
// ─────────────────────────────────────────────────────────────────────────────

/**
 * Markdown content for conversion into slide(s).
 * Must be non-empty and within a sensible size limit.
 */
export const markdownContentSchema = z
  .string()
  .min(1, 'Markdown content must not be empty')
  .max(100_000, 'Markdown content exceeds 100 KB limit')
  .describe('Markdown-formatted content to convert into slides');

// ─────────────────────────────────────────────────────────────────────────────
// Batch Update Requests
// ─────────────────────────────────────────────────────────────────────────────

/**
 * A single Google Slides API batch-update request object.
 * We use `z.record` because the exact shape varies by request type and
 * is validated by the API itself.
 */
export const batchUpdateRequestSchema = z
  .record(z.string(), z.unknown())
  .refine((obj) => Object.keys(obj).length > 0, {
    message: 'Batch update request must contain at least one key',
  })
  .describe('A single Google Slides batchUpdate request');

/**
 * Array of batch-update request objects.
 * Must contain at least one request.
 */
export const batchUpdateRequestsSchema = z
  .array(batchUpdateRequestSchema)
  .min(1, 'At least one batch update request is required')
  .max(1000, 'Cannot exceed 1000 requests per batch')
  .describe('Array of Google Slides batchUpdate requests');

// ─────────────────────────────────────────────────────────────────────────────
// Slide Element Schemas
// ─────────────────────────────────────────────────────────────────────────────

/** Allowed slide element types. */
export const slideElementTypeSchema = z.enum([
  'shape',
  'text',
  'image',
  'table',
  'chart',
  'video',
  'line',
  'group',
  'sheetsChart',
  'wordArt',
]);

/** Styles applicable to a slide element. */
export const elementStylesSchema = z.object({
  fontFamily: z.string().optional(),
  fontSize: z.number().positive().optional(),
  bold: z.boolean().optional(),
  italic: z.boolean().optional(),
  underline: z.boolean().optional(),
  foregroundColor: colorSchema.optional(),
  backgroundColor: colorSchema.optional(),
  alignment: z.enum(['START', 'CENTER', 'END', 'JUSTIFIED']).optional(),
  lineSpacing: z.number().positive().optional(),
  spaceAbove: z.number().min(0).optional(),
  spaceBelow: z.number().min(0).optional(),
  borderColor: colorSchema.optional(),
  borderWeight: z.number().min(0).optional(),
  opacity: z.number().min(0).max(1).optional(),
});

/** Full slide element schema (for validation of tool inputs). */
export const slideElementSchema = z.object({
  id: elementIdSchema,
  type: slideElementTypeSchema,
  position: positionSchema,
  text: z.string().optional(),
  imageUrl: z.string().url().optional(),
  shapeType: z.string().optional(),
  styles: elementStylesSchema.optional(),
});

// ─────────────────────────────────────────────────────────────────────────────
// Tool-Specific Input Schemas
// ─────────────────────────────────────────────────────────────────────────────

/** Input schema for the `get_presentation` tool. */
export const getPresentationInputSchema = z.object({
  presentationId: presentationIdSchema,
});

/** Input schema for the `get_slide` tool. */
export const getSlideInputSchema = z.object({
  presentationId: presentationIdSchema,
  slideId: slideIdSchema.optional(),
  slideIndex: z.number().int().min(0).optional(),
}).refine(
  (data) => data.slideId !== undefined || data.slideIndex !== undefined,
  { message: 'Either slideId or slideIndex must be provided' },
);

/** Input schema for the `create_presentation` tool. */
export const createPresentationInputSchema = z.object({
  title: z.string().min(1).max(500).describe('Presentation title'),
});

/** Input schema for the `add_slide` tool. */
export const addSlideInputSchema = z.object({
  presentationId: presentationIdSchema,
  layoutId: z.string().optional().describe('Layout object ID to use'),
  insertionIndex: z
    .number()
    .int()
    .min(0)
    .optional()
    .describe('Zero-based index at which to insert the new slide'),
});

/** Input schema for the `batch_update` tool. */
export const batchUpdateInputSchema = z.object({
  presentationId: presentationIdSchema,
  requests: batchUpdateRequestsSchema,
});

/** Input schema for the `add_text` tool. */
export const addTextInputSchema = z.object({
  presentationId: presentationIdSchema,
  slideId: slideIdSchema,
  text: z.string().min(1).describe('Text content to add'),
  position: positionSchema.optional(),
  font: fontSchema.optional(),
});

/** Input schema for the `add_image` tool. */
export const addImageInputSchema = z.object({
  presentationId: presentationIdSchema,
  slideId: slideIdSchema,
  imageUrl: z.string().url().describe('Public URL of the image'),
  position: positionSchema.optional(),
});

/** Input schema for the `add_shape` tool. */
export const addShapeInputSchema = z.object({
  presentationId: presentationIdSchema,
  slideId: slideIdSchema,
  shapeType: z
    .string()
    .min(1)
    .describe('Shape type (e.g. RECTANGLE, ELLIPSE, STAR_5)'),
  position: positionSchema,
  fillColor: colorSchema.optional(),
  borderColor: colorSchema.optional(),
  borderWeight: z.number().min(0).optional(),
});

/** Input schema for the `markdown_to_slides` tool. */
export const markdownToSlidesInputSchema = z.object({
  presentationId: presentationIdSchema,
  markdown: markdownContentSchema,
  theme: z.string().optional().describe('Theme name to apply'),
});

/** Input schema for the `take_screenshot` tool. */
export const takeScreenshotInputSchema = z.object({
  presentationId: presentationIdSchema,
  slideIndex: z.number().int().min(0).optional(),
  format: z.enum(['png', 'jpeg', 'webp']).optional(),
});

/** Input schema for the `analyze_design` tool. */
export const analyzeDesignInputSchema = z.object({
  presentationId: presentationIdSchema,
  slideIndex: z.number().int().min(0).optional(),
  checks: z
    .array(
      z.enum([
        'alignment',
        'spacing',
        'color',
        'font',
        'hierarchy',
        'contrast',
        'balance',
      ]),
    )
    .optional()
    .describe('Specific design checks to run (default: all)'),
});

/** Input schema for the `delete_element` tool. */
export const deleteElementInputSchema = z.object({
  presentationId: presentationIdSchema,
  elementId: elementIdSchema,
});

/** Input schema for the `update_element_style` tool. */
export const updateElementStyleInputSchema = z.object({
  presentationId: presentationIdSchema,
  elementId: elementIdSchema,
  styles: elementStylesSchema,
});

// ─────────────────────────────────────────────────────────────────────────────
// Validation Utilities
// ─────────────────────────────────────────────────────────────────────────────

/**
 * Validate `input` against a Zod `schema` and return a structured result.
 *
 * @typeParam T - The inferred type of the schema.
 * @param schema - The Zod schema to validate against.
 * @param input - The raw input value.
 * @returns An object with `success`, `data` (on success), or `error` (on failure).
 */
export function validateInput<T>(
  schema: z.ZodType<T>,
  input: unknown,
): { success: true; data: T } | { success: false; error: string } {
  const result = schema.safeParse(input);
  if (result.success) {
    return { success: true, data: result.data };
  }

  const messages = result.error.issues.map(
    (issue) => `${issue.path.join('.')}: ${issue.message}`,
  );
  return { success: false, error: messages.join('; ') };
}

/**
 * Validate and throw on failure.
 * Convenience wrapper when you want exceptions rather than result objects.
 *
 * @typeParam T - The inferred type of the schema.
 * @param schema - The Zod schema.
 * @param input - The raw input.
 * @returns The validated and parsed data.
 * @throws {z.ZodError} if validation fails.
 */
export function parseInput<T>(schema: z.ZodType<T>, input: unknown): T {
  return schema.parse(input);
}

/**
 * Convert a hex colour string (e.g. "#FF5733") to the Google Slides API
 * RGB object with channels in [0, 1].
 *
 * Accepts 3-digit (#RGB), 6-digit (#RRGGBB), and 8-digit (#RRGGBBAA) hex
 * strings.  For 8-digit hex the alpha channel is silently ignored — only
 * the RGB portion is used.
 *
 * @param hex - A hex colour string (with or without leading `#`).
 * @returns An object with `red`, `green`, `blue` channels in [0, 1].
 * @throws {Error} If the input is not a valid hex color string.
 */
export function hexToGoogleRgb(hex: string): {
  red: number;
  green: number;
  blue: number;
} {
  if (typeof hex !== 'string' || !hex) {
    throw new Error(`Invalid hex color: expected a non-empty string, got ${typeof hex}`);
  }

  const cleaned = hex.replace('#', '');

  // Validate the hex string contains only valid hex characters and has a valid length.
  if (!/^[0-9a-fA-F]{3}$|^[0-9a-fA-F]{6}$|^[0-9a-fA-F]{8}$/.test(cleaned)) {
    throw new Error(
      `Invalid hex color "${hex}": must be a 3, 6, or 8 digit hex string (e.g. #RGB, #RRGGBB, #RRGGBBAA)`,
    );
  }

  let r: number, g: number, b: number;

  if (cleaned.length === 3) {
    r = parseInt(cleaned[0]! + cleaned[0]!, 16);
    g = parseInt(cleaned[1]! + cleaned[1]!, 16);
    b = parseInt(cleaned[2]! + cleaned[2]!, 16);
  } else {
    // For both 6-digit and 8-digit hex, use only the first 6 characters (ignore alpha).
    r = parseInt(cleaned.slice(0, 2), 16);
    g = parseInt(cleaned.slice(2, 4), 16);
    b = parseInt(cleaned.slice(4, 6), 16);
  }

  // Guard against NaN results from parseInt (should not happen after regex validation,
  // but provides a safety net).
  if (Number.isNaN(r) || Number.isNaN(g) || Number.isNaN(b)) {
    throw new Error(`Invalid hex color "${hex}": parsed NaN for one or more channels`);
  }

  return {
    red: r / 255,
    green: g / 255,
    blue: b / 255,
  };
}
