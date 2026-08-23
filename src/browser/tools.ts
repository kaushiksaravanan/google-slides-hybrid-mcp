/**
 * @module browser/tools
 * @description MCP tool definitions for the browser (live editing) layer.
 *
 * Each tool follows the Model Context Protocol contract:
 * - JSON Schema input definition (via Zod → JSON Schema)
 * - Zod validation of incoming arguments
 * - Structured {@link ToolResult} return values
 * - Comprehensive error handling with {@link ToolExecutionError}
 *
 * Tools are prefixed with `live_` to distinguish them from the
 * REST-API-based tools.
 */

import { z } from 'zod';
import type { ToolResult, ToolResultContent } from '../shared/types.js';
import { MCPLayer } from '../shared/types.js';
import { validateInput } from '../shared/validators.js';
import { colorSchema, presentationIdSchema } from '../shared/validators.js';
import { ToolExecutionError, createToolError } from '../shared/errors.js';
import { createLogger } from '../shared/logger.js';
import { zodToJsonSchema } from '../shared/schema-converter.js';
import * as slides from './slides-controller.js';
import * as actions from './actions.js';

const log = createLogger('browser.tools');

// ─────────────────────────────────────────────────────────────────────────────
// Tool Result Helpers
// ─────────────────────────────────────────────────────────────────────────────

/**
 * Create a successful text-only {@link ToolResult}.
 *
 * @param text - The text content to include.
 * @returns A ToolResult with `isError = false`.
 */
function successText(text: string): ToolResult {
  return {
    content: [{ type: 'text', text }],
    isError: false,
  };
}

/**
 * Create a successful image {@link ToolResult}.
 *
 * @param data - Base64-encoded image data.
 * @param mimeType - MIME type of the image.
 * @param caption - Optional text caption to include alongside the image.
 * @returns A ToolResult with `isError = false`.
 */
function successImage(
  data: string,
  mimeType: string,
  caption?: string,
): ToolResult {
  const content: ToolResultContent[] = [];
  if (caption) {
    content.push({ type: 'text', text: caption });
  }
  content.push({ type: 'image', data, mimeType });
  return { content, isError: false };
}

/**
 * Create an error {@link ToolResult}.
 *
 * @param message - The error message.
 * @returns A ToolResult with `isError = true`.
 */
function errorResult(message: string): ToolResult {
  return {
    content: [{ type: 'text', text: `Error: ${message}` }],
    isError: true,
  };
}

/**
 * Wrap a tool handler with standard validation and error handling.
 *
 * @typeParam T - The Zod schema output type.
 * @param toolName - Name of the MCP tool (for error context).
 * @param schema - Zod schema for input validation.
 * @param args - The raw input arguments.
 * @param handler - The async handler that receives validated args and returns a ToolResult.
 * @returns A ToolResult.
 */
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

  try {
    return await handler(validation.data);
  } catch (error) {
    const toolError = createToolError(error, toolName, MCPLayer.BROWSER);
    log.error('Tool execution failed', {
      toolName,
      error: toolError.message,
    });
    return errorResult(toolError.message);
  }
}

// ─────────────────────────────────────────────────────────────────────────────
// Input Schemas
// ─────────────────────────────────────────────────────────────────────────────

/** @internal Schema for `live_navigate_to_presentation`. */
const navigateToPresentationSchema = z.object({
  presentationId: presentationIdSchema,
});

/** @internal Schema for `live_go_to_slide`. */
const goToSlideSchema = z.object({
  slideIndex: z.number().int().min(1).describe('1-based slide number'),
});

/** @internal Schema for `live_click_element`. */
const clickElementSchema = z.object({
  selector: z
    .string()
    .min(1)
    .describe('CSS selector or aria-label of the element to click'),
  index: z
    .number()
    .int()
    .min(0)
    .optional()
    .describe('Zero-based index when multiple elements match'),
});

/** @internal Schema for `live_type_text`. */
const typeTextSchema = z.object({
  text: z.string().min(1).describe('Text to type into the focused element'),
  selector: z
    .string()
    .optional()
    .describe('Optional CSS selector to focus before typing'),
});

/** @internal Schema for `live_press_key`. */
const pressKeySchema = z.object({
  key: z
    .string()
    .min(1)
    .describe('Key to press (e.g. "Tab", "Enter", "Escape")'),
  modifiers: z
    .array(z.string())
    .optional()
    .describe('Modifier keys to hold (e.g. ["Control", "Shift"])'),
});

