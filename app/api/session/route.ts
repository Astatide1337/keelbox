import { authorized, bootstrap, csrf, denied } from "@/lib/server/security";

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
  return Response.json(
    {
      csrf: csrf(),
      lab: null,
      aiEnabled: true,

    },
    { headers: { "Cache-Control": "no-store" } },
  );
}
