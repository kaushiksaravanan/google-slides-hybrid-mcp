/**
 * @module vision/auto-fixer
 * @description Automatic design fix applier for Google Slides.
 *
 * Generates concrete fix plans (Google Slides API batch update requests
 * and/or browser automation actions) from {@link VisionAnalysis} results.
 * Fix plans can be applied directly via an API client or browser controller.
 */

import type {
  VisionAnalysis,
  DesignIssue,
  DesignIssueType,
  BatchUpdateRequest,
} from '../shared/types.js';
import {
  EMU_PER_POINT,
  DEFAULT_PAGE_WIDTH,
  DEFAULT_PAGE_HEIGHT,
  DEFAULT_MARGIN_LEFT,
  DEFAULT_MARGIN_RIGHT,
  DEFAULT_MARGIN_TOP,
  DEFAULT_MARGIN_BOTTOM,
  DEFAULT_TITLE_FONT_SIZE,
  DEFAULT_BODY_FONT_SIZE,
  CONTENT_AREA,
} from '../shared/constants.js';
import { createLogger } from '../shared/logger.js';
import { hexToGoogleRgb } from '../shared/validators.js';

const log = createLogger('vision.auto-fixer');

// ─────────────────────────────────────────────────────────────────────────────
// Types
// ─────────────────────────────────────────────────────────────────────────────

/** A single fix action that can be applied via API or browser. */
export interface FixAction {
  /** Whether the fix is applied via Google Slides API or browser automation. */
  type: 'api_update' | 'browser_action';
  /** Human-readable description of what this action does. */
  description: string;
  /** The payload — a batch update request for API, or a command descriptor for browser. */
  payload: unknown;
}

/** A complete fix plan for a single slide. */
export interface FixPlan {
  /** The slide page object ID being fixed. */
  slideId: string;
  /** The design issues that this plan addresses. */
  issues: DesignIssue[];
  /** Google Slides API batchUpdate requests to apply. */
  apiUpdates: BatchUpdateRequest[];
  /** Browser actions to execute for fixes that require UI interaction. */
  browserActions: FixAction[];
  /** Human-readable summary of the fix plan. */
  description: string;
}

// ─────────────────────────────────────────────────────────────────────────────
// EMU Conversion Helpers
// ─────────────────────────────────────────────────────────────────────────────

/**
 * Convert points to EMU (English Metric Units).
 * 1 pt = 12700 EMU.
 */
function ptToEmu(pt: number): number {
  return Math.round(pt * EMU_PER_POINT);
}

// ─────────────────────────────────────────────────────────────────────────────
// Individual Fix Generators
// ─────────────────────────────────────────────────────────────────────────────

/**
 * Generate API requests to fix alignment issues.
 *
 * Snaps the affected element's position to the nearest standard alignment
 * point (left margin or center of the content area).
 *
 * @param issue - The alignment design issue.
 * @param slideId - The page object ID of the slide.
 * @returns Array of Google Slides API batch update requests.
 */
export function fixAlignment(
  issue: DesignIssue,
  slideId: string,
): BatchUpdateRequest[] {
  const requests: BatchUpdateRequest[] = [];

  if (!issue.element) {
    log.debug('Alignment fix skipped: no element ID', { slideId });
    return requests;
  }

  // Snap element left edge to the default left margin
  const targetX = ptToEmu(DEFAULT_MARGIN_LEFT);

  requests.push({
    updatePageElementTransform: {
      objectId: issue.element,
      applyMode: 'ABSOLUTE',
      transform: {
        scaleX: 1,
        scaleY: 1,
        shearX: 0,
        shearY: 0,
        translateX: targetX,
        unit: 'EMU',
      },
      fields: 'translateX',
    },
  });

  log.debug('Generated alignment fix', {
    elementId: issue.element,
    targetX,
    slideId,
  });

  return requests;
}

/**
 * Generate API requests to fix spacing issues.
 *
 * Adjusts element positions to normalize margins and inter-element spacing.
 *
 * @param issue - The spacing design issue.
 * @param slideId - The page object ID of the slide.
 * @returns Array of Google Slides API batch update requests.
 */
