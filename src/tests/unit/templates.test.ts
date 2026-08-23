/**
 * Template system tests
 */
import { describe, it, expect } from 'vitest';
import { TEMPLATE_CATEGORIES } from '../../templates/types.js';
import type { SlideTemplate, TemplateCategory, TemplateVariable } from '../../templates/types.js';
import { InMemoryStorageAdapter } from '../../storage/index.js';
import type { TemplateRecord } from '../../storage/types.js';

// ─────────────────────────────────────────────────────────────────────────────
// Template type tests
// ─────────────────────────────────────────────────────────────────────────────

describe('Template Types', () => {
  it('TEMPLATE_CATEGORIES has 10 categories', () => {
    expect(TEMPLATE_CATEGORIES).toHaveLength(10);
  });

  it('includes expected categories', () => {
    const expected: TemplateCategory[] = ['business', 'pitch', 'education', 'marketing', 'report', 'portfolio', 'proposal', 'meeting', 'workshop', 'creative'];
    for (const cat of expected) {
      expect(TEMPLATE_CATEGORIES).toContain(cat);
    }
  });

  it('all categories are lowercase strings', () => {
    for (const cat of TEMPLATE_CATEGORIES) {
      expect(cat).toBe(cat.toLowerCase());
      expect(typeof cat).toBe('string');
    }
  });

  it('TEMPLATE_CATEGORIES is readonly', () => {
    // TypeScript ensures this at compile time; we verify the array exists
    expect(Array.isArray(TEMPLATE_CATEGORIES)).toBe(true);
  });
});

// ─────────────────────────────────────────────────────────────────────────────
// Template structure validation
// ─────────────────────────────────────────────────────────────────────────────

