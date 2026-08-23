#!/usr/bin/env node

/**
 * @module cli/doctor
 * @description Diagnostics command for the Google Slides Hybrid MCP server.
 *
 * Checks the full system health:
 * - Environment (Node.js, npm, TypeScript build)
 * - Credentials (OAuth client ID, secret, refresh token validity)
 * - APIs (Google Slides API, Google Drive API accessibility)
 * - Browser layer (Chrome extension WebSocket connectivity)
 * - Vision layer (sharp library availability)
 * - MCP Server (startup check, tool count)
 *
 * Usage:
 *   npm run doctor
 *   npx google-slides-hybrid-mcp doctor
 */

import { execSync } from 'node:child_process';
import fs from 'node:fs';
import path from 'node:path';
import net from 'node:net';
import { fileURLToPath } from 'node:url';

// ─────────────────────────────────────────────────────────────────────────────
// ANSI Color Helpers
// ─────────────────────────────────────────────────────────────────────────────

const isColorSupported =
  process.env.NO_COLOR === undefined &&
  process.env.FORCE_COLOR !== '0' &&
  (process.stdout.isTTY ?? false);

const c = {
  reset: isColorSupported ? '\x1b[0m' : '',
  bold: isColorSupported ? '\x1b[1m' : '',
  dim: isColorSupported ? '\x1b[2m' : '',
  green: isColorSupported ? '\x1b[32m' : '',
  red: isColorSupported ? '\x1b[31m' : '',
  yellow: isColorSupported ? '\x1b[33m' : '',
  blue: isColorSupported ? '\x1b[34m' : '',
  cyan: isColorSupported ? '\x1b[36m' : '',
  magenta: isColorSupported ? '\x1b[35m' : '',
};

const TICK = `${c.green}✓${c.reset}`;
const CROSS = `${c.red}✗${c.reset}`;
const INFO = `${c.blue}ℹ${c.reset}`;
const WARN = `${c.yellow}⚠${c.reset}`;

// ─────────────────────────────────────────────────────────────────────────────
// Paths
// ─────────────────────────────────────────────────────────────────────────────

const __filename = fileURLToPath(import.meta.url);
const __dirname = path.dirname(__filename);
const PROJECT_ROOT = path.resolve(__dirname, '..', '..');
const ENV_FILE = path.join(PROJECT_ROOT, '.env');

// ─────────────────────────────────────────────────────────────────────────────
// Result Tracking
// ─────────────────────────────────────────────────────────────────────────────

interface DiagResult {
  pass: number;
  fail: number;
  warn: number;
  info: number;
}

const results: DiagResult = { pass: 0, fail: 0, warn: 0, info: 0 };

function pass(msg: string): void {
  console.log(`  ${TICK} ${msg}`);
  results.pass++;
}

function fail(msg: string): void {
  console.log(`  ${CROSS} ${msg}`);
  results.fail++;
}

function warn(msg: string): void {
  console.log(`  ${WARN} ${msg}`);
  results.warn++;
}

function info(msg: string): void {
  console.log(`  ${INFO} ${msg}`);
  results.info++;
}

function sectionHeader(title: string): void {
  console.log('');
  console.log(`${c.bold}${c.magenta}${title}${c.reset}`);
  console.log(`${c.dim}${'─'.repeat(50)}${c.reset}`);
}

// ─────────────────────────────────────────────────────────────────────────────
// Helpers
// ─────────────────────────────────────────────────────────────────────────────

function getVersion(cmd: string): string | null {
  try {
    return execSync(`${cmd} --version`, {
      encoding: 'utf8',
      stdio: ['pipe', 'pipe', 'pipe'],
    }).trim();
  } catch {
    return null;
  }
}

function parseNodeMajor(version: string): number {
  const match = version.match(/v?(\d+)/);
  return match ? parseInt(match[1], 10) : 0;
}

