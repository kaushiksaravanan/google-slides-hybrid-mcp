/**
 * @module shared/constants
 * @description All constants used across the Google Slides Hybrid MCP server.
 * Centralised here so that every layer references a single source of truth.
 */

// ─────────────────────────────────────────────────────────────────────────────
// MCP Server Metadata
// ─────────────────────────────────────────────────────────────────────────────

/** Name of this MCP server as reported in the `initialize` handshake. */
export const MCP_SERVER_NAME = 'google-slides-hybrid-mcp';

/** Semantic version of this MCP server. */
export const MCP_SERVER_VERSION = '1.0.0';

/** Human-readable description surfaced to MCP clients. */
export const MCP_SERVER_DESCRIPTION =
  'Production-ready hybrid Google Slides MCP server combining API + Live Browser + Vision layers';

// ─────────────────────────────────────────────────────────────────────────────
// Google OAuth Scopes
// ─────────────────────────────────────────────────────────────────────────────

/**
 * Google Slides API OAuth scope — required for reading and writing
 * presentations.
 */
export const GOOGLE_SLIDES_SCOPE =
  'https://www.googleapis.com/auth/presentations';

/**
 * Google Slides read-only scope — used when the server only needs to
 * fetch presentation data.
 */
export const GOOGLE_SLIDES_READONLY_SCOPE =
  'https://www.googleapis.com/auth/presentations.readonly';

/**
 * Google Drive API scope — required for file-level operations
 * (create, share, move, etc.).
 */
export const GOOGLE_DRIVE_SCOPE = 'https://www.googleapis.com/auth/drive';

/** Google Drive read-only scope. */
export const GOOGLE_DRIVE_READONLY_SCOPE =
  'https://www.googleapis.com/auth/drive.readonly';

/** All scopes requested by default during the OAuth consent flow.
 *  Full Drive scope (not readonly) is needed because the server uses
 *  drive.permissions.create to share presentations, which requires
 *  write access to Drive.
 */
export const DEFAULT_OAUTH_SCOPES: readonly string[] = [
  GOOGLE_SLIDES_SCOPE,
  GOOGLE_DRIVE_SCOPE,
] as const;

// ─────────────────────────────────────────────────────────────────────────────
// Slide Dimensions (points)
// ─────────────────────────────────────────────────────────────────────────────

/**
 * Default slide width in points (16:9 aspect ratio).
 * Google Slides uses 720 × 405 pt as the default 16:9 page size.
 */
export const DEFAULT_PAGE_WIDTH = 720;

/**
 * Default slide height in points (16:9 aspect ratio).
 */
export const DEFAULT_PAGE_HEIGHT = 405;

/** Conversion factor: 1 point = 12700 EMU (English Metric Units). */
export const EMU_PER_POINT = 12700;

/** Default page width in EMU. */
export const DEFAULT_PAGE_WIDTH_EMU = DEFAULT_PAGE_WIDTH * EMU_PER_POINT;

/** Default page height in EMU. */
export const DEFAULT_PAGE_HEIGHT_EMU = DEFAULT_PAGE_HEIGHT * EMU_PER_POINT;

// ─────────────────────────────────────────────────────────────────────────────
// Default Margins (points)
// ─────────────────────────────────────────────────────────────────────────────

/** Default left margin, in points. */
export const DEFAULT_MARGIN_LEFT = 50;

/** Default right margin, in points. */
export const DEFAULT_MARGIN_RIGHT = 50;

/** Default top margin, in points. */
export const DEFAULT_MARGIN_TOP = 50;

/** Default bottom margin, in points. */
export const DEFAULT_MARGIN_BOTTOM = 50;

/** All default margins as a convenience object. */
export const DEFAULT_MARGINS = {
  left: DEFAULT_MARGIN_LEFT,
  right: DEFAULT_MARGIN_RIGHT,
  top: DEFAULT_MARGIN_TOP,
  bottom: DEFAULT_MARGIN_BOTTOM,
} as const;

/**
 * Usable content area after applying default margins (in points).
 * width  = 720 − 50 − 50 = 620
 * height = 405 − 50 − 50 = 305
 */
export const CONTENT_AREA = {
  x: DEFAULT_MARGIN_LEFT,
  y: DEFAULT_MARGIN_TOP,
  width: DEFAULT_PAGE_WIDTH - DEFAULT_MARGIN_LEFT - DEFAULT_MARGIN_RIGHT,
  height: DEFAULT_PAGE_HEIGHT - DEFAULT_MARGIN_TOP - DEFAULT_MARGIN_BOTTOM,
} as const;

