"use client";

import { createContext, useCallback, useContext, useMemo, useState, type ReactNode } from "react";
import { cn } from "@/lib/utils";

type Toast = { id: number; title: string; description?: string; tone: "success" | "error" | "info" };

type ToastContextValue = {
  push: (toast: Omit<Toast, "id">) => void;
  success: (title: string, description?: string) => void;
  error: (title: string, description?: string) => void;
  info: (title: string, description?: string) => void;
};

const ToastContext = createContext<ToastContextValue | null>(null);

export function ToastProvider({ children }: { children: ReactNode }) {
  const [toasts, setToasts] = useState<Toast[]>([]);

  const push = useCallback((toast: Omit<Toast, "id">) => {
    const id = Date.now() + Math.random();
    setToasts((current) => [...current, { ...toast, id }]);
    setTimeout(() => setToasts((current) => current.filter((entry) => entry.id !== id)), 4200);
  }, []);

  const value = useMemo<ToastContextValue>(
    () => ({
      push,
      success: (title, description) => push({ title, description, tone: "success" }),
      error: (title, description) => push({ title, description, tone: "error" }),
      info: (title, description) => push({ title, description, tone: "info" }),
    }),
    [push],
  );

  return (
    <ToastContext.Provider value={value}>
      {children}
      <div className="pointer-events-none fixed inset-x-0 bottom-4 z-50 flex flex-col items-center gap-2 px-4 sm:bottom-6 sm:right-6 sm:left-auto sm:items-end">
        {toasts.map((toast) => (
          <div
            key={toast.id}
            className={cn(
              "animate-in pointer-events-auto w-full max-w-sm rounded-xl border bg-white px-4 py-3 shadow-lg",
              toast.tone === "success" && "border-emerald-200",
              toast.tone === "error" && "border-rose-200",
              toast.tone === "info" && "border-slate-200",
            )}
          >
            <div className="flex items-start gap-2">
              <span
                className={cn(
                  "mt-0.5 flex h-5 w-5 items-center justify-center rounded-full text-[11px] font-bold text-white",
                  toast.tone === "success" && "bg-emerald-500",
                  toast.tone === "error" && "bg-rose-500",
                  toast.tone === "info" && "bg-slate-700",
                )}
              >
                {toast.tone === "success" ? "✓" : toast.tone === "error" ? "!" : "i"}
              </span>
              <div className="min-w-0">
                <p className="text-sm font-semibold text-slate-900">{toast.title}</p>
                {toast.description ? <p className="mt-0.5 text-xs text-slate-500">{toast.description}</p> : null}
              </div>
            </div>
          </div>
        ))}
      </div>
    </ToastContext.Provider>
  );
}

export function useToast() {
  const context = useContext(ToastContext);
  if (!context) {
    return {
      push: () => {},
      success: () => {},
      error: () => {},
      info: () => {},
    } satisfies ToastContextValue;
  }
  return context;
}
