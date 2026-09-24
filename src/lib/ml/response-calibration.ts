/**
 * Response-probability calibration.
 *
 * Calibration is deliberately separate from the response model: the model ranks
 * learner/item pairs; a versioned calibrator maps its raw probability to an
 * empirically reliable probability. Fitting is deterministic and side-effect
 * free. Nothing in this module promotes an artifact to production.
 */
import { clamp } from "@/lib/utils";
import type { ResponseContext, ResponseModel } from "./interfaces";
import { brierScore, calibration as calibrationMetrics } from "./evaluation";

const EPS = 1e-6;
const logit = (p: number) => Math.log(clamp(p, EPS, 1 - EPS) / (1 - clamp(p, EPS, 1 - EPS)));
const sigmoid = (x: number) => 1 / (1 + Math.exp(-clamp(x, -30, 30)));

export type CalibrationSource = "synthetic" | "offline-historical" | "production";

/** Versioned, auditable Platt scaling artifact: sigmoid(intercept + slope*logit(p)). */
export interface ResponseCalibrator {
  kind: "identity" | "platt";
  version: string;
  source: CalibrationSource;
  slope: number;
  intercept: number;
  samples: number;
  trainedThrough?: string;
  heldOutLearners?: boolean;
}

export const IDENTITY_CALIBRATOR: ResponseCalibrator = {
  kind: "identity", version: "identity-v1", source: "offline-historical", slope: 1, intercept: 0, samples: 0,
};

export interface ResponseTelemetry {
  rawProbability: number;
  isCorrect: boolean;
  occurredAt: string | Date;
  learnerId: string | number;
  skillId?: string | number;
  difficulty?: number;
  bloom?: number;
  cohort?: string;
  /** True for learners with insufficient prior evidence at prediction time. */
  coldStart?: boolean;
}

export function calibrateResponseProbability(rawProbability: number, calibrator: ResponseCalibrator = IDENTITY_CALIBRATOR): number {
  const p = clamp(rawProbability, EPS, 1 - EPS);
  if (calibrator.kind === "identity") return p;
  return clamp(sigmoid(calibrator.intercept + calibrator.slope * logit(p)), 0.01, 0.99);
}

/** Stable public prediction entry point used by selectors and other consumers. */
export function predictResponseProbability(model: ResponseModel, context: ResponseContext): number {
  return clamp(model.predict(context), 0.01, 0.99);
}

/** Keeps serving deterministic while making raw and calibrated models composable. */
export class CalibratedResponseModel implements ResponseModel {
  readonly id: string;
  constructor(readonly rawModel: ResponseModel, readonly calibrator: ResponseCalibrator) {
    this.id = `${rawModel.id}+cal:${calibrator.version}`;
  }
  predict(context: ResponseContext): number {
    return calibrateResponseProbability(this.rawModel.predict(context), this.calibrator);
  }
}

/**
 * Fit Platt scaling. Callers must provide training rows only; split helpers below
 * prevent learner and future leakage. Synthetic artifacts must never be relabeled
 * or promoted as production artifacts.
 */
export function fitResponseCalibrator(
  rows: ResponseTelemetry[],
  meta: { version: string; source: CalibrationSource; trainedThrough?: string; heldOutLearners?: boolean },
): ResponseCalibrator {
  if (rows.length < 30) return { ...IDENTITY_CALIBRATOR, version: meta.version, source: meta.source, samples: rows.length, trainedThrough: meta.trainedThrough, heldOutLearners: meta.heldOutLearners };
  let slope = 1;
  let intercept = 0;
  const x = rows.map((r) => logit(r.rawProbability));
  for (let epoch = 0; epoch < 1200; epoch += 1) {
    let ga = 0, gb = 0;
    for (let i = 0; i < rows.length; i += 1) {
      const error = sigmoid(intercept + slope * x[i]) - Number(rows[i].isCorrect);
      ga += error * x[i]; gb += error;
    }
    const lr = 0.08 / Math.sqrt(1 + epoch / 80);
    // weak regularisation toward identity avoids unstable small-sample mappings
    slope -= lr * (ga / rows.length + 0.001 * (slope - 1));
    intercept -= lr * (gb / rows.length + 0.001 * intercept);
  }
  return { kind: "platt", version: meta.version, source: meta.source, slope, intercept, samples: rows.length, trainedThrough: meta.trainedThrough, heldOutLearners: meta.heldOutLearners };
}

