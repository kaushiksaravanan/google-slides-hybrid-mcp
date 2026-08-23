#!/usr/bin/env node

/**
 * @module cli/setup
 * @description Interactive setup wizard for the Google Slides Hybrid MCP server.
 *
 * Guides the user through:
 * 1. Checking prerequisites (Node.js, npm)
 * 2. Configuring Google Cloud OAuth credentials
 * 3. Obtaining a refresh token via the OAuth consent flow
 * 4. Setting optional feature flags (browser layer, vision layer)
 * 5. Writing the .env file and building the project
 *
 * Usage:
 *   npm run setup
 *   npx google-slides-hybrid-mcp setup
 *
 * Uses only Node.js built-in modules (readline, child_process, fs, path) so
 * that it can run before any npm install is complete.
 */

import readline from 'node:readline';
import { execSync, spawn } from 'node:child_process';
import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

// ─────────────────────────────────────────────────────────────────────────────
// ANSI Color Helpers (zero external dependencies)
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
  white: isColorSupported ? '\x1b[37m' : '',
  bgGreen: isColorSupported ? '\x1b[42m' : '',
  bgRed: isColorSupported ? '\x1b[41m' : '',
  bgBlue: isColorSupported ? '\x1b[44m' : '',
};

const TICK = `${c.green}✓${c.reset}`;
const CROSS = `${c.red}✗${c.reset}`;
const INFO = `${c.blue}ℹ${c.reset}`;
const WARN = `${c.yellow}⚠${c.reset}`;
const ARROW = `${c.cyan}→${c.reset}`;

// ─────────────────────────────────────────────────────────────────────────────
// Utility Helpers
// ─────────────────────────────────────────────────────────────────────────────

const __filename = fileURLToPath(import.meta.url);
const __dirname = path.dirname(__filename);
const PROJECT_ROOT = path.resolve(__dirname, '..', '..');
const ENV_FILE = path.join(PROJECT_ROOT, '.env');

function banner(): void {
  console.log('');
  console.log(`${c.bold}${c.blue}╔══════════════════════════════════════════════════════╗${c.reset}`);
  console.log(`${c.bold}${c.blue}║${c.reset}  ${c.bold}Google Slides Hybrid MCP — Setup Wizard${c.reset}            ${c.bold}${c.blue}║${c.reset}`);
  console.log(`${c.bold}${c.blue}╚══════════════════════════════════════════════════════╝${c.reset}`);
  console.log('');
}

function stepHeader(step: number, total: number, title: string): void {
  console.log('');
  console.log(`${c.bold}${c.magenta}Step ${step}/${total}: ${title}${c.reset}`);
  console.log(`${c.dim}${'─'.repeat(50)}${c.reset}`);
}

function getVersion(cmd: string): string | null {
  try {
    return execSync(`${cmd} --version`, { encoding: 'utf8', stdio: ['pipe', 'pipe', 'pipe'] }).trim();
  } catch {
    return null;
  }
}

function parseNodeVersion(versionStr: string): number[] {
  const match = versionStr.match(/v?(\d+)\.(\d+)\.(\d+)/);
  if (!match) return [0, 0, 0];
  return [parseInt(match[1], 10), parseInt(match[2], 10), parseInt(match[3], 10)];
}

// ─────────────────────────────────────────────────────────────────────────────
// Readline Prompt Abstraction
// ─────────────────────────────────────────────────────────────────────────────

class Prompter {
  private rl: readline.Interface;

  constructor() {
    this.rl = readline.createInterface({
      input: process.stdin,
      output: process.stdout,
    });
  }

  async ask(question: string, defaultValue?: string): Promise<string> {
    const suffix = defaultValue ? ` ${c.dim}(${defaultValue})${c.reset}` : '';
    return new Promise((resolve) => {
      this.rl.question(`  ${question}${suffix}: `, (answer) => {
        resolve(answer.trim() || defaultValue || '');
      });
    });
  }

  async confirm(question: string, defaultYes = true): Promise<boolean> {
    const hint = defaultYes ? 'Y/n' : 'y/N';
    return new Promise((resolve) => {
      this.rl.question(`  ${question} (${hint}): `, (answer) => {
        const a = answer.trim().toLowerCase();
        if (a === '') resolve(defaultYes);
        else resolve(a === 'y' || a === 'yes');
      });
    });
  }