/** @internal Schema for `live_edit_text`. */
const editTextSchema = z.object({
  elementLabel: z
    .string()
    .min(1)
    .describe('Accessibility label of the text element to edit'),
  newText: z.string().describe('The new text content'),
});

/** @internal Schema for `live_change_font`. */
const changeFontSchema = z.object({
  fontName: z
    .string()
    .min(1)
    .describe('Font family name (e.g. "Roboto", "Arial")'),
});

/** @internal Schema for `live_change_font_size`. */
const changeFontSizeSchema = z.object({
  size: z
    .number()
    .positive()
    .max(400)
    .describe('Font size in points'),
});

/** @internal Schema for `live_change_text_color`. */
const changeTextColorSchema = z.object({
  hexColor: colorSchema.describe('Text color as hex (e.g. "#FF5733")'),
});

/** @internal Schema for `live_change_background`. */
const changeBackgroundSchema = z.object({
  hexColor: colorSchema.describe('Background color as hex (e.g. "#FFFFFF")'),
});

/** @internal Schema for `live_align_elements`. */
const alignElementsSchema = z.object({
  alignment: z
    .enum(['left', 'center', 'right', 'top', 'middle', 'bottom'])
    .describe('Alignment direction'),
});

/** @internal Schema for `live_insert_image`. */
const insertImageSchema = z.object({
  imageUrl: z
    .string()
    .url()
    .describe('Public URL of the image to insert'),
});

/** @internal Schema for `live_move_element`. */
const moveElementSchema = z.object({
  elementLabel: z
    .string()
    .min(1)
    .describe('Accessibility label of the element to move'),
  deltaX: z.number().describe('Horizontal displacement in pixels'),
  deltaY: z.number().describe('Vertical displacement in pixels'),
});

/** @internal Schema for `live_apply_transition`. */
const applyTransitionSchema = z.object({
  transitionType: z
    .string()
    .min(1)
    .describe(
      'Transition type (e.g. "Fade", "Slide from right", "Dissolve", "None")',
    ),
});

/** @internal Schema for `live_set_speaker_notes`. */
const setSpeakerNotesSchema = z.object({
  text: z.string().describe('Speaker notes text content'),
});

/** @internal Empty schema for tools with no parameters. */
const emptySchema = z.object({});

// ─────────────────────────────────────────────────────────────────────────────
// Tool Definition Interface
// ─────────────────────────────────────────────────────────────────────────────

/** Full definition of an MCP tool. */
export interface BrowserToolDefinition {
  /** The MCP tool name (prefixed with `live_`). */
  name: string;
  /** Human-readable description shown to the LLM. */
  description: string;
  /** JSON Schema for the tool's input parameters. */
  inputSchema: Record<string, unknown>;
  /** The handler function that executes the tool. */
  handler: (args: unknown) => Promise<ToolResult>;
}

// ─────────────────────────────────────────────────────────────────────────────
// Tool Definitions
// ─────────────────────────────────────────────────────────────────────────────

/**
 * All browser-layer MCP tool definitions.
 *
 * Each tool is a complete, self-contained definition with:
 * - `name` — the MCP tool name
 * - `description` — shown to the LLM for tool selection
 * - `inputSchema` — JSON Schema for input validation
 * - `handler` — the async function that executes the tool
 */
