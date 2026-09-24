import { vi, afterAll, beforeEach, expect, it } from "vitest";

vi.mock("next/headers", () => import("../helpers/next-headers-mock"));
vi.mock("next/navigation", () => import("../helpers/next-navigation-mock"));

import { eq } from "drizzle-orm";
import { db, describeDb, closePool } from "../helpers/db";
import { seedFixtures, type Fixtures } from "../helpers/fixtures";
import { loginAs, logout } from "../helpers/session";
import { __resetCookies } from "../helpers/next-headers-mock";
import { GET, POST, routeCtx, readJson } from "../helpers/http";
import { getCurrentUser } from "@/lib/auth";
import { questions } from "@/db/schema";

import { POST as authRoute } from "@/app/api/auth/route";
import { POST as createAssessment } from "@/app/api/assessments/route";
import { GET as assessmentDetail } from "@/app/api/assessments/[id]/route";
import { POST as answerAssessment } from "@/app/api/assessments/[id]/answer/route";
import { GET as listRecs, POST as generateRecs } from "@/app/api/recommendations/route";
import { POST as createPath } from "@/app/api/paths/route";
import { POST as mlPOST } from "@/app/api/ml/route";

type Session = { itemId: number; questionId: number } | null;

function resetRateLimits() {
  (globalThis as { __adaptiqRateBuckets?: Map<string, unknown> }).__adaptiqRateBuckets?.clear();
}

async function keyFor(questionId: number): Promise<number> {
  const [q] = await db.select({ ci: questions.correctIndex }).from(questions).where(eq(questions.id, questionId));
  return q.ci;
}

describeDb("e2e · full learner journey", () => {
  let fx: Fixtures;

  beforeEach(async () => {
    fx = await seedFixtures();
    (globalThis as { __adaptiqSeedPromise?: Promise<void> }).__adaptiqSeedPromise = Promise.resolve();
    __resetCookies();
    resetRateLimits();
    await logout();
  });
  afterAll(async () => {
    await closePool();
  });

  it("register → assess → answer → complete → recommend → plan → logout", async () => {
    /* 1. Public self-registration creates a student + session. */
    const reg = await authRoute(
      POST("/api/auth", { body: { action: "register", name: "Journey Jo", email: "journey@student.test", password: "Str0ngPass!" } }),
    );
    expect(reg.status).toBe(201);
    const me = await getCurrentUser();
    expect(me?.role).toBe("student");
    const studentId = me!.id;

    /* 2. Start an adaptive diagnostic (student pinned to self). */
    const created = await readJson<{ assessmentId: number; session: Session }>(
      await createAssessment(
        POST("/api/assessments", { body: { targetSkillIds: [fx.skills.arithmetic], itemTarget: 3, mode: "diagnostic" } }),
      ),
    );
    const assessmentId = created.assessmentId;
    expect(created.session).not.toBeNull();

    /* 2b. SECURITY: the answer key is redacted for pending items. */
    const detail = await readJson<{ items: { studentAnswer: number | null; correctIndex: number }[] }>(
      await assessmentDetail(GET(`/api/assessments/${assessmentId}`), routeCtx(assessmentId)),
    );
    const pending = detail.items.find((i) => i.studentAnswer === null);
    if (pending) expect(pending.correctIndex).toBe(-1);

    /* 3–4. Answer every item (as a struggling new learner) until completion.
     * Deliberately answering incorrectly keeps mastery below target, so a real
     * knowledge gap remains for the recommender and path builder to act on. */
    let session = created.session;
    let completed = false;
    let guard = 0;
    while (session && guard < 10) {
      guard += 1;
      const key = await keyFor(session.questionId);
      const wrong = (key + 1) % 4;
      const grade = await readJson<{ completed: boolean; next: Session; summary: unknown }>(
        await answerAssessment(
          POST(`/api/assessments/${assessmentId}/answer`, { body: { action: "answer", itemId: session.itemId, studentAnswer: wrong, responseTimeMs: 5000 } }),
          routeCtx(assessmentId),
        ),
      );
      if (grade.completed) {
        completed = true;
        expect(grade.summary).not.toBeNull();
        break;
      }
      session = grade.next;
    }
    expect(completed).toBe(true);

    /* 5. Recommendations now have evidence to work with. */
    const recs = await readJson<{ generated: number }>(
      await generateRecs(POST("/api/recommendations", { body: {} })),
    );
    expect(recs.generated).toBeGreaterThan(0);
    // And they are listable by the student.
    const list = await readJson<{ recommendations: unknown[] }>(await listRecs(GET("/api/recommendations")));
    expect(list.recommendations.length).toBeGreaterThan(0);

    /* 6. A personalised learning path can be generated. */
    const pathRes = await createPath(POST("/api/paths", { body: { autoGenerate: true } }));
    expect(pathRes.status).toBe(201);
    const { path } = await readJson<{ path: { studentId: number; milestones: unknown[] } }>(pathRes);
    expect(path.studentId).toBe(studentId);
    expect(path.milestones.length).toBeGreaterThan(0);

    /* 7. Logout closes the session. */
    await authRoute(POST("/api/auth", { body: { action: "logout" } }));
    expect(await getCurrentUser()).toBeNull();
    const afterLogout = await createAssessment(POST("/api/assessments", { body: { targetSkillIds: [fx.skills.arithmetic] } }));
    expect(afterLogout.status).toBe(401);
  });

  it("staff operate the ML lifecycle end-to-end (train then evaluate)", async () => {
    await loginAs(fx.users.teacherA);
    const train = await mlPOST(POST("/api/ml", { body: { action: "train" } }));
    expect(train.status).toBe(200);
    const evalRes = await mlPOST(POST("/api/ml", { body: { action: "evaluate" } }));
    expect(evalRes.status).toBe(200);
    const evalData = await readJson<{ samples: number }>(evalRes);
    expect(evalData.samples).toBeGreaterThan(0);
  });
});
