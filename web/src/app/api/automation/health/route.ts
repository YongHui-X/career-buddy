export const runtime = "nodejs";
export const dynamic = "force-dynamic";

export async function GET() {
  return Response.json({
    service: "career-ops-apply",
    browserApiDisabled: process.env.CAREER_OPS_APPLY_API_DISABLED === "true",
  });
}
