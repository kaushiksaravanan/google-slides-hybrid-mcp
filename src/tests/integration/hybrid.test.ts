/**
 * Integration tests for the hybrid MCP server.
 * Tests cross-layer interactions with mocked external dependencies.
 */
import { describe, it, expect, vi, beforeEach } from 'vitest';

// Mock googleapis
vi.mock('googleapis', () => {
  const mockOAuth2 = vi.fn().mockImplementation(() => ({
    setCredentials: vi.fn(),
    on: vi.fn(),
    getAccessToken: vi.fn().mockResolvedValue({ token: 'mock-token' }),
  }));
  return {
    google: {
      auth: { OAuth2: mockOAuth2 },
      slides: vi.fn().mockReturnValue({
        presentations: {
          create: vi.fn().mockResolvedValue({
            data: {
              presentationId: 'test-pres-id',
              title: 'Test',
              slides: [{ objectId: 'slide_1' }],
            },
          }),
          get: vi.fn().mockResolvedValue({
            data: {
              presentationId: 'test-pres-id',
              title: 'Test',
              slides: [{ objectId: 'slide_1', pageElements: [] }],
              pageSize: {
                width: { magnitude: 9144000, unit: 'EMU' },
                height: { magnitude: 5143500, unit: 'EMU' },
              },
            },
          }),
          batchUpdate: vi.fn().mockResolvedValue({
            data: { replies: [] },
          }),
          pages: {
            get: vi.fn().mockResolvedValue({
              data: { objectId: 'slide_1', pageElements: [] },
            }),
            getThumbnail: vi.fn().mockResolvedValue({
              data: { contentUrl: 'https://example.com/thumb.png', width: 1600, height: 900 },
            }),
          },
        },
      }),
      drive: vi.fn().mockReturnValue({
        files: {
          get: vi.fn().mockResolvedValue({ data: { id: 'test-pres-id', name: 'Test' } }),
        },
        permissions: {
          create: vi.fn().mockResolvedValue({ data: {} }),
        },
      }),
    },
  };
});

// Mock ws
vi.mock('ws', () => {
  const EventEmitter = require('eventemitter3');
  class MockWebSocketServer extends EventEmitter {
    constructor() { super(); }
    close(cb?: () => void) { cb?.(); }
    address() { return { port: 9222 }; }
  }
  return {
    WebSocketServer: MockWebSocketServer,
    WebSocket: { OPEN: 1 },
  };
});

vi.mock('node:child_process', () => ({
  execSync: vi.fn().mockReturnValue(''),
}));

import { apiTools, isApiTool, listApiTools } from '../../api/tools.js';
import { browserTools, listBrowserTools } from '../../browser/tools.js';
import { visionTools, listVisionTools } from '../../vision/tools.js';
import { HybridOrchestrator } from '../../orchestrator/orchestrator.js';
import type { HybridConfig } from '../../shared/types.js';

describe('Full MCP Tool Listing', () => {
  it('lists all API tools', () => {
    const tools = listApiTools();
    expect(tools.length).toBe(19);
    for (const tool of tools) {
      expect(tool.name).toMatch(/^slides_/);
      expect(tool.description).toBeTruthy();
      expect(tool.inputSchema).toBeDefined();
    }
  });

  it('lists all browser tools', () => {
    const tools = listBrowserTools();
    expect(tools.length).toBeGreaterThanOrEqual(22);
    for (const tool of tools) {
      expect(tool.name).toMatch(/^live_/);
    }
  });

  it('lists all vision tools', () => {
    const tools = listVisionTools();
    expect(tools.length).toBe(11);
    for (const tool of tools) {
      expect(tool.name).toMatch(/^vision_/);
    }
  });

  it('total tool count is at least 52 (19 + 22+ + 11)', () => {
    expect(apiTools.length + browserTools.length + visionTools.length).toBeGreaterThanOrEqual(52);
  });

  it('no tool name collisions across layers', () => {
    const allNames = [
      ...apiTools.map((t) => t.name),
      ...browserTools.map((t) => t.name),
      ...visionTools.map((t) => t.name),
    ];
    const uniqueNames = new Set(allNames);
    expect(uniqueNames.size).toBe(allNames.length);
  });
});

describe('Tool Routing Through Orchestrator', () => {
  it('correctly identifies which layer a tool belongs to', async () => {
    // API tools
    expect(isApiTool('slides_create_presentation')).toBe(true);
    expect(isApiTool('slides_markdown_create')).toBe(true);

    // Browser tools
    const { isBrowserTool } = await import('../../browser/tools.js');
    expect(isBrowserTool('live_screenshot')).toBe(true);
    expect(isBrowserTool('live_go_to_slide')).toBe(true);

    // Vision tools
    const { isVisionTool } = await import('../../vision/tools.js');
    expect(isVisionTool('vision_analyze_slide')).toBe(true);
    expect(isVisionTool('vision_apply_theme')).toBe(true);
  });
});

describe('Error Propagation Across Layers', () => {
  it('propagates auth errors from API layer', async () => {
    const orch = new HybridOrchestrator({
      api: { clientId: '', clientSecret: '', refreshToken: '' },
      browser: { wsPort: 0, screenshotFormat: 'png', timeout: 5000 },
      vision: { enabled: false, analysisModel: 'built-in', autoFix: false },
    });

    const result = await orch.executeToolAuto('slides_create_presentation', { title: 'Test' });
    expect(result.isError).toBe(true);
    expect(result.content[0]!.text).toContain('API layer is not available');
  });

  it('propagates browser errors for live_ tools', async () => {
    const orch = new HybridOrchestrator({
      api: { clientId: 'x', clientSecret: 'x', refreshToken: 'x' },
      browser: { wsPort: 0, screenshotFormat: 'png', timeout: 5000 },
      vision: { enabled: false, analysisModel: 'built-in', autoFix: false },
    });

    const result = await orch.executeToolAuto('live_screenshot', {});
    expect(result.isError).toBe(true);
  });
});

describe('API + Vision Combined Concepts', () => {
  it('vision tools can analyze design issues from slide content', async () => {
    // Test that the design rules engine works on slide-like data
    const { evaluateAllRules, calculateDesignScore } = await import('../../vision/design-rules.js');

    const slideContent = {
      slideId: 'test',
      slideIndex: 0,
      elements: [
        {
          id: 'title',
          type: 'text' as const,
          position: { x: 50, y: 50, width: 620, height: 50 },
          text: 'My Title',
          styles: { fontSize: 36 },
        },
        {
          id: 'body',
          type: 'text' as const,
          position: { x: 50, y: 120, width: 620, height: 200 },
          text: 'Body content here with some bullet points and descriptions.',
          styles: { fontSize: 18 },
        },
      ],
    };

    const issues = evaluateAllRules(slideContent);
    const score = calculateDesignScore(issues);

    // Should have a reasonable score for a well-structured slide
    expect(score).toBeGreaterThanOrEqual(0);
    expect(score).toBeLessThanOrEqual(100);
    expect(typeof score).toBe('number');
  });

  it('theme engine generates valid batch update requests', async () => {
    const { getTheme, applyTheme } = await import('../../vision/theme-engine.js');
    const theme = getTheme('corporate-blue');
    expect(theme).toBeDefined();

    const requests = applyTheme('pres-id', theme!, ['slide1', 'slide2']);
    expect(requests.length).toBeGreaterThan(0);

    for (const req of requests) {
      expect(req).toHaveProperty('updatePageProperties');
    }
  });
});