  async secret(question: string): Promise<string> {
    // For secret input we write manually and suppress echo
    return new Promise((resolve) => {
      const stdin = process.stdin;
      const stdout = process.stdout;
      stdout.write(`  ${question}: `);

      // If stdin is not a TTY (piped), just read normally
      if (!stdin.isTTY) {
        this.rl.question('', (answer) => resolve(answer.trim()));
        return;
      }

      const wasRaw = stdin.isRaw;
      stdin.setRawMode(true);
      stdin.resume();
      stdin.setEncoding('utf8');

      let input = '';
      const onData = (char: string): void => {
        // Handle Ctrl+C
        if (char === '\x03') {
          stdout.write('\n');
          process.exit(1);
        }
        // Handle Enter
        if (char === '\r' || char === '\n') {
          stdout.write('\n');
          stdin.setRawMode(wasRaw ?? false);
          stdin.removeListener('data', onData);
          stdin.pause();
          // Re-resume for readline to work
          stdin.resume();
          resolve(input.trim());
          return;
        }
        // Handle Backspace
        if (char === '\x7f' || char === '\b') {
          if (input.length > 0) {
            input = input.slice(0, -1);
            stdout.write('\b \b');
          }
          return;
        }
        input += char;
        stdout.write('*');
      };

      stdin.on('data', onData);
    });
  }

  close(): void {
    this.rl.close();
  }
}

// ─────────────────────────────────────────────────────────────────────────────
// Step 1: Check Prerequisites
// ─────────────────────────────────────────────────────────────────────────────

interface PrereqResult {
  nodeOk: boolean;
  npmOk: boolean;
  nodeVersion: string;
  npmVersion: string;
  hasEnv: boolean;
  hasBuild: boolean;
}

function checkPrerequisites(): PrereqResult {
  const nodeRaw = getVersion('node');
  const npmRaw = getVersion('npm');

  const nodeVersion = nodeRaw ?? 'not found';
  const npmVersion = npmRaw
    ? npmRaw.replace(/^v?/, '')
    : 'not found';

  const nodeParts = nodeRaw ? parseNodeVersion(nodeRaw) : [0, 0, 0];
  const nodeOk = nodeParts[0] >= 18;
  const npmOk = npmRaw !== null;

  const hasEnv = fs.existsSync(ENV_FILE);
  const hasBuild = fs.existsSync(path.join(PROJECT_ROOT, 'build'));

  console.log(
    `  ${nodeOk ? TICK : CROSS} Node.js ${nodeVersion}${!nodeOk ? ` ${c.red}(requires >= 18)${c.reset}` : ''}`,
  );
  console.log(`  ${npmOk ? TICK : CROSS} npm ${npmVersion}`);

  if (hasEnv) {
    // Check if .env has real credentials
    const envContent = fs.readFileSync(ENV_FILE, 'utf8');
    const hasRealCreds =
      envContent.includes('GOOGLE_CLIENT_ID=') &&
      !envContent.includes('GOOGLE_CLIENT_ID=your-client-id');
    if (hasRealCreds) {
      console.log(`  ${TICK} .env file found with credentials`);
    } else {
      console.log(`  ${WARN} .env file found but credentials are placeholders`);
    }
  } else {
    console.log(`  ${INFO} .env file not found (will create)`);
  }

  if (hasBuild) {
    console.log(`  ${TICK} TypeScript build exists`);
  } else {
    console.log(`  ${INFO} TypeScript not yet built (will build)`);
  }

  return { nodeOk, npmOk, nodeVersion, npmVersion, hasEnv, hasBuild };
}

// ─────────────────────────────────────────────────────────────────────────────
// Step 2: Google Cloud OAuth Setup
// ─────────────────────────────────────────────────────────────────────────────

interface OAuthCredentials {
  clientId: string;
  clientSecret: string;
}

