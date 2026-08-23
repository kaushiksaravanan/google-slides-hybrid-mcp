/**
 * @module orchestrator/workflow
 * @description Pre-built workflow engine for common presentation tasks.
 *
 * Provides higher-level workflows that chain multiple orchestrator operations:
 * - `briefToDeck` — turn a text brief into a polished slide deck
 * - `importAndPolish` — take an existing presentation, analyze, and fix
 * - `batchPolish` — polish multiple presentations in sequence
 * - `slideBySlideReview` — iterative per-slide review with progress callbacks
 *
 * Each workflow tracks its status and can report progress via optional callbacks.
 */

import { HybridOrchestrator } from './orchestrator.js';
import type { PolishResult, PipelineResult } from './orchestrator.js';
import * as apiClient from '../api/client.js';
import { createLogger } from '../shared/logger.js';

const log = createLogger('orchestrator.workflow');

// ─────────────────────────────────────────────────────────────────────────────
// Types
// ─────────────────────────────────────────────────────────────────────────────

/** Current status of a running workflow. */
export type WorkflowStatus = 'idle' | 'running' | 'completed' | 'failed' | 'cancelled';

/** Progress callback signature. */
export type ProgressCallback = (progress: WorkflowProgress) => void;

/** Progress update sent to the callback. */
export interface WorkflowProgress {
  /** Workflow identifier. */
  workflowId: string;
  /** Current step description. */
  step: string;
  /** Progress fraction in [0, 1]. */
  progress: number;
  /** Current step number. */
  currentStep: number;
  /** Total step count (may be estimated). */
  totalSteps: number;
  /** Optional detail data for the current step. */
  detail?: unknown;
}

/** Result of a workflow run. */
export interface WorkflowResult<T> {
  /** Whether the workflow completed successfully. */
  success: boolean;
  /** The workflow result data (on success). */
  data?: T;
  /** Error message (on failure). */
  error?: string;
  /** Duration in milliseconds. */
  durationMs: number;
  /** The workflow ID for tracking. */
  workflowId: string;
}

/** Result of a batch polish workflow. */
export interface BatchPolishResult {
  total: number;
  succeeded: number;
  failed: number;
  results: Array<{
    presentationId: string;
    success: boolean;
    polishResults?: PolishResult[];
    error?: string;
  }>;
}

/** Result of a slide-by-slide review. */
export interface SlideReviewResult {
  presentationId: string;
  slideCount: number;
  reviews: PolishResult[];
  averageScoreBefore: number;
  averageScoreAfter: number;
  totalIssuesFixed: number;
}

// ─────────────────────────────────────────────────────────────────────────────
// Markdown Generation from Brief
// ─────────────────────────────────────────────────────────────────────────────

/**
 * Generate structured Markdown from a text brief.
 *
 * Uses heuristic rules to split a brief into a title slide, content slides,
 * and a closing slide. Each section becomes a Markdown slide separated by `---`.
 *
 * @param brief - The text brief describing the deck content.
 * @param slideCount - Target number of slides (default: auto-detect).
 * @returns Markdown string ready for the Markdown-to-Slides pipeline.
 */
