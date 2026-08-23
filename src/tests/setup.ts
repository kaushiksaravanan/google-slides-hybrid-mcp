/**
 * Global test setup — mock winston to avoid colorize errors in test environment.
 */
import { vi } from 'vitest';

// Mock winston to avoid colorize errors from the colorize format
vi.mock('winston', () => {
  const noop = vi.fn((info: unknown) => info);
  const mockFormat = { transform: noop };

  // winston.format is both a namespace and a function
  const format = Object.assign(
    // winston.format(fn) - used for custom formats
    vi.fn().mockReturnValue(vi.fn().mockReturnValue(mockFormat)),
    {
      timestamp: vi.fn().mockReturnValue(mockFormat),
      errors: vi.fn().mockReturnValue(mockFormat),
      json: vi.fn().mockReturnValue(mockFormat),
      colorize: vi.fn().mockReturnValue(mockFormat),
      printf: vi.fn().mockReturnValue(mockFormat),
      combine: vi.fn().mockReturnValue(mockFormat),
    },
  );

  const mockLogger = {
    info: vi.fn(),
    warn: vi.fn(),
    error: vi.fn(),
    debug: vi.fn(),
    child: vi.fn().mockReturnValue({
      info: vi.fn(),
      warn: vi.fn(),
      error: vi.fn(),
      debug: vi.fn(),
    }),
  };

  // Make child return an object with a child method too (for chaining)
  const childLogger = {
    info: vi.fn(),
    warn: vi.fn(),
    error: vi.fn(),
    debug: vi.fn(),
    child: vi.fn(),
  };
  childLogger.child.mockReturnValue(childLogger);
  mockLogger.child.mockReturnValue(childLogger);

  return {
    default: {
      createLogger: vi.fn().mockReturnValue(mockLogger),
      format,
      transports: {
        Console: vi.fn(),
      },
    },
  };
});
