"use client";

import { useCallback, useRef, useState } from "react";
import { Badge, buttonClass, Card, CardHeader, Spinner } from "@/components/ui";
import { useToast } from "@/components/toast";
import { cn } from "@/lib/utils";

/* Mirrors the server-side TutorResponse / intents (kept local to avoid a
   client bundle importing server-only modules). */
type Intent = "explain" | "hint" | "socratic" | "worked_example" | "diagnose" | "remediate" | "next_activity";
type DifficultyReq = "auto" | "easier" | "same" | "harder";

type SuggestedActivity = { kind: string; skillId: number | null; title: string; reason: string } | null;

type TutorResponse = {
  interactionId: number;
  intent: Intent;
  requestedIntent: Intent;
  adjustedIntent: boolean;
  skillName: string | null;
  message: string;
  followUps: string[];
  suggestedActivity: SuggestedActivity;
  difficulty: "foundational" | "core" | "stretch";
  withheldAnswer: boolean;
  guardrails: string[];
  citations: { type: string; ref: string }[];
  provider: string;
  disclaimers: string[];
};

type Turn =
  | { role: "learner"; text: string }
  | { role: "tutor"; response: TutorResponse; helpful: boolean | null };

const INTENTS: { id: Intent; label: string; icon: string }[] = [
  { id: "explain", label: "Explain", icon: "◎" },
  { id: "hint", label: "Hint", icon: "➜" },
  { id: "socratic", label: "Ask me", icon: "?" },
  { id: "worked_example", label: "Worked example", icon: "✎" },
  { id: "diagnose", label: "Diagnose", icon: "◍" },
  { id: "remediate", label: "Remediate", icon: "⚕" },
  { id: "next_activity", label: "What next", icon: "★" },
];

const DIFFICULTY_LABEL: Record<DifficultyReq, string> = {
  auto: "Auto",
  easier: "Easier",
  same: "Same",
  harder: "Harder",
};

/** Heuristic map from a follow-up chip to the intent it implies. */
function inferIntent(text: string): Intent {
  const t = text.toLowerCase();
  if (t.includes("worked example")) return "worked_example";
  if (t.includes("hint")) return "hint";
  if (t.includes("practice") || t.includes("fix")) return "remediate";
  if (t.includes("next") || t.includes("different option")) return "next_activity";
  if (t.includes("question") || t.includes("ask me")) return "socratic";
  return "explain";
}

const difficultyTone: Record<string, string> = {
  foundational: "amber",
  core: "sky",
  stretch: "violet",
};