function generateMarkdownFromBrief(brief: string, slideCount?: number): {
  title: string;
  markdown: string;
} {
  const lines = brief.split('\n').map((l) => l.trim()).filter(Boolean);

  // Extract title: first line, or first sentence before a period
  let title = lines[0] ?? 'Untitled Presentation';
  const bodyLines = lines.slice(1);

  // If the title is too long, truncate
  if (title.length > 100) {
    const periodIdx = title.indexOf('.');
    if (periodIdx > 10 && periodIdx < 80) {
      const rest = title.substring(periodIdx + 1).trim();
      title = title.substring(0, periodIdx);
      if (rest) bodyLines.unshift(rest);
    } else {
      title = title.substring(0, 80) + '...';
    }
  }

  // Split body content into slide-sized chunks
  const bodyText = bodyLines.join('\n');
  const paragraphs = bodyText.split(/\n\n+/).filter(Boolean);

  // Determine slide count
  const targetSlides = slideCount ?? Math.max(3, Math.min(12, Math.ceil(paragraphs.length / 2) + 2));

  // Generate markdown sections
  const sections: string[] = [];

  // Title slide
  sections.push(`# ${title}\n\nA presentation overview`);

  // Content slides: distribute paragraphs across slides
  const contentSlideCount = Math.max(1, targetSlides - 2); // reserve title + closing
  const parasPerSlide = Math.max(1, Math.ceil(paragraphs.length / contentSlideCount));

  for (let i = 0; i < paragraphs.length; i += parasPerSlide) {
    const chunk = paragraphs.slice(i, i + parasPerSlide);
    const slideNum = Math.floor(i / parasPerSlide) + 1;

    // Try to extract a heading from the first line of the chunk
    const firstLine = chunk[0]?.split('.')[0] ?? `Section ${slideNum}`;
    const heading = firstLine.length > 60 ? `Section ${slideNum}` : firstLine;

    const bulletPoints = chunk
      .map((p) => {
        // Convert sentences to bullet points
        const sentences = p.split(/\.\s+/).filter(Boolean);
        return sentences.map((s) => `- ${s.trim().replace(/\.$/, '')}`).join('\n');
      })
      .join('\n');

    sections.push(`## ${heading}\n\n${bulletPoints}`);
  }

  // If we have no content paragraphs, create a placeholder content slide
  if (paragraphs.length === 0) {
    sections.push(`## Key Points\n\n- ${brief.substring(0, 200)}`);
  }

  // Closing slide
  sections.push(`## Thank You\n\nQuestions and discussion`);

  const markdown = sections.join('\n\n---\n\n');

  return { title, markdown };
}

// ─────────────────────────────────────────────────────────────────────────────
// WorkflowEngine
// ─────────────────────────────────────────────────────────────────────────────

/**
 * Engine for executing pre-built presentation workflows.
 *
 * Each workflow is a multi-step process that coordinates the orchestrator's
 * capabilities. Workflows support progress callbacks and return structured
 * results.
 *
 * @example
 * ```ts
 * const engine = new WorkflowEngine(orchestrator);
 *
 * const result = await engine.briefToDeck(
 *   'Our Q3 results showed 25% growth in...',
 *   8, // 8 slides
 *   (progress) => console.log(`${progress.step} (${Math.round(progress.progress * 100)}%)`)
 * );
 * ```
 */
export class WorkflowEngine {
  private readonly orchestrator: HybridOrchestrator;
  private workflowCounter = 0;
  private activeWorkflows = new Map<string, WorkflowStatus>();
  /** Timers scheduled to remove completed/failed workflows after a TTL. */
  private cleanupTimers = new Map<string, ReturnType<typeof setTimeout>>();

  /** Maximum number of tracked workflows before evicting oldest completed ones. */
  private static readonly MAX_TRACKED_WORKFLOWS = 100;
  /** Time (ms) after which completed/failed workflows are removed from the map. */
  private static readonly COMPLETED_WORKFLOW_TTL_MS = 5 * 60 * 1000; // 5 minutes

  constructor(orchestrator: HybridOrchestrator) {
    this.orchestrator = orchestrator;
  }

  /**
   * Schedule removal of a completed/failed workflow after a TTL.
   * Also enforces the maximum map size by evicting oldest completed entries.
   */
  private scheduleWorkflowCleanup(workflowId: string): void {
    const timer = setTimeout(() => {
      this.activeWorkflows.delete(workflowId);
      this.cleanupTimers.delete(workflowId);
    }, WorkflowEngine.COMPLETED_WORKFLOW_TTL_MS);
    this.cleanupTimers.set(workflowId, timer);

    // Enforce max size: evict oldest completed/failed workflows.
    if (this.activeWorkflows.size > WorkflowEngine.MAX_TRACKED_WORKFLOWS) {
      this.cleanupCompletedWorkflows();
    }
  }

  /**
   * Remove completed and failed workflows that exceed the max size limit,
   * starting with the earliest entries (insertion order).
   */
  cleanupCompletedWorkflows(): void {
    const targetSize = Math.floor(WorkflowEngine.MAX_TRACKED_WORKFLOWS * 0.75);
    for (const [id, status] of this.activeWorkflows) {
      if (this.activeWorkflows.size <= targetSize) break;
      if (status === 'completed' || status === 'failed') {
        this.activeWorkflows.delete(id);
        const timer = this.cleanupTimers.get(id);
        if (timer) {
          clearTimeout(timer);
          this.cleanupTimers.delete(id);
        }
      }
    }
  }

