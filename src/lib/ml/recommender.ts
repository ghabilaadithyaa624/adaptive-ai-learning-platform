/**
 * Recommendation system + personalized learning-path generator.
 *
 * Hybrid scoring blends 5 signals into a single 0-100 priority:
 *   gap magnitude, forgetting risk (recency), prerequisite readiness,
 *   path alignment and evidence confidence. Each recommendation carries the
 *   factor decomposition so the UI can explain *why* it was surfaced.
 */
import { clamp, daysBetween, MASTERY_TARGET, round } from "@/lib/utils";

export type SkillSignal = {
  skillId: number;
  skillName: string;
  subjectName: string;
  subjectColor: string;
  mastery: number;
  attempts: number;
  correct: number;
  daysSincePractice: number;
  prereqReadiness: number;
  pathAlignment: number;
  questionCount: number;
  difficultyBase: number;
};

export const RECOMMENDER_WEIGHTS = {
  gap: 0.4,
  forgetting: 0.2,
  prereq: 0.16,
  alignment: 0.12,
  confidence: 0.12,
};

export type ScoredSkill = {
  signal: SkillSignal;
  priority: number;
  confidence: number;
  factors: Record<string, number>;
  reason: string;
  action: string;
  gap: number;
};

export function scoreSkill(signal: SkillSignal, target = MASTERY_TARGET): ScoredSkill {
  const gap = clamp(target - signal.mastery, 0, 1);
  const forgetting = clamp(signal.daysSincePractice / 45);
  const prereq = clamp(signal.prereqReadiness);
  const alignment = clamp(signal.pathAlignment);
  const confidence = clamp(signal.attempts / 14);

  const factors = {
    gap: round(gap * 100, 1),
    forgetting: round(forgetting * 100, 1),
    prereq: round(prereq * 100, 1),
    alignment: round(alignment * 100, 1),
    confidence: round(confidence * 100, 1),
  };

  const raw =
    RECOMMENDER_WEIGHTS.gap * gap +
    RECOMMENDER_WEIGHTS.forgetting * forgetting +
    RECOMMENDER_WEIGHTS.prereq * prereq +
    RECOMMENDER_WEIGHTS.alignment * alignment +
    RECOMMENDER_WEIGHTS.confidence * confidence;

  const priority = round(clamp(raw * (0.7 + 0.3 * confidence)) * 100, 1) / 100;

  const drivers: { key: string; value: number; text: string }[] = [
    { key: "gap", value: gap, text: `${(gap * 100).toFixed(0)}pt mastery gap to target` },
    { key: "forgetting", value: forgetting, text: `${Math.round(signal.daysSincePractice)} days since last practice (decay risk)` },
    { key: "prereq", value: prereq, text: `prerequisite readiness ${(prereq * 100).toFixed(0)}%` },
    { key: "alignment", value: alignment, text: alignment > 0.5 ? "on the active learning path" : "outside current path order" },
    { key: "confidence", value: confidence, text: confidence < 0.3 ? "thin evidence — needs more signal" : `${signal.attempts} prior attempts logged` },
  ];
  drivers.sort((a, b) => b.value - a.value);

  const weakEvidence = signal.attempts < 4;
  const action = weakEvidence
    ? "Diagnose with a short 5-item checkpoint"
    : signal.mastery < 0.4
      ? "Rebuild foundations with scaffolded practice"
      : "Run a targeted practice set";

  return {
    signal,
    priority: Math.max(0.02, priority),
    confidence: round(confidence, 2),
    factors,
    reason: `${drivers[0].text}; ${drivers[1].text}.`,
    action,
    gap,
  };
}

export function rankSkills(signals: SkillSignal[], target = MASTERY_TARGET) {
  return signals.map((signal) => scoreSkill(signal, target)).sort((a, b) => b.priority - a.priority);
}

