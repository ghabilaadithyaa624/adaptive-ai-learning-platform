/** Pre-specified real-world policy evaluation built on the existing experiment framework. */
import { buildReadout, formatReadout, type ExperimentReadout } from "./analysis";
import type { AttributionResult } from "./attribution";
import type { Experiment, ExperimentDraft, PrimaryMetricKey, SecondaryMetricKey } from "./types";

export interface GovernanceApproval {
  privacyApproved: boolean;
  consentApproved: boolean;
  institutionApproved: boolean;
  educationalDataRequirementsApproved: boolean;
  approvedBy?: string;
  approvedAt?: Date;
}
export interface PolicyEvaluationProtocol {
  protocolVersion: string;
  institutionId: number;
  startAt: Date;
  endAt: Date;
  finalAnalysisAt: Date;
  assignmentUnit: "learner";
  assignmentStrategy: "sticky";
  control: "mastery-gap-baseline";
  treatment: "adaptive-v3";
  optionalTreatment: "irt-assisted" | null;
  primaryOutcomes: readonly ["retainedMasteryGain", "timeToMastery", "questionsToMastery", "delayedRetention"];
  secondaryOutcomes: readonly ["completion", "engagement", "zpdHitRate", "prerequisiteViolations", "recommendationAcceptance", "calibration"];
  retentionDelayDays: number;
  outcomeFreeze: "single-final-analysis";
  governance: GovernanceApproval;
}

/** Throws before definition/launch when human-subject governance is incomplete. */
export function assertLaunchApproved(protocol: PolicyEvaluationProtocol) {
  const g=protocol.governance;
  if(!g.privacyApproved||!g.consentApproved||!g.institutionApproved||!g.educationalDataRequirementsApproved)
    throw new Error("Real-student experiment blocked: privacy, consent, institutional approval, and educational-data requirements must all be satisfied.");
  if(protocol.endAt<=protocol.startAt||protocol.finalAnalysisAt<protocol.endAt)throw new Error("Invalid pre-specified evaluation window/final analysis date.");
}

export function createPolicyEvaluationDraft(protocol: PolicyEvaluationProtocol): ExperimentDraft {
  assertLaunchApproved(protocol);
  if(protocol.optionalTreatment) throw new Error("IRT-assisted live arm is not enabled: no production-approved IRT artifact/strategy is registered.");
  return {
    key:`policy-evaluation-${protocol.protocolVersion}`,
    name:"Mastery-gap control vs adaptive v3",
    hypothesis:"Estimate policy effects on learning, efficiency, retention, safety, and engagement without automatic winner selection.",
    institutionId:protocol.institutionId,
    startAt:protocol.startAt,endAt:protocol.endAt,assignmentStrategy:"sticky",exclusionGroup:"adaptive-policy-serving",
    eligibility:{institutionIds:[protocol.institutionId],roles:["student"]},
    primaryMetric:"masteryGain",
    secondaryMetrics:["completion","engagement","zpdHitRate","recommendationAcceptance","calibration"],
    variants:[
      {key:"control",label:"Mastery-gap-only",allocationPct:50,isControl:true,config:{policy:"mastery-gap-baseline",version:"1.0.0"}},
      {key:"adaptive-v3",label:"Adaptive v3",allocationPct:50,isControl:false,config:{policy:"adaptive-v3",version:"3.0.0"}},
    ],
  };
}

export function outcomeReadoutAllowed(protocol:PolicyEvaluationProtocol,now:Date){return now>=protocol.finalAnalysisAt;}

export interface BaselineCharacteristic { variantKey:string; assigned:number; exposed:number; meanPriorAttempts:number|null; meanBaselineMastery:number|null; gradeDistribution:Record<string,number>; cohortDistribution:Record<string,number>; }
export interface EvaluationDiagnostics { missingByVariant:Record<string,Record<string,number>>; prerequisiteViolationsByVariant:Record<string,number>; protocolDeviations:string[]; assignmentCounts:Record<string,number>; exposureCounts:Record<string,number>; }
export interface PolicyEvaluationReport { protocolVersion:string; generatedAt:Date; readouts:ExperimentReadout[]; text:string; }