  // ── Workflow: Brief to Deck ───────────────────────────────────────────────

  /**
   * Create a polished slide deck from a text brief.
   *
   * Pipeline:
   * 1. Parse the brief into structured Markdown
   * 2. Create a presentation from the Markdown
   * 3. Apply a professional theme
   * 4. Polish each slide (screenshot -> analyze -> fix)
   *
   * @param brief - Text description of the desired deck content.
   * @param slideCount - Target number of slides (default: auto).
   * @param onProgress - Optional progress callback.
   * @param themeName - Theme to apply (default: "corporate").
   * @returns Workflow result with the pipeline output.
   */
  async briefToDeck(
    brief: string,
    slideCount?: number,
    onProgress?: ProgressCallback,
    themeName: string = 'corporate',
  ): Promise<WorkflowResult<PipelineResult>> {
    const workflowId = this.generateWorkflowId('brief-to-deck');
    const startTime = Date.now();
    this.activeWorkflows.set(workflowId, 'running');

    log.info('Starting brief-to-deck workflow', {
      workflowId,
      briefLength: brief.length,
      slideCount,
      themeName,
    });

    try {
      // Step 1: Generate Markdown from brief
      this.reportProgress(onProgress, workflowId, 'Generating slide structure from brief', 0.1, 1, 4);
      const { title, markdown } = generateMarkdownFromBrief(brief, slideCount);

      // Step 2: Create presentation from Markdown
      this.reportProgress(onProgress, workflowId, 'Creating presentation from Markdown', 0.3, 2, 4);

      // Step 3+4: Create with theme and polish (handled by orchestrator)
      this.reportProgress(onProgress, workflowId, 'Applying theme and creating slides', 0.5, 3, 4);

      const result = await this.orchestrator.createAndPolish(title, markdown, themeName);

      this.reportProgress(onProgress, workflowId, 'Workflow complete', 1.0, 4, 4);
      this.activeWorkflows.set(workflowId, 'completed');
      this.scheduleWorkflowCleanup(workflowId);

      log.info('Brief-to-deck workflow complete', {
        workflowId,
        presentationId: result.presentationId,
        slideCount: result.slideCount,
        durationMs: Date.now() - startTime,
      });

      return {
        success: true,
        data: result,
        durationMs: Date.now() - startTime,
        workflowId,
      };
    } catch (error) {
      this.activeWorkflows.set(workflowId, 'failed');
      this.scheduleWorkflowCleanup(workflowId);
      const message = error instanceof Error ? error.message : String(error);
      log.error('Brief-to-deck workflow failed', { workflowId, error: message });

      return {
        success: false,
        error: message,
        durationMs: Date.now() - startTime,
        workflowId,
      };
    }
  }

  // ── Workflow: Import and Polish ───────────────────────────────────────────

  /**
   * Take an existing presentation, analyze it, and fix design issues.
   *
   * @param presentationId - The ID of an existing presentation.
   * @param onProgress - Optional progress callback.
   * @returns Workflow result with polish details.
   */
  async importAndPolish(
    presentationId: string,
    onProgress?: ProgressCallback,
  ): Promise<WorkflowResult<{ polishResults: PolishResult[]; presentationUrl: string }>> {
    const workflowId = this.generateWorkflowId('import-and-polish');
    const startTime = Date.now();
    this.activeWorkflows.set(workflowId, 'running');

    log.info('Starting import-and-polish workflow', { workflowId, presentationId });

    try {
      // Step 1: Verify the presentation exists and get slide count
      this.reportProgress(onProgress, workflowId, 'Fetching presentation info', 0.1, 1, 3);
      const pres = await apiClient.getPresentation(presentationId);
      const slideCount = pres.slides?.length ?? 0;

      if (slideCount === 0) {
        throw new Error('Presentation has no slides to polish');
      }

      // Step 2: Polish all slides
      this.reportProgress(onProgress, workflowId, `Polishing ${slideCount} slides`, 0.3, 2, 3);
      const polishResults = await this.orchestrator.polishPresentation(presentationId);

      // Step 3: Done
      this.reportProgress(onProgress, workflowId, 'Polish complete', 1.0, 3, 3);
      this.activeWorkflows.set(workflowId, 'completed');
      this.scheduleWorkflowCleanup(workflowId);

      const url = `https://docs.google.com/presentation/d/${presentationId}/edit`;

      log.info('Import-and-polish workflow complete', {
        workflowId,
        presentationId,
        slidesPolished: polishResults.length,
        durationMs: Date.now() - startTime,
      });

      return {
        success: true,
        data: { polishResults, presentationUrl: url },
        durationMs: Date.now() - startTime,
        workflowId,
      };
    } catch (error) {
      this.activeWorkflows.set(workflowId, 'failed');
      this.scheduleWorkflowCleanup(workflowId);
      const message = error instanceof Error ? error.message : String(error);
      log.error('Import-and-polish workflow failed', { workflowId, error: message });

      return {
        success: false,
        error: message,
        durationMs: Date.now() - startTime,
        workflowId,
      };
    }
  }

