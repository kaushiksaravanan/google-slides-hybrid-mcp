/**
 * @module security/secrets-manager
 * @description Encrypt secrets at rest, derive keys, hash API keys, and generate tokens.
 *
 * Uses Node.js built-in `crypto` module exclusively — no external crypto deps.
 *
 * Algorithms:
 * - **Encryption**: AES-256-GCM with random 12-byte IV and 16-byte auth tag.
 * - **Key derivation**: scrypt with N=2^15, r=8, p=1 (OWASP recommended).
 * - **API key hashing**: SHA-256 with per-key salt (constant-time comparison).
 * - **Token generation**: crypto.randomBytes.
 */

import crypto from 'node:crypto';
import { createLogger } from '../shared/logger.js';

const log = createLogger('security.secrets-manager');

// ─────────────────────────────────────────────────────────────────────────────
// Types
// ─────────────────────────────────────────────────────────────────────────────

/** Encrypted payload containing everything needed for decryption. */
export interface EncryptedPayload {
  /** Base64-encoded ciphertext. */
  ciphertext: string;
  /** Base64-encoded 12-byte initialisation vector. */
  iv: string;
  /** Base64-encoded 16-byte GCM authentication tag. */
  tag: string;
}

// ─────────────────────────────────────────────────────────────────────────────
// Constants
// ─────────────────────────────────────────────────────────────────────────────

/** AES-256-GCM parameters. */
const AES_ALGORITHM = 'aes-256-gcm' as const;
const IV_LENGTH = 12; // NIST-recommended for GCM
const AUTH_TAG_LENGTH = 16;
const KEY_LENGTH = 32; // 256 bits

/** Scrypt parameters — OWASP recommended for interactive login. */
const SCRYPT_N = 2 ** 15; // CPU/memory cost
const SCRYPT_R = 8; // block size
const SCRYPT_P = 1; // parallelisation
const SCRYPT_SALT_LENGTH = 32;
const SCRYPT_MAXMEM = 128 * SCRYPT_N * SCRYPT_R * 2; // sufficient memory

/** API key hash parameters. */
const API_KEY_HASH_ALGO = 'sha256';
const API_KEY_SALT_LENGTH = 32;

/** Default secure token length in bytes. */
const DEFAULT_TOKEN_BYTES = 32;

/** Default number of characters to show in masked secrets. */
const DEFAULT_VISIBLE_CHARS = 4;

// ─────────────────────────────────────────────────────────────────────────────
// SecretsManager
// ─────────────────────────────────────────────────────────────────────────────

/**
 * Manages encryption, decryption, key derivation, and API key hashing
 * for the SaaS platform.
 *
 * The master encryption key is derived from:
 * 1. The `ENCRYPTION_KEY` environment variable (preferred), OR
 * 2. An auto-generated key persisted in the instance for the runtime lifetime.
 *
 * @example
 * ```ts
 * const secrets = new SecretsManager();
 * const key = secrets.getMasterKey();
 * const encrypted = secrets.encrypt('my-secret', key);
 * const decrypted = secrets.decrypt(encrypted, key);
 * ```
 */
export class SecretsManager {
  /** Cached master key (derived lazily on first access). */
  private masterKey: Buffer | null = null;

  /** Salt used when deriving master key from env var. */
  private masterSalt: Buffer;

  constructor() {
    // Derive a deterministic salt from the master key so encrypted data
    // is recoverable across process restarts (same ENCRYPTION_KEY → same salt).
    const envKey = process.env['ENCRYPTION_KEY'];
    if (envKey && envKey.length > 0) {
      this.masterSalt = crypto
        .createHash('sha256')
        .update(envKey)
        .update('salt-derivation')
        .digest();
    } else {
      // No master key configured — ephemeral salt is acceptable since
      // an ephemeral master key will be generated anyway.
      this.masterSalt = crypto.randomBytes(SCRYPT_SALT_LENGTH);
    }

    log.info('SecretsManager initialised');
  }

  // ─────────────────────────────────────────────────────────────────────────
  // Master Key
  // ─────────────────────────────────────────────────────────────────────────

