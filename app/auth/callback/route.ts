import { callback } from "@/lib/server/oauth";
import { localOrigin, validHost, rotateSession } from "@/lib/server/security";
export async function GET(request: Request) {
  if (!validHost(request))
    return new Response("Invalid local callback host.", { status: 403 });
  try {
    const plan = await callback(new URL(request.url));
    return new Response(null, {
      status: 303,
      headers: {
        Location:
          localOrigin() + "/?auth=" + (plan ? "connected" : "identity-only"),
        "Set-Cookie": rotateSession(),
        "Cache-Control": "no-store",
        "Referrer-Policy": "no-referrer",
      },
    });
  } catch {
    return new Response(null, {
      status: 303,
      headers: {
        Location: localOrigin() + "/?auth=failed",
        "Cache-Control": "no-store",
        "Referrer-Policy": "no-referrer",
      },
    });
  }
}
