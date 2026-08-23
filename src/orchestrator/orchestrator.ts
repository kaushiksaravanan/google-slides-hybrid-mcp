/**
 * @module orchestrator/orchestrator
 * @description Hybrid orchestrator — the brain that coordinates API + Browser + Vision layers.
 *
 * Provides high-level operations that combine all three layers:
 * - Create presentations from Markdown and polish them visually
 * - Analyze and auto-fix design issues across entire presentations
 * - Apply professional themes with vision-guided refinement
 * - Smart-route tool calls to the correct layer based on prefix
 *
 * The orchestrator manages initialization / shutdown of all layers and
 * reports which layers are available at runtime.
 */

import type {
  HybridConfig,
  ToolResult,
  VisionAnalysis,
} from '../shared/types.js';
import { MCPLayer } from '../shared/types.js';
import { createLogger } from '../shared/logger.js';
import {
  ToolExecutionError,
} from '../shared/errors.js';
import {
  MCP_SERVER_NAME,
  MCP_SERVER_VERSION,
} from '../shared/constants.js';

// Resilience imports (optional — used when available)
import {
  googleSlidesCircuit,
  apiBulkhead,
  browserBulkhead,
  visionBulkhead,
  presentationCache,
} from '../resilience/index.js';

// Monitoring imports (optional — used when available)
import { defaultMetrics } from '../monitoring/metrics.js';

// Event bus import (optional — used when available)
import { eventBus } from '../events/event-bus.js';

// API layer imports
import { getAuthenticatedClient, clearAuthCache } from '../api/auth.js';
import * as apiClient from '../api/client.js';
import { markdownToSlides } from '../api/markdown.js';
import {
  isApiTool,
  executeApiTool,
  listApiTools,
} from '../api/tools.js';

// Browser layer imports
import {
  BrowserConnectionManager,
  getConnectionManager,
  destroyConnectionManager,
} from '../browser/connection.js';
import {
  isBrowserTool,
  executeBrowserTool,
  listBrowserTools,
} from '../browser/tools.js';
import * as slidesController from '../browser/slides-controller.js';

// Vision layer imports
import {
  isVisionTool,
  executeVisionTool,
  listVisionTools,
} from '../vision/tools.js';
import { analyzeSlideDesign } from '../vision/analyzer.js';
import { generateFixes } from '../vision/auto-fixer.js';
import { getTheme, applyTheme, listThemes } from '../vision/theme-engine.js';
import { evaluateAllRules, calculateDesignScore, getRecommendedFix } from '../vision/design-rules.js';

// Event layer imports
import {
  isEventTool,
  executeEventTool,
  listEventTools,
} from '../events/event-tools.js';

import { randomUUID } from 'node:crypto';
import type { slides_v1 } from 'googleapis';

const log = createLogger('orchestrator');

// ─────────────────────────────────────────────────────────────────────────────
// Types
// ─────────────────────────────────────────────────────────────────────────────

/** Status of each layer. */
export interface LayerStatus {
  api: { available: boolean; authenticated: boolean; error?: string };
  browser: { available: boolean; connected: boolean; wsPort: number; error?: string };
  vision: { available: boolean; enabled: boolean; error?: string };
}

/** Options for createPresentationFromMarkdown. */
export interface CreateFromMarkdownOptions {
  /** Whether to polish slides after creation (requires browser + vision). */
  polish?: boolean;
  /** Theme name to apply after creation. */
  themeName?: string;
  /** Maximum polish iterations per slide. */
  maxPolishIterations?: number;
}

/** Result of a polish operation on a single slide. */
export interface PolishResult {
  slideId: string;
  slideIndex: number;
  beforeScore: number;
  afterScore: number;
  issuesFixed: number;
  iterations: number;
}

/** Result of a full pipeline run. */
export interface PipelineResult {
  presentationId: string;
  title: string;
  slideCount: number;
  url: string;
  themeApplied?: string;
  polishResults?: PolishResult[];
  overallScoreBefore?: number;
  overallScoreAfter?: number;
}

// ─────────────────────────────────────────────────────────────────────────────
// HybridOrchestrator
// ─────────────────────────────────────────────────────────────────────────────

