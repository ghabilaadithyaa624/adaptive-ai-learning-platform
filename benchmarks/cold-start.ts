/** Held-out synthetic benchmark for cold-start diagnostics. */
import { mean, round } from "@/lib/utils";
import { posterior, DEFAULT_BKT } from "@/lib/ml/knowledge-tracing";
import { buildLearnerState, type RawSkillState } from "@/lib/ml/learner-state";
import { selectDiagnosticItem, shouldStopDiagnostic, type DiagnosticKind } from "@/lib/ml/diagnostic";
import { buildCandidatePool } from "./policies";
import { ARCHETYPES, BASE_WORLD, ITEMS, SKILLS, applyPractice, hashUniform, initialTrueState, trueProbCorrect } from "./world";

export interface ColdStartMetrics {
  estimationRmse: number;
  questions: number;
  skillCoverage: number;
  uncertaintyReduction: number;
  downstreamLearningGain: number;
}
export interface ColdStartResult { strategy: DiagnosticKind; metrics: ColdStartMetrics; cells: ColdStartMetrics[] }

function one(strategy: DiagnosticKind, archetypeIndex: number, seed: number): ColdStartMetrics {
  const archetype = ARCHETYPES[archetypeIndex];
  const truth = initialTrueState(archetype, BASE_WORLD);
  const candidates = buildCandidatePool(ITEMS);
  const states = new Map<number, { mastery: number; attempts: number; correct: number }>(SKILLS.map(s => [s.id, { mastery: .5, attempts: 0, correct: 0 }]));
  const seen = new Set<number>();
  const learner = () => buildLearnerState({
    studentId: seed,
    now: new Date("2026-01-01T00:00:00Z"),
    skillStates: SKILLS.map((s): RawSkillState => ({
      skillId: s.id, skillName: s.name, subjectName: "Math", mastery: states.get(s.id)!.mastery,
      attempts: states.get(s.id)!.attempts, correct: states.get(s.id)!.correct, streak: 0, history: [],
      lastPracticedAt: null, prereqIds: s.prereqIds, difficultyBase: s.difficultyBase,
    })),
    responses: [], context: { mode: "diagnostic", itemsAnswered: seen.size, itemTarget: 12 },
  });
  while (seen.size < 12) {
    const l = learner();
    if (shouldStopDiagnostic(l, SKILLS.map(s => s.id), seen.size)) break;
    const item = selectDiagnosticItem({ kind: strategy, learner: l, candidates, seenQuestionIds: seen, targetSkillIds: SKILLS.map(s => s.id), seed });
    if (!item) break;
    seen.add(item.questionId);
    const def = ITEMS.find(i => i.id === item.questionId)!;
    const p = trueProbCorrect({ item: def, truth, day: 0, archetype, world: BASE_WORLD });
    const correct = hashUniform(seed, def.id, 4049) < p;
    const s = states.get(def.skillId)!;
    s.mastery = posterior(s.mastery, correct, DEFAULT_BKT); s.attempts++; s.correct += Number(correct);
  }
  const finalLearner = learner();
  const rmse = Math.sqrt(mean(SKILLS.map(s => (states.get(s.id)!.mastery - truth.skills.get(s.id)!.ability) ** 2)));
  const covered = SKILLS.filter(s => states.get(s.id)!.attempts > 0).length;
  const finalUncertainty = mean([...finalLearner.skills.values()].map(s => s.uncertainty));

  // Common downstream policy: practice the estimated weakest skill, easiest
  // unseen item. Only the diagnostic state differs across strategies.
  let downstreamGain = 0;
  for (let step = 0; step < 12; step++) {
    const skillId = SKILLS.reduce((a, b) => states.get(a.id)!.mastery <= states.get(b.id)!.mastery ? a : b).id;
    const item = ITEMS.filter(i => i.skillId === skillId)[step % 10];
    const p = trueProbCorrect({ item, truth, day: 1, archetype, world: BASE_WORLD });
    const correct = hashUniform(seed, item.id, step, 9091) < p;
    const outcome = applyPractice({ item, truth, day: 1, isCorrect: correct, trueP: p, archetype, world: BASE_WORLD, minutesThisSession: step });
    downstreamGain += outcome.gain;
    const s = states.get(skillId)!; s.mastery = posterior(s.mastery, correct, DEFAULT_BKT); s.attempts++; s.correct += Number(correct);
  }
  return { estimationRmse: round(rmse, 4), questions: seen.size, skillCoverage: round(covered / SKILLS.length, 4), uncertaintyReduction: round(1 - finalUncertainty, 4), downstreamLearningGain: round(downstreamGain, 4) };
}

export function runColdStartBenchmark(): ColdStartResult[] {
  // Held-out seeds; no strategy tuning occurs on these cells.
  return (["random", "fixed", "adaptive"] as DiagnosticKind[]).map(strategy => {
    const cells = ARCHETYPES.flatMap((_, i) => [71, 89, 107].map(offset => one(strategy, i, ARCHETYPES[i].seedBase + offset)));
    return { strategy, cells, metrics: {
      estimationRmse: round(mean(cells.map(c => c.estimationRmse)), 5), questions: round(mean(cells.map(c => c.questions)), 3),
      skillCoverage: round(mean(cells.map(c => c.skillCoverage)), 5), uncertaintyReduction: round(mean(cells.map(c => c.uncertaintyReduction)), 5),
      downstreamLearningGain: round(mean(cells.map(c => c.downstreamLearningGain)), 5),
    }};
  });
}
