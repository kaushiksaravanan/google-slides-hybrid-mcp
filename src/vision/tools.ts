/**
 * @module vision/tools
 * @description MCP tool definitions for the vision (design analysis) layer.
 *
 * Each tool follows the Model Context Protocol contract:
 * - JSON Schema input definition (via Zod -> JSON Schema)
 * - Zod validation of incoming arguments
 * - Structured {@link ToolResult} return values
 * - Comprehensive error handling with {@link ToolExecutionError}
 *
 * Tools are prefixed with `vision_` to distinguish them from
 * REST-API-based and browser-layer tools.
 */

import { z } from 'zod';
import type {
  ToolResult,
  DesignIssueType,
  VisionAnalysis,
  SlideContent,
} from '../shared/types.js';
import { MCPLayer } from '../shared/types.js';
import {
  validateInput,
  presentationIdSchema,
  slideIdSchema,
  colorSchema,
} from '../shared/validators.js';
import { ToolExecutionError, createToolError } from '../shared/errors.js';
import { createLogger } from '../shared/logger.js';
import { zodToJsonSchema } from '../shared/schema-converter.js';
import {
  analyzeSlideDesign,
  extractDominantColors,
  compareSlideConsistency,
} from './analyzer.js';
import {
  evaluateAllRules,
  calculateDesignScore,
  getRecommendedFix,
} from './design-rules.js';
import {
  generateFixes,
} from './auto-fixer.js';
import {
  getTheme,
  listThemes,
  applyTheme,
  applyColorScheme,
  applyFontScheme,
  generateThemePreview,
  type ThemeDefinition,
} from './theme-engine.js';

const log = createLogger('vision.tools');

// ─────────────────────────────────────────────────────────────────────────────
// Tool Result Helpers
// ─────────────────────────────────────────────────────────────────────────────

/**
 * Create a successful text-only {@link ToolResult}.
 */
function successText(text: string): ToolResult {
  return {
    content: [{ type: 'text', text }],
    isError: false,
  };
}

/**
 * Create an error {@link ToolResult}.
 */
function errorResult(message: string): ToolResult {
  return {
    content: [{ type: 'text', text: `Error: ${message}` }],
    isError: true,
  };
}

/**
 * Wrap a tool handler with standard validation and error handling.
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
    const toolError = createToolError(error, toolName, MCPLayer.VISION);
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

/** Design issue type enum for filtering. */
const designIssueTypeEnum = z.enum([
  'alignment',
  'spacing',
  'color',
  'font',
  'hierarchy',
  'contrast',
  'balance',
]).describe('Type of design issue');

/** Schema for `vision_analyze_slide`. */
const analyzeSlideSchema = z.object({
  presentationId: presentationIdSchema,
  slideId: slideIdSchema.optional().describe('Slide page object ID (provide this or slideIndex)'),
  slideIndex: z.number().int().min(0).optional().describe('Zero-based slide index (provide this or slideId)'),
  screenshotBase64: z.string().optional().describe('Base64-encoded PNG screenshot of the slide'),
});

/** Schema for `vision_analyze_presentation`. */
const analyzePresentationSchema = z.object({
  presentationId: presentationIdSchema,
});

/** Schema for `vision_get_design_score`. */
const getDesignScoreSchema = z.object({
  presentationId: presentationIdSchema,
  slideId: slideIdSchema.optional().describe('Optional: score a specific slide'),
});

/** Schema for `vision_get_fix_suggestions`. */
const getFixSuggestionsSchema = z.object({
  presentationId: presentationIdSchema,
  slideId: slideIdSchema,
});

/** Schema for `vision_auto_fix_slide`. */
const autoFixSlideSchema = z.object({
  presentationId: presentationIdSchema,
  slideId: slideIdSchema,
  issueTypes: z.array(designIssueTypeEnum).optional().describe('Filter which issue types to fix'),
});

/** Schema for `vision_auto_fix_presentation`. */
const autoFixPresentationSchema = z.object({
  presentationId: presentationIdSchema,
  issueTypes: z.array(designIssueTypeEnum).optional().describe('Filter which issue types to fix'),
});

