/**
 * @module api/tools
 * @description MCP tool definitions for the Google Slides REST API layer.
 *
 * Each tool follows the Model Context Protocol contract:
 * - JSON Schema input definition (via Zod -> JSON Schema)
 * - Zod validation of incoming arguments
 * - Structured {@link ToolResult} return values
 * - Comprehensive error handling with {@link ToolExecutionError}
 *
 * Tools are prefixed with `slides_` to distinguish them from
 * browser-layer and vision-layer tools.
 */

import { z } from 'zod';
import { randomUUID } from 'node:crypto';
import type { slides_v1 } from 'googleapis';
import type { ToolResult } from '../shared/types.js';
import { MCPLayer } from '../shared/types.js';
import {
  validateInput,
  presentationIdSchema,
  slideIdSchema,
  positionSchema,
  fontSchema,
  colorSchema,
  markdownContentSchema,
  batchUpdateRequestsSchema,
} from '../shared/validators.js';
import { ToolExecutionError, createToolError } from '../shared/errors.js';
import { createLogger } from '../shared/logger.js';
import * as client from './client.js';
import {
  markdownToSlides,
  updatePresentationFromMarkdown,
  appendSlidesFromMarkdown,
} from './markdown.js';
import {
  EMU_PER_POINT,
  DEFAULT_FONT_FAMILY,
  DEFAULT_BODY_FONT_SIZE,
  MCP_SERVER_VERSION,
} from '../shared/constants.js';
import { hexToGoogleRgb } from '../shared/validators.js';
import { zodToJsonSchema } from '../shared/schema-converter.js';

// Security: input sanitization
import {
  sanitizeString,
  sanitizePresentationId,
  sanitizeMarkdown,
} from '../security/input-sanitizer.js';

// Monitoring: metrics
import { defaultMetrics } from '../monitoring/metrics.js';

// Monitoring: audit logging
import { auditLogger } from '../monitoring/audit-log.js';

// Events: event emission
import { eventBus } from '../events/event-bus.js';

const log = createLogger('api.tools');

// ─────────────────────────────────────────────────────────────────────────────
// Google Slides API string literal types
// ─────────────────────────────────────────────────────────────────────────────

/** Predefined slide layout names accepted by the Google Slides API. */
type PredefinedLayout =
  | 'BLANK' | 'CAPTION_ONLY' | 'TITLE' | 'TITLE_AND_BODY'
  | 'TITLE_AND_TWO_COLUMNS' | 'TITLE_ONLY' | 'SECTION_HEADER'
  | 'SECTION_TITLE_AND_DESCRIPTION' | 'ONE_COLUMN_TEXT'
  | 'MAIN_POINT' | 'BIG_NUMBER';

