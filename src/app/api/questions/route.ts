import { db } from "@/db";
import { questions } from "@/db/schema";
import { fail, ok, toNumber, withUser } from "@/lib/api";
import { getQuestionBank } from "@/lib/queries";
import { DIFFICULTY_VALUE } from "@/lib/engine";

export const dynamic = "force-dynamic";

export async function GET(request: Request) {
  return withUser(async () => {
    const url = new URL(request.url);
    const skillId = url.searchParams.get("skillId");
    const bank = await getQuestionBank(skillId ? Number(skillId) : undefined);
    return ok({ questions: bank });
  });
}

export async function POST(request: Request) {
  return withUser(async (user) => {
    if (user.role === "student") return fail("Learners cannot author items.", 403);
    const body = (await request.json()) as Record<string, unknown>;
    const stem = String(body.stem ?? "").trim();
    const skillId = toNumber(body.skillId, 0);
    const options = Array.isArray(body.options) ? body.options.map((option) => String(option)).filter(Boolean) : [];
    if (!stem || !skillId || options.length < 2) {
      return fail("A stem, a skill and at least two options are required.");
    }
    const correctIndex = Math.min(Math.max(toNumber(body.correctIndex, 0), 0), options.length - 1);
    const difficultyLabel = ["easy", "medium", "hard", "expert"].includes(String(body.difficultyLabel))
      ? String(body.difficultyLabel)
      : "medium";

    const [created] = await db
      .insert(questions)
      .values({
        stem,
        skillId,
        options,
        correctIndex,
        difficultyLabel,
        bloomLevel: String(body.bloomLevel ?? "apply"),
        explanation: String(body.explanation ?? ""),
        estimatedSeconds: toNumber(body.estimatedSeconds, Math.round(45 + DIFFICULTY_VALUE[difficultyLabel] * 90)),
        isActive: body.isActive === undefined ? true : Boolean(body.isActive),
      })
      .returning();
    return ok({ question: created }, 201);
  });
}
