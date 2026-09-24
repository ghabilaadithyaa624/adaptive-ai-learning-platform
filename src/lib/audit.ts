/**
 * Security audit logging.
 *
 * Writes structured, security-relevant events to the `audit_logs` table.
 * Audit failures must never break the request being audited, so every write is
 * wrapped in try/catch (and additionally logged to the server console).
 */
import { db } from "@/db";
import { auditLogs } from "@/db/schema";
import type { User } from "@/db/schema";

export type AuditEntry = {
  actor?: Pick<User, "id" | "role" | "email"> | null;
  action: string;
  resource?: string;
  resourceId?: string | number | null;
  targetStudentId?: number | null;
  institutionId?: number | null;
  outcome?: "success" | "denied" | "failure";
  ip?: string | null;
  detail?: string | null;
};

export async function recordAudit(entry: AuditEntry): Promise<void> {
  try {
    await db.insert(auditLogs).values({
      actorId: entry.actor?.id ?? null,
      actorRole: entry.actor?.role ?? null,
      actorEmail: entry.actor?.email ?? null,
      action: entry.action,
      resource: entry.resource ?? null,
      resourceId: entry.resourceId === undefined || entry.resourceId === null ? null : String(entry.resourceId),
      targetStudentId: entry.targetStudentId ?? null,
      institutionId: entry.institutionId ?? null,
      outcome: entry.outcome ?? "success",
      ip: entry.ip ?? null,
      detail: entry.detail ? entry.detail.slice(0, 1000) : null,
    });
  } catch (error) {
    // Never let audit failures surface to the caller.
    console.error("[audit] failed to record entry", entry.action, error);
  }
}
