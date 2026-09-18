import fs from "node:fs";
import path from "node:path";
import * as yaml from "js-yaml";
import { applyApiDisabled } from "@/lib/apply/api-guard";
import { openAuthenticatedLogin } from "@/lib/apply/session";
import { careerOpsRoot } from "@/lib/career-ops";

export const runtime = "nodejs";
export const dynamic = "force-dynamic";

export async function POST(req: Request) {
  const disabled = applyApiDisabled();
  if (disabled) return disabled;
  let body: { url?: string };
  try { body = await req.json(); } catch { return Response.json({ error: "bad json" }, { status: 400 }); }
  if (!body.url || !/^https:\/\//i.test(body.url)) return Response.json({ error: "HTTPS url required" }, { status: 400 });
  let allowed: string[] = [];
  try {
    const portals = yaml.load(fs.readFileSync(path.join(careerOpsRoot(), "portals.yml"), "utf8")) as { browser_sources?: Array<{ url?: string; enabled?: boolean }> };
    // Every configured browser_sources URL is allowed, including `enabled: false` ones:
    // authenticating a source is the step that PRECEDES enabling it, so filtering
    // disabled entries out made the documented login flow impossible (403).
    allowed = (portals.browser_sources || []).map((x) => x.url || "").filter(Boolean);
  } catch { /* handled by allow-list failure */ }
  if (!allowed.includes(body.url)) return Response.json({ error: "url is not an enabled browser_sources entry" }, { status: 403 });
  try {
    await openAuthenticatedLogin(body.url);
    return Response.json({ opened: true });
  } catch (error) {
    return Response.json({ error: error instanceof Error ? error.message.slice(0, 200) : "login browser failed" }, { status: 500 });
  }
}
