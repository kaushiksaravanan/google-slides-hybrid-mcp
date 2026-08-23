/**
 * @module sdk/index
 * @description Standalone TypeScript client SDK for the Google Slides Hybrid MCP REST API.
 *
 * Uses the native `fetch` API with no external HTTP dependencies.
 * Handles authentication (API key or bearer token), automatic retry with
 * exponential backoff on 429 responses, and typed error classes.
 *
 * @example
 * ```ts
 * import { GoogleSlidesHybridClient } from './sdk/index.js';
 *
 * const client = new GoogleSlidesHybridClient({
 *   baseUrl: 'https://api.example.com',
 *   apiKey: 'my-api-key',
 * });
 *
 * const pres = await client.createPresentation({ title: 'Q4 Results' });
 * console.log(pres.presentationId, pres.url);
 * ```
 */

import {
  ApiError,
  RateLimitError,
  AuthenticationError,
  NotFoundError,
  ValidationError,
} from './errors.js';
import type { ValidationField } from './errors.js';

import type {
  ClientConfig,
  ApiEnvelope,
  PresentationResponse,
  SlideResponse,
  ShareResponse,
  TemplateResponse,
  TemplateListResponse,
  AnalysisResponse,
  PolishResponse,
  PreviewResponse,
  ExportPdfResponse,
  CreatePresentationOptions,
  UpdatePresentationOptions,
  AddSlideOptions,
  DuplicateSlideOptions,
  AnalyzeOptions,
  PolishOptions,
  ApplyTemplateOptions,
} from './types.js';

// ─────────────────────────────────────────────────────────────────────────────
// Helpers
// ─────────────────────────────────────────────────────────────────────────────

/** Extract a flat record of header values from a Headers object. */
function headersToRecord(headers: Headers): Record<string, string> {
  const record: Record<string, string> = {};
  headers.forEach((value, key) => {
    record[key] = value;
  });
  return record;
}

/** Sleep for the given number of milliseconds. */
function sleep(ms: number): Promise<void> {
  return new Promise((resolve) => setTimeout(resolve, ms));
}

// ─────────────────────────────────────────────────────────────────────────────
// Client
// ─────────────────────────────────────────────────────────────────────────────

/**
 * Typed client for the Google Slides Hybrid MCP REST API.
 *
 * Supports both `X-API-Key` and `Authorization: Bearer` authentication.
 * Automatically retries rate-limited requests with exponential backoff.
 */
export class GoogleSlidesHybridClient {
  private readonly baseUrl: string;
  private readonly apiKey?: string;
  private readonly bearerToken?: string;
  private readonly maxRetries: number;
  private readonly retryBaseDelay: number;
  private readonly timeout: number;

  constructor(config: ClientConfig) {
    // Strip trailing slash from baseUrl
    this.baseUrl = config.baseUrl.replace(/\/+$/, '');
    this.apiKey = config.apiKey;
    this.bearerToken = config.bearerToken;
    this.maxRetries = config.maxRetries ?? 3;
    this.retryBaseDelay = config.retryBaseDelay ?? 1000;
    this.timeout = config.timeout ?? 30_000;
  }

  // ───────────────────────────────────────────────────────────────────────
  // Internal HTTP
  // ───────────────────────────────────────────────────────────────────────

  /**
   * Build the full URL for a given API path.
   * All REST endpoints live under `/api/v1`.
   */
  private url(path: string): string {
    const cleanPath = path.startsWith('/') ? path : `/${path}`;
    return `${this.baseUrl}/api/v1${cleanPath}`;
  }

  /** Build common headers including auth. */
  private buildHeaders(extra?: Record<string, string>): Record<string, string> {
    const headers: Record<string, string> = {
      'Content-Type': 'application/json',
      Accept: 'application/json',
      ...extra,
    };

    if (this.apiKey) {
      headers['X-API-Key'] = this.apiKey;
    }
    if (this.bearerToken) {
      headers['Authorization'] = `Bearer ${this.bearerToken}`;
    }

    return headers;
  }

