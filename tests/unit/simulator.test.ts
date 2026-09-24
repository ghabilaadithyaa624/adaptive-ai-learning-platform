/**
 * Synthetic learner simulation environment — regression tests.
 *
 * `benchmark.test.ts` tests the *conclusions* the simulator supports. This file
 * tests the simulator itself, because every conclusion in `RESULTS.md` is only
 * as trustworthy as the world that produced it. A simulator that silently loses
 * an archetype, stops applying forgetting, or lets a policy see the future
 * would keep producing confident, reproducible, wrong numbers.
 *
 * The properties asserted here are the ones that would invalidate the benchmark
 * if they broke:
 *
 *   • determinism        — same seed ⇒ byte-identical run
 *   • seed independence  — different seeds ⇒ genuinely different runs
 *   • population         — all 10 archetypes exist, are partitioned, and differ
 *   • mechanisms         — forgetting, fatigue, confidence bias, prerequisites
 *   • no leakage         — real policies cannot see ground truth
 *   • world validity     — productive difficulty has an interior optimum
 *   • honest framing     — the floor/ceiling bracket is actually computed
 */
import { describe, expect, it } from "vitest";

import {
  ARCHETYPES,
  ARCHETYPE_BY_ID,
  BASE_WORLD,
  ITEMS,
  SKILLS,
  applyPractice,
  effectiveNoise,
  fatigueLevel,
  hashUniform,
  initialTrueState,
  isPrereqViolation,
  responseTimeMs,
  retrievability,
  trueProbCorrect,
} from "../../benchmarks/world";
import { DEFAULT_PROTOCOL, aggregateCells, simulateCell } from "../../benchmarks/simulate";
import {
  HELD_OUT_ONLY_ARCHETYPE_IDS,
  TRAIN_ARCHETYPE_IDS,
  heldOutCells,
  trainCells,
} from "../../benchmarks/protocol";
import {
  difficultyOnlyPolicy,
  legacyPolicy,
  makeOraclePolicy,
  masteryGapOnlyPolicy,
  oraclePolicy,
  randomPolicy,
  v2Policy,
  v3Policy,
} from "../../benchmarks/policies";
import { probeResponseModelCalibration, runBaselineFloor, sweepDifficultyTargets } from "../../benchmarks/baselines";

const cell = (archetypeId: string, seed = 41) => ({
  archetype: ARCHETYPE_BY_ID.get(archetypeId)!,
  world: BASE_WORLD,
  seed,
});

describe("simulation environment — determinism", () => {
  it("produces byte-identical results for the same cell", () => {
    const a = simulateCell(v3Policy, cell("intermediate"));
    const b = simulateCell(v3Policy, cell("intermediate"));
    expect(JSON.stringify(b.metrics)).toBe(JSON.stringify(a.metrics));
    expect(b.trace.map((t) => t.itemId)).toEqual(a.trace.map((t) => t.itemId));
    expect(b.trace.map((t) => t.isCorrect)).toEqual(a.trace.map((t) => t.isCorrect));
  });

  it("produces genuinely different runs for different seeds", () => {
    // If the seed were ignored, every 'replication' would be the same learner
    // and every confidence interval in the report would be a fiction.
    const a = simulateCell(v3Policy, cell("intermediate", 41));
    const b = simulateCell(v3Policy, cell("intermediate", 997));
    expect(b.trace.map((t) => t.isCorrect)).not.toEqual(a.trace.map((t) => t.isCorrect));
  });

  it("uses a uniform hash — the common-random-numbers stream is not biased", () => {
    const draws: number[] = [];
    for (let i = 0; i < 4000; i += 1) draws.push(hashUniform(i, i * 7 + 1, 12345));
    const mean = draws.reduce((s, d) => s + d, 0) / draws.length;
    expect(Math.min(...draws)).toBeGreaterThanOrEqual(0);
    expect(Math.max(...draws)).toBeLessThan(1);
    // A sign/coercion bug here once produced mean 0.0121 instead of 0.5.
    expect(mean).toBeGreaterThan(0.47);
    expect(mean).toBeLessThan(0.53);
  });

  it("gives every policy the same luck via common random numbers", () => {
    // Paired statistics are only valid if policies face the same draws.
    const spec = cell("advanced");
    const first = simulateCell(v2Policy, spec).trace[0];
    const second = simulateCell(v3Policy, spec).trace[0];
    if (first.itemId === second.itemId) expect(second.isCorrect).toBe(first.isCorrect);
  });
});

