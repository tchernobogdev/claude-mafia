/**
 * Retry Utilities with Exponential Backoff
 *
 * Provides robust retry logic for handling transient failures in:
 * - API calls (Anthropic, Kimi, OpenAI)
 * - Database operations
 * - Network requests
 *
 * Features:
 * - Exponential backoff with jitter
 * - Configurable max attempts
 * - Transient error detection
 * - Circuit breaker integration
 */

// Error types that should trigger retry
const TRANSIENT_ERROR_CODES = new Set([
  'ECONNRESET',
  'ETIMEDOUT',
  'ECONNREFUSED',
  'EPIPE',
  'ENOTFOUND',
  'ENETUNREACH',
  'EAI_AGAIN',
]);

const TRANSIENT_HTTP_CODES = new Set([
  408, // Request Timeout
  429, // Too Many Requests (rate limit)
  500, // Internal Server Error
  502, // Bad Gateway
  503, // Service Unavailable
  504, // Gateway Timeout
  520, // Cloudflare errors
  521,
  522,
  523,
  524,
]);

export interface RetryOptions {
  /** Maximum number of retry attempts (default: 3) */
  maxAttempts?: number;
  /** Initial delay in ms (default: 1000) */
  initialDelayMs?: number;
  /** Maximum delay in ms (default: 30000) */
  maxDelayMs?: number;
  /** Backoff multiplier (default: 2) */
  backoffMultiplier?: number;
  /** Add jitter to delays to prevent thundering herd (default: true) */
  jitter?: boolean;
  /** Custom function to determine if error is transient */
  isTransient?: (error: unknown) => boolean;
  /** Callback when retry occurs */
  onRetry?: (error: unknown, attempt: number, delayMs: number) => void;
  /** Abort signal to cancel retries */
  signal?: AbortSignal;
}

const DEFAULT_OPTIONS: Required<Omit<RetryOptions, 'isTransient' | 'onRetry' | 'signal'>> = {
  maxAttempts: 3,
  initialDelayMs: 1000,
  maxDelayMs: 30000,
  backoffMultiplier: 2,
  jitter: true,
};

/**
 * Check if an error is transient and should be retried
 */
export function isTransientError(error: unknown): boolean {
  if (!error) return false;

  // Check error code (Node.js network errors)
  const errWithCode = error as { code?: string };
  if (errWithCode.code && TRANSIENT_ERROR_CODES.has(errWithCode.code)) {
    return true;
  }

  // Check HTTP status code
  const errWithStatus = error as { status?: number; statusCode?: number };
  const httpCode = errWithStatus.status || errWithStatus.statusCode;
  if (httpCode && TRANSIENT_HTTP_CODES.has(httpCode)) {
    return true;
  }

  // Check error message for common transient patterns
  const errWithMessage = error as { message?: string };
  if (errWithMessage.message) {
    const msg = errWithMessage.message.toLowerCase();
    if (
      msg.includes('timeout') ||
      msg.includes('econnreset') ||
      msg.includes('socket hang up') ||
      msg.includes('network') ||
      msg.includes('rate limit') ||
      msg.includes('overloaded') ||
      msg.includes('temporarily unavailable') ||
      msg.includes('too many requests') ||
      msg.includes('service unavailable') ||
      msg.includes('bad gateway')
    ) {
      return true;
    }
  }

  // Anthropic-specific error handling
  const errWithType = error as { error?: { type?: string } };
  if (errWithType.error?.type === 'overloaded_error') {
    return true;
  }

  return false;
}

/**
 * Calculate delay with optional jitter
 */
function calculateDelay(
  attempt: number,
  initialDelayMs: number,
  maxDelayMs: number,
  backoffMultiplier: number,
  jitter: boolean
): number {
  // Exponential backoff: initialDelay * (multiplier ^ attempt)
  let delay = initialDelayMs * Math.pow(backoffMultiplier, attempt - 1);

  // Cap at max delay
  delay = Math.min(delay, maxDelayMs);

  // Add jitter (±25% of delay)
  if (jitter) {
    const jitterRange = delay * 0.25;
    delay = delay - jitterRange + Math.random() * jitterRange * 2;
  }

  return Math.round(delay);
}

