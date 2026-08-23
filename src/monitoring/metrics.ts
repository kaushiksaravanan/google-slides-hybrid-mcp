/**
 * @module monitoring/metrics
 * @description Prometheus-compatible metrics collector with zero external dependencies.
 *
 * Provides Counter, Gauge, Histogram, and Summary metric types with full
 * label support. Renders to Prometheus text exposition format (v0.0.4).
 *
 * Pre-registers all Google Slides MCP metrics used across the server.
 */

// ─────────────────────────────────────────────────────────────────────────────
// Types
// ─────────────────────────────────────────────────────────────────────────────

/** Valid Prometheus metric types. */
type MetricType = 'counter' | 'gauge' | 'histogram' | 'summary';

/** Definition shared by all metric kinds. */
interface MetricBase {
  name: string;
  help: string;
  type: MetricType;
  labelNames: string[];
}

/** Serialise a label set to a deterministic key for internal map lookups. */
function labelKey(labels: Record<string, string>): string {
  const entries = Object.entries(labels).sort(([a], [b]) => a.localeCompare(b));
  if (entries.length === 0) return '';
  return entries.map(([k, v]) => `${k}="${v}"`).join(',');
}

/** Format a label key as Prometheus {label="value",...} notation. */
function labelBrackets(key: string): string {
  return key ? `{${key}}` : '';
}

/** Format a number to a string suitable for Prometheus exposition. */
function formatValue(value: number): string {
  if (Number.isNaN(value)) return 'NaN';
  if (value === Infinity) return '+Inf';
  if (value === -Infinity) return '-Inf';
  // Use full precision for integers, 6 decimal places otherwise
  return Number.isInteger(value) ? value.toString() : value.toFixed(6);
}

// ─────────────────────────────────────────────────────────────────────────────
// Counter
// ─────────────────────────────────────────────────────────────────────────────

/**
 * A monotonically increasing counter metric.
 * Counters can only increase or be reset to zero.
 */
export class Counter implements MetricBase {
  public readonly type = 'counter' as const;
  private readonly values = new Map<string, number>();

  constructor(
    public readonly name: string,
    public readonly help: string,
    public readonly labelNames: string[] = [],
  ) {}

  /** Increment the counter by a positive delta (default 1). */
  inc(labels: Record<string, string> = {}, delta = 1): void {
    if (delta < 0) throw new Error(`Counter ${this.name}: increment delta must be non-negative`);
    const key = labelKey(labels);
    this.values.set(key, (this.values.get(key) ?? 0) + delta);
  }

  /** Get the current value for a label set. */
  get(labels: Record<string, string> = {}): number {
    return this.values.get(labelKey(labels)) ?? 0;
  }

  /** Reset all values. */
  reset(): void {
    this.values.clear();
  }

  /** Render to Prometheus text lines. */
  render(): string[] {
    const lines: string[] = [
      `# HELP ${this.name} ${this.help}`,
      `# TYPE ${this.name} counter`,
    ];
    if (this.values.size === 0) {
      // Emit a zero-value line when no labels to ensure metric is always present
      if (this.labelNames.length === 0) {
        lines.push(`${this.name} 0`);
      }
    } else {
      for (const [key, value] of this.values.entries()) {
        lines.push(`${this.name}${labelBrackets(key)} ${formatValue(value)}`);
      }
    }
    return lines;
  }
}

// ─────────────────────────────────────────────────────────────────────────────
// Gauge
// ─────────────────────────────────────────────────────────────────────────────

/**
 * A gauge metric that can go up and down.
 */
export class Gauge implements MetricBase {
  public readonly type = 'gauge' as const;
  private readonly values = new Map<string, number>();

  constructor(
    public readonly name: string,
    public readonly help: string,
    public readonly labelNames: string[] = [],
  ) {}

  /** Set the gauge to an absolute value. */
  set(value: number, labels: Record<string, string> = {}): void {
    this.values.set(labelKey(labels), value);
  }

  /** Increment the gauge (default +1). */
  inc(labels: Record<string, string> = {}, delta = 1): void {
    const key = labelKey(labels);
    this.values.set(key, (this.values.get(key) ?? 0) + delta);
  }

  /** Decrement the gauge (default -1). */
  dec(labels: Record<string, string> = {}, delta = 1): void {
    const key = labelKey(labels);
    this.values.set(key, (this.values.get(key) ?? 0) - delta);
  }

