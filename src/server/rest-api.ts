/**
 * @module server/rest-api
 * @description RESTful API endpoints for non-MCP clients.
 *
 * Provides a standard REST interface for presentation management,
 * template operations, vision/analysis, and markdown conversion.
 * Each endpoint validates input with Zod, calls the orchestrator or
 * API layer, and returns consistent JSON responses.
 *
 * All routes are mounted under `/api/v1/`.
 */

import { Router } from 'express';
import type { Request, Response, NextFunction } from 'express';
import { z } from 'zod';
import { createLogger } from '../shared/logger.js';
import { generateOpenApiSpec } from './openapi.js';
import {
  presentationIdSchema,
  slideIdSchema,
  markdownContentSchema,
} from '../shared/validators.js';
import type { HybridOrchestrator } from '../orchestrator/orchestrator.js';
import { metrics } from './health.js';

const log = createLogger('server.rest-api');

// ─────────────────────────────────────────────────────────────────────────────
// Param Helper
// ─────────────────────────────────────────────────────────────────────────────

/**
 * Safely extract a route parameter as a string.
 * Express 5 types allow `string | string[]` for params; this normalises to a single string.
 */
function param(req: Request, name: string): string {
  const value = req.params[name];
  return Array.isArray(value) ? value[0] ?? '' : (value ?? '');
}

// ─────────────────────────────────────────────────────────────────────────────
// Standard Response Helpers
// ─────────────────────────────────────────────────────────────────────────────

/** Standard JSON response envelope. */
interface ApiResponse<T = unknown> {
  success: boolean;
  data?: T;
  error?: { code: string; message: string; details?: unknown };
  meta?: Record<string, unknown>;
}

function success<T>(res: Response, data: T, status: number = 200, meta?: Record<string, unknown>): void {
  const body: ApiResponse<T> = { success: true, data };
  if (meta) body.meta = meta;
  res.status(status).json(body);
}

function error(res: Response, status: number, code: string, message: string, details?: unknown): void {
  const body: ApiResponse = {
    success: false,
    error: { code, message, ...(details !== undefined ? { details } : {}) },
  };
  res.status(status).json(body);
}

// ─────────────────────────────────────────────────────────────────────────────
// Input Schemas
// ─────────────────────────────────────────────────────────────────────────────

const createPresentationBody = z.object({
  title: z.string().min(1).max(500),
  markdown: z.string().optional(),
  theme: z.string().optional(),
  polish: z.boolean().optional(),
});

const updatePresentationBody = z.object({
  title: z.string().min(1).max(500).optional(),
  markdown: z.string().optional(),
});

const addSlideBody = z.object({
  layoutId: z.string().optional(),
  insertionIndex: z.number().int().min(0).optional(),
  content: z.object({
    title: z.string().optional(),
    body: z.string().optional(),
  }).optional(),
});

const duplicateSlideBody = z.object({
  insertionIndex: z.number().int().min(0).optional(),
});

const shareBody = z.object({
  role: z.enum(['reader', 'writer', 'commenter']).optional(),
});

const applyTemplateBody = z.object({
  presentationId: presentationIdSchema,
});

const analyzeBody = z.object({
  slideIndex: z.number().int().min(0).optional(),
  checks: z.array(z.string()).optional(),
});

const polishBody = z.object({
  maxIterations: z.number().int().min(1).max(10).optional(),
});

const themeBody = z.object({
  theme: z.string().min(1),
});

const markdownPreviewBody = z.object({
  markdown: markdownContentSchema,
  title: z.string().min(1).max(500).optional(),
});

const markdownCreateBody = z.object({
  title: z.string().min(1).max(500),
  markdown: markdownContentSchema,
  theme: z.string().optional(),
  polish: z.boolean().optional(),
});

// ─────────────────────────────────────────────────────────────────────────────
// Validation Middleware
// ─────────────────────────────────────────────────────────────────────────────