export const browserTools: BrowserToolDefinition[] = [
  // ── Navigation ──────────────────────────────────────────────────────────

  {
    name: 'live_navigate_to_presentation',
    description:
      'Open a Google Slides presentation in the browser for live editing. ' +
      'Returns a page snapshot after the presentation loads.',
    inputSchema: zodToJsonSchema(navigateToPresentationSchema),
    handler: (args) =>
      executeTool(
        'live_navigate_to_presentation',
        navigateToPresentationSchema,
        args,
        async ({ presentationId }) => {
          const snapshot = await slides.openPresentation(presentationId);
          return successText(
            `Opened presentation ${presentationId}.\n` +
              `URL: ${snapshot.url}\n` +
              `Title: ${snapshot.title}`,
          );
        },
      ),
  },

  {
    name: 'live_go_to_slide',
    description:
      'Navigate to a specific slide by its 1-based index number.',
    inputSchema: zodToJsonSchema(goToSlideSchema),
    handler: (args) =>
      executeTool(
        'live_go_to_slide',
        goToSlideSchema,
        args,
        async ({ slideIndex }) => {
          const snapshot = await slides.goToSlide(slideIndex);
          return successText(
            `Navigated to slide ${slideIndex}.\n` +
              (snapshot.accessibilityTree
                ? `Accessibility tree:\n${snapshot.accessibilityTree}`
                : ''),
          );
        },
      ),
  },

  // ── Screenshots & Snapshots ─────────────────────────────────────────────

  {
    name: 'live_screenshot',
    description:
      'Take a screenshot of the current Google Slides view. ' +
      'Returns a base64-encoded PNG image.',
    inputSchema: zodToJsonSchema(emptySchema),
    handler: (args) =>
      executeTool(
        'live_screenshot',
        emptySchema,
        args ?? {},
        async () => {
          const result = await slides.getSlideScreenshot();
          return successImage(
            result.data,
            result.mimeType,
            'Screenshot of current slide view.',
          );
        },
      ),
  },

  {
    name: 'live_get_accessibility_snapshot',
    description:
      'Get the accessibility tree snapshot of the current page. ' +
      'This provides a structured representation of all visible elements, ' +
      'their roles, labels, and hierarchy — useful for understanding the ' +
      'current state of the slide editor.',
    inputSchema: zodToJsonSchema(emptySchema),
    handler: (args) =>
      executeTool(
        'live_get_accessibility_snapshot',
        emptySchema,
        args ?? {},
        async () => {
          const snapshot = await slides.getSlideAccessibilityTree();
          return successText(
            snapshot.accessibilityTree ??
              'No accessibility tree data available.',
          );
        },
      ),
  },

  {
    name: 'live_get_page_text',
    description:
      'Extract all visible text from the current page. ' +
      'Traverses the DOM including shadow roots and same-origin iframes.',
    inputSchema: zodToJsonSchema(emptySchema),
    handler: (args) =>
      executeTool(
        'live_get_page_text',
        emptySchema,
        args ?? {},
        async () => {
          const text = await actions.getPageText();
          return successText(text || 'No text found on the page.');
        },
      ),
  },

  // ── Click & Type ────────────────────────────────────────────────────────

  {
    name: 'live_click_element',
    description:
      'Click an element on the page by CSS selector or aria-label. ' +
      'Use the accessibility snapshot to find the right selector.',
    inputSchema: zodToJsonSchema(clickElementSchema),
    handler: (args) =>
      executeTool(
        'live_click_element',
        clickElementSchema,
        args,
        async ({ selector, index }) => {
          await actions.click(selector, index);
          return successText(
            `Clicked element "${selector}"` +
              (index !== undefined ? ` (index ${index})` : '') +
              '.',
          );
        },
      ),
  },

  {
    name: 'live_type_text',
    description:
      'Type text into the currently focused element (or a specified element). ' +
      'Use after clicking on a text box or input field.',
    inputSchema: zodToJsonSchema(typeTextSchema),
    handler: (args) =>
      executeTool(
        'live_type_text',
        typeTextSchema,
        args,
        async ({ text, selector }) => {
          if (selector) {
            await actions.type(selector, text);
          } else {
            // Type into whatever is currently focused using evaluateScript
            await actions.evaluateScript(
              `document.execCommand('insertText', false, ${JSON.stringify(text)})`,
            );
          }
          return successText(`Typed ${text.length} characters.`);
        },
      ),
  },

  {
    name: 'live_press_key',
    description:
      'Press a keyboard key or key combination. ' +
      'Supports modifier keys like Control, Shift, Alt. ' +
      'Examples: key="Enter", key="Tab", key="a" with modifiers=["Control"].',
    inputSchema: zodToJsonSchema(pressKeySchema),
    handler: (args) =>
      executeTool(
        'live_press_key',
        pressKeySchema,
        args,
        async ({ key, modifiers }) => {
          if (modifiers && modifiers.length > 0) {
            await actions.pressKeys([...modifiers, key]);
          } else {
            await actions.pressKey(key);
          }
          return successText(
            `Pressed key: ${modifiers ? modifiers.join('+') + '+' : ''}${key}`,
          );
        },
      ),
  },

  // ── Text Editing ────────────────────────────────────────────────────────

  {
    name: 'live_edit_text',
    description:
      'Edit the text content of an element identified by its accessibility label. ' +
      'Clicks the element, selects all existing text, and types the new text.',
    inputSchema: zodToJsonSchema(editTextSchema),
    handler: (args) =>
      executeTool(
        'live_edit_text',
        editTextSchema,
        args,
        async ({ elementLabel, newText }) => {
          await slides.editText(elementLabel, newText);
          return successText(
            `Updated text of "${elementLabel}" to "${newText.substring(0, 50)}${newText.length > 50 ? '...' : ''}".`,
          );
        },
      ),
  },

  // ── Formatting ──────────────────────────────────────────────────────────

  {
    name: 'live_change_font',
    description:
      'Change the font of the currently selected text. ' +
      'Select text first, then use this tool.',
    inputSchema: zodToJsonSchema(changeFontSchema),
    handler: (args) =>
      executeTool(
        'live_change_font',
        changeFontSchema,
        args,
        async ({ fontName }) => {
          await slides.changeFont(fontName);
          return successText(`Changed font to "${fontName}".`);
        },
      ),
  },

  {
    name: 'live_change_font_size',
    description:
      'Change the font size of the currently selected text. ' +
      'Select text first, then use this tool.',
    inputSchema: zodToJsonSchema(changeFontSizeSchema),
    handler: (args) =>
      executeTool(
        'live_change_font_size',
        changeFontSizeSchema,
        args,
        async ({ size }) => {
          await slides.changeFontSize(size);
          return successText(`Changed font size to ${size}pt.`);
        },
      ),
  },

  {
    name: 'live_change_text_color',
    description:
      'Change the color of the currently selected text. ' +
      'Select text first, then use this tool. Provide a hex color value.',
    inputSchema: zodToJsonSchema(changeTextColorSchema),
    handler: (args) =>
      executeTool(
        'live_change_text_color',
        changeTextColorSchema,
        args,
        async ({ hexColor }) => {
          await slides.changeTextColor(hexColor);
          return successText(`Changed text color to ${hexColor}.`);
        },
      ),
  },

  {
    name: 'live_change_background',
    description:
      'Change the background color of the current slide. ' +
      'Provide a hex color value.',
    inputSchema: zodToJsonSchema(changeBackgroundSchema),
    handler: (args) =>
      executeTool(
        'live_change_background',
        changeBackgroundSchema,
        args,
        async ({ hexColor }) => {
          await slides.changeBackgroundColor(hexColor);
          return successText(`Changed slide background to ${hexColor}.`);
        },
      ),
  },

  {
    name: 'live_toggle_bold',
    description:
      'Toggle bold formatting on the currently selected text (Ctrl+B).',
    inputSchema: zodToJsonSchema(emptySchema),
    handler: (args) =>
      executeTool(
        'live_toggle_bold',
        emptySchema,
        args ?? {},
        async () => {
          await slides.applyBold();
          return successText('Toggled bold formatting.');
        },
      ),
  },

  {
    name: 'live_toggle_italic',
    description:
      'Toggle italic formatting on the currently selected text (Ctrl+I).',
    inputSchema: zodToJsonSchema(emptySchema),
    handler: (args) =>
      executeTool(
        'live_toggle_italic',
        emptySchema,
        args ?? {},
        async () => {
          await slides.applyItalic();
          return successText('Toggled italic formatting.');
        },
      ),
  },

  {
    name: 'live_toggle_underline',
    description:
      'Toggle underline formatting on the currently selected text (Ctrl+U).',
    inputSchema: zodToJsonSchema(emptySchema),
    handler: (args) =>
      executeTool(
        'live_toggle_underline',
        emptySchema,
        args ?? {},
        async () => {
          await slides.applyUnderline();
          return successText('Toggled underline formatting.');
        },
      ),
  },

  // ── Alignment ───────────────────────────────────────────────────────────

  {
    name: 'live_align_elements',
    description:
      'Align the currently selected elements. ' +
      'Options: left, center, right, top, middle, bottom.',
    inputSchema: zodToJsonSchema(alignElementsSchema),
    handler: (args) =>
      executeTool(
        'live_align_elements',
        alignElementsSchema,
        args,
        async ({ alignment }) => {
          await slides.alignElements(alignment);
          return successText(`Aligned elements: ${alignment}.`);
        },
      ),
  },

  // ── Insert ──────────────────────────────────────────────────────────────

  {
    name: 'live_insert_image',
    description:
      'Insert an image into the current slide from a public URL.',
    inputSchema: zodToJsonSchema(insertImageSchema),
    handler: (args) =>
      executeTool(
        'live_insert_image',
        insertImageSchema,
        args,
        async ({ imageUrl }) => {
          await slides.insertImage(imageUrl);
          return successText(`Inserted image from URL: ${imageUrl}`);
        },
      ),
  },

  // ── Slide Operations ────────────────────────────────────────────────────

  {
    name: 'live_duplicate_slide',
    description: 'Duplicate the currently selected slide.',
    inputSchema: zodToJsonSchema(emptySchema),
    handler: (args) =>
      executeTool(
        'live_duplicate_slide',
        emptySchema,
        args ?? {},
        async () => {
          await slides.duplicateSlide();
          return successText('Duplicated the current slide.');
        },
      ),
  },

  {
    name: 'live_delete_slide',
    description:
      'Delete the currently selected slide. Use with caution.',
    inputSchema: zodToJsonSchema(emptySchema),
    handler: (args) =>
      executeTool(
        'live_delete_slide',
        emptySchema,
        args ?? {},
        async () => {
          await slides.deleteSlide();
          return successText('Deleted the current slide.');
        },
      ),
  },

  // ── Element Manipulation ────────────────────────────────────────────────

  {
    name: 'live_move_element',
    description:
      'Move a slide element by a given pixel offset. ' +
      'Positive deltaX moves right, positive deltaY moves down.',
    inputSchema: zodToJsonSchema(moveElementSchema),
    handler: (args) =>
      executeTool(
        'live_move_element',
        moveElementSchema,
        args,
        async ({ elementLabel, deltaX, deltaY }) => {
          await slides.moveElement(elementLabel, deltaX, deltaY);
          return successText(
            `Moved "${elementLabel}" by (${deltaX}, ${deltaY}) pixels.`,
          );
        },
      ),
  },

  // ── Transitions & Notes ─────────────────────────────────────────────────

  {
    name: 'live_apply_transition',
    description:
      'Apply a slide transition to the current slide. ' +
      'Examples: "Fade", "Slide from right", "Dissolve", "Flip", "None".',
    inputSchema: zodToJsonSchema(applyTransitionSchema),
    handler: (args) =>
      executeTool(
        'live_apply_transition',
        applyTransitionSchema,
        args,
        async ({ transitionType }) => {
          await slides.applyTransition(transitionType);
          return successText(`Applied transition: ${transitionType}.`);
        },
      ),
  },

  {
    name: 'live_set_speaker_notes',
    description:
      'Set the speaker notes for the current slide. ' +
      'Replaces any existing notes.',
    inputSchema: zodToJsonSchema(setSpeakerNotesSchema),
    handler: (args) =>
      executeTool(
        'live_set_speaker_notes',
        setSpeakerNotesSchema,
        args,
        async ({ text }) => {
          await slides.setSpeakerNotes(text);
          return successText(
            `Set speaker notes (${text.length} characters).`,
          );
        },
      ),
  },
];

