import { discoverAuthenticatedSources } from "@/lib/apply/session";
import { applyApiDisabled } from "@/lib/apply/api-guard";

export const runtime = "nodejs";
export const dynamic = "force-dynamic";
export const maxDuration = 300;

export async function POST(req: Request) {
  const disabled = applyApiDisabled(); if (disabled) return disabled;
  let body: { sources?: Array<{ name?: string; url: string }> };
  try { body = await req.json(); } catch { return Response.json({ error: "bad json" }, { status: 400 }); }
  const sources = (body.sources || []).filter((x) => x && /^https:\/\//i.test(x.url || ""));
  try { return Response.json(await discoverAuthenticatedSources(sources)); }
  catch (error) { return Response.json({ error: error instanceof Error ? error.message.slice(0, 200) : "browser discovery failed" }, { status: 500 }); }
}
