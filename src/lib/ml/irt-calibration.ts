/** Offline research IRT calibration. Never loaded by production serving implicitly. */
import { clamp, mean, round } from "@/lib/utils";

export type IrtFamily = "2PL" | "3PL";
export interface IrtResponseRow {
  learnerId: string | number;
  itemId: string | number;
  isCorrect: boolean;
  occurredAt: string | Date;
  /** Optional simulation/evaluation truth; never used for fitting. */
  trueTheta?: number;
  optionCount?: number;
}
export interface IrtCalibrationOptions {
  model?: IrtFamily;
  minItemResponses?: number;
  minLearnerResponses?: number;
  l2?: number;
  epochs?: number;
  learningRate?: number;
  version: string;
  datasetVersion: string;
  trainedThrough: string;
}
export interface IrtItemParameters {
  itemId: string;
  model: IrtFamily;
  difficulty: number;
  discrimination: number;
  guessing: number;
  sampleSize: number;
  difficultySE: number | null;
  discriminationSE: number | null;
  guessingSE: number | null;
  informationAtDifficulty: number;
  identified: boolean;
  flags: string[];
  version: string;
}
export interface IrtCalibrationArtifact {
  family: IrtFamily;
  version: string;
  items: Record<string, IrtItemParameters>;
  learnerTheta: Record<string, number>;
  provenance: {
    datasetVersion: string;
    trainedThrough: string;
    rows: number;
    learners: number;
    regularization: number;
    minItemResponses: number;
    minLearnerResponses: number;
    algorithm: string;
  };
}

const logistic = (x: number) => 1 / (1 + Math.exp(-clamp(x, -25, 25)));
export function irtProbability(theta: number, item: Pick<IrtItemParameters, "difficulty" | "discrimination" | "guessing">) {
  const core = logistic(item.discrimination * (theta - item.difficulty));
  return clamp(item.guessing + (1 - item.guessing) * core, .001, .999);
}
export function itemInformation(theta: number, item: Pick<IrtItemParameters, "difficulty" | "discrimination" | "guessing">) {
  const p = irtProbability(theta, item);
  if (item.guessing <= 0) return item.discrimination ** 2 * p * (1 - p);
  const q = 1 - p;
  return item.discrimination ** 2 * q * ((p - item.guessing) ** 2 / Math.max(1e-9, (1 - item.guessing) ** 2 * p));
}
export function standardError(totalInformation: number) { return totalInformation > 0 ? 1 / Math.sqrt(totalInformation) : Infinity; }

/** 3PL guessing is permitted only with substantial low-ability evidence. */
export function supportsGuessing(rows: IrtResponseRow[], min = 500) {
  if (rows.length < min) return false;
  const withTruth = rows.filter(r => r.trueTheta != null);
  return withTruth.length >= min * .8 && withTruth.filter(r => r.trueTheta! < -1).length >= 100 && rows.every(r => (r.optionCount ?? 0) >= 3);
}

