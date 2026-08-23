/**
 * Unit tests for the API layer: auth, client, markdown, tools.
 */
import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest';

// ─── Auth Module ───────────────────────────────────────────────────────────────

vi.mock('googleapis', () => {
  const mockOAuth2 = vi.fn().mockImplementation(() => ({
    setCredentials: vi.fn(),
    on: vi.fn(),
    getAccessToken: vi.fn().mockResolvedValue({ token: 'mock-token' }),
    generateAuthUrl: vi.fn().mockReturnValue('https://accounts.google.com/o/oauth2/auth?mock'),
    getToken: vi.fn().mockResolvedValue({
      tokens: {
        access_token: 'at',
        refresh_token: 'rt',
        expiry_date: Date.now() + 3600_000,
      },
    }),
  }));

  return {
    google: {
      auth: { OAuth2: mockOAuth2 },
      slides: vi.fn().mockReturnValue({ presentations: {} }),
      drive: vi.fn().mockReturnValue({ files: {}, permissions: {} }),
    },
  };
});

import { AuthenticationError } from '../../shared/errors.js';

describe('Auth Module', () => {
  beforeEach(() => {
    vi.resetModules();
  });

  it('getAuthenticatedClient succeeds with valid credentials', async () => {
    const { getAuthenticatedClient, clearAuthCache } = await import('../../api/auth.js');
    clearAuthCache();
    const client = await getAuthenticatedClient({
      clientId: 'test-id',
      clientSecret: 'test-secret',
      refreshToken: 'test-token',
    });
    expect(client).toBeDefined();
    expect(client.getAccessToken).toBeDefined();
  });

  it('getAuthenticatedClient throws for missing clientId', async () => {
    const { getAuthenticatedClient, clearAuthCache } = await import('../../api/auth.js');
    clearAuthCache();
    try {
      await getAuthenticatedClient({ clientId: '', clientSecret: 'x', refreshToken: 'x' }, true);
      expect.fail('Should have thrown');
    } catch (e: unknown) {
      expect((e as Error).name).toBe('AuthenticationError');
      expect((e as Error).message).toContain('Missing');
    }
  });

  it('getAuthenticatedClient throws for missing clientSecret', async () => {
    const { getAuthenticatedClient, clearAuthCache } = await import('../../api/auth.js');
    clearAuthCache();
    try {
      await getAuthenticatedClient({ clientId: 'x', clientSecret: '', refreshToken: 'x' }, true);
      expect.fail('Should have thrown');
    } catch (e: unknown) {
      expect((e as Error).name).toBe('AuthenticationError');
      expect((e as Error).message).toContain('Missing');
    }
  });

  it('getAuthenticatedClient throws for missing refreshToken', async () => {
    const { getAuthenticatedClient, clearAuthCache } = await import('../../api/auth.js');
    clearAuthCache();
    try {
      await getAuthenticatedClient({ clientId: 'x', clientSecret: 'x', refreshToken: '' }, true);
      expect.fail('Should have thrown');
    } catch (e: unknown) {
      expect((e as Error).name).toBe('AuthenticationError');
      expect((e as Error).message).toContain('Missing');
    }
  });

  it('getAuthorizationUrl returns a URL string', async () => {
    const { getAuthorizationUrl } = await import('../../api/auth.js');
    const url = getAuthorizationUrl('cid', 'csecret');
    expect(url).toContain('https://accounts.google.com');
  });

  it('clearAuthCache does not throw', async () => {
    const { clearAuthCache } = await import('../../api/auth.js');
    expect(() => clearAuthCache()).not.toThrow();
  });
});

// ─── Markdown Module (no mocking needed - pure functions) ──────────────────────

import {
  parseMarkdown,
  markdownToSlideRequests,
  markdownToSlides,
  updatePresentationFromMarkdown,
  appendSlidesFromMarkdown,
} from '../../api/markdown.js';