/**
 * Sleep for specified milliseconds, respecting abort signal
 */
async function sleep(ms: number, signal?: AbortSignal): Promise<void> {
  return new Promise((resolve, reject) => {
    if (signal?.aborted) {
      reject(new Error('Aborted'));
      return;
    }

    const timeout = setTimeout(resolve, ms);

    signal?.addEventListener('abort', () => {
      clearTimeout(timeout);
      reject(new Error('Aborted'));
    }, { once: true });
  });
}

/**
 * Execute a function with retry logic
 *
 * @example
 * ```typescript
 * const result = await withRetry(
 *   () => anthropic.messages.create({ ... }),
 *   {
 *     maxAttempts: 3,
 *     onRetry: (err, attempt, delay) => {
 *       console.log(`Retry ${attempt} after ${delay}ms: ${err.message}`);
 *     }
 *   }
 * );
 * ```
 */
export async function withRetry<T>(
  fn: () => Promise<T>,
  options: RetryOptions = {}
): Promise<T> {
  const opts = { ...DEFAULT_OPTIONS, ...options };
  const checkTransient = opts.isTransient || isTransientError;

  let lastError: unknown;

  for (let attempt = 1; attempt <= opts.maxAttempts; attempt++) {
    try {
      // Check abort signal before attempting
      if (opts.signal?.aborted) {
        throw new Error('Operation aborted');
      }

      return await fn();
    } catch (error) {
      lastError = error;

      // Don't retry if aborted
      if (opts.signal?.aborted) {
        throw error;
      }

      // Don't retry on final attempt
      if (attempt >= opts.maxAttempts) {
        throw error;
      }

      // Don't retry if not transient
      if (!checkTransient(error)) {
        throw error;
      }

      // Calculate delay
      const delay = calculateDelay(
        attempt,
        opts.initialDelayMs,
        opts.maxDelayMs,
        opts.backoffMultiplier,
        opts.jitter
      );

      // Notify callback
      if (opts.onRetry) {
        opts.onRetry(error, attempt, delay);
      }

      // Wait before retrying
      try {
        await sleep(delay, opts.signal);
      } catch {
        // Aborted during sleep
        throw lastError;
      }
    }
  }

  // Should never reach here, but TypeScript wants a return
  throw lastError;
}

// ==================== CIRCUIT BREAKER ====================

export interface CircuitBreakerOptions {
  /** Number of failures before opening circuit (default: 5) */
  failureThreshold?: number;
  /** Time in ms to keep circuit open before trying again (default: 30000) */
  resetTimeoutMs?: number;
  /** Time window in ms to count failures (default: 60000) */
  failureWindowMs?: number;
  /** Optional name for logging */
  name?: string;
}

type CircuitState = 'closed' | 'open' | 'half-open';

interface FailureRecord {
  timestamp: number;
  error: string;
}

export class CircuitBreaker {
  private state: CircuitState = 'closed';
  private failures: FailureRecord[] = [];
  private lastFailureTime = 0;
  private options: Required<CircuitBreakerOptions>;
  private halfOpenAttemptInProgress = false; // Guard against concurrent half-open attempts

  constructor(options: CircuitBreakerOptions = {}) {
    this.options = {
      failureThreshold: options.failureThreshold ?? 5,
      resetTimeoutMs: options.resetTimeoutMs ?? 30000,
      failureWindowMs: options.failureWindowMs ?? 60000,
      name: options.name ?? 'circuit',
    };
  }