export function fixSpacing(
  issue: DesignIssue,
  slideId: string,
): BatchUpdateRequest[] {
  const requests: BatchUpdateRequest[] = [];

  if (!issue.element) {
    log.debug('Spacing fix skipped: no element ID', { slideId });
    return requests;
  }

  // Determine if the issue is about an element too close to an edge.
  // If so, move it to the recommended margin.
  const description = issue.description.toLowerCase();
  let targetTranslateX: number | undefined;
  let targetTranslateY: number | undefined;

  if (description.includes('left edge') || description.includes('left margin')) {
    targetTranslateX = ptToEmu(DEFAULT_MARGIN_LEFT);
  }
  if (description.includes('top edge') || description.includes('top margin')) {
    targetTranslateY = ptToEmu(DEFAULT_MARGIN_TOP);
  }
  if (description.includes('right edge') || description.includes('right margin')) {
    // For right margin issues, we move element left — needs element width context.
    // Use a safe default: place at content area right edge minus a standard element width.
    targetTranslateX = ptToEmu(DEFAULT_PAGE_WIDTH - DEFAULT_MARGIN_RIGHT - 200);
  }
  if (description.includes('bottom edge') || description.includes('bottom margin')) {
    targetTranslateY = ptToEmu(DEFAULT_PAGE_HEIGHT - DEFAULT_MARGIN_BOTTOM - 100);
  }

  const fields: string[] = [];
  const transform: Record<string, unknown> = {
    scaleX: 1,
    scaleY: 1,
    shearX: 0,
    shearY: 0,
    unit: 'EMU',
  };

  if (targetTranslateX !== undefined) {
    transform['translateX'] = targetTranslateX;
    fields.push('translateX');
  }
  if (targetTranslateY !== undefined) {
    transform['translateY'] = targetTranslateY;
    fields.push('translateY');
  }

  if (fields.length > 0) {
    requests.push({
      updatePageElementTransform: {
        objectId: issue.element,
        applyMode: 'ABSOLUTE',
        transform,
        fields: fields.join(','),
      },
    });
  }

  log.debug('Generated spacing fix', {
    elementId: issue.element,
    fields,
    slideId,
  });

  return requests;
}

/**
 * Generate API requests to fix font hierarchy issues.
 *
 * Adjusts font sizes to establish a clear visual hierarchy:
 * title at DEFAULT_TITLE_FONT_SIZE, body at DEFAULT_BODY_FONT_SIZE.
 *
 * @param issue - The hierarchy design issue.
 * @param slideId - The page object ID of the slide.
 * @returns Array of Google Slides API batch update requests.
 */
export function fixFontHierarchy(
  issue: DesignIssue,
  slideId: string,
): BatchUpdateRequest[] {
  const requests: BatchUpdateRequest[] = [];

  if (!issue.element) {
    // Without a specific element, generate a generic fix for the first text element.
    // The caller should apply this with known element IDs.
    log.debug('Font hierarchy fix: no specific element, generating advisory', { slideId });
    return requests;
  }

  // Determine whether the issue suggests increasing title or reducing body.
  const description = issue.description.toLowerCase();
  let targetFontSize: number;

  if (description.includes('title') || description.includes('heading') || description.includes('largest')) {
    targetFontSize = DEFAULT_TITLE_FONT_SIZE;
  } else {
    targetFontSize = DEFAULT_BODY_FONT_SIZE;
  }

  requests.push({
    updateTextStyle: {
      objectId: issue.element,
      textRange: {
        type: 'ALL',
      },
      style: {
        fontSize: {
          magnitude: targetFontSize,
          unit: 'PT',
        },
      },
      fields: 'fontSize',
    },
  });

  log.debug('Generated font hierarchy fix', {
    elementId: issue.element,
    targetFontSize,
    slideId,
  });

  return requests;
}

