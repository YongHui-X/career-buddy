import { advanceSession } from "@/lib/apply/session";
import { applyApiDisabled } from "@/lib/apply/api-guard";

export const runtime = "nodejs";
export const dynamic = "force-dynamic";

export async function POST(req: Request) {
  const disabled = applyApiDisabled(); if (disabled) return disabled;
  let body: { sessionId?: string };
  try { body = await req.json(); } catch { return Response.json({ error: "bad json" }, { status: 400 }); }
  if (!body.sessionId) return Response.json({ error: "sessionId is required" }, { status: 400 });
  try { return Response.json(await advanceSession(body.sessionId)); }
  catch (error) { return Response.json({ error: error instanceof Error ? error.message.slice(0, 200) : "advance failed" }, { status: 500 }); }
}