  // ── Workflow: Batch Polish ────────────────────────────────────────────────

  /**
   * Polish multiple presentations in sequence.
   *
   * @param presentationIds - Array of presentation IDs to polish.
   * @param onProgress - Optional progress callback.
   * @returns Workflow result with per-presentation outcomes.
   */
  async batchPolish(
    presentationIds: string[],
    onProgress?: ProgressCallback,
  ): Promise<WorkflowResult<BatchPolishResult>> {
    const workflowId = this.generateWorkflowId('batch-polish');
    const startTime = Date.now();
    this.activeWorkflows.set(workflowId, 'running');

    log.info('Starting batch-polish workflow', {
      workflowId,
      presentationCount: presentationIds.length,
    });

    const batchResult: BatchPolishResult = {
      total: presentationIds.length,
      succeeded: 0,
      failed: 0,
      results: [],
    };

    try {
      for (let i = 0; i < presentationIds.length; i++) {
        const presId = presentationIds[i]!;
        const progressFraction = (i + 0.5) / presentationIds.length;

        this.reportProgress(
          onProgress,
          workflowId,
          `Polishing presentation ${i + 1} of ${presentationIds.length}`,
          progressFraction,
          i + 1,
          presentationIds.length,
        );

        try {
          const polishResults = await this.orchestrator.polishPresentation(presId);
          batchResult.succeeded++;
          batchResult.results.push({
            presentationId: presId,
            success: true,
            polishResults,
          });
        } catch (error) {
          batchResult.failed++;
          batchResult.results.push({
            presentationId: presId,
            success: false,
            error: error instanceof Error ? error.message : String(error),
          });
          log.warn('Batch item failed, continuing', { presentationId: presId });
        }
      }

      this.reportProgress(onProgress, workflowId, 'Batch polish complete', 1.0, presentationIds.length, presentationIds.length);
      this.activeWorkflows.set(workflowId, 'completed');
      this.scheduleWorkflowCleanup(workflowId);

      log.info('Batch-polish workflow complete', {
        workflowId,
        succeeded: batchResult.succeeded,
        failed: batchResult.failed,
        durationMs: Date.now() - startTime,
      });

      return {
        success: true,
        data: batchResult,
        durationMs: Date.now() - startTime,
        workflowId,
      };
    } catch (error) {
      this.activeWorkflows.set(workflowId, 'failed');
      this.scheduleWorkflowCleanup(workflowId);
      const message = error instanceof Error ? error.message : String(error);

      return {
        success: false,
        error: message,
        durationMs: Date.now() - startTime,
        workflowId,
      };
    }
  }

  // ── Workflow: Slide-by-Slide Review ───────────────────────────────────────