/**
 * The central orchestrator that coordinates the API, Browser, and Vision layers.
 *
 * @example
 * ```ts
 * const orchestrator = new HybridOrchestrator(config);
 * await orchestrator.initialize();
 *
 * const result = await orchestrator.createAndPolish(
 *   'Q3 Review', markdown, 'corporate'
 * );
 * console.log(`Created: ${result.url}`);
 *
 * await orchestrator.shutdown();
 * ```
 */
export class HybridOrchestrator {
  private readonly config: HybridConfig;
  private browserManager: BrowserConnectionManager | null = null;
  private apiInitialized = false;
  private browserInitialized = false;
  private visionAvailable = false;
  private _isShutdown = false;

  constructor(config: HybridConfig) {
    this.config = config;
  }

  // ── Lifecycle ─────────────────────────────────────────────────────────────

  /**
   * Initialize all available layers.
   *
   * - API: authenticate with Google OAuth (always attempted if credentials present)
   * - Browser: start WebSocket server (optional, for live editing)
   * - Vision: check sharp availability (optional, for design analysis)
   */
  async initialize(): Promise<LayerStatus> {
    log.info('Initializing hybrid orchestrator', {
      server: MCP_SERVER_NAME,
      version: MCP_SERVER_VERSION,
    });

    const status = await this.getLayerStatus();

    // ── API Layer ──────────────────────────────────────────────────────────
    try {
      if (this.config.api.clientId && this.config.api.clientSecret && this.config.api.refreshToken) {
        await getAuthenticatedClient(this.config.api);
        this.apiInitialized = true;
        status.api.available = true;
        status.api.authenticated = true;
        log.info('API layer initialized successfully');
      } else {
        status.api.error = 'Missing OAuth credentials (GOOGLE_CLIENT_ID, GOOGLE_CLIENT_SECRET, GOOGLE_REFRESH_TOKEN)';
        log.warn('API layer not initialized: missing credentials');
      }
    } catch (error) {
      status.api.error = error instanceof Error ? error.message : String(error);
      log.error('API layer initialization failed', { error: status.api.error });
    }

    // ── Browser Layer ──────────────────────────────────────────────────────
    try {
      this.browserManager = getConnectionManager({
        port: this.config.browser.wsPort,
      });
      await this.browserManager.start();
      this.browserInitialized = true;
      status.browser.available = true;
      status.browser.wsPort = this.config.browser.wsPort;
      log.info('Browser layer initialized (WebSocket server started)', {
        port: this.config.browser.wsPort,
      });

      // Note: the browser is "available" (WS server is listening) but may not
      // be "connected" (Chrome extension hasn't connected yet).
      status.browser.connected = this.browserManager.isConnected;
    } catch (error) {
      status.browser.error = error instanceof Error ? error.message : String(error);
      log.warn('Browser layer initialization failed (non-fatal)', {
        error: status.browser.error,
      });
    }

    // ── Vision Layer ───────────────────────────────────────────────────────
    if (this.config.vision.enabled) {
      try {
        // Check if sharp is available by importing it
        await import('sharp');
        this.visionAvailable = true;
        status.vision.available = true;
        status.vision.enabled = true;
        log.info('Vision layer initialized (sharp available)');
      } catch (error) {
        status.vision.error = 'sharp module not available — install with: npm install sharp';
        log.warn('Vision layer not available', { error: status.vision.error });
      }
    } else {
      status.vision.enabled = false;
      log.info('Vision layer disabled by configuration');
    }

    log.info('Orchestrator initialization complete', {
      apiAvailable: status.api.available,
      browserAvailable: status.browser.available,
      visionAvailable: status.vision.available,
    });

    return status;
  }

  /**
   * Gracefully shut down all layers and release resources.
   */
  async shutdown(): Promise<void> {
    if (this._isShutdown) return;
    this._isShutdown = true;

    log.info('Shutting down hybrid orchestrator');

    // Shut down browser layer
    if (this.browserInitialized) {
      try {
        await destroyConnectionManager();
        this.browserInitialized = false;
        log.info('Browser layer shut down');
      } catch (error) {
        log.error('Error shutting down browser layer', {
          error: error instanceof Error ? error.message : String(error),
        });
      }
    }

    // Clear API auth cache
    if (this.apiInitialized) {
      clearAuthCache();
      apiClient.clearServiceCache();
      this.apiInitialized = false;
      log.info('API layer shut down');
    }

    this.visionAvailable = false;
    log.info('Hybrid orchestrator shut down complete');
  }