/**
 * Runs every requested inferential outcome through the unchanged buildReadout
 * implementation. Multiple primary-family views do not imply multiple winners;
 * they are a complete outcome family and the report states that multiplicity is
 * unadjusted. `masteryGain` is the available retained-gain proxy and must be
 * paired with the delayed `retention` readout; no unsupported composite is made.
 */
export function buildPolicyEvaluationReport(params:{protocol:PolicyEvaluationProtocol;experiment:Experiment;attribution:AttributionResult;baseline:BaselineCharacteristic[];diagnostics:EvaluationDiagnostics;generatedAt:Date}):PolicyEvaluationReport{
  if(!outcomeReadoutAllowed(params.protocol,params.generatedAt))throw new Error("Outcome report locked until the pre-specified final analysis time; operational monitoring must not peek at outcomes.");
  const primaryFamily:PrimaryMetricKey[]=["masteryGain","timeToMastery","questionsToMastery","retention"];
  const secondary:SecondaryMetricKey[]=["completion","engagement","zpdHitRate","recommendationAcceptance","calibration"];
  const readouts=primaryFamily.map(primaryMetric=>buildReadout({experiment:{...params.experiment,primaryMetric,secondaryMetrics:secondary},attribution:params.attribution,exposureByVariant:params.diagnostics.exposureCounts,generatedAt:params.generatedAt}));
  const L:string[]=[];
  L.push(`# Real-world adaptive-policy evaluation — protocol ${params.protocol.protocolVersion}`);
  L.push(`Window: ${params.protocol.startAt.toISOString()} to ${params.protocol.endAt.toISOString()}; final analysis: ${params.protocol.finalAnalysisAt.toISOString()}.`);
  L.push("Randomization unit: learner; assignment: sticky; tenant scope: one institution. Exposure precedes attribution and pre-exposure outcomes are excluded by framework rules.");
  L.push("This report describes evidence and does not make a product decision or identify a winner. Confidence intervals are unchanged, nominal, and not adjusted for repeated viewing or multiple outcomes.");
  L.push("Retained mastery gain is represented by post-exposure masteryGain together with delayed retention; the current framework does not manufacture a new composite estimand.");
  L.push("\n## Cohort, exposure, and baseline characteristics");
  L.push("| arm | assigned | exposed | prior attempts | baseline mastery | grades | cohorts |");L.push("|---|---:|---:|---:|---:|---|---|");
  for(const b of [...params.baseline].sort((a,b)=>a.variantKey.localeCompare(b.variantKey)))L.push(`| ${b.variantKey} | ${b.assigned} | ${b.exposed} | ${b.meanPriorAttempts?.toFixed(2)??"missing"} | ${b.meanBaselineMastery?.toFixed(3)??"missing"} | ${JSON.stringify(b.gradeDistribution)} | ${JSON.stringify(b.cohortDistribution)} |`);
  L.push("\n## Primary and secondary outcomes");for(const r of readouts)L.push("\n"+formatReadout(r));
  L.push("\n## Prerequisite safety (descriptive)");for(const [k,v] of Object.entries(params.diagnostics.prerequisiteViolationsByVariant).sort())L.push(`- ${k}: ${v} violation(s)`);
  L.push("\n## Missingness");for(const [arm,m] of Object.entries(params.diagnostics.missingByVariant).sort())L.push(`- ${arm}: ${JSON.stringify(m)}`);
  L.push("\n## Protocol deviations");L.push(...(params.diagnostics.protocolDeviations.length?params.diagnostics.protocolDeviations.map(x=>`- ${x}`):["- None recorded."]));
  const d=params.attribution.diagnostics;L.push("\n## Attribution conflicts and exclusions");L.push(`- conflicts=${d.conflicts}; before-treatment=${d.beforeExposure}; after-window=${d.afterWindow}; cross-tenant=${d.crossTenant}; unassigned=${d.unassigned}; attributed=${d.attributed}.`);
  L.push("\n## Censoring");L.push("Time-to-mastery, questions-to-mastery, delayed retention, completion, and recommendation acceptance report censored counts and coverage in each unchanged metric table. Censored learners are not scored as zero.");
  L.push("\n## Governance");L.push("Do not launch or continue against real students without documented privacy review, consent, institutional approval, and compliance with applicable educational-data requirements.");
  return{protocolVersion:params.protocol.protocolVersion,generatedAt:params.generatedAt,readouts,text:L.join("\n")};
}
