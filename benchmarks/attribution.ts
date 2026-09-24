/**
 * Why did one policy learn more than another?
 *
 * The world's acquisition rule is multiplicative:
 *
 *   gain = rate · zpd(p) · prereq(support) · outcome · (1 − ability)^1.15
 *
 * so the *log* of the mean gain per item decomposes additively into the four
 * levers a policy can actually pull. Taking the difference of mean log-factors
 * between two policies gives an exact attribution of the learning-rate gap:
 *
 *   Δ log ḡ  ≈  Δ(ZPD targeting) + Δ(prerequisite support) + Δ(headroom chosen)
 *               + Δ(outcome mix)
 *
 * This is the tool used to diagnose the v2 mastery-gain deficit reported in
 * `benchmarks/RESULTS.md` §6: v2 targeted the ZPD *better* than legacy and still
 * learned less, because it spent items on skills with unmet prerequisites and on
 * skills with little headroom left.
 *
 * Note that this decomposition explains the gap *between two policies*. It does
 * not explain why all of them sit far below the achievable ceiling — that is a
 * response-model calibration defect, isolated separately in
 * `benchmarks/baselines.ts` and reported in RESULTS.md §2b.2.
 */
import { mean } from "@/lib/utils";
import { WORLD_VARIANTS, SKILLS, type WorldParams } from "./world";
import type { CellResult, StepTrace } from "./simulate";

export interface FactorProfile {
  policyId: string;
  items: number;
  gainPerItem: number;
  meanZpdEfficiency: number;
  meanPrereqEfficiency: number;
  meanHeadroomFactor: number;
  meanOutcomeFactor: number;
  meanTrueP: number;
  tooHardShare: number;
  tooEasyShare: number;
  prereqViolationShare: number;
  allocation: { skillId: number; skillName: string; items: number; gain: number }[];
}

export interface AttributionResult {
  candidate: FactorProfile;
  baseline: FactorProfile;
  /** Additive decomposition of Δ log(gain per item). Positive = candidate better. */
  logGapContributions: { factor: string; contribution: number; note: string }[];
  totalLogGap: number;
  explainedLogGap: number;
}

const worldById = (id: string): WorldParams => WORLD_VARIANTS.find((w) => w.id === id) ?? WORLD_VARIANTS[0];

const safeLog = (x: number) => Math.log(Math.max(1e-6, x));

function factorsFor(trace: StepTrace, world: WorldParams) {
  const prereqEfficiency = world.prereqFloor + (1 - world.prereqFloor) * trace.prereqSupport;
  const outcome = trace.isCorrect ? 1 : world.errorLearningShare;
  const headroomFactor = Math.pow(Math.max(1e-6, 1 - trace.trueAbilityBefore), 1.15);
  return { prereqEfficiency, outcome, headroomFactor };
}

export function profilePolicy(results: CellResult[]): FactorProfile {
  const traces = results.flatMap((r) => r.trace.map((t) => ({ t, world: worldById(r.worldId) })));
  const items = traces.length || 1;
  const allocation = new Map<number, { items: number; gain: number }>();
  for (const { t } of traces) {
    const entry = allocation.get(t.skillId) ?? { items: 0, gain: 0 };
    entry.items += 1;
    entry.gain += t.gain;
    allocation.set(t.skillId, entry);
  }
  const derived = traces.map(({ t, world }) => ({ t, ...factorsFor(t, world) }));

  return {
    policyId: results[0]?.policyId ?? "unknown",
    items: traces.length,
    gainPerItem: mean(traces.map(({ t }) => t.gain)),
    meanZpdEfficiency: mean(traces.map(({ t }) => t.zpdEfficiency)),
    meanPrereqEfficiency: mean(derived.map((d) => d.prereqEfficiency)),
    meanHeadroomFactor: mean(derived.map((d) => d.headroomFactor)),
    meanOutcomeFactor: mean(derived.map((d) => d.outcome)),
    meanTrueP: mean(traces.map(({ t }) => t.trueP)),
    tooHardShare: traces.filter(({ t }) => t.trueP < 0.25).length / items,
    tooEasyShare: traces.filter(({ t }) => t.trueP > 0.93).length / items,
    prereqViolationShare: traces.filter(({ t }) => t.prereqViolation).length / items,
    allocation: SKILLS.map((s) => ({
      skillId: s.id,
      skillName: s.name,
      items: allocation.get(s.id)?.items ?? 0,
      gain: allocation.get(s.id)?.gain ?? 0,
    })),
  };
}

export function attributeGainGap(candidate: CellResult[], baseline: CellResult[]): AttributionResult {
  const candidateProfile = profilePolicy(candidate);
  const baselineProfile = profilePolicy(baseline);

  const logMean = (results: CellResult[], pick: (d: { t: StepTrace; world: WorldParams }) => number) => {
    const traces = results.flatMap((r) => r.trace.map((t) => ({ t, world: worldById(r.worldId) })));
    return mean(traces.map((entry) => safeLog(pick(entry))));
  };

  const contributions = [
    {
      factor: "ZPD targeting",
      contribution:
        logMean(candidate, ({ t }) => t.zpdEfficiency) - logMean(baseline, ({ t }) => t.zpdEfficiency),
      note: "how often items landed in the productive-difficulty band",
    },
    {
      factor: "Prerequisite support",
      contribution:
        logMean(candidate, ({ t, world }) => factorsFor(t, world).prereqEfficiency) -
        logMean(baseline, ({ t, world }) => factorsFor(t, world).prereqEfficiency),
      note: "whether the skill practised had its foundations in place",
    },
    {
      factor: "Headroom chosen",
      contribution:
        logMean(candidate, ({ t, world }) => factorsFor(t, world).headroomFactor) -
        logMean(baseline, ({ t, world }) => factorsFor(t, world).headroomFactor),
      note: "how much room to improve the targeted skill still had",
    },
    {
      factor: "Outcome mix",
      contribution:
        logMean(candidate, ({ t, world }) => factorsFor(t, world).outcome) -
        logMean(baseline, ({ t, world }) => factorsFor(t, world).outcome),
      note: "correct answers consolidate more than errors do",
    },
  ];

  const totalLogGap = safeLog(candidateProfile.gainPerItem) - safeLog(baselineProfile.gainPerItem);
  const explained = contributions.reduce((a, c) => a + c.contribution, 0);

  return {
    candidate: candidateProfile,
    baseline: baselineProfile,
    logGapContributions: contributions,
    totalLogGap,
    explainedLogGap: explained,
  };
}