  /**
   * Get (or derive) the master encryption key.
   *
   * - If `ENCRYPTION_KEY` env var is set, derives a 256-bit key via scrypt.
   * - Otherwise, generates a random 256-bit key for the current process.
   *
   * @returns A 32-byte Buffer suitable for AES-256.
   */
  public getMasterKey(): Buffer {
    if (this.masterKey) {
      return this.masterKey;
    }

    const envKey = process.env['ENCRYPTION_KEY'];

    if (envKey && envKey.length > 0) {
      log.info('Deriving master key from ENCRYPTION_KEY environment variable');
      this.masterKey = this.deriveKey(envKey, this.masterSalt);
    } else {
      log.warn(
        'ENCRYPTION_KEY not set — generating ephemeral master key. ' +
        'Encrypted data will NOT survive process restarts.',
      );
      this.masterKey = crypto.randomBytes(KEY_LENGTH);
    }

    return this.masterKey;
  }

  // ─────────────────────────────────────────────────────────────────────────
  // Encryption / Decryption
  // ─────────────────────────────────────────────────────────────────────────

  /**
   * Encrypt plaintext using AES-256-GCM.
   *
   * @param plaintext - The string to encrypt.
   * @param key       - A 32-byte encryption key.
   * @returns An {@link EncryptedPayload} containing ciphertext, IV, and auth tag.
   */
  public encrypt(plaintext: string, key: Buffer): EncryptedPayload {
    if (key.length !== KEY_LENGTH) {
      throw new Error(`Encryption key must be ${KEY_LENGTH} bytes, got ${key.length}`);
    }

    const iv = crypto.randomBytes(IV_LENGTH);
    const cipher = crypto.createCipheriv(AES_ALGORITHM, key, iv, {
      authTagLength: AUTH_TAG_LENGTH,
    });

    const encrypted = Buffer.concat([
      cipher.update(plaintext, 'utf8'),
      cipher.final(),
    ]);

    const tag = cipher.getAuthTag();

    return {
      ciphertext: encrypted.toString('base64'),
      iv: iv.toString('base64'),
      tag: tag.toString('base64'),
    };
  }

  /**
   * Decrypt an AES-256-GCM encrypted payload.
   *
   * @param encrypted - The {@link EncryptedPayload} to decrypt.
   * @param key       - The 32-byte encryption key used during encryption.
   * @returns The original plaintext string.
   * @throws {Error} If decryption fails (wrong key, tampered data, etc.).
   */
  public decrypt(encrypted: EncryptedPayload, key: Buffer): string {
    if (key.length !== KEY_LENGTH) {
      throw new Error(`Encryption key must be ${KEY_LENGTH} bytes, got ${key.length}`);
    }

    const iv = Buffer.from(encrypted.iv, 'base64');
    const tag = Buffer.from(encrypted.tag, 'base64');
    const ciphertext = Buffer.from(encrypted.ciphertext, 'base64');

    if (iv.length !== IV_LENGTH) {
      throw new Error(`Invalid IV length: expected ${IV_LENGTH}, got ${iv.length}`);
    }

    if (tag.length !== AUTH_TAG_LENGTH) {
      throw new Error(`Invalid auth tag length: expected ${AUTH_TAG_LENGTH}, got ${tag.length}`);
    }

    const decipher = crypto.createDecipheriv(AES_ALGORITHM, key, iv, {
      authTagLength: AUTH_TAG_LENGTH,
    });
    decipher.setAuthTag(tag);

    try {
      const decrypted = Buffer.concat([
        decipher.update(ciphertext),
        decipher.final(),
      ]);
      return decrypted.toString('utf8');
    } catch (err) {
      throw new Error(
        `Decryption failed — the key may be wrong or the data may be tampered. ` +
        `Cause: ${err instanceof Error ? err.message : String(err)}`,
      );
    }
  }

  // ─────────────────────────────────────────────────────────────────────────
  // Key Derivation
  // ─────────────────────────────────────────────────────────────────────────

  /**
   * Derive a 256-bit encryption key from a master password using scrypt.
   *
   * @param masterPassword - The password/passphrase to derive from.
   * @param salt           - A random salt (at least 16 bytes recommended).
   * @returns A 32-byte Buffer (256-bit key).
   */
  public deriveKey(masterPassword: string, salt: Buffer): Buffer {
    if (salt.length < 16) {
      throw new Error('Salt must be at least 16 bytes for adequate security.');
    }

    return crypto.scryptSync(masterPassword, salt, KEY_LENGTH, {
      N: SCRYPT_N,
      r: SCRYPT_R,
      p: SCRYPT_P,
      maxmem: SCRYPT_MAXMEM,
    });
  }

