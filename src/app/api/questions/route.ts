import { db } from "@/db";
import { questions } from "@/db/schema";
import { ok, toNumber, withAuth } from "@/lib/api";
import { getQuestionBank } from "@/lib/queries";
import { badRequest } from "@/lib/http";
import { NextResponse } from "next/server";
import { idList, oneOf, optString, readJsonBody, reqString, stringList } from "@/lib/validation";
import { requireCapability } from "@/lib/authz";
import { recordAudit } from "@/lib/audit";
import { invalidate, CACHE_KEYS } from "@/lib/cache";
import {
  BLOOM_LEVELS,
  COGNITIVE_COMPLEXITY_LEVELS,
  DIFFICULTY_LABELS,
  QUESTION_SOURCES,
} from "@/lib/questions/constants";
import { validateQuestion } from "@/lib/questions/validation";
import { buildValidationContext, resolveDifficultyValue } from "@/lib/questions/service";

export const dynamic = "force-dynamic";

/** Parse distractor metadata from an untrusted array. */
function parseDistractorMeta(value: unknown): { optionIndex: number; misconception?: string; rationale?: string }[] {
  if (!Array.isArray(value)) return [];
  return value
    .filter((v): v is Record<string, unknown> => Boolean(v) && typeof v === "object")
    .map((v) => ({
      optionIndex: toNumber(v.optionIndex, -1),
      misconception: typeof v.misconception === "string" ? v.misconception.slice(0, 500) : undefined,
      rationale: typeof v.rationale === "string" ? v.rationale.slice(0, 500) : undefined,
    }))
    .filter((v) => v.optionIndex >= 0)
    .slice(0, 12);
}

export async function GET(request: Request) {
  return withAuth(request, async ({ user }) => {
    // The question bank includes correct answers/explanations — staff only.
    requireCapability(user, "manageContent", "You do not have permission to view the item bank.", "questions.list");
    const url = new URL(request.url);
    const skillId = url.searchParams.get("skillId");
    const bank = await getQuestionBank(skillId ? Number(skillId) : undefined);
    return ok({ questions: bank });
  });
}

export async function POST(request: Request) {
  return withAuth(request, async ({ user, ip }) => {
    requireCapability(user, "manageContent", "Learners cannot author items.", "questions.create");
    const body = await readJsonBody(request);

    const stem = reqString(body.stem, "Stem", { max: 2000 });
    const skillId = toNumber(body.skillId, 0);
    const options = stringList(body.options, "options", { max: 12, maxLen: 500 });
    if (!skillId) throw badRequest("A skill is required.");

    const correctIndex = toNumber(body.correctIndex, 0);
    const difficultyLabel = oneOf(body.difficultyLabel, DIFFICULTY_LABELS, "difficultyLabel", "medium");
    const bloomLevel = oneOf(body.bloomLevel, BLOOM_LEVELS, "bloomLevel", "apply");
    const cognitiveComplexity = oneOf(body.cognitiveComplexity, COGNITIVE_COMPLEXITY_LEVELS, "cognitiveComplexity", "skill_concept");
    const source = oneOf(body.source, QUESTION_SOURCES, "source", "human");
    const difficultyValue = resolveDifficultyValue(difficultyLabel, typeof body.difficultyValue === "number" ? body.difficultyValue : undefined);
    const prerequisiteSkillIds = idList(body.prerequisiteSkillIds, "prerequisiteSkillIds");
    const hints = Array.isArray(body.hints) ? stringList(body.hints, "hints", { max: 8, maxLen: 500 }) : [];
    const distractorMeta = parseDistractorMeta(body.distractorMeta);
    const subskill = optString(body.subskill, "subskill", { max: 120 }) ?? null;
    const explanation = optString(body.explanation, "explanation", { max: 2000 }) ?? "";
    const estimatedSeconds = toNumber(body.estimatedSeconds, Math.round(45 + difficultyValue * 90));

    // Full structural + psychometric validation against the live taxonomy/bank.
    const ctx = await buildValidationContext();
    const report = validateQuestion(
      {
        stem,
        options,
        correctIndex,
        skillId,
        subskill,
        prerequisiteSkillIds,
        difficultyLabel,
        difficultyValue,
        bloomLevel,
        cognitiveComplexity,
        estimatedSeconds,
        hints,
        distractorMeta,
        source,
      },
      ctx,
    );
    if (!report.valid) {
      await recordAudit({ actor: user, action: "questions.create.rejected", resource: "questions", outcome: "failure", ip, detail: report.errors.map((e) => e.code).join(",") });
      return NextResponse.json({ error: "The item failed validation.", errors: report.errors, warnings: report.warnings }, { status: 422 });
    }

    // New items ALWAYS enter as draft. AI-generated content is never auto-trusted:
    // it must go through review → validated → published like everything else.
    const [created] = await db
      .insert(questions)
      .values({
        stem,
        skillId,
        subskill,
        prerequisiteSkillIds,
        options,
        correctIndex: Math.min(Math.max(correctIndex, 0), options.length - 1),
        difficultyLabel,
        difficultyValue,
        bloomLevel,
        cognitiveComplexity,
        explanation,
        hints,
        distractorMeta,
        estimatedSeconds,
        authorId: user.id,
        source,
        version: 1,
        status: "draft",
        isActive: false, // not servable until published
      })
      .returning();

    await recordAudit({ actor: user, action: "questions.create", resource: "questions", resourceId: created.id, ip, detail: `source=${source}` });
    invalidate(CACHE_KEYS.skillCatalog); // per-skill question counts changed
    return ok({ question: created, warnings: report.warnings }, 201);
  });
}
