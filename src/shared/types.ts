/**
 * @module shared/types
 * @description Core type definitions for the Google Slides Hybrid MCP server.
 * Covers all three layers: API, Browser, and Vision — plus shared operational types.
 */

// ─────────────────────────────────────────────────────────────────────────────
// MCP Layer Enum
// ─────────────────────────────────────────────────────────────────────────────

/** Identifies which operational layer a request or error originates from. */
export enum MCPLayer {
  /** Google Slides REST API layer */
  API = 'api',
  /** Chrome DevTools / browser automation layer */
  BROWSER = 'browser',
  /** Vision-based analysis and design critique layer */
  VISION = 'vision',
}

// ─────────────────────────────────────────────────────────────────────────────
// Slide Element Types
// ─────────────────────────────────────────────────────────────────────────────

/** Supported element types within a Google Slide. */
export type SlideElementType =
  | 'shape'
  | 'text'
  | 'image'
  | 'table'
  | 'chart'
  | 'video'
  | 'line'
  | 'group'
  | 'sheetsChart'
  | 'wordArt';

/** Absolute position and dimensions of an element in EMU (English Metric Units) or points. */
export interface ElementPosition {
  /** Horizontal offset from the left edge, in points. */
  x: number;
  /** Vertical offset from the top edge, in points. */
  y: number;
  /** Width of the element, in points. */
  width: number;
  /** Height of the element, in points. */
  height: number;
}

/** Style properties that can be applied to a slide element. */
export interface ElementStyles {
  /** Font family name (e.g. "Roboto", "Arial"). */
  fontFamily?: string;
  /** Font size in points. */
  fontSize?: number;
  /** Whether the text is bold. */
  bold?: boolean;
  /** Whether the text is italic. */
  italic?: boolean;
  /** Whether the text is underlined. */
  underline?: boolean;
  /** Foreground (text) color as a hex string (e.g. "#000000"). */
  foregroundColor?: string;
  /** Background fill color as a hex string. */
  backgroundColor?: string;
  /** Text alignment within the element. */
  alignment?: 'START' | 'CENTER' | 'END' | 'JUSTIFIED';
  /** Line spacing multiplier (e.g. 1.15). */
  lineSpacing?: number;
  /** Space above the paragraph, in points. */
  spaceAbove?: number;
  /** Space below the paragraph, in points. */
  spaceBelow?: number;
  /** Border/outline color as a hex string. */
  borderColor?: string;
  /** Border weight in points. */
  borderWeight?: number;
  /** Opacity value from 0 (transparent) to 1 (opaque). */
  opacity?: number;
}

/** A single element on a Google Slide. */
export interface SlideElement {
  /** The unique object ID of this element in the presentation. */
  id: string;
  /** The kind of page element. */
  type: SlideElementType;
  /** Position and dimensions on the slide. */
  position: ElementPosition;
  /** Plain-text content (applicable to text / shape / wordArt elements). */
  text?: string;
  /** Source URL for image elements. */
  imageUrl?: string;
  /** The shape type identifier (e.g. "RECTANGLE", "ELLIPSE") for shape elements. */
  shapeType?: string;
  /** Optional styling applied to this element. */
  styles?: ElementStyles;
}

// ─────────────────────────────────────────────────────────────────────────────
// Slide & Presentation Types
// ─────────────────────────────────────────────────────────────────────────────

/** Full content representation of a single slide. */
export interface SlideContent {
  /** The unique page object ID for this slide. */
  slideId: string;
  /** Zero-based index of this slide in the presentation. */
  slideIndex: number;
  /** The title text extracted from this slide, if any. */
  title?: string;
  /** All page elements present on the slide. */
  elements: SlideElement[];
  /** Speaker notes attached to this slide. */
  notes?: string;
  /** The layout object ID this slide is based on. */
  layoutId?: string;
}

/** Top-level metadata and content of an entire presentation. */
export interface PresentationInfo {
  /** The unique presentation ID (from the Google Slides URL). */
  presentationId: string;
  /** The human-readable title of the presentation. */
  title: string;
  /** Total number of slides. */
  slideCount: number;
  /** Ordered list of all slides with their content. */
  slides: SlideContent[];
  /** Page width in points. */
  pageWidth: number;
  /** Page height in points. */
  pageHeight: number;
  /** Canonical URL to the presentation in Google Slides. */
  url: string;
}

// ─────────────────────────────────────────────────────────────────────────────
// MCP Tool Result
// ─────────────────────────────────────────────────────────────────────────────

/** A single content block returned in an MCP tool result. */
export interface ToolResultContent {
  /** The kind of content block. */
  type: 'text' | 'image';
  /** Text payload (for type = 'text'). */
  text?: string;
  /** Base64-encoded image data (for type = 'image'). */
  data?: string;
  /** MIME type of the image (for type = 'image'), e.g. "image/png". */
  mimeType?: string;
}

/**
 * Standard result shape returned by every MCP tool handler.
 * Conforms to the Model Context Protocol tool response contract.
 */
export interface ToolResult {
  /** One or more content blocks (text and/or images). */
  content: ToolResultContent[];
  /** When true the result represents an error rather than a success. */
  isError?: boolean;
}

// ─────────────────────────────────────────────────────────────────────────────
// Authentication
// ─────────────────────────────────────────────────────────────────────────────

/** OAuth 2.0 credentials needed to authenticate with Google APIs. */
export interface OAuthCredentials {
  /** The OAuth client ID from the Google Cloud Console. */
  clientId: string;
  /** The OAuth client secret from the Google Cloud Console. */
  clientSecret: string;
  /** A long-lived refresh token obtained via the OAuth consent flow. */
  refreshToken: string;
}

