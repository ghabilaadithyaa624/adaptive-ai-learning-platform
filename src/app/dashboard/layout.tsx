import { redirect } from "next/navigation";
import type { ReactNode } from "react";
import { AppShell } from "@/components/shell";
import { getCurrentUser } from "@/lib/auth";
import { ensureSeededSafe } from "@/lib/seed";

export const dynamic = "force-dynamic";

export default async function DashboardLayout({ children }: { children: ReactNode }) {
  await ensureSeededSafe();
  const user = await getCurrentUser();
  if (!user) redirect("/login");
  return (
    <AppShell user={{ id: user.id, name: user.name, email: user.email, role: user.role, avatarColor: user.avatarColor }}>
      {children}
    </AppShell>
  );
}
