import { NextResponse } from "next/server";
import { getCurrentUser } from "@/lib/auth";
import type { User } from "@/db/schema";

export function ok<T>(data: T, status = 200) {
  return NextResponse.json(data as Record<string, unknown>, { status });
}

export function fail(message: string, status = 400) {
  return NextResponse.json({ error: message }, { status });
}

export async function withUser(
  handler: (user: User) => Promise<Response>,
): Promise<Response> {
  const user = await getCurrentUser();
  if (!user) return fail("You must sign in to continue.", 401);
  try {
    return await handler(user);
  } catch (error) {
    const message = error instanceof Error ? error.message : "Unexpected server error";
    return fail(message, 500);
  }
}

export function toNumber(value: unknown, fallback = 0) {
  const parsed = typeof value === "string" ? Number(value) : typeof value === "number" ? value : NaN;
  return Number.isFinite(parsed) ? parsed : fallback;
}

export function toIdList(value: unknown): number[] {
  if (!Array.isArray(value)) return [];
  return value.map((entry) => toNumber(entry, -1)).filter((id) => id > 0);
}