  /**
   * Execute an HTTP request with automatic retry on 429.
   *
   * @returns The parsed {@link ApiEnvelope} body.
   * @throws {ApiError} (or a subclass) on non-2xx responses.
   */
  private async request<T>(
    method: string,
    path: string,
    body?: unknown,
  ): Promise<T> {
    const requestUrl = this.url(path);
    const headers = this.buildHeaders();

    let lastError: ApiError | undefined;

    for (let attempt = 0; attempt <= this.maxRetries; attempt++) {
      const controller = new AbortController();
      const timeoutId = setTimeout(() => controller.abort(), this.timeout);

      let response: Response;
      try {
        response = await fetch(requestUrl, {
          method,
          headers,
          body: body !== undefined ? JSON.stringify(body) : undefined,
          signal: controller.signal,
        });
      } catch (err) {
        clearTimeout(timeoutId);
        // Network or abort errors
        const message = err instanceof Error ? err.message : String(err);
        throw new ApiError(0, `Network error: ${message}`);
      } finally {
        clearTimeout(timeoutId);
      }

      const responseHeaders = headersToRecord(response.headers);

      // Parse body (may be empty for 204)
      let responseBody: unknown;
      const contentType = response.headers.get('content-type') ?? '';
      if (contentType.includes('application/json')) {
        try {
          responseBody = await response.json();
        } catch {
          responseBody = undefined;
        }
      } else {
        const text = await response.text();
        responseBody = text || undefined;
      }

      // Success
      if (response.ok) {
        const envelope = responseBody as ApiEnvelope<T> | undefined;
        // If response follows envelope format, unwrap data
        if (envelope && typeof envelope === 'object' && 'success' in envelope) {
          if (envelope.success && envelope.data !== undefined) {
            return envelope.data;
          }
          // success: true but no data field — return the whole body as T
          if (envelope.success) {
            return envelope as unknown as T;
          }
        }
        // Non-envelope 2xx — return raw body
        return responseBody as T;
      }

      // Rate limited — retry with backoff
      if (response.status === 429) {
        const retryAfterHeader = responseHeaders['retry-after'];
        const retryAfterSeconds = retryAfterHeader
          ? parseInt(retryAfterHeader, 10)
          : 0;

        const rateLimitErr = new RateLimitError(
          this.extractErrorMessage(responseBody, 'Rate limit exceeded'),
          retryAfterSeconds || Math.ceil((this.retryBaseDelay * Math.pow(2, attempt)) / 1000),
          responseBody,
          responseHeaders,
        );

        if (attempt < this.maxRetries) {
          // Exponential backoff: use Retry-After header or calculated delay
          const delayMs = retryAfterSeconds > 0
            ? retryAfterSeconds * 1000
            : this.retryBaseDelay * Math.pow(2, attempt);
          await sleep(delayMs);
          lastError = rateLimitErr;
          continue;
        }

        throw rateLimitErr;
      }

      // Auth errors
      if (response.status === 401 || response.status === 403) {
        throw new AuthenticationError(
          response.status,
          this.extractErrorMessage(responseBody, 'Authentication failed'),
          responseBody,
          responseHeaders,
        );
      }

      // Not found
      if (response.status === 404) {
        throw new NotFoundError(
          this.extractErrorMessage(responseBody, 'Resource not found'),
          responseBody,
          responseHeaders,
        );
      }

      // Validation error
      if (response.status === 400) {
        const fields = this.extractValidationFields(responseBody);
        throw new ValidationError(
          this.extractErrorMessage(responseBody, 'Validation error'),
          fields,
          responseBody,
          responseHeaders,
        );
      }

      // All other errors
      throw new ApiError(
        response.status,
        this.extractErrorMessage(responseBody, `HTTP ${response.status} error`),
        responseBody,
        responseHeaders,
      );
    }

    // Exhausted retries (should only reach here for 429)
    throw lastError ?? new ApiError(0, 'Request failed after retries');
  }

  /** Extract an error message from the standard API envelope. */
  private extractErrorMessage(body: unknown, fallback: string): string {
    if (body && typeof body === 'object') {
      const envelope = body as ApiEnvelope;
      if (envelope.error?.message) {
        return envelope.error.message;
      }
    }
    return fallback;
  }

  /** Extract validation field errors from the standard API envelope. */
  private extractValidationFields(body: unknown): ValidationField[] {
    if (body && typeof body === 'object') {
      const envelope = body as ApiEnvelope;
      if (Array.isArray(envelope.error?.details)) {
        return (envelope.error.details as Array<{ path?: string; message?: string }>).map((d) => ({
          path: d.path ?? '',
          message: d.message ?? '',
        }));
      }
    }
    return [];
  }

  // ───────────────────────────────────────────────────────────────────────
  // Presentations
  // ───────────────────────────────────────────────────────────────────────