/** Schema for `vision_apply_theme`. */
const applyThemeSchema = z.object({
  presentationId: presentationIdSchema,
  themeName: z.string().optional().describe('Name of a preset theme: "Corporate Blue", "Dark Professional", "Warm Minimal", "Nature Fresh", "Slate Modern"'),
  customTheme: z.object({
    name: z.string().describe('Custom theme name'),
    colors: z.object({
      primary: colorSchema,
      secondary: colorSchema,
      accent: colorSchema,
      background: colorSchema,
      surface: colorSchema,
      textPrimary: colorSchema,
      textSecondary: colorSchema,
      border: colorSchema,
    }),
    fonts: z.object({
      titleFamily: z.string(),
      bodyFamily: z.string(),
      titleSize: z.number().positive().optional(),
      subtitleSize: z.number().positive().optional(),
      bodySize: z.number().positive().optional(),
      lineSpacing: z.number().positive().optional(),
    }),
  }).optional().describe('Custom theme definition (alternative to themeName)'),
  slideIds: z.array(slideIdSchema).optional().describe('Specific slides to theme (default: all)'),
});

/** Schema for `vision_apply_color_scheme`. */
const applyColorSchemeSchema = z.object({
  presentationId: presentationIdSchema,
  primaryColor: colorSchema.describe('Primary brand color'),
  secondaryColor: colorSchema.describe('Secondary color'),
  accentColor: colorSchema.describe('Accent/highlight color'),
  backgroundColor: colorSchema.describe('Slide background color'),
  slideIds: z.array(slideIdSchema).optional().describe('Specific slides (default: all)'),
});

/** Schema for `vision_apply_font_scheme`. */
const applyFontSchemeSchema = z.object({
  presentationId: presentationIdSchema,
  titleFont: z.string().min(1).describe('Font family for titles (e.g. "Montserrat")'),
  bodyFont: z.string().min(1).describe('Font family for body text (e.g. "Open Sans")'),
  slideIds: z.array(slideIdSchema).optional().describe('Specific slides (default: all)'),
  elementIds: z.array(z.object({
    elementId: z.string().min(1).describe('The page element object ID'),
    type: z.enum(['title', 'body']).describe('Whether this element is a title or body text'),
  })).optional().describe('Element IDs with their roles. Use get_slide to discover these.'),
});

/** Schema for `vision_compare_slides`. */
const compareSlidesSchema = z.object({
  presentationId: presentationIdSchema,
  slideId1: slideIdSchema.describe('First slide page object ID'),
  slideId2: slideIdSchema.describe('Second slide page object ID'),
  screenshot1Base64: z.string().optional().describe('Base64 screenshot of first slide'),
  screenshot2Base64: z.string().optional().describe('Base64 screenshot of second slide'),
});

/** Schema for `vision_extract_colors`. */
const extractColorsSchema = z.object({
  presentationId: presentationIdSchema,
  slideId: slideIdSchema,
  screenshotBase64: z.string().optional().describe('Base64-encoded PNG screenshot'),
  maxColors: z.number().int().min(1).max(20).optional().describe('Max colors to extract (default: 8)'),
});

// ─────────────────────────────────────────────────────────────────────────────
// Helper: Grade from Score
// ─────────────────────────────────────────────────────────────────────────────

/**
 * Convert a numeric design score (0-100) to a letter grade.
 */
function scoreToGrade(score: number): string {
  if (score >= 90) return 'A';
  if (score >= 80) return 'B';
  if (score >= 70) return 'C';
  if (score >= 60) return 'D';
  return 'F';
}

// ─────────────────────────────────────────────────────────────────────────────
// Stub helpers for tools that need presentation context
// ─────────────────────────────────────────────────────────────────────────────

/**
 * Placeholder: In a production system, this fetches the presentation data
 * via the API client. For the vision tool layer, we work with provided
 * screenshots or return advisory results.
 */
function createPlaceholderSlideContent(slideId: string, slideIndex: number): SlideContent {
  return {
    slideId,
    slideIndex,
    title: undefined,
    elements: [],
    notes: undefined,
  };
}

// ─────────────────────────────────────────────────────────────────────────────
// Tool Definition Interface
// ─────────────────────────────────────────────────────────────────────────────

