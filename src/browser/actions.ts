/**
 * @module browser/actions
 * @description Low-level browser action primitives.
 *
 * Every action sends a typed WebSocket message to the Chrome extension
 * and returns the result.  These are the building blocks on which
 * higher-level Slides-specific operations are composed.
 *
 * All methods are stateless — they require a {@link BrowserConnectionManager}
 * (or use the singleton) and translate cleanly into the extension's message
 * protocol.
 */

import type { BrowserConnectionManager } from './connection.js';
import { getConnectionManager } from './connection.js';
import { createLogger } from '../shared/logger.js';
import { BrowserConnectionError } from '../shared/errors.js';
import { DEFAULT_BROWSER_TIMEOUT } from '../shared/constants.js';

const log = createLogger('browser.actions');

// ─────────────────────────────────────────────────────────────────────────────
// Types
// ─────────────────────────────────────────────────────────────────────────────

/** Represents a page snapshot returned from the extension. */
export interface PageSnapshot {
  /** The current page URL. */
  url: string;
  /** The page title. */
  title: string;
  /** Accessibility tree as a structured string. */
  accessibilityTree?: string;
  /** Raw HTML content (truncated if very large). */
  html?: string;
}

/** Result returned from a click action. */
export interface ClickResult {
  /** Whether the click was performed successfully. */
  success: boolean;
  /** A page snapshot taken after the click. */
  snapshot?: PageSnapshot;
}

/** Result returned from a screenshot action. */
export interface ScreenshotResult {
  /** Base64-encoded PNG image data. */
  data: string;
  /** MIME type of the image (always "image/png"). */
  mimeType: string;
  /** Width of the screenshot in pixels. */
  width?: number;
  /** Height of the screenshot in pixels. */
  height?: number;
}

/** Result returned from a script evaluation. */
export interface EvalResult {
  /** The return value of the evaluated script (JSON-serializable). */
  value: unknown;
}

/** A single console log entry from the page. */
export interface ConsoleLogEntry {
  /** Log level: "log", "warn", "error", "info", "debug". */
  level: string;
  /** The log message text. */
  text: string;
  /** ISO-8601 timestamp. */
  timestamp: string;
}

// ─────────────────────────────────────────────────────────────────────────────
// Helpers
// ─────────────────────────────────────────────────────────────────────────────

/**
 * Get the connection manager, validating that it is connected.
 *
 * @param conn - Optional explicit connection manager.
 * @returns The connection manager.
 * @throws {BrowserConnectionError} If not connected.
 */
function getConn(conn?: BrowserConnectionManager): BrowserConnectionManager {
  const mgr = conn ?? getConnectionManager();
  if (!mgr.isConnected) {
    throw new BrowserConnectionError(
      'Browser is not connected. Ensure the Chrome extension is active.',
    );
  }
  return mgr;
}

/**
 * Send a message to the extension and cast the result.
 *
 * @typeParam T - The expected return type.
 * @param type - The action type.
 * @param payload - The action payload.
 * @param conn - Optional explicit connection manager.
 * @param timeout - Optional timeout override in ms.
 * @returns The typed result from the extension.
 */
async function send<T>(
  type: string,
  payload: Record<string, unknown>,
  conn?: BrowserConnectionManager,
  timeout?: number,
): Promise<T> {
  const mgr = getConn(conn);
  const result = await mgr.sendMessage(type, payload, timeout);
  return result as T;
}

// ─────────────────────────────────────────────────────────────────────────────
// Navigation
// ─────────────────────────────────────────────────────────────────────────────

/**
 * Navigate the browser tab to the given URL.
 *
 * @param url - The URL to navigate to.
 * @param conn - Optional connection manager override.
 * @returns A page snapshot of the loaded page.
 */
export async function navigate(
  url: string,
  conn?: BrowserConnectionManager,
): Promise<PageSnapshot> {
  log.info('Navigating to URL', { url });
  return send<PageSnapshot>('navigate', { url }, conn);
}

// ─────────────────────────────────────────────────────────────────────────────
// Click Actions
// ─────────────────────────────────────────────────────────────────────────────

/**
 * Click an element matching the given CSS selector.
 *
 * @param selector - CSS selector identifying the target element.
 * @param index - Zero-based index when multiple elements match. Defaults to 0.
 * @param conn - Optional connection manager override.
 * @returns A click result with an optional page snapshot.
 */
export async function click(
  selector: string,
  index?: number,
  conn?: BrowserConnectionManager,
): Promise<ClickResult> {
  log.info('Clicking element', { selector, index });
  return send<ClickResult>('click', { selector, index: index ?? 0 }, conn);
}

/**
 * Click at specific page coordinates.
 *
 * @param x - Horizontal coordinate in pixels.
 * @param y - Vertical coordinate in pixels.
 * @param conn - Optional connection manager override.
 * @returns A click result with an optional page snapshot.
 */