// ─────────────────────────────────────────────────────────────────────────────
// Typography Defaults
// ─────────────────────────────────────────────────────────────────────────────

/** Default font family used across new elements. */
export const DEFAULT_FONT_FAMILY = 'Roboto';

/** Default title font size, in points. */
export const DEFAULT_TITLE_FONT_SIZE = 36;

/** Default subtitle font size, in points. */
export const DEFAULT_SUBTITLE_FONT_SIZE = 24;

/** Default body text font size, in points. */
export const DEFAULT_BODY_FONT_SIZE = 18;

/** Default caption / footnote font size, in points. */
export const DEFAULT_CAPTION_FONT_SIZE = 12;

/** Default line spacing multiplier. */
export const DEFAULT_LINE_SPACING = 1.15;

/** Complete set of font-size defaults keyed by semantic role. */
export const FONT_SIZES = {
  title: DEFAULT_TITLE_FONT_SIZE,
  subtitle: DEFAULT_SUBTITLE_FONT_SIZE,
  body: DEFAULT_BODY_FONT_SIZE,
  caption: DEFAULT_CAPTION_FONT_SIZE,
} as const;

// ─────────────────────────────────────────────────────────────────────────────
// WebSocket / Browser Defaults
// ─────────────────────────────────────────────────────────────────────────────

/** Default Chrome DevTools Protocol WebSocket port. */
export const DEFAULT_WS_PORT = 9222;

/** Default screenshot format. */
export const DEFAULT_SCREENSHOT_FORMAT: 'png' | 'jpeg' | 'webp' = 'png';

/** Default browser operation timeout, in milliseconds. */
export const DEFAULT_BROWSER_TIMEOUT = 30_000;

/** Maximum time to wait for Chrome to launch, in milliseconds. */
export const CHROME_LAUNCH_TIMEOUT = 15_000;

// ─────────────────────────────────────────────────────────────────────────────
// Rate Limits
// ─────────────────────────────────────────────────────────────────────────────

/**
 * Google Slides API default quota: 60 read requests per user per minute.
 * (The actual quota depends on your GCP project; this is a safe default.)
 */
export const GOOGLE_API_READ_QUOTA_PER_MINUTE = 60;

/**
 * Google Slides API default quota: 60 write requests per user per minute.
 */
export const GOOGLE_API_WRITE_QUOTA_PER_MINUTE = 60;

/** Maximum number of concurrent API requests we allow in-flight. */
export const MAX_CONCURRENT_API_REQUESTS = 10;

/** Minimum delay between consecutive API calls, in milliseconds. */
export const MIN_REQUEST_INTERVAL_MS = 100;

/** Rate limit values as a convenience object. */
export const RATE_LIMITS = {
  readPerMinute: GOOGLE_API_READ_QUOTA_PER_MINUTE,
  writePerMinute: GOOGLE_API_WRITE_QUOTA_PER_MINUTE,
  maxConcurrent: MAX_CONCURRENT_API_REQUESTS,
  minIntervalMs: MIN_REQUEST_INTERVAL_MS,
} as const;

// ─────────────────────────────────────────────────────────────────────────────
// Retry Defaults
// ─────────────────────────────────────────────────────────────────────────────

/** Default maximum number of retries for transient failures. */
export const DEFAULT_MAX_RETRIES = 3;

/** Default base delay for exponential backoff, in milliseconds. */
export const DEFAULT_BASE_DELAY = 1000;

/** Default maximum delay cap, in milliseconds. */
export const DEFAULT_MAX_DELAY = 30_000;

/** Default backoff factor (multiplier). */
export const DEFAULT_BACKOFF_FACTOR = 2;

// ─────────────────────────────────────────────────────────────────────────────
// Professional Colour Themes
// ─────────────────────────────────────────────────────────────────────────────

/**
 * A curated set of professional colour palettes for slide themes.
 * Colours are stored as hex strings.
 */
