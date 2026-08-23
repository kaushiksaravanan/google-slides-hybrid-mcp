/**
 * @module templates/types
 * @description Type definitions for the professional template library.
 * Covers template structure, slide layouts, theming, and variable substitution.
 */

// ─────────────────────────────────────────────────────────────────────────────
// Template Categories
// ─────────────────────────────────────────────────────────────────────────────

/** Supported template categories for filtering and discovery. */
export type TemplateCategory =
  | 'business'
  | 'pitch'
  | 'education'
  | 'marketing'
  | 'report'
  | 'portfolio'
  | 'proposal'
  | 'meeting'
  | 'workshop'
  | 'creative';

/** All valid category values as a readonly array (useful for validation). */
export const TEMPLATE_CATEGORIES: readonly TemplateCategory[] = [
  'business',
  'pitch',
  'education',
  'marketing',
  'report',
  'portfolio',
  'proposal',
  'meeting',
  'workshop',
  'creative',
] as const;

// ─────────────────────────────────────────────────────────────────────────────
// Slide Layouts
// ─────────────────────────────────────────────────────────────────────────────

/** Available slide layout types for template slides. */
export type SlideLayout =
  | 'title'
  | 'title_content'
  | 'two_column'
  | 'image_left'
  | 'image_right'
  | 'full_image'
  | 'comparison'
  | 'timeline'
  | 'chart_data'
  | 'quote'
  | 'team'
  | 'pricing'
  | 'features'
  | 'cta'
  | 'blank';

// ─────────────────────────────────────────────────────────────────────────────
// Template Variable
// ─────────────────────────────────────────────────────────────────────────────

/** Type of input a template variable expects. */
export type TemplateVariableType = 'text' | 'multiline' | 'url' | 'color' | 'number';

/** A user-fillable placeholder within a template. */
export interface TemplateVariable {
  /** The variable name, used as {{name}} in template content. */
  name: string;
  /** Human-readable description of what this variable represents. */
  description: string;
  /** Default value used when the user does not provide one. */
  defaultValue: string;
  /** The kind of input expected. */
  type: TemplateVariableType;
  /** Whether this variable must be provided by the user. */
  required: boolean;
}

// ─────────────────────────────────────────────────────────────────────────────
// Template Theme
// ─────────────────────────────────────────────────────────────────────────────

/** Colour and typography settings for a template. */
export interface TemplateTheme {
  /** Primary brand/accent colour as hex (e.g. "#1A73E8"). */
  primaryColor: string;
  /** Secondary colour as hex. */
  secondaryColor: string;
  /** Accent / highlight colour as hex. */
  accentColor: string;
  /** Slide background colour as hex. */
  backgroundColor: string;
  /** Font family for titles (e.g. "Montserrat"). */
  titleFont: string;
  /** Font family for body text (e.g. "Open Sans"). */
  bodyFont: string;
  /** Title font size in points. */
  titleSize: number;
  /** Body text font size in points. */
  bodySize: number;
}

// ─────────────────────────────────────────────────────────────────────────────
// Slide Definition
// ─────────────────────────────────────────────────────────────────────────────

/** A single slide within a template definition. */
export interface SlideDefinition {
  /** The layout to use for this slide. */
  layout: SlideLayout;
  /** Slide title text (may contain {{variables}}). */
  title?: string;
  /** Slide subtitle text (may contain {{variables}}). */
  subtitle?: string;
  /** Body paragraph text (may contain {{variables}}). */
  body?: string;
  /** Bullet point items (each may contain {{variables}}). */
  bullets?: string[];
  /** URL for an image element on this slide. */
  imageUrl?: string;
  /** Speaker notes for the presenter (may contain {{variables}}). */
  speakerNotes?: string;
  /** Which template variable names this slide references. */
  variables?: string[];
}

// ─────────────────────────────────────────────────────────────────────────────
// Slide Template
// ─────────────────────────────────────────────────────────────────────────────

/** A complete, self-contained presentation template. */
export interface SlideTemplate {
  /** Unique template identifier (e.g. "startup-pitch"). */
  id: string;
  /** Human-readable template name. */
  name: string;
  /** Description of the template's purpose and audience. */
  description: string;
  /** Primary category for filtering. */
  category: TemplateCategory;
  /** Searchable tags. */
  tags: string[];
  /** Ordered list of slide definitions. */
  slides: SlideDefinition[];
  /** Theme configuration. */
  theme: TemplateTheme;
  /** User-fillable variables / placeholders. */
  variables: TemplateVariable[];
  /** Optional markdown preview string. */
  preview?: string;
}
