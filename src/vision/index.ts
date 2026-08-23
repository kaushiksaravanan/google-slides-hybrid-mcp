/**
 * @module vision
 * @description Vision layer barrel exports.
 *
 * Re-exports everything from the vision layer modules:
 * - {@link analyzer} — pixel-level and structural design analysis
 * - {@link design-rules} — professional design rule engine
 * - {@link auto-fixer} — automatic design fix generator and applier
 * - {@link theme-engine} — professional theme definitions and application
 * - {@link tools} — MCP tool definitions for the vision layer
 */

// ── Analyzer ──────────────────────────────────────────────────────────────────
export {
  analyzeSlideDesign,
  extractDominantColors,
  analyzeVisualBalance,
  analyzeTextDensity,
  checkContrastRatio,
  compareSlideConsistency,
  detectElementBoundaries,
  type ExtractedColor,
  type BalanceResult,
  type TextDensityResult,
} from './analyzer.js';

// ── Design Rules ──────────────────────────────────────────────────────────────
export {
  classifySlide,
  evaluateRule,
  evaluateAllRules,
  calculateDesignScore,
  getRecommendedFix,
  parseHexColor,
  relativeLuminance,
  contrastRatio,
  DESIGN_RULES,
  DESIGN_RULE_MAP,
  MAX_WORDS_PER_SLIDE,
  WCAG_CONTRAST,
  ALIGNMENT_TOLERANCE_PT,
  MIN_FONT_SIZES,
  RECOMMENDED_FONT_PAIRINGS,
  MAX_COLORS_PER_SLIDE,
  MIN_MARGIN_FRACTION,
  type SlideType,
  type RuleEvaluationResult,
  type DesignRule,
} from './design-rules.js';

// ── Auto-Fixer ────────────────────────────────────────────────────────────────
export {
  generateFixes,
  applyFixPlan,
  fixAlignment,
  fixSpacing,
  fixFontHierarchy,
  fixContrast,
  fixTextDensity,
  fixBalance,
  type FixAction,
  type FixPlan,
  type ApiClient,
  type BrowserController,
} from './auto-fixer.js';

// ── Theme Engine ──────────────────────────────────────────────────────────────
export {
  getTheme,
  listThemes,
  listThemeNames,
  applyTheme,
  applyColorScheme,
  applyFontScheme,
  generateThemePreview,
  type ThemeDefinition,
} from './theme-engine.js';

// ── Tools ─────────────────────────────────────────────────────────────────────
export {
  visionTools,
  visionToolMap,
  getVisionTool,
  isVisionTool,
  executeVisionTool,
  listVisionTools,
  type VisionToolDefinition,
} from './tools.js';
