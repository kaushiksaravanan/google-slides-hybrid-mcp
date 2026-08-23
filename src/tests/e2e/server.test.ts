/**
 * End-to-end tests for the MCP server.
 * Tests server lifecycle, tool listing, and routing with mocked dependencies.
 */
import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest';

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
      slides: vi.fn().mockReturnValue({ presentations: {} }),
      drive: vi.fn().mockReturnValue({ files: {}, permissions: {} }),
    },
  };
});

// Mock ws
vi.mock('ws', () => {
  const EventEmitter = require('eventemitter3');
  class MockWebSocketServer extends EventEmitter {
    constructor() {
      super();
      // Simulate async listening
      setTimeout(() => this.emit('listening'), 10);
    }
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

import { HybridOrchestrator } from '../../orchestrator/orchestrator.js';
import type { HybridConfig } from '../../shared/types.js';
import { MCP_SERVER_NAME, MCP_SERVER_VERSION } from '../../shared/constants.js';

function makeConfig(overrides?: Partial<HybridConfig>): HybridConfig {
  return {
    api: {
      clientId: 'test-id',
      clientSecret: 'test-secret',
      refreshToken: 'test-token',
    },
    browser: {
      wsPort: 0,
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

describe('MCP Server Lifecycle', () => {
  it('orchestrator initializes and returns layer status', async () => {
    const orch = new HybridOrchestrator(makeConfig());

    const status = await orch.initialize();

    expect(status).toBeDefined();
    expect(status.api).toBeDefined();
    expect(status.browser).toBeDefined();
    expect(status.vision).toBeDefined();

    // API should be available (we mocked googleapis)
    expect(status.api.available).toBe(true);
    expect(status.api.authenticated).toBe(true);

    // Vision depends on sharp being installed
    expect(typeof status.vision.available).toBe('boolean');

    await orch.shutdown();
  });

  it('orchestrator shuts down cleanly', async () => {
    const orch = new HybridOrchestrator(makeConfig());
    await orch.initialize();
    await expect(orch.shutdown()).resolves.toBeUndefined();
  });

  it('orchestrator lists tools from initialized layers', async () => {
    const orch = new HybridOrchestrator(makeConfig());
    await orch.initialize();

    const tools = orch.getAvailableTools();
    expect(tools.length).toBeGreaterThan(0);

    // Should include API tools since we mocked auth
    const apiToolNames = tools.filter((t) => t.name.startsWith('slides_'));
    expect(apiToolNames.length).toBe(19);

    await orch.shutdown();
  });

  it('CallTool routes correctly to API layer', async () => {
    const orch = new HybridOrchestrator(makeConfig());
    await orch.initialize();

    // Call a tool that will fail validation but verify routing works
    const result = await orch.executeToolAuto('slides_get_presentation', {
      presentationId: 'abc123',
    });

    // It should route to API and either succeed or fail with API error, not routing error
    expect(result).toBeDefined();
    expect(result.content).toBeDefined();
    expect(result.content.length).toBeGreaterThan(0);

    await orch.shutdown();
  });

  it('CallTool returns error for unknown tools', async () => {
    const orch = new HybridOrchestrator(makeConfig());
    await orch.initialize();

    await expect(
      orch.executeToolAuto('totally_unknown_tool', {}),
    ).rejects.toThrow('Unknown tool');

    await orch.shutdown();
  });
});

describe('Environment Variable Validation', () => {
  it('API layer fails gracefully with empty credentials', async () => {
    const orch = new HybridOrchestrator(makeConfig({
      api: { clientId: '', clientSecret: '', refreshToken: '' },
    }));

    const status = await orch.initialize();
    expect(status.api.available).toBe(false);
    expect(status.api.error).toContain('Missing OAuth credentials');

    await orch.shutdown();
  });
});

describe('Server With Partial Config', () => {
  it('works with only API layer (no browser, no vision)', async () => {
    const orch = new HybridOrchestrator(makeConfig({
      vision: { enabled: false, analysisModel: 'built-in', autoFix: false },
    }));

    const status = await orch.initialize();
    expect(status.api.available).toBe(true);
    expect(status.vision.enabled).toBe(false);
    expect(status.vision.available).toBe(false);

    const tools = orch.getAvailableTools();
    // Should have API tools, possibly browser tools, no vision tools
    const visionTools = tools.filter((t) => t.name.startsWith('vision_'));
    expect(visionTools.length).toBe(0);

    await orch.shutdown();
  });

  it('gracefully degrades when browser connection fails', async () => {
    const orch = new HybridOrchestrator(makeConfig());
    await orch.initialize();

    // Browser layer should be "available" (server started) but not "connected"
    const status = await orch.getLayerStatus();
    expect(status.browser.connected).toBe(false);

    // Trying to use a browser tool should return a soft error
    const result = await orch.executeToolAuto('live_screenshot', {});
    // It could succeed if browserInitialized is true, but connection will fail
    expect(result.content.length).toBeGreaterThan(0);

    await orch.shutdown();
  });
});

describe('Server Constants', () => {
  it('MCP_SERVER_NAME matches package name', () => {
    expect(MCP_SERVER_NAME).toBe('google-slides-hybrid-mcp');
  });

  it('MCP_SERVER_VERSION is valid semver', () => {
    expect(MCP_SERVER_VERSION).toMatch(/^\d+\.\d+\.\d+$/);
  });
});
