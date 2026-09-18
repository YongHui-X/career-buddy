import { fillSession, handoffSession, getSession } from "@/lib/apply/session";
import { resolveTailoredCv, resolveTailoredCvArtifact, companyFromTitle } from "@/lib/apply/cv";
import type { ApplyField } from "@/lib/apply/extract";
import { applyApiDisabled } from "@/lib/apply/api-guard";

export const runtime = "nodejs";
export const dynamic = "force-dynamic";
export const maxDuration = 120;

// Fill the real form behind the scenes (headed-but-off-screen), screenshotting
// each step for the "behind the scenes" strip, then bring the window to the front
// so the HUMAN reviews and submits. NEVER submits — there is no submit path here.
export async function POST(req: Request) {
  const disabled = applyApiDisabled(); if (disabled) return disabled;
  let body: { sessionId?: string; answers?: Record<string, string>; fields?: ApplyField[]; handoff?: boolean; company?: string; cvArtifact?: string };
  try {
    body = await req.json();
  } catch {
    return Response.json({ error: "bad json" }, { status: 400 });
  }
  const { sessionId, answers = {}, fields = [], handoff, company } = body;
  if (!sessionId) return Response.json({ error: "sessionId required" }, { status: 400 });

  // Resolve the tailored CV server-side (never trust a client path): by the
  // offer's company if known, else best-effort from the form title.
  const session = getSession(sessionId);
  const cvPath = resolveTailoredCvArtifact(body.cvArtifact) ?? resolveTailoredCv(company) ?? resolveTailoredCv(companyFromTitle(session?.title)) ?? undefined;

  try {
    const result = await fillSession(sessionId, answers, fields, cvPath);
    const resumeSteps = result.steps.filter((step) => /\(CV attached\)$/.test(step.label));
    const cvAttached = !!cvPath && resumeSteps.length > 0 && resumeSteps.every((step) => step.ok);
    if (handoff) await handoffSession(sessionId).catch(() => {});
    return Response.json({ ...result, handedOff: !!handoff, cvAttached });
  } catch (e) {
    return Response.json({ error: e instanceof Error ? e.message.slice(0, 200) : "fill failed" }, { status: 500 });
  }
}