export async function clickCoordinates(
  x: number,
  y: number,
  conn?: BrowserConnectionManager,
): Promise<ClickResult> {
  log.info('Clicking at coordinates', { x, y });
  return send<ClickResult>('clickCoordinates', { x, y }, conn);
}

/**
 * Double-click an element matching the given CSS selector.
 *
 * Sends a `doubleClick` message to the Chrome extension, which should
 * dispatch a proper `dblclick` event on the target element.
 *
 * @param selector - CSS selector identifying the target element.
 * @param index - Zero-based index when multiple elements match. Defaults to 0.
 * @param conn - Optional connection manager override.
 * @returns A click result with an optional page snapshot.
 */
export async function doubleClick(
  selector: string,
  index?: number,
  conn?: BrowserConnectionManager,
): Promise<ClickResult> {
  log.info('Double-clicking element', { selector, index });
  return send<ClickResult>('doubleClick', { selector, index: index ?? 0 }, conn);
}

// ─────────────────────────────────────────────────────────────────────────────
// Typing & Keyboard
// ─────────────────────────────────────────────────────────────────────────────

/**
 * Type text into an element matching the given selector.
 *
 * @param selector - CSS selector of the input/textarea/contenteditable element.
 * @param text - The text to type.
 * @param conn - Optional connection manager override.
 * @returns A page snapshot after typing.
 */
export async function type(
  selector: string,
  text: string,
  conn?: BrowserConnectionManager,
): Promise<PageSnapshot> {
  log.info('Typing text', { selector, textLength: text.length });
  return send<PageSnapshot>('type', { selector, text }, conn);
}

/**
 * Press a single keyboard key.
 *
 * @param key - The key to press (e.g. "Tab", "Enter", "Escape", "a").
 * @param conn - Optional connection manager override.
 * @returns A page snapshot after the key press.
 */
export async function pressKey(
  key: string,
  conn?: BrowserConnectionManager,
): Promise<PageSnapshot> {
  log.info('Pressing key', { key });
  return send<PageSnapshot>('pressKey', { key }, conn);
}

/**
 * Press a key combination (e.g. Ctrl+A, Ctrl+C).
 *
 * @param keys - Array of key names to press simultaneously (e.g. ["Control", "a"]).
 * @param conn - Optional connection manager override.
 * @returns A page snapshot after the key combination.
 */
export async function pressKeys(
  keys: string[],
  conn?: BrowserConnectionManager,
): Promise<PageSnapshot> {
  log.info('Pressing key combination', { keys });
  return send<PageSnapshot>('pressKeys', { keys }, conn);
}

// ─────────────────────────────────────────────────────────────────────────────
// Hover & Drag
// ─────────────────────────────────────────────────────────────────────────────

/**
 * Hover over an element matching the given selector.
 *
 * @param selector - CSS selector of the target element.
 * @param conn - Optional connection manager override.
 * @returns A page snapshot after the hover.
 */
export async function hover(
  selector: string,
  conn?: BrowserConnectionManager,
): Promise<PageSnapshot> {
  log.info('Hovering over element', { selector });
  return send<PageSnapshot>('hover', { selector }, conn);
}

/**
 * Drag an element from one selector to another.
 *
 * @param startSelector - CSS selector of the element to drag.
 * @param endSelector - CSS selector of the drop target.
 * @param conn - Optional connection manager override.
 * @returns A page snapshot after the drag-and-drop.
 */
export async function dragDrop(
  startSelector: string,
  endSelector: string,
  conn?: BrowserConnectionManager,
): Promise<PageSnapshot> {
  log.info('Drag and drop', { startSelector, endSelector });
  return send<PageSnapshot>('dragDrop', { startSelector, endSelector }, conn);
}

/**
 * Drag between two coordinate pairs.
 *
 * @param startX - Starting horizontal coordinate.
 * @param startY - Starting vertical coordinate.
 * @param endX - Ending horizontal coordinate.
 * @param endY - Ending vertical coordinate.
 * @param conn - Optional connection manager override.
 * @returns A page snapshot after the drag.
 */
export async function dragCoordinates(
  startX: number,
  startY: number,
  endX: number,
  endY: number,
  conn?: BrowserConnectionManager,
): Promise<PageSnapshot> {
  log.info('Drag between coordinates', { startX, startY, endX, endY });
  return send<PageSnapshot>(
    'dragCoordinates',
    { startX, startY, endX, endY },
    conn,
  );
}

// ─────────────────────────────────────────────────────────────────────────────
// Scrolling
// ─────────────────────────────────────────────────────────────────────────────

/**
 * Scroll the page or a specific element.
 *
 * @param x - Horizontal scroll delta in pixels.
 * @param y - Vertical scroll delta in pixels.
 * @param selector - Optional CSS selector to scroll a specific element.
 * @param conn - Optional connection manager override.
 * @returns A page snapshot after scrolling.
 */