/** Shape types accepted by the Google Slides API createShape request. */
type GoogleShapeType =
  | 'TEXT_BOX' | 'RECTANGLE' | 'ROUND_RECTANGLE' | 'ELLIPSE'
  | 'ARC' | 'BENT_ARROW' | 'BENT_UP_ARROW' | 'BEVEL' | 'BLOCK_ARC'
  | 'BRACE_PAIR' | 'BRACKET_PAIR' | 'CAN' | 'CHEVRON' | 'CHORD'
  | 'CLOUD' | 'CORNER' | 'CUBE' | 'CURVED_DOWN_ARROW'
  | 'CURVED_LEFT_ARROW' | 'CURVED_RIGHT_ARROW' | 'CURVED_UP_ARROW'
  | 'DECAGON' | 'DIAGONAL_STRIPE' | 'DIAMOND' | 'DODECAGON'
  | 'DONUT' | 'DOUBLE_WAVE' | 'DOWN_ARROW' | 'DOWN_ARROW_CALLOUT'
  | 'FOLDED_CORNER' | 'FRAME' | 'HALF_FRAME' | 'HEART' | 'HEPTAGON'
  | 'HEXAGON' | 'HOME_PLATE' | 'HORIZONTAL_SCROLL' | 'IRREGULAR_SEAL_1'
  | 'IRREGULAR_SEAL_2' | 'LEFT_ARROW' | 'LEFT_ARROW_CALLOUT'
  | 'LEFT_BRACE' | 'LEFT_BRACKET' | 'LEFT_RIGHT_ARROW'
  | 'LEFT_RIGHT_ARROW_CALLOUT' | 'LEFT_RIGHT_UP_ARROW' | 'LEFT_UP_ARROW'
  | 'LIGHTNING_BOLT' | 'MATH_DIVIDE' | 'MATH_EQUAL' | 'MATH_MINUS'
  | 'MATH_MULTIPLY' | 'MATH_NOT_EQUAL' | 'MATH_PLUS' | 'MOON'
  | 'NO_SMOKING' | 'NOTCHED_RIGHT_ARROW' | 'OCTAGON' | 'PARALLELOGRAM'
  | 'PENTAGON' | 'PIE' | 'PLAQUE' | 'PLUS' | 'QUAD_ARROW'
  | 'QUAD_ARROW_CALLOUT' | 'RIBBON' | 'RIBBON_2' | 'RIGHT_ARROW'
  | 'RIGHT_ARROW_CALLOUT' | 'RIGHT_BRACE' | 'RIGHT_BRACKET'
  | 'ROUND_1_RECTANGLE' | 'ROUND_2_DIAGONAL_RECTANGLE'
  | 'ROUND_2_SAME_RECTANGLE' | 'RIGHT_TRIANGLE' | 'SMILEY_FACE'
  | 'SNIP_1_RECTANGLE' | 'SNIP_2_DIAGONAL_RECTANGLE'
  | 'SNIP_2_SAME_RECTANGLE' | 'SNIP_ROUND_RECTANGLE' | 'STAR_10'
  | 'STAR_12' | 'STAR_16' | 'STAR_24' | 'STAR_32' | 'STAR_4'
  | 'STAR_5' | 'STAR_6' | 'STAR_7' | 'STAR_8' | 'STRIPED_RIGHT_ARROW'
  | 'SUN' | 'TRAPEZOID' | 'TRIANGLE' | 'UP_ARROW' | 'UP_ARROW_CALLOUT'
  | 'UP_DOWN_ARROW' | 'UTURN_ARROW' | 'VERTICAL_SCROLL' | 'WAVE'
  | 'WEDGE_ELLIPSE_CALLOUT' | 'WEDGE_RECTANGLE_CALLOUT'
  | 'WEDGE_ROUND_RECTANGLE_CALLOUT' | 'FLOW_CHART_ALTERNATE_PROCESS'
  | 'FLOW_CHART_COLLATE' | 'FLOW_CHART_CONNECTOR' | 'FLOW_CHART_DECISION'
  | 'FLOW_CHART_DELAY' | 'FLOW_CHART_DISPLAY' | 'FLOW_CHART_DOCUMENT'
  | 'FLOW_CHART_EXTRACT' | 'FLOW_CHART_INPUT_OUTPUT'
  | 'FLOW_CHART_INTERNAL_STORAGE' | 'FLOW_CHART_MAGNETIC_DISK'
  | 'FLOW_CHART_MAGNETIC_DRUM' | 'FLOW_CHART_MAGNETIC_TAPE'
  | 'FLOW_CHART_MANUAL_INPUT' | 'FLOW_CHART_MANUAL_OPERATION'
  | 'FLOW_CHART_MERGE' | 'FLOW_CHART_MULTIDOCUMENT'
  | 'FLOW_CHART_OFFLINE_STORAGE' | 'FLOW_CHART_OFFPAGE_CONNECTOR'
  | 'FLOW_CHART_ONLINE_STORAGE' | 'FLOW_CHART_OR'
  | 'FLOW_CHART_PREDEFINED_PROCESS' | 'FLOW_CHART_PREPARATION'
  | 'FLOW_CHART_PROCESS' | 'FLOW_CHART_PUNCHED_CARD'
  | 'FLOW_CHART_PUNCHED_TAPE' | 'FLOW_CHART_SORT'
  | 'FLOW_CHART_SUMMING_JUNCTION' | 'FLOW_CHART_TERMINATOR'
  | 'ARROW_EAST' | 'ARROW_NORTH' | 'ARROW_NORTH_EAST' | 'SPEECH'
  | 'STARBURST' | 'TEARDROP' | 'CUSTOM';

// ─────────────────────────────────────────────────────────────────────────────
// Tool Result Helpers
// ─────────────────────────────────────────────────────────────────────────────

function successText(text: string): ToolResult {
  return { content: [{ type: 'text', text }], isError: false };
}

function errorResult(message: string): ToolResult {
  return { content: [{ type: 'text', text: `Error: ${message}` }], isError: true };
}

async function executeTool<T>(
  toolName: string,
  schema: z.ZodType<T>,
  args: unknown,
  handler: (validated: T) => Promise<ToolResult>,
): Promise<ToolResult> {
  const validation = validateInput(schema, args);
  if (!validation.success) {
    log.warn('Tool input validation failed', { toolName, error: validation.error });
    return errorResult(`Invalid input for ${toolName}: ${validation.error}`);
  }

  const startTime = Date.now();
  try {
    const result = await handler(validation.data);
    const duration = Date.now() - startTime;
    defaultMetrics.apiCallsTotal.inc({ tool: toolName, status: 'success' });
    defaultMetrics.apiCallDuration.observe(duration, { tool: toolName });

    // Audit log for presentation lifecycle operations (fire-and-forget)
    if (toolName.includes('create_presentation') || toolName.includes('markdown_create')) {
      auditLogger.logPresentationEvent(
        'presentation.created', 'system', toolName,
        { tool: toolName, durationMs: duration },
      ).catch(() => {});
    } else if (toolName.includes('delete')) {
      auditLogger.logPresentationEvent(
        'presentation.deleted', 'system', toolName,
        { tool: toolName, durationMs: duration },
      ).catch(() => {});
    } else if (toolName.includes('share')) {
      auditLogger.logPresentationEvent(
        'presentation.shared', 'system', toolName,
        { tool: toolName, durationMs: duration },
      ).catch(() => {});
    } else if (toolName.includes('export')) {
      auditLogger.logPresentationEvent(
        'presentation.exported', 'system', toolName,
        { tool: toolName, durationMs: duration },
      ).catch(() => {});
    }

    return result;
  } catch (error) {
    const duration = Date.now() - startTime;
    defaultMetrics.apiCallsTotal.inc({ tool: toolName, status: 'error' });
    defaultMetrics.apiCallDuration.observe(duration, { tool: toolName });
    defaultMetrics.errorsTotal.inc({ type: 'tool_execution', layer: 'api' });
    const toolError = createToolError(error, toolName, MCPLayer.API);
    log.error('Tool execution failed', { toolName, error: toolError.message });
    return errorResult(toolError.message);
  }
}