/** Full definition of an MCP tool for the vision layer. */
export interface VisionToolDefinition {
  /** The MCP tool name (prefixed with `vision_`). */
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
 * All vision-layer MCP tool definitions.
 */
export const visionTools: VisionToolDefinition[] = [
  // ── 1. vision_analyze_slide ─────────────────────────────────────────────

  {
    name: 'vision_analyze_slide',
    description:
      'Analyze the design quality of a specific slide. Evaluates alignment, ' +
      'spacing, typography, color contrast, visual balance, and text density. ' +
      'Returns a comprehensive VisionAnalysis with a score (0-100), issues found, ' +
      'and actionable suggestions. Provide a screenshot for pixel-level analysis.',
    inputSchema: zodToJsonSchema(analyzeSlideSchema),
    handler: (args) =>
      executeTool(
        'vision_analyze_slide',
        analyzeSlideSchema,
        args,
        async ({ presentationId, slideId, slideIndex, screenshotBase64 }) => {
          const effectiveSlideId = slideId ?? `slide_${slideIndex ?? 0}`;

          if (screenshotBase64) {
            // Full pixel-level + structural analysis
            const slideContent = createPlaceholderSlideContent(effectiveSlideId, slideIndex ?? 0);
            const analysis = await analyzeSlideDesign(screenshotBase64, slideContent);

            return successText(JSON.stringify({
              presentationId,
              slideId: effectiveSlideId,
              score: analysis.score,
              grade: scoreToGrade(analysis.score),
              issueCount: analysis.issues.length,
              issues: analysis.issues,
              suggestions: analysis.suggestions,
            }, null, 2));
          }

          // Without a screenshot, provide generic recommendations based on
          // common design issues. Note: actual screenshot or API data would
          // produce much more accurate and specific results.
          return successText(JSON.stringify({
            presentationId,
            slideId: effectiveSlideId,
            score: null,
            note: 'No screenshot provided — results below are generic best-practice recommendations, not based on actual slide analysis.',
            genericRecommendations: [
              { type: 'alignment', suggestion: 'Ensure all elements are aligned to a consistent grid (left-align or center-align).' },
              { type: 'spacing', suggestion: 'Maintain consistent margins (at least 0.5" / 36pt from slide edges) and spacing between elements.' },
              { type: 'font', suggestion: 'Use no more than 2 font families. Titles: 28-36pt, body: 18-24pt.' },
              { type: 'color', suggestion: 'Limit palette to 3-5 colors. Ensure text-to-background contrast ratio >= 4.5:1.' },
              { type: 'hierarchy', suggestion: 'Use clear visual hierarchy: title largest, subtitle medium, body smallest.' },
              { type: 'balance', suggestion: 'Distribute visual weight evenly. Avoid clustering all content in one area.' },
              { type: 'contrast', suggestion: 'Avoid low-contrast text. Light text on light backgrounds or dark text on dark backgrounds is hard to read.' },
            ],
            suggestions: [
              'Use live_screenshot to capture the current slide, then pass the base64 data here for pixel-level analysis.',
              'Alternatively, fetch slide data via get_slide and use the structural content for rule-based analysis.',
            ],
          }, null, 2));
        },
      ),
  },

  // ── 2. vision_analyze_presentation ──────────────────────────────────────

  {
    name: 'vision_analyze_presentation',
    description:
      'Analyze the design quality of an entire presentation. Returns per-slide ' +
      'analysis (scores, issues) plus an overall presentation score. Requires ' +
      'the presentation to be accessible via the API layer.',
    inputSchema: zodToJsonSchema(analyzePresentationSchema),
    handler: (args) =>
      executeTool(
        'vision_analyze_presentation',
        analyzePresentationSchema,
        args,
        async ({ presentationId }) => {
          // This tool serves as a coordination point — the orchestrator should
          // iterate over slides and call vision_analyze_slide for each.
          return successText(JSON.stringify({
            presentationId,
            message: 'Presentation-level analysis requires iterating over all slides. ' +
              'Use the API layer to get_presentation to list all slides, then call ' +
              'vision_analyze_slide for each slide with its screenshot.',
            workflow: [
              '1. Call get_presentation to get slide list',
              '2. For each slide, call live_go_to_slide + live_screenshot',
              '3. Call vision_analyze_slide with each screenshot',
              '4. Aggregate results for overall score',
            ],
          }, null, 2));
        },
      ),
  },

  // ── 3. vision_get_design_score ──────────────────────────────────────────

  {
    name: 'vision_get_design_score',
    description:
      'Get a quick design quality score (0-100) and letter grade (A/B/C/D/F) ' +
      'for a slide or presentation. Faster than a full analysis — returns just ' +
      'the score without detailed issues.',
    inputSchema: zodToJsonSchema(getDesignScoreSchema),
    handler: (args) =>
      executeTool(
        'vision_get_design_score',
        getDesignScoreSchema,
        args,
        async ({ presentationId, slideId }) => {
          // Without live data, we provide a placeholder.
          // In production, this would fetch slide data and run quick scoring.
          return successText(JSON.stringify({
            presentationId,
            slideId: slideId ?? 'all',
            message: 'Design scoring requires slide data or screenshots. ' +
              'Use vision_analyze_slide with a screenshot for accurate scoring.',
            availableScoring: {
              'rule-based': 'Provide slide structural data (via API) for rule-based scoring',
              'pixel-based': 'Provide a screenshot (screenshotBase64) for pixel-level scoring',
            },
          }, null, 2));
        },
      ),
  },

  // ── 4. vision_get_fix_suggestions ───────────────────────────────────────

  {
    name: 'vision_get_fix_suggestions',
    description:
      'Get detailed fix suggestions for design issues found on a specific slide. ' +
      'Returns actionable recommendations including which API calls or manual ' +
      'actions would fix each issue.',
    inputSchema: zodToJsonSchema(getFixSuggestionsSchema),
    handler: (args) =>
      executeTool(
        'vision_get_fix_suggestions',
        getFixSuggestionsSchema,
        args,
        async ({ presentationId, slideId }) => {
          return successText(JSON.stringify({
            presentationId,
            slideId,
            message: 'To get fix suggestions, first run vision_analyze_slide to identify issues, ' +
              'then call vision_auto_fix_slide to generate a concrete fix plan.',
            workflow: [
              '1. Take a screenshot with live_screenshot',
              '2. Analyze with vision_analyze_slide (pass screenshotBase64)',
              '3. Review issues in the analysis result',
              '4. Call vision_auto_fix_slide to generate API fix requests',
            ],
          }, null, 2));
        },
      ),
  },

  // ── 5. vision_auto_fix_slide ────────────────────────────────────────────

  {
    name: 'vision_auto_fix_slide',
    description:
      'Automatically generate and optionally apply design fixes for a specific slide. ' +
      'Analyzes the slide for issues and generates Google Slides API batch update ' +
      'requests to fix alignment, spacing, font hierarchy, and contrast issues. ' +
      'Returns the fix plan including API requests that can be applied via batch_update.',
    inputSchema: zodToJsonSchema(autoFixSlideSchema),
    handler: (args) =>
      executeTool(
        'vision_auto_fix_slide',
        autoFixSlideSchema,
        args,
        async ({ presentationId, slideId, issueTypes }) => {
          // Without a screenshot or real API data, we work with placeholder content.
          // This means the analysis may find few or no issues. We include generic
          // recommendations alongside any rule-based findings.
          const slideContent = createPlaceholderSlideContent(slideId, 0);
          const issues = evaluateAllRules(
            slideContent,
            undefined,
            undefined,
            issueTypes as DesignIssueType[] | undefined,
          );

          const analysis: VisionAnalysis = {
            issues,
            score: calculateDesignScore(issues),
            suggestions: issues.map((i) => getRecommendedFix(i)),
          };

          const fixPlan = generateFixes(
            analysis,
            presentationId,
            slideId,
            issueTypes as DesignIssueType[] | undefined,
          );

          return successText(JSON.stringify({
            presentationId,
            slideId,
            note: fixPlan.apiUpdates.length === 0 && fixPlan.browserActions.length === 0
              ? 'No actual slide data was available for analysis. The results below are based on placeholder content. Provide a screenshot via vision_analyze_slide for accurate results.'
              : undefined,
            fixPlan: {
              issuesAddressed: fixPlan.issues.length,
              apiUpdates: fixPlan.apiUpdates,
              apiUpdateCount: fixPlan.apiUpdates.length,
              browserActions: fixPlan.browserActions.map((a) => ({
                type: a.type,
                description: a.description,
              })),
              browserActionCount: fixPlan.browserActions.length,
              description: fixPlan.description,
            },
            genericRecommendations: fixPlan.apiUpdates.length === 0 ? [
              'Ensure text elements use consistent fonts (max 2 families)',
              'Check alignment — all elements should snap to a layout grid',
              'Verify color contrast ratio >= 4.5:1 for all text',
              'Maintain consistent spacing between elements (e.g. 12-24pt)',
              'Use visual hierarchy: title (28-36pt) > subtitle (20-24pt) > body (16-20pt)',
            ] : undefined,
            instructions: fixPlan.apiUpdates.length > 0
              ? 'Apply the apiUpdates array via the batch_update tool to fix these issues.'
              : 'No automatic API fixes available. For accurate analysis, capture a screenshot with live_screenshot and pass it to vision_analyze_slide.',
          }, null, 2));
        },
      ),
  },

  // ── 6. vision_auto_fix_presentation ─────────────────────────────────────

  {
    name: 'vision_auto_fix_presentation',
    description:
      'Automatically analyze and fix design issues across all slides in a ' +
      'presentation. Returns a summary of fixes applied per slide.',
    inputSchema: zodToJsonSchema(autoFixPresentationSchema),
    handler: (args) =>
      executeTool(
        'vision_auto_fix_presentation',
        autoFixPresentationSchema,
        args,
        async ({ presentationId, issueTypes }) => {
          return successText(JSON.stringify({
            presentationId,
            message: 'Presentation-wide auto-fix requires iterating over all slides. ' +
              'Use the following workflow:',
            workflow: [
              '1. Call get_presentation to list all slides',
              '2. For each slide, call vision_auto_fix_slide',
              '3. Apply each slide fix plan via batch_update',
              '4. Re-analyze to verify improvements',
            ],
            issueTypes: issueTypes ?? 'all',
          }, null, 2));
        },
      ),
  },

  // ── 7. vision_apply_theme ───────────────────────────────────────────────

  {
    name: 'vision_apply_theme',
    description:
      'Apply a professional theme to the presentation. Choose from 5 preset ' +
      'themes: "Corporate Blue", "Dark Professional", "Warm Minimal", ' +
      '"Nature Fresh", "Slate Modern" — or provide a custom theme definition. ' +
      'Returns Google Slides API batch update requests to apply the theme.',
    inputSchema: zodToJsonSchema(applyThemeSchema),
    handler: (args) =>
      executeTool(
        'vision_apply_theme',
        applyThemeSchema,
        args,
        async ({ presentationId, themeName, customTheme, slideIds }) => {
          let theme: ThemeDefinition | undefined;

          if (themeName) {
            theme = getTheme(themeName);
            if (!theme) {
              const available = listThemes().map((t) => t.name).join(', ');
              return errorResult(
                `Theme "${themeName}" not found. Available themes: ${available}`,
              );
            }
          } else if (customTheme) {
            theme = {
              id: 'custom',
              name: customTheme.name,
              description: 'Custom theme',
              colors: customTheme.colors,
              fonts: {
                titleFamily: customTheme.fonts.titleFamily,
                bodyFamily: customTheme.fonts.bodyFamily,
                titleSize: customTheme.fonts.titleSize ?? 36,
                subtitleSize: customTheme.fonts.subtitleSize ?? 24,
                bodySize: customTheme.fonts.bodySize ?? 18,
                lineSpacing: customTheme.fonts.lineSpacing ?? 1.15,
              },
            };
          } else {
            const available = listThemes().map((t) => `"${t.name}"`).join(', ');
            return errorResult(
              `Provide either themeName or customTheme. Available presets: ${available}`,
            );
          }

          const effectiveSlideIds = slideIds ?? [];
          const requests = applyTheme(presentationId, theme, effectiveSlideIds);
          const preview = generateThemePreview(theme);

          return successText(JSON.stringify({
            presentationId,
            theme: {
              id: theme.id,
              name: theme.name,
              description: theme.description,
            },
            requests,
            requestCount: requests.length,
            preview,
            instructions: requests.length > 0
              ? 'Apply the requests array via the batch_update tool to set the theme.'
              : 'Provide slideIds to generate theme application requests for specific slides.',
          }, null, 2));
        },
      ),
  },

  // ── 8. vision_apply_color_scheme ────────────────────────────────────────

  {
    name: 'vision_apply_color_scheme',
    description:
      'Apply a custom color scheme to slides. Sets background colors ' +
      'and generates requests for text color updates. Provide hex color ' +
      'values for primary, secondary, accent, and background colors.',
    inputSchema: zodToJsonSchema(applyColorSchemeSchema),
    handler: (args) =>
      executeTool(
        'vision_apply_color_scheme',
        applyColorSchemeSchema,
        args,
        async ({ presentationId, primaryColor, secondaryColor, accentColor, backgroundColor, slideIds }) => {
          const effectiveSlideIds = slideIds ?? [];
          const requests = applyColorScheme(
            presentationId,
            { primaryColor, secondaryColor, accentColor, backgroundColor },
            effectiveSlideIds,
          );

          return successText(JSON.stringify({
            presentationId,
            colorScheme: {
              primaryColor,
              secondaryColor,
              accentColor,
              backgroundColor,
            },
            requests,
            requestCount: requests.length,
            instructions: requests.length > 0
              ? 'Apply the requests array via the batch_update tool.'
              : 'Provide slideIds to generate color scheme requests for specific slides.',
          }, null, 2));
        },
      ),
  },

  // ── 9. vision_apply_font_scheme ─────────────────────────────────────────

  {
    name: 'vision_apply_font_scheme',
    description:
      'Apply a custom font scheme to slides. Sets the title and body ' +
      'font families across specified elements. Requires element IDs — ' +
      'first call get_slide to discover text element IDs on each slide, ' +
      'then pass them as elementIds. Without element IDs, returns an empty ' +
      'request list with instructions on how to discover them.',
    inputSchema: zodToJsonSchema(applyFontSchemeSchema),
    handler: (args) =>
      executeTool(
        'vision_apply_font_scheme',
        applyFontSchemeSchema,
        args,
        async ({ presentationId, titleFont, bodyFont, slideIds, elementIds }) => {
          const effectiveSlideIds = slideIds ?? [];
          const requests = applyFontScheme(
            presentationId,
            titleFont,
            bodyFont,
            effectiveSlideIds,
            elementIds,
          );

          return successText(JSON.stringify({
            presentationId,
            fontScheme: { titleFont, bodyFont },
            requests,
            requestCount: requests.length,
            instructions:
              'Font scheme changes require element-level targeting. ' +
              'Use get_slide to discover text element IDs, then apply ' +
              'updateTextStyle requests via batch_update for each element.',
          }, null, 2));
        },
      ),
  },

  // ── 10. vision_compare_slides ───────────────────────────────────────────

  {
    name: 'vision_compare_slides',
    description:
      'Compare two slides for design consistency. Analyzes color palette overlap, ' +
      'visual balance, and layout differences. Useful for ensuring a cohesive look ' +
      'across a presentation. Provide screenshots of both slides for best results.',
    inputSchema: zodToJsonSchema(compareSlidesSchema),
    handler: (args) =>
      executeTool(
        'vision_compare_slides',
        compareSlidesSchema,
        args,
        async ({ presentationId, slideId1, slideId2, screenshot1Base64, screenshot2Base64 }) => {
          if (screenshot1Base64 && screenshot2Base64) {
            const result = await compareSlideConsistency(
              screenshot1Base64,
              screenshot2Base64,
            );

            return successText(JSON.stringify({
              presentationId,
              slideId1,
              slideId2,
              consistent: result.consistent,
              consistencyScore: result.score,
              grade: scoreToGrade(result.score),
              differences: result.differences,
              summary: result.consistent
                ? 'Slides are visually consistent.'
                : `Slides have ${result.differences.length} inconsistencies.`,
            }, null, 2));
          }

          return successText(JSON.stringify({
            presentationId,
            slideId1,
            slideId2,
            message: 'Provide screenshot1Base64 and screenshot2Base64 for pixel-level consistency comparison.',
            workflow: [
              '1. Navigate to slide 1 with live_go_to_slide, take live_screenshot',
              '2. Navigate to slide 2 with live_go_to_slide, take live_screenshot',
              '3. Call vision_compare_slides with both screenshots',
            ],
          }, null, 2));
        },
      ),
  },

  // ── 11. vision_extract_colors ───────────────────────────────────────────

  {
    name: 'vision_extract_colors',
    description:
      'Extract dominant colors from a slide screenshot. Returns an array of ' +
      'hex colors with their approximate percentage of the slide area. ' +
      'Useful for understanding the current color palette before applying themes.',
    inputSchema: zodToJsonSchema(extractColorsSchema),
    handler: (args) =>
      executeTool(
        'vision_extract_colors',
        extractColorsSchema,
        args,
        async ({ presentationId, slideId, screenshotBase64, maxColors }) => {
          if (screenshotBase64) {
            const colors = await extractDominantColors(
              screenshotBase64,
              maxColors ?? 8,
            );

            return successText(JSON.stringify({
              presentationId,
              slideId,
              colorCount: colors.length,
              colors: colors.map((c) => ({
                hex: c.hex,
                percentage: Math.round(c.percentage * 1000) / 10,
                rgb: { r: c.r, g: c.g, b: c.b },
              })),
              dominantColor: colors.length > 0 ? colors[0]!.hex : null,
              palette: colors.slice(0, 4).map((c) => c.hex),
            }, null, 2));
          }

          return successText(JSON.stringify({
            presentationId,
            slideId,
            message: 'Provide screenshotBase64 to extract dominant colors from the slide.',
            workflow: [
              '1. Navigate to the slide with live_go_to_slide',
              '2. Take a screenshot with live_screenshot',
              '3. Call vision_extract_colors with the screenshot base64 data',
            ],
          }, null, 2));
        },
      ),
  },
];

// ─────────────────────────────────────────────────────────────────────────────
// Lookup Utilities
// ─────────────────────────────────────────────────────────────────────────────

/**
 * Map of tool name -> tool definition for O(1) lookups.
 */
export const visionToolMap = new Map<string, VisionToolDefinition>(
  visionTools.map((tool) => [tool.name, tool]),
);

/**
 * Get a vision tool definition by name.
 *
 * @param name - The tool name (e.g. "vision_analyze_slide").
 * @returns The tool definition, or `undefined` if not found.
 */
export function getVisionTool(
  name: string,
): VisionToolDefinition | undefined {
  return visionToolMap.get(name);
}

/**
 * Check whether a given tool name belongs to the vision layer.
 *
 * @param name - The tool name to check.
 * @returns `true` if the tool is a vision-layer tool.
 */
export function isVisionTool(name: string): boolean {
  return visionToolMap.has(name);
}

/**
 * Execute a vision tool by name.
 *
 * @param name - The tool name.
 * @param args - The raw input arguments.
 * @returns A ToolResult.
 * @throws {ToolExecutionError} If the tool is not found.
 */
export async function executeVisionTool(
  name: string,
  args: unknown,
): Promise<ToolResult> {
  const tool = visionToolMap.get(name);
  if (!tool) {
    throw new ToolExecutionError(
      `Unknown vision tool: ${name}`,
      name,
      MCPLayer.VISION,
    );
  }

  log.info('Executing vision tool', { name });
  return tool.handler(args);
}

/**
 * Get all vision tool definitions in the format expected by
 * `server.setRequestHandler(ListToolsRequestSchema, ...)`.
 *
 * @returns Array of tool metadata objects (name, description, inputSchema).
 */
export function listVisionTools(): Array<{
  name: string;
  description: string;
  inputSchema: Record<string, unknown>;
}> {
  return visionTools.map(({ name, description, inputSchema }) => ({
    name,
    description,
    inputSchema,
  }));
}
