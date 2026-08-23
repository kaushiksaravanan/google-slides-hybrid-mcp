#!/usr/bin/env node

/**
 * @module cli/index
 * @description CLI entry point for the Google Slides Hybrid MCP server.
 *
 * Handles subcommands:
 *   setup       Run the interactive setup wizard
 *   doctor      Run diagnostics to verify installation
 *   start       Start the MCP server (default)
 *   get-token   Run the OAuth refresh token flow
 *   --help      Show help
 *   --version   Show version
 *
 * Usage:
 *   npx google-slides-hybrid-mcp [command]
 *   node build/cli/index.js [command]
 */

import { spawn } from 'node:child_process';
import fs from 'node:fs';
import path from 'node:path';
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
  cyan: isColorSupported ? '\x1b[36m' : '',
  blue: isColorSupported ? '\x1b[34m' : '',
  yellow: isColorSupported ? '\x1b[33m' : '',
};

// ─────────────────────────────────────────────────────────────────────────────
// Paths
// ─────────────────────────────────────────────────────────────────────────────

const __filename = fileURLToPath(import.meta.url);
const __dirname = path.dirname(__filename);

// Determine project root by looking for package.json
// Works both from src/cli/ (via tsx) and build/cli/ (compiled)
function findProjectRoot(): string {
  let dir = __dirname;
  for (let i = 0; i < 5; i++) {
    if (fs.existsSync(path.join(dir, 'package.json'))) {
      return dir;
    }
    dir = path.dirname(dir);
  }
  return process.cwd();
}

const PROJECT_ROOT = findProjectRoot();

// ─────────────────────────────────────────────────────────────────────────────
// Version
// ─────────────────────────────────────────────────────────────────────────────

function getPackageVersion(): string {
  try {
    const pkgPath = path.join(PROJECT_ROOT, 'package.json');
    const pkg = JSON.parse(fs.readFileSync(pkgPath, 'utf8')) as { version?: string };
    return pkg.version ?? '0.0.0';
  } catch {
    return '0.0.0';
  }
}

// ─────────────────────────────────────────────────────────────────────────────
// Help Text
// ─────────────────────────────────────────────────────────────────────────────

function showHelp(): void {
  const version = getPackageVersion();
  console.log(`
${c.bold}Google Slides Hybrid MCP v${version}${c.reset}
${c.dim}Production-ready hybrid Google Slides MCP server${c.reset}
${c.dim}API + Live Browser + Vision layers${c.reset}

${c.bold}USAGE${c.reset}
  ${c.cyan}npx google-slides-hybrid-mcp${c.reset} [command] [options]

${c.bold}COMMANDS${c.reset}
  ${c.green}setup${c.reset}        Interactive setup wizard (credentials, config, build)
  ${c.green}doctor${c.reset}       Run diagnostics to verify installation health
  ${c.green}start${c.reset}        Start the MCP server ${c.dim}(default)${c.reset}
  ${c.green}get-token${c.reset}    Run the OAuth refresh token flow

${c.bold}OPTIONS${c.reset}
  ${c.green}--help${c.reset}       Show this help message
  ${c.green}--version${c.reset}    Show version number

${c.bold}QUICK START${c.reset}
  ${c.dim}1.${c.reset} ${c.cyan}npm install${c.reset}
  ${c.dim}2.${c.reset} ${c.cyan}npm run setup${c.reset}         ${c.dim}# Interactive wizard${c.reset}
  ${c.dim}3.${c.reset} ${c.cyan}npm run doctor${c.reset}        ${c.dim}# Verify everything works${c.reset}
  ${c.dim}4.${c.reset} ${c.cyan}npm start${c.reset}             ${c.dim}# Start the server${c.reset}

${c.bold}DOCUMENTATION${c.reset}
  README:  ${c.cyan}${path.join(PROJECT_ROOT, 'README.md')}${c.reset}
  Configs: ${c.cyan}${path.join(PROJECT_ROOT, 'configs', '')}${c.reset}
`);
}