  /** Get the current value for a label set. */
  get(labels: Record<string, string> = {}): number {
    return this.values.get(labelKey(labels)) ?? 0;
  }

  /** Reset all values. */
  reset(): void {
    this.values.clear();
  }

  /** Render to Prometheus text lines. */
  render(): string[] {
    const lines: string[] = [
      `# HELP ${this.name} ${this.help}`,
      `# TYPE ${this.name} gauge`,
    ];
    if (this.values.size === 0) {
      if (this.labelNames.length === 0) {
        lines.push(`${this.name} 0`);
      }
    } else {
      for (const [key, value] of this.values.entries()) {
        lines.push(`${this.name}${labelBrackets(key)} ${formatValue(value)}`);
      }
    }
    return lines;
  }
}

// ─────────────────────────────────────────────────────────────────────────────
// Histogram
// ─────────────────────────────────────────────────────────────────────────────

/** Internal state for one label combination of a histogram. */
interface HistogramBucketState {
  /** Cumulative counts for each bucket boundary. */
  buckets: Map<number, number>;
  sum: number;
  count: number;
}

/**
 * A histogram metric that tracks the distribution of observed values
 * across configurable buckets.
 */
export class Histogram implements MetricBase {
  public readonly type = 'histogram' as const;
  private readonly states = new Map<string, HistogramBucketState>();

  constructor(
    public readonly name: string,
    public readonly help: string,
    public readonly buckets: number[],
    public readonly labelNames: string[] = [],
  ) {
    // Ensure buckets are sorted ascending
    this.buckets = [...buckets].sort((a, b) => a - b);
  }

  /** Record an observation. */
  observe(value: number, labels: Record<string, string> = {}): void {
    const key = labelKey(labels);
    let state = this.states.get(key);
    if (!state) {
      state = {
        buckets: new Map(this.buckets.map((b) => [b, 0])),
        sum: 0,
        count: 0,
      };
      this.states.set(key, state);
    }

    state.sum += value;
    state.count += 1;

    for (const boundary of this.buckets) {
      if (value <= boundary) {
        state.buckets.set(boundary, (state.buckets.get(boundary) ?? 0) + 1);
      }
    }
  }

  /** Get a snapshot of the histogram for a label set. */
  get(labels: Record<string, string> = {}): {
    buckets: Map<number, number>;
    sum: number;
    count: number;
  } | null {
    const state = this.states.get(labelKey(labels));
    if (!state) return null;
    return {
      buckets: new Map(state.buckets),
      sum: state.sum,
      count: state.count,
    };
  }

  /** Reset all values. */
  reset(): void {
    this.states.clear();
  }

  /** Render to Prometheus text lines. */
  render(): string[] {
    const lines: string[] = [
      `# HELP ${this.name} ${this.help}`,
      `# TYPE ${this.name} histogram`,
    ];

    for (const [key, state] of this.states.entries()) {
      const labelSuffix = key ? `,${key}` : '';
      const labelPrefix = key ? `{${key}}` : '';

      // Render cumulative bucket counts
      let cumulativeCount = 0;
      for (const boundary of this.buckets) {
        cumulativeCount += state.buckets.get(boundary) ?? 0;
        lines.push(
          `${this.name}_bucket{le="${formatValue(boundary)}"${labelSuffix}} ${cumulativeCount}`,
        );
      }
      // +Inf bucket always equals total count
      lines.push(
        `${this.name}_bucket{le="+Inf"${labelSuffix}} ${state.count}`,
      );
      lines.push(`${this.name}_sum${labelPrefix} ${formatValue(state.sum)}`);
      lines.push(`${this.name}_count${labelPrefix} ${state.count}`);
    }

    return lines;
  }
}

// ─────────────────────────────────────────────────────────────────────────────
// Summary
// ─────────────────────────────────────────────────────────────────────────────

/** Internal state for one label combination of a summary. */
interface SummaryState {
  /** All observed values (kept in memory for quantile computation). */
  values: number[];
  sum: number;
  count: number;
}

/**
 * A summary metric that computes configurable quantiles over a sliding
 * window of observations.
 *
 * Note: This implementation keeps all observations in memory. For
 * high-throughput production use consider a digest algorithm. For the
 * expected cardinality of an MCP server this is perfectly adequate.
 */