  // ── Layer Status ──────────────────────────────────────────────────────────

  /**
   * Check which layers are currently available and their status.
   */
  async getLayerStatus(): Promise<LayerStatus> {
    return {
      api: {
        available: this.apiInitialized,
        authenticated: this.apiInitialized,
      },
      browser: {
        available: this.browserInitialized,
        connected: this.browserManager?.isConnected ?? false,
        wsPort: this.config.browser.wsPort,
      },
      vision: {
        available: this.visionAvailable,
        enabled: this.config.vision.enabled,
      },
    };
  }

  // ── Smart Tool Routing ────────────────────────────────────────────────────

  /**
   * Get all available tools across all layers.
   *
   * Returns tool definitions from API + Browser + Vision layers,
   * filtered to only include tools from layers that are currently available.
   */
  getAvailableTools(): Array<{
    name: string;
    description: string;
    inputSchema: Record<string, unknown>;
  }> {
    const tools: Array<{ name: string; description: string; inputSchema: Record<string, unknown> }> = [];

    if (this.apiInitialized) {
      tools.push(...listApiTools());
    }

    if (this.browserInitialized) {
      tools.push(...listBrowserTools());
    }

    if (this.visionAvailable) {
      tools.push(...listVisionTools());
    }

    // Event tools are always available
    tools.push(...listEventTools());

    return tools;
  }

  /**
   * Auto-route a tool call to the correct layer based on its name prefix.
   *
   * - `slides_*` -> API layer
   * - `live_*` -> Browser layer
   * - `vision_*` -> Vision layer
   *
   * @param toolName - The MCP tool name.
   * @param args - The raw input arguments.
   * @returns The tool result.
   * @throws {ToolExecutionError} if the tool is not found or its layer is unavailable.
   */
  async executeToolAuto(toolName: string, args: unknown): Promise<ToolResult> {
    log.info('Auto-routing tool call', { toolName });
    const startTime = Date.now();

    try {
      let result: ToolResult;

      // API layer tools
      if (isApiTool(toolName)) {
        if (!this.apiInitialized) {
          return {
            content: [{ type: 'text', text: `Error: API layer is not available. Ensure Google OAuth credentials are configured.` }],
            isError: true,
          };
        }
        result = await apiBulkhead.execute(() =>
          googleSlidesCircuit.execute(() => executeApiTool(toolName, args)),
        );
      }

      // Browser layer tools
      else if (isBrowserTool(toolName)) {
        if (!this.browserInitialized) {
          return {
            content: [{ type: 'text', text: `Error: Browser layer is not available. Ensure the Chrome extension is installed and connected.` }],
            isError: true,
          };
        }
        result = await browserBulkhead.execute(() => executeBrowserTool(toolName, args));
      }

      // Vision layer tools
      else if (isVisionTool(toolName)) {
        if (!this.visionAvailable) {
          return {
            content: [{ type: 'text', text: `Error: Vision layer is not available. Ensure sharp is installed: npm install sharp` }],
            isError: true,
          };
        }
        result = await visionBulkhead.execute(() => executeVisionTool(toolName, args));
      }

      // Event layer tools
      else if (isEventTool(toolName)) {
        result = await executeEventTool(toolName, args);
      }

      // Unknown tool
      else {
        throw new ToolExecutionError(
          `Unknown tool: "${toolName}". Available prefixes: slides_* (API), live_* (Browser), vision_* (Vision), events_*/webhooks_* (Events)`,
          toolName,
          MCPLayer.API,
        );
      }

      // Record metrics for successful tool execution
      const duration = Date.now() - startTime;
      defaultMetrics.apiCallsTotal.inc({ tool: toolName, status: 'success' });
      defaultMetrics.apiCallDuration.observe(duration, { tool: toolName });

      return result;
    } catch (error) {
      // Record metrics for failed tool execution
      const duration = Date.now() - startTime;
      defaultMetrics.apiCallsTotal.inc({ tool: toolName, status: 'error' });
      defaultMetrics.apiCallDuration.observe(duration, { tool: toolName });
      defaultMetrics.errorsTotal.inc({
        type: error instanceof Error ? error.constructor.name : 'UnknownError',
        layer: isApiTool(toolName) ? 'api' : isBrowserTool(toolName) ? 'browser' : isVisionTool(toolName) ? 'vision' : 'events',
      });

      throw error;
    }
  }

