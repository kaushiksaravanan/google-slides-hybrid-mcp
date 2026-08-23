/**
 * @module browser
 * @description Public API for the browser (live editing) layer.
 *
 * Re-exports all public types, classes, and functions from the browser
 * sub-modules so that consumers can import from a single entry point:
 *
 * ```ts
 * import {
 *   BrowserConnectionManager,
 *   getConnectionManager,
 *   browserTools,
 *   executeBrowserTool,
 * } from '../browser/index.js';
 * ```
 */

// ── Connection Management ─────────────────────────────────────────────────
export {
  BrowserConnectionManager,
  getConnectionManager,
  destroyConnectionManager,
} from './connection.js';

export type {
  OutgoingMessage,
  IncomingExtensionMessage,
  ConnectionEvents,
  ConnectionState,
  ConnectionManagerOptions,
} from './connection.js';

// ── Browser Actions (low-level primitives) ────────────────────────────────
export {
  navigate,
  click,
  clickCoordinates,
  type,
  pressKey,
  pressKeys,
  hover,
  dragDrop,
  dragCoordinates,
  scroll,
  selectOption,
  screenshot,
  snapshot,
  getConsoleLogs,
  evaluateScript,
  waitForSelector,
  waitForNavigation,
  getPageText,
} from './actions.js';

export type {
  PageSnapshot,
  ClickResult,
  ScreenshotResult,
  EvalResult,
  ConsoleLogEntry,
} from './actions.js';

// ── Slides Controller (high-level Google Slides automation) ───────────────
export {
  openPresentation,
  goToSlide,
  getCurrentSlideIndex,
  clickOnSlideElement,
  addTextBox,
  editText,
  changeFont,
  changeFontSize,
  changeTextColor,
  changeBackgroundColor,
  applyBold,
  applyItalic,
  applyUnderline,
  alignElements,
  distributeElements,
  insertImage,
  duplicateSlide,
  deleteSlide,
  moveElement,
  resizeElement,
  getSlideScreenshot,
  getSlideAccessibilityTree,
  applyTransition,
  setSpeakerNotes,
} from './slides-controller.js';

// ── MCP Tool Definitions ──────────────────────────────────────────────────
export {
  browserTools,
  browserToolMap,
  getBrowserTool,
  isBrowserTool,
  executeBrowserTool,
  listBrowserTools,
} from './tools.js';

export type { BrowserToolDefinition } from './tools.js';
