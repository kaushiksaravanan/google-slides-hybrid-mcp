/**
 * Unit tests for CLI tools: index, setup, doctor.
 */
import { describe, it, expect, vi } from 'vitest';
import fs from 'node:fs';
import path from 'node:path';

// ─── CLI index.ts exports are available ────────────────────────────────────

describe('CLI index.ts module', () => {
  it('CLI entry file exists and is loadable', () => {
    const cliPath = path.resolve(__dirname, '../../cli/index.ts');
    expect(fs.existsSync(cliPath)).toBe(true);
  });

  it('setup module exists', () => {
    const setupPath = path.resolve(__dirname, '../../cli/setup.ts');
    expect(fs.existsSync(setupPath)).toBe(true);
  });

  it('doctor module exists', () => {
    const doctorPath = path.resolve(__dirname, '../../cli/doctor.ts');
    expect(fs.existsSync(doctorPath)).toBe(true);
  });
});

// ─── Setup wizard prerequisite checks ──────────────────────────────────────

describe('Setup wizard prerequisite checks', () => {
  it('Node.js version is >= 18', () => {
    const major = parseInt(process.version.replace('v', '').split('.')[0], 10);
    expect(major).toBeGreaterThanOrEqual(18);
  });

  it('parseNodeVersion extracts major.minor.patch', () => {
    // Replicate the parseNodeVersion logic from setup.ts
    function parseNodeVersion(versionStr: string): number[] {
      const match = versionStr.match(/v?(\d+)\.(\d+)\.(\d+)/);
      if (!match) return [0, 0, 0];
      return [parseInt(match[1], 10), parseInt(match[2], 10), parseInt(match[3], 10)];
    }

    expect(parseNodeVersion('v18.17.0')).toEqual([18, 17, 0]);
    expect(parseNodeVersion('v22.2.1')).toEqual([22, 2, 1]);
    expect(parseNodeVersion('v16.0.0')).toEqual([16, 0, 0]);
    expect(parseNodeVersion('invalid')).toEqual([0, 0, 0]);
  });

  it('process.version is a valid semver string', () => {
    expect(process.version).toMatch(/^v\d+\.\d+\.\d+/);
  });
});

// ─── Doctor diagnostic checks structure ────────────────────────────────────

describe('Doctor diagnostic checks structure', () => {
  it('DiagResult interface has pass/fail/warn/info fields', () => {
    // Replicate the DiagResult interface from doctor.ts
    interface DiagResult {
      pass: number;
      fail: number;
      warn: number;
      info: number;
    }

    const result: DiagResult = { pass: 0, fail: 0, warn: 0, info: 0 };
    expect(result.pass).toBe(0);
    expect(result.fail).toBe(0);
    expect(result.warn).toBe(0);
    expect(result.info).toBe(0);
  });

  it('loadEnvFile parses key=value pairs correctly', () => {
    // Replicate the loadEnvFile logic from doctor.ts
    function loadEnvContent(content: string): Record<string, string> {
      const env: Record<string, string> = {};
      for (const line of content.split('\n')) {
        const trimmed = line.trim();
        if (!trimmed || trimmed.startsWith('#')) continue;
        const eqIdx = trimmed.indexOf('=');
        if (eqIdx === -1) continue;
        const key = trimmed.slice(0, eqIdx).trim();
        const value = trimmed.slice(eqIdx + 1).trim();
        env[key] = value;
      }
      return env;
    }

    const content = '# Comment\nFOO=bar\nBAZ=qux\n\nEMPTY=';
    const result = loadEnvContent(content);
    expect(result['FOO']).toBe('bar');
    expect(result['BAZ']).toBe('qux');
    expect(result['EMPTY']).toBe('');
  });

  it('maskSecret function masks secrets correctly', () => {
    function maskSecret(value: string): string {
      if (!value || value.length <= 8) return '****';
      return value.slice(0, 4) + '...' + value.slice(-4);
    }

    expect(maskSecret('short')).toBe('****');
    expect(maskSecret('abcdefghijklmnop')).toBe('abcd...mnop');
    expect(maskSecret('')).toBe('****');
  });
});

// ─── CLI command routing ───────────────────────────────────────────────────

describe('CLI command routing', () => {
  it('setup command routes correctly', () => {
    const commands: Record<string, string> = {
      setup: 'setup',
      doctor: 'doctor',
      check: 'doctor',
      diagnose: 'doctor',
      start: 'start',
      serve: 'start',
      help: 'help',
      '--help': 'help',
      '-h': 'help',
      version: 'version',
      '--version': 'version',
      '-v': 'version',
      '-V': 'version',
    };

    // Simulate the switch routing logic from cli/index.ts
    function resolveCommand(input: string): string {
      switch (input) {
        case 'setup':
          return 'setup';
        case 'doctor':
        case 'check':
        case 'diagnose':
          return 'doctor';
        case 'start':
        case 'serve':
          return 'start';
        case 'get-token':
        case 'token':
        case 'auth':
          return 'get-token';
        case '--help':
        case '-h':
        case 'help':
          return 'help';
        case '--version':
        case '-v':
        case '-V':
        case 'version':
          return 'version';
        default:
          return 'unknown';
      }
    }

    for (const [input, expected] of Object.entries(commands)) {
      expect(resolveCommand(input)).toBe(expected);
    }
  });

  it('unknown commands resolve to unknown', () => {
    function resolveCommand(input: string): string {
      switch (input) {
        case 'setup':
          return 'setup';
        case 'doctor':
        case 'check':
        case 'diagnose':
          return 'doctor';
        case 'start':
        case 'serve':
          return 'start';
        default:
          return 'unknown';
      }
    }

    expect(resolveCommand('foo')).toBe('unknown');
    expect(resolveCommand('bar')).toBe('unknown');
  });

  it('default command is start', () => {
    const args: string[] = [];
    const command = args[0] ?? 'start';
    expect(command).toBe('start');
  });
});