  // ── High-Level Orchestration Methods ──────────────────────────────────────

  /**
   * Create a presentation from Markdown with optional browser polishing.
   *
   * 1. Creates the presentation via the API layer
   * 2. Converts Markdown to slides
   * 3. Optionally applies a theme
   * 4. Optionally polishes each slide (screenshot -> analyze -> fix)
   *
   * @param title - Presentation title.
   * @param markdown - Markdown content.
   * @param options - Additional options (polish, theme, iterations).
   * @returns Pipeline result with presentation info and polish details.
   */
  async createPresentationFromMarkdown(
    title: string,
    markdown: string,
    options?: CreateFromMarkdownOptions,
  ): Promise<PipelineResult> {
    this.ensureApiAvailable('createPresentationFromMarkdown');

    log.info('Creating presentation from markdown', {
      title,
      markdownLength: markdown.length,
      polish: options?.polish ?? false,
      theme: options?.themeName,
    });

    // Step 1: Create the presentation
    const pres = await googleSlidesCircuit.execute(() => apiClient.createPresentation(title));
    const presentationId = pres.presentationId!;
    const initialSlideId = pres.slides?.[0]?.objectId;

    // Step 2: Convert Markdown to slides
    const { createRequests, deleteInitialSlideRequest } = markdownToSlides(title, markdown);
    const allRequests: slides_v1.Schema$Request[] = [...createRequests];
    if (initialSlideId) {
      allRequests.push(deleteInitialSlideRequest(initialSlideId));
    }
    if (allRequests.length > 0) {
      await googleSlidesCircuit.execute(() => apiClient.batchUpdate(presentationId, allRequests));
    }

    // Record metrics
    defaultMetrics.presentationsCreatedTotal.inc({ method: 'markdown' });

    // Emit event
    eventBus.emit({
      id: randomUUID(),
      type: 'presentation.created',
      timestamp: new Date(),
      data: { presentationId, title, method: 'markdown' },
      metadata: { source: 'orchestrator', version: MCP_SERVER_VERSION },
    });

    const result: PipelineResult = {
      presentationId,
      title,
      slideCount: 0,
      url: `https://docs.google.com/presentation/d/${presentationId}/edit`,
    };

    // Step 3: Apply theme if specified
    if (options?.themeName) {
      try {
        await this.applyProfessionalTheme(presentationId, options.themeName);
        result.themeApplied = options.themeName;
      } catch (error) {
        log.warn('Theme application failed (continuing without theme)', {
          error: error instanceof Error ? error.message : String(error),
        });
      }
    }

    // Step 4: Polish if requested and layers are available
    if (options?.polish && this.browserInitialized && this.visionAvailable) {
      try {
        const polishResults = await this.polishPresentation(
          presentationId,
          options.maxPolishIterations,
        );
        result.polishResults = polishResults;
        if (polishResults.length > 0) {
          result.overallScoreBefore = Math.round(
            polishResults.reduce((s, r) => s + r.beforeScore, 0) / polishResults.length,
          );
          result.overallScoreAfter = Math.round(
            polishResults.reduce((s, r) => s + r.afterScore, 0) / polishResults.length,
          );
        }
      } catch (error) {
        log.warn('Polish step failed (continuing without polish)', {
          error: error instanceof Error ? error.message : String(error),
        });
      }
    }

    // Refresh slide count
    const updatedPres = await googleSlidesCircuit.execute(() => apiClient.getPresentation(presentationId));
    result.slideCount = updatedPres.slides?.length ?? 0;

    log.info('Presentation created from markdown', {
      presentationId,
      slideCount: result.slideCount,
      themeApplied: result.themeApplied,
      polished: !!result.polishResults,
    });

    return result;
  }