export function TutorPanel({
  studentId,
  assessmentId,
  skillId,
  contextLabel,
}: {
  studentId: number;
  assessmentId?: number;
  skillId?: number;
  contextLabel?: string;
}) {
  const toast = useToast();
  const [turns, setTurns] = useState<Turn[]>([]);
  const [difficulty, setDifficulty] = useState<DifficultyReq>("auto");
  const [message, setMessage] = useState("");
  const [loading, setLoading] = useState(false);
  const scrollRef = useRef<HTMLDivElement>(null);

  const ask = useCallback(
    async (intent: Intent, text: string) => {
      if (loading) return;
      setLoading(true);
      if (text.trim()) setTurns((cur) => [...cur, { role: "learner", text: text.trim() }]);
      try {
        const res = await fetch("/api/tutor", {
          method: "POST",
          headers: { "Content-Type": "application/json" },
          body: JSON.stringify({
            action: "ask",
            studentId,
            intent,
            difficulty,
            message: text.trim() || undefined,
            assessmentId,
            skillId,
          }),
        });
        const payload = (await res.json()) as TutorResponse & { error?: string };
        if (!res.ok) throw new Error(payload.error ?? "The tutor could not respond.");
        setTurns((cur) => [...cur, { role: "tutor", response: payload, helpful: null }]);
        setMessage("");
        // Scroll the transcript to the latest turn.
        requestAnimationFrame(() => {
          scrollRef.current?.scrollTo({ top: scrollRef.current.scrollHeight, behavior: "smooth" });
        });
      } catch (caught) {
        toast.error("Tutor unavailable", caught instanceof Error ? caught.message : undefined);
      } finally {
        setLoading(false);
      }
    },
    [assessmentId, difficulty, loading, skillId, studentId, toast],
  );

  const rate = useCallback(
    async (index: number, interactionId: number, helpful: boolean) => {
      setTurns((cur) => cur.map((t, i) => (i === index && t.role === "tutor" ? { ...t, helpful } : t)));
      try {
        await fetch("/api/tutor", {
          method: "POST",
          headers: { "Content-Type": "application/json" },
          body: JSON.stringify({ action: "feedback", interactionId, helpful }),
        });
      } catch {
        /* feedback is best-effort */
      }
    },
    [],
  );

  return (
    <Card>
      <CardHeader
        title="AI tutor"
        subtitle={
          contextLabel
            ? `Grounded in your learner model · ${contextLabel}`
            : "Grounded in your live learner model — it never sets your mastery"
        }
        action={
          <div className="flex items-center gap-1 rounded-lg bg-slate-100 p-0.5">
            {(Object.keys(DIFFICULTY_LABEL) as DifficultyReq[]).map((d) => (
              <button
                key={d}
                onClick={() => setDifficulty(d)}
                className={cn(
                  "rounded-md px-2 py-1 text-[11px] font-medium transition",
                  difficulty === d ? "bg-white text-slate-900 shadow-sm" : "text-slate-500 hover:text-slate-700",
                )}
              >
                {DIFFICULTY_LABEL[d]}
              </button>
            ))}
          </div>
        }
      />

      {/* transcript */}
      <div ref={scrollRef} className="mt-4 max-h-[420px] space-y-3 overflow-y-auto scrollbar-thin pr-1">
        {turns.length === 0 ? (
          <div className="rounded-xl border border-dashed border-slate-200 p-4 text-sm text-slate-500">
            Ask for an explanation, a hint, a worked example, or what to do next. During an active assessment the tutor
            will coach you without revealing answers.
          </div>
        ) : (
          turns.map((turn, i) =>
            turn.role === "learner" ? (
              <div key={i} className="ml-auto max-w-[85%] rounded-2xl rounded-br-sm bg-indigo-600 px-3 py-2 text-sm text-white">
                {turn.text}
              </div>
            ) : (
              <TutorBubble key={i} turn={turn} index={i} onFollowUp={ask} onRate={rate} />
            ),
          )
        )}
        {loading ? (
          <div className="flex items-center gap-2 text-sm text-slate-400">
            <Spinner /> Thinking…
          </div>
        ) : null}
      </div>

      {/* intents */}
      <div className="mt-4 flex flex-wrap gap-1.5">
        {INTENTS.map((it) => (
          <button
            key={it.id}
            disabled={loading}
            onClick={() => ask(it.id, message)}
            className={cn(buttonClass("secondary", "sm"), "gap-1 disabled:opacity-50")}
          >
            <span aria-hidden>{it.icon}</span>
            {it.label}
          </button>
        ))}
      </div>

      {/* free-text */}
      <form
        className="mt-3 flex gap-2"
        onSubmit={(e) => {
          e.preventDefault();
          if (message.trim()) ask("explain", message);
        }}
      >
        <input
          value={message}
          onChange={(e) => setMessage(e.target.value)}
          placeholder="Ask the tutor a question…"
          className="min-w-0 flex-1 rounded-lg border border-slate-200 px-3 py-2 text-sm outline-none focus:border-indigo-400"
        />
        <button type="submit" disabled={loading || !message.trim()} className={cn(buttonClass("primary", "sm"), "disabled:opacity-50")}>
          Send
        </button>
      </form>
    </Card>
  );
}