async function setupOAuthCredentials(prompter: Prompter): Promise<OAuthCredentials> {
  const hasCredentials = await prompter.confirm(
    'Do you already have Google Cloud OAuth credentials?',
    false,
  );

  if (!hasCredentials) {
    console.log('');
    console.log(`  ${ARROW} You need to create OAuth 2.0 credentials in Google Cloud Console.`);
    console.log('');
    console.log(`  ${c.bold}Follow these steps:${c.reset}`);
    console.log(`  ${c.dim}1.${c.reset} Go to ${c.cyan}https://console.cloud.google.com/apis/credentials${c.reset}`);
    console.log(`  ${c.dim}2.${c.reset} Create a new project (or select an existing one)`);
    console.log(`  ${c.dim}3.${c.reset} Click ${c.bold}Create Credentials${c.reset} → ${c.bold}OAuth client ID${c.reset}`);
    console.log(`  ${c.dim}4.${c.reset} Select application type: ${c.bold}Desktop app${c.reset}`);
    console.log(`  ${c.dim}5.${c.reset} Copy the ${c.bold}Client ID${c.reset} and ${c.bold}Client Secret${c.reset}`);
    console.log('');
    console.log(`  ${c.bold}Also enable these APIs:${c.reset}`);
    console.log(`  ${c.dim}•${c.reset} Google Slides API: ${c.cyan}https://console.cloud.google.com/apis/library/slides.googleapis.com${c.reset}`);
    console.log(`  ${c.dim}•${c.reset} Google Drive API:  ${c.cyan}https://console.cloud.google.com/apis/library/drive.googleapis.com${c.reset}`);
    console.log('');
    console.log(`  ${c.bold}Configure OAuth consent screen:${c.reset}`);
    console.log(`  ${c.dim}•${c.reset} Go to ${c.cyan}https://console.cloud.google.com/apis/credentials/consent${c.reset}`);
    console.log(`  ${c.dim}•${c.reset} Choose ${c.bold}External${c.reset} user type`);
    console.log(`  ${c.dim}•${c.reset} Add your Google account as a ${c.bold}test user${c.reset}`);
    console.log('');

    const openBrowser = await prompter.confirm('Open Google Cloud Console in your browser?', true);
    if (openBrowser) {
      try {
        const openModule = await import('open');
        await openModule.default('https://console.cloud.google.com/apis/credentials');
        console.log(`  ${TICK} Browser opened`);
      } catch {
        console.log(`  ${WARN} Could not open browser. Please visit the URL above manually.`);
      }
    }

    console.log('');
    console.log(`  ${c.dim}When you have your credentials, enter them below:${c.reset}`);
  }

  console.log('');
  const clientId = await prompter.ask(`${c.bold}Enter Client ID${c.reset}`);
  if (!clientId || !clientId.includes('.apps.googleusercontent.com')) {
    if (clientId && !clientId.includes('.apps.googleusercontent.com')) {
      console.log(`  ${WARN} Client ID usually ends with ${c.dim}.apps.googleusercontent.com${c.reset}`);
      const proceed = await prompter.confirm('Continue anyway?', true);
      if (!proceed) {
        console.log(`  ${CROSS} Setup cancelled.`);
        process.exit(1);
      }
    }
    if (!clientId) {
      console.log(`  ${CROSS} Client ID is required.`);
      process.exit(1);
    }
  }

  const clientSecret = await prompter.ask(`${c.bold}Enter Client Secret${c.reset}`);
  if (!clientSecret) {
    console.log(`  ${CROSS} Client Secret is required.`);
    process.exit(1);
  }

  console.log(`  ${TICK} Credentials received`);
  return { clientId, clientSecret };
}

// ─────────────────────────────────────────────────────────────────────────────
// Step 3: Get Refresh Token
// ─────────────────────────────────────────────────────────────────────────────

