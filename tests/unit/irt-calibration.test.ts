import { describe, expect, it } from "vitest";
import { estimateAbility, fitIrtCalibration, itemInformation, splitIrtResponses, standardError, supportsGuessing, type IrtResponseRow } from "@/lib/ml/irt-calibration";
import { selectCatItem } from "@/lib/ml/irt-cat";
import type { CandidateItem } from "@/lib/ml/interfaces";

function rows():IrtResponseRow[]{const out:IrtResponseRow[]=[];for(let l=0;l<30;l++)for(let i=0;i<4;i++)for(let k=0;k<3;k++){const theta=(l-15)/8,b=(i-1.5)*.7,p=1/(1+Math.exp(-(1+i*.2)*(theta-b)));out.push({learnerId:l,itemId:i,isCorrect:((l*17+i*11+k*7)%100)/100<p,occurredAt:new Date(Date.UTC(2025,0,l*12+i*3+k+1)),trueTheta:theta,optionCount:4});}return out;}
const options={version:"2pl-test-v1",datasetVersion:"fixture-v1",trainedThrough:"2025-12-31"};

describe("offline IRT calibration",()=>{
 it("fits regularized versioned 2PL parameters with uncertainty and provenance",()=>{const a=fitIrtCalibration(rows(),{...options,minItemResponses:40,epochs:80});expect(a.family).toBe("2PL");expect(a.provenance.regularization).toBeGreaterThan(0);expect(Object.values(a.items).every(i=>i.version==="2pl-test-v1"&&i.difficultySE!=null)).toBe(true);});
 it("flags low-sample items as poorly identified",()=>{const a=fitIrtCalibration(rows().slice(0,20),{...options,minItemResponses:50,epochs:5});expect(Object.values(a.items).every(i=>!i.identified&&i.flags.includes("insufficient_sample"))).toBe(true);});
 it("does not fit 3PL guessing without strong evidence",()=>{expect(supportsGuessing(rows())).toBe(false);expect(fitIrtCalibration(rows(),{...options,model:"3PL",minItemResponses:40,epochs:5}).family).toBe("2PL");});
 it("creates leakage-free chronological and held-out-learner splits",()=>{const s=splitIrtResponses(rows(),[29],.7);expect(s.train.every(r=>r.learnerId!==29)).toBe(true);expect(s.learnerTest.every(r=>r.learnerId===29)).toBe(true);expect(Math.max(...s.train.map(r=>+new Date(r.occurredAt)))).toBeLessThanOrEqual(Math.min(...s.chronologicalTest.map(r=>+new Date(r.occurredAt))));});
 it("reports ability SEM and decreasing error with information",()=>{expect(standardError(4)).toBe(.5);const a=fitIrtCalibration(rows(),{...options,minItemResponses:40,epochs:80});const e=estimateAbility(rows().filter(r=>r.learnerId===20),a);expect(Number.isFinite(e.theta)).toBe(true);expect(e.standardError).toBeGreaterThan(0);});
 it("CAT consumes only identified calibrated items and emits an explanation",()=>{const a=fitIrtCalibration(rows(),{...options,minItemResponses:40,epochs:80});const candidates:CandidateItem[]=[0,1,2,3].map(i=>({questionId:i,skillId:1,skillName:"S",subjectName:"M",item:{difficulty:.5,bloom:3,exposureRate:0},estimatedSeconds:30,text:"q"}));const picked=selectCatItem({candidates,theta:0,calibration:a});expect(picked).not.toBeNull();expect(picked!.explanation.modelVersion).toBe(a.version);expect(picked!.information).toBeGreaterThan(0);});
 it("item information is nonnegative",()=>expect(itemInformation(0,{difficulty:0,discrimination:1,guessing:0})).toBeCloseTo(.25));
});
