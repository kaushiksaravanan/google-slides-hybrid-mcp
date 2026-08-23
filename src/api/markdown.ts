/**
 * @module api/markdown
 * @description Markdown-to-Google-Slides converter.
 *
 * Inspired by ngs/google-mcp-server's markdown.go but fully rewritten in
 * TypeScript. Converts markdown content into Google Slides API batch-update
 * requests.
 *
 * Supports:
 * - Slide breaks via horizontal rules (`---`)
 * - Auto-pagination when no explicit breaks are present
 * - Smart layout detection (TITLE, TITLE_AND_BODY, TITLE_ONLY, BLANK)
 * - Headings (H1–H3), bullets, numbered lists
 * - Images via `![alt](url)`
 * - Code blocks (rendered as monospace text boxes)
 * - Tables (rendered as Google Slides tables)
 * - Inline formatting: **bold**, *italic*, `code`, [links](url)
 * - Speaker notes (text after `Notes:` or `???` on a slide section)
 */

import { Lexer, type Token, type Tokens } from 'marked';
import { randomUUID } from 'node:crypto';
import type { slides_v1 } from 'googleapis';
import { createLogger } from '../shared/logger.js';

/**
 * Local type alias for Google Slides batch-update request objects.
 * Avoids leaking the `googleapis` dependency into the module's public
 * return types — callers can treat these as opaque records.
 */
type BatchRequest = Record<string, unknown>;
import {
  DEFAULT_PAGE_HEIGHT,
  DEFAULT_MARGIN_LEFT,
  DEFAULT_MARGIN_TOP,
  DEFAULT_MARGIN_BOTTOM,
  DEFAULT_FONT_FAMILY,
  DEFAULT_TITLE_FONT_SIZE,
  DEFAULT_BODY_FONT_SIZE,
  DEFAULT_CAPTION_FONT_SIZE,
  EMU_PER_POINT,
  PREDEFINED_LAYOUTS,
  CONTENT_AREA,
} from '../shared/constants.js';
import type { MarkdownSlide } from '../shared/types.js';

const log = createLogger('api.markdown');

// ─────────────────────────────────────────────────────────────────────────────
// Constants
// ─────────────────────────────────────────────────────────────────────────────

/** Maximum lines of body content before auto-paginating to a new slide. */
const MAX_BODY_LINES_PER_SLIDE = 8;

/** Maximum characters of body text before auto-paginating. */
const MAX_BODY_CHARS_PER_SLIDE = 600;

/** Code block font size. */
const CODE_FONT_SIZE = 12;

/** Code block font family. */
const CODE_FONT_FAMILY = 'Courier New';

/** Code block background color. */
const CODE_BG_COLOR = { red: 0.95, green: 0.95, blue: 0.95 };

/** Bullet glyph for unordered lists. */
const BULLET_GLYPH = '\u2022 ';

/** Subtitle font size (H2 within a title slide). */
const SUBTITLE_FONT_SIZE = 20;

// ─────────────────────────────────────────────────────────────────────────────
// Types
// ─────────────────────────────────────────────────────────────────────────────

/** A text run with style information for building insertText requests. */
interface StyledRun {
  text: string;
  bold?: boolean;
  italic?: boolean;
  code?: boolean;
  link?: string;
}

/** A parsed slide section ready for API request generation. */
interface ParsedSlide {
  title: string;
  subtitle?: string;
  bodyRuns: StyledRun[][];
  images: Array<{ url: string; alt: string }>;
  tables: Array<{ headers: string[]; rows: string[][] }>;
  codeBlocks: Array<{ lang: string; code: string }>;
  notes: string;
  layout: string;
}

// ─────────────────────────────────────────────────────────────────────────────
// Helper: Convert points to EMU
// ─────────────────────────────────────────────────────────────────────────────

/** Convert points to English Metric Units. */
function pt(points: number): number {
  return Math.round(points * EMU_PER_POINT);
}

/** Generate a unique object ID with a given prefix. */
function generateId(prefix: string): string {
  const rand = randomUUID().replace(/-/g, '').substring(0, 12);
  const ts = Date.now().toString(36);
  return `${prefix}_${ts}_${rand}`;
}