export async function scroll(
  x?: number,
  y?: number,
  selector?: string,
  conn?: BrowserConnectionManager,
): Promise<PageSnapshot> {
  log.info('Scrolling', { x, y, selector });
  return send<PageSnapshot>('scroll', { x, y, selector }, conn);
}

// ─────────────────────────────────────────────────────────────────────────────
// Form Elements
// ─────────────────────────────────────────────────────────────────────────────

/**
 * Select an option from a dropdown/select element.
 *
 * @param selector - CSS selector of the `<select>` element.
 * @param value - The option value to select.
 * @param conn - Optional connection manager override.
 * @returns A page snapshot after the selection.
 */
export async function selectOption(
  selector: string,
  value: string,
  conn?: BrowserConnectionManager,
): Promise<PageSnapshot> {
  log.info('Selecting option', { selector, value });
  return send<PageSnapshot>('selectOption', { selector, value }, conn);
}

// ─────────────────────────────────────────────────────────────────────────────
// Screenshots & Snapshots
// ─────────────────────────────────────────────────────────────────────────────

/**
 * Take a screenshot of the current page.
 *
 * @param conn - Optional connection manager override.
 * @returns A screenshot result with base64-encoded PNG data.
 */
export async function screenshot(
  conn?: BrowserConnectionManager,
): Promise<ScreenshotResult> {
  log.info('Taking screenshot');
  return send<ScreenshotResult>('screenshot', {}, conn);
}

/**
 * Get an accessibility tree snapshot of the current page.
 *
 * @param conn - Optional connection manager override.
 * @returns A page snapshot with the accessibility tree.
 */
export async function snapshot(
  conn?: BrowserConnectionManager,
): Promise<PageSnapshot> {
  log.info('Getting accessibility snapshot');
  return send<PageSnapshot>('snapshot', {}, conn);
}

// ─────────────────────────────────────────────────────────────────────────────
// Console & Debugging
// ─────────────────────────────────────────────────────────────────────────────

/**
 * Retrieve browser console log entries.
 *
 * @param conn - Optional connection manager override.
 * @returns An array of console log entries.
 */
export async function getConsoleLogs(
  conn?: BrowserConnectionManager,
): Promise<ConsoleLogEntry[]> {
  log.info('Getting console logs');
  return send<ConsoleLogEntry[]>('getConsoleLogs', {}, conn);
}

/**
 * Execute a JavaScript expression/script in the page context.
 *
 * @param script - The JavaScript code to evaluate.
 * @param conn - Optional connection manager override.
 * @returns The evaluation result.
 */
export async function evaluateScript(
  script: string,
  conn?: BrowserConnectionManager,
): Promise<EvalResult> {
  log.info('Evaluating script', { scriptLength: script.length });
  return send<EvalResult>('evaluateScript', { script }, conn);
}

// ─────────────────────────────────────────────────────────────────────────────
// Waiting
// ─────────────────────────────────────────────────────────────────────────────

/**
 * Wait for an element matching the given selector to appear in the DOM.
 *
 * @param selector - CSS selector of the element to wait for.
 * @param timeout - Maximum time to wait in ms. Defaults to {@link DEFAULT_BROWSER_TIMEOUT}.
 * @param conn - Optional connection manager override.
 * @returns A page snapshot once the element is found.
 */
export async function waitForSelector(
  selector: string,
  timeout?: number,
  conn?: BrowserConnectionManager,
): Promise<PageSnapshot> {
  const waitMs = timeout ?? DEFAULT_BROWSER_TIMEOUT;
  log.info('Waiting for selector', { selector, timeout: waitMs });
  return send<PageSnapshot>(
    'waitForSelector',
    { selector, timeout: waitMs },
    conn,
    waitMs + 5_000, // extra buffer for the WebSocket round-trip
  );
}

/**
 * Wait for a page navigation to complete.
 *
 * @param timeout - Maximum time to wait in ms. Defaults to {@link DEFAULT_BROWSER_TIMEOUT}.
 * @param conn - Optional connection manager override.
 * @returns A page snapshot of the navigated-to page.
 */
export async function waitForNavigation(
  timeout?: number,
  conn?: BrowserConnectionManager,
): Promise<PageSnapshot> {
  const waitMs = timeout ?? DEFAULT_BROWSER_TIMEOUT;
  log.info('Waiting for navigation', { timeout: waitMs });
  return send<PageSnapshot>(
    'waitForNavigation',
    { timeout: waitMs },
    conn,
    waitMs + 5_000,
  );
}

// ─────────────────────────────────────────────────────────────────────────────
// Text Extraction
// ─────────────────────────────────────────────────────────────────────────────

/**
 * Extract all visible text from the current page.
 *
 * The Chrome extension traverses the DOM (including shadow roots and
 * same-origin iframes) to produce a clean text representation.
 *
 * @param conn - Optional connection manager override.
 * @returns The extracted page text.
 */
export async function getPageText(
  conn?: BrowserConnectionManager,
): Promise<string> {
  log.info('Extracting page text');
  return send<string>('getPageText', {}, conn);
}
