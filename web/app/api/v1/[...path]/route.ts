/**
 * Server-side proxy to the Aftershock API. The browser never sees the API key: it calls same-origin `/api/v1/*`, and
 * this handler forwards the request to AFTERSHOCK_API_URL with the bearer key added. Bodies stream both ways, so
 * server-sent events (index progress, the agent's steps) pass through unbuffered.
 *
 * Only `/api/v1/*` is reachable through here; `/mcp` and the OpenAPI docs stay on the API itself.
 */
import type { NextRequest } from "next/server";

export const dynamic = "force-dynamic";
export const runtime = "nodejs";

const UPSTREAM = (process.env.AFTERSHOCK_API_URL ?? "http://127.0.0.1:8100").replace(/\/+$/, "");
const KEY = process.env.AFTERSHOCK_API_KEY ?? "";
const SEGMENT = /^[\w.\-:@]+$/; // repo names, "dead-code", "diff.md"; never "." / ".." (checked below)
const PASS_REQ = ["content-type", "accept", "last-event-id"];
const PASS_RES = ["content-type", "cache-control", "x-accel-buffering", "retry-after"];

async function forward(req: NextRequest, ctx: { params: Promise<{ path: string[] }> }) {
  const { path } = await ctx.params;
  if (!path.length || path.some((s) => !SEGMENT.test(s) || s === "." || s === "..")) {
    return Response.json({ detail: "invalid path" }, { status: 400 });
  }
  const url = `${UPSTREAM}/api/v1/${path.map(encodeURIComponent).join("/")}${req.nextUrl.search}`;
  const headers = new Headers();
  for (const h of PASS_REQ) {
    const v = req.headers.get(h);
    if (v) headers.set(h, v);
  }
  if (KEY) headers.set("authorization", `Bearer ${KEY}`);
  const hasBody = req.method === "POST";
  let res: Response;
  try {
    res = await fetch(url, {
      method: req.method,
      headers,
      body: hasBody ? req.body : undefined,
      // @ts-expect-error: Node's fetch needs this to stream a request body; not in the DOM typings
      duplex: hasBody ? "half" : undefined,
      cache: "no-store",
      signal: req.signal, // the browser closing an SSE stream closes the upstream one
    });
  } catch {
    return Response.json({ detail: "Aftershock API unreachable" }, { status: 502 });
  }
  const out = new Headers();
  for (const h of PASS_RES) {
    const v = res.headers.get(h);
    if (v) out.set(h, v);
  }
  return new Response(res.body, { status: res.status, headers: out });
}

export { forward as DELETE, forward as GET, forward as POST };
