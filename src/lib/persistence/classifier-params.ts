/**
 * Parser for `ml_models.params` of the difficulty/correctness classifier.
 *
 * What this protects: `loadClassifier` used to read the JSONB column as
 * `Partial<ClassifierModel>` and check only `params?.weights?.length`. Under
 * that check a payload of `{ weights: ["0.4", null] }` passes, the strings flow
 * into `predictWithFeatures`, and `z` becomes `NaN` — every learner then gets a
 * clamped 0.99 success probability and adaptive selection quietly degenerates.
 * Nothing logs, nothing alerts, and the model page still shows a trained model.
 *
 * Versioning: payloads written before this parser existed carry no schema
 * version. They are *legacy but valid* and continue to load as
 * `CLASSIFIER_PARAMS_V1` — the parser must not orphan the currently-deployed
 * registry row. Writers stamp `schemaVersion` going forward so a future shape
 * change is detectable instead of guessable.
 */
import { FEATURE_NAMES, type ClassifierModel } from "@/lib/ml/classifier";
import type { ResponseCalibrator } from "@/lib/ml/response-calibration";
import {
  expectEnum,
  expectFiniteNumber,
  expectInteger,
  expectNumberArray,
  expectObject,
  expectString,
  expectStringArray,
  fail,
  optional,
  resolveVersion,
  runParser,
  type ParseResult,
} from "./result";

export const CLASSIFIER_PARAMS_BOUNDARY = "ml_models.params:classifier";

/** Current on-disk shape of the classifier parameter payload. */
export const CLASSIFIER_PARAMS_V1 = "clf-params-v1";
export const SUPPORTED_CLASSIFIER_PARAM_VERSIONS = [CLASSIFIER_PARAMS_V1] as const;

/** Guards against a corrupted length field allocating unbounded work. */
const MAX_FEATURES = 256;

export interface PersistedClassifierParams {
  schemaVersion: string;
  featureNames: string[];
  weights: number[];
  means: number[];
  stds: number[];
  calibration?: ResponseCalibrator;
}

const CALIBRATOR_KINDS = ["identity", "platt"] as const;
const CALIBRATION_SOURCES = ["synthetic", "offline-historical", "production"] as const;

/**
 * The calibrator rescales every served probability. A malformed one is worse
 * than none at all, so it is parsed strictly and a failure invalidates the whole
 * params payload rather than being dropped — silently discarding a calibrator
 * would change served predictions with no trace.
 */
function parseCalibrator(value: unknown, path: string): ResponseCalibrator {
  const obj = expectObject(value, path);
  const kind = expectEnum(obj.kind, CALIBRATOR_KINDS, `${path}.kind`);
  const calibrator: ResponseCalibrator = {
    kind,
    version: expectString(obj.version, `${path}.version`, { max: 128 }),
    source: expectEnum(obj.source, CALIBRATION_SOURCES, `${path}.source`),
    slope: expectFiniteNumber(obj.slope, `${path}.slope`),
    intercept: expectFiniteNumber(obj.intercept, `${path}.intercept`),
    samples: expectInteger(obj.samples, `${path}.samples`, { min: 0 }),
  };
  const trainedThrough = optional(obj.trainedThrough, () =>
    expectString(obj.trainedThrough, `${path}.trainedThrough`, { max: 64 }),
  );
  if (trainedThrough !== undefined) calibrator.trainedThrough = trainedThrough;
  const heldOut = optional(obj.heldOutLearners, () => {
    if (typeof obj.heldOutLearners !== "boolean") {
      fail({ code: "WRONG_TYPE", path: `${path}.heldOutLearners`, message: "expected a boolean" });
    }
    return obj.heldOutLearners;
  });
  if (heldOut !== undefined) calibrator.heldOutLearners = heldOut;

  // A Platt calibrator with zero slope maps every input to one constant
  // probability. That is never a fitted result; it is corruption.
  if (kind === "platt" && calibrator.slope === 0) {
    fail({
      code: "OUT_OF_RANGE",
      path: `${path}.slope`,
      message: "a platt calibrator with zero slope would collapse all predictions to a constant",
    });
  }
  return calibrator;
}

export function parseClassifierParams(raw: unknown): ParseResult<PersistedClassifierParams> {
  return runParser(CLASSIFIER_PARAMS_BOUNDARY, () => {
    const obj = expectObject(raw, "$");

    const schemaVersion = resolveVersion(obj, "$", {
      field: "schemaVersion",
      supported: SUPPORTED_CLASSIFIER_PARAM_VERSIONS,
      legacyDefault: CLASSIFIER_PARAMS_V1,
    });

    const weights = expectNumberArray(obj.weights, "$.weights", { maxLength: MAX_FEATURES });
    if (weights.length === 0) {
      fail({ code: "MALFORMED_STRUCTURE", path: "$.weights", message: "a trained classifier has at least one weight" });
    }

    // Absent feature names are legacy-tolerated (the heuristic ordering is the
    // only one that ever shipped), but a present list must agree with the
    // weight vector — a mismatch means weights are indexed against a different
    // feature contract, which silently scores the wrong feature.
    const featureNames =
      optional(obj.featureNames, () => expectStringArray(obj.featureNames, "$.featureNames", { max: MAX_FEATURES })) ??
      [...FEATURE_NAMES];
    if (featureNames.length !== weights.length) {
      fail({
        code: "MALFORMED_STRUCTURE",
        path: "$.featureNames",
        message: `feature/weight arity mismatch (${featureNames.length} names vs ${weights.length} weights)`,
      });
    }

    // Standardisation vectors may legitimately be empty (an unstandardised
    // model); if present they must line up with the weights.
    const means = optional(obj.means, () => expectNumberArray(obj.means, "$.means", { maxLength: MAX_FEATURES })) ?? [];
    const stds = optional(obj.stds, () => expectNumberArray(obj.stds, "$.stds", { maxLength: MAX_FEATURES })) ?? [];
    if (means.length && means.length !== weights.length) {
      fail({ code: "MALFORMED_STRUCTURE", path: "$.means", message: "means do not match the weight arity" });
    }
    if (stds.length && stds.length !== weights.length) {
      fail({ code: "MALFORMED_STRUCTURE", path: "$.stds", message: "stds do not match the weight arity" });
    }

    const calibration = optional(obj.calibration, () => parseCalibrator(obj.calibration, "$.calibration"));

    return {
      schemaVersion,
      featureNames,
      weights,
      means,
      stds,
      ...(calibration ? { calibration } : {}),
    };
  });
}

/** Metrics stored alongside a registry row. Absent entries are not invented. */
export function parseModelMetrics(raw: unknown, boundary: string): ParseResult<ClassifierModel["metrics"]> {
  return runParser(boundary, () => {
    const obj = expectObject(raw, "$");
    const read = (key: keyof ClassifierModel["metrics"]) =>
      optional(obj[key], () => expectFiniteNumber(obj[key], `$.${key}`)) ?? 0;
    return {
      accuracy: read("accuracy"),
      logLoss: read("logLoss"),
      auc: read("auc"),
      brier: read("brier"),
      precision: read("precision"),
      recall: read("recall"),
      testSize: read("testSize"),
      f1: read("f1"),
      prAuc: read("prAuc"),
      ece: read("ece"),
      mce: read("mce"),
    };
  });
}
