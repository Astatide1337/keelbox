import {
  authorized,
  denied,
  boundedJson,
  validHost,
} from "@/lib/server/security";
import { beginSignIn, loginOwner, authorizationUrl } from "@/lib/server/oauth";
import { safeError } from "@/lib/server/runtime";
export async function GET(request: Request) {
  if (!validHost(request)) return denied();
  try {
    return new Response(null, {
      status: 307,
      headers: {
        Location: authorizationUrl(
          new URL(request.url).searchParams.get("ticket") ?? "",
        ),
        "Cache-Control": "no-store",
        "Referrer-Policy": "no-referrer",
      },
    });
  } catch {
    return new Response(
      "This sign-in link expired or was already used. Return to Waypoint and start again.",
      { status: 400 },
    );
  }
}
export async function POST(request: Request) {
  if (!authorized(request, true)) return denied();
  try {
    const body = await boundedJson(request, 1000);
    return Response.json(
      await beginSignIn(
        loginOwner(request),
        typeof body.account === "string" ? body.account : undefined,
      ),
    );
  } catch (e) {
    return Response.json({ error: safeError(e) }, { status: 400 });
  }
}