  /**
   * Polish all slides in a presentation.
   *
   * For each slide: screenshot -> analyze design -> generate fixes -> apply.
   * Repeats up to `maxIterations` times per slide or until the score
   * reaches 80+.
   *
   * Requires both the Browser and Vision layers.
   *
   * @param presentationId - The presentation to polish.
   * @param maxIterations - Max polish iterations per slide (default 2).
   * @returns Array of per-slide polish results.
   */
  async polishPresentation(
    presentationId: string,
    maxIterations: number = 2,
  ): Promise<PolishResult[]> {
    this.ensureApiAvailable('polishPresentation');

    log.info('Polishing presentation', { presentationId, maxIterations });

    const pres = await googleSlidesCircuit.execute(() => apiClient.getPresentation(presentationId));
    const slides = pres.slides ?? [];
    const results: PolishResult[] = [];

    // Open the presentation in the browser if browser is connected
    if (this.browserInitialized && this.browserManager?.isConnected) {
      try {
        await slidesController.openPresentation(presentationId);
      } catch (error) {
        log.warn('Could not open presentation in browser', {
          error: error instanceof Error ? error.message : String(error),
        });
      }
    }

    for (let i = 0; i < slides.length; i++) {
      const slide = slides[i]!;
      const slideId = slide.objectId!;

      try {
        const polishResult = await this.polishSlide(
          presentationId,
          slideId,
          i,
          maxIterations,
        );
        results.push(polishResult);
      } catch (error) {
        log.warn('Failed to polish slide', {
          slideId,
          slideIndex: i,
          error: error instanceof Error ? error.message : String(error),
        });
        results.push({
          slideId,
          slideIndex: i,
          beforeScore: -1,
          afterScore: -1,
          issuesFixed: 0,
          iterations: 0,
        });
      }
    }

    log.info('Presentation polish complete', {
      presentationId,
      slidesPolished: results.filter((r) => r.issuesFixed > 0).length,
      totalIssuesFixed: results.reduce((s, r) => s + r.issuesFixed, 0),
    });

    return results;
  }

  /**
   * Polish a single slide: screenshot -> analyze -> fix -> repeat.
   *
   * @param presentationId - The presentation ID.
   * @param slideId - The slide page object ID.
   * @param slideIndex - Zero-based slide index (for navigation).
   * @param maxIterations - Max polish iterations (default 2).
   * @returns Polish result for this slide.
   */
  async polishSlide(
    presentationId: string,
    slideId: string,
    slideIndex?: number,
    maxIterations: number = 2,
  ): Promise<PolishResult> {
    const effectiveIndex = slideIndex ?? 0;
    log.info('Polishing slide', { presentationId, slideId, slideIndex: effectiveIndex });

    let beforeScore = -1;
    let afterScore = -1;
    let totalIssuesFixed = 0;
    let actualIterations = 0;

    for (let iteration = 0; iteration < maxIterations; iteration++) {
      actualIterations++;
      // Navigate to the slide in the browser
      if (this.browserInitialized && this.browserManager?.isConnected) {
        try {
          await slidesController.goToSlide(effectiveIndex + 1); // 1-based
        } catch {
          log.debug('Could not navigate to slide in browser');
        }
      }

      // Take a screenshot (browser layer)
      let screenshotBase64: string | undefined;
      if (this.browserInitialized && this.browserManager?.isConnected) {
        try {
          const screenshot = await slidesController.getSlideScreenshot();
          screenshotBase64 = screenshot.data;
        } catch {
          log.debug('Could not take screenshot');
        }
      }

      // If no screenshot, try API thumbnail
      if (!screenshotBase64 && this.apiInitialized) {
        try {
          const thumbnail = await googleSlidesCircuit.execute(() =>
            apiClient.getPageThumbnail(presentationId, slideId, 'LARGE'),
          );
          if (thumbnail.contentUrl) {
            // thumbnail.contentUrl is a URL, not base64 — we note that the
            // full pixel analysis requires the browser screenshot
            log.debug('Got API thumbnail URL but need base64 for analysis');
          }
        } catch {
          log.debug('Could not get API thumbnail');
        }
      }

      // Analyze the slide
      let analysis: VisionAnalysis;
      if (screenshotBase64 && this.visionAvailable) {
        analysis = await analyzeSlideDesign(screenshotBase64);
      } else {
        // Fall back to structural-only analysis
        const slideContent = {
          slideId,
          slideIndex: effectiveIndex,
          elements: [],
        };
        const issues = evaluateAllRules(slideContent);
        analysis = {
          issues,
          score: calculateDesignScore(issues),
          suggestions: issues.map((i) => getRecommendedFix(i)),
        };
      }

      if (iteration === 0) {
        beforeScore = analysis.score;
      }
      afterScore = analysis.score;

      // If score is already good, stop iterating
      if (analysis.score >= 80) {
        log.info('Slide already scores well, skipping fixes', {
          slideId, score: analysis.score, iteration,
        });
        break;
      }

      // Generate and apply fixes
      if (analysis.issues.length > 0) {
        const fixPlan = generateFixes(analysis, presentationId, slideId);

        if (fixPlan.apiUpdates.length > 0) {
          try {
            await googleSlidesCircuit.execute(() =>
              apiClient.batchUpdate(
                presentationId,
                fixPlan.apiUpdates as slides_v1.Schema$Request[],
              ),
            );
            totalIssuesFixed += fixPlan.issues.length;

            // Invalidate cache after fixes
            presentationCache.invalidatePresentation(presentationId);

            // Emit autofix event
            eventBus.emit({
              id: randomUUID(),
              type: 'autofix.applied',
              timestamp: new Date(),
              data: { presentationId, slideId, fixCount: fixPlan.apiUpdates.length, iteration },
              metadata: { source: 'orchestrator', version: MCP_SERVER_VERSION },
            });

            log.info('Applied API fixes', {
              slideId, fixCount: fixPlan.apiUpdates.length, iteration,
            });
          } catch (error) {
            log.warn('Failed to apply API fixes', {
              error: error instanceof Error ? error.message : String(error),
            });
          }
        }
      }

      // Small delay for Google Slides to process changes
      await new Promise((resolve) => setTimeout(resolve, 1000));
    }

    return {
      slideId,
      slideIndex: effectiveIndex,
      beforeScore,
      afterScore,
      issuesFixed: totalIssuesFixed,
      iterations: actualIterations,
    };
  }