// ─────────────────────────────────────────────────────────────────────────────
// Inline Token Parsing
// ─────────────────────────────────────────────────────────────────────────────

/**
 * Recursively convert marked inline tokens into styled runs.
 */
function inlineTokensToRuns(
  tokens: Token[],
  inheritBold = false,
  inheritItalic = false,
): StyledRun[] {
  const runs: StyledRun[] = [];

  for (const token of tokens) {
    switch (token.type) {
      case 'text': {
        const t = token as Tokens.Text;
        // Text tokens may themselves contain inline tokens
        if ('tokens' in t && Array.isArray(t.tokens) && t.tokens.length > 0) {
          runs.push(...inlineTokensToRuns(t.tokens, inheritBold, inheritItalic));
        } else {
          runs.push({
            text: t.text,
            bold: inheritBold || undefined,
            italic: inheritItalic || undefined,
          });
        }
        break;
      }
      case 'strong': {
        const s = token as Tokens.Strong;
        const innerTokens = s.tokens ?? [];
        runs.push(...inlineTokensToRuns(innerTokens, true, inheritItalic));
        break;
      }
      case 'em': {
        const e = token as Tokens.Em;
        const innerTokens = e.tokens ?? [];
        runs.push(...inlineTokensToRuns(innerTokens, inheritBold, true));
        break;
      }
      case 'codespan': {
        const c = token as Tokens.Codespan;
        runs.push({ text: c.text, code: true });
        break;
      }
      case 'link': {
        const l = token as Tokens.Link;
        runs.push({ text: l.text, link: l.href });
        break;
      }
      case 'image': {
        // Images in inline context are handled separately
        break;
      }
      case 'br': {
        runs.push({ text: '\n' });
        break;
      }
      case 'escape': {
        const esc = token as Tokens.Escape;
        runs.push({ text: esc.text });
        break;
      }
      default: {
        // Fallback: extract raw text
        if ('text' in token && typeof (token as { text: unknown }).text === 'string') {
          runs.push({
            text: (token as { text: string }).text,
            bold: inheritBold || undefined,
            italic: inheritItalic || undefined,
          });
        }
        break;
      }
    }
  }

  return runs;
}

// ─────────────────────────────────────────────────────────────────────────────
// Markdown Splitting
// ─────────────────────────────────────────────────────────────────────────────

/**
 * Split markdown content into sections delimited by `---` (horizontal rules).
 * If no explicit separators are found, split on H1/H2 headings or auto-paginate.
 */
