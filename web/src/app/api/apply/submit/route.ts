import { submitSession, type Preauthorize } from "@/lib/apply/session";
import type { ApplyField } from "@/lib/apply/extract";
import { applyApiDisabled } from "@/lib/apply/api-guard";

export const runtime = "nodejs";
export const dynamic = "force-dynamic";
export const maxDuration = 120;

export async function POST(req: Request) {
  const disabled = applyApiDisabled(); if (disabled) return disabled;
  let body: {
    sessionId?: string;
    answers?: Record<string, string>;
    fields?: ApplyField[];
    expectedCompany?: string;
    expectedRole?: string;
    // Absent means refuse, so an interactive caller cannot auto-attest.
    preauthorize?: Preauthorize;
  };
  try { body = await req.json(); } catch { return Response.json({ error: "bad json" }, { status: 400 }); }
  if (!body.sessionId || !body.expectedCompany || !body.expectedRole) {
    return Response.json({ error: "sessionId, expectedCompany, and expectedRole are required" }, { status: 400 });
  }
  const result = await submitSession(body.sessionId, body.answers || {}, body.fields || [], body.expectedCompany, body.expectedRole, body.preauthorize);
  return Response.json(result);
}
