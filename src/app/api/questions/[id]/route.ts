import { eq } from "drizzle-orm";
import { NextResponse } from "next/server";
import { db } from "@/db";
import { assessmentItems, itemStatistics, questions } from "@/db/schema";
import { ok, toNumber, withAuth } from "@/lib/api";
import { badRequest, notFound } from "@/lib/http";
import { idList, oneOf, optString, parseId, readJsonBody, stringList } from "@/lib/validation";
import { requireCapability } from "@/lib/authz";
import { recordAudit } from "@/lib/audit";
import { invalidate, CACHE_KEYS } from "@/lib/cache";
import {
  BLOOM_LEVELS,
  COGNITIVE_COMPLEXITY_LEVELS,
  DIFFICULTY_LABELS,
  EMPTY_CALIBRATION,
} from "@/lib/questions/constants";
import { validateQuestion } from "@/lib/questions/validation";
import { buildValidationContext, resolveDifficultyValue } from "@/lib/questions/service";

export const dynamic = "force-dynamic";

type Params = { params: Promise<{ id: string }> };

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

export async function PATCH(request: Request, { params }: Params) {
  return withAuth(request, async ({ user, ip }) => {
    requireCapability(user, "manageContent", "Learners cannot edit items.", "questions.update");
    const { id } = await params;
    const questionId = parseId(id);
    const body = await readJsonBody(request);

    const [existing] = await db.select().from(questions).where(eq(questions.id, questionId)).limit(1);
    if (!existing) throw notFound("Question not found.");

    // Build the "merged" candidate so validation runs against the final content.
    const patch: Partial<typeof questions.$inferInsert> = {};
    if (body.stem !== undefined) patch.stem = String(body.stem).slice(0, 2000);
    if (body.skillId !== undefined) patch.skillId = toNumber(body.skillId, existing.skillId);
    if (body.options !== undefined) patch.options = stringList(body.options, "options", { max: 12, maxLen: 500 });
    if (body.correctIndex !== undefined) patch.correctIndex = toNumber(body.correctIndex, existing.correctIndex);
    if (body.difficultyLabel !== undefined) patch.difficultyLabel = oneOf(body.difficultyLabel, DIFFICULTY_LABELS, "difficultyLabel");
    if (body.bloomLevel !== undefined) patch.bloomLevel = oneOf(body.bloomLevel, BLOOM_LEVELS, "bloomLevel");
    if (body.cognitiveComplexity !== undefined) patch.cognitiveComplexity = oneOf(body.cognitiveComplexity, COGNITIVE_COMPLEXITY_LEVELS, "cognitiveComplexity");
    if (body.explanation !== undefined) patch.explanation = String(body.explanation).slice(0, 2000);
    if (body.estimatedSeconds !== undefined) patch.estimatedSeconds = toNumber(body.estimatedSeconds, existing.estimatedSeconds);
    if (body.subskill !== undefined) patch.subskill = optString(body.subskill, "subskill", { max: 120 }) ?? null;
    if (body.prerequisiteSkillIds !== undefined) patch.prerequisiteSkillIds = idList(body.prerequisiteSkillIds, "prerequisiteSkillIds");
    if (body.hints !== undefined) patch.hints = stringList(body.hints, "hints", { max: 8, maxLen: 500 });
    if (body.distractorMeta !== undefined) patch.distractorMeta = parseDistractorMeta(body.distractorMeta);
    if (body.reviewNotes !== undefined) patch.reviewNotes = optString(body.reviewNotes, "reviewNotes", { max: 1000 }) ?? null;
    if (body.isActive !== undefined) patch.isActive = Boolean(body.isActive);
    if (!Object.keys(patch).length) throw badRequest("Nothing to update.");

    const difficultyLabel = (patch.difficultyLabel ?? existing.difficultyLabel) as string;
    const difficultyValue =
      body.difficultyValue !== undefined
        ? resolveDifficultyValue(difficultyLabel, Number(body.difficultyValue))
        : patch.difficultyLabel
          ? resolveDifficultyValue(difficultyLabel, undefined)
          : existing.difficultyValue;
    patch.difficultyValue = difficultyValue;

    const merged = { ...existing, ...patch };
    const ctx = await buildValidationContext();
    const report = validateQuestion(
      {
        id: questionId,
        stem: merged.stem,
        options: merged.options,
        correctIndex: merged.correctIndex,
        skillId: merged.skillId,
        subskill: merged.subskill,
        prerequisiteSkillIds: merged.prerequisiteSkillIds,
        difficultyLabel: merged.difficultyLabel,
        difficultyValue: merged.difficultyValue,
        bloomLevel: merged.bloomLevel,
        cognitiveComplexity: merged.cognitiveComplexity,
        estimatedSeconds: merged.estimatedSeconds,
        hints: merged.hints,
        distractorMeta: merged.distractorMeta,
        source: merged.source,
      },
      ctx,
    );
    if (!report.valid) {
      return NextResponse.json({ error: "The item failed validation.", errors: report.errors, warnings: report.warnings }, { status: 422 });
    }

    // Editing content of an already-published/monitored item invalidates its
    // calibration and trust: bump the version, reset stats, and send it back to
    // review so a human re-validates before it is served again.
    const contentChanged =
      (patch.stem !== undefined && patch.stem !== existing.stem) ||
      (patch.options !== undefined && JSON.stringify(patch.options) !== JSON.stringify(existing.options)) ||
      (patch.correctIndex !== undefined && patch.correctIndex !== existing.correctIndex) ||
      (patch.skillId !== undefined && patch.skillId !== existing.skillId);

    let requeued = false;
    if (contentChanged && (existing.status === "published" || existing.status === "monitored")) {
      patch.version = existing.version + 1;
      patch.status = "review";
      patch.isActive = false;
      patch.qualityScore = 0;
      patch.discrimination = 0;
      patch.successRate = 0;
      patch.qualityFlags = [];
      patch.calibration = EMPTY_CALIBRATION as unknown as Record<string, unknown>;
      patch.lastAnalyzedAt = null;
      requeued = true;
    }

    const [updated] = await db.update(questions).set(patch).where(eq(questions.id, questionId)).returning();
    await recordAudit({
      actor: user,
      action: "questions.update",
      resource: "questions",
      resourceId: questionId,
      ip,
      detail: requeued ? `content edit → v${patch.version}, requeued to review` : undefined,
    });
    return ok({ question: updated, warnings: report.warnings, requeued });
  });
}

export async function DELETE(request: Request, { params }: Params) {
  return withAuth(request, async ({ user, ip }) => {
    requireCapability(user, "manageContent", "Learners cannot delete items.", "questions.delete");
    const { id } = await params;
    const questionId = parseId(id);
    await db.delete(assessmentItems).where(eq(assessmentItems.questionId, questionId));
    await db.delete(itemStatistics).where(eq(itemStatistics.questionId, questionId));
    await db.delete(questions).where(eq(questions.id, questionId));
    await recordAudit({ actor: user, action: "questions.delete", resource: "questions", resourceId: questionId, ip });
    invalidate(CACHE_KEYS.skillCatalog); // per-skill question counts changed
    return ok({ deleted: true });
  });
}
