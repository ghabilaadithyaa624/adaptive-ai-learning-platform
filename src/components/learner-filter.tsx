"use client";

import { useRouter, useSearchParams } from "next/navigation";
import { inputClass } from "@/components/ui";

export function LearnerFilter({
  learners,
  basePath,
  current,
  label = "Learner",
}: {
  learners: { id: number; name: string; cohort: string | null }[];
  basePath: string;
  current?: number;
  label?: string;
}) {
  const router = useRouter();
  const params = useSearchParams();

  return (
    <label className="flex items-center gap-2 text-xs text-slate-500">
      <span className="hidden sm:inline">{label}</span>
      <select
        className={`${inputClass} w-56 py-1.5 text-xs`}
        value={current ? String(current) : ""}
        onChange={(event) => {
          const next = new URLSearchParams(params.toString());
          if (event.target.value) next.set("studentId", event.target.value);
          else next.delete("studentId");
          router.push(`${basePath}${next.toString() ? `?${next.toString()}` : ""}`);
        }}
      >
        <option value="">All learners</option>
        {learners.map((learner) => (
          <option key={learner.id} value={learner.id}>
            {learner.name}
            {learner.cohort ? ` · ${learner.cohort}` : ""}
          </option>
        ))}
      </select>
    </label>
  );
}