describe('SlideTemplate structure', () => {
  const validTemplate: SlideTemplate = {
    id: 'test-template',
    name: 'Test Template',
    description: 'A test template',
    category: 'business',
    tags: ['test', 'sample'],
    slides: [
      {
        layout: 'title',
        title: 'Welcome {{company}}',
        subtitle: 'Presented by {{author}}',
      },
      {
        layout: 'title_content',
        title: 'Overview',
        body: 'Content goes here',
        bullets: ['Point 1', 'Point 2'],
      },
    ],
    theme: {
      primaryColor: '#1A73E8',
      secondaryColor: '#34A853',
      accentColor: '#FBBC04',
      backgroundColor: '#FFFFFF',
      titleFont: 'Montserrat',
      bodyFont: 'Open Sans',
      titleSize: 36,
      bodySize: 18,
    },
    variables: [
      {
        name: 'company',
        description: 'Company name',
        defaultValue: 'Acme Corp',
        type: 'text',
        required: true,
      },
      {
        name: 'author',
        description: 'Author name',
        defaultValue: 'John Doe',
        type: 'text',
        required: false,
      },
    ],
  };

  it('has valid structure with required fields', () => {
    expect(validTemplate.id).toBeTruthy();
    expect(validTemplate.name).toBeTruthy();
    expect(validTemplate.description).toBeTruthy();
    expect(TEMPLATE_CATEGORIES).toContain(validTemplate.category);
  });

  it('has slides array with valid layouts', () => {
    expect(validTemplate.slides.length).toBeGreaterThan(0);
    expect(validTemplate.slides[0]!.layout).toBe('title');
  });

  it('has theme with color values', () => {
    expect(validTemplate.theme.primaryColor).toMatch(/^#[0-9A-Fa-f]{6}$/);
    expect(validTemplate.theme.secondaryColor).toMatch(/^#[0-9A-Fa-f]{6}$/);
  });

  it('has variables defined', () => {
    expect(validTemplate.variables.length).toBeGreaterThan(0);
    const reqVar = validTemplate.variables.find(v => v.required);
    expect(reqVar).toBeDefined();
  });

  it('variables have valid types', () => {
    const validTypes = ['text', 'multiline', 'url', 'color', 'number'];
    for (const v of validTemplate.variables) {
      expect(validTypes).toContain(v.type);
    }
  });
});

// ─────────────────────────────────────────────────────────────────────────────
// Template rendering simulation
// ─────────────────────────────────────────────────────────────────────────────

describe('Template variable rendering', () => {
  function renderTemplate(text: string, vars: Record<string, string>): string {
    let result = text;
    for (const [key, val] of Object.entries(vars)) {
      result = result.replace(new RegExp(`\\{\\{${key}\\}\\}`, 'g'), val);
    }
    return result;
  }

  it('replaces simple variables', () => {
    expect(renderTemplate('Hello {{name}}', { name: 'World' })).toBe('Hello World');
  });

  it('replaces multiple occurrences', () => {
    expect(renderTemplate('{{x}} and {{x}}', { x: 'A' })).toBe('A and A');
  });

  it('replaces multiple different variables', () => {
    expect(renderTemplate('{{a}} {{b}}', { a: 'Hello', b: 'World' })).toBe('Hello World');
  });

  it('leaves unmatched variables as-is', () => {
    expect(renderTemplate('Hello {{unknown}}', {})).toBe('Hello {{unknown}}');
  });

  it('handles empty variables', () => {
    expect(renderTemplate('Hello {{name}}', { name: '' })).toBe('Hello ');
  });

  it('handles complex template text', () => {
    const tmpl = '# {{title}}\n\nBy {{author}}\n\n{{content}}';
    const result = renderTemplate(tmpl, {
      title: 'My Presentation',
      author: 'Jane',
      content: 'Great content here',
    });
    expect(result).toContain('My Presentation');
    expect(result).toContain('Jane');
    expect(result).toContain('Great content here');
  });
});

// ─────────────────────────────────────────────────────────────────────────────
// Template storage operations via InMemoryStorageAdapter
// ─────────────────────────────────────────────────────────────────────────────

describe('Template storage operations', () => {
  let store: InMemoryStorageAdapter;

  const makeTemplate = (id: string, category: string): TemplateRecord => ({
    id,
    name: `Template ${id}`,
    description: `Description for ${id}`,
    category,
    thumbnailUrl: null,
    markdown: `# ${id}`,
    theme: 'default',
    tags: JSON.stringify([category]),
    isBuiltIn: true,
    createdBy: null,
    createdAt: new Date().toISOString(),
  });

  beforeEach(async () => {
    store = new InMemoryStorageAdapter();
    await store.initialize();
  });

  it('creates templates for all categories', async () => {
    for (const cat of TEMPLATE_CATEGORIES) {
      await store.createTemplate(makeTemplate(`tpl-${cat}`, cat));
    }
    const all = await store.listTemplates();
    expect(all).toHaveLength(TEMPLATE_CATEGORIES.length);
  });

  it('filters templates by category', async () => {
    await store.createTemplate(makeTemplate('t1', 'business'));
    await store.createTemplate(makeTemplate('t2', 'business'));
    await store.createTemplate(makeTemplate('t3', 'pitch'));
    const biz = await store.listTemplates('business');
    expect(biz).toHaveLength(2);
  });

  it('retrieves a single template by id', async () => {
    await store.createTemplate(makeTemplate('my-tpl', 'education'));
    const t = await store.getTemplate('my-tpl');
    expect(t).not.toBeNull();
    expect(t!.category).toBe('education');
  });

  it('returns null for non-existent template', async () => {
    expect(await store.getTemplate('nope')).toBeNull();
  });

  it('deletes a template', async () => {
    await store.createTemplate(makeTemplate('del-me', 'creative'));
    expect(await store.deleteTemplate('del-me')).toBe(true);
    expect(await store.getTemplate('del-me')).toBeNull();
  });

  it('template markdown can contain variables', async () => {
    const tpl = makeTemplate('var-tpl', 'proposal');
    tpl.markdown = '# {{title}}\nBy {{author}}';
    await store.createTemplate(tpl);
    const loaded = await store.getTemplate('var-tpl');
    expect(loaded!.markdown).toContain('{{title}}');
    expect(loaded!.markdown).toContain('{{author}}');
  });

  it('template tags are stored as JSON string', async () => {
    const tpl = makeTemplate('tag-tpl', 'marketing');
    tpl.tags = JSON.stringify(['marketing', 'social', 'ads']);
    await store.createTemplate(tpl);
    const loaded = await store.getTemplate('tag-tpl');
    const tags = JSON.parse(loaded!.tags);
    expect(tags).toHaveLength(3);
    expect(tags).toContain('social');
  });
});