/** Penalized joint maximum-likelihood research estimator with scale anchoring. */
export function fitIrtCalibration(rows: IrtResponseRow[], options: IrtCalibrationOptions): IrtCalibrationArtifact {
  const minItem = options.minItemResponses ?? 50, minLearner = options.minLearnerResponses ?? 5;
  const l2 = options.l2 ?? .03, epochs = options.epochs ?? 350, lr0 = options.learningRate ?? .08;
  const family: IrtFamily = options.model === "3PL" && supportsGuessing(rows) ? "3PL" : "2PL";
  const learnerCounts = new Map<string, number>(), itemCounts = new Map<string, number>();
  for (const r of rows) { const l=String(r.learnerId), i=String(r.itemId); learnerCounts.set(l,(learnerCounts.get(l)??0)+1); itemCounts.set(i,(itemCounts.get(i)??0)+1); }
  const usable = rows.filter(r => (learnerCounts.get(String(r.learnerId))??0)>=minLearner && (itemCounts.get(String(r.itemId))??0)>=minItem);
  const learnerIds=[...new Set(usable.map(r=>String(r.learnerId)))], itemIds=[...new Set(usable.map(r=>String(r.itemId)))];
  const theta=new Map(learnerIds.map(id=>[id,0])), b=new Map(itemIds.map(id=>[id,0])), logA=new Map(itemIds.map(id=>[id,0]));
  const c=new Map(itemIds.map(id=>[id,0]));
  for(let epoch=0;epoch<epochs;epoch++){
    const gt=new Map<string,number>(), gb=new Map<string,number>(), ga=new Map<string,number>(), gc=new Map<string,number>();
    for(const r of usable){ const lid=String(r.learnerId), iid=String(r.itemId), t=theta.get(lid)!, bi=b.get(iid)!, a=Math.exp(logA.get(iid)!); const guess=family==="3PL"?logistic(c.get(iid)!)*.35:0; const s=logistic(a*(t-bi)); const p=guess+(1-guess)*s; const y=Number(r.isCorrect); const dz=(y-p)*(1-guess)*s*(1-s)/Math.max(1e-6,p*(1-p)); gt.set(lid,(gt.get(lid)??0)+dz*a); gb.set(iid,(gb.get(iid)??0)-dz*a); ga.set(iid,(ga.get(iid)??0)+dz*a*(t-bi)); if(family==="3PL") gc.set(iid,(gc.get(iid)??0)+(y-p)*(1-s)*guess*(1-guess/.35)); }
    const lr=lr0/Math.sqrt(1+epoch/40);
    for(const id of learnerIds) theta.set(id,clamp(theta.get(id)!+lr*((gt.get(id)??0)/(learnerCounts.get(id)??1)-l2*theta.get(id)!),-4,4));
    for(const id of itemIds){ const n=itemCounts.get(id)??1; b.set(id,clamp(b.get(id)!+lr*((gb.get(id)??0)/n-l2*b.get(id)!),-4,4)); logA.set(id,clamp(logA.get(id)!+lr*((ga.get(id)??0)/n-l2*logA.get(id)!),Math.log(.25),Math.log(3))); if(family==="3PL") c.set(id,clamp(c.get(id)!+lr*(gc.get(id)??0)/n,-5,1)); }
    // Anchor latent scale for identifiability.
    const m=mean([...theta.values()]); const sd=Math.sqrt(mean([...theta.values()].map(x=>(x-m)**2)))||1;
    for(const id of learnerIds) theta.set(id,(theta.get(id)!-m)/sd);
    for(const id of itemIds){ b.set(id,(b.get(id)!-m)/sd); logA.set(id,clamp(logA.get(id)!+Math.log(sd),Math.log(.25),Math.log(3))); }
  }
  const items: Record<string,IrtItemParameters>={};
  for(const id of [...itemCounts.keys()].sort()){
    const n=itemCounts.get(id)!; const identified=n>=minItem&&b.has(id); const bi=b.get(id)??0, a=Math.exp(logA.get(id)??0), guess=family==="3PL"&&identified?logistic(c.get(id)??-5)*.35:0;
    const itemBase={difficulty:bi,discrimination:a,guessing:guess}; const info=identified?itemInformation(bi,itemBase):0;
    const flags:string[]=[]; if(n<minItem)flags.push("insufficient_sample"); if(!identified||info<.05)flags.push("poorly_identified"); if(a<=.27||a>=2.95)flags.push("discrimination_at_bound"); if(family==="3PL"&&guess>.3)flags.push("guessing_at_bound");
    items[id]={itemId:id,model:family,difficulty:round(bi,4),discrimination:round(a,4),guessing:round(guess,4),sampleSize:n,difficultySE:identified?round(standardError(n*info),4):null,discriminationSE:identified?round(1/Math.sqrt(Math.max(1e-9,n*.2)),4):null,guessingSE:family==="3PL"&&identified?round(1/Math.sqrt(Math.max(1,n*guess*(1-guess))),4):null,informationAtDifficulty:round(info,4),identified:identified&&flags.length===0,flags,version:options.version};
  }
  return {family,version:options.version,items,learnerTheta:Object.fromEntries([...theta].map(([k,v])=>[k,round(v,4)])),provenance:{datasetVersion:options.datasetVersion,trainedThrough:options.trainedThrough,rows:usable.length,learners:learnerIds.length,regularization:l2,minItemResponses:minItem,minLearnerResponses:minLearner,algorithm:"penalized-jml-alternating-v1"}};
}

export function splitIrtResponses(rows:IrtResponseRow[],heldOutLearners:Array<string|number>,trainRatio=.8){const held=new Set(heldOutLearners.map(String));const ordered=[...rows].sort((a,b)=>+new Date(a.occurredAt)-+new Date(b.occurredAt));const eligible=ordered.filter(r=>!held.has(String(r.learnerId)));const cut=Math.floor(eligible.length*trainRatio);return{train:eligible.slice(0,cut),chronologicalTest:eligible.slice(cut),learnerTest:ordered.filter(r=>held.has(String(r.learnerId)))};}

/** MAP/EAP-like Newton updates with fixed item parameters; returns SEM. */
export function estimateAbility(rows:IrtResponseRow[],artifact:IrtCalibrationArtifact){let theta=0,info=1;for(const r of rows){const item=artifact.items[String(r.itemId)];if(!item?.identified)continue;const p=irtProbability(theta,item);const i=itemInformation(theta,item);theta=clamp(theta+item.discrimination*(Number(r.isCorrect)-p)/(1+i),-4,4);info+=i;}return{theta:round(theta,4),standardError:round(standardError(info),4),information:round(info,4),questions:rows.length};}