// ─────────────────────────────────────────────────────────────────────────────
// Input Schemas
// ─────────────────────────────────────────────────────────────────────────────

const createPresentationSchema = z.object({
  title: z.string().min(1).max(500).describe('Presentation title'),
});

const getPresentationSchema = z.object({
  presentationId: presentationIdSchema,
});

const getPageSchema = z.object({
  presentationId: presentationIdSchema,
  pageObjectId: slideIdSchema.describe('Page object ID of the slide'),
});

const getPageThumbnailSchema = z.object({
  presentationId: presentationIdSchema,
  pageObjectId: slideIdSchema.describe('Page object ID'),
  thumbnailSize: z.enum(['SMALL', 'MEDIUM', 'LARGE']).optional().describe('Thumbnail size (default: MEDIUM)'),
});

const batchUpdateSchema = z.object({
  presentationId: presentationIdSchema,
  requests: batchUpdateRequestsSchema,
});

const createSlideSchema = z.object({
  presentationId: presentationIdSchema,
  insertionIndex: z.number().int().min(0).optional().describe('Zero-based insertion index'),
  layoutId: z.string().optional().describe('Layout object ID or predefined layout name'),
});

const deleteSlideSchema = z.object({
  presentationId: presentationIdSchema,
  slideId: slideIdSchema,
});

const duplicateSlideSchema = z.object({
  presentationId: presentationIdSchema,
  slideId: slideIdSchema,
  insertionIndex: z.number().int().min(0).optional().describe('Position for the duplicated slide'),
});

const addTextSchema = z.object({
  presentationId: presentationIdSchema,
  slideId: slideIdSchema,
  text: z.string().min(1).describe('Text content to add'),
  position: positionSchema.optional().describe('Position and size of the text box'),
  font: fontSchema.optional().describe('Font specification'),
});

const addImageSchema = z.object({
  presentationId: presentationIdSchema,
  slideId: slideIdSchema,
  imageUrl: z.string().url().describe('Public URL of the image'),
  position: positionSchema.optional().describe('Position and size of the image'),
});

const addTableSchema = z.object({
  presentationId: presentationIdSchema,
  slideId: slideIdSchema,
  rows: z.number().int().min(1).max(50).describe('Number of rows'),
  columns: z.number().int().min(1).max(20).describe('Number of columns'),
  position: positionSchema.optional().describe('Position and size of the table'),
});

const addShapeSchema = z.object({
  presentationId: presentationIdSchema,
  slideId: slideIdSchema,
  shapeType: z.string().min(1).describe('Shape type (e.g. RECTANGLE, ELLIPSE, TEXT_BOX)'),
  position: positionSchema,
  fillColor: colorSchema.optional().describe('Fill color as hex'),
  borderColor: colorSchema.optional().describe('Border color as hex'),
  borderWeight: z.number().min(0).optional().describe('Border weight in points'),
});

const setLayoutSchema = z.object({
  presentationId: presentationIdSchema,
  slideId: slideIdSchema,
  layoutId: z.string().min(1).describe('Predefined layout name (e.g. BLANK, TITLE, TITLE_AND_BODY)'),
});

const markdownCreateSchema = z.object({
  title: z.string().min(1).max(500).describe('Presentation title'),
  markdown: markdownContentSchema,
});

const markdownUpdateSchema = z.object({
  presentationId: presentationIdSchema,
  markdown: markdownContentSchema,
});

const markdownAppendSchema = z.object({
  presentationId: presentationIdSchema,
  markdown: markdownContentSchema,
  insertionIndex: z.number().int().min(0).optional().describe('Where to insert new slides'),
});

const exportPdfSchema = z.object({
  presentationId: presentationIdSchema,
});

const shareSchema = z.object({
  presentationId: presentationIdSchema,
  role: z.enum(['reader', 'writer', 'commenter']).optional().describe('Permission role (default: reader)'),
});

const summarizeSchema = z.object({
  presentationId: presentationIdSchema,
});

// ─────────────────────────────────────────────────────────────────────────────
// Tool Definition Interface
// ─────────────────────────────────────────────────────────────────────────────

/** Full definition of an MCP tool for the API layer. */
export interface ApiToolDefinition {
  /** The MCP tool name (prefixed with `slides_`). */
  name: string;
  /** Human-readable description shown to the LLM. */
  description: string;
  /** JSON Schema for the tool's input parameters. */
  inputSchema: Record<string, unknown>;
  /** The handler function that executes the tool. */
  handler: (args: unknown) => Promise<ToolResult>;
}

// ─────────────────────────────────────────────────────────────────────────────
// Helpers
// ─────────────────────────────────────────────────────────────────────────────

function pt(points: number): number {
  return Math.round(points * EMU_PER_POINT);
}

function generateId(prefix: string): string {
  const rand = randomUUID().replace(/-/g, '').substring(0, 12);
  const ts = Date.now().toString(36);
  return `${prefix}_${ts}_${rand}`;
}