describe('parseMarkdown', () => {
  it('parses a simple heading into a slide with title', () => {
    const slides = parseMarkdown('# Hello World\n\nSome body text.');
    expect(slides.length).toBeGreaterThanOrEqual(1);
    expect(slides[0]!.title).toBe('Hello World');
    expect(slides[0]!.body.length).toBeGreaterThan(0);
  });

  it('splits on --- page breaks', () => {
    const md = '# Slide 1\n\nContent 1\n\n---\n\n# Slide 2\n\nContent 2';
    const slides = parseMarkdown(md);
    expect(slides.length).toBe(2);
    expect(slides[0]!.title).toBe('Slide 1');
    expect(slides[1]!.title).toBe('Slide 2');
  });

  it('handles bullet lists', () => {
    const md = '# Title\n\n- Item 1\n- Item 2\n- Item 3';
    const slides = parseMarkdown(md);
    expect(slides[0]!.body.length).toBe(3);
    expect(slides[0]!.body[0]).toContain('Item 1');
  });

  it('handles numbered lists', () => {
    const md = '# Title\n\n1. First\n2. Second\n3. Third';
    const slides = parseMarkdown(md);
    expect(slides[0]!.body.length).toBe(3);
    expect(slides[0]!.body[0]).toContain('First');
  });

  it('handles code blocks', () => {
    const md = '# Code\n\n```js\nconsole.log("hello");\n```';
    const slides = parseMarkdown(md);
    expect(slides.length).toBeGreaterThanOrEqual(1);
    // Code blocks are part of the slide content
    expect(slides[0]!.title).toBe('Code');
  });

  it('handles image syntax', () => {
    const md = '# Images\n\n![alt](https://example.com/img.png)';
    const slides = parseMarkdown(md);
    expect(slides.length).toBeGreaterThanOrEqual(1);
  });

  it('handles tables', () => {
    const md = '# Data\n\n| Name | Value |\n|------|-------|\n| A | 1 |\n| B | 2 |';
    const slides = parseMarkdown(md);
    expect(slides.length).toBeGreaterThanOrEqual(1);
  });

  it('handles empty markdown gracefully', () => {
    const slides = parseMarkdown('');
    expect(slides.length).toBe(0);
  });

  it('handles single-line markdown', () => {
    const slides = parseMarkdown('# Just a title');
    expect(slides.length).toBe(1);
    expect(slides[0]!.title).toBe('Just a title');
  });

  it('auto-paginates long content without breaks', () => {
    const longContent = Array.from({ length: 20 }, (_, i) => `Line ${i + 1}: Some content here that is long enough.`).join('\n');
    const slides = parseMarkdown(longContent);
    expect(slides.length).toBeGreaterThan(1);
  });

  it('detects TITLE layout for title-only slides', () => {
    const slides = parseMarkdown('# Just a Title');
    expect(slides[0]!.layout).toBe('TITLE_ONLY');
  });

  it('detects TITLE_AND_BODY for title + content', () => {
    const slides = parseMarkdown('# Title\n\nBody content here.');
    expect(slides[0]!.layout).toBe('TITLE_AND_BODY');
  });

  it('detects BLANK for no title, no body', () => {
    // Completely empty sections are filtered out, so we test a section with only space
    // Actually, empty markdown returns 0 slides. BLANK is for body-only content
    const slides = parseMarkdown('Just body text without a heading');
    if (slides.length > 0) {
      expect(slides[0]!.layout).toBe('BLANK');
    }
  });

  it('handles inline formatting markers', () => {
    const md = '# Formatting\n\n**bold** and *italic* and `code` and [link](http://x.com)';
    const slides = parseMarkdown(md);
    expect(slides[0]!.body.length).toBeGreaterThan(0);
    // The body text should contain the raw text
    const bodyText = slides[0]!.body.join(' ');
    expect(bodyText).toContain('bold');
    expect(bodyText).toContain('italic');
    expect(bodyText).toContain('code');
    expect(bodyText).toContain('link');
  });

  it('extracts speaker notes', () => {
    const md = '# Slide\n\nContent\n\nNotes:\nSpeaker note text here.';
    const slides = parseMarkdown(md);
    expect(slides[0]!.notes).toBe('Speaker note text here.');
  });
});

describe('markdownToSlideRequests', () => {
  it('generates createSlide requests', () => {
    const requests = markdownToSlideRequests('Test', '# Hello\n\nWorld');
    expect(requests.length).toBeGreaterThan(0);
    const createSlideReqs = requests.filter((r) => r.createSlide);
    expect(createSlideReqs.length).toBeGreaterThanOrEqual(1);
  });

  it('generates insertText requests for titles', () => {
    const requests = markdownToSlideRequests('Test', '# My Title');
    const insertReqs = requests.filter((r) => r.insertText);
    expect(insertReqs.length).toBeGreaterThan(0);
  });

  it('uses presentation title when first section has no heading', () => {
    const requests = markdownToSlideRequests('Fallback Title', 'Just body content');
    const insertReqs = requests.filter((r) => r.insertText);
    const titleInsert = insertReqs.find((r) => {
      const text = (r.insertText as { text?: string })?.text;
      return text === 'Fallback Title';
    });
    expect(titleInsert).toBeDefined();
  });
});

