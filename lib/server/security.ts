import { timingSafeEqual, randomBytes } from "node:crypto";
export const localOrigin = () => {
  const value = process.env.PLAYGROUND_ORIGIN ?? "http://127.0.0.1:3000",
    url = new URL(value);
  if (
    url.protocol !== "http:" ||
    url.hostname !== "127.0.0.1" ||
    url.username ||
    url.password ||
    url.pathname !== "/" ||
    url.search ||
    url.hash
  )
    throw Error("Waypoint requires a plain HTTP loopback origin on 127.0.0.1.");
  return url.origin;
};
const authGlobal = globalThis as typeof globalThis & {
  playgroundAuth?: { cookie: string; csrf: string; bootstrapUsed: boolean };
};
const auth = (authGlobal.playgroundAuth ??= {
  cookie: randomBytes(32).toString("hex"),
  csrf: randomBytes(24).toString("hex"),
  bootstrapUsed: false,
});
const equal = (a: string, b: string) => {
  const aa = Buffer.from(a),
    bb = Buffer.from(b);
  return aa.length === bb.length && timingSafeEqual(aa, bb);
};
export function validHost(request: Request) {
  return request.headers.get("host") === new URL(localOrigin()).host;
}
export function authorized(request: Request, write = false) {
  if (
    !validHost(request) ||
    (request.headers.get("origin") &&
      request.headers.get("origin") !== localOrigin()) ||
    request.headers.get("sec-fetch-site") === "cross-site"
  )
    return false;
  const cookie =
    (request.headers.get("cookie") ?? "")
      .split(";")
      .map((x) => x.trim())
      .find((x) => x.startsWith("playground="))
      ?.slice(11) ?? "";
  const bearer =
    request.headers.get("authorization")?.replace(/^Bearer /, "") ?? "";
  const cli = process.env.PLAYGROUND_API_TOKEN ?? "";
  if (!(equal(cookie, auth.cookie) || (cli && equal(bearer, cli))))
    return false;
  if (write) {
    if (request.headers.get("origin") !== localOrigin()) return false;
    if (
      !equal(request.headers.get("x-playground-csrf") ?? "", auth.csrf) &&
      !(cli && equal(bearer, cli))
    )
      return false;
  }
  return true;
}
export function bootstrap(request: Request) {
  if (!validHost(request) || request.headers.get("origin") !== localOrigin())
    return null;
  const token = request.headers.get("x-playground-bootstrap") ?? "";
  const expected = process.env.PLAYGROUND_BOOTSTRAP ?? "";
  if (!expected || auth.bootstrapUsed || !equal(token, expected)) return null;
  auth.bootstrapUsed = true;
  return {
    csrf: auth.csrf,
    cookie: `playground=${auth.cookie}; HttpOnly; SameSite=Strict; Path=/`,
  };
}
export function csrf() {
  return auth.csrf;
}
export async function boundedJson(request: Request, limit = 2_000_000) {
  if (Number(request.headers.get("content-length") ?? 0) > limit)
    throw new Error("Request too large.");
  const reader = request.body?.getReader();
  let n = 0,
    s = "";
  const decoder = new TextDecoder();
  if (!reader) throw new Error("Request body required.");
  for (;;) {
    const { value, done } = await reader.read();
    if (done) break;
    n += value.byteLength;
    if (n > limit) {
      await reader.cancel();
      throw new Error("Request too large.");
    }
    s += decoder.decode(value, { stream: true });
  }
  return JSON.parse(s + decoder.decode());
}
export function denied() {
  return Response.json(
    {
      error:
        "Local session authorization required. Launch with pnpm dev and use its one-time connect link.",
    },
    { status: 403 },
  );
}

export function rotateSession() {
  auth.cookie = randomBytes(32).toString("hex");
  auth.csrf = randomBytes(24).toString("hex");
  return `playground=${auth.cookie}; HttpOnly; SameSite=Lax; Path=/`;
}