/**
 * Create an Express middleware that validates the request body against a Zod schema.
 * On success, replaces req.body with the validated data.
 * On failure, returns a 400 response with validation errors.
 */
function validateBody<T>(schema: z.ZodType<T>): (req: Request, res: Response, next: NextFunction) => void {
  return (req: Request, res: Response, next: NextFunction) => {
    const result = schema.safeParse(req.body);
    if (!result.success) {
      const details = result.error.issues.map((issue) => ({
        path: issue.path.join('.'),
        message: issue.message,
      }));
      error(res, 400, 'VALIDATION_ERROR', 'Invalid request body', details);
      return;
    }
    req.body = result.data;
    next();
  };
}

/**
 * Validate a route parameter against a Zod schema.
 */
function validateParam(paramName: string, schema: z.ZodType<string>): (req: Request, res: Response, next: NextFunction) => void {
  return (req: Request, res: Response, next: NextFunction) => {
    const raw = req.params[paramName];
    const value = Array.isArray(raw) ? raw[0] : raw;
    const result = schema.safeParse(value);
    if (!result.success) {
      error(res, 400, 'INVALID_PARAMETER', `Invalid ${paramName}: ${result.error.issues[0]?.message ?? 'invalid'}`);
      return;
    }
    next();
  };
}

// ─────────────────────────────────────────────────────────────────────────────
// Safe JSON Parser
// ─────────────────────────────────────────────────────────────────────────────

/**
 * Safely parse a JSON string. Returns the raw string if parsing fails,
 * avoiding uncaught exceptions on malformed tool result content.
 */
function safeJsonParse(text: string): unknown {
  try {
    return JSON.parse(text);
  } catch {
    return text;
  }
}

// ─────────────────────────────────────────────────────────────────────────────
// Async Handler Wrapper
// ─────────────────────────────────────────────────────────────────────────────

/**
 * Wrap an async route handler to catch errors and pass them to Express error handling.
 */
function asyncHandler(fn: (req: Request, res: Response, next: NextFunction) => Promise<void>): (req: Request, res: Response, next: NextFunction) => void {
  return (req: Request, res: Response, next: NextFunction) => {
    fn(req, res, next).catch(next);
  };
}

// ─────────────────────────────────────────────────────────────────────────────
// Router Factory
// ─────────────────────────────────────────────────────────────────────────────

/**
 * Create the REST API router with all presentation, template, vision,
 * and markdown endpoints.
 *
 * @param orchestrator - The hybrid orchestrator for executing operations.
 * @returns An Express Router mounted at /api/v1.
 */
