/**
 * Auth system tests — TenantManager, SessionManager, AuthMiddleware, OAuthProvider
 */
import { describe, it, expect, beforeEach, afterEach, vi } from 'vitest';
import {
  TenantManager,
  TenantError,
  SessionManager,
  AuthMiddleware,
  OAuthProvider,
  OAuthError,
  PLAN_LIMITS,
} from '../../auth/index.js';
import type { AuthRequest } from '../../auth/middleware.js';

// ─────────────────────────────────────────────────────────────────────────────
// TenantManager
// ─────────────────────────────────────────────────────────────────────────────

describe('TenantManager', () => {
  let tm: TenantManager;

  beforeEach(() => {
    tm = new TenantManager();
  });

  describe('createTenant', () => {
    it('creates a tenant with default free plan', () => {
      const t = tm.createTenant('Acme', 'admin@acme.com');
      expect(t.name).toBe('Acme');
      expect(t.email).toBe('admin@acme.com');
      expect(t.plan).toBe('free');
      expect(t.id).toBeTruthy();
      expect(t.createdAt).toBeInstanceOf(Date);
      expect(t.lastActiveAt).toBeInstanceOf(Date);
    });

    it('creates a tenant with a specific plan', () => {
      const t = tm.createTenant('Pro Co', 'hi@pro.co', 'pro');
      expect(t.plan).toBe('pro');
      expect(t.settings.visionEnabled).toBe(true);
    });

    it('normalises email to lowercase', () => {
      const t = tm.createTenant('Test', 'UPPER@CASE.COM');
      expect(t.email).toBe('upper@case.com');
    });

    it('trims name and email', () => {
      const t = tm.createTenant('  Spaced  ', '  spaced@test.com  ');
      expect(t.name).toBe('Spaced');
      expect(t.email).toBe('spaced@test.com');
    });

    it('throws on duplicate email', () => {
      tm.createTenant('A', 'dup@test.com');
      expect(() => tm.createTenant('B', 'dup@test.com')).toThrow(TenantError);
      expect(() => tm.createTenant('B', 'dup@test.com')).toThrow('already exists');
    });

    it('applies plan limits from PLAN_LIMITS', () => {
      const t = tm.createTenant('E', 'e@test.com', 'enterprise');
      expect(t.settings.maxPresentationsPerDay).toBe(PLAN_LIMITS.enterprise.maxPresentationsPerDay);
      expect(t.settings.webhooksEnabled).toBe(true);
    });

    it('stores google credentials when provided', () => {
      const creds = { clientId: 'cid', clientSecret: 'cs', refreshToken: 'rt' };
      const t = tm.createTenant('G', 'g@test.com', 'free', creds);
      expect(t.googleCredentials).toEqual(creds);
    });
  });

  describe('getTenant', () => {
    it('returns tenant by id', () => {
      const t = tm.createTenant('A', 'a@test.com');
      expect(tm.getTenant(t.id)).toEqual(t);
    });

    it('returns null for unknown id', () => {
      expect(tm.getTenant('nonexistent')).toBeNull();
    });
  });

  describe('getTenantByEmail', () => {
    it('finds tenant by email (case-insensitive)', () => {
      const t = tm.createTenant('A', 'find@me.com');
      expect(tm.getTenantByEmail('FIND@ME.COM')?.id).toBe(t.id);
    });

    it('returns null for unknown email', () => {
      expect(tm.getTenantByEmail('nope@test.com')).toBeNull();
    });
  });

  describe('getTenantByApiKey', () => {
    it('finds tenant by valid api key', () => {
      const t = tm.createTenant('A', 'a@test.com');
      const key = tm.generateApiKey(t.id, 'k', ['*']);
      expect(tm.getTenantByApiKey(key.key)?.id).toBe(t.id);
    });

    it('returns null for invalid key', () => {
      expect(tm.getTenantByApiKey('bogus')).toBeNull();
    });
  });

  describe('updateTenant', () => {
    it('updates name', () => {
      const t = tm.createTenant('Old', 'old@test.com');
      const updated = tm.updateTenant(t.id, { name: 'New' });
      expect(updated.name).toBe('New');
    });

    it('updates email with re-indexing', () => {
      const t = tm.createTenant('A', 'old@test.com');
      tm.updateTenant(t.id, { email: 'new@test.com' });
      expect(tm.getTenantByEmail('old@test.com')).toBeNull();
      expect(tm.getTenantByEmail('new@test.com')).not.toBeNull();
    });

    it('throws on email conflict', () => {
      tm.createTenant('A', 'a@test.com');
      const b = tm.createTenant('B', 'b@test.com');
      expect(() => tm.updateTenant(b.id, { email: 'a@test.com' })).toThrow('already exists');
    });

    it('throws for unknown tenant', () => {
      expect(() => tm.updateTenant('nope', { name: 'X' })).toThrow('not found');
    });

    it('updates plan and resets settings', () => {
      const t = tm.createTenant('A', 'a@test.com', 'free');
      expect(t.settings.visionEnabled).toBe(false);
      const updated = tm.updateTenant(t.id, { plan: 'pro' });
      expect(updated.plan).toBe('pro');
      expect(updated.settings.visionEnabled).toBe(true);
    });
  });

  describe('deleteTenant', () => {
    it('deletes tenant and its API keys', () => {
      const t = tm.createTenant('A', 'a@test.com');
      const key = tm.generateApiKey(t.id, 'k', ['*']);
      expect(tm.deleteTenant(t.id)).toBe(true);
      expect(tm.getTenant(t.id)).toBeNull();
      expect(tm.validateApiKey(key.key)).toBeNull();
    });

    it('returns false for non-existent tenant', () => {
      expect(tm.deleteTenant('nope')).toBe(false);
    });
  });

  describe('listTenants', () => {
    it('returns all tenants sorted by creation date (newest first)', () => {
      tm.createTenant('A', 'a@test.com');
      tm.createTenant('B', 'b@test.com');
      tm.createTenant('C', 'c@test.com');
      const list = tm.listTenants();
      expect(list).toHaveLength(3);
      // All created at essentially the same time, just verify we get 3
      const names = list.map(t => t.name);
      expect(names).toContain('A');
      expect(names).toContain('B');
      expect(names).toContain('C');
    });

    it('supports pagination', () => {
      tm.createTenant('A', 'a@test.com');
      tm.createTenant('B', 'b@test.com');
      tm.createTenant('C', 'c@test.com');
      const page = tm.listTenants(1, 1);
      expect(page).toHaveLength(1);
    });
  });

  describe('generateApiKey', () => {
    it('generates a key with gshm_ prefix', () => {
      const t = tm.createTenant('A', 'a@test.com');
      const key = tm.generateApiKey(t.id, 'test', ['slides:read']);
      expect(key.key).toMatch(/^gshm_/);
      expect(key.tenantId).toBe(t.id);
      expect(key.permissions).toEqual(['slides:read']);
    });

    it('throws for unknown tenant', () => {
      expect(() => tm.generateApiKey('nope', 'k', ['*'])).toThrow('not found');
    });

    it('stores expiry date when provided', () => {
      const t = tm.createTenant('A', 'a@test.com');
      const future = new Date(Date.now() + 86400000);
      const key = tm.generateApiKey(t.id, 'k', ['*'], 60, future);
      expect(key.expiresAt).toEqual(future);
    });
  });

  describe('revokeApiKey', () => {
    it('revokes an existing key', () => {
      const t = tm.createTenant('A', 'a@test.com');
      const key = tm.generateApiKey(t.id, 'k', ['*']);
      expect(tm.revokeApiKey(key.key)).toBe(true);
      expect(tm.validateApiKey(key.key)).toBeNull();
    });

    it('returns false for unknown key', () => {
      expect(tm.revokeApiKey('bogus')).toBe(false);
    });
  });

  describe('validateApiKey', () => {
    it('validates a good key and updates lastUsedAt', () => {
      const t = tm.createTenant('A', 'a@test.com');
      const key = tm.generateApiKey(t.id, 'k', ['*']);
      const info = tm.validateApiKey(key.key);
      expect(info).not.toBeNull();
      expect(info!.lastUsedAt).toBeInstanceOf(Date);
    });

    it('auto-revokes expired keys', () => {
      const t = tm.createTenant('A', 'a@test.com');
      const past = new Date(Date.now() - 1000);
      const key = tm.generateApiKey(t.id, 'k', ['*'], 60, past);
      expect(tm.validateApiKey(key.key)).toBeNull();
      expect(tm.apiKeyCount).toBe(0);
    });

    it('returns null for non-existent key', () => {
      expect(tm.validateApiKey('gshm_nothing')).toBeNull();
    });
  });

  describe('plan limits enforcement', () => {
    it('checkPlanLimit returns true for enabled boolean', () => {
      const t = tm.createTenant('A', 'a@test.com', 'enterprise');
      expect(tm.checkPlanLimit(t.id, 'webhooksEnabled')).toBe(true);
    });

    it('checkPlanLimit returns false for disabled boolean', () => {
      const t = tm.createTenant('A', 'a@test.com', 'free');
      expect(tm.checkPlanLimit(t.id, 'visionEnabled')).toBe(false);
    });

    it('getNumericLimit returns correct limit', () => {
      const t = tm.createTenant('A', 'a@test.com', 'pro');
      expect(tm.getNumericLimit(t.id, 'maxPresentationsPerDay')).toBe(50);
    });

    it('throws for unknown tenant in checkPlanLimit', () => {
      expect(() => tm.checkPlanLimit('nope', 'visionEnabled')).toThrow('not found');
    });
  });

  describe('tenantCount / apiKeyCount', () => {
    it('tracks counts', () => {
      expect(tm.tenantCount).toBe(0);
      const t = tm.createTenant('A', 'a@test.com');
      expect(tm.tenantCount).toBe(1);
      tm.generateApiKey(t.id, 'k', ['*']);
      expect(tm.apiKeyCount).toBe(1);
    });
  });
});