  /**
   * Create a new presentation.
   *
   * @param options - Title, optional markdown content, theme, and polish flag.
   * @returns The created presentation details.
   */
  async createPresentation(options: CreatePresentationOptions): Promise<PresentationResponse> {
    return this.request<PresentationResponse>('POST', '/presentations', options);
  }

  /**
   * Get presentation details by ID.
   *
   * @param id - The presentation ID.
   * @returns Presentation metadata and slide contents.
   */
  async getPresentation(id: string): Promise<PresentationResponse> {
    return this.request<PresentationResponse>('GET', `/presentations/${encodeURIComponent(id)}`);
  }

  /**
   * Update an existing presentation.
   *
   * @param id - The presentation ID.
   * @param updates - Fields to update (title, markdown).
   * @returns The updated presentation details.
   */
  async updatePresentation(id: string, updates: UpdatePresentationOptions): Promise<PresentationResponse> {
    return this.request<PresentationResponse>('PUT', `/presentations/${encodeURIComponent(id)}`, updates);
  }

  /**
   * Delete a presentation.
   *
   * @param id - The presentation ID.
   */
  async deletePresentation(id: string): Promise<void> {
    await this.request<void>('DELETE', `/presentations/${encodeURIComponent(id)}`);
  }

  /**
   * Add a new slide to a presentation.
   *
   * @param presentationId - The presentation ID.
   * @param options - Layout, insertion index, and content options.
   * @returns The newly created slide.
   */
  async addSlide(presentationId: string, options?: AddSlideOptions): Promise<SlideResponse> {
    return this.request<SlideResponse>(
      'POST',
      `/presentations/${encodeURIComponent(presentationId)}/slides`,
      options ?? {},
    );
  }

  /**
   * Get a specific slide from a presentation.
   *
   * @param presentationId - The presentation ID.
   * @param slideId - The slide's page object ID.
   * @returns The slide details.
   */
  async getSlide(presentationId: string, slideId: string): Promise<SlideResponse> {
    return this.request<SlideResponse>(
      'GET',
      `/presentations/${encodeURIComponent(presentationId)}/slides/${encodeURIComponent(slideId)}`,
    );
  }

  /**
   * Delete a slide from a presentation.
   *
   * @param presentationId - The presentation ID.
   * @param slideId - The slide's page object ID.
   */
  async deleteSlide(presentationId: string, slideId: string): Promise<void> {
    await this.request<void>(
      'DELETE',
      `/presentations/${encodeURIComponent(presentationId)}/slides/${encodeURIComponent(slideId)}`,
    );
  }

  /**
   * Duplicate a slide within a presentation.
   *
   * @param presentationId - The presentation ID.
   * @param slideId - The slide's page object ID to duplicate.
   * @param options - Optional insertion index for the duplicate.
   * @returns The duplicated slide.
   */
  async duplicateSlide(
    presentationId: string,
    slideId: string,
    options?: DuplicateSlideOptions,
  ): Promise<SlideResponse> {
    return this.request<SlideResponse>(
      'POST',
      `/presentations/${encodeURIComponent(presentationId)}/slides/${encodeURIComponent(slideId)}/duplicate`,
      options ?? {},
    );
  }

  /**
   * Export a presentation to PDF.
   *
   * @param presentationId - The presentation ID.
   * @returns An object containing the download URL.
   */
  async exportPdf(presentationId: string): Promise<ExportPdfResponse> {
    return this.request<ExportPdfResponse>(
      'GET',
      `/presentations/${encodeURIComponent(presentationId)}/export/pdf`,
    );
  }

  /**
   * Share a presentation with a specific role.
   *
   * @param presentationId - The presentation ID.
   * @param role - The sharing role: 'reader', 'writer', or 'commenter'.
   * @returns Sharing details including the share URL.
   */
  async sharePresentation(
    presentationId: string,
    role: 'reader' | 'writer' | 'commenter',
  ): Promise<ShareResponse> {
    return this.request<ShareResponse>(
      'POST',
      `/presentations/${encodeURIComponent(presentationId)}/share`,
      { role },
    );
  }

  // ───────────────────────────────────────────────────────────────────────
  // Templates
  // ───────────────────────────────────────────────────────────────────────

