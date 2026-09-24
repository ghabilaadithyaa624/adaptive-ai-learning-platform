/**
 * Zero-dependency, in-process metrics registry with a Prometheus text
 * exposition renderer.
 *
 * We deliberately avoid a heavyweight client library: the platform values a
 * small dependency surface, and Prometheus' exposition format is simple and
 * stable. Metrics live in the Node process and are scraped from
 * `GET /api/metrics`. For multi-instance deployments each replica exposes its
 * own counters and Prometheus aggregates across the `instance` label at query
 * time (standard pull-model behaviour — see OBSERVABILITY.md).
 *
 * Label cardinality is kept low on purpose: route templates rather than raw
 * paths, bounded status codes, model names, and enum-like outcomes only.
 */
import { performance } from "node:perf_hooks";

export const now = (): number => performance.now();

type Labels = Record<string, string | number>;

function labelKey(labels: Labels): string {
  const keys = Object.keys(labels).sort();
  return keys.map((k) => `${k}=${labels[k]}`).join(",");
}

function renderLabels(labels: Labels, extra?: Labels): string {
  const merged: Labels = { ...labels, ...(extra ?? {}) };
  const keys = Object.keys(merged).sort();
  if (!keys.length) return "";
  const inner = keys
    .map((k) => `${k}="${String(merged[k]).replace(/\\/g, "\\\\").replace(/"/g, '\\"').replace(/\n/g, "\\n")}"`)
    .join(",");
  return `{${inner}}`;
}

interface Metric {
  render(): string[];
}

export class Counter implements Metric {
  private readonly values = new Map<string, { labels: Labels; value: number }>();
  constructor(
    readonly name: string,
    readonly help: string,
    readonly labelNames: string[] = [],
  ) {}

  inc(labels: Labels = {}, amount = 1): void {
    const key = labelKey(labels);
    const existing = this.values.get(key);
    if (existing) existing.value += amount;
    else this.values.set(key, { labels, value: amount });
  }

  render(): string[] {
    const lines = [`# HELP ${this.name} ${this.help}`, `# TYPE ${this.name} counter`];
    if (this.values.size === 0) lines.push(`${this.name}${renderLabels({})} 0`);
    for (const { labels, value } of this.values.values()) {
      lines.push(`${this.name}${renderLabels(labels)} ${value}`);
    }
    return lines;
  }
}

export class Gauge implements Metric {
  private readonly values = new Map<string, { labels: Labels; value: number }>();
  constructor(
    readonly name: string,
    readonly help: string,
    readonly labelNames: string[] = [],
  ) {}

  set(value: number, labels: Labels = {}): void {
    this.values.set(labelKey(labels), { labels, value });
  }

  render(): string[] {
    const lines = [`# HELP ${this.name} ${this.help}`, `# TYPE ${this.name} gauge`];
    for (const { labels, value } of this.values.values()) {
      lines.push(`${this.name}${renderLabels(labels)} ${value}`);
    }
    return lines;
  }
}

export class Histogram implements Metric {
  private readonly series = new Map<string, { labels: Labels; counts: number[]; sum: number; count: number }>();
  constructor(
    readonly name: string,
    readonly help: string,
    readonly buckets: number[],
    readonly labelNames: string[] = [],
  ) {
    this.buckets = [...buckets].sort((a, b) => a - b);
  }

  observe(value: number, labels: Labels = {}): void {
    const key = labelKey(labels);
    let entry = this.series.get(key);
    if (!entry) {
      entry = { labels, counts: new Array(this.buckets.length).fill(0), sum: 0, count: 0 };
      this.series.set(key, entry);
    }
    entry.sum += value;
    entry.count += 1;
    for (let i = 0; i < this.buckets.length; i += 1) {
      if (value <= this.buckets[i]) entry.counts[i] += 1;
    }
  }