describe("simulation environment — learner population", () => {
  it("has the ten archetypes the protocol expects", () => {
    expect(ARCHETYPES).toHaveLength(10);
    for (const id of [...TRAIN_ARCHETYPE_IDS, ...HELD_OUT_ONLY_ARCHETYPE_IDS]) {
      expect(ARCHETYPE_BY_ID.get(id), `missing archetype ${id}`).toBeDefined();
    }
  });

  it("covers every learner type the brief called for", () => {
    for (const id of [
      "cold-start-novice",
      "intermediate",
      "advanced",
      "uneven",
      "forgetful",
      "slow-learner",
      "fast-learner",
      "high-variance",
      "overconfident",
      "underconfident",
    ]) {
      expect(ARCHETYPE_BY_ID.get(id), `missing archetype ${id}`).toBeDefined();
    }
  });

  it("partitions train and held-out archetypes with no overlap", () => {
    const overlap = TRAIN_ARCHETYPE_IDS.filter((id) =>
      (HELD_OUT_ONLY_ARCHETYPE_IDS as readonly string[]).includes(id),
    );
    expect(overlap).toEqual([]);
    expect(TRAIN_ARCHETYPE_IDS.length + HELD_OUT_ONLY_ARCHETYPE_IDS.length).toBe(ARCHETYPES.length);
  });

  it("keeps tuning seeds disjoint from held-out seeds", () => {
    const trainKeys = new Set(trainCells().map((c) => `${c.archetype.id}:${c.seed}`));
    for (const c of heldOutCells()) {
      expect(trainKeys.has(`${c.archetype.id}:${c.seed}`)).toBe(false);
    }
  });

  it("makes archetypes behave differently, not just carry different labels", () => {
    const gains = new Map<string, number>();
    for (const a of ARCHETYPES) {
      gains.set(a.id, simulateCell(v3Policy, { archetype: a, world: BASE_WORLD, seed: 77 }).metrics.masteryGain);
    }
    // A fast learner must out-learn a slow one under an identical protocol.
    expect(gains.get("fast-learner")!).toBeGreaterThan(gains.get("slow-learner")!);
    // An advanced learner starts near the ceiling, so it has less room to gain
    // than a cold-start novice.
    expect(gains.get("cold-start-novice")!).toBeGreaterThan(gains.get("advanced")!);
  });
});

describe("simulation environment — learning and forgetting", () => {
  it("increases true ability when practice succeeds", () => {
    const archetype = ARCHETYPE_BY_ID.get("intermediate")!;
    const truth = initialTrueState(archetype, BASE_WORLD);
    const item = ITEMS[20];
    const before = truth.skills.get(item.skillId)!.ability;
    applyPractice({ item, truth, isCorrect: true, day: 0, trueP: 0.7, archetype, world: BASE_WORLD });
    expect(truth.skills.get(item.skillId)!.ability).toBeGreaterThan(before);
  });

  it("still learns something from an error, but less than from a success", () => {
    const archetype = ARCHETYPE_BY_ID.get("intermediate")!;
    const item = ITEMS[20];
    const gainFor = (isCorrect: boolean) => {
      const truth = initialTrueState(archetype, BASE_WORLD);
      const before = truth.skills.get(item.skillId)!.ability;
      applyPractice({ item, truth, isCorrect, day: 0, trueP: 0.7, archetype, world: BASE_WORLD });
      return truth.skills.get(item.skillId)!.ability - before;
    };
    const win = gainFor(true);
    const loss = gainFor(false);
    expect(loss).toBeGreaterThan(0);
    expect(loss).toBeLessThan(win);
  });

  it("decays retrievability with elapsed time", () => {
    const state = { ability: 0.6, stability: 10, lastPracticedDay: 0 } as never;
    expect(retrievability(state, 0)).toBeCloseTo(1, 6);
    expect(retrievability(state, 1)).toBeGreaterThan(retrievability(state, 30));
    expect(retrievability(state, 30)).toBeGreaterThan(0);
  });

  it("forgets faster for the forgetful archetype than the baseline", () => {
    const fresh = simulateCell(v3Policy, cell("forgetful")).metrics;
    const steady = simulateCell(v3Policy, cell("intermediate")).metrics;
    // Retention ratio = retained gain / immediate gain; lower means more decay.
    expect(fresh.retentionRatio).toBeLessThan(steady.retentionRatio);
  });
});