export function recommendReviewSkill(signals: SkillSignal[]) {
  const strongest = [...signals].sort((a, b) => b.mastery - a.mastery)[0];
  if (!strongest || strongest.daysSincePractice < 12) return null;
  const scored = scoreSkill({ ...strongest, pathAlignment: 0.4 });
  return {
    ...scored,
    reason: `Mastery is high (${(strongest.mastery * 100).toFixed(0)}%) but untouched for ${Math.round(
      strongest.daysSincePractice,
    )} days — spaced repetition window is open.`,
    action: "Schedule a 6-item refresher",
  };
}

export type PathBuildInput = {
  skills: {
    id: number;
    name: string;
    subjectName: string;
    mastery: number;
    prereqIds: number[];
    difficultyBase: number;
    attempts: number;
  }[];
  targetMastery?: number;
  maxItems?: number;
  horizonDays?: number;
};

export type BuiltMilestone = {
  skillId: number;
  name: string;
  subjectName: string;
  position: number;
  targetMastery: number;
  currentMastery: number;
  status: "locked" | "available";
  dueDate: string;
  estimatedSessions: number;
};

export function buildLearningPath(input: PathBuildInput) {
  const target = input.targetMastery ?? MASTERY_TARGET;
  const maxItems = input.maxItems ?? 6;
  const horizon = input.horizonDays ?? 42;
  const byId = new Map(input.skills.map((skill) => [skill.id, skill]));
  const gaps = input.skills
    .filter((skill) => skill.mastery < target)
    .sort((a, b) => a.mastery - b.mastery);

  // keep unmet prerequisites that block selected gap skills
  const needed = new Set<number>();
  for (const skill of gaps.slice(0, maxItems)) {
    needed.add(skill.id);
    const stack = [...skill.prereqIds];
    while (stack.length) {
      const id = stack.pop() as number;
      const prereq = byId.get(id);
      if (!prereq || prereq.mastery >= target) continue;
      if (!needed.has(id)) {
        needed.add(id);
        stack.push(...prereq.prereqIds);
      }
    }
  }

  const selected = input.skills.filter((skill) => needed.has(skill.id));
  const ordered: PathBuildInput["skills"] = [];
  const visited = new Set<number>();
  const visit = (skill: PathBuildInput["skills"][number]) => {
    if (visited.has(skill.id)) return;
    visited.add(skill.id);
    for (const prereqId of skill.prereqIds) {
      const prereq = selected.find((candidate) => candidate.id === prereqId);
      if (prereq) visit(prereq);
    }
    ordered.push(skill);
  };
  [...selected].sort((a, b) => a.mastery - b.mastery).forEach(visit);

  const trimmed = ordered.slice(0, Math.max(maxItems, 4));
  const perMilestone = Math.max(5, Math.round(horizon / Math.max(1, trimmed.length)));

  const milestones: BuiltMilestone[] = trimmed.map((skill, index) => {
    const remaining = Math.max(0, target - skill.mastery);
    const estimatedSessions = Math.max(2, Math.round(remaining * 22 + skill.difficultyBase * 5));
    const due = new Date(Date.now() + (index + 1) * perMilestone * 86_400_000);
    return {
      skillId: skill.id,
      name: skill.name,
      subjectName: skill.subjectName,
      position: index + 1,
      targetMastery: target,
      currentMastery: skill.mastery,
      status: index === 0 ? "available" : "locked",
      dueDate: due.toISOString().slice(0, 10),
      estimatedSessions,
    };
  });

  const progress =
    milestones.length === 0
      ? 0
      : clamp(
          milestones.reduce((acc, milestone) => acc + clamp(milestone.currentMastery / milestone.targetMastery), 0) /
            milestones.length,
        );

  const totalSessions = milestones.reduce((acc, milestone) => acc + milestone.estimatedSessions, 0);
  const projected = new Date(Date.now() + totalSessions * 1.5 * 86_400_000).toISOString().slice(0, 10);

  return {
    milestones,
    progress: round(progress, 2),
    projectedCompletion: projected,
    totalSessions,
  };
}

export function retentionScore(skill: { mastery: number; lastPracticedAt: Date | string | null }) {
  if (!skill.lastPracticedAt) return 0;
  const days = daysBetween(skill.lastPracticedAt);
  return round(clamp(skill.mastery * Math.exp(-0.035 * days), 0, 1), 2);
}
