/**
 * Knowledge-gap detection.
 *
 * Combines three statistical signals into a supervised-style severity
 * classification (rule + score hybrid, the same way production rules engines
 * wrap a classifier): mastery shortfall, Wilson lower bound of observed
 * accuracy and time-based decay. Prerequisite gaps escalate severity.
 */
import { clamp, round } from "@/lib/utils";

export function wilsonLowerBound(successes: number, total: number, z = 1.64) {
  if (total <= 0) return 0;
  const phat = successes / total;
  const denom = 1 + (z * z) / total;
  const center = phat + (z * z) / (2 * total);
  const spread = z * Math.sqrt((phat * (1 - phat)) / total + (z * z) / (4 * total * total));
  return clamp((center - spread) / denom, 0, 1);
}

export type GapSeverity = "critical" | "high" | "moderate" | "watch" | "healthy";

export type GapInput = {
  skillId: number;
  skillName: string;
  subjectName: string;
  mastery: number;
  attempts: number;
  correct: number;
  daysSincePractice: number;
  prereqGaps: number;
  target?: number;
};

export type GapReadout = {
  input: GapInput;
  severity: GapSeverity;
  severityScore: number;
  shortfall: number;
  accuracy: number;
  confidenceBound: number;
  decayRisk: number;
  drivers: string[];
  recommendation: string;
};

const SEVERITY_META: Record<GapSeverity, { min: number; action: string }> = {
  critical: { min: 0.62, action: "Re-teach foundations immediately and lock downstream skills" },
  high: { min: 0.46, action: "Assign a scaffolded remediation set this week" },
  moderate: { min: 0.3, action: "Queue targeted practice after current milestone" },
  watch: { min: 0.16, action: "Monitor — low evidence, schedule a 5-item checkpoint" },
  healthy: { min: 0, action: "Maintain with spaced review" },
};

export function classifyGap(input: GapInput): GapReadout {
  const target = input.target ?? 0.85;
  const shortfall = clamp(target - input.mastery, 0, 1);
  const accuracy = input.attempts > 0 ? input.correct / input.attempts : 0;
  const confidenceBound = wilsonLowerBound(input.correct, input.attempts);
  const decayRisk = clamp(input.daysSincePractice / 45);

  const evidenceWeight = clamp(input.attempts / 10) * 0.5 + 0.5;
  const raw =
    shortfall * 0.5 * evidenceWeight +
    clamp(1 - confidenceBound) * 0.22 +
    decayRisk * 0.16 +
    clamp(input.prereqGaps / 3) * 0.12;

  const severityScore = round(clamp(raw), 3);
  const severity = (Object.keys(SEVERITY_META) as GapSeverity[]).find(
    (key) => severityScore >= SEVERITY_META[key].min,
  ) ?? "healthy";

  const drivers: string[] = [];
  drivers.push(`${(shortfall * 100).toFixed(0)}pt shortfall against the ${(target * 100).toFixed(0)}% mastery target`);
  if (input.attempts > 0) drivers.push(`observed accuracy ${(accuracy * 100).toFixed(0)}% over ${input.attempts} items`);
  if (input.attempts < 4) drivers.push("weak evidence — fewer than 4 observed responses");
  if (decayRisk > 0.4) drivers.push(`${Math.round(input.daysSincePractice)} days since practice, retention decaying`);
  if (input.prereqGaps > 0) drivers.push(`${input.prereqGaps} upstream prerequisite gap${input.prereqGaps > 1 ? "s" : ""}`);

  return {
    input,
    severity,
    severityScore,
    shortfall: round(shortfall, 3),
    accuracy: round(accuracy, 3),
    confidenceBound: round(confidenceBound, 3),
    decayRisk: round(decayRisk, 3),
    drivers,
    recommendation: SEVERITY_META[severity].action,
  };
}

export const severityTone: Record<GapSeverity, "rose" | "amber" | "sky" | "emerald" | "violet"> = {
  critical: "rose",
  high: "amber",
  moderate: "amber",
  watch: "sky",
  healthy: "emerald",
};

export const severityLabel: Record<GapSeverity, string> = {
  critical: "Critical gap",
  high: "High risk",
  moderate: "Moderate gap",
  watch: "Watch",
  healthy: "Healthy",
};
