/**
 * @module sdk/types
 * @description Request and response type definitions for the
 * Google Slides Hybrid MCP client SDK.
 *
 * All types mirror the JSON shapes returned by the REST API and are
 * fully standalone — no imports from the server codebase.
 */

// ─────────────────────────────────────────────────────────────────────────────
// Standard API Envelope
// ─────────────────────────────────────────────────────────────────────────────

/** Standard JSON envelope returned by every API endpoint. */
export interface ApiEnvelope<T = unknown> {
  success: boolean;
  data?: T;
  error?: {
    code: string;
    message: string;
    details?: unknown;
  };
  meta?: Record<string, unknown>;
}

// ─────────────────────────────────────────────────────────────────────────────
// Client Configuration
// ─────────────────────────────────────────────────────────────────────────────

/** Configuration for the SDK client. */
export interface ClientConfig {
  /** Base URL of the API server (e.g. "https://api.example.com"). */
  baseUrl: string;
  /** API key for X-API-Key header authentication. */
  apiKey?: string;
  /** Bearer token for Authorization header authentication. */
  bearerToken?: string;
  /** Maximum number of automatic retries on 429 responses (default: 3). */
  maxRetries?: number;
  /** Base delay in milliseconds for exponential backoff (default: 1000). */
  retryBaseDelay?: number;
  /** Request timeout in milliseconds (default: 30000). */
  timeout?: number;
}

// ─────────────────────────────────────────────────────────────────────────────
// Slide Element Types
// ─────────────────────────────────────────────────────────────────────────────

/** Position and dimensions of an element on a slide. */
export interface ElementPosition {
  x: number;
  y: number;
  width: number;
  height: number;
}

/** Styling applied to a slide element. */
export interface ElementStyles {
  fontFamily?: string;
  fontSize?: number;
  bold?: boolean;
  italic?: boolean;
  underline?: boolean;
  foregroundColor?: string;
  backgroundColor?: string;
  alignment?: 'START' | 'CENTER' | 'END' | 'JUSTIFIED';
  lineSpacing?: number;
  spaceAbove?: number;
  spaceBelow?: number;
  borderColor?: string;
  borderWeight?: number;
  opacity?: number;
}

/** A single element on a Google Slide. */
export interface SlideElement {
  id: string;
  type: string;
  position: ElementPosition;
  text?: string;
  imageUrl?: string;
  shapeType?: string;
  styles?: ElementStyles;
}

// ─────────────────────────────────────────────────────────────────────────────
// Presentation & Slide Types
// ─────────────────────────────────────────────────────────────────────────────

/** Full content of a single slide. */
export interface SlideContent {
  slideId: string;
  slideIndex: number;
  title?: string;
  elements: SlideElement[];
  notes?: string;
  layoutId?: string;
}

/** Response returned when fetching or creating a presentation. */
export interface PresentationResponse {
  presentationId: string;
  title: string;
  slideCount: number;
  slides: SlideContent[];
  pageWidth: number;
  pageHeight: number;
  url: string;
  [key: string]: unknown;
}

/** Response returned when operating on a single slide. */
export interface SlideResponse {
  slideId: string;
  slideIndex?: number;
  title?: string;
  elements?: SlideElement[];
  notes?: string;
  layoutId?: string;
  [key: string]: unknown;
}

/** Response returned when sharing a presentation. */
export interface ShareResponse {
  presentationId: string;
  role: string;
  shareUrl?: string;
  [key: string]: unknown;
}

// ─────────────────────────────────────────────────────────────────────────────
// Template Types
// ─────────────────────────────────────────────────────────────────────────────

/** A single template / theme entry. */
export interface TemplateResponse {
  id: string;
  name: string;
  description: string;
  colors?: Record<string, string>;
  category?: string;
  tags?: string[];
}

/** Response from listing templates. */
export interface TemplateListResponse {
  templates: TemplateResponse[];
  count: number;
}

// ─────────────────────────────────────────────────────────────────────────────
// Vision / Analysis Types
// ─────────────────────────────────────────────────────────────────────────────

/** A single design issue found during analysis. */
export interface DesignIssue {
  type: string;
  severity: 'low' | 'medium' | 'high';
  element?: string;
  description: string;
  fix?: string;
}

/** Response from analysing a presentation's design quality. */
export interface AnalysisResponse {
  issues: DesignIssue[];
  score: number;
  suggestions: string[];
  [key: string]: unknown;
}

/** Result for a single polished slide. */
export interface PolishSlideResult {
  slideIndex: number;
  beforeScore: number;
  afterScore: number;
  fixes: string[];
}

/** Response from auto-polishing a presentation. */
export interface PolishResponse {
  presentationId: string;
  slidesPolished: number;
  results: PolishSlideResult[];
  overallScoreBefore?: number;
  overallScoreAfter?: number;
}

// ─────────────────────────────────────────────────────────────────────────────
// Markdown Types
// ─────────────────────────────────────────────────────────────────────────────

/** Preview entry for a single slide parsed from markdown. */
export interface MarkdownSlidePreview {
  index: number;
  title: string;
  bodyLines: number;
  hasNotes: boolean;
  layout: string;
}

/** Response from previewing markdown without creating a presentation. */
export interface PreviewResponse {
  title: string;
  slideCount: number;
  slides: MarkdownSlidePreview[];
}

// ─────────────────────────────────────────────────────────────────────────────
// Export PDF Types
// ─────────────────────────────────────────────────────────────────────────────

/** Response from exporting a presentation to PDF. */
export interface ExportPdfResponse {
  url: string;
  [key: string]: unknown;
}

// ─────────────────────────────────────────────────────────────────────────────
// Request Option Types
// ─────────────────────────────────────────────────────────────────────────────

/** Options for creating a new presentation. */
export interface CreatePresentationOptions {
  title: string;
  markdown?: string;
  theme?: string;
  polish?: boolean;
}

/** Options for updating an existing presentation. */
export interface UpdatePresentationOptions {
  title?: string;
  markdown?: string;
}

/** Options for adding a slide. */
export interface AddSlideOptions {
  layoutId?: string;
  insertionIndex?: number;
  content?: {
    title?: string;
    body?: string;
  };
}

/** Options for duplicating a slide. */
export interface DuplicateSlideOptions {
  insertionIndex?: number;
}

/** Options for analysing a presentation. */
export interface AnalyzeOptions {
  slideIndex?: number;
  checks?: string[];
}

/** Options for polishing a presentation. */
export interface PolishOptions {
  maxIterations?: number;
}

/** Options for applying a template. */
export interface ApplyTemplateOptions {
  presentationId: string;
  variables?: Record<string, string>;
}