describe('markdownToSlides', () => {
  it('returns createRequests and deleteInitialSlideRequest', () => {
    const result = markdownToSlides('Test', '# Slide 1');
    expect(result.createRequests).toBeDefined();
    expect(result.createRequests.length).toBeGreaterThan(0);
    const delReq = result.deleteInitialSlideRequest('initial_id');
    expect(delReq.deleteObject).toBeDefined();
    expect((delReq.deleteObject as { objectId: string }).objectId).toBe('initial_id');
  });
});

describe('updatePresentationFromMarkdown', () => {
  it('generates delete + create requests', () => {
    const requests = updatePresentationFromMarkdown(
      '# New\n\nContent',
      ['old_slide_1', 'old_slide_2'],
    );
    const deleteReqs = requests.filter((r) => r.deleteObject);
    const createReqs = requests.filter((r) => r.createSlide);
    expect(deleteReqs.length).toBe(2);
    expect(createReqs.length).toBeGreaterThanOrEqual(1);
  });

  it('deletes in reverse order', () => {
    const requests = updatePresentationFromMarkdown('# New', ['s1', 's2', 's3']);
    const deleteReqs = requests.filter((r) => r.deleteObject);
    expect((deleteReqs[0]!.deleteObject as { objectId: string }).objectId).toBe('s3');
    expect((deleteReqs[1]!.deleteObject as { objectId: string }).objectId).toBe('s2');
    expect((deleteReqs[2]!.deleteObject as { objectId: string }).objectId).toBe('s1');
  });

  it('create-slide requests come before delete-slide requests (#22)', () => {
    const requests = updatePresentationFromMarkdown(
      '# New Slide\n\nNew content',
      ['old1', 'old2'],
    );
    const firstCreateIdx = requests.findIndex((r) => r.createSlide);
    const firstDeleteIdx = requests.findIndex((r) => r.deleteObject);
    // Both should exist
    expect(firstCreateIdx).toBeGreaterThanOrEqual(0);
    expect(firstDeleteIdx).toBeGreaterThanOrEqual(0);
    // Creates should come before deletes
    expect(firstCreateIdx).toBeLessThan(firstDeleteIdx);
  });
});

describe('appendSlidesFromMarkdown', () => {
  it('generates create requests at the specified index', () => {
    const requests = appendSlidesFromMarkdown('# Appended', 5);
    const createReqs = requests.filter((r) => r.createSlide);
    expect(createReqs.length).toBeGreaterThanOrEqual(1);
    const cs = createReqs[0]!.createSlide as { insertionIndex?: number };
    expect(cs.insertionIndex).toBe(5);
  });
});

// ─── Tools Module ──────────────────────────────────────────────────────────────

import { apiTools, isApiTool, getApiTool } from '../../api/tools.js';

