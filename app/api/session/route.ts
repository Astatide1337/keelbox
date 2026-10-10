import { authorized, bootstrap, csrf, denied } from "@/lib/server/security";
import { runtime } from "@/lib/server/runtime";
export const dynamic = "force-dynamic";
export async function POST(request: Request) {
  const result = bootstrap(request);
  if (!result) return denied();
  return Response.json(
    { csrf: result.csrf },
    { headers: { "Set-Cookie": result.cookie, "Cache-Control": "no-store" } },
  );
}
export async function GET(request: Request) {
  if (!authorized(request)) return denied();
  await runtime.load();
  return Response.json(
    {
      csrf: csrf(),
      lab: await runtime.observe(),
      aiEnabled: process.env.PLAYGROUND_AI_ENABLED === "1",
      devMode: process.env.PLAYGROUND_AI_ENABLED !== "1",
    },
    { headers: { "Cache-Control": "no-store" } },
  );
}