function splitIntoSections(markdown: string): string[] {
  // First try explicit --- separators
  const hrSplit = markdown.split(/\n---\n|\n---$|^---\n/);
  if (hrSplit.length > 1) {
    return hrSplit.map((s) => s.trim()).filter(Boolean);
  }

  // Try splitting on H1 headings (each H1 starts a new slide)
  const headingSplit = markdown.split(/(?=^# )/m);
  if (headingSplit.length > 1) {
    return headingSplit.map((s) => s.trim()).filter(Boolean);
  }

  // Try splitting on H2 headings
  const h2Split = markdown.split(/(?=^## )/m);
  if (h2Split.length > 1) {
    return h2Split.map((s) => s.trim()).filter(Boolean);
  }

  // No natural breaks — auto-paginate
  return autoPaginate(markdown);
}

/**
 * Auto-paginate a block of markdown into multiple sections when it
 * exceeds the per-slide limits.
 */
function autoPaginate(markdown: string): string[] {
  const lines = markdown.split('\n');
  const sections: string[] = [];
  let current: string[] = [];
  let charCount = 0;
  let lineCount = 0;

  for (const line of lines) {
    if (
      lineCount >= MAX_BODY_LINES_PER_SLIDE ||
      charCount >= MAX_BODY_CHARS_PER_SLIDE
    ) {
      sections.push(current.join('\n'));
      current = [];
      charCount = 0;
      lineCount = 0;
    }
    current.push(line);
    charCount += line.length;
    if (line.trim()) lineCount++;
  }

  if (current.length > 0) {
    sections.push(current.join('\n'));
  }

  return sections.filter((s) => s.trim());
}

// ─────────────────────────────────────────────────────────────────────────────
// Section Parsing
// ─────────────────────────────────────────────────────────────────────────────

/**
 * Extract speaker notes from a section. Notes are indicated by a line
 * starting with `Notes:` or `???` — everything after that line is notes.
 */
function extractNotes(section: string): { content: string; notes: string } {
  const notesPattern = /^(?:Notes:|[?]{3})\s*$/m;
  const match = section.match(notesPattern);
  if (!match || match.index === undefined) {
    return { content: section, notes: '' };
  }
  return {
    content: section.substring(0, match.index).trim(),
    notes: section.substring(match.index + match[0].length).trim(),
  };
}

/**
 * Parse a single markdown section into a {@link ParsedSlide}.
 */
function parseSection(section: string): ParsedSlide {
  const { content, notes } = extractNotes(section);
  const tokens = Lexer.lex(content);

  let title = '';
  let subtitle: string | undefined;
  const bodyRuns: StyledRun[][] = [];
  const images: Array<{ url: string; alt: string }> = [];
  const tables: Array<{ headers: string[]; rows: string[][] }> = [];
  const codeBlocks: Array<{ lang: string; code: string }> = [];
  let titleDepth = 0;

  for (const token of tokens) {
    switch (token.type) {
      case 'heading': {
        const h = token as Tokens.Heading;
        if (!title && h.depth <= 2) {
          title = h.text;
          titleDepth = h.depth;
        } else if (titleDepth === 1 && h.depth === 2 && !subtitle) {
          subtitle = h.text;
        } else {
          // H3+ in body becomes a bold line
          bodyRuns.push([{ text: h.text, bold: true }]);
        }
        break;
      }

      case 'paragraph': {
        const p = token as Tokens.Paragraph;

        // Check for standalone images in paragraphs
        if (p.tokens && p.tokens.length === 1 && p.tokens[0]?.type === 'image') {
          const img = p.tokens[0] as Tokens.Image;
          images.push({ url: img.href, alt: img.text });
          break;
        }

        // Check for images mixed with text
        const nonImageTokens: Token[] = [];
        for (const pt of p.tokens ?? []) {
          if (pt.type === 'image') {
            const img = pt as Tokens.Image;
            images.push({ url: img.href, alt: img.text });
          } else {
            nonImageTokens.push(pt);
          }
        }

        if (nonImageTokens.length > 0) {
          bodyRuns.push(inlineTokensToRuns(nonImageTokens));
        }
        break;
      }

      case 'list': {
        const list = token as Tokens.List;
        for (let i = 0; i < list.items.length; i++) {
          const item = list.items[i]!;
          const prefix = list.ordered ? `${i + 1}. ` : BULLET_GLYPH;
          const runs = item.tokens
            ? inlineTokensToRuns(item.tokens)
            : [{ text: item.text }];
          // Prepend the list prefix to the first run
          if (runs.length > 0 && runs[0]) {
            runs[0] = { ...runs[0], text: prefix + runs[0].text };
          } else {
            runs.push({ text: prefix + item.text });
          }
          bodyRuns.push(runs);
        }
        break;
      }

      case 'code': {
        const c = token as Tokens.Code;
        codeBlocks.push({ lang: c.lang ?? '', code: c.text });
        break;
      }

      case 'table': {
        const t = token as Tokens.Table;
        const headers = t.header.map((cell) => cell.text);
        const rows = t.rows.map((row) => row.map((cell) => cell.text));
        tables.push({ headers, rows });
        break;
      }

      case 'blockquote': {
        const bq = token as Tokens.Blockquote;
        const bqText = bq.text ?? '';
        bodyRuns.push([{ text: bqText, italic: true }]);
        break;
      }

      case 'space':
      case 'hr':
        // Ignore whitespace and horizontal rules (already used as separators)
        break;

      default:
        // Fallback for any unhandled token types
        if ('text' in token && typeof (token as { text: unknown }).text === 'string') {
          bodyRuns.push([{ text: (token as { text: string }).text }]);
        }
        break;
    }
  }

  // Determine layout
  const layout = detectLayout(title, bodyRuns, images, tables, codeBlocks);

  return { title, subtitle, bodyRuns, images, tables, codeBlocks, notes, layout };
}

// ─────────────────────────────────────────────────────────────────────────────
// Layout Detection
// ─────────────────────────────────────────────────────────────────────────────

/**
 * Detect the best predefined layout based on the slide content.
 */
function detectLayout(
  title: string,
  bodyRuns: StyledRun[][],
  images: Array<{ url: string; alt: string }>,
  tables: Array<{ headers: string[]; rows: string[][] }>,
  codeBlocks: Array<{ lang: string; code: string }>,
): string {
  const hasBody =
    bodyRuns.length > 0 ||
    images.length > 0 ||
    tables.length > 0 ||
    codeBlocks.length > 0;

  if (!title && !hasBody) {
    return PREDEFINED_LAYOUTS.BLANK;
  }
  if (title && !hasBody) {
    return PREDEFINED_LAYOUTS.TITLE_ONLY;
  }
  if (!title && hasBody) {
    return PREDEFINED_LAYOUTS.BLANK;
  }
  // Title + body content
  return PREDEFINED_LAYOUTS.TITLE_AND_BODY;
}

// ─────────────────────────────────────────────────────────────────────────────
// Request Generation
// ─────────────────────────────────────────────────────────────────────────────

/**
 * Build an `insertText` + style requests for a text element.
 *
 * @param objectId - The text box element ID.
 * @param runs - Array of styled text runs.
 * @param baseFontSize - Base font size for plain text.
 * @returns Array of batch update requests.
 */
function buildTextRequests(
  objectId: string,
  runs: StyledRun[],
  baseFontSize: number = DEFAULT_BODY_FONT_SIZE,
): slides_v1.Schema$Request[] {
  const requests: slides_v1.Schema$Request[] = [];

  // Build the full text string first
  const fullText = runs.map((r) => r.text).join('');
  if (!fullText.trim()) return requests;

  // Insert all text at once
  requests.push({
    insertText: {
      objectId,
      text: fullText,
      insertionIndex: 0,
    },
  });

  // Apply style to each run
  let offset = 0;
  for (const run of runs) {
    if (!run.text) {
      continue;
    }

    const startIndex = offset;
    const endIndex = offset + run.text.length;
    offset = endIndex;

    // Build style
    const style: slides_v1.Schema$TextStyle = {
      fontFamily: run.code ? CODE_FONT_FAMILY : DEFAULT_FONT_FAMILY,
      fontSize: {
        magnitude: run.code ? CODE_FONT_SIZE : baseFontSize,
        unit: 'PT',
      },
    };

    const fields: string[] = ['fontFamily', 'fontSize'];

    if (run.bold) {
      style.bold = true;
      fields.push('bold');
    }

    if (run.italic) {
      style.italic = true;
      fields.push('italic');
    }

    if (run.code) {
      style.backgroundColor = {
        opaqueColor: { rgbColor: CODE_BG_COLOR },
      };
      fields.push('backgroundColor');
    }

    if (run.link) {
      style.link = { url: run.link };
      style.foregroundColor = {
        opaqueColor: { rgbColor: { red: 0.1, green: 0.45, blue: 0.9 } },
      };
      style.underline = true;
      fields.push('link', 'foregroundColor', 'underline');
    }

    requests.push({
      updateTextStyle: {
        objectId,
        textRange: {
          type: 'FIXED_RANGE',
          startIndex,
          endIndex,
        },
        style,
        fields: fields.join(','),
      },
    });
  }

  return requests;
}

/**
 * Build batch-update requests for a single parsed slide.
 *
 * @param slide - The parsed slide content.
 * @param slideIndex - The zero-based slide index for insertion ordering.
 * @returns Array of Google Slides API request objects.
 */
function buildSlideRequests(
  slide: ParsedSlide,
  slideIndex: number,
): slides_v1.Schema$Request[] {
  const requests: slides_v1.Schema$Request[] = [];
  const slideId = generateId('slide');

  // Create the slide
  requests.push({
    createSlide: {
      objectId: slideId,
      insertionIndex: slideIndex,
      slideLayoutReference: {
        predefinedLayout: slide.layout as 'BLANK' | 'TITLE' | 'TITLE_AND_BODY' | 'TITLE_ONLY',
      },
    },
  });

  // Layout calculations
  const marginLeft = DEFAULT_MARGIN_LEFT;
  const marginTop = DEFAULT_MARGIN_TOP;
  const contentWidth = CONTENT_AREA.width;
  let currentY = marginTop;

  // ── Title ──────────────────────────────────────────────────────────────
  if (slide.title) {
    const titleId = generateId('title');
    const titleHeight = 50;

    requests.push({
      createShape: {
        objectId: titleId,
        shapeType: 'TEXT_BOX',
        elementProperties: {
          pageObjectId: slideId,
          size: {
            width: { magnitude: pt(contentWidth), unit: 'EMU' },
            height: { magnitude: pt(titleHeight), unit: 'EMU' },
          },
          transform: {
            scaleX: 1,
            scaleY: 1,
            translateX: pt(marginLeft),
            translateY: pt(currentY),
            unit: 'EMU',
          },
        },
      },
    });

    requests.push({
      insertText: {
        objectId: titleId,
        text: slide.title,
        insertionIndex: 0,
      },
    });

    requests.push({
      updateTextStyle: {
        objectId: titleId,
        textRange: { type: 'ALL' },
        style: {
          fontFamily: DEFAULT_FONT_FAMILY,
          fontSize: { magnitude: DEFAULT_TITLE_FONT_SIZE, unit: 'PT' },
          bold: true,
          foregroundColor: {
            opaqueColor: { rgbColor: { red: 0.13, green: 0.13, blue: 0.13 } },
          },
        },
        fields: 'fontFamily,fontSize,bold,foregroundColor',
      },
    });

    currentY += titleHeight + 5;

    // ── Subtitle ──────────────────────────────────────────────────────────
    if (slide.subtitle) {
      const subtitleId = generateId('subtitle');
      const subtitleHeight = 35;

      requests.push({
        createShape: {
          objectId: subtitleId,
          shapeType: 'TEXT_BOX',
          elementProperties: {
            pageObjectId: slideId,
            size: {
              width: { magnitude: pt(contentWidth), unit: 'EMU' },
              height: { magnitude: pt(subtitleHeight), unit: 'EMU' },
            },
            transform: {
              scaleX: 1,
              scaleY: 1,
              translateX: pt(marginLeft),
              translateY: pt(currentY),
              unit: 'EMU',
            },
          },
        },
      });

      requests.push({
        insertText: {
          objectId: subtitleId,
          text: slide.subtitle,
          insertionIndex: 0,
        },
      });

      requests.push({
        updateTextStyle: {
          objectId: subtitleId,
          textRange: { type: 'ALL' },
          style: {
            fontFamily: DEFAULT_FONT_FAMILY,
            fontSize: { magnitude: SUBTITLE_FONT_SIZE, unit: 'PT' },
            foregroundColor: {
              opaqueColor: { rgbColor: { red: 0.37, green: 0.37, blue: 0.37 } },
            },
          },
          fields: 'fontFamily,fontSize,foregroundColor',
        },
      });

      currentY += subtitleHeight + 5;
    }
  }

  // ── Body Text ──────────────────────────────────────────────────────────
  if (slide.bodyRuns.length > 0) {
    const bodyId = generateId('body');
    const bodyHeight = DEFAULT_PAGE_HEIGHT - currentY - DEFAULT_MARGIN_BOTTOM;

    requests.push({
      createShape: {
        objectId: bodyId,
        shapeType: 'TEXT_BOX',
        elementProperties: {
          pageObjectId: slideId,
          size: {
            width: { magnitude: pt(contentWidth), unit: 'EMU' },
            height: { magnitude: pt(bodyHeight), unit: 'EMU' },
          },
          transform: {
            scaleX: 1,
            scaleY: 1,
            translateX: pt(marginLeft),
            translateY: pt(currentY),
            unit: 'EMU',
          },
        },
      },
    });

    // Flatten all body runs with newlines between paragraphs
    const allRuns: StyledRun[] = [];
    for (let i = 0; i < slide.bodyRuns.length; i++) {
      const lineRuns = slide.bodyRuns[i]!;
      allRuns.push(...lineRuns);
      if (i < slide.bodyRuns.length - 1) {
        allRuns.push({ text: '\n' });
      }
    }

    requests.push(...buildTextRequests(bodyId, allRuns));

    // Track how much vertical space the body uses (rough estimate)
    const estimatedBodyLines = slide.bodyRuns.length;
    const lineHeightPt = DEFAULT_BODY_FONT_SIZE * 1.4;
    currentY += Math.min(
      estimatedBodyLines * lineHeightPt + 15,
      bodyHeight,
    );
  }

  // ── Images ─────────────────────────────────────────────────────────────
  for (const image of slide.images) {
    const imgId = generateId('img');
    const imgWidth = Math.min(contentWidth, 400);
    const imgHeight = imgWidth * 0.6; // Approximate 5:3 aspect
    const imgX = marginLeft + (contentWidth - imgWidth) / 2; // Center horizontally

    // Ensure we don't exceed slide bounds
    if (currentY + imgHeight > DEFAULT_PAGE_HEIGHT - DEFAULT_MARGIN_BOTTOM) {
      currentY = DEFAULT_MARGIN_TOP;
    }

    requests.push({
      createImage: {
        objectId: imgId,
        url: image.url,
        elementProperties: {
          pageObjectId: slideId,
          size: {
            width: { magnitude: pt(imgWidth), unit: 'EMU' },
            height: { magnitude: pt(imgHeight), unit: 'EMU' },
          },
          transform: {
            scaleX: 1,
            scaleY: 1,
            translateX: pt(imgX),
            translateY: pt(currentY),
            unit: 'EMU',
          },
        },
      },
    });

    currentY += imgHeight + 10;
  }

  // ── Code Blocks ────────────────────────────────────────────────────────
  for (const codeBlock of slide.codeBlocks) {
    const codeId = generateId('code');
    const codeLines = codeBlock.code.split('\n').length;
    const codeHeight = Math.min(codeLines * 16 + 20, 200);

    if (currentY + codeHeight > DEFAULT_PAGE_HEIGHT - DEFAULT_MARGIN_BOTTOM) {
      currentY = DEFAULT_MARGIN_TOP + 55;
    }

    requests.push({
      createShape: {
        objectId: codeId,
        shapeType: 'TEXT_BOX',
        elementProperties: {
          pageObjectId: slideId,
          size: {
            width: { magnitude: pt(contentWidth), unit: 'EMU' },
            height: { magnitude: pt(codeHeight), unit: 'EMU' },
          },
          transform: {
            scaleX: 1,
            scaleY: 1,
            translateX: pt(marginLeft),
            translateY: pt(currentY),
            unit: 'EMU',
          },
        },
      },
    });

    // Set background fill on the code box
    requests.push({
      updateShapeProperties: {
        objectId: codeId,
        shapeProperties: {
          shapeBackgroundFill: {
            solidFill: {
              color: { rgbColor: CODE_BG_COLOR },
              alpha: 1,
            },
          },
        },
        fields: 'shapeBackgroundFill',
      },
    });

    requests.push({
      insertText: {
        objectId: codeId,
        text: codeBlock.code,
        insertionIndex: 0,
      },
    });

    requests.push({
      updateTextStyle: {
        objectId: codeId,
        textRange: { type: 'ALL' },
        style: {
          fontFamily: CODE_FONT_FAMILY,
          fontSize: { magnitude: CODE_FONT_SIZE, unit: 'PT' },
          foregroundColor: {
            opaqueColor: { rgbColor: { red: 0.2, green: 0.2, blue: 0.2 } },
          },
        },
        fields: 'fontFamily,fontSize,foregroundColor',
      },
    });

    currentY += codeHeight + 10;
  }

  // ── Tables ─────────────────────────────────────────────────────────────
  for (const table of slide.tables) {
    const tableId = generateId('table');
    const totalRows = table.rows.length + 1; // +1 for header row
    const totalCols = table.headers.length;
    const rowHeight = 25;
    const tableHeight = Math.min(totalRows * rowHeight, 200);

    if (currentY + tableHeight > DEFAULT_PAGE_HEIGHT - DEFAULT_MARGIN_BOTTOM) {
      currentY = DEFAULT_MARGIN_TOP + 55;
    }

    requests.push({
      createTable: {
        objectId: tableId,
        elementProperties: {
          pageObjectId: slideId,
          size: {
            width: { magnitude: pt(contentWidth), unit: 'EMU' },
            height: { magnitude: pt(tableHeight), unit: 'EMU' },
          },
          transform: {
            scaleX: 1,
            scaleY: 1,
            translateX: pt(marginLeft),
            translateY: pt(currentY),
            unit: 'EMU',
          },
        },
        rows: totalRows,
        columns: totalCols,
      },
    });

    // Insert header text
    for (let col = 0; col < totalCols; col++) {
      const headerText = table.headers[col] ?? '';
      if (headerText) {
        requests.push({
          insertText: {
            objectId: tableId,
            cellLocation: { rowIndex: 0, columnIndex: col },
            text: headerText,
            insertionIndex: 0,
          },
        });
      }
    }

    // Insert body rows
    for (let row = 0; row < table.rows.length; row++) {
      const rowData = table.rows[row]!;
      for (let col = 0; col < totalCols; col++) {
        const cellText = rowData[col] ?? '';
        if (cellText) {
          requests.push({
            insertText: {
              objectId: tableId,
              cellLocation: { rowIndex: row + 1, columnIndex: col },
              text: cellText,
              insertionIndex: 0,
            },
          });
        }
      }
    }

    // Style header row (bold)
    for (let col = 0; col < totalCols; col++) {
      requests.push({
        updateTextStyle: {
          objectId: tableId,
          cellLocation: { rowIndex: 0, columnIndex: col },
          textRange: { type: 'ALL' },
          style: {
            bold: true,
            fontFamily: DEFAULT_FONT_FAMILY,
            fontSize: { magnitude: DEFAULT_CAPTION_FONT_SIZE, unit: 'PT' },
          },
          fields: 'bold,fontFamily,fontSize',
        },
      });
    }

    // Style body rows
    for (let row = 0; row < table.rows.length; row++) {
      for (let col = 0; col < totalCols; col++) {
        requests.push({
          updateTextStyle: {
            objectId: tableId,
            cellLocation: { rowIndex: row + 1, columnIndex: col },
            textRange: { type: 'ALL' },
            style: {
              fontFamily: DEFAULT_FONT_FAMILY,
              fontSize: { magnitude: DEFAULT_CAPTION_FONT_SIZE, unit: 'PT' },
            },
            fields: 'fontFamily,fontSize',
          },
        });
      }
    }

    currentY += tableHeight + 10;
  }

  // ── Speaker Notes ──────────────────────────────────────────────────────
  // NOTE: Speaker notes cannot be added via batch update because the notes
  // page placeholder ID must be discovered via `presentations.get` after
  // the slide is created. The fabricated `${slideId}_notes` object ID is
  // not valid. Notes must be added via a separate API call that first
  // retrieves the actual notes placeholder element ID from the slide's
  // notesPage property.

  return requests;
}

// ─────────────────────────────────────────────────────────────────────────────
// Public API
// ─────────────────────────────────────────────────────────────────────────────

/**
 * Parse markdown content into an array of {@link MarkdownSlide} objects.
 *
 * @param markdown - The raw markdown string.
 * @returns Parsed slide objects.
 */
export function parseMarkdown(markdown: string): MarkdownSlide[] {
  const sections = splitIntoSections(markdown);
  log.debug('Split markdown into sections', { count: sections.length });

  return sections.map((section) => {
    const parsed = parseSection(section);
    return {
      title: parsed.title,
      body: parsed.bodyRuns.map((runs) =>
        runs.map((r) => r.text).join(''),
      ),
      notes: parsed.notes || undefined,
      layout: parsed.layout,
    };
  });
}

/**
 * Convert markdown into Google Slides API batch-update requests that
 * create a complete presentation.
 *
 * This function creates slides and populates them with formatted content.
 * The caller must first create a presentation (or use an existing one)
 * and then call `batchUpdate` with the returned requests.
 *
 * @param title - The presentation title (used for the first slide if no
 *   explicit title heading is found).
 * @param markdown - The markdown content to convert.
 * @returns An array of Google Slides API request objects.
 */
export function markdownToSlideRequests(
  title: string,
  markdown: string,
): slides_v1.Schema$Request[] {
  const sections = splitIntoSections(markdown);
  log.info('Converting markdown to slide requests', {
    title,
    sectionCount: sections.length,
  });

  const allRequests: slides_v1.Schema$Request[] = [];

  for (let i = 0; i < sections.length; i++) {
    const section = sections[i]!;
    const parsed = parseSection(section);

    // If the first section has no title, use the presentation title
    if (i === 0 && !parsed.title) {
      parsed.title = title;
    }

    const slideRequests = buildSlideRequests(parsed, i);
    allRequests.push(...slideRequests);
  }

  log.info('Generated slide requests', {
    requestCount: allRequests.length,
    slideCount: sections.length,
  });

  return allRequests as BatchRequest[];
}/**
 * Create a new presentation from markdown content.
 *
 * This is the high-level entry point. It:
 * 1. Creates a new presentation with the given title.
 * 2. Converts markdown to batch-update requests.
 * 3. Applies the requests to populate the presentation.
 * 4. Deletes the initial blank slide created by Google.
 *
 * @param title - The presentation title.
 * @param markdown - The markdown content.
 * @returns An object containing the batch-update requests and a function
 *   to generate the delete-blank-slide request.
 */
export function markdownToSlides(
  title: string,
  markdown: string,
): {
  createRequests: slides_v1.Schema$Request[];
  deleteInitialSlideRequest: (initialSlideId: string) => slides_v1.Schema$Request;
} {
  const createRequests = markdownToSlideRequests(title, markdown);

  return {
    createRequests,
    deleteInitialSlideRequest: (initialSlideId: string) => ({
      deleteObject: { objectId: initialSlideId },
    }),
  };
}

/**
 * Generate batch-update requests to replace all content in an existing
 * presentation with new markdown content.
 *
 * The caller should:
 * 1. Get the presentation to find existing slide IDs.
 * 2. Delete all existing slides.
 * 3. Apply the returned requests.
 *
 * @param markdown - The markdown content.
 * @param existingSlideIds - IDs of existing slides to delete first.
 * @returns Array of batch-update requests (deletes + creates).
 */
export function updatePresentationFromMarkdown(
  markdown: string,
  existingSlideIds: string[],
): BatchRequest[] {
  const requests: BatchRequest[] = [];

  // Generate new slide requests FIRST — the Google Slides API requires
  // at least one slide to exist at all times, so we must create the new
  // slides before deleting the old ones.
  const createRequests = markdownToSlideRequests('', markdown);
  requests.push(...(createRequests as BatchRequest[]));

  // Delete all existing slides (in reverse order to maintain indices)
  for (const slideId of [...existingSlideIds].reverse()) {
    requests.push({ deleteObject: { objectId: slideId } });
  }

  log.info('Generated update-from-markdown requests', {
    deletedSlides: existingSlideIds.length,
    totalRequests: requests.length,
  });

  return requests;
}

/**
 * Generate batch-update requests to append slides from markdown to an
 * existing presentation.
 *
 * @param markdown - The markdown content for new slides.
 * @param insertionIndex - The index at which to insert new slides
 *   (defaults to the end of the presentation).
 * @returns Array of batch-update requests.
 */
export function appendSlidesFromMarkdown(
  markdown: string,
  insertionIndex: number,
): BatchRequest[] {
  const sections = splitIntoSections(markdown);
  const allRequests: slides_v1.Schema$Request[] = [];

  for (let i = 0; i < sections.length; i++) {
    const section = sections[i]!;
    const parsed = parseSection(section);
    const slideRequests = buildSlideRequests(parsed, insertionIndex + i);
    allRequests.push(...slideRequests);
  }

  log.info('Generated append-from-markdown requests', {
    newSlides: sections.length,
    insertionIndex,
    totalRequests: allRequests.length,
  });

  return allRequests as BatchRequest[];
}