/**
 * Generate API requests to fix contrast issues.
 *
 * Adjusts text color or background color to achieve WCAG AA compliance.
 * Strategy: if text is light on a light background, darken the text;
 * if text is dark on a dark background, lighten the text.
 *
 * @param issue - The contrast design issue.
 * @param slideId - The page object ID of the slide.
 * @returns Array of Google Slides API batch update requests.
 */
export function fixContrast(
  issue: DesignIssue,
  slideId: string,
): BatchUpdateRequest[] {
  const requests: BatchUpdateRequest[] = [];

  if (!issue.element) {
    log.debug('Contrast fix skipped: no element ID', { slideId });
    return requests;
  }

  // Parse suggested colors from the fix description or use safe defaults.
  // Default strategy: set text to near-black for light backgrounds,
  // or near-white for dark backgrounds.
  const description = issue.description.toLowerCase();

  // Try to extract the background color from the issue description.
  const bgMatch = description.match(/background\s+#([0-9a-f]{6})/i);
  let textColor: string;

  if (bgMatch) {
    const bgHex = `#${bgMatch[1]}`;
    const bgRgb = hexToGoogleRgb(bgHex);
    // Calculate perceived brightness (simple formula)
    const brightness = bgRgb.red * 0.299 + bgRgb.green * 0.587 + bgRgb.blue * 0.114;
    // If background is light (brightness > 0.5), use dark text; otherwise use light text.
    textColor = brightness > 0.5 ? '#1A1A1A' : '#F5F5F5';
  } else {
    // Default: use near-black text (safe for most light backgrounds)
    textColor = '#1A1A1A';
  }

  const rgbColor = hexToGoogleRgb(textColor);

  requests.push({
    updateTextStyle: {
      objectId: issue.element,
      textRange: {
        type: 'ALL',
      },
      style: {
        foregroundColor: {
          opaqueColor: {
            rgbColor: {
              red: rgbColor.red,
              green: rgbColor.green,
              blue: rgbColor.blue,
            },
          },
        },
      },
      fields: 'foregroundColor',
    },
  });

  log.debug('Generated contrast fix', {
    elementId: issue.element,
    textColor,
    slideId,
  });

  return requests;
}

/**
 * Generate a descriptive suggestion for text density issues.
 *
 * Text density cannot be fixed automatically via API — it requires
 * content restructuring (splitting the slide). Returns an advisory
 * FixAction describing what the user should do.
 *
 * @param issue - The text density / hierarchy design issue.
 * @returns A browser-action FixAction with advisory description.
 */
export function fixTextDensity(issue: DesignIssue): FixAction {
  const suggestion = issue.fix
    ?? 'Consider splitting this slide into multiple slides, moving details to speaker notes, or summarizing content into bullet points.';

  return {
    type: 'browser_action',
    description: `[Manual action required] ${suggestion}`,
    payload: {
      action: 'advisory',
      message: suggestion,
      issueDescription: issue.description,
    },
  };
}

/**
 * Generate API requests to fix visual balance issues.
 *
 * Attempts to redistribute element positions by centering them within
 * the content area. This is a heuristic — complex layout changes may
 * need manual intervention.
 *
 * @param issue - The balance design issue.
 * @param slideId - The page object ID of the slide.
 * @returns Array of Google Slides API batch update requests.
 */
export function fixBalance(
  issue: DesignIssue,
  slideId: string,
): BatchUpdateRequest[] {
  const requests: BatchUpdateRequest[] = [];

  if (!issue.element) {
    log.debug('Balance fix skipped: no element ID', { slideId });
    return requests;
  }

  // Strategy: move the element to the horizontal center of the content area.
  const contentCenterX = CONTENT_AREA.x + CONTENT_AREA.width / 2;
  // Use a reasonable default element width for centering calculation.
  const estimatedElementWidth = 300;
  const targetX = contentCenterX - estimatedElementWidth / 2;

  requests.push({
    updatePageElementTransform: {
      objectId: issue.element,
      applyMode: 'ABSOLUTE',
      transform: {
        scaleX: 1,
        scaleY: 1,
        shearX: 0,
        shearY: 0,
        translateX: ptToEmu(targetX),
        unit: 'EMU',
      },
      fields: 'translateX',
    },
  });

  log.debug('Generated balance fix', {
    elementId: issue.element,
    targetX,
    slideId,
  });

  return requests;
}

// ─────────────────────────────────────────────────────────────────────────────
// Fix Plan Generation
// ─────────────────────────────────────────────────────────────────────────────

/** Map from issue type to the appropriate fix generator. */
const fixGenerators: Record<
  DesignIssueType,
  (issue: DesignIssue, slideId: string) => { apiUpdates: BatchUpdateRequest[]; browserActions: FixAction[] }
> = {
  alignment: (issue, slideId) => ({
    apiUpdates: fixAlignment(issue, slideId),
    browserActions: [],
  }),
  spacing: (issue, slideId) => ({
    apiUpdates: fixSpacing(issue, slideId),
    browserActions: [],
  }),
  font: (issue, slideId) => ({
    apiUpdates: fixFontHierarchy(issue, slideId),
    browserActions: [],
  }),
  hierarchy: (issue, slideId) => {
    // Text density issues get advisory browser actions; other hierarchy issues get API fixes.
    if (issue.description.toLowerCase().includes('words') || issue.description.toLowerCase().includes('text density')) {
      return {
        apiUpdates: [],
        browserActions: [fixTextDensity(issue)],
      };
    }
    return {
      apiUpdates: fixFontHierarchy(issue, slideId),
      browserActions: [],
    };
  },
  contrast: (issue, slideId) => ({
    apiUpdates: fixContrast(issue, slideId),
    browserActions: [],
  }),
  color: (issue, _slideId) => ({
    apiUpdates: [],
    browserActions: [{
      type: 'browser_action',
      description: `[Manual action required] ${issue.fix ?? 'Simplify the color palette to 3-4 complementary colors.'}`,
      payload: {
        action: 'advisory',
        message: issue.fix ?? 'Reduce the number of distinct colors used on this slide.',
        issueDescription: issue.description,
      },
    }],
  }),
  balance: (issue, slideId) => ({
    apiUpdates: fixBalance(issue, slideId),
    browserActions: [],
  }),
};

/**
 * Generate a comprehensive fix plan for all design issues found in a
 * vision analysis result.
 *
 * @param analysis - The VisionAnalysis result from the analyzer.
 * @param presentationId - The Google Slides presentation ID.
 * @param slideId - The page object ID of the slide being fixed.
 * @param issueTypes - Optional filter: only generate fixes for specific issue types.
 * @returns A FixPlan with all API updates and browser actions.
 */
export function generateFixes(
  analysis: VisionAnalysis,
  presentationId: string,
  slideId: string,
  issueTypes?: DesignIssueType[],
): FixPlan {
  log.info('Generating fix plan', {
    presentationId,
    slideId,
    totalIssues: analysis.issues.length,
    filterTypes: issueTypes,
  });

  const filteredIssues = issueTypes
    ? analysis.issues.filter((issue) => issueTypes.includes(issue.type))
    : analysis.issues;

  const allApiUpdates: BatchUpdateRequest[] = [];
  const allBrowserActions: FixAction[] = [];
  const descriptions: string[] = [];

  for (const issue of filteredIssues) {
    const generator = fixGenerators[issue.type];
    if (!generator) {
      log.warn('No fix generator for issue type', { type: issue.type });
      continue;
    }

    try {
      const { apiUpdates, browserActions } = generator(issue, slideId);
      allApiUpdates.push(...apiUpdates);
      allBrowserActions.push(...browserActions);

      if (apiUpdates.length > 0) {
        descriptions.push(`[API] Fix ${issue.type}: ${issue.description}`);
      }
      if (browserActions.length > 0) {
        descriptions.push(`[Browser/Manual] ${issue.type}: ${browserActions[0]?.description ?? issue.description}`);
      }
    } catch (error) {
      log.warn('Failed to generate fix for issue', {
        type: issue.type,
        error: String(error),
      });
    }
  }

  const plan: FixPlan = {
    slideId,
    issues: filteredIssues,
    apiUpdates: allApiUpdates,
    browserActions: allBrowserActions,
    description: descriptions.length > 0
      ? `Fix plan for slide ${slideId} (${filteredIssues.length} issues):\n${descriptions.map((d) => `  - ${d}`).join('\n')}`
      : `No actionable fixes for slide ${slideId}.`,
  };

  log.info('Fix plan generated', {
    slideId,
    apiUpdateCount: allApiUpdates.length,
    browserActionCount: allBrowserActions.length,
    issuesAddressed: filteredIssues.length,
  });

  return plan;
}

// ─────────────────────────────────────────────────────────────────────────────
// Fix Plan Execution
// ─────────────────────────────────────────────────────────────────────────────

/**
 * Interface for an API client that can execute batch updates.
 * Matches the shape of the API client's batchUpdate method.
 */
export interface ApiClient {
  batchUpdate(
    presentationId: string,
    requests: BatchUpdateRequest[],
  ): Promise<unknown>;
}

/**
 * Interface for a browser controller that can execute actions.
 * Matches the shape of browser automation commands.
 */
export interface BrowserController {
  executeAction(action: FixAction): Promise<void>;
}

/**
 * Apply a fix plan by executing API updates and/or browser actions.
 *
 * @param fixPlan - The fix plan to apply.
 * @param presentationId - The presentation ID for API calls.
 * @param apiClient - Optional API client for executing batch updates.
 * @param browserController - Optional browser controller for browser actions.
 * @returns Summary of what was applied.
 */
export async function applyFixPlan(
  fixPlan: FixPlan,
  presentationId: string,
  apiClient?: ApiClient,
  browserController?: BrowserController,
): Promise<{
  apiUpdatesApplied: number;
  browserActionsApplied: number;
  advisoryActions: number;
  errors: string[];
}> {
  const result = {
    apiUpdatesApplied: 0,
    browserActionsApplied: 0,
    advisoryActions: 0,
    errors: [] as string[],
  };

  log.info('Applying fix plan', {
    slideId: fixPlan.slideId,
    presentationId,
    apiUpdateCount: fixPlan.apiUpdates.length,
    browserActionCount: fixPlan.browserActions.length,
    hasApiClient: !!apiClient,
    hasBrowserController: !!browserController,
  });

  // Apply API updates
  if (fixPlan.apiUpdates.length > 0) {
    if (apiClient) {
      try {
        await apiClient.batchUpdate(presentationId, fixPlan.apiUpdates);
        result.apiUpdatesApplied = fixPlan.apiUpdates.length;
        log.info('API updates applied successfully', {
          count: fixPlan.apiUpdates.length,
        });
      } catch (error) {
        const message = `Failed to apply API updates: ${error instanceof Error ? error.message : String(error)}`;
        result.errors.push(message);
        log.error('API update failed', { error: message });
      }
    } else {
      log.warn('API updates generated but no API client provided — returning requests only');
      result.apiUpdatesApplied = 0;
    }
  }

  // Apply browser actions
  for (const action of fixPlan.browserActions) {
    if (action.type === 'browser_action') {
      const actionPayload = action.payload as Record<string, unknown>;
      if (actionPayload?.action === 'advisory') {
        result.advisoryActions++;
        log.info('Advisory action (manual)', { description: action.description });
        continue;
      }

      if (browserController) {
        try {
          await browserController.executeAction(action);
          result.browserActionsApplied++;
        } catch (error) {
          const message = `Failed to apply browser action: ${error instanceof Error ? error.message : String(error)}`;
          result.errors.push(message);
          log.error('Browser action failed', { error: message });
        }
      } else {
        log.warn('Browser action generated but no browser controller provided', {
          description: action.description,
        });
      }
    }
  }

  log.info('Fix plan application complete', result);

  return result;
}
