import { describe, expect, it } from "vitest";
import { canTransition, transitionPatch, nextWorkflowActions, type WorkflowContext } from "@/lib/questions/workflow";

const ctx = (over: Partial<WorkflowContext> = {}): WorkflowContext => ({
  validationPassed: true,
  source: "human",
  authorId: 1,
  actorId: 2,
  actorCanReview: true,
  hasHumanReview: true,
  reviewedById: 2,
  ...over,
});

describe("canTransition — legal paths", () => {
  it("draft → review (author submits, no review capability needed)", () => {
    expect(canTransition("draft", "review", ctx({ actorCanReview: false })).ok).toBe(true);
  });
  it("review → validated (reviewer approves)", () => {
    expect(canTransition("review", "validated", ctx()).ok).toBe(true);
  });
  it("validated → published", () => {
    expect(canTransition("validated", "published", ctx()).ok).toBe(true);
  });
  it("published → monitored", () => {
    expect(canTransition("published", "monitored", ctx()).ok).toBe(true);
  });
  it("monitored → retired", () => {
    expect(canTransition("monitored", "retired", ctx()).ok).toBe(true);
  });
  it("retired → draft (revive)", () => {
    expect(canTransition("retired", "draft", ctx()).ok).toBe(true);
  });
});

describe("canTransition — illegal / guarded", () => {
  it("blocks skipping straight from draft to published", () => {
    const r = canTransition("draft", "published", ctx());
    expect(r.ok).toBe(false);
  });
  it("blocks validation when validation fails", () => {
    const r = canTransition("review", "validated", ctx({ validationPassed: false }));
    expect(r.ok).toBe(false);
    expect(r.reason).toMatch(/pass validation/i);
  });
  it("blocks validation without review capability", () => {
    const r = canTransition("review", "validated", ctx({ actorCanReview: false }));
    expect(r.ok).toBe(false);
    expect(r.reason).toMatch(/permission/i);
  });
  it("blocks publishing without a human review", () => {
    const r = canTransition("validated", "published", ctx({ hasHumanReview: false }));
    expect(r.ok).toBe(false);
    expect(r.reason).toMatch(/reviewed by a human/i);
  });
});

describe("AI-generated items are not auto-trusted", () => {
  it("blocks publishing an AI item reviewed by its own author", () => {
    const r = canTransition("validated", "published", ctx({ source: "ai", authorId: 5, reviewedById: 5, actorId: 9 }));
    expect(r.ok).toBe(false);
    expect(r.reason).toMatch(/other than the author/i);
  });
  it("blocks the AI item's author from publishing it", () => {
    const r = canTransition("validated", "published", ctx({ source: "ai", authorId: 9, reviewedById: 3, actorId: 9 }));
    expect(r.ok).toBe(false);
    expect(r.reason).toMatch(/cannot be published by their author/i);
  });
  it("allows an AI item published by an independent reviewer", () => {
    const r = canTransition("validated", "published", ctx({ source: "ai", authorId: 5, reviewedById: 3, actorId: 3 }));
    expect(r.ok).toBe(true);
  });
});

describe("transitionPatch", () => {
  it("stamps review fields on validation", () => {
    const patch = transitionPatch("validated", ctx({ actorId: 7 }), new Date("2026-01-01T00:00:00Z"));
    expect(patch.status).toBe("validated");
    expect(patch.reviewedById).toBe(7);
    expect(patch.reviewedAt).toBeInstanceOf(Date);
  });
  it("stamps retiredAt and deactivates on retire", () => {
    const patch = transitionPatch("retired", ctx());
    expect(patch.status).toBe("retired");
    expect(patch.isActive).toBe(false);
    expect(patch.retiredAt).toBeInstanceOf(Date);
  });
  it("activates on publish", () => {
    const patch = transitionPatch("published", ctx());
    expect(patch.isActive).toBe(true);
    expect(patch.publishedAt).toBeInstanceOf(Date);
  });
});

describe("nextWorkflowActions", () => {
  it("returns the legal next states for a status", () => {
    const actions = nextWorkflowActions("published").map((a) => a.to);
    expect(actions).toEqual(["monitored", "retired"]);
  });
});