async function getRefreshToken(
  prompter: Prompter,
  credentials: OAuthCredentials,
): Promise<string> {
  const alreadyHasToken = await prompter.confirm(
    'Do you already have a refresh token?',
    false,
  );

  if (alreadyHasToken) {
    const token = await prompter.ask(`${c.bold}Enter Refresh Token${c.reset}`);
    if (!token) {
      console.log(`  ${CROSS} Refresh token is required.`);
      process.exit(1);
    }
    console.log(`  ${TICK} Refresh token received`);
    return token;
  }

  console.log('');
  console.log(`  ${ARROW} Starting OAuth consent flow...`);
  console.log(`  ${INFO} A browser window will open for Google authorization.`);
  console.log(`  ${INFO} Grant access, and the token will be captured automatically.`);
  console.log('');

  return new Promise<string>((resolve, reject) => {
    // We need to run the getRefreshToken script as a child process,
    // with the credentials set as environment variables. We capture its
    // output to extract the refresh token.
    const env = {
      ...process.env,
      GOOGLE_CLIENT_ID: credentials.clientId,
      GOOGLE_CLIENT_SECRET: credentials.clientSecret,
    };

    // Determine whether to use tsx (if available) or node with the built file
    const tsxPath = path.join(PROJECT_ROOT, 'node_modules', '.bin', 'tsx');
    const scriptPath = path.join(PROJECT_ROOT, 'src', 'api', 'getRefreshToken.ts');
    const builtScript = path.join(PROJECT_ROOT, 'build', 'api', 'getRefreshToken.js');

    let cmd: string;
    let args: string[];

    if (fs.existsSync(tsxPath) || fs.existsSync(tsxPath + '.cmd')) {
      const tsxBin = process.platform === 'win32' ? tsxPath + '.cmd' : tsxPath;
      cmd = tsxBin;
      args = [scriptPath];
    } else if (fs.existsSync(builtScript)) {
      cmd = 'node';
      args = [builtScript];
    } else {
      cmd = 'npx';
      args = ['tsx', scriptPath];
    }

    const child = spawn(cmd, args, {
      env,
      cwd: PROJECT_ROOT,
      stdio: ['inherit', 'pipe', 'inherit'],
      shell: process.platform === 'win32',
    });

    let output = '';
    let tokenFound = false;

    child.stdout.on('data', (data: Buffer) => {
      const text = data.toString();
      output += text;
      // Print output to user (so they can see what's happening)
      process.stdout.write(text);

      // Try to extract the refresh token from output
      // The getRefreshToken script prints:
      // ==============
      // REFRESH TOKEN OBTAINED SUCCESSFULLY
      // ==============
      //   <token>
      const tokenMatch = output.match(/REFRESH TOKEN OBTAINED SUCCESSFULLY\s*\n=+\n\s*(\S+)/);
      if (tokenMatch && !tokenFound) {
        tokenFound = true;
        // Don't resolve yet — wait for the child to exit
      }
    });

    child.on('close', (code) => {
      if (tokenFound) {
        const tokenMatch = output.match(/REFRESH TOKEN OBTAINED SUCCESSFULLY\s*\n=+\n\s*(\S+)/);
        if (tokenMatch) {
          console.log(`  ${TICK} Refresh token obtained!`);
          resolve(tokenMatch[1]);
          return;
        }
      }

      if (code !== 0) {
        console.log('');
        console.log(`  ${WARN} OAuth flow did not complete automatically (exit code: ${code}).`);
        console.log(`  ${INFO} You can enter the refresh token manually if you obtained it.`);
        console.log('');

        // Fall back to manual entry
        prompter.ask(`${c.bold}Enter Refresh Token (or press Enter to skip)${c.reset}`).then((token) => {
          if (token) {
            resolve(token);
          } else {
            console.log(`  ${WARN} No refresh token. You can get one later with: ${c.cyan}npm run get-token${c.reset}`);
            resolve('');
          }
        }).catch(reject);
      } else if (!tokenFound) {
        // Process exited 0 but we didn't find a token in output
        prompter.ask(`${c.bold}Enter Refresh Token${c.reset}`).then((token) => {
          if (token) {
            resolve(token);
          } else {
            console.log(`  ${WARN} No refresh token. You can get one later with: ${c.cyan}npm run get-token${c.reset}`);
            resolve('');
          }
        }).catch(reject);
      }
    });

    child.on('error', (err) => {
      console.log(`  ${WARN} Could not start OAuth flow: ${err.message}`);
      console.log(`  ${INFO} You can get a token manually with: ${c.cyan}npm run get-token${c.reset}`);

      prompter.ask(`${c.bold}Enter Refresh Token (or press Enter to skip)${c.reset}`).then((token) => {
        resolve(token || '');
      }).catch(reject);
    });
  });
}

// ─────────────────────────────────────────────────────────────────────────────
// Step 4: Feature Configuration
// ─────────────────────────────────────────────────────────────────────────────

interface FeatureConfig {
  browserEnabled: boolean;
  visionEnabled: boolean;
  wsPort: number;
  screenshotFormat: string;
  logLevel: string;
}

async function configureFeatures(prompter: Prompter): Promise<FeatureConfig> {
  console.log('');
  console.log(`  ${c.dim}The server has three layers. The API layer is always enabled.${c.reset}`);
  console.log(`  ${c.dim}The Browser and Vision layers are optional.${c.reset}`);
  console.log('');

  const browserEnabled = await prompter.confirm(
    `Enable ${c.bold}Browser layer${c.reset} (live editing via Chrome extension)?`,
    true,
  );

  let wsPort = 9222;
  if (browserEnabled) {
    const portStr = await prompter.ask('WebSocket port for Chrome extension', '9222');
    wsPort = parseInt(portStr, 10) || 9222;
  }

  const visionEnabled = await prompter.confirm(
    `Enable ${c.bold}Vision layer${c.reset} (design analysis with sharp)?`,
    true,
  );

  const logLevel = await prompter.ask('Log level', 'info');

  console.log('');
  console.log(`  ${TICK} Browser layer: ${browserEnabled ? `${c.green}enabled${c.reset} (port ${wsPort})` : `${c.dim}disabled${c.reset}`}`);
  console.log(`  ${TICK} Vision layer:  ${visionEnabled ? `${c.green}enabled${c.reset}` : `${c.dim}disabled${c.reset}`}`);
  console.log(`  ${TICK} Log level:     ${logLevel}`);

  return {
    browserEnabled,
    visionEnabled,
    wsPort,
    screenshotFormat: 'png',
    logLevel: logLevel || 'info',
  };
}