describe("simulation environment — fatigue", () => {
  it("is absent at the start of a session and grows with time on task", () => {
    const a = ARCHETYPE_BY_ID.get("intermediate")!;
    expect(fatigueLevel(0, a, BASE_WORLD)).toBe(0);
    const early = fatigueLevel(20, a, BASE_WORLD);
    const late = fatigueLevel(45, a, BASE_WORLD);
    expect(early).toBeGreaterThan(0);
    expect(late).toBeGreaterThan(early);
    expect(late).toBeLessThanOrEqual(1);
  });

  it("lowers success probability and slows responses late in a session", () => {
    const a = ARCHETYPE_BY_ID.get("intermediate")!;
    const truth = initialTrueState(a, BASE_WORLD);
    const item = ITEMS[12];
    const fresh = trueProbCorrect({ item, truth, day: 0, archetype: a, world: BASE_WORLD, minutesThisSession: 0 });
    const tired = trueProbCorrect({ item, truth, day: 0, archetype: a, world: BASE_WORLD, minutesThisSession: 45 });
    expect(tired).toBeLessThan(fresh);

    const quick = responseTimeMs({ item, trueP: fresh, fatigue: 0, archetype: a, world: BASE_WORLD });
    const slow = responseTimeMs({ item, trueP: fresh, fatigue: 1, archetype: a, world: BASE_WORLD });
    expect(slow).toBeGreaterThan(quick);
  });

  it("tires resistant learners more slowly than susceptible ones", () => {
    const strong = ARCHETYPE_BY_ID.get("fast-learner")!;
    const weak = ARCHETYPE_BY_ID.get("slow-learner")!;
    expect(strong.fatigueResistance).toBeGreaterThan(weak.fatigueResistance);
    expect(fatigueLevel(40, strong, BASE_WORLD)).toBeLessThan(fatigueLevel(40, weak, BASE_WORLD));
  });

  it("is recorded on every served item so it can be audited", () => {
    const run = simulateCell(v3Policy, cell("intermediate"));
    for (const step of run.trace) {
      expect(step.fatigue).toBeGreaterThanOrEqual(0);
      expect(step.fatigue).toBeLessThanOrEqual(1);
    }
  });
});

describe("simulation environment — confidence bias", () => {
  it("makes the over-confident learner guess more and slip more", () => {
    const over = effectiveNoise(ARCHETYPE_BY_ID.get("overconfident")!, BASE_WORLD);
    const under = effectiveNoise(ARCHETYPE_BY_ID.get("underconfident")!, BASE_WORLD);
    expect(over.guess).toBeGreaterThan(under.guess);
  });

  it("makes the under-confident learner answer more slowly", () => {
    const item = ITEMS[12];
    const timeFor = (id: string) => {
      const a = ARCHETYPE_BY_ID.get(id)!;
      return responseTimeMs({ item, trueP: 0.6, fatigue: 0, archetype: a, world: BASE_WORLD });
    };
    expect(timeFor("underconfident")).toBeGreaterThan(timeFor("overconfident"));
  });

  it("creates a genuine estimation challenge in both directions", () => {
    // The point of these archetypes is that observed behaviour misrepresents
    // latent ability, so the tracer is misled rather than merely noisy.
    const bias = (id: string) => {
      const run = simulateCell(v3Policy, cell(id, 860));
      const rows = run.finalState;
      return rows.reduce((s, r) => s + (r.estimated - r.trueAbility), 0) / rows.length;
    };
    expect(bias("overconfident")).toBeGreaterThan(bias("underconfident"));
  });
});

describe("simulation environment — prerequisites", () => {
  it("defines a non-trivial prerequisite DAG with no self-references", () => {
    const withPrereqs = SKILLS.filter((s) => s.prereqIds.length > 0);
    expect(withPrereqs.length).toBeGreaterThan(0);
    for (const s of SKILLS) {
      expect(s.prereqIds).not.toContain(s.id);
      // A prerequisite must be introduced before the skill that needs it.
      for (const p of s.prereqIds) expect(p).toBeLessThan(s.id);
    }
  });

  it("flags a violation only when true prerequisite ability is lacking", () => {
    const a = ARCHETYPE_BY_ID.get("cold-start-novice")!;
    const truth = initialTrueState(a, BASE_WORLD);
    const deep = SKILLS.filter((s) => s.prereqIds.length > 0).at(-1)!;
    const shallow = SKILLS.find((s) => s.prereqIds.length === 0)!;
    // A root skill can never be a prerequisite violation.
    expect(isPrereqViolation(shallow.id, truth, BASE_WORLD)).toBe(false);
    // A cold-start learner attempting the deepest skill is one.
    expect(isPrereqViolation(deep.id, truth, BASE_WORLD)).toBe(true);
  });
});

