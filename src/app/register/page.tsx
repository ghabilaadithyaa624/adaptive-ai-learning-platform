import { redirect } from "next/navigation";
import { AuthForm } from "@/components/auth-form";
import { getCurrentUser } from "@/lib/auth";
import { ensureSeededSafe } from "@/lib/seed";

export const dynamic = "force-dynamic";

export default async function RegisterPage() {
  await ensureSeededSafe();
  const user = await getCurrentUser();
  if (user) redirect("/dashboard");
  return (
    <div className="grid-backdrop flex min-h-screen items-center justify-center px-4 py-12">
      <AuthForm mode="register" />
    </div>
  );
}
