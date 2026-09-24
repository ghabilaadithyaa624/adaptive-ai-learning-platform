"use client";

import Link from "next/link";
import { usePathname, useRouter } from "next/navigation";
import { useEffect, useState, type ReactNode } from "react";
import { Avatar, buttonClass } from "@/components/ui";
import { useToast } from "@/components/toast";
import { cn, roleLabels } from "@/lib/utils";

export type ShellUser = {
  id: number;
  name: string;
  email: string;
  role: string;
  avatarColor: string;
};

const NAV: { href: string; label: string; icon: string; roles?: string[]; studentLabel?: string }[] = [
  { href: "/dashboard", label: "Overview", icon: "◎" },
  { href: "/dashboard/students", label: "Learners", icon: "☺" },
  { href: "/dashboard/gaps", label: "Knowledge gaps", icon: "◍" },
  { href: "/dashboard/assessments", label: "Adaptive quizzes", icon: "✎" },
  { href: "/dashboard/paths", label: "Learning paths", icon: "⇥" },
  { href: "/dashboard/recommendations", label: "Recommendations", icon: "★" },
  { href: "/dashboard/analytics", label: "Progress analytics", icon: "▲" },
  { href: "/dashboard/skills", label: "Skill catalog", icon: "▤" },
  { href: "/dashboard/questions", label: "Question bank", icon: "?", roles: ["teacher", "trainer", "institution", "admin"] },
  { href: "/dashboard/models", label: "AI models", icon: "⚙", roles: ["teacher", "trainer", "institution", "admin"] },
  { href: "/dashboard/admin", label: "Administration", icon: "⛭", roles: ["admin", "institution"] },
];

export function AppShell({ user, children }: { user: ShellUser; children: ReactNode }) {
  const pathname = usePathname();
  const router = useRouter();
  const toast = useToast();
  const [mobileOpen, setMobileOpen] = useState(false);
  const [signingOut, setSigningOut] = useState(false);

  useEffect(() => {
    setMobileOpen(false);
  }, [pathname]);

  const items = NAV.filter((item) => !item.roles || item.roles.includes(user.role)).map((item) =>
    user.role === "student" && item.href === "/dashboard/students"
      ? { ...item, href: `/dashboard/students/${user.id}`, label: "My progress" }
      : item,
  );

  const active = (href: string) => pathname === href || (href !== "/dashboard" && pathname.startsWith(href));
  const currentLabel = items.find((item) => active(item.href))?.label ?? "Overview";

  const signOut = async () => {
    setSigningOut(true);
    try {
      await fetch("/api/auth", {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ action: "logout" }),
      });
      toast.info("Signed out", "See you soon.");
      router.replace("/login");
    } finally {
      setSigningOut(false);
    }
  };

  const sidebar = (
    <div className="flex h-full flex-col gap-1">
      <Link href="/dashboard" className="mb-4 flex items-center gap-2.5 px-2 py-1">
        <span className="flex h-9 w-9 items-center justify-center rounded-xl bg-gradient-to-br from-indigo-500 to-sky-500 text-sm font-bold text-white shadow-sm">
          AQ
        </span>
        <span>
          <span className="block text-sm font-semibold tracking-tight text-slate-900">AdaptiQ</span>
          <span className="block text-[11px] text-slate-500">Adaptive learning engine</span>
        </span>
      </Link>
      <nav className="flex-1 space-y-0.5 overflow-y-auto pr-1 scrollbar-thin">
        {items.map((item) => (
          <Link
            key={item.href}
            href={item.href}
            className={cn(
              "flex items-center gap-2.5 rounded-lg px-3 py-2 text-sm transition",
              active(item.href)
                ? "bg-indigo-50 font-semibold text-indigo-700 ring-1 ring-inset ring-indigo-100"
                : "text-slate-600 hover:bg-slate-100",
            )}
          >
            <span className="w-4 text-center text-xs opacity-70">{item.icon}</span>
            {item.label}
          </Link>
        ))}
      </nav>
    </div>
  );

  return (
    <div className="min-h-screen lg:flex">
      <aside className="hidden w-64 shrink-0 border-r border-slate-200 bg-white p-3 lg:flex lg:flex-col">{sidebar}</aside>

      {mobileOpen ? (
        <div className="fixed inset-0 z-40 lg:hidden">
          <button className="absolute inset-0 bg-slate-900/30" aria-label="Close navigation" onClick={() => setMobileOpen(false)} />
          <div className="absolute inset-y-0 left-0 w-72 bg-white p-3 shadow-xl">{sidebar}</div>
        </div>
      ) : null}

      <div className="flex min-w-0 flex-1 flex-col">
        <header className="sticky top-0 z-30 border-b border-slate-200 bg-white/85 backdrop-blur">
          <div className="flex items-center justify-between gap-3 px-4 py-3 sm:px-6">
            <div className="flex min-w-0 items-center gap-2">
              <button
                className={cn(buttonClass("ghost", "sm", "lg:hidden"), "px-2")}
                onClick={() => setMobileOpen((open) => !open)}
                aria-label="Toggle navigation"
              >
                ☰
              </button>
              <div className="min-w-0">
                <p className="truncate text-sm font-semibold text-slate-900">{currentLabel}</p>
                <p className="hidden truncate text-[11px] text-slate-500 sm:block">
                  Personalised mastery tracking · Bayesian knowledge tracing · hybrid recommendations
                </p>
              </div>
            </div>
            <div className="flex items-center gap-3">
              <div className="hidden items-center gap-2 rounded-full bg-slate-50 px-3 py-1.5 ring-1 ring-inset ring-slate-200 sm:flex">
                <span className="h-2 w-2 rounded-full bg-emerald-500" />
                <span className="text-[11px] font-medium text-slate-600">Models live</span>
              </div>
              <div className="flex items-center gap-2">
                <Avatar name={user.name} color={user.avatarColor} size={32} />
                <div className="hidden text-right sm:block">
                  <p className="text-xs font-semibold text-slate-800">{user.name}</p>
                  <p className="text-[11px] text-slate-500">{roleLabels[user.role] ?? user.role}</p>
                </div>
              </div>
              <button className={buttonClass("secondary", "sm")} onClick={signOut} disabled={signingOut}>
                {signingOut ? "Signing out…" : "Sign out"}
              </button>
            </div>
          </div>
        </header>
        <main className="mx-auto w-full max-w-[1400px] flex-1 space-y-5 p-4 sm:p-6">{children}</main>
        <footer className="px-6 pb-6 pt-2 text-center text-[11px] text-slate-400">
          AdaptiQ · knowledge tracing, difficulty classification and hybrid recommendations running on live learner telemetry
        </footer>
      </div>
    </div>
  );
}