function TutorBubble({
  turn,
  index,
  onFollowUp,
  onRate,
}: {
  turn: Extract<Turn, { role: "tutor" }>;
  index: number;
  onFollowUp: (intent: Intent, text: string) => void;
  onRate: (index: number, interactionId: number, helpful: boolean) => void;
}) {
  const r = turn.response;
  const [showWhy, setShowWhy] = useState(false);
  return (
    <div className="max-w-[92%] rounded-2xl rounded-bl-sm border border-slate-200 bg-slate-50 px-3.5 py-3 text-sm">
      <div className="mb-1.5 flex flex-wrap items-center gap-1.5">
        <Badge tone="slate">{r.intent.replace("_", " ")}</Badge>
        <Badge tone={difficultyTone[r.difficulty] ?? "slate"}>{r.difficulty}</Badge>
        {r.withheldAnswer ? <Badge tone="rose">answer hidden</Badge> : null}
        {r.adjustedIntent ? <Badge tone="amber">adjusted</Badge> : null}
        <span className="ml-auto text-[10px] uppercase tracking-wide text-slate-400">{r.provider}</span>
      </div>

      <p className="whitespace-pre-wrap leading-relaxed text-slate-800">{r.message}</p>

      {r.suggestedActivity ? (
        <div className="mt-2 rounded-lg border border-indigo-100 bg-indigo-50/60 px-3 py-2">
          <p className="text-[11px] font-semibold uppercase tracking-wide text-indigo-500">Suggested next</p>
          <p className="text-sm font-medium text-slate-800">{r.suggestedActivity.title}</p>
          <p className="text-xs text-slate-500">{r.suggestedActivity.reason}</p>
        </div>
      ) : null}

      {r.followUps.length ? (
        <div className="mt-2 flex flex-wrap gap-1.5">
          {r.followUps.map((f) => (
            <button
              key={f}
              onClick={() => onFollowUp(inferIntent(f), f)}
              className="rounded-full border border-slate-200 bg-white px-2.5 py-1 text-xs text-slate-600 transition hover:border-indigo-300 hover:text-indigo-600"
            >
              {f}
            </button>
          ))}
        </div>
      ) : null}

      <div className="mt-2.5 flex items-center gap-3 text-[11px] text-slate-400">
        <button onClick={() => setShowWhy((s) => !s)} className="hover:text-slate-600">
          {showWhy ? "Hide grounding" : "Why this answer?"}
        </button>
        <span className="ml-auto flex items-center gap-1.5">
          Helpful?
          <button
            aria-label="Helpful"
            onClick={() => onRate(index, r.interactionId, true)}
            className={cn("rounded px-1 hover:text-emerald-600", turn.helpful === true && "text-emerald-600")}
          >
            ↑
          </button>
          <button
            aria-label="Not helpful"
            onClick={() => onRate(index, r.interactionId, false)}
            className={cn("rounded px-1 hover:text-rose-600", turn.helpful === false && "text-rose-600")}
          >
            ↓
          </button>
        </span>
      </div>

      {showWhy ? (
        <div className="mt-2 space-y-1.5 border-t border-slate-200 pt-2 text-[11px] text-slate-500">
          {r.guardrails.length ? (
            <div>
              <span className="font-semibold text-slate-600">Guardrails:</span>{" "}
              {r.guardrails.join(" ")}
            </div>
          ) : null}
          {r.citations.length ? (
            <div className="flex flex-wrap gap-1">
              <span className="font-semibold text-slate-600">Grounded in:</span>
              {r.citations.map((c, i) => (
                <span key={i} className="rounded bg-white px-1.5 py-0.5 ring-1 ring-slate-200">
                  {c.type}: {c.ref}
                </span>
              ))}
            </div>
          ) : null}
          {r.disclaimers.map((d, i) => (
            <p key={i} className="italic">
              {d}
            </p>
          ))}
        </div>
      ) : null}
    </div>
  );
}