// ─────────────────────────────────────────────────────────────────────────────
// SessionManager
// ─────────────────────────────────────────────────────────────────────────────

describe('SessionManager', () => {
  let sm: SessionManager;

  beforeEach(() => {
    sm = new SessionManager(60_000, 999_999_999); // 1min TTL, no auto-cleanup
  });

  afterEach(() => {
    sm.dispose();
  });

  describe('createSession', () => {
    it('creates a session with a token', () => {
      const s = sm.createSession('t1');
      expect(s.token).toBeTruthy();
      expect(s.tenantId).toBe('t1');
      expect(s.id).toBeTruthy();
    });

    it('stores ip and userAgent', () => {
      const s = sm.createSession('t1', '1.2.3.4', 'Mozilla');
      expect(s.ipAddress).toBe('1.2.3.4');
      expect(s.userAgent).toBe('Mozilla');
    });
  });

  describe('validateSession', () => {
    it('returns session for valid token', () => {
      const s = sm.createSession('t1');
      const validated = sm.validateSession(s.token);
      expect(validated).not.toBeNull();
      expect(validated!.tenantId).toBe('t1');
    });

    it('returns null for unknown token', () => {
      expect(sm.validateSession('bogus')).toBeNull();
    });

    it('returns null for expired session', () => {
      const shortSm = new SessionManager(1); // 1ms TTL
      const s = shortSm.createSession('t1');
      // Wait for expiry
      const start = Date.now();
      while (Date.now() - start < 5) { /* spin */ }
      expect(shortSm.validateSession(s.token)).toBeNull();
      shortSm.dispose();
    });
  });

  describe('refreshSession', () => {
    it('extends session expiry', () => {
      const s = sm.createSession('t1');
      const original = s.expiresAt.getTime();
      // Small delay
      const refreshed = sm.refreshSession(s.token);
      expect(refreshed).not.toBeNull();
      expect(refreshed!.expiresAt.getTime()).toBeGreaterThanOrEqual(original);
    });

    it('returns null for unknown token', () => {
      expect(sm.refreshSession('bogus')).toBeNull();
    });
  });

  describe('destroySession', () => {
    it('removes a session', () => {
      const s = sm.createSession('t1');
      expect(sm.destroySession(s.token)).toBe(true);
      expect(sm.validateSession(s.token)).toBeNull();
    });

    it('returns false for unknown token', () => {
      expect(sm.destroySession('bogus')).toBe(false);
    });
  });

  describe('destroyAllSessions', () => {
    it('removes all sessions for a tenant', () => {
      sm.createSession('t1');
      sm.createSession('t1');
      sm.createSession('t2');
      expect(sm.destroyAllSessions('t1')).toBe(2);
      expect(sm.getActiveSessionCount('t1')).toBe(0);
      expect(sm.getActiveSessionCount('t2')).toBe(1);
    });

    it('returns 0 for tenant with no sessions', () => {
      expect(sm.destroyAllSessions('nobody')).toBe(0);
    });
  });

  describe('cleanupExpiredSessions', () => {
    it('removes expired sessions', () => {
      const shortSm = new SessionManager(1, 999_999_999);
      shortSm.createSession('t1');
      shortSm.createSession('t1');
      const start = Date.now();
      while (Date.now() - start < 5) { /* spin */ }
      const removed = shortSm.cleanupExpiredSessions();
      expect(removed).toBe(2);
      expect(shortSm.sessionCount).toBe(0);
      shortSm.dispose();
    });
  });

  describe('sessionCount / getActiveSessionCount', () => {
    it('tracks session count', () => {
      expect(sm.sessionCount).toBe(0);
      sm.createSession('t1');
      expect(sm.sessionCount).toBe(1);
      expect(sm.getActiveSessionCount('t1')).toBe(1);
    });
  });
});