// ─────────────────────────────────────────────────────────────────────────────
// Browser Layer Types
// ─────────────────────────────────────────────────────────────────────────────

// ─────────────────────────────────────────────────────────────────────────────
// Vision / Design Analysis Types
// ─────────────────────────────────────────────────────────────────────────────

/** Categories of design issues the vision layer can detect. */
export type DesignIssueType =
  | 'alignment'
  | 'spacing'
  | 'color'
  | 'font'
  | 'hierarchy'
  | 'contrast'
  | 'balance';

/**
 * Severity levels for design issues.
 *
 * Convention: severity levels are informational — they indicate the impact
 * of a design problem on visual quality, **not** an execution error.
 * A "high" severity issue means the design is significantly impacted,
 * but the tool result's `isError` field is still `false`.  The `isError`
 * flag is reserved for actual execution failures (e.g. API errors,
 * invalid input) rather than design quality assessments.
 */
export type DesignIssueSeverity = 'low' | 'medium' | 'high';

/** A single design issue found during vision analysis. */
export interface DesignIssue {
  /** The category of design problem. */
  type: DesignIssueType;
  /** How impactful this issue is on overall design quality. */
  severity: DesignIssueSeverity;
  /** The element ID or description of the element affected, if applicable. */
  element?: string;
  /** Human-readable explanation of the issue. */
  description: string;
  /** Suggested fix or remediation, if available. */
  fix?: string;
}

/** Result of a vision-based design analysis pass. */
export interface VisionAnalysis {
  /** All design issues detected. */
  issues: DesignIssue[];
  /** Overall design quality score from 0 (worst) to 100 (best). */
  score: number;
  /** High-level actionable suggestions for improvement. */
  suggestions: string[];
}

// ─────────────────────────────────────────────────────────────────────────────
// Configuration Types
// ─────────────────────────────────────────────────────────────────────────────

/** Configuration for the Google Slides REST API layer. */
export interface ApiConfig {
  /** OAuth client ID. */
  clientId: string;
  /** OAuth client secret. */
  clientSecret: string;
  /** OAuth refresh token. */
  refreshToken: string;
}

/** Configuration for the browser automation layer. */
export interface BrowserConfig {
  /** Port for the Chrome DevTools Protocol WebSocket. */
  wsPort: number;
  /** Screenshot output format. */
  screenshotFormat: 'png' | 'jpeg' | 'webp';
  /** Default timeout for browser operations, in milliseconds. */
  timeout: number;
}

/** Configuration for the vision analysis layer. */
export interface VisionConfig {
  /** Whether vision analysis is enabled. */
  enabled: boolean;
  /** The model identifier to use for analysis (e.g. "claude-3-opus"). */
  analysisModel: string;
  /** Whether to automatically apply suggested fixes. */
  autoFix: boolean;
}

/** Root configuration object for the entire hybrid MCP server. */
export interface HybridConfig {
  /** Google Slides API layer configuration. */
  api: ApiConfig;
  /** Browser automation layer configuration. */
  browser: BrowserConfig;
  /** Vision analysis layer configuration. */
  vision: VisionConfig;
}

// ─────────────────────────────────────────────────────────────────────────────
// Generic Operation Result
// ─────────────────────────────────────────────────────────────────────────────

/**
 * A discriminated-union result type for operations that can succeed or fail.
 * Prefer this over throwing when the caller needs structured error context.
 */
export type OperationResult<T> =
  | {
      /** Indicates the operation completed successfully. */
      success: true;
      /** The result data. */
      data: T;
    }
  | {
      /** Indicates the operation failed. */
      success: false;
      /** A human-readable error message. */
      error: string;
      /** An optional error code for programmatic handling. */
      code?: string;
      /** The original error, if any. */
      cause?: Error;
    };

// ─────────────────────────────────────────────────────────────────────────────
// Retry Configuration
// ─────────────────────────────────────────────────────────────────────────────

/** Configuration for retry logic with exponential backoff. */
export interface RetryConfig {
  /** Maximum number of retry attempts (not counting the initial attempt). */
  maxRetries: number;
  /** Initial delay between retries, in milliseconds. */
  baseDelay: number;
  /** Maximum delay cap, in milliseconds. */
  maxDelay: number;
  /** Multiplier applied to the delay on each successive retry. */
  backoffFactor: number;
}

// ─────────────────────────────────────────────────────────────────────────────
// Batch Update Types (Google Slides API)
// ─────────────────────────────────────────────────────────────────────────────

/** A single request within a batchUpdate call to the Google Slides API. */
export interface BatchUpdateRequest {
  /** The request kind and payload (keyed by API method name). */
  [key: string]: unknown;
}

/** Payload for a batchUpdate API call. */
export interface BatchUpdatePayload {
  /** Ordered list of mutation requests to apply atomically. */
  requests: BatchUpdateRequest[];
}

// ─────────────────────────────────────────────────────────────────────────────
// Rate Limit Types
// ─────────────────────────────────────────────────────────────────────────────

/** Configuration for the rate limiter. */
export interface RateLimitConfig {
  /** Maximum number of requests allowed per interval. */
  maxRequests: number;
  /** Time window in milliseconds. */
  intervalMs: number;
  /** Maximum number of concurrent in-flight requests. */
  maxConcurrent: number;
}

// ─────────────────────────────────────────────────────────────────────────────
// Markdown → Slides Types
// ─────────────────────────────────────────────────────────────────────────────

/** Parsed markdown slide content ready for conversion. */
export interface MarkdownSlide {
  /** Slide heading / title. */
  title: string;
  /** Body content lines. */
  body: string[];
  /** Speaker notes, if a notes section was found. */
  notes?: string;
  /** Layout hint derived from markdown conventions. */
  layout?: string;
}