// ─────────────────────────────────────────────────────────────────────────────
// Lookup Utilities
// ─────────────────────────────────────────────────────────────────────────────

/**
 * Map of tool name → tool definition for O(1) lookups.
 */
export const browserToolMap = new Map<string, BrowserToolDefinition>(
  browserTools.map((tool) => [tool.name, tool]),
);

/**
 * Get a browser tool definition by name.
 *
 * @param name - The tool name (e.g. "live_screenshot").
 * @returns The tool definition, or `undefined` if not found.
 */
export function getBrowserTool(
  name: string,
): BrowserToolDefinition | undefined {
  return browserToolMap.get(name);
}

/**
 * Check whether a given tool name belongs to the browser layer.
 *
 * @param name - The tool name to check.
 * @returns `true` if the tool is a browser-layer tool.
 */
export function isBrowserTool(name: string): boolean {
  return browserToolMap.has(name);
}

/**
 * Execute a browser tool by name.
 *
 * @param name - The tool name.
 * @param args - The raw input arguments.
 * @returns A ToolResult.
 * @throws {ToolExecutionError} If the tool is not found.
 */
export async function executeBrowserTool(
  name: string,
  args: unknown,
): Promise<ToolResult> {
  const tool = browserToolMap.get(name);
  if (!tool) {
    throw new ToolExecutionError(
      `Unknown browser tool: ${name}`,
      name,
      MCPLayer.BROWSER,
    );
  }

  log.info('Executing browser tool', { name });
  return tool.handler(args);
}

/**
 * Get all browser tool definitions in the format expected by
 * `server.setRequestHandler(ListToolsRequestSchema, ...)`.
 *
 * @returns Array of tool metadata objects (name, description, inputSchema).
 */
export function listBrowserTools(): Array<{
  name: string;
  description: string;
  inputSchema: Record<string, unknown>;
}> {
  return browserTools.map(({ name, description, inputSchema }) => ({
    name,
    description,
    inputSchema,
  }));
}