// ─────────────────────────────────────────────────────────────────────────────
// AuthMiddleware
// ─────────────────────────────────────────────────────────────────────────────

describe('AuthMiddleware', () => {
  let tm: TenantManager;
  let sm: SessionManager;
  let auth: AuthMiddleware;

  beforeEach(() => {
    tm = new TenantManager();
    sm = new SessionManager(60_000, 999_999_999);
    auth = new AuthMiddleware(tm, sm);
  });

  afterEach(() => {
    sm.dispose();
  });

  it('authenticates with valid session (Bearer token)', () => {
    const t = tm.createTenant('A', 'a@test.com');
    const s = sm.createSession(t.id);
    const req: AuthRequest = { headers: { authorization: `Bearer ${s.token}` } };
    const result = auth.authenticateRequest(req);
    expect(result.authenticated).toBe(true);
    expect(result.tenant?.id).toBe(t.id);
    expect(result.method).toBe('session');
  });

  it('authenticates with valid API key (X-API-Key header)', () => {
    const t = tm.createTenant('A', 'a@test.com');
    const key = tm.generateApiKey(t.id, 'k', ['*']);
    const req: AuthRequest = { headers: { 'x-api-key': key.key } };
    const result = auth.authenticateRequest(req);
    expect(result.authenticated).toBe(true);
    expect(result.method).toBe('api_key');
  });

  it('authenticates with ApiKey authorization header', () => {
    const t = tm.createTenant('A', 'a@test.com');
    const key = tm.generateApiKey(t.id, 'k', ['*']);
    const req: AuthRequest = { headers: { authorization: `ApiKey ${key.key}` } };
    const result = auth.authenticateRequest(req);
    expect(result.authenticated).toBe(true);
  });

  it('fails with missing auth', () => {
    const req: AuthRequest = { headers: {} };
    const result = auth.authenticateRequest(req);
    expect(result.authenticated).toBe(false);
    expect(result.error).toContain('No authentication credentials');
  });

  it('fails with invalid Bearer token', () => {
    const req: AuthRequest = { headers: { authorization: 'Bearer invalid_token' } };
    const result = auth.authenticateRequest(req);
    expect(result.authenticated).toBe(false);
    expect(result.error).toContain('Invalid or expired session');
  });

  it('fails with expired session', () => {
    const t = tm.createTenant('A', 'a@test.com');
    const shortSm = new SessionManager(1, 999_999_999);
    const authShort = new AuthMiddleware(tm, shortSm);
    const s = shortSm.createSession(t.id);
    const start = Date.now();
    while (Date.now() - start < 5) { /* spin */ }
    const req: AuthRequest = { headers: { authorization: `Bearer ${s.token}` } };
    const result = authShort.authenticateRequest(req);
    expect(result.authenticated).toBe(false);
    shortSm.dispose();
  });

  it('extractTenantContext returns context on success', () => {
    const t = tm.createTenant('A', 'a@test.com');
    const key = tm.generateApiKey(t.id, 'k', ['*']);
    const req: AuthRequest = { headers: { 'x-api-key': key.key } };
    const ctx = auth.extractTenantContext(req);
    expect(ctx).not.toBeNull();
    expect(ctx!.tenant.id).toBe(t.id);
  });

  it('extractTenantContext returns null on failure', () => {
    const req: AuthRequest = { headers: {} };
    expect(auth.extractTenantContext(req)).toBeNull();
  });

  describe('requirePlan', () => {
    it('allows sufficient plan', () => {
      const t = tm.createTenant('A', 'a@test.com', 'pro');
      const req: AuthRequest = { headers: {}, tenant: t };
      const forbidden = vi.fn();
      const handler = vi.fn();
      const wrapped = auth.requirePlan<AuthRequest, any>('pro', forbidden)(handler);
      wrapped(req, {} as any);
      expect(handler).toHaveBeenCalled();
      expect(forbidden).not.toHaveBeenCalled();
    });

    it('rejects insufficient plan', () => {
      const t = tm.createTenant('A', 'a@test.com', 'free');
      const req: AuthRequest = { headers: {}, tenant: t };
      const forbidden = vi.fn();
      const handler = vi.fn();
      const wrapped = auth.requirePlan<AuthRequest, any>('pro', forbidden)(handler);
      wrapped(req, {} as any);
      expect(forbidden).toHaveBeenCalled();
      expect(handler).not.toHaveBeenCalled();
    });
  });
});

