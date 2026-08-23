/**
 * Unit tests for the orchestrator: HybridOrchestrator + WorkflowEngine.
 */
import { describe, it, expect, vi, beforeEach } from 'vitest';

// Mock googleapis for auth module
vi.mock('googleapis', () => {
  const mockOAuth2 = vi.fn().mockImplementation(() => ({
    setCredentials: vi.fn(),
    on: vi.fn(),
    getAccessToken: vi.fn().mockResolvedValue({ token: 'mock-token' }),
  }));
  return {
    google: {
      auth: { OAuth2: mockOAuth2 },
      slides: vi.fn().mockReturnValue({ presentations: {} }),
      drive: vi.fn().mockReturnValue({ files: {}, permissions: {} }),
    },
  };
});

// Mock ws module to prevent actual WebSocket server creation
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

// Mock child_process to prevent port cleanup
vi.mock('node:child_process', () => ({
  execSync: vi.fn().mockReturnValue(''),
}));

import { HybridOrchestrator } from '../../orchestrator/orchestrator.js';
import type { HybridConfig } from '../../shared/types.js';
import { apiTools, isApiTool } from '../../api/tools.js';
import { browserTools, isBrowserTool } from '../../browser/tools.js';
import { visionTools, isVisionTool } from '../../vision/tools.js';

function makeConfig(overrides?: Partial<HybridConfig>): HybridConfig {
  return {
    api: {
      clientId: 'test-id',
      clientSecret: 'test-secret',
      refreshToken: 'test-token',
    },
    browser: {
      wsPort: 0, // port 0 to avoid binding
      screenshotFormat: 'png',
      timeout: 5000,
    },
    vision: {
      enabled: true,
      analysisModel: 'built-in',
      autoFix: false,
    },
    ...overrides,
  };
}

describe('HybridOrchestrator', () => {
  describe('tool auto-routing', () => {
    it('routes slides_ tools to API layer', () => {
      for (const tool of apiTools) {
        expect(isApiTool(tool.name)).toBe(true);
        expect(tool.name.startsWith('slides_')).toBe(true);
      }
    });

    it('routes live_ tools to browser layer', () => {
      for (const tool of browserTools) {
        expect(isBrowserTool(tool.name)).toBe(true);
        expect(tool.name.startsWith('live_')).toBe(true);
      }
    });

    it('routes vision_ tools to vision layer', () => {
      for (const tool of visionTools) {
        expect(isVisionTool(tool.name)).toBe(true);
        expect(tool.name.startsWith('vision_')).toBe(true);
      }
    });
  });

  describe('getLayerStatus', () => {
    it('returns status for all three layers', async () => {
      const orch = new HybridOrchestrator(makeConfig());
      const status = await orch.getLayerStatus();
      expect(status.api).toBeDefined();
      expect(status.browser).toBeDefined();
      expect(status.vision).toBeDefined();
      expect(typeof status.api.available).toBe('boolean');
      expect(typeof status.browser.available).toBe('boolean');
      expect(typeof status.vision.available).toBe('boolean');
    });

    it('reports false for all layers before initialization', async () => {
      const orch = new HybridOrchestrator(makeConfig());
      const status = await orch.getLayerStatus();
      expect(status.api.available).toBe(false);
      expect(status.browser.available).toBe(false);
      expect(status.vision.available).toBe(false);
    });
  });

  describe('getAvailableTools', () => {
    it('returns only event tools before initialization (no API/browser/vision tools)', () => {
      const orch = new HybridOrchestrator(makeConfig());
      const tools = orch.getAvailableTools();
      // Before initialization, only event/webhook tools are available (stateless)
      // No API, browser, or vision tools should be present
      const apiTools = tools.filter((t: { name: string }) => t.name.startsWith('slides_'));
      const browserTools = tools.filter((t: { name: string }) => t.name.startsWith('live_'));
      const visionTools = tools.filter((t: { name: string }) => t.name.startsWith('vision_'));
      expect(apiTools.length).toBe(0);
      expect(browserTools.length).toBe(0);
      expect(visionTools.length).toBe(0);
    });
  });

  describe('executeToolAuto', () => {
    it('returns error for API tool when API not initialized', async () => {
      const orch = new HybridOrchestrator(makeConfig());
      const result = await orch.executeToolAuto('slides_create_presentation', { title: 'Test' });
      expect(result.isError).toBe(true);
      expect(result.content[0]!.text).toContain('API layer is not available');
    });

    it('returns error for browser tool when browser not initialized', async () => {
      const orch = new HybridOrchestrator(makeConfig());
      const result = await orch.executeToolAuto('live_screenshot', {});
      expect(result.isError).toBe(true);
      expect(result.content[0]!.text).toContain('Browser layer is not available');
    });

    it('returns error for vision tool when vision not available', async () => {
      const orch = new HybridOrchestrator(makeConfig());
      const result = await orch.executeToolAuto('vision_analyze_slide', { presentationId: 'x' });
      expect(result.isError).toBe(true);
      expect(result.content[0]!.text).toContain('Vision layer is not available');
    });

    it('throws ToolExecutionError for unknown tool', async () => {
      const orch = new HybridOrchestrator(makeConfig());
      await expect(
        orch.executeToolAuto('unknown_tool', {}),
      ).rejects.toThrow('Unknown tool');
    });
  });

  describe('shutdown', () => {
    it('does not throw when called without initialization', async () => {
      const orch = new HybridOrchestrator(makeConfig());
      await expect(orch.shutdown()).resolves.toBeUndefined();
    });

    it('is idempotent (double shutdown is safe)', async () => {
      const orch = new HybridOrchestrator(makeConfig());
      await orch.shutdown();
      await expect(orch.shutdown()).resolves.toBeUndefined();
    });
  });
});

// ─── WorkflowEngine ────────────────────────────────────────────────────────────

import { WorkflowEngine } from '../../orchestrator/workflow.js';

describe('WorkflowEngine', () => {
  describe('briefToDeck', () => {
    it('calls progress callback during workflow', async () => {
      const orch = new HybridOrchestrator(makeConfig());
      const engine = new WorkflowEngine(orch);
      const progressCalls: Array<{ step: string; progress: number }> = [];

      // This will fail because API isn't initialized, but progress should still be called
      const result = await engine.briefToDeck(
        'Test brief about quarterly results',
        5,
        (progress) => {
          progressCalls.push({ step: progress.step, progress: progress.progress });
        },
      );

      // Should fail since API not initialized
      expect(result.success).toBe(false);
      // But progress callback should have been invoked for initial steps
      expect(progressCalls.length).toBeGreaterThan(0);
      expect(result.workflowId).toMatch(/^brief-to-deck/);
      expect(result.durationMs).toBeGreaterThanOrEqual(0);
    });

    it('returns a structured WorkflowResult on failure', async () => {
      const orch = new HybridOrchestrator(makeConfig());
      const engine = new WorkflowEngine(orch);

      const result = await engine.briefToDeck('Test brief');
      expect(result.success).toBe(false);
      expect(result.error).toBeDefined();
      expect(result.workflowId).toBeTruthy();
      expect(result.durationMs).toBeGreaterThanOrEqual(0);
    });
  });

  describe('workflow status tracking', () => {
    it('tracks workflow status', async () => {
      const orch = new HybridOrchestrator(makeConfig());
      const engine = new WorkflowEngine(orch);

      await engine.briefToDeck('Test');

      const statuses = engine.getAllWorkflowStatuses();
      expect(statuses.size).toBeGreaterThan(0);
      // Should have failed status since API not initialized
      const values = [...statuses.values()];
      expect(values).toContain('failed');
    });
  });
});
