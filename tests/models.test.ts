import { describe, expect, it } from "vitest";
import { bktModel } from "@/lib/ml/models/bkt";
import { irtModel } from "@/lib/ml/models/irt";
import { bayesianModel } from "@/lib/ml/models/bayesian";
import { ucbBonus, ucbScore } from "@/lib/ml/models/bandit";
import type { ItemDescriptor, KnowledgeTracingModel } from "@/lib/ml/interfaces";

const models: KnowledgeTracingModel[] = [bktModel, irtModel, bayesianModel];
const easy: ItemDescriptor = { difficulty: 0.2, bloom: 2 };
const hard: ItemDescriptor = { difficulty: 0.85, bloom: 5 };

describe.each(models)("KnowledgeTracingModel contract: $id", (model) => {
  it("exposes a stable id and kind", () => {
    expect(model.id).toBeTruthy();
    expect(["bkt", "irt", "bayesian"]).toContain(model.kind);
  });

  it("prior has high uncertainty and a valid mastery", () => {
    const prior = model.prior();
    expect(prior.uncertainty).toBeGreaterThan(0.4);
    expect(prior.mastery).toBeGreaterThan(0);
    expect(prior.mastery).toBeLessThan(1);
    expect(prior.confidence).toBeCloseTo(1 - prior.uncertainty, 5);
  });

  it("a correct response raises mastery; a wrong one lowers it", () => {
    const prior = model.prior();
    const up = model.observe(prior, { isCorrect: true, difficulty: 0.5, bloom: 3 });
    const down = model.observe(prior, { isCorrect: false, difficulty: 0.5, bloom: 3 });
    expect(up.mastery).toBeGreaterThan(prior.mastery);
    expect(down.mastery).toBeLessThan(prior.mastery);
  });

  it("evidence reduces uncertainty monotonically", () => {
    let belief = model.prior();
    let prevUncertainty = belief.uncertainty;
    for (let i = 0; i < 8; i += 1) {
      belief = model.observe(belief, { isCorrect: true, difficulty: 0.5, bloom: 3 });
      expect(belief.uncertainty).toBeLessThanOrEqual(prevUncertainty + 1e-9);
      prevUncertainty = belief.uncertainty;
    }
    expect(belief.uncertainty).toBeLessThan(model.prior().uncertainty);
  });

  it("predictCorrect stays in (0,1) and drops for harder items", () => {
    let belief = model.prior();
    for (let i = 0; i < 5; i += 1) belief = model.observe(belief, { isCorrect: true, difficulty: 0.5, bloom: 3 });
    const pEasy = model.predictCorrect(belief, easy);
    const pHard = model.predictCorrect(belief, hard);
    for (const p of [pEasy, pHard]) {
      expect(p).toBeGreaterThan(0);
      expect(p).toBeLessThan(1);
    }
    expect(pEasy).toBeGreaterThan(pHard);
  });

  it("decay reduces a well-learned mastery over time", () => {
    let belief = model.prior();
    for (let i = 0; i < 10; i += 1) belief = model.observe(belief, { isCorrect: true, difficulty: 0.6, bloom: 3 });
    const decayed = model.decay(belief, 40);
    expect(decayed.mastery).toBeLessThanOrEqual(belief.mastery);
  });

  it("is deterministic", () => {
    const a = model.observe(model.prior(), { isCorrect: true, difficulty: 0.4, bloom: 3 });
    const b = model.observe(model.prior(), { isCorrect: true, difficulty: 0.4, bloom: 3 });
    expect(a).toEqual(b);
  });
});

describe("bayesian model weights evidence by difficulty", () => {
  it("a correct hard answer moves mastery more than a correct easy answer", () => {
    const prior = bayesianModel.prior();
    const afterHard = bayesianModel.observe(prior, { isCorrect: true, difficulty: 0.9, bloom: 4 });
    const afterEasy = bayesianModel.observe(prior, { isCorrect: true, difficulty: 0.1, bloom: 2 });
    expect(afterHard.mastery).toBeGreaterThan(afterEasy.mastery);
  });
});

describe("UCB exploration bonus (deterministic)", () => {
  it("is larger for under-sampled arms", () => {
    expect(ucbBonus(0, 20)).toBeGreaterThan(ucbBonus(15, 20));
  });
  it("combines exploitation and exploration", () => {
    expect(ucbScore(0.5, 1, 10)).toBeGreaterThan(0.5);
  });
  it("is bounded to [0,1] for the bonus", () => {
    expect(ucbBonus(0, 1_000_000)).toBeLessThanOrEqual(1);
    expect(ucbBonus(10, 10)).toBeGreaterThanOrEqual(0);
  });
});