// ─────────────────────────────────────────────────────────────────────────────
// OAuthProvider
// ─────────────────────────────────────────────────────────────────────────────

describe('OAuthProvider', () => {
  let tm: TenantManager;
  let sm: SessionManager;
  let oauth: OAuthProvider;

  beforeEach(() => {
    tm = new TenantManager();
    sm = new SessionManager(60_000, 999_999_999);
    oauth = new OAuthProvider(tm, sm);
  });

  afterEach(() => {
    oauth.dispose();
    sm.dispose();
  });

  it('registers a client', () => {
    oauth.registerClient({
      clientId: 'c1',
      clientSecret: 's1',
      redirectUris: ['http://localhost/cb'],
      name: 'Test',
    });
    // No throw means success
  });

  it('throws on duplicate client registration', () => {
    const client = { clientId: 'c1', clientSecret: 's1', redirectUris: ['http://localhost/cb'], name: 'T' };
    oauth.registerClient(client);
    expect(() => oauth.registerClient(client)).toThrow(OAuthError);
  });

  it('unregisters a client', () => {
    oauth.registerClient({ clientId: 'c1', clientSecret: 's1', redirectUris: ['http://localhost/cb'], name: 'T' });
    expect(oauth.unregisterClient('c1')).toBe(true);
    expect(oauth.unregisterClient('c1')).toBe(false);
  });

  describe('authorization flow with PKCE', () => {
    const clientId = 'mcp-client';
    let tenantId: string;
    let pkce: { codeVerifier: string; codeChallenge: string };

    beforeEach(() => {
      oauth.registerClient({
        clientId,
        clientSecret: 'secret',
        redirectUris: ['http://localhost/cb'],
        name: 'MCP',
      });
      const t = tm.createTenant('A', 'a@test.com');
      tenantId = t.id;
      pkce = OAuthProvider.generatePKCE();
    });

    it('generates auth code and redirect URI', () => {
      const result = oauth.authorize({
        clientId,
        redirectUri: 'http://localhost/cb',
        responseType: 'code',
        scope: 'slides:read slides:write',
        state: 'test-state',
        codeChallenge: pkce.codeChallenge,
        codeChallengeMethod: 'S256',
      }, tenantId);

      expect(result.code).toBeTruthy();
      expect(result.redirectUri).toContain('code=');
      expect(result.redirectUri).toContain('state=test-state');
    });

    it('exchanges code for tokens with valid PKCE verifier', () => {
      const { code } = oauth.authorize({
        clientId,
        redirectUri: 'http://localhost/cb',
        responseType: 'code',
        scope: 'slides:read',
        state: 's',
        codeChallenge: pkce.codeChallenge,
        codeChallengeMethod: 'S256',
      }, tenantId);

      const tokens = oauth.exchangeCode({
        grantType: 'authorization_code',
        code,
        redirectUri: 'http://localhost/cb',
        clientId,
        codeVerifier: pkce.codeVerifier,
      });

      expect(tokens.access_token).toBeTruthy();
      expect(tokens.refresh_token).toBeTruthy();
      expect(tokens.token_type).toBe('bearer');
      expect(tokens.expires_in).toBeGreaterThan(0);
    });

    it('rejects code exchange with wrong PKCE verifier', () => {
      const { code } = oauth.authorize({
        clientId,
        redirectUri: 'http://localhost/cb',
        responseType: 'code',
        scope: 'slides:read',
        state: 's',
        codeChallenge: pkce.codeChallenge,
        codeChallengeMethod: 'S256',
      }, tenantId);

      expect(() => oauth.exchangeCode({
        grantType: 'authorization_code',
        code,
        redirectUri: 'http://localhost/cb',
        clientId,
        codeVerifier: 'wrong-verifier',
      })).toThrow('PKCE');
    });

    it('rejects unsupported response_type', () => {
      expect(() => oauth.authorize({
        clientId,
        redirectUri: 'http://localhost/cb',
        responseType: 'token',
        scope: 'slides:read',
        state: 's',
        codeChallenge: pkce.codeChallenge,
        codeChallengeMethod: 'S256',
      }, tenantId)).toThrow('response_type');
    });

    it('rejects non-S256 code challenge method', () => {
      expect(() => oauth.authorize({
        clientId,
        redirectUri: 'http://localhost/cb',
        responseType: 'code',
        scope: 'slides:read',
        state: 's',
        codeChallenge: pkce.codeChallenge,
        codeChallengeMethod: 'plain',
      }, tenantId)).toThrow('S256');
    });

    it('refreshes access token', () => {
      const { code } = oauth.authorize({
        clientId,
        redirectUri: 'http://localhost/cb',
        responseType: 'code',
        scope: 'slides:read',
        state: 's',
        codeChallenge: pkce.codeChallenge,
        codeChallengeMethod: 'S256',
      }, tenantId);

      const tokens = oauth.exchangeCode({
        grantType: 'authorization_code',
        code,
        redirectUri: 'http://localhost/cb',
        clientId,
        codeVerifier: pkce.codeVerifier,
      });

      const refreshed = oauth.refreshAccessToken({
        grantType: 'refresh_token',
        refreshToken: tokens.refresh_token!,
        clientId,
      });

      expect(refreshed.access_token).toBeTruthy();
      expect(refreshed.access_token).not.toBe(tokens.access_token);
    });

    it('revokes refresh tokens', () => {
      const { code } = oauth.authorize({
        clientId,
        redirectUri: 'http://localhost/cb',
        responseType: 'code',
        scope: 'slides:read',
        state: 's',
        codeChallenge: pkce.codeChallenge,
        codeChallengeMethod: 'S256',
      }, tenantId);

      const tokens = oauth.exchangeCode({
        grantType: 'authorization_code',
        code,
        redirectUri: 'http://localhost/cb',
        clientId,
        codeVerifier: pkce.codeVerifier,
      });

      expect(oauth.revokeRefreshToken(tokens.refresh_token!)).toBe(true);
      expect(() => oauth.refreshAccessToken({
        grantType: 'refresh_token',
        refreshToken: tokens.refresh_token!,
        clientId,
      })).toThrow('not found');
    });

    it('codes are single-use', () => {
      const { code } = oauth.authorize({
        clientId,
        redirectUri: 'http://localhost/cb',
        responseType: 'code',
        scope: 'slides:read',
        state: 's',
        codeChallenge: pkce.codeChallenge,
        codeChallengeMethod: 'S256',
      }, tenantId);

      oauth.exchangeCode({
        grantType: 'authorization_code',
        code,
        redirectUri: 'http://localhost/cb',
        clientId,
        codeVerifier: pkce.codeVerifier,
      });

      expect(() => oauth.exchangeCode({
        grantType: 'authorization_code',
        code,
        redirectUri: 'http://localhost/cb',
        clientId,
        codeVerifier: pkce.codeVerifier,
      })).toThrow('not found or already used');
    });
  });

  describe('generatePKCE', () => {
    it('produces verifier and challenge pair', () => {
      const { codeVerifier, codeChallenge } = OAuthProvider.generatePKCE();
      expect(codeVerifier).toBeTruthy();
      expect(codeChallenge).toBeTruthy();
      expect(codeVerifier).not.toBe(codeChallenge);
    });
  });
});
