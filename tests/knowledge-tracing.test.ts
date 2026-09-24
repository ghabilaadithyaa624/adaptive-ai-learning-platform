import { describe, expect, it } from "vitest";
import { DEFAULT_BKT, applyDecay, posterior, predictCorrect, decayedMastery } from "@/lib/ml/knowledge-tracing";

describe("knowledge-tracing (BKT primitives)", () => {
  it("a correct response raises mastery, a wrong one lowers it", () => {
    const m = 0.5;
    expect(posterior(m, true)).toBeGreaterThan(m);
    expect(posterior(m, false)).toBeLessThan(m);
  });

  it("repeated correct responses converge upward and stay bounded", () => {
    let m = 0.3;
    let prev = m;
    for (let i = 0; i < 20; i += 1) {
      m = posterior(m, true);
      expect(m).toBeGreaterThanOrEqual(prev);
      prev = m;
    }
    expect(m).toBeLessThanOrEqual(0.995);
    expect(m).toBeGreaterThan(0.9);
  });

  it("predictCorrect is bounded and increases with mastery", () => {
    const low = predictCorrect(0.1);
    const high = predictCorrect(0.9);
    expect(low).toBeGreaterThan(0);
    expect(high).toBeLessThan(1);
    expect(high).toBeGreaterThan(low);
    // floors at guess, caps below 1
    expect(predictCorrect(0)).toBeGreaterThanOrEqual(DEFAULT_BKT.guess - 0.01);
  });

  it("forgetting decay reduces mastery over elapsed time, never below floor", () => {
    const thirtyDaysAgo = new Date(Date.now() - 30 * 86_400_000);
    const decayed = applyDecay(0.9, thirtyDaysAgo);
    expect(decayed).toBeLessThan(0.9);
    expect(decayed).toBeGreaterThan(0);
    expect(applyDecay(0.9, null)).toBe(0.9); // no history → no decay
  });

  it("decayedMastery is deterministic for the same inputs", () => {
    const state = { mastery: 0.8, lastPracticedAt: new Date("2026-01-01T00:00:00Z") };
    expect(decayedMastery(state)).toBe(decayedMastery(state));
  });

  it("honours custom slip/guess parameters", () => {
    const slippery = posterior(0.9, false, { ...DEFAULT_BKT, slip: 0.4 });
    const normal = posterior(0.9, false, DEFAULT_BKT);
    // with a higher slip, a wrong answer is discounted → mastery stays higher
    expect(slippery).toBeGreaterThan(normal);
  });
});