export function createRestApiRouter(orchestrator: HybridOrchestrator): Router {
  const router = Router();

  // Lazy-import API client methods (they're always available if orchestrator is).
  // We use dynamic imports within handlers to avoid circular dependency issues
  // and to ensure the API layer is initialized before use.

  // =====================================================================
  // PRESENTATIONS
  // =====================================================================

  // POST /api/v1/presentations — Create a presentation
  router.post(
    '/presentations',
    validateBody(createPresentationBody),
    asyncHandler(async (req: Request, res: Response) => {
      const { title, markdown, theme, polish } = req.body as z.infer<typeof createPresentationBody>;

      log.info('REST: Create presentation', { title, hasMarkdown: !!markdown, theme, polish });

      if (markdown) {
        // Create from markdown (potentially with theme + polish)
        const result = await orchestrator.createPresentationFromMarkdown(title, markdown, {
          polish,
          themeName: theme,
        });
        metrics.incPresentationsCreated();
        success(res, result, 201);
      } else {
        // Create blank presentation via orchestrator tool
        const toolResult = await orchestrator.executeToolAuto('slides_create_presentation', { title });
        const text = toolResult.content[0]?.text ?? '{}';
        metrics.incPresentationsCreated();
        success(res, safeJsonParse(text), 201);
      }
    }),
  );

  // GET /api/v1/presentations/:id — Get presentation details
  router.get(
    '/presentations/:id',
    validateParam('id', presentationIdSchema),
    asyncHandler(async (req: Request, res: Response) => {
      const id = param(req, 'id');
      log.info('REST: Get presentation', { presentationId: id });

      const toolResult = await orchestrator.executeToolAuto('slides_get_presentation', { presentationId: id });
      if (toolResult.isError) {
        error(res, 404, 'NOT_FOUND', toolResult.content[0]?.text ?? 'Presentation not found');
        return;
      }
      const text = toolResult.content[0]?.text ?? '{}';
      success(res, safeJsonParse(text));
    }),
  );

  // PUT /api/v1/presentations/:id — Update presentation
  router.put(
    '/presentations/:id',
    validateParam('id', presentationIdSchema),
    validateBody(updatePresentationBody),
    asyncHandler(async (req: Request, res: Response) => {
      const id = param(req, 'id');
      const { title, markdown } = req.body as z.infer<typeof updatePresentationBody>;

      log.info('REST: Update presentation', { presentationId: id, hasTitle: !!title, hasMarkdown: !!markdown });

      if (markdown) {
        const toolResult = await orchestrator.executeToolAuto('slides_markdown_update', {
          presentationId: id,
          markdown,
        });
        if (toolResult.isError) {
          error(res, 400, 'UPDATE_FAILED', toolResult.content[0]?.text ?? 'Update failed');
          return;
        }
        const text = toolResult.content[0]?.text ?? '{}';
        let parsed: unknown;
        try {
          parsed = JSON.parse(text);
        } catch {
          parsed = text;
        }
        success(res, parsed, 200, title ? { title } : undefined);
      } else if (title) {
        // Title-only update: fetch presentation and return with updated title metadata
        const toolResult = await orchestrator.executeToolAuto('slides_get_presentation', { presentationId: id });
        if (toolResult.isError) {
          error(res, 404, 'NOT_FOUND', toolResult.content[0]?.text ?? 'Presentation not found');
          return;
        }
        const text = toolResult.content[0]?.text ?? '{}';
        let parsed: unknown;
        try {
          parsed = JSON.parse(text);
        } catch {
          parsed = text;
        }
        success(res, parsed, 200, { title });
      } else {
        error(res, 400, 'NO_CHANGES', 'No update fields provided. Supply title or markdown to update.');
      }
    }),
  );

  // DELETE /api/v1/presentations/:id — Delete presentation
  router.delete(
    '/presentations/:id',
    validateParam('id', presentationIdSchema),
    asyncHandler(async (req: Request, res: Response) => {
      const id = param(req, 'id');
      log.info('REST: Delete presentation', { presentationId: id });

      // Google Slides API doesn't have a direct delete — we use Drive API.
      // Attempt via orchestrator tool first, then fall back to Drive API.
      try {
        const toolResult = await orchestrator.executeToolAuto('drive_delete_file', {
          fileId: id,
        });
        if (toolResult.isError) {
          // Tool layer reported an error — fall back to direct Drive API
          throw new Error(toolResult.content[0]?.text ?? 'Orchestrator delete failed');
        }
        success(res, { presentationId: id, status: 'deleted' });
      } catch (orchestratorErr) {
        // Fallback: try Drive API directly with proper error handling
        log.warn('REST: Orchestrator delete failed, falling back to Drive API', {
          presentationId: id,
          error: orchestratorErr instanceof Error ? orchestratorErr.message : String(orchestratorErr),
        });
        try {
          const { getDriveService } = await import('../api/auth.js');
          const drive = await getDriveService();
          await drive.files.delete({ fileId: id as string });
          success(res, { presentationId: id, status: 'deleted' });
        } catch (driveErr) {
          const message = driveErr instanceof Error ? driveErr.message : String(driveErr);
          log.error('REST: Delete failed (Drive API fallback)', { presentationId: id, error: message });
          error(res, 500, 'DELETE_FAILED', message);
        }
      }
    }),
  );

  // POST /api/v1/presentations/:id/slides — Add a slide
  router.post(
    '/presentations/:id/slides',
    validateParam('id', presentationIdSchema),
    validateBody(addSlideBody),
    asyncHandler(async (req: Request, res: Response) => {
      const id = param(req, 'id');
      const { layoutId, insertionIndex } = req.body as z.infer<typeof addSlideBody>;

      log.info('REST: Add slide', { presentationId: id, layoutId, insertionIndex });

      const toolResult = await orchestrator.executeToolAuto('slides_create_slide', {
        presentationId: id,
        layoutId,
        insertionIndex,
      });

      if (toolResult.isError) {
        error(res, 400, 'CREATE_SLIDE_FAILED', toolResult.content[0]?.text ?? 'Failed to create slide');
        return;
      }
      const text = toolResult.content[0]?.text ?? '{}';
      success(res, safeJsonParse(text), 201);
    }),
  );

  // GET /api/v1/presentations/:id/slides/:slideId — Get a specific slide
  router.get(
    '/presentations/:id/slides/:slideId',
    validateParam('id', presentationIdSchema),
    validateParam('slideId', slideIdSchema),
    asyncHandler(async (req: Request, res: Response) => {
      const id = param(req, 'id');
      const slideId = param(req, 'slideId');
      log.info('REST: Get slide', { presentationId: id, slideId });

      const toolResult = await orchestrator.executeToolAuto('slides_get_page', {
        presentationId: id,
        pageObjectId: slideId,
      });

      if (toolResult.isError) {
        error(res, 404, 'NOT_FOUND', toolResult.content[0]?.text ?? 'Slide not found');
        return;
      }
      const text = toolResult.content[0]?.text ?? '{}';
      success(res, safeJsonParse(text));
    }),
  );

  // DELETE /api/v1/presentations/:id/slides/:slideId — Delete a slide
  router.delete(
    '/presentations/:id/slides/:slideId',
    validateParam('id', presentationIdSchema),
    validateParam('slideId', slideIdSchema),
    asyncHandler(async (req: Request, res: Response) => {
      const id = param(req, 'id');
      const slideId = param(req, 'slideId');
      log.info('REST: Delete slide', { presentationId: id, slideId });

      const toolResult = await orchestrator.executeToolAuto('slides_delete_slide', {
        presentationId: id,
        slideId,
      });

      if (toolResult.isError) {
        error(res, 400, 'DELETE_SLIDE_FAILED', toolResult.content[0]?.text ?? 'Failed to delete slide');
        return;
      }
      const text = toolResult.content[0]?.text ?? '{}';
      success(res, safeJsonParse(text));
    }),
  );

  // POST /api/v1/presentations/:id/slides/:slideId/duplicate — Duplicate slide
  router.post(
    '/presentations/:id/slides/:slideId/duplicate',
    validateParam('id', presentationIdSchema),
    validateParam('slideId', slideIdSchema),
    validateBody(duplicateSlideBody),
    asyncHandler(async (req: Request, res: Response) => {
      const id = param(req, 'id');
      const slideId = param(req, 'slideId');
      const { insertionIndex } = req.body as z.infer<typeof duplicateSlideBody>;

      log.info('REST: Duplicate slide', { presentationId: id, slideId, insertionIndex });

      const toolResult = await orchestrator.executeToolAuto('slides_duplicate_slide', {
        presentationId: id,
        slideId,
        insertionIndex,
      });

      if (toolResult.isError) {
        error(res, 400, 'DUPLICATE_FAILED', toolResult.content[0]?.text ?? 'Failed to duplicate slide');
        return;
      }
      const text = toolResult.content[0]?.text ?? '{}';
      success(res, safeJsonParse(text), 201);
    }),
  );

  // GET /api/v1/presentations/:id/export/pdf — Export to PDF
  router.get(
    '/presentations/:id/export/pdf',
    validateParam('id', presentationIdSchema),
    asyncHandler(async (req: Request, res: Response) => {
      const id = param(req, 'id');
      log.info('REST: Export PDF', { presentationId: id });

      const toolResult = await orchestrator.executeToolAuto('slides_export_pdf', {
        presentationId: id,
      });

      if (toolResult.isError) {
        error(res, 400, 'EXPORT_FAILED', toolResult.content[0]?.text ?? 'Failed to export PDF');
        return;
      }
      const text = toolResult.content[0]?.text ?? '{}';
      success(res, safeJsonParse(text));
    }),
  );

  // POST /api/v1/presentations/:id/share — Share presentation
  router.post(
    '/presentations/:id/share',
    validateParam('id', presentationIdSchema),
    validateBody(shareBody),
    asyncHandler(async (req: Request, res: Response) => {
      const id = param(req, 'id');
      const { role } = req.body as z.infer<typeof shareBody>;

      log.info('REST: Share presentation', { presentationId: id, role });

      const toolResult = await orchestrator.executeToolAuto('slides_share', {
        presentationId: id,
        role,
      });

      if (toolResult.isError) {
        error(res, 400, 'SHARE_FAILED', toolResult.content[0]?.text ?? 'Failed to share presentation');
        return;
      }
      const text = toolResult.content[0]?.text ?? '{}';
      success(res, safeJsonParse(text));
    }),
  );

  // =====================================================================
  // TEMPLATES
  // =====================================================================

  // GET /api/v1/templates — List available templates/themes
  router.get(
    '/templates',
    asyncHandler(async (_req: Request, res: Response) => {
      log.info('REST: List templates');

      // Use the vision layer's theme listing if available
      try {
        const { listThemes } = await import('../vision/theme-engine.js');
        const themes = listThemes();
        success(res, {
          templates: themes.map((t) => ({
            id: t.name,
            name: t.name,
            description: t.description ?? `${t.name} theme`,
            colors: t.colors,
          })),
          count: themes.length,
        });
      } catch {
        // Fallback: list built-in color themes from constants
        const { COLOR_THEMES } = await import('../shared/constants.js');
        const templates = Object.entries(COLOR_THEMES).map(([name, colors]) => ({
          id: name,
          name,
          description: `${name} color theme`,
          colors,
        }));
        success(res, { templates, count: templates.length });
      }
    }),
  );

  // POST /api/v1/templates/:id/apply — Apply template to presentation
  router.post(
    '/templates/:id/apply',
    validateBody(applyTemplateBody),
    asyncHandler(async (req: Request, res: Response) => {
      const templateId = param(req, 'id');
      const { presentationId } = req.body as z.infer<typeof applyTemplateBody>;

      log.info('REST: Apply template', { templateId, presentationId });

      try {
        await orchestrator.applyProfessionalTheme(presentationId, templateId);
        success(res, {
          presentationId,
          templateId,
          status: 'applied',
        });
      } catch (err) {
        const message = err instanceof Error ? err.message : String(err);
        error(res, 400, 'TEMPLATE_APPLY_FAILED', message);
      }
    }),
  );

  // =====================================================================
  // VISION / ANALYSIS
  // =====================================================================

  // POST /api/v1/presentations/:id/analyze — Analyze design quality
  router.post(
    '/presentations/:id/analyze',
    validateParam('id', presentationIdSchema),
    validateBody(analyzeBody),
    asyncHandler(async (req: Request, res: Response) => {
      const id = param(req, 'id');
      const { slideIndex, checks } = req.body as z.infer<typeof analyzeBody>;

      log.info('REST: Analyze presentation', { presentationId: id, slideIndex, checks });

      // Try vision tool if available
      const toolResult = await orchestrator.executeToolAuto('vision_analyze_design', {
        presentationId: id,
        slideIndex,
        checks,
      });

      if (toolResult.isError) {
        // Vision layer might not be available — provide useful error
        error(res, 400, 'ANALYSIS_FAILED', toolResult.content[0]?.text ?? 'Design analysis failed');
        return;
      }
      const text = toolResult.content[0]?.text ?? '{}';
      success(res, safeJsonParse(text));
    }),
  );

  // POST /api/v1/presentations/:id/polish — Auto-polish presentation
  router.post(
    '/presentations/:id/polish',
    validateParam('id', presentationIdSchema),
    validateBody(polishBody),
    asyncHandler(async (req: Request, res: Response) => {
      const id = param(req, 'id');
      const { maxIterations } = req.body as z.infer<typeof polishBody>;

      log.info('REST: Polish presentation', { presentationId: id, maxIterations });

      try {
        const results = await orchestrator.polishPresentation(id, maxIterations);
        success(res, {
          presentationId: id,
          slidesPolished: results.length,
          results,
          overallScoreBefore: results.length > 0
            ? Math.round(results.reduce((s, r) => s + r.beforeScore, 0) / results.length)
            : undefined,
          overallScoreAfter: results.length > 0
            ? Math.round(results.reduce((s, r) => s + r.afterScore, 0) / results.length)
            : undefined,
        });
      } catch (err) {
        const message = err instanceof Error ? err.message : String(err);
        error(res, 400, 'POLISH_FAILED', message);
      }
    }),
  );

  // POST /api/v1/presentations/:id/theme — Apply theme
  router.post(
    '/presentations/:id/theme',
    validateParam('id', presentationIdSchema),
    validateBody(themeBody),
    asyncHandler(async (req: Request, res: Response) => {
      const id = param(req, 'id');
      const { theme } = req.body as z.infer<typeof themeBody>;

      log.info('REST: Apply theme', { presentationId: id, theme });

      try {
        await orchestrator.applyProfessionalTheme(id, theme);
        success(res, {
          presentationId: id,
          theme,
          status: 'applied',
        });
      } catch (err) {
        const message = err instanceof Error ? err.message : String(err);
        error(res, 400, 'THEME_FAILED', message);
      }
    }),
  );

  // =====================================================================
  // MARKDOWN
  // =====================================================================

  // POST /api/v1/markdown/preview — Preview markdown structure without creating
  router.post(
    '/markdown/preview',
    validateBody(markdownPreviewBody),
    asyncHandler(async (req: Request, res: Response) => {
      const { markdown, title } = req.body as z.infer<typeof markdownPreviewBody>;

      log.info('REST: Preview markdown', { titleProvided: !!title, markdownLength: markdown.length });

      try {
        const { parseMarkdown } = await import('../api/markdown.js');
        const slides = parseMarkdown(markdown);

        success(res, {
          title: title ?? 'Untitled Presentation',
          slideCount: slides.length,
          slides: slides.map((slide, index) => ({
            index,
            title: slide.title,
            bodyLines: slide.body.length,
            hasNotes: !!slide.notes,
            layout: slide.layout ?? 'auto',
          })),
        });
      } catch (err) {
        const message = err instanceof Error ? err.message : String(err);
        error(res, 400, 'PARSE_FAILED', message);
      }
    }),
  );

  // POST /api/v1/markdown/create — Create presentation from markdown
  router.post(
    '/markdown/create',
    validateBody(markdownCreateBody),
    asyncHandler(async (req: Request, res: Response) => {
      const { title, markdown, theme, polish } = req.body as z.infer<typeof markdownCreateBody>;

      log.info('REST: Create from markdown', { title, theme, polish, markdownLength: markdown.length });

      const result = await orchestrator.createPresentationFromMarkdown(title, markdown, {
        polish,
        themeName: theme,
      });

      metrics.incPresentationsCreated();
      success(res, result, 201);
    }),
  );

  // =====================================================================
  // OPENAPI SPEC
  // =====================================================================

  // GET /api/v1/openapi.json — Serve the OpenAPI specification
  router.get(
    '/openapi.json',
    (_req: Request, res: Response) => {
      res.status(200).json(generateOpenApiSpec());
    },
  );

  return router;
}