  /**
   * Iterative slide-by-slide review with detailed per-slide progress.
   *
   * For each slide:
   * 1. Navigate to slide (browser)
   * 2. Take screenshot
   * 3. Analyze design
   * 4. Generate and apply fixes
   * 5. Re-screenshot and re-analyze to verify improvement
   *
   * @param presentationId - The presentation to review.
   * @param onProgress - Optional progress callback (called per slide).
   * @returns Detailed review result.
   */
  async slideBySlideReview(
    presentationId: string,
    onProgress?: ProgressCallback,
  ): Promise<WorkflowResult<SlideReviewResult>> {
    const workflowId = this.generateWorkflowId('slide-review');
    const startTime = Date.now();
    this.activeWorkflows.set(workflowId, 'running');

    log.info('Starting slide-by-slide review', { workflowId, presentationId });

    try {
      const pres = await apiClient.getPresentation(presentationId);
      const slides = pres.slides ?? [];

      if (slides.length === 0) {
        throw new Error('Presentation has no slides');
      }

      const totalSteps = slides.length * 2; // analyze + fix for each slide
      const reviews: PolishResult[] = [];

      for (let i = 0; i < slides.length; i++) {
        const slide = slides[i]!;
        const slideId = slide.objectId!;

        // Analyze step
        this.reportProgress(
          onProgress,
          workflowId,
          `Analyzing slide ${i + 1} of ${slides.length}`,
          (i * 2) / totalSteps,
          i * 2 + 1,
          totalSteps,
          { slideId, slideIndex: i, phase: 'analyze' },
        );

        // Fix step
        this.reportProgress(
          onProgress,
          workflowId,
          `Fixing slide ${i + 1} of ${slides.length}`,
          (i * 2 + 1) / totalSteps,
          i * 2 + 2,
          totalSteps,
          { slideId, slideIndex: i, phase: 'fix' },
        );

        const polishResult = await this.orchestrator.polishSlide(
          presentationId,
          slideId,
          i,
          2, // 2 iterations per slide
        );
        reviews.push(polishResult);
      }

      // Calculate summary stats
      const validReviews = reviews.filter((r) => r.beforeScore >= 0);
      const avgBefore = validReviews.length > 0
        ? Math.round(validReviews.reduce((s, r) => s + r.beforeScore, 0) / validReviews.length)
        : 0;
      const avgAfter = validReviews.length > 0
        ? Math.round(validReviews.reduce((s, r) => s + r.afterScore, 0) / validReviews.length)
        : 0;
      const totalFixed = reviews.reduce((s, r) => s + r.issuesFixed, 0);

      this.reportProgress(onProgress, workflowId, 'Review complete', 1.0, totalSteps, totalSteps);
      this.activeWorkflows.set(workflowId, 'completed');
      this.scheduleWorkflowCleanup(workflowId);

      const result: SlideReviewResult = {
        presentationId,
        slideCount: slides.length,
        reviews,
        averageScoreBefore: avgBefore,
        averageScoreAfter: avgAfter,
        totalIssuesFixed: totalFixed,
      };

      log.info('Slide-by-slide review complete', {
        workflowId,
        presentationId,
        slideCount: slides.length,
        avgBefore,
        avgAfter,
        totalFixed,
        durationMs: Date.now() - startTime,
      });

      return {
        success: true,
        data: result,
        durationMs: Date.now() - startTime,
        workflowId,
      };
    } catch (error) {
      this.activeWorkflows.set(workflowId, 'failed');
      this.scheduleWorkflowCleanup(workflowId);
      const message = error instanceof Error ? error.message : String(error);

      return {
        success: false,
        error: message,
        durationMs: Date.now() - startTime,
        workflowId,
      };
    }
  }

  // ── Status Tracking ───────────────────────────────────────────────────────

  /**
   * Get the status of a specific workflow by ID.
   */
  getWorkflowStatus(workflowId: string): WorkflowStatus | undefined {
    return this.activeWorkflows.get(workflowId);
  }

  /**
   * Get all active workflow statuses.
   */
  getAllWorkflowStatuses(): Map<string, WorkflowStatus> {
    return new Map(this.activeWorkflows);
  }

  // ── Private Helpers ───────────────────────────────────────────────────────

  private generateWorkflowId(prefix: string): string {
    this.workflowCounter++;
    const ts = Date.now().toString(36);
    return `${prefix}-${ts}-${this.workflowCounter}`;
  }

  private reportProgress(
    onProgress: ProgressCallback | undefined,
    workflowId: string,
    step: string,
    progress: number,
    currentStep: number,
    totalSteps: number,
    detail?: unknown,
  ): void {
    if (onProgress) {
      try {
        onProgress({ workflowId, step, progress, currentStep, totalSteps, detail });
      } catch (error) {
        log.warn('Progress callback threw', {
          error: error instanceof Error ? error.message : String(error),
        });
      }
    }
    log.debug('Workflow progress', { workflowId, step, progress: Math.round(progress * 100) });
  }
}
