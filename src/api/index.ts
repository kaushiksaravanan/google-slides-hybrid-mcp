/**
 * @module api
 * @description Public API for the Google Slides REST API layer.
 *
 * Re-exports all public types, classes, and functions from the API
 * sub-modules so that consumers can import from a single entry point:
 *
 * ```ts
 * import {
 *   getAuthenticatedClient,
 *   createPresentation,
 *   apiTools,
 *   executeApiTool,
 * } from '../api/index.js';
 * ```
 */

// ── Authentication ────────────────────────────────────────────────────────
export {
  getAuthenticatedClient,
  getSlidesService,
  getDriveService,
  clearAuthCache,
  getAuthorizationUrl,
  exchangeCodeForTokens,
} from './auth.js';

// ── Client (API wrapper) ─────────────────────────────────────────────────
export {
  createPresentation,
  getPresentation,
  getPresentationPages,
  getPage,
  getPageThumbnail,
  batchUpdate,
  duplicateSlide,
  deleteSlide,
  exportPdf,
  sharePresentation,
  extractElementText,
  extractAllText,
  clearServiceCache,
} from './client.js';

// ── Markdown Converter ────────────────────────────────────────────────────
export {
  parseMarkdown,
  markdownToSlideRequests,
  markdownToSlides,
  updatePresentationFromMarkdown,
  appendSlidesFromMarkdown,
} from './markdown.js';

// ── MCP Tool Definitions ──────────────────────────────────────────────────
export {
  apiTools,
  apiToolMap,
  getApiTool,
  isApiTool,
  executeApiTool,
  listApiTools,
} from './tools.js';

export type { ApiToolDefinition } from './tools.js';