export class Summary implements MetricBase {
  public readonly type = 'summary' as const;
  private readonly states = new Map<string, SummaryState>();
  /** Maximum observations to keep per label set (sliding window). */
  private readonly maxObservations: number;

  constructor(
    public readonly name: string,
    public readonly help: string,
    public readonly quantiles: number[],
    public readonly labelNames: string[] = [],
    maxObservations = 10_000,
  ) {
    this.maxObservations = maxObservations;
  }

  /** Record an observation. */
  observe(value: number, labels: Record<string, string> = {}): void {
    const key = labelKey(labels);
    let state = this.states.get(key);
    if (!state) {
      state = { values: [], sum: 0, count: 0 };
      this.states.set(key, state);
    }

    state.values.push(value);
    state.sum += value;
    state.count += 1;

    // Enforce sliding window
    if (state.values.length > this.maxObservations) {
      const removed = state.values.shift()!;
      state.sum -= removed;
      state.count -= 1;
    }
  }

  /** Get a snapshot including computed quantiles for a label set. */
  get(labels: Record<string, string> = {}): {
    quantiles: Map<number, number>;
    sum: number;
    count: number;
  } | null {
    const state = this.states.get(labelKey(labels));
    if (!state || state.values.length === 0) return null;

    const sorted = [...state.values].sort((a, b) => a - b);
    const quantileMap = new Map<number, number>();
    for (const q of this.quantiles) {
      quantileMap.set(q, computeQuantile(sorted, q));
    }

    return {
      quantiles: quantileMap,
      sum: state.sum,
      count: state.count,
    };
  }

  /** Reset all values. */
  reset(): void {
    this.states.clear();
  }

  /** Render to Prometheus text lines. */
  render(): string[] {
    const lines: string[] = [
      `# HELP ${this.name} ${this.help}`,
      `# TYPE ${this.name} summary`,
    ];

    for (const [key, state] of this.states.entries()) {
      if (state.values.length === 0) continue;

      const sorted = [...state.values].sort((a, b) => a - b);
      const labelSuffix = key ? `,${key}` : '';
      const labelPrefix = key ? `{${key}}` : '';

      for (const q of this.quantiles) {
        const value = computeQuantile(sorted, q);
        lines.push(
          `${this.name}{quantile="${q}"${labelSuffix}} ${formatValue(value)}`,
        );
      }
      lines.push(`${this.name}_sum${labelPrefix} ${formatValue(state.sum)}`);
      lines.push(`${this.name}_count${labelPrefix} ${state.count}`);
    }

    return lines;
  }
}

/** Compute the q-th quantile from a sorted array (nearest-rank method). */
function computeQuantile(sorted: number[], q: number): number {
  if (sorted.length === 0) return 0;
  if (q <= 0) return sorted[0]!;
  if (q >= 1) return sorted[sorted.length - 1]!;

  const index = Math.ceil(q * sorted.length) - 1;
  return sorted[Math.max(0, index)]!;
}

// ─────────────────────────────────────────────────────────────────────────────
// Metrics Registry
// ─────────────────────────────────────────────────────────────────────────────

/**
 * Singleton registry that holds all metrics and provides factory methods.
 *
 * Usage:
 * ```ts
 * const registry = MetricsRegistry.getInstance();
 * const c = registry.counter('my_counter', 'A counter');
 * c.inc({ method: 'GET' });
 * console.log(registry.toPrometheusText());
 * ```
 */
export class MetricsRegistry {
  private static instance: MetricsRegistry | null = null;

  private readonly metrics = new Map<string, Counter | Gauge | Histogram | Summary>();

  private constructor() {}

  /** Get (or create) the singleton registry. */
  static getInstance(): MetricsRegistry {
    if (!MetricsRegistry.instance) {
      MetricsRegistry.instance = new MetricsRegistry();
    }
    return MetricsRegistry.instance;
  }

  /** Reset the singleton (primarily for testing). */
  static resetInstance(): void {
    MetricsRegistry.instance = null;
  }

  // ── Factory methods ─────────────────────────────────────────────────

