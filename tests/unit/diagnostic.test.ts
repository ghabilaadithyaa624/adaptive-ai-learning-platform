import { describe, expect, it } from "vitest";
import { buildLearnerState, type RawSkillState } from "@/lib/ml/learner-state";
import { selectDiagnosticItem, shouldStopDiagnostic } from "@/lib/ml/diagnostic";
import { runColdStartBenchmark } from "../../benchmarks/cold-start";
import type { CandidateItem } from "@/lib/ml/interfaces";

const raw = (id: number, prereqIds: number[] = [], attempts = 0): RawSkillState => ({
  skillId: id, skillName: `S${id}`, subjectName: "Math", mastery: .5, attempts, correct: 0, streak: 0,
  history: [], lastPracticedAt: null, prereqIds, difficultyBase: .5,
});
const candidates: CandidateItem[] = [
  { questionId: 1, skillId: 1, skillName: "S1", subjectName: "Math", item: { difficulty: .5, bloom: 2, discrimination: 1.2 }, estimatedSeconds: 30, text: "foundation" },
  { questionId: 2, skillId: 2, skillName: "S2", subjectName: "Math", item: { difficulty: .5, bloom: 2, discrimination: 1 }, estimatedSeconds: 30, text: "dependent" },
];
function learner(states = [raw(1), raw(2, [1])]) { return buildLearnerState({ studentId: 1, skillStates: states, responses: [] }); }

describe("cold-start diagnostic", () => {
  it("samples an unseen prerequisite foundation first without receiving an answer key", () => {
    const selected = selectDiagnosticItem({ kind: "adaptive", learner: learner(), candidates, seenQuestionIds: new Set(), targetSkillIds: [1, 2] });
    expect(selected?.skillId).toBe(1);
    expect(selected).not.toHaveProperty("correctIndex");
  });
  it("broadens coverage after a foundation has evidence", () => {
    const selected = selectDiagnosticItem({ kind: "adaptive", learner: learner([raw(1, [], 1), raw(2, [1])]), candidates, seenQuestionIds: new Set([1]), targetSkillIds: [1, 2] });
    expect(selected?.skillId).toBe(2);
  });
  it("does not stop early from low scores; breadth and uncertainty are required", () => {
    expect(shouldStopDiagnostic(learner(), [1, 2], 6)).toBe(false);
    expect(shouldStopDiagnostic(learner([raw(1, [], 3), raw(2, [1], 3)]), [1, 2], 6)).toBe(true);
  });
  it("reports held-out evidence without asserting unsupported adaptive superiority", () => {
    const rows = runColdStartBenchmark();
    const adaptive = rows.find(r => r.strategy === "adaptive")!.metrics;
    const random = rows.find(r => r.strategy === "random")!.metrics;
    expect(adaptive.questions).toBeLessThanOrEqual(random.questions);
    expect(adaptive.skillCoverage).toBeGreaterThanOrEqual(.75);
    // Current evidence does not show better downstream learning; preserve this
    // failure honestly until a principled strategy changes it.
    expect(adaptive.downstreamLearningGain).toBeLessThanOrEqual(random.downstreamLearningGain);
  });
});