// ─────────────────────────────────────────────────────────────────────────────
// Step 5: Write Configuration & Build
// ─────────────────────────────────────────────────────────────────────────────

function writeEnvFile(
  credentials: OAuthCredentials,
  refreshToken: string,
  features: FeatureConfig,
): void {
  const lines = [
    '# ─────────────────────────────────────────────────────────────────────────────',
    '# Google Slides Hybrid MCP Server — Environment Variables',
    '# Generated by setup wizard on ' + new Date().toISOString(),
    '# ─────────────────────────────────────────────────────────────────────────────',
    '',
    '# ── Google OAuth 2.0 Credentials ─────────────────────────────────────────────',
    `GOOGLE_CLIENT_ID=${credentials.clientId}`,
    `GOOGLE_CLIENT_SECRET=${credentials.clientSecret}`,
    `GOOGLE_REFRESH_TOKEN=${refreshToken || 'YOUR_REFRESH_TOKEN_HERE'}`,
    '',
    '# ── Browser Layer Configuration ──────────────────────────────────────────────',
    `BROWSER_WS_PORT=${features.wsPort}`,
    `BROWSER_SCREENSHOT_FORMAT=${features.screenshotFormat}`,
    'BROWSER_TIMEOUT=30000',
    '',
    '# ── Vision Layer Configuration ───────────────────────────────────────────────',
    `VISION_ENABLED=${features.visionEnabled}`,
    'VISION_AUTO_FIX=false',
    '',
    '# ── Logging ──────────────────────────────────────────────────────────────────',
    `LOG_LEVEL=${features.logLevel}`,
    '',
    '# ── Runtime Environment ──────────────────────────────────────────────────────',
    'NODE_ENV=production',
  ];

  fs.writeFileSync(ENV_FILE, lines.join('\n') + '\n', 'utf8');
}

function buildProject(): boolean {
  console.log(`  ${ARROW} Compiling TypeScript...`);
  try {
    execSync('npm run build', {
      cwd: PROJECT_ROOT,
      stdio: ['pipe', 'pipe', 'pipe'],
      encoding: 'utf8',
    });
    return true;
  } catch (error) {
    const err = error as { stderr?: string; message?: string };
    console.log(`  ${CROSS} Build failed: ${err.stderr || err.message || 'unknown error'}`);
    return false;
  }
}

// ─────────────────────────────────────────────────────────────────────────────
// Main Setup Flow
// ─────────────────────────────────────────────────────────────────────────────