export const COLOR_THEMES = {
  /** Clean corporate blue palette. */
  corporate: {
    primary: '#1A73E8',
    secondary: '#174EA6',
    accent: '#EA4335',
    background: '#FFFFFF',
    surface: '#F8F9FA',
    textPrimary: '#202124',
    textSecondary: '#5F6368',
    border: '#DADCE0',
  },

  /** Modern dark theme. */
  dark: {
    primary: '#8AB4F8',
    secondary: '#669DF6',
    accent: '#F28B82',
    background: '#202124',
    surface: '#303134',
    textPrimary: '#E8EAED',
    textSecondary: '#9AA0A6',
    border: '#5F6368',
  },

  /** Warm minimalist palette. */
  warm: {
    primary: '#D93025',
    secondary: '#C5221F',
    accent: '#F9AB00',
    background: '#FFFBF0',
    surface: '#FFF3E0',
    textPrimary: '#3C4043',
    textSecondary: '#5F6368',
    border: '#E0D5C1',
  },

  /** Nature-inspired green palette. */
  nature: {
    primary: '#0D652D',
    secondary: '#137333',
    accent: '#1E8E3E',
    background: '#F1F8E9',
    surface: '#E8F5E9',
    textPrimary: '#1B5E20',
    textSecondary: '#33691E',
    border: '#A5D6A7',
  },

  /** Professional slate / neutral palette. */
  slate: {
    primary: '#455A64',
    secondary: '#37474F',
    accent: '#0097A7',
    background: '#FFFFFF',
    surface: '#ECEFF1',
    textPrimary: '#263238',
    textSecondary: '#546E7A',
    border: '#B0BEC5',
  },
} as const;

/** The names of all available colour themes. */
export type ColorThemeName = keyof typeof COLOR_THEMES;

// ─────────────────────────────────────────────────────────────────────────────
// Google Slides Shape Types
// ─────────────────────────────────────────────────────────────────────────────

/** Common shape types supported by the Google Slides API. */
export const SHAPE_TYPES = {
  RECTANGLE: 'RECTANGLE',
  ROUND_RECTANGLE: 'ROUND_RECTANGLE',
  ELLIPSE: 'ELLIPSE',
  TRIANGLE: 'TRIANGLE',
  DIAMOND: 'DIAMOND',
  PENTAGON: 'PENTAGON',
  HEXAGON: 'HEXAGON',
  STAR_4: 'STAR_4',
  STAR_5: 'STAR_5',
  CLOUD: 'CLOUD',
  ARROW_EAST: 'ARROW_EAST',
  ARROW_NORTH: 'ARROW_NORTH',
  ARROW_SOUTH: 'ARROW_SOUTH',
  ARROW_WEST: 'ARROW_WEST',
  HEART: 'HEART',
  TEXT_BOX: 'TEXT_BOX',
} as const;

// ─────────────────────────────────────────────────────────────────────────────
// Predefined Layouts
// ─────────────────────────────────────────────────────────────────────────────

/** Google Slides predefined layout identifiers. */
export const PREDEFINED_LAYOUTS = {
  BLANK: 'BLANK',
  TITLE: 'TITLE',
  TITLE_AND_BODY: 'TITLE_AND_BODY',
  TITLE_AND_TWO_COLUMNS: 'TITLE_AND_TWO_COLUMNS',
  TITLE_ONLY: 'TITLE_ONLY',
  SECTION_HEADER: 'SECTION_HEADER',
  SECTION_TITLE_AND_DESCRIPTION: 'SECTION_TITLE_AND_DESCRIPTION',
  ONE_COLUMN_TEXT: 'ONE_COLUMN_TEXT',
  MAIN_POINT: 'MAIN_POINT',
  BIG_NUMBER: 'BIG_NUMBER',
} as const;

// ─────────────────────────────────────────────────────────────────────────────
// Environment Variable Names
// ─────────────────────────────────────────────────────────────────────────────

/** Canonical environment variable names used by the server. */
export const ENV_VARS = {
  GOOGLE_CLIENT_ID: 'GOOGLE_CLIENT_ID',
  GOOGLE_CLIENT_SECRET: 'GOOGLE_CLIENT_SECRET',
  GOOGLE_REFRESH_TOKEN: 'GOOGLE_REFRESH_TOKEN',
  CHROME_WS_PORT: 'CHROME_WS_PORT',
  NODE_ENV: 'NODE_ENV',
  LOG_LEVEL: 'LOG_LEVEL',
  VISION_ENABLED: 'VISION_ENABLED',
  VISION_MODEL: 'VISION_MODEL',
  VISION_AUTO_FIX: 'VISION_AUTO_FIX',
} as const;
