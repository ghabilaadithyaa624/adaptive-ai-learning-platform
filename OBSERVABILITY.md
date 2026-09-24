# Observability

Production-grade observability for the AdaptIQ adaptive-learning platform:
**structured logging**, **request-correlation IDs**, **metrics**, and
**health checks** — plus a ready-to-provision **operations dashboard**.

The design goal is the classic SRE triad — *know when something is wrong, know
where, know why* — while never leaking secrets or unnecessary student PII.

---

## 1. Signals at a glance

| Signal      | Where it lives                       | Exposed at / shipped to                        |
|-------------|--------------------------------------|------------------------------------------------|
| Logs        | `src/lib/observability/logger.ts`    | stdout/stderr → Loki / CloudWatch / Datadog    |
| Metrics     | `src/lib/observability/metrics.ts`   | `GET /api/metrics` (Prometheus text) → Grafana |
| Correlation | `src/lib/observability/context.ts`   | `x-request-id` header + every log line         |
| Health      | `src/lib/observability/health.ts`    | `/api/health`, `/api/health/live`, `/ready`    |

Everything is wired through the central API guard (`src/lib/api.ts`) and the
DB pool (`src/db/index.ts`), so **every** request and **every** query is
observed automatically — instrumentation at call sites is additive detail, not
the baseline.

---

## 2. Structured logging

One JSON object per line (newline-delimited JSON — the format every modern log
pipeline ingests natively). Each line carries the active correlation context and
is redacted before serialization.

```json
{"ts":"2026-09-24T08:44:00.123Z","level":"info","event":"answer.submitted",
 "requestId":"b1d…","method":"POST","route":"/api/assessments/:id/answer",
 "userId":42,"role":"student","assessmentId":7,"skillId":3,"isCorrect":true,
 "responseTimeMs":8200,"predictedSuccess":0.61}
```

### Event catalogue (required domains)

| Domain              | Event(s)                                                    |
|---------------------|-------------------------------------------------------------|
| Authentication      | `auth.login`, `auth.register`, `auth.logout`                |
| API requests        | `api.request` (+ `api.unhandled_error`)                     |
| Assessment lifecycle| `assessment.started`, `assessment.completed`                |
| Question selection  | `question.selected`, `question.selection_exhausted`         |
| Answer submission   | `answer.submitted`                                          |
| Mastery updates     | `mastery.updated`                                           |
| Recommendations     | `recommendation.generated`, `recommendation.acted`          |
| ML predictions      | `model.prediction`                                          |
| Model training      | `model.trained`                                             |
| Errors              | `api.unhandled_error`, `model.error`, `db.slow_query`, `db.pool_error` |

### Levels

`LOG_LEVEL` = `debug` \| `info` \| `warn` \| `error` \| `silent`.
Default `info`; the `test` environment defaults to `silent`. `warn`/`error` go
to **stderr**, everything else to **stdout** (12-factor).

---

## 3. Correlation IDs

Every request runs inside an `AsyncLocalStorage` context holding a correlation
id. The id is:

1. **honoured on the way in** from `x-request-id` or `x-correlation-id`
   (so an upstream LB / gateway trace id flows through), else a fresh UUID is
   minted;
2. **attached automatically** to every log line and slow-query warning emitted
   while handling the request — across `await`s, DB calls and the engine;
3. **echoed back** on the `x-request-id` response header.

Inbound ids are validated (`[A-Za-z0-9._-]{8,128}`) to prevent header-injection
and unbounded log cardinality. This gives end-to-end traceability without a
full distributed-tracing backend (and is a clean drop-in point for OpenTelemetry
later — the context already models `traceId`-shaped data).

---

## 4. Metrics

Zero-dependency in-process registry rendered in Prometheus text-exposition
format at `GET /api/metrics`. Pull model: each replica exposes its own counters
and Prometheus aggregates across the `instance` label at query time. Label
cardinality is deliberately bounded (route *templates*, status codes, model
names, enum outcomes).

### Metric catalogue (required signals)

| Requirement                     | Metric                                             | Type      |
|---------------------------------|----------------------------------------------------|-----------|
| API latency                     | `adaptiq_http_request_duration_seconds`            | histogram |
| Error rate                      | `adaptiq_http_requests_total{status}` (+ `adaptiq_app_errors_total`) | counter |
| Assessment completion           | `adaptiq_assessments_completed_total{mode,outcome}`| counter   |
| Question response time          | `adaptiq_question_response_time_seconds`           | histogram |
| Adaptive-selection latency      | `adaptiq_adaptive_selection_duration_seconds`      | histogram |
| Recommendation acceptance       | `adaptiq_recommendation_actions_total{status}`     | counter   |
| Model prediction volume         | `adaptiq_model_predictions_total{model,surface}`   | counter   |
| Model errors                    | `adaptiq_model_errors_total{model,op}`             | counter   |
| Database latency                | `adaptiq_db_query_duration_seconds{op,status}`     | histogram |

Supporting metrics: `adaptiq_answers_total{correct}`,
`adaptiq_assessment_score{mode}`, `adaptiq_assessments_started_total{mode}`,
`adaptiq_mastery_updates_total{direction}`, `adaptiq_mastery_update_delta`,
`adaptiq_recommendations_generated_total`,
`adaptiq_model_training_duration_seconds{model}`,
`adaptiq_model_training_total{model,verdict}`,
`adaptiq_auth_events_total{action,outcome}`,
`adaptiq_db_errors_total{op}`, `adaptiq_db_pool_connections{state}`,
`adaptiq_build_info`, `adaptiq_process_uptime_seconds`.