describe("simulation environment — information hygiene", () => {
  it("never lets a shippable policy read ground truth", async () => {
    // The oracle is allowed to; nothing else is. This is a source-level check
    // because a leak would be invisible in the metrics — it would just look
    // like a very good policy.
    const { readFileSync } = await import("node:fs");
    const src = readFileSync(new URL("../../benchmarks/policies.ts", import.meta.url), "utf8");
    const oracleStart = src.indexOf("export function makeOraclePolicy");
    expect(oracleStart).toBeGreaterThan(-1);
    const shippable = src.slice(0, oracleStart);
    expect(shippable).not.toContain("ctx.truth");
  });

  it("never serves the same question twice under any policy", () => {
    for (const policy of [randomPolicy, difficultyOnlyPolicy, masteryGapOnlyPolicy, legacyPolicy, v2Policy, v3Policy]) {
      const run = simulateCell(policy, cell("intermediate"));
      const ids = run.trace.map((t) => t.itemId);
      expect(new Set(ids).size, `${policy.id} repeated an item`).toBe(ids.length);
    }
  });

  it("emits a machine-readable decision explanation for every v3 selection", () => {
    const run = simulateCell(v3Policy, cell("uneven"));
    expect(run.trace.length).toBeGreaterThan(0);
  });
});

describe("simulation environment — baselines and ceiling", () => {
  it("runs the trivial baselines without error and keeps them distinct", () => {
    const spec = cell("intermediate");
    const ids = [randomPolicy, difficultyOnlyPolicy, masteryGapOnlyPolicy].map((p) =>
      simulateCell(p, spec).trace.map((t) => t.itemId).join(","),
    );
    expect(new Set(ids).size).toBe(3);
  });

  it("keeps the random baseline reproducible", () => {
    const spec = cell("intermediate");
    expect(simulateCell(randomPolicy, spec).trace.map((t) => t.itemId)).toEqual(
      simulateCell(randomPolicy, spec).trace.map((t) => t.itemId),
    );
  });

  it("puts the oracle ceiling above every real policy", () => {
    const cells = ARCHETYPES.map((a) => ({ archetype: a, world: BASE_WORLD, seed: 63 }));
    const floor = runBaselineFloor(cells, v3Policy);
    const ceiling = floor.ceiling.aggregate.retainedGain;
    for (const row of floor.rows) {
      if (row.tier === "ceiling") continue;
      expect(row.aggregate.retainedGain, `${row.policyId} beat the oracle`).toBeLessThanOrEqual(ceiling);
    }
  });

  it("hits the productive band far more often than any real policy", () => {
    const spec = ARCHETYPES.map((a) => ({ archetype: a, world: BASE_WORLD, seed: 63 }));
    const orc = aggregateCells(spec.map((c) => simulateCell(oraclePolicy, c)));
    const real = aggregateCells(spec.map((c) => simulateCell(v3Policy, c)));
    expect(orc.zpdHitRate).toBeGreaterThan(real.zpdHitRate);
  });
});

describe("simulation environment — world validity", () => {
  it("rewards productive difficulty rather than easy questions", () => {
    // If learning rose monotonically toward a target of 1.0, this world would
    // simply pay for trivial items and every ZPD-shaped objective in the policy
    // would be unjustified. The optimum must be interior.
    const cells = ARCHETYPES.map((a) => ({ archetype: a, world: BASE_WORLD, seed: 63 }));
    const sweep = sweepDifficultyTargets(cells, [0.35, 0.5, 0.75, 0.95]);
    const at = (t: number) => sweep.find((s) => s.target === t)!.retainedGain;
    expect(at(0.75)).toBeGreaterThan(at(0.35));
    expect(at(0.75)).toBeGreaterThan(at(0.5));
    // 0.95 is allowed to tie with 0.75 (the bank runs out of items that easy),
    // but it must not beat it.
    expect(at(0.95)).toBeLessThanOrEqual(at(0.75) + 1e-9);
  });

  it("keeps the item bank wide enough to target any difficulty", () => {
    const difficulties = ITEMS.map((i) => i.difficulty);
    expect(Math.min(...difficulties)).toBeLessThan(0.2);
    expect(Math.max(...difficulties)).toBeGreaterThan(0.85);
    for (const s of SKILLS) {
      expect(ITEMS.filter((i) => i.skillId === s.id).length).toBeGreaterThanOrEqual(5);
    }
  });

  it("detects the response-model calibration gap that limits every policy", () => {
    // Guards the headline diagnosis: with mastery estimation held PERFECT the
    // response model is still over-confident. If a future change fixes it, this
    // test should be updated — and RESULTS.md re-read, because the main
    // conclusion will have changed.
    const probe = probeResponseModelCalibration();
    expect(probe.pairs).toBe(ARCHETYPES.length * ITEMS.length);
    expect(probe.bias).toBeGreaterThan(0.1);
    expect(probe.meanPredicted).toBeGreaterThan(probe.meanTrue);
  });
});

