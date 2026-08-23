/**
 * @module api/getRefreshToken
 * @description One-time interactive script to obtain a Google OAuth2 refresh token.
 *
 * Usage:
 *   npm run get-token
 *
 * This script:
 * 1. Reads GOOGLE_CLIENT_ID and GOOGLE_CLIENT_SECRET from environment variables.
 * 2. Starts a local HTTP server on port 3000 to receive the OAuth callback.
 * 3. Opens the user's default browser to the Google consent screen.
 * 4. Exchanges the authorization code for tokens.
 * 5. Prints the refresh token to the console.
 * 6. Shuts down the server and exits cleanly.
 *
 * The refresh token should be stored in the GOOGLE_REFRESH_TOKEN environment
 * variable for use by the MCP server.
 */

import http from 'node:http';
import type { Socket } from 'node:net';
import { URL } from 'node:url';
import open from 'open';
import {
  GOOGLE_SLIDES_SCOPE,
  GOOGLE_DRIVE_SCOPE,
  ENV_VARS,
} from '../shared/constants.js';
import { getAuthorizationUrl, exchangeCodeForTokens } from './auth.js';

// ─────────────────────────────────────────────────────────────────────────────
// Configuration
// ─────────────────────────────────────────────────────────────────────────────

const PORT = 3000;
const CALLBACK_PATH = '/oauth2callback';
// Full Drive scope (not readonly) is required so that sharing permissions
// (drive.permissions.create) work correctly at runtime.
const SCOPES = [GOOGLE_SLIDES_SCOPE, GOOGLE_DRIVE_SCOPE] as const;

// ─────────────────────────────────────────────────────────────────────────────
// Helpers
// ─────────────────────────────────────────────────────────────────────────────

/**
 * Track open sockets on an HTTP server so we can forcefully destroy them
 * during shutdown.  This replaces the `server-destroy` package with a
 * simpler, dependency-free approach that avoids ESM/CJS detection issues.
 */
function trackSockets(server: http.Server): { destroyAll: () => void } {
  const sockets = new Set<Socket>();

  server.on('connection', (socket: Socket) => {
    sockets.add(socket);
    socket.on('close', () => sockets.delete(socket));
  });

  return {
    destroyAll() {
      for (const socket of sockets) {
        socket.destroy();
      }
      sockets.clear();
    },
  };
}

/**
 * HTML page returned to the browser after successful token exchange.
 */
function successHtml(refreshToken: string): string {
  // Mask the refresh token in HTML — only show first 8 and last 4 characters.
  // The full token is printed to the console, which is the intended mechanism.
  const masked = refreshToken.length > 12
    ? `${refreshToken.slice(0, 8)}...${'*'.repeat(8)}...${refreshToken.slice(-4)}`
    : '****masked****';

  return `<!DOCTYPE html>
<html lang="en">
<head>
  <meta charset="utf-8">
  <title>Google Slides MCP - Token Acquired</title>
  <style>
    body { font-family: system-ui, sans-serif; max-width: 600px; margin: 80px auto; padding: 20px; }
    h1 { color: #1a73e8; }
    .token-box { background: #f1f3f4; padding: 16px; border-radius: 8px; word-break: break-all; font-family: monospace; font-size: 13px; }
    .note { color: #5f6368; margin-top: 16px; }
  </style>
</head>
<body>
  <h1>Authentication Successful</h1>
  <p>Your refresh token has been printed to the console. You can close this window.</p>
  <p class="note">
    Set the following environment variable to configure the MCP server:
  </p>
  <div class="token-box">
    ${ENV_VARS.GOOGLE_REFRESH_TOKEN}=${masked}
  </div>
</body>
</html>`;
}

/**
 * HTML page returned when an error occurs.
 */
function errorHtml(message: string): string {
  return `<!DOCTYPE html>
<html lang="en">
<head>
  <meta charset="utf-8">
  <title>Google Slides MCP - Error</title>
  <style>
    body { font-family: system-ui, sans-serif; max-width: 600px; margin: 80px auto; padding: 20px; }
    h1 { color: #d93025; }
    .error { background: #fce8e6; padding: 16px; border-radius: 8px; }
  </style>
</head>
<body>
  <h1>Authentication Failed</h1>
  <div class="error">${message}</div>
</body>
</html>`;
}

// ─────────────────────────────────────────────────────────────────────────────
// Main
// ─────────────────────────────────────────────────────────────────────────────

