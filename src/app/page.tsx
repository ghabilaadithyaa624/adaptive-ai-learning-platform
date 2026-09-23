import Link from "next/link";
import { Badge, buttonClass, Card } from "@/components/ui";
import { getCurrentUser } from "@/lib/auth";
import { ensureSeededSafe } from "@/lib/seed";
import { getCohortSnapshot } from "@/lib/queries";
import { pct } from "@/lib/utils";

export const dynamic = "force-dynamic";

const PILLARS = [
  {
    title: "Knowledge tracing",
    body: "Bayesian Knowledge Tracing with forgetting-curve decay maintains a latent mastery estimate for every learner × skill pair.",
    icon: "◎",
  },
  {
    title: "Knowledge-gap detection",
    body: "Wilson-lower-bound confidence plus prerequisite analysis classifies every gap into five actionable severities.",
    icon: "◍",
  },
  {
    title: "Difficulty prediction",
    body: "A logistic-regression classifier predicts P(correct) for each (learner, item) pair — trained on live response logs.",
    icon: "⚙",
  },
  {
    title: "Recommendation engine",
    body: "Hybrid scoring of gap size, forgetting risk, prerequisite readiness, path alignment and evidence confidence.",
    icon: "★",
  },
  {
    title: "Adaptive quizzes",
    body: "CAT-style item selection targets the zone of proximal development and adapts within a single session.",
    icon: "✎",
  },
  {
    title: "Performance forecasting",
    body: "Linear-regression forecasting on completed sessions projects mastery trajectory, R² and confidence bands.",
    icon: "▲",
  },
];

