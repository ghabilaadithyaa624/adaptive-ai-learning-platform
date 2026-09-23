"use client";

import { useRouter } from "next/navigation";
import { useState, useTransition } from "react";
import { Badge, buttonClass, EmptyState } from "@/components/ui";
import { useToast } from "@/components/toast";
import { cn } from "@/lib/utils";
import type { RecommendationView } from "@/lib/queries";

const STATUS_TONE: Record<string, "violet" | "emerald" | "amber" | "slate" | "sky"> = {
  new: "violet",
  accepted: "sky",
  completed: "emerald",
  dismissed: "slate",
};

export function RecommendationQueue({
  items,
  showLearner = true,
  emptyHint = "Generate priorities to populate the queue from the live mastery model.",
  compact = false,
}: {
  items: RecommendationView[];
  showLearner?: boolean;
  emptyHint?: string;
  compact?: boolean;
}) {
  const router = useRouter();
  const toast = useToast();
  const [optimistic, setOptimistic] = useState<Record<number, string>>({});
  const [pending, startTransition] = useTransition();

  const act = async (id: number, status: string) => {
    setOptimistic((current) => ({ ...current, [id]: status }));
    try {
      const response = await fetch(`/api/recommendations/${id}`, {
        method: "PATCH",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ status }),
      });
      if (!response.ok) {
        const payload = (await response.json()) as { error?: string };
        throw new Error(payload.error ?? "Update failed");
      }
      toast.success(`Priority marked ${status}`, "Recommendation engine will re-rank on the next refresh.");
      startTransition(() => router.refresh());
    } catch (caught) {
      setOptimistic((current) => {
        const next = { ...current };
        delete next[id];
        return next;
      });
      toast.error("Could not update priority", caught instanceof Error ? caught.message : undefined);
    }
  };

  if (!items.length) {
    return <EmptyState icon="★" title="No priorities in the queue" description={emptyHint} />;
  }

  return (
    <ul className={cn("divide-y divide-slate-100", pending && "opacity-95")}>
      {items.map((item) => {
        const status = optimistic[item.id] ?? item.status;
        const factors = Object.entries(item.factors ?? {}).sort((a, b) => b[1] - a[1]).slice(0, 3);
        return (
          <li key={item.id} className="flex flex-col gap-3 py-3 first:pt-0 last:pb-0 sm:flex-row sm:items-start sm:justify-between">
            <div className="min-w-0">
              <div className="flex flex-wrap items-center gap-2">
                <Badge tone={STATUS_TONE[status] ?? "slate"}>{status}</Badge>
                <Badge tone="slate">{item.kind}</Badge>
                <span className="text-[11px] font-medium text-slate-500">priority {Math.round(item.priority * 100)}/100</span>
                {showLearner ? <span className="text-[11px] text-slate-400">· {item.studentName}</span> : null}
              </div>
              <p className="mt-1.5 text-sm font-semibold text-slate-800">{item.title}</p>
              <p className="mt-0.5 text-xs leading-relaxed text-slate-500">{item.reason}</p>
              {!compact && factors.length ? (
                <div className="mt-2 flex flex-wrap gap-1.5">
                  {factors.map(([key, value]) => (
                    <span key={key} className="rounded-md bg-slate-50 px-2 py-0.5 text-[11px] text-slate-500 ring-1 ring-inset ring-slate-200">
                      {key} {Math.round(value)}
                    </span>
                  ))}
                  <span className="rounded-md bg-slate-50 px-2 py-0.5 text-[11px] text-slate-500 ring-1 ring-inset ring-slate-200">
                    conf {Math.round(item.confidence * 100)}%
                  </span>
                </div>
              ) : null}
            </div>
            <div className="flex shrink-0 gap-2">
              {status === "new" ? (
                <>
                  <button className={buttonClass("primary", "sm")} onClick={() => act(item.id, "accepted")}>
                    Accept
                  </button>
                  <button className={buttonClass("secondary", "sm")} onClick={() => act(item.id, "dismissed")}>
                    Dismiss
                  </button>
                </>
              ) : null}
              {status === "accepted" ? (
                <button className={buttonClass("secondary", "sm")} onClick={() => act(item.id, "completed")}>
                  Mark done
                </button>
              ) : null}
              {status === "dismissed" || status === "completed" ? (
                <button className={buttonClass("ghost", "sm")} onClick={() => act(item.id, "new")}>
                  Reopen
                </button>
              ) : null}
            </div>
          </li>
        );
      })}
    </ul>
  );
}
