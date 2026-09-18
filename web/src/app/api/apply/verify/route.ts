import { verifySession } from "@/lib/apply/session";
import { applyApiDisabled } from "@/lib/apply/api-guard";

export const runtime = "nodejs";
export async function POST(req: Request) {
  const disabled = applyApiDisabled(); if (disabled) return disabled;
  const body = await req.json().catch(() => null);
  if (!body?.sessionId || !Array.isArray(body.fields) || !body.answers || typeof body.answers !== "object") {
    return Response.json({ error: "sessionId, fields and answers required" }, { status: 400 });
  }
  try { return Response.json(await verifySession(body.sessionId, body.fields, body.answers)); }
  catch { return Response.json({ error: "Could not verify application session" }, { status: 400 }); }
}