  render(): string[] {
    const lines = [`# HELP ${this.name} ${this.help}`, `# TYPE ${this.name} histogram`];
    for (const entry of this.series.values()) {
      // `counts[i]` already holds the cumulative "<= bucket[i]" total.
      for (let i = 0; i < this.buckets.length; i += 1) {
        lines.push(`${this.name}_bucket${renderLabels(entry.labels, { le: this.buckets[i] })} ${entry.counts[i]}`);
      }
      lines.push(`${this.name}_bucket${renderLabels(entry.labels, { le: "+Inf" })} ${entry.count}`);
      lines.push(`${this.name}_sum${renderLabels(entry.labels)} ${entry.sum}`);
      lines.push(`${this.name}_count${renderLabels(entry.labels)} ${entry.count}`);
    }
    return lines;
  }
}

export class Registry {
  private readonly metrics: Metric[] = [];
  private readonly collectors: Array<() => void> = [];

  register<T extends Metric>(metric: T): T {
    this.metrics.push(metric);
    return metric;
  }

  /** Register a callback invoked at scrape time to refresh dynamic gauges. */
  onCollect(fn: () => void): void {
    this.collectors.push(fn);
  }

  render(): string {
    for (const collect of this.collectors) {
      try {
        collect();
      } catch {
        // never let a broken collector break the whole scrape
      }
    }
    return `${this.metrics.flatMap((m) => m.render()).join("\n")}\n`;
  }
}

// ---------------------------------------------------------------------------
// Bucket presets
// ---------------------------------------------------------------------------
const LATENCY_BUCKETS = [0.005, 0.01, 0.025, 0.05, 0.1, 0.25, 0.5, 1, 2.5, 5, 10];
const DB_BUCKETS = [0.001, 0.005, 0.01, 0.025, 0.05, 0.1, 0.25, 0.5, 1, 2.5, 5];
const RESPONSE_TIME_BUCKETS = [1, 2, 5, 10, 20, 30, 45, 60, 120, 300];
const UNIT_BUCKETS = [0.1, 0.2, 0.3, 0.4, 0.5, 0.6, 0.7, 0.8, 0.9, 1];
const DELTA_BUCKETS = [-1, -0.5, -0.25, -0.1, -0.01, 0, 0.01, 0.1, 0.25, 0.5, 1];

// ---------------------------------------------------------------------------
// The default registry + the platform metric catalogue.
// (Every required signal has a home here — see OBSERVABILITY.md § "Metrics".)
// ---------------------------------------------------------------------------
export const registry = new Registry();