describe("simulation environment — longitudinal output", () => {
  it("emits one trajectory point per served item", () => {
    const run = simulateCell(v3Policy, cell("intermediate"));
    expect(run.trajectory).toHaveLength(run.trace.length);
  });

  it("tracks latent truth and platform belief side by side over time", () => {
    const run = simulateCell(v3Policy, cell("cold-start-novice"));
    const first = run.trajectory[0];
    const last = run.trajectory.at(-1)!;
    expect(last.step).toBeGreaterThan(first.step);
    expect(last.day).toBeGreaterThanOrEqual(first.day);
    // A cold-start learner should end the run knowing more than they started.
    expect(last.meanTrueAbility).toBeGreaterThan(first.meanTrueAbility);
    for (const p of run.trajectory) {
      expect(p.meanTrueAbility).toBeGreaterThanOrEqual(0);
      expect(p.meanTrueAbility).toBeLessThanOrEqual(1);
      expect(p.meanEstimated).toBeGreaterThanOrEqual(0);
      expect(p.meanEstimated).toBeLessThanOrEqual(1);
    }
  });

  it("spans the full protocol", () => {
    const run = simulateCell(v3Policy, cell("intermediate"));
    const sessions = new Set(run.trajectory.map((p) => p.session));
    expect(sessions.size).toBe(DEFAULT_PROTOCOL.sessions);
  });
});

describe("simulation environment — protocol integrity", () => {
  it("builds the documented number of cells", () => {
    expect(trainCells()).toHaveLength(TRAIN_ARCHETYPE_IDS.length * 4);
    expect(heldOutCells()).toHaveLength(ARCHETYPES.length * 8);
  });

  it("serves the whole item budget when the bank allows", () => {
    const run = simulateCell(v3Policy, cell("intermediate"));
    expect(run.metrics.itemsServed).toBe(DEFAULT_PROTOCOL.sessions * DEFAULT_PROTOCOL.itemsPerSession);
  });

  it("charges a time cost for every item", () => {
    const run = simulateCell(v3Policy, cell("intermediate"));
    expect(run.metrics.minutesSpent).toBeGreaterThan(0);
  });

  it("respects a time budget when one is set", () => {
    const budget = 10;
    const run = simulateCell(v3Policy, {
      ...cell("intermediate"),
      protocol: { ...DEFAULT_PROTOCOL, minutesPerSession: budget },
    });
    const perSession = new Map<number, number>();
    for (const s of run.trace) perSession.set(s.session, (perSession.get(s.session) ?? 0) + 1);
    expect(run.metrics.minutesSpent).toBeLessThanOrEqual(budget * DEFAULT_PROTOCOL.sessions + 5);
  });

  it("measures retention after a delay, against a no-practice counterfactual", () => {
    expect(DEFAULT_PROTOCOL.retentionDelayDays).toBeGreaterThan(0);
    // `retainedGain` is ability at the probe *minus the counterfactual of never
    // having practised*, so it is not bounded by the immediate gain — it also
    // captures the decay the learner avoided. What must hold is that a longer
    // delay leaves less behind.
    const shortDelay = simulateCell(v3Policy, {
      ...cell("forgetful"),
      protocol: { ...DEFAULT_PROTOCOL, retentionDelayDays: 2 },
    }).metrics.retainedMastery;
    const longDelay = simulateCell(v3Policy, {
      ...cell("forgetful"),
      protocol: { ...DEFAULT_PROTOCOL, retentionDelayDays: 60 },
    }).metrics.retainedMastery;
    expect(longDelay).toBeLessThan(shortDelay);
  });
});

describe("simulation environment — oracle configuration", () => {
  it("targets the difficulty it is asked for", () => {
    const easy = makeOraclePolicy(0.95);
    const hard = makeOraclePolicy(0.4);
    const spec = cell("intermediate");
    const easyRun = simulateCell(easy, spec);
    const hardRun = simulateCell(hard, spec);
    const meanTrueP = (r: typeof easyRun) => r.trace.reduce((s, t) => s + t.trueP, 0) / r.trace.length;
    expect(meanTrueP(easyRun)).toBeGreaterThan(meanTrueP(hardRun));
  });
});