  /** Register or retrieve a Counter metric. */
  counter(name: string, help: string, labels?: string[]): Counter {
    const existing = this.metrics.get(name);
    if (existing) {
      if (existing.type !== 'counter') {
        throw new Error(`Metric "${name}" already registered as ${existing.type}, not counter`);
      }
      return existing as Counter;
    }
    const metric = new Counter(name, help, labels);
    this.metrics.set(name, metric);
    return metric;
  }

  /** Register or retrieve a Gauge metric. */
  gauge(name: string, help: string, labels?: string[]): Gauge {
    const existing = this.metrics.get(name);
    if (existing) {
      if (existing.type !== 'gauge') {
        throw new Error(`Metric "${name}" already registered as ${existing.type}, not gauge`);
      }
      return existing as Gauge;
    }
    const metric = new Gauge(name, help, labels);
    this.metrics.set(name, metric);
    return metric;
  }

  /** Register or retrieve a Histogram metric. */
  histogram(
    name: string,
    help: string,
    buckets: number[],
    labels?: string[],
  ): Histogram {
    const existing = this.metrics.get(name);
    if (existing) {
      if (existing.type !== 'histogram') {
        throw new Error(`Metric "${name}" already registered as ${existing.type}, not histogram`);
      }
      return existing as Histogram;
    }
    const metric = new Histogram(name, help, buckets, labels);
    this.metrics.set(name, metric);
    return metric;
  }

  /** Register or retrieve a Summary metric. */
  summary(
    name: string,
    help: string,
    quantiles: number[],
    labels?: string[],
  ): Summary {
    const existing = this.metrics.get(name);
    if (existing) {
      if (existing.type !== 'summary') {
        throw new Error(`Metric "${name}" already registered as ${existing.type}, not summary`);
      }
      return existing as Summary;
    }
    const metric = new Summary(name, help, quantiles, labels);
    this.metrics.set(name, metric);
    return metric;
  }

  /** Retrieve any registered metric by name. */
  getMetric(name: string): Counter | Gauge | Histogram | Summary | undefined {
    return this.metrics.get(name);
  }

  /** Get all registered metric names. */
  getMetricNames(): string[] {
    return [...this.metrics.keys()];
  }

  /** Remove a metric by name. */
  unregister(name: string): boolean {
    return this.metrics.delete(name);
  }

  /** Reset all metric values (keeps registrations). */
  resetAll(): void {
    for (const metric of this.metrics.values()) {
      metric.reset();
    }
  }

  /** Clear all registrations entirely. */
  clear(): void {
    this.metrics.clear();
  }

  // ── Prometheus exposition ───────────────────────────────────────────

  /**
   * Render all registered metrics in Prometheus text exposition format
   * (content type: text/plain; version=0.0.4; charset=utf-8).
   */
  toPrometheusText(): string {
    const sections: string[] = [];
    for (const metric of this.metrics.values()) {
      const lines = metric.render();
      if (lines.length > 0) {
        sections.push(lines.join('\n'));
      }
    }
    return sections.join('\n') + '\n';
  }
}

// ─────────────────────────────────────────────────────────────────────────────
// Default Bucket Configurations
// ─────────────────────────────────────────────────────────────────────────────

/** Standard HTTP request duration buckets (seconds). */
export const HTTP_DURATION_BUCKETS = [
  0.005, 0.01, 0.025, 0.05, 0.1, 0.25, 0.5, 1, 2.5, 5, 10,
];

/** Google API call duration buckets (seconds). */
export const API_CALL_DURATION_BUCKETS = [
  0.05, 0.1, 0.25, 0.5, 1, 2.5, 5, 10, 30,
];

/** Default quantiles for summaries. */
export const DEFAULT_QUANTILES = [0.5, 0.9, 0.95, 0.99];

// ─────────────────────────────────────────────────────────────────────────────
// Pre-defined Metrics
// ─────────────────────────────────────────────────────────────────────────────

/**
 * All pre-defined metrics for the Google Slides MCP server.
 * Access these via the singleton to ensure consistent metric instances
 * across the entire application.
 */