async function main(): Promise<void> {
  banner();

  const prompter = new Prompter();
  const TOTAL_STEPS = 5;

  try {
    // ── Step 1: Prerequisites ──────────────────────────────────────────────
    stepHeader(1, TOTAL_STEPS, 'Checking prerequisites');
    const prereqs = checkPrerequisites();

    if (!prereqs.nodeOk) {
      console.log('');
      console.log(`  ${CROSS} Node.js 18 or higher is required.`);
      console.log(`  ${ARROW} Download from: ${c.cyan}https://nodejs.org/${c.reset}`);
      process.exit(1);
    }

    if (!prereqs.npmOk) {
      console.log('');
      console.log(`  ${CROSS} npm is required but was not found.`);
      process.exit(1);
    }

    // ── Step 2: OAuth Credentials ──────────────────────────────────────────
    stepHeader(2, TOTAL_STEPS, 'Google Cloud OAuth Setup');

    // Check if we already have valid credentials in .env
    let credentials: OAuthCredentials;
    let existingToken = '';

    if (prereqs.hasEnv) {
      const envContent = fs.readFileSync(ENV_FILE, 'utf8');
      const existingId = envContent.match(/^GOOGLE_CLIENT_ID=(.+)$/m)?.[1]?.trim();
      const existingSecret = envContent.match(/^GOOGLE_CLIENT_SECRET=(.+)$/m)?.[1]?.trim();
      existingToken = envContent.match(/^GOOGLE_REFRESH_TOKEN=(.+)$/m)?.[1]?.trim() || '';

      if (
        existingId &&
        existingId !== 'your-client-id.apps.googleusercontent.com' &&
        existingSecret &&
        existingSecret !== 'your-client-secret'
      ) {
        console.log(`  ${INFO} Existing credentials found in .env`);
        const useExisting = await prompter.confirm('Use existing credentials?', true);
        if (useExisting) {
          credentials = { clientId: existingId, clientSecret: existingSecret };
          console.log(`  ${TICK} Using existing credentials`);
        } else {
          credentials = await setupOAuthCredentials(prompter);
        }
      } else {
        credentials = await setupOAuthCredentials(prompter);
      }
    } else {
      credentials = await setupOAuthCredentials(prompter);
    }

    // ── Step 3: Refresh Token ──────────────────────────────────────────────
    stepHeader(3, TOTAL_STEPS, 'Getting Refresh Token');

    let refreshToken: string;

    if (
      existingToken &&
      existingToken !== 'your-refresh-token' &&
      existingToken !== 'YOUR_REFRESH_TOKEN_HERE'
    ) {
      console.log(`  ${INFO} Existing refresh token found in .env`);
      const useExisting = await prompter.confirm('Use existing refresh token?', true);
      if (useExisting) {
        refreshToken = existingToken;
        console.log(`  ${TICK} Using existing refresh token`);
      } else {
        refreshToken = await getRefreshToken(prompter, credentials);
      }
    } else {
      refreshToken = await getRefreshToken(prompter, credentials);
    }

    // ── Step 4: Features ───────────────────────────────────────────────────
    stepHeader(4, TOTAL_STEPS, 'Configuration');
    const features = await configureFeatures(prompter);

    // ── Step 5: Write & Build ──────────────────────────────────────────────
    stepHeader(5, TOTAL_STEPS, 'Writing configuration');

    // Back up existing .env
    if (fs.existsSync(ENV_FILE)) {
      const backup = ENV_FILE + '.backup';
      fs.copyFileSync(ENV_FILE, backup);
      console.log(`  ${INFO} Backed up existing .env to .env.backup`);
    }

    writeEnvFile(credentials, refreshToken, features);
    console.log(`  ${TICK} .env file created`);

    // Build
    const buildOk = buildProject();
    if (buildOk) {
      console.log(`  ${TICK} TypeScript compiled successfully`);
    } else {
      console.log(`  ${WARN} Build failed — you can fix issues and run ${c.cyan}npm run build${c.reset} later`);
    }

    // ── Summary ────────────────────────────────────────────────────────────
    console.log('');
    console.log(`${c.bold}${c.green}╔══════════════════════════════════════════════════════╗${c.reset}`);
    console.log(`${c.bold}${c.green}║${c.reset}  ${c.bold}${c.green}Setup Complete!${c.reset}                                     ${c.bold}${c.green}║${c.reset}`);
    console.log(`${c.bold}${c.green}╚══════════════════════════════════════════════════════╝${c.reset}`);
    console.log('');

    if (!refreshToken || refreshToken === 'YOUR_REFRESH_TOKEN_HERE') {
      console.log(`  ${WARN} You still need a refresh token. Run:`);
      console.log(`     ${c.cyan}npm run get-token${c.reset}`);
      console.log('');
    }

    console.log(`  ${c.bold}Next steps:${c.reset}`);
    console.log('');
    console.log(`  ${c.dim}1.${c.reset} Start the server:        ${c.cyan}npm start${c.reset}`);
    console.log(`  ${c.dim}2.${c.reset} Run diagnostics:         ${c.cyan}npm run doctor${c.reset}`);
    console.log(`  ${c.dim}3.${c.reset} Add to your MCP client:  Copy config from ${c.cyan}configs/${c.reset}`);

    if (features.browserEnabled) {
      console.log(`  ${c.dim}4.${c.reset} Install Chrome extension: Load ${c.cyan}src/chrome-extension/${c.reset} in chrome://extensions`);
    }

    console.log('');
    console.log(`  ${c.dim}For more info: ${c.cyan}npm run doctor${c.reset}`);
    console.log('');
  } finally {
    prompter.close();
  }
}

// ── Entry Point ─────────────────────────────────────────────────────────────

main().catch((error: unknown) => {
  console.error(`\n${CROSS} Setup failed:`, error instanceof Error ? error.message : error);
  process.exit(1);
});
