import { vi, afterAll, beforeEach, expect, it } from "vitest";

vi.mock("next/headers", () => import("../helpers/next-headers-mock"));
vi.mock("next/navigation", () => import("../helpers/next-navigation-mock"));

import { describeDb, closePool } from "../helpers/db";
import { seedFixtures, type Fixtures } from "../helpers/fixtures";
import { loginAs, logout } from "../helpers/session";
import { GET, readJson } from "../helpers/http";
import { GET as healthGET } from "@/app/api/health/route";
import { GET as liveGET } from "@/app/api/health/live/route";
import { GET as readyGET } from "@/app/api/health/ready/route";
import { GET as metricsGET } from "@/app/api/metrics/route";
import { GET as mlGET } from "@/app/api/ml/route";

type Check = { name: string; status: string; critical: boolean };

describeDb("API · observability (health, metrics, correlation)", () => {
  let fx: Fixtures;

  beforeEach(async () => {
    fx = await seedFixtures();
    await logout();
  });
  afterAll(async () => {
    delete process.env.METRICS_TOKEN;
    await closePool();
  });

  it("liveness never touches the database and reports alive", async () => {
    const res = await liveGET();
    expect(res.status).toBe(200);
    const data = await readJson<{ status: string; uptimeSeconds: number }>(res);
    expect(data.status).toBe("alive");
    expect(typeof data.uptimeSeconds).toBe("number");
  });

  it("readiness passes with a live database + core schema", async () => {
    const res = await readyGET();
    expect(res.status).toBe(200);
    const data = await readJson<{ status: string; checks: Check[] }>(res);
    expect(data.status).toBe("ready");
    const pg = data.checks.find((c) => c.name === "postgres");
    expect(pg?.status).toBe("pass");
    expect(data.checks.find((c) => c.name === "schema")?.status).toBe("pass");
  });

  it("deep health reports app, postgres and pool checks with counts", async () => {
    const res = await healthGET();
    expect(res.status).toBe(200);
    const data = await readJson<{
      status: string;
      database: string;
      checks: Check[];
      counts: Record<string, number>;
    }>(res);
    expect(data.status).toBe("ok");
    expect(data.database).toBe("up");
    expect(data.checks.map((c) => c.name)).toEqual(expect.arrayContaining(["postgres", "schema", "db_pool"]));
    expect(data.counts.users).toBeGreaterThan(0);
  });

  it("stamps and echoes a correlation id, honouring an inbound one", async () => {
    await loginAs(fx.users.teacherA);
    // No inbound id -> a fresh one is minted and echoed.
    const minted = await mlGET(GET("/api/ml"));
    expect(minted.headers.get("x-request-id")).toBeTruthy();
    // Inbound id -> propagated unchanged.
    const propagated = await mlGET(GET("/api/ml", { headers: { "x-request-id": "trace-abc-123" } }));
    expect(propagated.headers.get("x-request-id")).toBe("trace-abc-123");
  });

  it("exposes Prometheus metrics that reflect served traffic", async () => {
    await loginAs(fx.users.teacherA);
    // Generate some API traffic so counters are non-zero.
    await mlGET(GET("/api/ml"));
    const res = await metricsGET(GET("/api/metrics"));
    expect(res.status).toBe(200);
    expect(res.headers.get("content-type")).toContain("text/plain");
    const body = await res.text();
    expect(body).toContain("adaptiq_http_requests_total");
    expect(body).toContain("adaptiq_db_query_duration_seconds");
    expect(body).toContain("adaptiq_db_pool_connections");
    expect(body).toContain("adaptiq_build_info");
    // The /api/ml GET above must have been counted.
    expect(body).toMatch(/adaptiq_http_requests_total\{[^}]*route="\/api\/ml"[^}]*\}/);
  });

  it("requires a bearer token for /api/metrics when METRICS_TOKEN is set", async () => {
    process.env.METRICS_TOKEN = "s3cr3t";
    try {
      const denied = await metricsGET(GET("/api/metrics"));
      expect(denied.status).toBe(401);
      const allowed = await metricsGET(GET("/api/metrics", { headers: { authorization: "Bearer s3cr3t" } }));
      expect(allowed.status).toBe(200);
    } finally {
      delete process.env.METRICS_TOKEN;
    }
  });
});