  /**
   * Async version of key derivation (non-blocking for server use).
   *
   * @param masterPassword - The password/passphrase to derive from.
   * @param salt           - A random salt (at least 16 bytes recommended).
   * @returns A Promise resolving to a 32-byte Buffer.
   */
  public deriveKeyAsync(masterPassword: string, salt: Buffer): Promise<Buffer> {
    if (salt.length < 16) {
      return Promise.reject(new Error('Salt must be at least 16 bytes for adequate security.'));
    }

    return new Promise((resolve, reject) => {
      crypto.scrypt(
        masterPassword,
        salt,
        KEY_LENGTH,
        { N: SCRYPT_N, r: SCRYPT_R, p: SCRYPT_P, maxmem: SCRYPT_MAXMEM },
        (err, derivedKey) => {
          if (err) reject(err);
          else resolve(derivedKey);
        },
      );
    });
  }

  // ─────────────────────────────────────────────────────────────────────────
  // API Key Hashing
  // ─────────────────────────────────────────────────────────────────────────

  /**
   * Hash an API key for safe storage. The hash includes a random salt
   * and is formatted as `salt:hash` (both hex-encoded).
   *
   * @param apiKey - The raw API key string.
   * @returns A string in the format `hex(salt):hex(hash)`.
   */
  public hashApiKey(apiKey: string): string {
    const salt = crypto.randomBytes(API_KEY_SALT_LENGTH);
    const hash = crypto
      .createHmac(API_KEY_HASH_ALGO, salt)
      .update(apiKey)
      .digest();

    return `${salt.toString('hex')}:${hash.toString('hex')}`;
  }

  /**
   * Verify an API key against a stored hash using constant-time comparison.
   *
   * @param apiKey     - The raw API key to verify.
   * @param storedHash - The stored hash string (from {@link hashApiKey}).
   * @returns `true` if the key matches the hash.
   */
  public verifyApiKey(apiKey: string, storedHash: string): boolean {
    const separatorIndex = storedHash.indexOf(':');
    if (separatorIndex === -1) {
      log.warn('Invalid stored hash format — missing separator');
      return false;
    }

    const saltHex = storedHash.slice(0, separatorIndex);
    const expectedHashHex = storedHash.slice(separatorIndex + 1);

    let salt: Buffer;
    let expectedHash: Buffer;

    try {
      salt = Buffer.from(saltHex, 'hex');
      expectedHash = Buffer.from(expectedHashHex, 'hex');
    } catch {
      log.warn('Invalid stored hash format — malformed hex');
      return false;
    }

    const actualHash = crypto
      .createHmac(API_KEY_HASH_ALGO, salt)
      .update(apiKey)
      .digest();

    // Constant-time comparison to prevent timing attacks
    if (actualHash.length !== expectedHash.length) {
      return false;
    }

    return crypto.timingSafeEqual(actualHash, expectedHash);
  }

  // ─────────────────────────────────────────────────────────────────────────
  // Token Generation
  // ─────────────────────────────────────────────────────────────────────────

  /**
   * Generate a cryptographically secure random hex token.
   *
   * @param bytes - Number of random bytes (default 32 = 64 hex chars).
   * @returns A hex-encoded random string.
   */
  public generateSecureToken(bytes: number = DEFAULT_TOKEN_BYTES): string {
    if (bytes < 16) {
      throw new Error('Token must be at least 16 bytes for adequate security.');
    }
    return crypto.randomBytes(bytes).toString('hex');
  }

  // ─────────────────────────────────────────────────────────────────────────
  // Secret Masking
  // ─────────────────────────────────────────────────────────────────────────

  /**
   * Mask a secret string for display, showing only the last N characters.
   *
   * @param secret       - The secret to mask.
   * @param visibleChars - Number of trailing characters to reveal (default 4).
   * @returns The masked string (e.g., `"****abcd"`).
   */
  public maskSecret(secret: string, visibleChars: number = DEFAULT_VISIBLE_CHARS): string {
    if (secret.length <= visibleChars) {
      return '*'.repeat(secret.length);
    }

    const masked = '*'.repeat(secret.length - visibleChars);
    const visible = secret.slice(-visibleChars);
    return `${masked}${visible}`;
  }

  // ─────────────────────────────────────────────────────────────────────────
  // Utility
  // ─────────────────────────────────────────────────────────────────────────

  /**
   * Generate a random salt of the specified length.
   *
   * @param length - Salt length in bytes (default 32).
   * @returns A random Buffer.
   */
  public generateSalt(length: number = SCRYPT_SALT_LENGTH): Buffer {
    return crypto.randomBytes(length);
  }

  /**
   * Securely wipe a Buffer by overwriting with zeros.
   * Call this when a key is no longer needed.
   *
   * @param buffer - The Buffer to wipe.
   */
  public wipeBuffer(buffer: Buffer): void {
    buffer.fill(0);
  }
}