  /**
   * List available templates and themes.
   *
   * @param category - Optional category to filter templates by.
   * @returns Array of template/theme entries.
   */
  async listTemplates(category?: string): Promise<TemplateResponse[]> {
    const path = category
      ? `/templates?category=${encodeURIComponent(category)}`
      : '/templates';
    const result = await this.request<TemplateListResponse>('GET', path);
    return result.templates;
  }

  /**
   * Apply a template/theme to an existing presentation.
   *
   * @param presentationId - The presentation to apply the template to.
   * @param templateId - The template/theme ID to apply.
   * @param variables - Optional variable substitution map.
   * @returns The updated presentation details.
   */
  async applyTemplate(
    presentationId: string,
    templateId: string,
    variables?: Record<string, string>,
  ): Promise<PresentationResponse> {
    return this.request<PresentationResponse>(
      'POST',
      `/templates/${encodeURIComponent(templateId)}/apply`,
      { presentationId, variables } satisfies ApplyTemplateOptions,
    );
  }

  // ───────────────────────────────────────────────────────────────────────
  // Vision / Analysis
  // ───────────────────────────────────────────────────────────────────────

  /**
   * Analyse the design quality of a presentation.
   *
   * @param presentationId - The presentation ID.
   * @param options - Optional slide index and check categories.
   * @returns Design issues, score, and suggestions.
   */
  async analyzePresentation(
    presentationId: string,
    options?: AnalyzeOptions,
  ): Promise<AnalysisResponse> {
    return this.request<AnalysisResponse>(
      'POST',
      `/presentations/${encodeURIComponent(presentationId)}/analyze`,
      options ?? {},
    );
  }

  /**
   * Auto-polish a presentation to improve design quality.
   *
   * @param presentationId - The presentation ID.
   * @param options - Optional maximum iterations.
   * @returns Polish results with before/after scores.
   */
  async polishPresentation(
    presentationId: string,
    options?: PolishOptions,
  ): Promise<PolishResponse> {
    return this.request<PolishResponse>(
      'POST',
      `/presentations/${encodeURIComponent(presentationId)}/polish`,
      options ?? {},
    );
  }

  /**
   * Apply a visual theme to a presentation.
   *
   * @param presentationId - The presentation ID.
   * @param theme - The theme name to apply.
   */
  async applyTheme(presentationId: string, theme: string): Promise<void> {
    await this.request<void>(
      'POST',
      `/presentations/${encodeURIComponent(presentationId)}/theme`,
      { theme },
    );
  }

  // ───────────────────────────────────────────────────────────────────────
  // Markdown
  // ───────────────────────────────────────────────────────────────────────

  /**
   * Preview how markdown will be parsed into slides without creating a presentation.
   *
   * @param markdown - The markdown content to preview.
   * @param title - Optional title for the preview.
   * @returns Parsed slide structure.
   */
  async previewMarkdown(markdown: string, title?: string): Promise<PreviewResponse> {
    return this.request<PreviewResponse>('POST', '/markdown/preview', { markdown, title });
  }

  /**
   * Create a new presentation from markdown content.
   *
   * @param title - Presentation title.
   * @param markdown - Markdown content to convert to slides.
   * @param options - Optional theme and polish settings.
   * @returns The created presentation details.
   */
  async createFromMarkdown(
    title: string,
    markdown: string,
    options?: { theme?: string; polish?: boolean },
  ): Promise<PresentationResponse> {
    return this.request<PresentationResponse>('POST', '/markdown/create', {
      title,
      markdown,
      ...options,
    });
  }
}

// ─────────────────────────────────────────────────────────────────────────────
// Re-exports
// ─────────────────────────────────────────────────────────────────────────────

export type {
  ClientConfig,
  ApiEnvelope,
  PresentationResponse,
  SlideResponse,
  ShareResponse,
  TemplateResponse,
  TemplateListResponse,
  AnalysisResponse,
  PolishResponse,
  PreviewResponse,
  ExportPdfResponse,
  CreatePresentationOptions,
  UpdatePresentationOptions,
  AddSlideOptions,
  DuplicateSlideOptions,
  AnalyzeOptions,
  PolishOptions,
  ApplyTemplateOptions,
  SlideContent,
  SlideElement,
  ElementPosition,
  ElementStyles,
  DesignIssue,
  PolishSlideResult,
  MarkdownSlidePreview,
} from './types.js';

export {
  ApiError,
  RateLimitError,
  AuthenticationError,
  NotFoundError,
  ValidationError,
} from './errors.js';
export type { ValidationField } from './errors.js';