describe('API Tools', () => {
  it('has exactly 19 tool definitions', () => {
    expect(apiTools.length).toBe(19);
  });

  it('all tool names start with slides_', () => {
    for (const tool of apiTools) {
      expect(tool.name).toMatch(/^slides_/);
    }
  });

  it('all tools have name, description, inputSchema, handler', () => {
    for (const tool of apiTools) {
      expect(tool.name).toBeTruthy();
      expect(tool.description).toBeTruthy();
      expect(tool.inputSchema).toBeDefined();
      expect(typeof tool.handler).toBe('function');
    }
  });

  it('all tool input schemas have type "object"', () => {
    for (const tool of apiTools) {
      expect(tool.inputSchema.type).toBe('object');
    }
  });

  it('isApiTool returns true for known tools', () => {
    expect(isApiTool('slides_create_presentation')).toBe(true);
    expect(isApiTool('slides_get_presentation')).toBe(true);
    expect(isApiTool('slides_batch_update')).toBe(true);
    expect(isApiTool('slides_markdown_create')).toBe(true);
  });

  it('isApiTool returns false for unknown tools', () => {
    expect(isApiTool('live_screenshot')).toBe(false);
    expect(isApiTool('vision_analyze')).toBe(false);
    expect(isApiTool('unknown_tool')).toBe(false);
  });

  it('getApiTool returns tool definition for known names', () => {
    const tool = getApiTool('slides_create_presentation');
    expect(tool).toBeDefined();
    expect(tool!.name).toBe('slides_create_presentation');
  });

  it('getApiTool returns undefined for unknown names', () => {
    expect(getApiTool('nonexistent')).toBeUndefined();
  });

  it('includes all expected tool names', () => {
    const expectedNames = [
      'slides_create_presentation',
      'slides_get_presentation',
      'slides_get_page',
      'slides_get_page_thumbnail',
      'slides_batch_update',
      'slides_create_slide',
      'slides_delete_slide',
      'slides_duplicate_slide',
      'slides_add_text',
      'slides_add_image',
      'slides_add_table',
      'slides_add_shape',
      'slides_set_layout',
      'slides_markdown_create',
      'slides_markdown_update',
      'slides_markdown_append',
      'slides_export_pdf',
      'slides_share',
      'slides_summarize',
    ];
    const actualNames = apiTools.map((t) => t.name);
    for (const name of expectedNames) {
      expect(actualNames).toContain(name);
    }
  });
});

// ─── extractElementText fix (#1) ───────────────────────────────────────────

import { extractElementText } from '../../api/client.js';

describe('extractElementText (#1)', () => {
  it('returns shape text from a shape element', () => {
    const element = {
      shape: {
        text: {
          textElements: [
            { textRun: { content: 'Hello ' } },
            { textRun: { content: 'World' } },
          ],
        },
      },
    };
    expect(extractElementText(element)).toBe('Hello World');
  });

  it('returns table text from a table element', () => {
    const element = {
      table: {
        tableRows: [
          {
            tableCells: [
              { text: { textElements: [{ textRun: { content: 'A' } }] } },
              { text: { textElements: [{ textRun: { content: 'B' } }] } },
            ],
          },
          {
            tableCells: [
              { text: { textElements: [{ textRun: { content: 'C' } }] } },
              { text: { textElements: [{ textRun: { content: 'D' } }] } },
            ],
          },
        ],
      },
    };
    const result = extractElementText(element as any);
    expect(result).toContain('A');
    expect(result).toContain('B');
    expect(result).toContain('C');
    expect(result).toContain('D');
  });

  it('returns concatenated children text from a group element', () => {
    const element = {
      elementGroup: {
        children: [
          {
            shape: {
              text: {
                textElements: [{ textRun: { content: 'First' } }],
              },
            },
          },
          {
            shape: {
              text: {
                textElements: [{ textRun: { content: 'Second' } }],
              },
            },
          },
        ],
      },
    };
    const result = extractElementText(element as any);
    expect(result).toContain('First');
    expect(result).toContain('Second');
  });

  it('returns empty string for empty element', () => {
    expect(extractElementText({} as any)).toBe('');
    expect(extractElementText({ objectId: 'x' } as any)).toBe('');
  });
});

// ─── generateId crypto (#16) ───────────────────────────────────────────────

describe('generateId crypto (#16)', () => {
  it('generated IDs are unique (1000 IDs, check Set size)', () => {
    // We test via markdownToSlideRequests which uses generateId internally
    // Generate 1000 slide requests and verify IDs are unique
    const ids = new Set<string>();
    for (let i = 0; i < 1000; i++) {
      const requests = markdownToSlideRequests(`Test${i}`, `# Slide ${i}`);
      for (const req of requests) {
        if (req.createSlide) {
          const createSlide = req.createSlide as { objectId?: string };
          if (createSlide.objectId) {
            ids.add(createSlide.objectId);
          }
        }
      }
    }
    // All IDs should be unique
    expect(ids.size).toBe(1000);
  });

  it('IDs have sufficient length (>= 8 chars)', () => {
    const requests = markdownToSlideRequests('Test', '# Test Slide');
    for (const req of requests) {
      if (req.createSlide) {
        const createSlide = req.createSlide as { objectId?: string };
        if (createSlide.objectId) {
          expect(createSlide.objectId.length).toBeGreaterThanOrEqual(8);
        }
      }
    }
  });
});