export default async function LandingPage() {
  await ensureSeededSafe();
  const [user, snapshot] = await Promise.all([getCurrentUser(), getCohortSnapshot().catch(() => null)]);

  return (
    <div className="grid-backdrop min-h-screen">
      <header className="mx-auto flex w-full max-w-6xl items-center justify-between px-5 py-5">
        <div className="flex items-center gap-2.5">
          <span className="flex h-9 w-9 items-center justify-center rounded-xl bg-gradient-to-br from-indigo-500 to-sky-500 text-sm font-bold text-white">
            AQ
          </span>
          <span className="text-sm font-semibold tracking-tight text-slate-900">AdaptiQ</span>
        </div>
        <div className="flex items-center gap-2">
          {user ? (
            <Link href="/dashboard" className={buttonClass("primary", "sm")}>
              Open dashboard
            </Link>
          ) : (
            <>
              <Link href="/login" className={buttonClass("secondary", "sm")}>
                Sign in
              </Link>
              <Link href="/register" className={buttonClass("primary", "sm")}>
                Start free
              </Link>
            </>
          )}
        </div>
      </header>

      <main className="mx-auto w-full max-w-6xl px-5 pb-20">
        <section className="grid items-center gap-10 py-10 lg:grid-cols-[1.1fr_0.9fr]">
          <div>
            <Badge tone="violet">Recommendation systems · classification · knowledge tracing</Badge>
            <h1 className="mt-4 text-4xl font-semibold tracking-tight text-slate-900 sm:text-5xl">
              Personalised mastery for every learner, powered by continuously learning models.
            </h1>
            <p className="mt-4 max-w-xl text-sm leading-relaxed text-slate-600">
              AdaptiQ ingests every response, updates a latent mastery estimate per skill, detects knowledge gaps with
              statistical confidence, predicts item difficulty, recommends the single best next activity and forecasts
              where each learner is heading — all in one dashboard for students, teachers, trainers, institutions and
              administrators.
            </p>
            <div className="mt-6 flex flex-wrap gap-3">
              <Link href={user ? "/dashboard" : "/login"} className={buttonClass("primary", "lg")}>
                {user ? "Continue to dashboard" : "Explore the live demo"}
              </Link>
              <Link href="/register" className={buttonClass("secondary", "lg")}>
                Create an account
              </Link>
            </div>
            {snapshot ? (
              <dl className="mt-8 grid grid-cols-2 gap-4 sm:grid-cols-4">
                {[
                  { label: "Learners tracked", value: snapshot.learners },
                  { label: "Mastery states", value: snapshot.masteryStates },
                  { label: "Sessions logged", value: snapshot.completedAssessments },
                  { label: "Open recommendations", value: snapshot.openRecommendations },
                ].map((stat) => (
                  <div key={stat.label} className="rounded-xl border border-slate-200 bg-white/80 px-3 py-2.5">
                    <dt className="text-[11px] uppercase tracking-wide text-slate-500">{stat.label}</dt>
                    <dd className="mt-1 text-lg font-semibold text-slate-900">{stat.value}</dd>
                  </div>
                ))}
              </dl>
            ) : null}
          </div>

          <Card className="animate-in">
            <p className="text-xs font-semibold uppercase tracking-wide text-slate-500">Cohort mastery heat signal</p>
            <div className="mt-4 space-y-3">
              {(snapshot?.weakTopics ?? []).slice(0, 6).map((topic) => (
                <div key={topic.skillId}>
                  <div className="flex items-center justify-between text-xs">
                    <span className="truncate font-medium text-slate-700">{topic.skillName}</span>
                    <span className="text-slate-500">{pct(topic.avgMastery)}</span>
                  </div>
                  <div className="mt-1 h-2 overflow-hidden rounded-full bg-slate-100">
                    <div
                      className="h-full rounded-full"
                      style={{
                        width: `${Math.max(4, topic.avgMastery * 100)}%`,
                        background: topic.avgMastery < 0.5 ? "#e11d48" : topic.avgMastery < 0.7 ? "#d97706" : "#0284c7",
                      }}
                    />
                  </div>
                  <p className="mt-0.5 text-[11px] text-slate-400">
                    {topic.learners} learners · {topic.atRisk} at risk · {topic.attempts} responses logged
                  </p>
                </div>
              ))}
              {!snapshot?.weakTopics.length ? (
                <p className="text-xs text-slate-500">Seed data is warming up — refresh in a moment.</p>
              ) : null}
            </div>
            <div className="mt-5 rounded-xl bg-slate-50 p-3 text-[11px] leading-relaxed text-slate-600">
              <span className="font-semibold text-slate-700">Demo credentials:</span> student@adaptiq.ai ·
              teacher@adaptiq.ai · trainer@adaptiq.ai · institution@adaptiq.ai · admin@adaptiq.ai — password{" "}
              <span className="font-mono">password123</span>
            </div>
          </Card>
        </section>

        <section className="grid gap-4 sm:grid-cols-2 lg:grid-cols-3">
          {PILLARS.map((pillar) => (
            <Card key={pillar.title} className="animate-in">
              <span className="flex h-9 w-9 items-center justify-center rounded-xl bg-indigo-50 text-sm text-indigo-600 ring-1 ring-inset ring-indigo-100">
                {pillar.icon}
              </span>
              <h2 className="mt-3 text-sm font-semibold text-slate-900">{pillar.title}</h2>
              <p className="mt-1.5 text-xs leading-relaxed text-slate-600">{pillar.body}</p>
            </Card>
          ))}
        </section>

        <section className="mt-10 grid gap-4 lg:grid-cols-3">
          {[
            {
              role: "Students",
              items: ["Adaptive quizzes that meet you at your level", "Personalised path with milestone ETAs", "Transparent mastery timeline and forecasts"],
            },
            {
              role: "Teachers & trainers",
              items: ["Cohort gap heatmaps down to the sub-skill", "Item difficulty prediction before assignment", "Recommendation queue with explainability factors"],
            },
            {
              role: "Institutions & admins",
              items: ["Tenant, plan and seat management", "Model registry with retraining and metrics", "Platform-wide adoption and outcome analytics"],
            },
          ].map((column) => (
            <Card key={column.role}>
              <h3 className="text-sm font-semibold text-slate-900">For {column.role}</h3>
              <ul className="mt-3 space-y-2 text-xs text-slate-600">
                {column.items.map((item) => (
                  <li key={item} className="flex gap-2">
                    <span className="text-indigo-500">✓</span>
                    {item}
                  </li>
                ))}
              </ul>
            </Card>
          ))}
        </section>
      </main>
    </div>
  );
}