export interface ReliabilitySlice {
  key: string;
  samples: number;
  meanPredicted: number;
  observedCorrect: number;
  brier: number;
  ece: number;
  mce: number;
}
export interface ResponseCalibrationReport extends ReliabilitySlice {
  reliability: ReturnType<typeof calibrationMetrics>["reliability"];
  byDifficulty: ReliabilitySlice[];
  bySkill: ReliabilitySlice[];
  byCohort: ReliabilitySlice[];
  byBloom: ReliabilitySlice[];
  coldStart: ReliabilitySlice[];
}

function summarize(key: string, rows: ResponseTelemetry[], calibrator: ResponseCalibrator, bins: number): ReliabilitySlice {
  const labels = rows.map((r) => Number(r.isCorrect));
  const scores = rows.map((r) => calibrateResponseProbability(r.rawProbability, calibrator));
  const c = calibrationMetrics(labels, scores, bins);
  return { key, samples: rows.length, meanPredicted: scores.reduce((a, b) => a + b, 0) / (rows.length || 1), observedCorrect: labels.reduce((a, b) => a + b, 0) / (rows.length || 1), brier: brierScore(labels, scores), ece: c.ece, mce: c.mce };
}
function grouped(rows: ResponseTelemetry[], key: (r: ResponseTelemetry) => string, c: ResponseCalibrator, bins: number) {
  const groups = new Map<string, ResponseTelemetry[]>();
  for (const row of rows) groups.set(key(row), [...(groups.get(key(row)) ?? []), row]);
  return [...groups.entries()].sort(([a], [b]) => a.localeCompare(b)).map(([k, rs]) => summarize(k, rs, c, bins));
}

/** Full predicted-vs-observed reliability report, including required slices. */
export function evaluateResponseCalibration(rows: ResponseTelemetry[], calibrator: ResponseCalibrator = IDENTITY_CALIBRATOR, bins = 10): ResponseCalibrationReport {
  const overall = summarize("overall", rows, calibrator, bins);
  const labels = rows.map((r) => Number(r.isCorrect));
  const scores = rows.map((r) => calibrateResponseProbability(r.rawProbability, calibrator));
  return {
    ...overall,
    reliability: calibrationMetrics(labels, scores, bins).reliability,
    byDifficulty: grouped(rows, r => r.difficulty == null ? "unknown" : r.difficulty < .35 ? "easy" : r.difficulty < .7 ? "medium" : "hard", calibrator, bins),
    bySkill: grouped(rows, r => String(r.skillId ?? "unknown"), calibrator, bins),
    byCohort: grouped(rows, r => r.cohort ?? "unknown", calibrator, bins),
    byBloom: grouped(rows, r => String(r.bloom ?? "unknown"), calibrator, bins),
    coldStart: grouped(rows, r => r.coldStart ? "cold-start" : "established", calibrator, bins),
  };
}

/** Chronological split with an optional strict held-out-learner test set. */
export function splitCalibrationTelemetry(rows: ResponseTelemetry[], heldOutLearners: Array<string | number> = [], trainRatio = .8) {
  const held = new Set(heldOutLearners.map(String));
  const ordered = [...rows].sort((a, b) => new Date(a.occurredAt).getTime() - new Date(b.occurredAt).getTime());
  const eligible = ordered.filter(r => !held.has(String(r.learnerId)));
  const cut = Math.floor(eligible.length * trainRatio);
  const train = eligible.slice(0, cut);
  const chronologicalTest = eligible.slice(cut);
  const learnerTest = ordered.filter(r => held.has(String(r.learnerId)));
  return { train, chronologicalTest, learnerTest };
}