### Derived signals (PromQL)

```promql
# API error rate (5m)
sum(rate(adaptiq_http_requests_total{status=~"5.."}[5m]))
  / sum(rate(adaptiq_http_requests_total[5m]))

# API p95 latency
histogram_quantile(0.95,
  sum(rate(adaptiq_http_request_duration_seconds_bucket[5m])) by (le))

# Recommendation acceptance rate
sum(rate(adaptiq_recommendation_actions_total{status="accepted"}[1h]))
  / sum(rate(adaptiq_recommendation_actions_total{status=~"accepted|dismissed"}[1h]))

# Model error rate
sum(rate(adaptiq_model_errors_total[15m]))
  / sum(rate(adaptiq_model_predictions_total[15m]))
```

### Scrape auth

If `METRICS_TOKEN` is set, scrapers must present `Authorization: Bearer <token>`
(configure Prometheus `authorization`). Unset ⇒ open (local dev only).

---

## 5. Health checks

| Endpoint            | Purpose    | Checks                              | Codes        |
|---------------------|------------|-------------------------------------|--------------|
| `/api/health/live`  | liveness   | process/event-loop only (no deps)   | 200          |
| `/api/health/ready` | readiness  | PostgreSQL reachable + core schema  | 200 / **503**|
| `/api/health`       | deep       | app + PostgreSQL + schema + pool + counts | 200 / **503** |

- **Liveness** never calls a dependency, so a slow database cannot trigger a
  restart storm.
- **Readiness** returns **503** when a *critical* dependency is down, so the
  load balancer / orchestrator stops routing without killing the pod.
- Health checks are cheap and read-only — they **do not** trigger DB seeding.

Kubernetes example:

```yaml
livenessProbe:  { httpGet: { path: /api/health/live,  port: 3000 }, periodSeconds: 10 }
readinessProbe: { httpGet: { path: /api/health/ready, port: 3000 }, periodSeconds: 5 }
```

---

## 6. Sensitive data policy

Enforced centrally by `src/lib/observability/redact.ts` (unit-tested):

- **Never logged (dropped):** passwords, password hashes, session tokens,
  cookies, `authorization`, API keys, CSRF tokens, any secret-shaped key.
- **Masked, never in the clear:** email (`s***@e***.com`), name, phone,
  address, DOB, learner goals, question stems, answer text.
- **Allowed:** opaque numeric identifiers (`userId`, `studentId`, `questionId`,
  `skillId`) — required for correlation, not themselves sensitive.
- Stack traces are included only outside `production`.

Domain event emitters only accept ids + enum/number fields, so PII cannot reach
a log even by accident; redaction is the belt-and-braces safety net.

---

## 7. Dashboard architecture

The operations dashboard is provisioned as code under [`observability/`](observability/):

```
observability/
├── prometheus.yml          # scrape config (job: adaptiq, /api/metrics)
├── alerts.yml              # SLO / alerting rules
├── grafana-dashboard.json  # importable Grafana dashboard
└── README.md               # local run instructions
```

### Topology

```
 AdaptIQ replicas ──/api/metrics──▶ Prometheus ──▶ Grafana (dashboards)
        │  (stdout JSON logs)            │            Alertmanager (paging)
        └──────────────▶ Loki / CloudWatch Logs ◀── correlate by requestId
```

### Dashboard layout (rows/panels)

1. **Golden signals (RED/USE)** — request rate, error rate %, p50/p95/p99
   latency, in-flight, 5xx count.
2. **Learning domain** — assessments started vs completed vs abandoned,
   completion rate, score distribution, adaptive-selection p95 latency,
   question response-time distribution.
3. **ML** — prediction volume by surface, model error rate, training runs by
   verdict, training duration, recommendation acceptance rate.
4. **Data layer** — DB query p95 by op, DB error rate, connection-pool
   saturation (total/idle/waiting), slow-query count.
5. **Auth & security** — login success/failure/denied rate, registration rate.
6. **Fleet** — uptime, build info, readiness status.

### Alerting (SLOs → `observability/alerts.yml`)

| Alert                       | Condition (5–15m windows)                        | Severity |
|-----------------------------|--------------------------------------------------|----------|
| `HighApiErrorRate`          | 5xx ratio > 2%                                    | critical |
| `HighApiLatencyP95`         | p95 > 1s                                           | warning  |
| `HighDbLatencyP95`          | DB p95 > 0.25s                                     | warning  |
| `DbConnectionSaturation`    | `db_pool_connections{state="waiting"}` > 0        | warning  |
| `ModelErrorRateHigh`        | model errors / predictions > 5%                   | warning  |
| `NoAssessmentsCompleted`    | completion rate == 0 during active hours          | info     |
| `InstanceNotReady`          | readiness failing / target down                   | critical |

---

## 8. Configuration reference

| Env var           | Default        | Meaning                                             |
|-------------------|----------------|-----------------------------------------------------|
| `LOG_LEVEL`       | `info`(`silent` in test) | Minimum log level                         |
| `METRICS_TOKEN`   | *(unset)*      | Bearer token required to scrape `/api/metrics`      |
| `SLOW_QUERY_MS`   | `300`          | Threshold for `db.slow_query` warnings              |
| `APP_VERSION`     | `npm_package_version` | Value on the `adaptiq_build_info` gauge       |
```
