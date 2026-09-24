import { describe, expect, it } from "vitest";
import { redact, safeError, maskEmail } from "@/lib/observability/redact";
import { Counter, Gauge, Histogram, Registry } from "@/lib/observability/metrics";

describe("observability · redaction", () => {
  it("drops secrets entirely", () => {
    const out = redact({
      userId: 42,
      password: "hunter2",
      passwordHash: "$2b$deadbeef",
      token: "abc.def.ghi",
      sessionToken: "sess_123",
      cookie: "sid=xyz",
      authorization: "Bearer secret",
    });
    expect(out).toEqual({ userId: 42 });
    expect(JSON.stringify(out)).not.toContain("hunter2");
    expect(JSON.stringify(out)).not.toContain("deadbeef");
    expect(JSON.stringify(out)).not.toContain("sess_123");
  });

  it("masks PII rather than dropping it", () => {
    const out = redact({ email: "student@example.com", name: "Ada Lovelace", goal: "Ace calculus" });
    expect(out.email).toBe("s***@e***.com");
    expect(out.name).toBe("A***");
    expect(out.goal).toBe("A***");
    expect(JSON.stringify(out)).not.toContain("Lovelace");
    expect(JSON.stringify(out)).not.toContain("calculus");
  });

  it("keeps opaque identifiers needed for correlation", () => {
    const out = redact({ studentId: 7, questionId: 12, skillId: 3, isCorrect: true, mastery: 0.42 });
    expect(out).toEqual({ studentId: 7, questionId: 12, skillId: 3, isCorrect: true, mastery: 0.42 });
  });

  it("recurses into nested structures and redacts within them", () => {
    const out = redact({ actor: { id: 1, password: "x" }, items: [{ email: "a@b.com" }] }) as {
      actor: Record<string, unknown>;
      items: Array<Record<string, unknown>>;
    };
    expect(out.actor).toEqual({ id: 1 });
    expect(out.items[0].email).toBe("a***@b***.com");
  });

  it("truncates very long strings", () => {
    const out = redact({ blob: "x".repeat(1000) }) as { blob: string };
    expect(out.blob.length).toBeLessThan(1000);
    expect(out.blob).toContain("…");
  });

  it("masks assorted email shapes", () => {
    expect(maskEmail("a@b.com")).toBe("a***@b***.com");
    expect(maskEmail("no-at-sign")).toBe("n***");
  });

  it("normalizes errors and hides stacks in production", () => {
    const prev = process.env.NODE_ENV;
    try {
      const err = new Error("boom");
      (process.env as Record<string, string>).NODE_ENV = "development";
      expect(safeError(err).stack).toBeTruthy();
      (process.env as Record<string, string>).NODE_ENV = "production";
      expect(safeError(err).stack).toBeUndefined();
      expect(safeError("string error")).toEqual({ name: "NonError", message: "string error" });
    } finally {
      (process.env as Record<string, string>).NODE_ENV = prev ?? "test";
    }
  });
});

describe("observability · metrics registry", () => {
  it("counts with labels and renders Prometheus text", () => {
    const reg = new Registry();
    const c = reg.register(new Counter("adaptiq_test_total", "test counter", ["route"]));
    c.inc({ route: "/a" });
    c.inc({ route: "/a" });
    c.inc({ route: "/b" }, 3);
    const text = reg.render();
    expect(text).toContain("# TYPE adaptiq_test_total counter");
    expect(text).toContain('adaptiq_test_total{route="/a"} 2');
    expect(text).toContain('adaptiq_test_total{route="/b"} 3');
  });

  it("records histogram buckets, sum, and count", () => {
    const reg = new Registry();
    const h = reg.register(new Histogram("adaptiq_test_seconds", "test histogram", [0.1, 0.5, 1]));
    h.observe(0.05);
    h.observe(0.4);
    h.observe(2);
    const text = reg.render();
    expect(text).toContain('adaptiq_test_seconds_bucket{le="0.1"} 1');
    expect(text).toContain('adaptiq_test_seconds_bucket{le="0.5"} 2');
    expect(text).toContain('adaptiq_test_seconds_bucket{le="+Inf"} 3');
    expect(text).toContain("adaptiq_test_seconds_count 3");
    expect(text).toContain("adaptiq_test_seconds_sum 2.45");
  });

  it("exposes gauges and runs collect callbacks at render time", () => {
    const reg = new Registry();
    const g = reg.register(new Gauge("adaptiq_test_gauge", "test gauge"));
    let tick = 0;
    reg.onCollect(() => g.set((tick += 1)));
    reg.render();
    const text = reg.render();
    expect(text).toContain("adaptiq_test_gauge 2");
  });

  it("escapes label values safely", () => {
    const reg = new Registry();
    const c = reg.register(new Counter("adaptiq_test2_total", "help", ["path"]));
    c.inc({ path: 'a"b\\c' });
    const text = reg.render();
    expect(text).toContain('path="a\\"b\\\\c"');
  });
});
