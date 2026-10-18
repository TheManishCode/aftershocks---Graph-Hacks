/**
 * Optional gate for the whole UI. The proxy (app/api/v1) holds the API key, so anyone who can reach this server can
 * use the API through it. Locally that is you; anywhere else, set AFTERSHOCK_WEB_PASSWORD and the browser asks for
 * it (HTTP Basic, any user name). Serve it behind TLS when it leaves localhost.
 */
import { NextResponse, type NextRequest } from "next/server";

const PASSWORD = process.env.AFTERSHOCK_WEB_PASSWORD ?? "";

function sameString(a: string, b: string): boolean {
  // compare every byte so the time taken doesn't reveal how much of the password matched
  let diff = a.length ^ b.length;
  for (let i = 0; i < Math.max(a.length, b.length); i++) diff |= (a.charCodeAt(i) || 0) ^ (b.charCodeAt(i) || 0);
  return diff === 0;
}

/** Settings has one section, so /settings is an alias for it. Done in middleware rather than with
 *  `redirect()` in a page: the shell has already streamed by the time a page renders, so that path
 *  degrades to a one-second <meta refresh> the visitor can see. Applied after the password check —
 *  an unauthenticated visitor gets the challenge, not a tour of the routes. */
function alias(req: NextRequest): NextResponse | undefined {
  const { pathname } = req.nextUrl;
  if (pathname === "/settings" || pathname === "/settings/") {
    return NextResponse.redirect(new URL("/settings/models", req.url));
  }
  return undefined;
}

export function middleware(req: NextRequest) {
  if (!PASSWORD) return alias(req) ?? NextResponse.next();
  const header = req.headers.get("authorization") ?? "";
  if (header.startsWith("Basic ")) {
    try {
      const decoded = atob(header.slice(6));
      if (sameString(decoded.slice(decoded.indexOf(":") + 1), PASSWORD)) return alias(req) ?? NextResponse.next();
    } catch {
      /* malformed header: fall through to the challenge */
    }
  }
  return new NextResponse("Authentication required", {
    status: 401,
    headers: { "WWW-Authenticate": 'Basic realm="Aftershock", charset="UTF-8"' },
  });
}

export const config = { matcher: ["/((?!_next/static|_next/image|favicon.ico).*)"] };