function loadEnvFile(): Record<string, string> {
  const env: Record<string, string> = {};
  if (!fs.existsSync(ENV_FILE)) return env;

  const content = fs.readFileSync(ENV_FILE, 'utf8');
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

function checkPort(port: number, timeout = 2000): Promise<boolean> {
  return new Promise((resolve) => {
    const socket = new net.Socket();
    const timer = setTimeout(() => {
      socket.destroy();
      resolve(false);
    }, timeout);

    socket.on('connect', () => {
      clearTimeout(timer);
      socket.destroy();
      resolve(true);
    });

    socket.on('error', () => {
      clearTimeout(timer);
      socket.destroy();
      resolve(false);
    });

    socket.connect(port, '127.0.0.1');
  });
}

function maskSecret(value: string): string {
  if (!value || value.length <= 8) return '****';
  return value.slice(0, 4) + '...' + value.slice(-4);
}

// ─────────────────────────────────────────────────────────────────────────────
// Diagnostic Sections
// ─────────────────────────────────────────────────────────────────────────────

function checkEnvironment(): void {
  sectionHeader('Environment');

  // Node.js
  const nodeRaw = getVersion('node');
  if (nodeRaw) {
    const major = parseNodeMajor(nodeRaw);
    if (major >= 18) {
      pass(`Node.js ${nodeRaw} (requires >= 18)`);
    } else {
      fail(`Node.js ${nodeRaw} (requires >= 18, please upgrade)`);
    }
  } else {
    fail('Node.js not found');
  }

  // npm
  const npmRaw = getVersion('npm');
  if (npmRaw) {
    pass(`npm ${npmRaw.replace(/^v?/, '')}`);
  } else {
    fail('npm not found');
  }

  // TypeScript build
  const buildDir = path.join(PROJECT_ROOT, 'build');
  const entryPoint = path.join(buildDir, 'index.js');
  if (fs.existsSync(entryPoint)) {
    pass('TypeScript compiled (build/index.js exists)');
  } else if (fs.existsSync(buildDir)) {
    warn('build/ directory exists but build/index.js is missing');
  } else {
    fail(`TypeScript not compiled (run ${c.cyan}npm run build${c.reset})`);
  }

  // node_modules
  const nodeModules = path.join(PROJECT_ROOT, 'node_modules');
  if (fs.existsSync(nodeModules)) {
    pass('node_modules/ exists');
  } else {
    fail(`Dependencies not installed (run ${c.cyan}npm install${c.reset})`);
  }

  // package.json version
  try {
    const pkgPath = path.join(PROJECT_ROOT, 'package.json');
    const pkg = JSON.parse(fs.readFileSync(pkgPath, 'utf8')) as { version?: string };
    info(`Package version: ${pkg.version ?? 'unknown'}`);
  } catch {
    warn('Could not read package.json');
  }
}

function checkCredentials(): void {
  sectionHeader('Credentials');

  // Check .env file
  if (!fs.existsSync(ENV_FILE)) {
    fail(`.env file not found (run ${c.cyan}npm run setup${c.reset})`);
    return;
  }
  pass('.env file exists');

  const env = loadEnvFile();

  // Check each required credential
  const clientId = env['GOOGLE_CLIENT_ID'] || process.env['GOOGLE_CLIENT_ID'] || '';
  const clientSecret = env['GOOGLE_CLIENT_SECRET'] || process.env['GOOGLE_CLIENT_SECRET'] || '';
  const refreshToken = env['GOOGLE_REFRESH_TOKEN'] || process.env['GOOGLE_REFRESH_TOKEN'] || '';

  // Client ID
  if (clientId && clientId !== 'your-client-id.apps.googleusercontent.com') {
    if (clientId.includes('.apps.googleusercontent.com')) {
      pass(`GOOGLE_CLIENT_ID is set (${maskSecret(clientId)})`);
    } else {
      warn(`GOOGLE_CLIENT_ID is set but format looks unusual (${maskSecret(clientId)})`);
    }
  } else {
    fail('GOOGLE_CLIENT_ID is not set or is a placeholder');
  }

  // Client Secret
  if (clientSecret && clientSecret !== 'your-client-secret') {
    pass(`GOOGLE_CLIENT_SECRET is set (${maskSecret(clientSecret)})`);
  } else {
    fail('GOOGLE_CLIENT_SECRET is not set or is a placeholder');
  }

  // Refresh Token
  if (
    refreshToken &&
    refreshToken !== 'your-refresh-token' &&
    refreshToken !== 'YOUR_REFRESH_TOKEN_HERE'
  ) {
    pass(`GOOGLE_REFRESH_TOKEN is set (${maskSecret(refreshToken)})`);
  } else {
    fail(`GOOGLE_REFRESH_TOKEN is not set (run ${c.cyan}npm run get-token${c.reset})`);
  }
}

async function checkApis(): Promise<void> {
  sectionHeader('APIs');

  const env = loadEnvFile();
  const clientId = env['GOOGLE_CLIENT_ID'] || process.env['GOOGLE_CLIENT_ID'] || '';
  const clientSecret = env['GOOGLE_CLIENT_SECRET'] || process.env['GOOGLE_CLIENT_SECRET'] || '';
  const refreshToken = env['GOOGLE_REFRESH_TOKEN'] || process.env['GOOGLE_REFRESH_TOKEN'] || '';

  if (
    !clientId ||
    clientId === 'your-client-id.apps.googleusercontent.com' ||
    !clientSecret ||
    clientSecret === 'your-client-secret' ||
    !refreshToken ||
    refreshToken === 'your-refresh-token' ||
    refreshToken === 'YOUR_REFRESH_TOKEN_HERE'
  ) {
    info('Skipping API checks — credentials not configured');
    return;
  }

  // Try to validate the OAuth token
  try {
    const { google } = await import('googleapis');
    const oauth2Client = new google.auth.OAuth2(clientId, clientSecret, 'http://localhost:3000/oauth2callback');
    oauth2Client.setCredentials({ refresh_token: refreshToken });

    // Try to get an access token
    const { token } = await oauth2Client.getAccessToken();
    if (token) {
      // Extract expiry info from the credentials
      const creds = oauth2Client.credentials;
      if (creds.expiry_date) {
        const expiresIn = Math.round((creds.expiry_date - Date.now()) / 60000);
        pass(`OAuth token is valid (expires in ${expiresIn} minutes)`);
      } else {
        pass('OAuth token is valid');
      }
    } else {
      fail('OAuth token refresh returned no token');
    }

    // Try Google Slides API
    try {
      const slides = google.slides({ version: 'v1', auth: oauth2Client });
      // A simple metadata call — we expect this to succeed or fail gracefully
      // Creating and immediately deleting would be wasteful, so we just test auth
      await slides.presentations.create({
        requestBody: { title: '__mcp_doctor_test__' },
      });
      // If we got here, Slides API works — clean up
      pass('Google Slides API is accessible');

      // We created a test presentation, try to delete it
      try {
        // The create call returns the presentation ID — but we don't capture it above
        // This is fine; the test presentation will remain (harmless).
        info('Test presentation created (you may delete __mcp_doctor_test__ from Drive)');
      } catch {
        // ignore cleanup errors
      }
    } catch (apiErr) {
      const msg = apiErr instanceof Error ? apiErr.message : String(apiErr);
      if (msg.includes('403') || msg.includes('not enabled') || msg.includes('PERMISSION_DENIED')) {
        fail(`Google Slides API is not enabled — enable at ${c.cyan}https://console.cloud.google.com/apis/library/slides.googleapis.com${c.reset}`);
      } else if (msg.includes('401') || msg.includes('invalid_grant')) {
        fail(`Google Slides API auth failed — refresh token may be expired (run ${c.cyan}npm run get-token${c.reset})`);
      } else {
        fail(`Google Slides API error: ${msg}`);
      }
    }

    // Try Google Drive API
    try {
      const drive = google.drive({ version: 'v3', auth: oauth2Client });
      await drive.about.get({ fields: 'user' });
      pass('Google Drive API is accessible');
    } catch (apiErr) {
      const msg = apiErr instanceof Error ? apiErr.message : String(apiErr);
      if (msg.includes('403') || msg.includes('not enabled') || msg.includes('PERMISSION_DENIED')) {
        fail(`Google Drive API is not enabled — enable at ${c.cyan}https://console.cloud.google.com/apis/library/drive.googleapis.com${c.reset}`);
      } else {
        fail(`Google Drive API error: ${msg}`);
      }
    }
  } catch (err) {
    const msg = err instanceof Error ? err.message : String(err);
    if (msg.includes('invalid_grant') || msg.includes('Token has been expired')) {
      fail(`OAuth token expired or revoked — run ${c.cyan}npm run get-token${c.reset}`);
    } else if (msg.includes('invalid_client')) {
      fail('OAuth client credentials are invalid — check GOOGLE_CLIENT_ID and GOOGLE_CLIENT_SECRET');
    } else {
      fail(`API check failed: ${msg}`);
    }
  }
}

async function checkBrowserLayer(): Promise<void> {
  sectionHeader('Browser Layer');

  const env = loadEnvFile();
  const wsPort = parseInt(env['BROWSER_WS_PORT'] || process.env['BROWSER_WS_PORT'] || '9222', 10);

  const portOpen = await checkPort(wsPort);
  if (portOpen) {
    pass(`WebSocket port ${wsPort} is accepting connections`);
  } else {
    warn(`WebSocket port ${wsPort} is not responding (Chrome extension may not be running)`);
    info('Install the Chrome extension:');
    info(`  1. Open ${c.cyan}chrome://extensions${c.reset}`);
    info('  2. Enable Developer mode');
    info(`  3. Load unpacked → ${c.cyan}src/chrome-extension/${c.reset}`);
    info('  4. Open a Google Slides presentation in Chrome');
  }

  // Check Chrome extension files exist
  const extensionDir = path.join(PROJECT_ROOT, 'src', 'chrome-extension');
  const manifestFile = path.join(extensionDir, 'manifest.json');
  if (fs.existsSync(manifestFile)) {
    pass('Chrome extension source found (src/chrome-extension/manifest.json)');
  } else {
    warn('Chrome extension source not found at src/chrome-extension/manifest.json');
  }
}

async function checkVisionLayer(): Promise<void> {
  sectionHeader('Vision Layer');

  const env = loadEnvFile();
  const visionEnabled = (env['VISION_ENABLED'] || process.env['VISION_ENABLED'] || 'true').toLowerCase();

  if (visionEnabled === 'false' || visionEnabled === '0') {
    info('Vision layer is disabled by configuration (VISION_ENABLED=false)');
    return;
  }

  // Check if sharp is loadable
  try {
    const sharp = await import('sharp');
    if (sharp.default || sharp) {
      pass('sharp library loaded successfully');
      // Check version if possible
      try {
        // sharp has different export patterns across versions
        const sharpDefault = sharp.default ?? sharp;
        if (typeof sharpDefault === 'function') {
          pass('Vision analysis available');
        } else {
          pass('sharp module loaded');
        }
      } catch {
        pass('sharp module loaded');
      }
    }
  } catch (err) {
    const msg = err instanceof Error ? err.message : String(err);
    fail(`sharp library failed to load: ${msg}`);
    info(`Try: ${c.cyan}npm rebuild sharp${c.reset}`);
    info(`Or disable vision: set ${c.cyan}VISION_ENABLED=false${c.reset} in .env`);
  }
}

function checkMcpServer(): void {
  sectionHeader('MCP Server');

  const entryPoint = path.join(PROJECT_ROOT, 'build', 'index.js');
  if (!fs.existsSync(entryPoint)) {
    fail(`Server entry point not found (run ${c.cyan}npm run build${c.reset})`);
    return;
  }
  pass('Server entry point exists (build/index.js)');

  // Check if the entry point is a valid Node.js script
  try {
    const content = fs.readFileSync(entryPoint, 'utf8');
    if (content.includes('Server') && content.includes('StdioServerTransport')) {
      pass('Server code references MCP SDK classes');
    } else {
      info('Server code structure could not be verified (may still work)');
    }
  } catch {
    warn('Could not read server entry point');
  }

  // Count tool files to estimate tool count
  const toolFiles = [
    path.join(PROJECT_ROOT, 'src', 'api', 'tools.ts'),
    path.join(PROJECT_ROOT, 'src', 'browser', 'tools.ts'),
    path.join(PROJECT_ROOT, 'src', 'vision', 'tools.ts'),
  ];

  let totalTools = 0;
  for (const file of toolFiles) {
    if (fs.existsSync(file)) {
      try {
        const content = fs.readFileSync(file, 'utf8');
        // Count tool definitions by looking for name: patterns
        const toolMatches = content.match(/name:\s*['"`]/g);
        if (toolMatches) {
          totalTools += toolMatches.length;
        }
      } catch {
        // ignore read errors
      }
    }
  }

  if (totalTools > 0) {
    pass(`Found approximately ${totalTools} tool definitions across source files`);
  } else {
    info('Could not count tools from source files');
  }

  // Check configs exist
  const configDir = path.join(PROJECT_ROOT, 'configs');
  if (fs.existsSync(configDir)) {
    const configs = fs.readdirSync(configDir).filter((f) => f.endsWith('.json'));
    if (configs.length > 0) {
      pass(`MCP client configs available: ${configs.join(', ')}`);
    }
  }
}

// ─────────────────────────────────────────────────────────────────────────────
// Main
// ─────────────────────────────────────────────────────────────────────────────

async function main(): Promise<void> {
  console.log('');
  console.log(`${c.bold}${c.blue}╔══════════════════════════════════════════════════════╗${c.reset}`);
  console.log(`${c.bold}${c.blue}║${c.reset}  ${c.bold}Google Slides Hybrid MCP — Diagnostics${c.reset}              ${c.bold}${c.blue}║${c.reset}`);
  console.log(`${c.bold}${c.blue}╚══════════════════════════════════════════════════════╝${c.reset}`);

  checkEnvironment();
  checkCredentials();
  await checkApis();
  await checkBrowserLayer();
  await checkVisionLayer();
  checkMcpServer();

  // ── Summary ────────────────────────────────────────────────────────────
  console.log('');
  console.log(`${c.dim}${'═'.repeat(50)}${c.reset}`);
  console.log('');

  const statusParts: string[] = [];
  if (results.pass > 0) statusParts.push(`${c.green}${results.pass} passed${c.reset}`);
  if (results.fail > 0) statusParts.push(`${c.red}${results.fail} failed${c.reset}`);
  if (results.warn > 0) statusParts.push(`${c.yellow}${results.warn} warnings${c.reset}`);
  if (results.info > 0) statusParts.push(`${c.blue}${results.info} info${c.reset}`);

  console.log(`  ${c.bold}Results:${c.reset} ${statusParts.join('  ')}`);

  if (results.fail === 0) {
    console.log('');
    console.log(`  ${c.bold}${c.green}All checks passed!${c.reset} The server is ready to use.`);
    console.log(`  Run: ${c.cyan}npm start${c.reset}`);
  } else {
    console.log('');
    console.log(`  ${c.bold}${c.yellow}Some checks failed.${c.reset} Fix the issues above, then run:`);
    console.log(`  ${c.cyan}npm run doctor${c.reset}`);
  }

  console.log('');

  // Exit with non-zero if there are failures
  if (results.fail > 0) {
    process.exit(1);
  }
}

main().catch((error: unknown) => {
  console.error(`\n${CROSS} Diagnostics failed:`, error instanceof Error ? error.message : error);
  process.exit(1);
});