export const metrics = {
  // ---- API (latency, traffic, error rate) ----
  httpRequestsTotal: registry.register(
    new Counter("adaptiq_http_requests_total", "Total HTTP API requests.", ["method", "route", "status"]),
  ),
  httpRequestDuration: registry.register(
    new Histogram(
      "adaptiq_http_request_duration_seconds",
      "HTTP API request latency in seconds.",
      LATENCY_BUCKETS,
      ["method", "route", "status"],
    ),
  ),

  // ---- Database ----
  dbQueryDuration: registry.register(
    new Histogram("adaptiq_db_query_duration_seconds", "PostgreSQL query latency in seconds.", DB_BUCKETS, [
      "op",
      "status",
    ]),
  ),
  dbErrorsTotal: registry.register(
    new Counter("adaptiq_db_errors_total", "Failed PostgreSQL queries.", ["op"]),
  ),
  dbPoolConnections: registry.register(
    new Gauge("adaptiq_db_pool_connections", "PostgreSQL connection pool state.", ["state"]),
  ),

  // ---- Assessment lifecycle ----
  assessmentsStartedTotal: registry.register(
    new Counter("adaptiq_assessments_started_total", "Assessments started.", ["mode"]),
  ),
  assessmentsCompletedTotal: registry.register(
    new Counter("adaptiq_assessments_completed_total", "Assessments closed out.", ["mode", "outcome"]),
  ),
  assessmentScore: registry.register(
    new Histogram("adaptiq_assessment_score", "Final assessment score (0-1).", UNIT_BUCKETS, ["mode"]),
  ),

  // ---- Answer submission ----
  answersTotal: registry.register(
    new Counter("adaptiq_answers_total", "Answers graded.", ["correct"]),
  ),
  questionResponseTime: registry.register(
    new Histogram(
      "adaptiq_question_response_time_seconds",
      "Learner response time per graded question in seconds.",
      RESPONSE_TIME_BUCKETS,
    ),
  ),

  // ---- Adaptive selection ----
  adaptiveSelectionDuration: registry.register(
    new Histogram(
      "adaptiq_adaptive_selection_duration_seconds",
      "Latency of computing the next adaptive item in seconds.",
      LATENCY_BUCKETS,
    ),
  ),

  // ---- Mastery ----
  masteryUpdatesTotal: registry.register(
    new Counter("adaptiq_mastery_updates_total", "Mastery-state updates applied.", ["direction"]),
  ),
  masteryUpdateDelta: registry.register(
    new Histogram("adaptiq_mastery_update_delta", "Change in mastery per update.", DELTA_BUCKETS),
  ),

  // ---- Recommendations ----
  recommendationsGeneratedTotal: registry.register(
    new Counter("adaptiq_recommendations_generated_total", "Recommendation records generated."),
  ),
  recommendationActionsTotal: registry.register(
    new Counter(
      "adaptiq_recommendation_actions_total",
      "Recommendation status transitions (acceptance funnel).",
      ["status"],
    ),
  ),

  // ---- AI tutor ----
  tutorInteractionsTotal: registry.register(
    new Counter("adaptiq_tutor_interactions_total", "AI-tutor interactions served.", ["intent", "provider"]),
  ),
  tutorLatency: registry.register(
    new Histogram("adaptiq_tutor_latency_seconds", "End-to-end tutor response latency in seconds.", LATENCY_BUCKETS, [
      "provider",
    ]),
  ),
  tutorAnswersWithheldTotal: registry.register(
    new Counter("adaptiq_tutor_answers_withheld_total", "Tutor responses where the answer key was withheld."),
  ),
  tutorFallbacksTotal: registry.register(
    new Counter("adaptiq_tutor_fallbacks_total", "Tutor responses that fell back to the deterministic composer."),
  ),

  // ---- ML: predictions & training ----
  modelPredictionsTotal: registry.register(
    new Counter("adaptiq_model_predictions_total", "Model predictions served.", ["model", "surface"]),
  ),
  modelErrorsTotal: registry.register(
    new Counter("adaptiq_model_errors_total", "Model inference / training errors.", ["model", "op"]),
  ),
  modelTrainingDuration: registry.register(
    new Histogram(
      "adaptiq_model_training_duration_seconds",
      "Model training wall-clock time in seconds.",
      [0.5, 1, 2.5, 5, 10, 30, 60, 120, 300],
      ["model"],
    ),
  ),
  modelTrainingTotal: registry.register(
    new Counter("adaptiq_model_training_total", "Model training runs.", ["model", "verdict"]),
  ),

  // ---- Authentication ----
  authEventsTotal: registry.register(
    new Counter("adaptiq_auth_events_total", "Authentication events.", ["action", "outcome"]),
  ),

  // ---- Errors ----
  appErrorsTotal: registry.register(
    new Counter("adaptiq_app_errors_total", "Application-level errors.", ["type"]),
  ),

  // ---- Build / process info ----
  buildInfo: registry.register(new Gauge("adaptiq_build_info", "Build metadata (always 1).", ["version", "node"])),
  processUptimeSeconds: registry.register(
    new Gauge("adaptiq_process_uptime_seconds", "Process uptime in seconds."),
  ),
};

metrics.buildInfo.set(1, {
  version: process.env.APP_VERSION ?? process.env.npm_package_version ?? "dev",
  node: process.version,
});

registry.onCollect(() => {
  metrics.processUptimeSeconds.set(process.uptime());
});
