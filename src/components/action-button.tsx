"use client";

import { useRouter } from "next/navigation";
import { useState } from "react";
import { buttonClass, Spinner } from "@/components/ui";
import { useToast } from "@/components/toast";

export function ActionButton({
  label,
  url,
  method = "POST",
  body,
  successMessage,
  errorMessage = "Action failed",
  variant = "primary",
  size = "md",
  className,
  loadingLabel,
}: {
  label: string;
  url: string;
  method?: "POST" | "PATCH" | "DELETE";
  body?: unknown;
  successMessage: string;
  errorMessage?: string;
  variant?: "primary" | "secondary" | "ghost" | "danger" | "subtle";
  size?: "sm" | "md" | "lg";
  className?: string;
  loadingLabel?: string;
}) {
  const router = useRouter();
  const toast = useToast();
  const [loading, setLoading] = useState(false);

  const run = async () => {
    setLoading(true);
    try {
      const response = await fetch(url, {
        method,
        headers: { "Content-Type": "application/json" },
        body: method === "DELETE" ? undefined : JSON.stringify(body ?? {}),
      });
      const payload = (await response.json().catch(() => ({}))) as { error?: string; message?: string };
      if (!response.ok) throw new Error(payload.error ?? errorMessage);
      toast.success(successMessage, payload.message);
      router.refresh();
    } catch (caught) {
      toast.error(errorMessage, caught instanceof Error ? caught.message : undefined);
    } finally {
      setLoading(false);
    }
  };

  return (
    <button className={buttonClass(variant, size, className)} onClick={run} disabled={loading}>
      {loading ? <Spinner className={variant === "primary" || variant === "danger" ? "border-white/40 border-t-white" : undefined} /> : null}
      {loading ? loadingLabel ?? "Working…" : label}
    </button>
  );
}
