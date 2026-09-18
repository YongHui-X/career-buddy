import { inspectSession } from "@/lib/apply/session";
import { applyApiDisabled } from "@/lib/apply/api-guard";

export const runtime = "nodejs";
export async function POST(req: Request) {
  const disabled = applyApiDisabled(); if (disabled) return disabled;
  const body = await req.json().catch(() => null);
  if (!body?.sessionId) return Response.json({ error: "sessionId required" }, { status: 400 });
  try { return Response.json(await inspectSession(body.sessionId)); }
  catch { return Response.json({ error: "apply session not found or expired" }, { status: 404 }); }
}