function formatPresentation(pres: slides_v1.Schema$Presentation): string {
  const slideCount = pres.slides?.length ?? 0;
  const pageSize = pres.pageSize;
  const width = pageSize?.width?.magnitude
    ? pageSize.width.magnitude / (pageSize.width.unit === 'EMU' ? EMU_PER_POINT : 1)
    : 720;
  const height = pageSize?.height?.magnitude
    ? pageSize.height.magnitude / (pageSize.height.unit === 'EMU' ? EMU_PER_POINT : 1)
    : 405;

  return JSON.stringify({
    presentationId: pres.presentationId,
    title: pres.title,
    slideCount,
    pageWidth: Math.round(width),
    pageHeight: Math.round(height),
    url: `https://docs.google.com/presentation/d/${pres.presentationId}/edit`,
    slides: (pres.slides ?? []).map((slide, index) => ({
      slideId: slide.objectId,
      slideIndex: index,
      elementCount: slide.pageElements?.length ?? 0,
    })),
  }, null, 2);
}

function formatPage(page: slides_v1.Schema$Page): string {
  const elements = (page.pageElements ?? []).map((el) => ({
    objectId: el.objectId,
    type: el.shape ? 'shape' : el.image ? 'image' : el.table ? 'table' : el.video ? 'video' : el.line ? 'line' : el.elementGroup ? 'group' : 'unknown',
    size: el.size ? {
      width: el.size.width?.magnitude,
      height: el.size.height?.magnitude,
    } : undefined,
    text: el.shape?.text?.textElements
      ?.map((te) => te.textRun?.content ?? '')
      .join('')
      .trim() || undefined,
  }));

  return JSON.stringify({
    pageId: page.objectId,
    elementCount: elements.length,
    elements,
  }, null, 2);
}

// ─────────────────────────────────────────────────────────────────────────────
// Tool Definitions
// ─────────────────────────────────────────────────────────────────────────────

