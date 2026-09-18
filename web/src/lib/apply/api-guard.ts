export function applyApiDisabled(): Response | null {
  if (process.env.CAREER_OPS_APPLY_API_DISABLED !== "true") return null;
  return Response.json({ error: "browser application APIs are disabled in this service" }, { status: 503 });
}
