/** Optional research CAT item-information assistant. Not a production default. */
import type { CandidateItem } from "./interfaces";
import { itemInformation, type IrtCalibrationArtifact } from "./irt-calibration";

export interface CatSelection {
  candidate: CandidateItem;
  information: number;
  explanation: {
    modelVersion: string;
    theta: number;
    itemDifficulty: number;
    discrimination: number;
    guessing: number;
    information: number;
    rationale: string;
  };
}

/**
 * Select maximum-information item from an already safety-filtered candidate set.
 * Only identified, versioned parameters are eligible. Callers retain prerequisite,
 * exposure, no-repeat and curriculum gates before invoking this assistant.
 */
export function selectCatItem(params: {
  candidates: CandidateItem[];
  theta: number;
  calibration: IrtCalibrationArtifact;
  seenQuestionIds?: Set<number>;
  maxExposureRate?: number;
}): CatSelection | null {
  const maxExposure = params.maxExposureRate ?? .25;
  const scored = params.candidates
    .filter(c => !params.seenQuestionIds?.has(c.questionId))
    .filter(c => (c.item.exposureRate ?? 0) <= maxExposure)
    .map(candidate => {
      const item = params.calibration.items[String(candidate.questionId)];
      return item?.identified ? { candidate, item, information: itemInformation(params.theta, item) } : null;
    })
    .filter((x): x is NonNullable<typeof x> => x != null)
    .sort((a,b)=>b.information-a.information||a.candidate.questionId-b.candidate.questionId);
  const top=scored[0]; if(!top)return null;
  return {candidate:top.candidate,information:top.information,explanation:{modelVersion:params.calibration.version,theta:params.theta,itemDifficulty:top.item.difficulty,discrimination:top.item.discrimination,guessing:top.item.guessing,information:top.information,rationale:`Maximum calibrated ${top.item.model} Fisher information among prerequisite-safe, exposure-safe candidates.`}};
}