export const apiTools: ApiToolDefinition[] = [
  // ── 1. slides_create_presentation ─────────────────────────────────────────
  {
    name: 'slides_create_presentation',
    description: 'Create a new empty Google Slides presentation with the given title. Returns the presentation ID and URL.',
    inputSchema: zodToJsonSchema(createPresentationSchema),
    handler: (args) =>
      executeTool('slides_create_presentation', createPresentationSchema, args, async ({ title }) => {
        const safeTitle = sanitizeString(title, { maxLength: 500 });
        const pres = await client.createPresentation(safeTitle);

        // Emit event
        eventBus.emit({
          id: randomUUID(),
          type: 'presentation.created',
          timestamp: new Date(),
          data: { presentationId: pres.presentationId, title: safeTitle, method: 'api' },
          metadata: { source: 'api.tools', version: MCP_SERVER_VERSION },
        });
        defaultMetrics.presentationsCreatedTotal.inc({ method: 'api' });

        return successText(formatPresentation(pres));
      }),
  },

  // ── 2. slides_get_presentation ────────────────────────────────────────────
  {
    name: 'slides_get_presentation',
    description: 'Get full metadata and slide list for an existing Google Slides presentation.',
    inputSchema: zodToJsonSchema(getPresentationSchema),
    handler: (args) =>
      executeTool('slides_get_presentation', getPresentationSchema, args, async ({ presentationId }) => {
        const safeId = sanitizePresentationId(presentationId);
        const pres = await client.getPresentation(safeId);
        return successText(formatPresentation(pres));
      }),
  },

  // ── 3. slides_get_page ────────────────────────────────────────────────────
  {
    name: 'slides_get_page',
    description: 'Get detailed content of a specific slide page, including all elements, text, and properties.',
    inputSchema: zodToJsonSchema(getPageSchema),
    handler: (args) =>
      executeTool('slides_get_page', getPageSchema, args, async ({ presentationId, pageObjectId }) => {
        const safePresId = sanitizePresentationId(presentationId);
        const safePageId = sanitizeString(pageObjectId, { maxLength: 200 });
        const page = await client.getPage(safePresId, safePageId);
        return successText(formatPage(page));
      }),
  },

  // ── 4. slides_get_page_thumbnail ──────────────────────────────────────────
  {
    name: 'slides_get_page_thumbnail',
    description: 'Get a thumbnail image URL for a specific slide. Returns a URL that can be used to view or download the slide image.',
    inputSchema: zodToJsonSchema(getPageThumbnailSchema),
    handler: (args) =>
      executeTool('slides_get_page_thumbnail', getPageThumbnailSchema, args, async ({ presentationId, pageObjectId, thumbnailSize }) => {
        const safePresId = sanitizePresentationId(presentationId);
        const safePageId = sanitizeString(pageObjectId, { maxLength: 200 });
        const thumbnail = await client.getPageThumbnail(safePresId, safePageId, thumbnailSize ?? 'MEDIUM');
        return successText(JSON.stringify({
          presentationId,
          pageObjectId,
          contentUrl: thumbnail.contentUrl,
          width: thumbnail.width,
          height: thumbnail.height,
        }, null, 2));
      }),
  },

  // ── 5. slides_batch_update ────────────────────────────────────────────────
  {
    name: 'slides_batch_update',
    description: 'Apply a batch of mutation requests to a presentation. This is the most powerful and flexible API method. Supports all Google Slides API request types.',
    inputSchema: zodToJsonSchema(batchUpdateSchema),
    handler: (args) =>
      executeTool('slides_batch_update', batchUpdateSchema, args, async ({ presentationId, requests }) => {
        const response = await client.batchUpdate(
          presentationId,
          // Intentional loose typing: batchUpdateRequestsSchema validates structure at
          // runtime via Zod, but the Google API types are too narrow for the dynamic
          // request shapes users can pass in. The cast bridges Zod-validated JSON to
          // the googleapis typed interface.
          requests as slides_v1.Schema$Request[],
        );
        return successText(JSON.stringify({
          presentationId,
          requestCount: requests.length,
          repliesCount: response.replies?.length ?? 0,
          replies: response.replies,
        }, null, 2));
      }),
  },

  // ── 6. slides_create_slide ────────────────────────────────────────────────
  {
    name: 'slides_create_slide',
    description: 'Add a new slide to a presentation. Optionally specify a layout and insertion position.',
    inputSchema: zodToJsonSchema(createSlideSchema),
    handler: (args) =>
      executeTool('slides_create_slide', createSlideSchema, args, async ({ presentationId, insertionIndex, layoutId }) => {
        const slideId = generateId('slide');
        const request: slides_v1.Schema$Request = {
          createSlide: {
            objectId: slideId,
            ...(insertionIndex !== undefined ? { insertionIndex } : {}),
            ...(layoutId ? {
              slideLayoutReference: {
                predefinedLayout: layoutId as PredefinedLayout,
              },
            } : {}),
          },
        };
        const response = await client.batchUpdate(presentationId, [request]);
        return successText(JSON.stringify({
          presentationId,
          newSlideId: slideId,
          insertionIndex: insertionIndex ?? 'end',
          layout: layoutId ?? 'default',
          reply: response.replies?.[0],
        }, null, 2));
      }),
  },

  // ── 7. slides_delete_slide ────────────────────────────────────────────────
  {
    name: 'slides_delete_slide',
    description: 'Delete a slide from a presentation by its page object ID.',
    inputSchema: zodToJsonSchema(deleteSlideSchema),
    handler: (args) =>
      executeTool('slides_delete_slide', deleteSlideSchema, args, async ({ presentationId, slideId }) => {
        const safePresId = sanitizePresentationId(presentationId);
        const safeSlideId = sanitizeString(slideId, { maxLength: 200 });
        await client.deleteSlide(safePresId, safeSlideId);

        // Emit event
        eventBus.emit({
          id: randomUUID(),
          type: 'slide.deleted',
          timestamp: new Date(),
          data: { presentationId: safePresId, slideId: safeSlideId },
          metadata: { source: 'api.tools', version: MCP_SERVER_VERSION },
        });

        return successText(JSON.stringify({
          presentationId: safePresId,
          deletedSlideId: safeSlideId,
          status: 'deleted',
        }, null, 2));
      }),
  },

  // ── 8. slides_duplicate_slide ─────────────────────────────────────────────
  {
    name: 'slides_duplicate_slide',
    description: 'Duplicate an existing slide. Optionally specify where to insert the copy.',
    inputSchema: zodToJsonSchema(duplicateSlideSchema),
    handler: (args) =>
      executeTool('slides_duplicate_slide', duplicateSlideSchema, args, async ({ presentationId, slideId, insertionIndex }) => {
        const response = await client.duplicateSlide(presentationId, slideId, insertionIndex);
        const newSlideId = response.replies?.[0]?.duplicateObject?.objectId;
        return successText(JSON.stringify({
          presentationId,
          sourceSlideId: slideId,
          newSlideId: newSlideId ?? 'unknown',
          insertionIndex: insertionIndex ?? 'after source',
        }, null, 2));
      }),
  },

  // ── 9. slides_add_text ────────────────────────────────────────────────────
  {
    name: 'slides_add_text',
    description: 'Add a text box with content to a specific slide. Optionally set position, size, and font.',
    inputSchema: zodToJsonSchema(addTextSchema),
    handler: (args) =>
      executeTool('slides_add_text', addTextSchema, args, async ({ presentationId, slideId, text, position, font }) => {
        const safePresId = sanitizePresentationId(presentationId);
        const safeSlideId = sanitizeString(slideId, { maxLength: 200 });
        const safeText = sanitizeString(text, { maxLength: 50_000, stripHtml: false });
        const elementId = generateId('textbox');
        const x = position?.x ?? 50;
        const y = position?.y ?? 50;
        const width = position?.width ?? 620;
        const height = position?.height ?? 50;
        const fontSize = font?.size ?? DEFAULT_BODY_FONT_SIZE;
        const fontFamily = font?.family ?? DEFAULT_FONT_FAMILY;

        const requests: slides_v1.Schema$Request[] = [
          {
            createShape: {
              objectId: elementId,
              shapeType: 'TEXT_BOX',
              elementProperties: {
                pageObjectId: safeSlideId,
                size: {
                  width: { magnitude: pt(width), unit: 'EMU' },
                  height: { magnitude: pt(height), unit: 'EMU' },
                },
                transform: {
                  scaleX: 1, scaleY: 1,
                  translateX: pt(x), translateY: pt(y),
                  unit: 'EMU',
                },
              },
            },
          },
          { insertText: { objectId: elementId, text: safeText, insertionIndex: 0 } },
          {
            updateTextStyle: {
              objectId: elementId,
              textRange: { type: 'ALL' },
              style: {
                fontFamily,
                fontSize: { magnitude: fontSize, unit: 'PT' },
                ...(font?.bold ? { bold: true } : {}),
                ...(font?.italic ? { italic: true } : {}),
                ...(font?.underline ? { underline: true } : {}),
                ...(font?.color ? {
                  foregroundColor: { opaqueColor: { rgbColor: hexToGoogleRgb(font.color) } },
                } : {}),
              },
              fields: [
                'fontFamily', 'fontSize',
                ...(font?.bold ? ['bold'] : []),
                ...(font?.italic ? ['italic'] : []),
                ...(font?.underline ? ['underline'] : []),
                ...(font?.color ? ['foregroundColor'] : []),
              ].join(','),
            },
          },
        ];

        await client.batchUpdate(safePresId, requests);
        return successText(JSON.stringify({
          presentationId: safePresId, slideId: safeSlideId,
          elementId,
          text: safeText.substring(0, 100) + (safeText.length > 100 ? '...' : ''),
          position: { x, y, width, height },
        }, null, 2));
      }),
  },

  // ── 10. slides_add_image ──────────────────────────────────────────────────
  {
    name: 'slides_add_image',
    description: 'Insert an image from a public URL into a specific slide.',
    inputSchema: zodToJsonSchema(addImageSchema),
    handler: (args) =>
      executeTool('slides_add_image', addImageSchema, args, async ({ presentationId, slideId, imageUrl, position }) => {
        const elementId = generateId('image');
        const x = position?.x ?? 160;
        const y = position?.y ?? 80;
        const width = position?.width ?? 400;
        const height = position?.height ?? 240;

        const requests: slides_v1.Schema$Request[] = [{
          createImage: {
            objectId: elementId,
            url: imageUrl,
            elementProperties: {
              pageObjectId: slideId,
              size: {
                width: { magnitude: pt(width), unit: 'EMU' },
                height: { magnitude: pt(height), unit: 'EMU' },
              },
              transform: {
                scaleX: 1, scaleY: 1,
                translateX: pt(x), translateY: pt(y),
                unit: 'EMU',
              },
            },
          },
        }];

        await client.batchUpdate(presentationId, requests);
        return successText(JSON.stringify({
          presentationId, slideId, elementId, imageUrl,
          position: { x, y, width, height },
        }, null, 2));
      }),
  },

  // ── 11. slides_add_table ──────────────────────────────────────────────────
  {
    name: 'slides_add_table',
    description: 'Add a table to a specific slide with a given number of rows and columns.',
    inputSchema: zodToJsonSchema(addTableSchema),
    handler: (args) =>
      executeTool('slides_add_table', addTableSchema, args, async ({ presentationId, slideId, rows, columns, position }) => {
        const elementId = generateId('table');
        const x = position?.x ?? 50;
        const y = position?.y ?? 100;
        const width = position?.width ?? 620;
        const height = position?.height ?? 200;

        const requests: slides_v1.Schema$Request[] = [{
          createTable: {
            objectId: elementId,
            rows,
            columns,
            elementProperties: {
              pageObjectId: slideId,
              size: {
                width: { magnitude: pt(width), unit: 'EMU' },
                height: { magnitude: pt(height), unit: 'EMU' },
              },
              transform: {
                scaleX: 1, scaleY: 1,
                translateX: pt(x), translateY: pt(y),
                unit: 'EMU',
              },
            },
          },
        }];

        await client.batchUpdate(presentationId, requests);
        return successText(JSON.stringify({
          presentationId, slideId, elementId,
          rows, columns,
          position: { x, y, width, height },
        }, null, 2));
      }),
  },

  // ── 12. slides_add_shape ──────────────────────────────────────────────────
  {
    name: 'slides_add_shape',
    description: 'Add a shape (rectangle, ellipse, star, etc.) to a specific slide with optional fill and border colors.',
    inputSchema: zodToJsonSchema(addShapeSchema),
    handler: (args) =>
      executeTool('slides_add_shape', addShapeSchema, args, async ({ presentationId, slideId, shapeType, position, fillColor, borderColor, borderWeight }) => {
        const elementId = generateId('shape');
        const requests: slides_v1.Schema$Request[] = [{
          createShape: {
            objectId: elementId,
            shapeType: shapeType as GoogleShapeType,
            elementProperties: {
              pageObjectId: slideId,
              size: {
                width: { magnitude: pt(position.width), unit: 'EMU' },
                height: { magnitude: pt(position.height), unit: 'EMU' },
              },
              transform: {
                scaleX: 1, scaleY: 1,
                translateX: pt(position.x), translateY: pt(position.y),
                unit: 'EMU',
              },
            },
          },
        }];

        if (fillColor || borderColor || borderWeight !== undefined) {
          const shapeProps: slides_v1.Schema$ShapeProperties = {};
          const fields: string[] = [];

          if (fillColor) {
            shapeProps.shapeBackgroundFill = {
              solidFill: {
                color: { rgbColor: hexToGoogleRgb(fillColor) },
                alpha: 1,
              },
            };
            fields.push('shapeBackgroundFill');
          }
          if (borderColor || borderWeight !== undefined) {
            shapeProps.outline = {
              outlineFill: borderColor ? {
                solidFill: {
                  color: { rgbColor: hexToGoogleRgb(borderColor) },
                  alpha: 1,
                },
              } : undefined,
              weight: borderWeight !== undefined ? { magnitude: borderWeight, unit: 'PT' } : undefined,
            };
            fields.push('outline');
          }

          requests.push({
            updateShapeProperties: {
              objectId: elementId,
              shapeProperties: shapeProps,
              fields: fields.join(','),
            },
          });
        }

        await client.batchUpdate(presentationId, requests);
        return successText(JSON.stringify({
          presentationId, slideId, elementId, shapeType,
          position, fillColor, borderColor, borderWeight,
        }, null, 2));
      }),
  },

  // ── 13. slides_set_layout ─────────────────────────────────────────────────
  {
    name: 'slides_set_layout',
    description: 'Attempt to change the layout of an existing slide (best-effort). This sets the layoutObjectId property, which may not work for all layout changes since the Google Slides API does not support full layout replacement on existing slides. If this fails, consider duplicating the slide with the desired layout and copying elements manually. Available layouts: BLANK, TITLE, TITLE_AND_BODY, TITLE_AND_TWO_COLUMNS, TITLE_ONLY, SECTION_HEADER, ONE_COLUMN_TEXT, MAIN_POINT, BIG_NUMBER.',
    inputSchema: zodToJsonSchema(setLayoutSchema),
    handler: (args) =>
      executeTool('slides_set_layout', setLayoutSchema, args, async ({ presentationId, slideId, layoutId }) => {
        const requests: slides_v1.Schema$Request[] = [{
          updateSlideProperties: {
            objectId: slideId,
            slideProperties: {
              layoutObjectId: layoutId,
            },
            fields: 'layoutObjectId',
          },
        }];
        try {
          await client.batchUpdate(presentationId, requests);
          return successText(JSON.stringify({
            presentationId, slideId,
            layout: layoutId,
            status: 'layout updated',
          }, null, 2));
        } catch (error) {
          const message = error instanceof Error ? error.message : String(error);
          return successText(JSON.stringify({
            presentationId, slideId,
            layout: layoutId,
            status: 'layout update failed',
            error: message,
            suggestion: 'The Google Slides API has limited support for changing layouts on existing slides. As a workaround, create a new slide with the desired layout (slides_create_slide), copy elements to it, and delete the old slide.',
          }, null, 2));
        }
      }),
  },

  // ── 14. slides_markdown_create ────────────────────────────────────────────
  {
    name: 'slides_markdown_create',
    description: 'Create a new presentation from Markdown content. Automatically splits content into slides, detects layouts, and formats headings, bullets, code blocks, tables, and images.',
    inputSchema: zodToJsonSchema(markdownCreateSchema),
    handler: (args) =>
      executeTool('slides_markdown_create', markdownCreateSchema, args, async ({ title, markdown }) => {
        const safeTitle = sanitizeString(title, { maxLength: 500 });
        const safeMarkdown = sanitizeMarkdown(markdown);
        const pres = await client.createPresentation(safeTitle);
        const presentationId = pres.presentationId!;
        const initialSlideId = pres.slides?.[0]?.objectId;

        const { createRequests, deleteInitialSlideRequest } = markdownToSlides(safeTitle, safeMarkdown);

        const allRequests: slides_v1.Schema$Request[] = [...createRequests];
        if (initialSlideId) {
          allRequests.push(deleteInitialSlideRequest(initialSlideId));
        }

        if (allRequests.length > 0) {
          await client.batchUpdate(presentationId, allRequests);
        }

        const updatedPres = await client.getPresentation(presentationId);

        // Emit event
        eventBus.emit({
          id: randomUUID(),
          type: 'presentation.created',
          timestamp: new Date(),
          data: { presentationId, title: safeTitle, method: 'markdown', slideCount: updatedPres.slides?.length ?? 0 },
          metadata: { source: 'api.tools', version: MCP_SERVER_VERSION },
        });
        defaultMetrics.presentationsCreatedTotal.inc({ method: 'markdown' });

        return successText(JSON.stringify({
          presentationId,
          title: safeTitle,
          slideCount: updatedPres.slides?.length ?? 0,
          url: `https://docs.google.com/presentation/d/${presentationId}/edit`,
          status: 'created from markdown',
        }, null, 2));
      }),
  },

  // ── 15. slides_markdown_update ────────────────────────────────────────────
  {
    name: 'slides_markdown_update',
    description: 'Replace all slides in an existing presentation with new content from Markdown. Deletes existing slides and creates new ones.',
    inputSchema: zodToJsonSchema(markdownUpdateSchema),
    handler: (args) =>
      executeTool('slides_markdown_update', markdownUpdateSchema, args, async ({ presentationId, markdown }) => {
        const safePresId = sanitizePresentationId(presentationId);
        const safeMarkdown = sanitizeMarkdown(markdown);
        const pres = await client.getPresentation(safePresId);
        const existingSlideIds = (pres.slides ?? []).map((s) => s.objectId!).filter(Boolean);

        const requests = updatePresentationFromMarkdown(safeMarkdown, existingSlideIds);
        if (requests.length > 0) {
          await client.batchUpdate(safePresId, requests as slides_v1.Schema$Request[]);
        }

        const updatedPres = await client.getPresentation(safePresId);

        // Emit event
        eventBus.emit({
          id: randomUUID(),
          type: 'presentation.updated',
          timestamp: new Date(),
          data: { presentationId: safePresId, method: 'markdown_update' },
          metadata: { source: 'api.tools', version: MCP_SERVER_VERSION },
        });

        return successText(JSON.stringify({
          presentationId: safePresId,
          previousSlideCount: existingSlideIds.length,
          newSlideCount: updatedPres.slides?.length ?? 0,
          url: `https://docs.google.com/presentation/d/${presentationId}/edit`,
          status: 'updated from markdown',
        }, null, 2));
      }),
  },

  // ── 16. slides_markdown_append ────────────────────────────────────────────
  {
    name: 'slides_markdown_append',
    description: 'Append new slides from Markdown to an existing presentation. Optionally specify where to insert them.',
    inputSchema: zodToJsonSchema(markdownAppendSchema),
    handler: (args) =>
      executeTool('slides_markdown_append', markdownAppendSchema, args, async ({ presentationId, markdown, insertionIndex }) => {
        const pres = await client.getPresentation(presentationId);
        const existingCount = pres.slides?.length ?? 0;
        const effectiveIndex = insertionIndex ?? existingCount;

        const requests = appendSlidesFromMarkdown(markdown, effectiveIndex);
        if (requests.length > 0) {
          await client.batchUpdate(presentationId, requests as slides_v1.Schema$Request[]);
        }

        const updatedPres = await client.getPresentation(presentationId);
        return successText(JSON.stringify({
          presentationId,
          previousSlideCount: existingCount,
          newSlideCount: updatedPres.slides?.length ?? 0,
          insertedAt: effectiveIndex,
          url: `https://docs.google.com/presentation/d/${presentationId}/edit`,
          status: 'appended from markdown',
        }, null, 2));
      }),
  },

  // ── 17. slides_export_pdf ─────────────────────────────────────────────────
  {
    name: 'slides_export_pdf',
    description: 'Get a PDF export URL for a presentation. The URL can be used to download the presentation as a PDF.',
    inputSchema: zodToJsonSchema(exportPdfSchema),
    handler: (args) =>
      executeTool('slides_export_pdf', exportPdfSchema, args, async ({ presentationId }) => {
        const safePresId = sanitizePresentationId(presentationId);
        const url = await client.exportPdf(safePresId);

        // Emit event
        eventBus.emit({
          id: randomUUID(),
          type: 'presentation.exported',
          timestamp: new Date(),
          data: { presentationId: safePresId, format: 'pdf' },
          metadata: { source: 'api.tools', version: MCP_SERVER_VERSION },
        });

        return successText(JSON.stringify({
          presentationId: safePresId,
          pdfUrl: url,
          instructions: 'Open this URL in a browser to download the PDF. The URL requires Google authentication.',
        }, null, 2));
      }),
  },

  // ── 18. slides_share ──────────────────────────────────────────────────────
  {
    name: 'slides_share',
    description: 'Create a shareable link for a presentation with specified permissions (reader, writer, or commenter).',
    inputSchema: zodToJsonSchema(shareSchema),
    handler: (args) =>
      executeTool('slides_share', shareSchema, args, async ({ presentationId, role }) => {
        const safePresId = sanitizePresentationId(presentationId);
        const effectiveRole = role ?? 'reader';
        const url = await client.sharePresentation(safePresId, effectiveRole);

        // Emit event
        eventBus.emit({
          id: randomUUID(),
          type: 'presentation.shared',
          timestamp: new Date(),
          data: { presentationId: safePresId, role: effectiveRole },
          metadata: { source: 'api.tools', version: MCP_SERVER_VERSION },
        });

        return successText(JSON.stringify({
          presentationId: safePresId,
          shareUrl: url,
          role: effectiveRole,
          status: 'shared with anyone who has the link',
        }, null, 2));
      }),
  },

  // ── 19. slides_summarize ──────────────────────────────────────────────────
  {
    name: 'slides_summarize',
    description: 'Extract all text content from a presentation for summarization. Returns text and speaker notes for each slide.',
    inputSchema: zodToJsonSchema(summarizeSchema),
    handler: (args) =>
      executeTool('slides_summarize', summarizeSchema, args, async ({ presentationId }) => {
        const slideTexts = await client.extractAllText(presentationId);
        const totalWords = slideTexts.reduce(
          (sum, s) => sum + (s.text + ' ' + s.notes).split(/\s+/).filter(Boolean).length,
          0,
        );

        return successText(JSON.stringify({
          presentationId,
          slideCount: slideTexts.length,
          totalWordCount: totalWords,
          slides: slideTexts.map((s) => ({
            slideIndex: s.slideIndex,
            slideId: s.slideId,
            text: s.text || '(no text)',
            notes: s.notes || '(no notes)',
            wordCount: (s.text + ' ' + s.notes).split(/\s+/).filter(Boolean).length,
          })),
        }, null, 2));
      }),
  },
];

