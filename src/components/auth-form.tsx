"use client";

import Link from "next/link";
import { useRouter } from "next/navigation";
import { useState } from "react";
import { useToast } from "@/components/toast";
import { buttonClass, inputClass, labelClass, Spinner } from "@/components/ui";

const DEMO_ACCOUNTS = [
  { label: "Learner", email: "student@adaptiq.ai", note: "Grade 11 · STEM Cohort A" },
  { label: "Teacher", email: "teacher@adaptiq.ai", note: "Runs differentiated cohorts" },
  { label: "Trainer", email: "trainer@adaptiq.ai", note: "Corporate upskilling" },
  { label: "Institution", email: "institution@adaptiq.ai", note: "University admin" },
  { label: "Platform admin", email: "admin@adaptiq.ai", note: "Models, users, tenants" },
];

export function AuthForm({ mode }: { mode: "login" | "register" }) {
  const router = useRouter();
  const toast = useToast();
  const [loading, setLoading] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const [form, setForm] = useState({
    name: "",
    email: mode === "login" ? "student@adaptiq.ai" : "",
    password: mode === "login" ? "password123" : "",
    role: "student",
    gradeLevel: "Grade 10",
    cohort: "New Cohort",
    goal: "Build a personalised mastery plan",
  });

  const update = (key: keyof typeof form, value: string) => setForm((current) => ({ ...current, [key]: value }));

  const submit = async (event: React.FormEvent) => {
    event.preventDefault();
    setLoading(true);
    setError(null);
    try {
      const response = await fetch("/api/auth", {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ action: mode, ...form }),
      });
      const payload = (await response.json()) as { error?: string };
      if (!response.ok) throw new Error(payload.error ?? "Something went wrong");
      toast.success(mode === "login" ? "Welcome back" : "Account created", "Loading your learning dashboard…");
      router.replace("/dashboard");
    } catch (caught) {
      const message = caught instanceof Error ? caught.message : "Something went wrong";
      setError(message);
      toast.error("Authentication failed", message);
    } finally {
      setLoading(false);
    }
  };

  const quickLogin = async (email: string) => {
    setForm((current) => ({ ...current, email, password: "password123" }));
    setLoading(true);
    setError(null);
    try {
      const response = await fetch("/api/auth", {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ action: "login", email, password: "password123" }),
      });
      const payload = (await response.json()) as { error?: string };
      if (!response.ok) throw new Error(payload.error ?? "Login failed");
      toast.success("Signed in", email);
      router.replace("/dashboard");
    } catch (caught) {
      const message = caught instanceof Error ? caught.message : "Login failed";
      setError(message);
      toast.error("Authentication failed", message);
    } finally {
      setLoading(false);
    }
  };

  return (
    <div className="w-full max-w-md">
      <form onSubmit={submit} className="card-surface space-y-4 p-6">
        <div>
          <Link href="/" className="mb-4 inline-flex items-center gap-2">
            <span className="flex h-9 w-9 items-center justify-center rounded-xl bg-gradient-to-br from-indigo-500 to-sky-500 text-sm font-bold text-white">
              AQ
            </span>
            <span className="text-sm font-semibold tracking-tight text-slate-900">AdaptiQ</span>
          </Link>
          <h1 className="text-lg font-semibold tracking-tight text-slate-900">
            {mode === "login" ? "Sign in to AdaptiQ" : "Create your AdaptiQ account"}
          </h1>
          <p className="mt-1 text-xs text-slate-500">
            {mode === "login"
              ? "Adaptive assessments, knowledge tracing and personalised paths for every learner."
              : "Pick your role — learners get a diagnostic, educators get cohort analytics."}
          </p>
        </div>

        {mode === "register" ? (
          <label className="block">
            <span className={labelClass}>Full name</span>
            <input className={inputClass} value={form.name} onChange={(event) => update("name", event.target.value)} required />
          </label>
        ) : null}

        <label className="block">
          <span className={labelClass}>Email</span>
          <input
            type="email"
            className={inputClass}
            value={form.email}
            onChange={(event) => update("email", event.target.value)}
            required
          />
        </label>

        <label className="block">
          <span className={labelClass}>Password</span>
          <input
            type="password"
            className={inputClass}
            value={form.password}
            onChange={(event) => update("password", event.target.value)}
            placeholder="At least 6 characters"
            required
          />
        </label>

        {mode === "register" ? (
          <div className="grid gap-3 sm:grid-cols-2">
            <label className="block">
              <span className={labelClass}>Role</span>
              <select className={inputClass} value={form.role} onChange={(event) => update("role", event.target.value)}>
                <option value="student">Student</option>
                <option value="teacher">Teacher</option>
                <option value="trainer">Trainer</option>
                <option value="institution">Institution admin</option>
                <option value="admin">Platform admin</option>
              </select>
            </label>
            <label className="block">
              <span className={labelClass}>Grade / level</span>
              <input className={inputClass} value={form.gradeLevel} onChange={(event) => update("gradeLevel", event.target.value)} />
            </label>
            <label className="block sm:col-span-2">
              <span className={labelClass}>Cohort</span>
              <input className={inputClass} value={form.cohort} onChange={(event) => update("cohort", event.target.value)} />
            </label>
            <label className="block sm:col-span-2">
              <span className={labelClass}>Learning goal</span>
              <input className={inputClass} value={form.goal} onChange={(event) => update("goal", event.target.value)} />
            </label>
          </div>
        ) : null}

        {error ? <p className="rounded-lg bg-rose-50 px-3 py-2 text-xs text-rose-700 ring-1 ring-inset ring-rose-200">{error}</p> : null}

        <button type="submit" className={buttonClass("primary", "md", "w-full")} disabled={loading}>
          {loading ? <Spinner className="border-white/40 border-t-white" /> : null}
          {mode === "login" ? "Sign in" : "Create account & continue"}
        </button>

        <p className="text-center text-xs text-slate-500">
          {mode === "login" ? (
            <>
              New here?{" "}
              <Link className="font-medium text-indigo-600 hover:underline" href="/register">
                Create an account
              </Link>
            </>
          ) : (
            <>
              Already registered?{" "}
              <Link className="font-medium text-indigo-600 hover:underline" href="/login">
                Sign in
              </Link>
            </>
          )}
        </p>
      </form>

      {mode === "login" ? (
        <div className="mt-4 rounded-2xl border border-slate-200 bg-white/70 p-4">
          <p className="text-xs font-semibold text-slate-700">One-click demo accounts</p>
          <p className="mt-1 text-[11px] text-slate-500">Password for every demo account: password123</p>
          <div className="mt-3 grid gap-2">
            {DEMO_ACCOUNTS.map((account) => (
              <button
                key={account.email}
                onClick={() => quickLogin(account.email)}
                disabled={loading}
                className="flex items-center justify-between gap-3 rounded-lg border border-slate-200 bg-white px-3 py-2 text-left transition hover:border-indigo-200 hover:bg-indigo-50/50 disabled:opacity-60"
              >
                <span>
                  <span className="block text-xs font-semibold text-slate-800">{account.label}</span>
                  <span className="block text-[11px] text-slate-500">{account.note}</span>
                </span>
                <span className="text-[11px] font-medium text-indigo-600">{account.email}</span>
              </button>
            ))}
          </div>
        </div>
      ) : null}
    </div>
  );
}
