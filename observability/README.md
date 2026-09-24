# Observability provisioning

Infrastructure-as-code for the AdaptIQ operations dashboard. See the top-level
[`OBSERVABILITY.md`](../OBSERVABILITY.md) for the full design.

## Files

| File                     | Purpose                                                        |
|--------------------------|---------------------------------------------------------------|
| `prometheus.yml`         | Scrape config for `GET /api/metrics` (job `adaptiq`).         |
| `alerts.yml`             | SLO-based Prometheus alerting rules.                          |
| `grafana-dashboard.json` | Importable Grafana dashboard (6 rows, golden signals + domain).|

## Quick start (local)

1. Run the app so `/api/metrics` is live:

   ```bash
   npm run dev   # exposes http://localhost:3000/api/metrics
   ```

2. Start Prometheus with the provided config:

   ```bash
   docker run --rm -p 9090:9090 \
     -v "$(pwd)/observability/prometheus.yml:/etc/prometheus/prometheus.yml" \
     -v "$(pwd)/observability/alerts.yml:/etc/prometheus/alerts.yml" \
     prom/prometheus
   ```

3. Start Grafana, add the Prometheus data source (`http://host.docker.internal:9090`),
   then **Dashboards → Import → Upload JSON** and pick `grafana-dashboard.json`.

   ```bash
   docker run --rm -p 3001:3000 grafana/grafana
   ```

## Production notes

- Replace the static target in `prometheus.yml` with service discovery
  (`kubernetes_sd_configs`, `ec2_sd_configs`, …). Each replica is scraped
  independently; Prometheus aggregates across the `instance` label.
- If `METRICS_TOKEN` is set on the app, configure `authorization` in the scrape
  job (see the commented block in `prometheus.yml`).
- Wire `alerting.alertmanagers` to your Alertmanager to actually page.
- Ship stdout/stderr JSON logs to your log backend (Loki / CloudWatch / Elastic)
  and correlate with dashboard time ranges via the `requestId` field.