// ─────────────────────────────────────────────────────────────────────────────
// Lookup Utilities
// ─────────────────────────────────────────────────────────────────────────────

/** Map of tool name -> tool definition for O(1) lookups. */
export const apiToolMap = new Map<string, ApiToolDefinition>(
  apiTools.map((tool) => [tool.name, tool]),
);

/**
 * Get an API tool definition by name.
 */
export function getApiTool(name: string): ApiToolDefinition | undefined {
  return apiToolMap.get(name);
}

/**
 * Check whether a given tool name belongs to the API layer.
 */
export function isApiTool(name: string): boolean {
  return apiToolMap.has(name);
}

/**
 * Execute an API tool by name.
 */
export async function executeApiTool(name: string, args: unknown): Promise<ToolResult> {
  const tool = apiToolMap.get(name);
  if (!tool) {
    throw new ToolExecutionError(`Unknown API tool: ${name}`, name, MCPLayer.API);
  }
  log.info('Executing API tool', { name });
  return tool.handler(args);
}

/**
 * Get all API tool definitions in the format expected by
 * `server.setRequestHandler(ListToolsRequestSchema, ...)`.
 */
export function listApiTools(): Array<{
  name: string;
  description: string;
  inputSchema: Record<string, unknown>;
}> {
  return apiTools.map(({ name, description, inputSchema }) => ({
    name,
    description,
    inputSchema,
  }));
}