// ─────────────────────────────────────────────────────────────────────────────
// Command Runners
// ─────────────────────────────────────────────────────────────────────────────

/**
 * Resolve a script path, preferring the TypeScript source if tsx is available,
 * otherwise falling back to the compiled JavaScript.
 */
function resolveScript(
  tsRelative: string,
  jsRelative: string,
): { cmd: string; args: string[]; needsShell: boolean } {
  const tsPath = path.join(PROJECT_ROOT, tsRelative);
  const jsPath = path.join(PROJECT_ROOT, jsRelative);
  const tsxBin = path.join(PROJECT_ROOT, 'node_modules', '.bin', 'tsx');
  const tsxExists =
    fs.existsSync(tsxBin) ||
    fs.existsSync(tsxBin + '.cmd') ||
    fs.existsSync(tsxBin + '.ps1');

  if (tsxExists && fs.existsSync(tsPath)) {
    const bin = process.platform === 'win32' ? tsxBin + '.cmd' : tsxBin;
    // .cmd files on Windows require shell, but we avoid passing args through
    // the shell by using a direct node invocation instead.
    if (process.platform === 'win32') {
      // On Windows, invoke tsx via node to avoid shell: true deprecation
      const tsxJsEntry = path.join(PROJECT_ROOT, 'node_modules', 'tsx', 'dist', 'cli.mjs');
      if (fs.existsSync(tsxJsEntry)) {
        return { cmd: process.execPath, args: ['--import', 'tsx', tsPath], needsShell: false };
      }
      return { cmd: bin, args: [tsPath], needsShell: true };
    }
    return { cmd: bin, args: [tsPath], needsShell: false };
  }

  if (fs.existsSync(jsPath)) {
    return { cmd: process.execPath, args: [jsPath], needsShell: false };
  }

  // Fallback to npx tsx
  if (fs.existsSync(tsPath)) {
    return { cmd: 'npx', args: ['tsx', tsPath], needsShell: process.platform === 'win32' };
  }

  throw new Error(
    `Script not found. Looked for:\n  ${tsPath}\n  ${jsPath}\nRun 'npm run build' first.`,
  );
}

function runScript(tsRelative: string, jsRelative: string): void {
  const { cmd, args, needsShell } = resolveScript(tsRelative, jsRelative);

  const child = spawn(cmd, args, {
    cwd: PROJECT_ROOT,
    stdio: 'inherit',
    shell: needsShell,
    env: process.env,
  });

  child.on('close', (code) => {
    process.exit(code ?? 0);
  });

  child.on('error', (err) => {
    console.error(`Failed to run command: ${err.message}`);
    process.exit(1);
  });
}

// ─────────────────────────────────────────────────────────────────────────────
// Main
// ─────────────────────────────────────────────────────────────────────────────

function main(): void {
  const args = process.argv.slice(2);
  const command = args[0] ?? 'start';

  switch (command) {
    case 'setup':
      runScript('src/cli/setup.ts', 'build/cli/setup.js');
      break;

    case 'doctor':
    case 'check':
    case 'diagnose':
      runScript('src/cli/doctor.ts', 'build/cli/doctor.js');
      break;

    case 'start':
    case 'serve':
      runScript('src/index.ts', 'build/index.js');
      break;

    case 'get-token':
    case 'token':
    case 'auth':
      runScript('src/api/getRefreshToken.ts', 'build/api/getRefreshToken.js');
      break;

    case '--help':
    case '-h':
    case 'help':
      showHelp();
      break;

    case '--version':
    case '-v':
    case '-V':
    case 'version':
      console.log(getPackageVersion());
      break;

    default:
      console.error(
        `\n${c.yellow}Unknown command: ${c.bold}${command}${c.reset}\n`,
      );
      showHelp();
      process.exit(1);
  }
}

main();