  /**
   * Execute a function through the circuit breaker
   */
  async execute<T>(fn: () => Promise<T>): Promise<T> {
    // Check if circuit should transition from open to half-open
    if (this.state === 'open') {
      const timeSinceLastFailure = Date.now() - this.lastFailureTime;
      if (timeSinceLastFailure >= this.options.resetTimeoutMs) {
        // Only allow one request to attempt half-open transition
        if (this.halfOpenAttemptInProgress) {
          throw new Error(`Circuit breaker is testing recovery. Try again shortly.`);
        }
        this.halfOpenAttemptInProgress = true;
        this.state = 'half-open';
        console.log(`[CircuitBreaker:${this.options.name}] Transitioning to half-open`);
      } else {
        throw new Error(`Circuit breaker is open. Try again in ${Math.round((this.options.resetTimeoutMs - timeSinceLastFailure) / 1000)}s`);
      }
    }

    const wasHalfOpen = this.state === 'half-open';

    try {
      const result = await fn();

      // Success - close circuit if it was half-open
      if (wasHalfOpen) {
        this.state = 'closed';
        this.failures = [];
        this.halfOpenAttemptInProgress = false;
        console.log(`[CircuitBreaker:${this.options.name}] Circuit closed after successful request`);
      }

      return result;
    } catch (error) {
      this.recordFailure(error);

      // If half-open, immediately open again
      if (wasHalfOpen) {
        this.state = 'open';
        this.halfOpenAttemptInProgress = false;
        console.log(`[CircuitBreaker:${this.options.name}] Circuit re-opened after half-open failure`);
      }

      throw error;
    }
  }

  private recordFailure(error: unknown): void {
    const now = Date.now();
    this.lastFailureTime = now;

    // Add failure record
    const errorMsg = error instanceof Error ? error.message : String(error);
    this.failures.push({ timestamp: now, error: errorMsg.slice(0, 100) });

    // Clean up old failures outside the window
    const windowStart = now - this.options.failureWindowMs;
    this.failures = this.failures.filter(f => f.timestamp >= windowStart);

    // Check if we should open the circuit
    if (this.state === 'closed' && this.failures.length >= this.options.failureThreshold) {
      this.state = 'open';
      console.log(`[CircuitBreaker:${this.options.name}] Circuit OPENED after ${this.failures.length} failures in ${this.options.failureWindowMs}ms`);
    }
  }

  /**
   * Get current circuit state
   */
  getState(): CircuitState {
    return this.state;
  }

  /**
   * Get failure count in current window
   */
  getFailureCount(): number {
    const now = Date.now();
    const windowStart = now - this.options.failureWindowMs;
    return this.failures.filter(f => f.timestamp >= windowStart).length;
  }

  /**
   * Manually reset the circuit breaker
   */
  reset(): void {
    this.state = 'closed';
    this.failures = [];
    this.lastFailureTime = 0;
    console.log(`[CircuitBreaker:${this.options.name}] Circuit manually reset`);
  }
}

// ==================== PROVIDER-SPECIFIC CIRCUIT BREAKERS ====================

// Create circuit breakers for each provider
const circuitBreakers = new Map<string, CircuitBreaker>();

export function getCircuitBreaker(providerId: string): CircuitBreaker {
  let breaker = circuitBreakers.get(providerId);
  if (!breaker) {
    breaker = new CircuitBreaker({
      name: providerId,
      failureThreshold: 5,
      resetTimeoutMs: 30000,
      failureWindowMs: 60000,
    });
    circuitBreakers.set(providerId, breaker);
  }
  return breaker;
}

/**
 * Execute an API call with retry logic and circuit breaker
 */
export async function withRetryAndCircuitBreaker<T>(
  providerId: string,
  fn: () => Promise<T>,
  options: RetryOptions = {}
): Promise<T> {
  const breaker = getCircuitBreaker(providerId);

  return breaker.execute(() =>
    withRetry(fn, {
      ...options,
      onRetry: (error, attempt, delay) => {
        console.log(`[${providerId}] Retry ${attempt} after ${delay}ms: ${error instanceof Error ? error.message : String(error)}`);
        options.onRetry?.(error, attempt, delay);
      },
    })
  );
}