export function registerDefaultMetrics(registry: MetricsRegistry): DefaultMetrics {
  const startTime = Date.now();

  const requestsTotal = registry.counter(
    'gslides_requests_total',
    'Total number of requests by method, layer, and status.',
    ['method', 'layer', 'status'],
  );

  const requestDuration = registry.histogram(
    'gslides_request_duration_seconds',
    'Request duration in seconds by method and layer.',
    HTTP_DURATION_BUCKETS,
    ['method', 'layer'],
  );

  const activeConnections = registry.gauge(
    'gslides_active_connections',
    'Number of active connections (SSE + WebSocket).',
  );

  const apiCallsTotal = registry.counter(
    'gslides_api_calls_total',
    'Total Google API calls by API name and status.',
    ['api', 'status'],
  );

  const apiCallDuration = registry.histogram(
    'gslides_api_call_duration_seconds',
    'Google API call duration in seconds by API name.',
    API_CALL_DURATION_BUCKETS,
    ['api'],
  );

  const presentationsCreatedTotal = registry.counter(
    'gslides_presentations_created_total',
    'Total presentations created by creation method.',
    ['method'],
  );

  const slidesCreatedTotal = registry.counter(
    'gslides_slides_created_total',
    'Total number of slides created.',
  );

  const visionAnalysesTotal = registry.counter(
    'gslides_vision_analyses_total',
    'Total vision analyses by result status.',
    ['result'],
  );

  const autoFixesTotal = registry.counter(
    'gslides_auto_fixes_total',
    'Total auto-fixes applied by issue type.',
    ['type'],
  );

  const templateUsageTotal = registry.counter(
    'gslides_template_usage_total',
    'Template usage count by template ID.',
    ['template_id'],
  );

  const errorsTotal = registry.counter(
    'gslides_errors_total',
    'Total errors by error type and layer.',
    ['type', 'layer'],
  );

  const authAttemptsTotal = registry.counter(
    'gslides_auth_attempts_total',
    'Total authentication attempts by method and status.',
    ['method', 'status'],
  );

  const rateLimitHitsTotal = registry.counter(
    'gslides_rate_limit_hits_total',
    'Total rate limit events by plan.',
    ['plan'],
  );

  const activeTenants = registry.gauge(
    'gslides_active_tenants',
    'Number of currently active tenants.',
  );

  const browserConnections = registry.gauge(
    'gslides_browser_connections',
    'Number of active browser connections.',
  );

  const uptimeSeconds = registry.gauge(
    'gslides_uptime_seconds',
    'Server uptime in seconds.',
  );

  // Update uptime gauge lazily — set a timer that ticks every second.
  // Store the interval so callers can clear it if needed.
  const uptimeInterval = setInterval(() => {
    uptimeSeconds.set(Math.floor((Date.now() - startTime) / 1000));
  }, 1_000);
  // Ensure the timer does not prevent the process from exiting.
  if (uptimeInterval.unref) {
    uptimeInterval.unref();
  }
  // Set the initial value.
  uptimeSeconds.set(0);

  return {
    requestsTotal,
    requestDuration,
    activeConnections,
    apiCallsTotal,
    apiCallDuration,
    presentationsCreatedTotal,
    slidesCreatedTotal,
    visionAnalysesTotal,
    autoFixesTotal,
    templateUsageTotal,
    errorsTotal,
    authAttemptsTotal,
    rateLimitHitsTotal,
    activeTenants,
    browserConnections,
    uptimeSeconds,
    _uptimeInterval: uptimeInterval,
  };
}

/** Typed handle to all pre-defined metrics. */
export interface DefaultMetrics {
  requestsTotal: Counter;
  requestDuration: Histogram;
  activeConnections: Gauge;
  apiCallsTotal: Counter;
  apiCallDuration: Histogram;
  presentationsCreatedTotal: Counter;
  slidesCreatedTotal: Counter;
  visionAnalysesTotal: Counter;
  autoFixesTotal: Counter;
  templateUsageTotal: Counter;
  errorsTotal: Counter;
  authAttemptsTotal: Counter;
  rateLimitHitsTotal: Counter;
  activeTenants: Gauge;
  browserConnections: Gauge;
  uptimeSeconds: Gauge;
  /** Internal handle to the uptime update interval (for cleanup). */
  _uptimeInterval: ReturnType<typeof setInterval>;
}

// ─────────────────────────────────────────────────────────────────────────────
// Module-level Singleton Convenience
// ─────────────────────────────────────────────────────────────────────────────

/** The global metrics registry instance. */
export const metricsRegistry = MetricsRegistry.getInstance();

/** Pre-registered default metrics ready for use across the server. */
export const defaultMetrics: DefaultMetrics = registerDefaultMetrics(metricsRegistry);