  /**
   * Apply a professional theme to a presentation.
   *
   * Fetches slide IDs from the presentation, then generates and applies
   * theme batch-update requests via the API layer.
   *
   * @param presentationId - The presentation to theme.
   * @param themeName - Theme name (e.g. "corporate", "dark", "warm", "nature", "slate").
   */
  async applyProfessionalTheme(
    presentationId: string,
    themeName: string,
  ): Promise<void> {
    this.ensureApiAvailable('applyProfessionalTheme');

    const theme = getTheme(themeName);
    if (!theme) {
      const available = listThemes().map((t) => t.name).join(', ');
      throw new Error(`Theme "${themeName}" not found. Available: ${available}`);
    }

    log.info('Applying professional theme', { presentationId, themeName: theme.name });

    const pres = await googleSlidesCircuit.execute(() => apiClient.getPresentation(presentationId));
    const slideIds = (pres.slides ?? []).map((s) => s.objectId!).filter(Boolean);

    if (slideIds.length === 0) {
      log.warn('No slides to apply theme to');
      return;
    }

    const requests = applyTheme(presentationId, theme, slideIds);
    if (requests.length > 0) {
      await googleSlidesCircuit.execute(() =>
        apiClient.batchUpdate(
          presentationId,
          requests as slides_v1.Schema$Request[],
        ),
      );

      // Invalidate cache after theme application
      presentationCache.invalidatePresentation(presentationId);

      // Emit event
      eventBus.emit({
        id: randomUUID(),
        type: 'theme.applied',
        timestamp: new Date(),
        data: { presentationId, themeName: theme.name, slidesUpdated: slideIds.length },
        metadata: { source: 'orchestrator', version: MCP_SERVER_VERSION },
      });

      log.info('Theme applied successfully', {
        presentationId,
        themeName: theme.name,
        slidesUpdated: slideIds.length,
        requestCount: requests.length,
      });
    }
  }

  /**
   * Full pipeline: create from Markdown -> apply theme -> polish each slide.
   *
   * This is the highest-level entry point combining all orchestrator capabilities.
   *
   * @param title - Presentation title.
   * @param markdown - Markdown content.
   * @param themeName - Optional theme name.
   * @returns Full pipeline result.
   */
  async createAndPolish(
    title: string,
    markdown: string,
    themeName?: string,
  ): Promise<PipelineResult> {
    return this.createPresentationFromMarkdown(title, markdown, {
      polish: true,
      themeName,
      maxPolishIterations: 2,
    });
  }

  // ── Private Helpers ───────────────────────────────────────────────────────

  /**
   * Ensure the API layer is initialized, or throw.
   */
  private ensureApiAvailable(method: string): void {
    if (!this.apiInitialized) {
      throw new Error(
        `${method} requires the API layer, but it is not initialized. ` +
        `Provide Google OAuth credentials via environment variables.`,
      );
    }
  }
}