async function main(): Promise<void> {
  // Read credentials from environment.
  const clientId = process.env[ENV_VARS.GOOGLE_CLIENT_ID];
  const clientSecret = process.env[ENV_VARS.GOOGLE_CLIENT_SECRET];

  if (!clientId || !clientSecret) {
    console.error(
      `\nError: Missing required environment variables.\n` +
        `  ${ENV_VARS.GOOGLE_CLIENT_ID}  — your Google OAuth client ID\n` +
        `  ${ENV_VARS.GOOGLE_CLIENT_SECRET} — your Google OAuth client secret\n\n` +
        `Set these variables and re-run this script.\n`,
    );
    process.exit(1);
  }

  // Generate the authorization URL.
  const authUrl = getAuthorizationUrl(clientId, clientSecret, SCOPES);

  // Create the local HTTP server to handle the callback.
  const server = http.createServer(async (req, res) => {
    try {
      const reqUrl = new URL(req.url ?? '/', `http://localhost:${PORT}`);

      // Only handle the callback path.
      if (reqUrl.pathname !== CALLBACK_PATH) {
        res.writeHead(404, { 'Content-Type': 'text/plain' });
        res.end('Not Found');
        return;
      }

      // Check for OAuth errors (user denied, etc.).
      const error = reqUrl.searchParams.get('error');
      if (error) {
        const description = reqUrl.searchParams.get('error_description') ?? error;
        res.writeHead(400, { 'Content-Type': 'text/html; charset=utf-8' });
        res.end(errorHtml(description));
        console.error(`\nOAuth error: ${description}\n`);
        shutdown();
        return;
      }

      // Extract the authorization code.
      const code = reqUrl.searchParams.get('code');
      if (!code) {
        res.writeHead(400, { 'Content-Type': 'text/html; charset=utf-8' });
        res.end(errorHtml('No authorization code received.'));
        console.error('\nError: No authorization code in the callback URL.\n');
        shutdown();
        return;
      }

      // Exchange the code for tokens.
      console.log('\nExchanging authorization code for tokens...');
      const tokens = await exchangeCodeForTokens(clientId, clientSecret, code);

      // Return success page.
      res.writeHead(200, { 'Content-Type': 'text/html; charset=utf-8' });
      res.end(successHtml(tokens.refreshToken));

      // Print the refresh token to the console.
      console.log('\n' + '='.repeat(60));
      console.log('  REFRESH TOKEN OBTAINED SUCCESSFULLY');
      console.log('='.repeat(60));
      console.log(`\n  ${tokens.refreshToken}\n`);
      console.log('='.repeat(60));
      console.log(
        `\nAdd this to your environment:\n` +
          `  export ${ENV_VARS.GOOGLE_REFRESH_TOKEN}="${tokens.refreshToken}"\n`,
      );

      if (tokens.expiryDate) {
        console.log(
          `Access token expires: ${new Date(tokens.expiryDate).toISOString()}\n`,
        );
      }

      // Clean shutdown after a short delay (let the response finish).
      setTimeout(shutdown, 1000);
    } catch (err) {
      const message = err instanceof Error ? err.message : String(err);
      console.error(`\nError during token exchange: ${message}\n`);
      res.writeHead(500, { 'Content-Type': 'text/html; charset=utf-8' });
      res.end(errorHtml(`Token exchange failed: ${message}`));
      setTimeout(shutdown, 1000);
    }
  });

  // Enable forceful server shutdown (destroys open sockets).
  const socketTracker = trackSockets(server);

  /** Shut down the server and exit the process. */
  function shutdown(): void {
    console.log('Shutting down local server...');
    socketTracker.destroyAll();
    server.close();
    // Give sockets a moment to close, then exit.
    setTimeout(() => process.exit(0), 500);
  }

  // Handle process signals for clean shutdown.
  process.on('SIGINT', () => {
    console.log('\nReceived SIGINT, shutting down...');
    shutdown();
  });
  process.on('SIGTERM', () => {
    console.log('\nReceived SIGTERM, shutting down...');
    shutdown();
  });

  // Start listening.
  server.listen(PORT, () => {
    console.log(`\nLocal OAuth callback server listening on port ${PORT}`);
    console.log(`\nOpening browser for Google consent...\n`);
    console.log(`If the browser does not open automatically, visit:\n  ${authUrl}\n`);

    // Open the consent URL in the default browser.
    open(authUrl).catch((err: unknown) => {
      const message = err instanceof Error ? err.message : String(err);
      console.warn(`Could not open browser automatically: ${message}`);
      console.log(`Please visit the URL above manually.`);
    });
  });

  // Handle server errors (e.g. port already in use).
  server.on('error', (err: NodeJS.ErrnoException) => {
    if (err.code === 'EADDRINUSE') {
      console.error(
        `\nError: Port ${PORT} is already in use.\n` +
          `Close any other process using that port and try again.\n`,
      );
    } else {
      console.error(`\nServer error: ${err.message}\n`);
    }
    process.exit(1);
  });
}

// Run the script.
main().catch((err: unknown) => {
  console.error('Fatal error:', err);
  process.exit(1);
});
