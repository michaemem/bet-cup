import { defineMiddleware } from "astro:middleware";
import { createClient, loadProfile } from "@/lib/supabase";

// Default-deny gate (PRD `## Access Control`): every route is private unless its
// prefix is listed here. `/api/auth/signout` is public so the sign-out form can
// clear a session-clearing request without a refresh-token race.
const PUBLIC_ROUTES = ["/auth/signin", "/api/auth/signin", "/api/auth/signout"];

function isPublic(pathname: string): boolean {
  return PUBLIC_ROUTES.some((route) => pathname === route || pathname.startsWith(route + "/"));
}

// Baseline security headers applied to every SSR response.
// `public/_headers` does NOT apply to SSR responses on @astrojs/cloudflare v13 — only static assets.
// See context/foundation/infrastructure.md Risk Register entry on this gap.
const SECURITY_HEADERS: Record<string, string> = {
  "Strict-Transport-Security": "max-age=63072000; includeSubDomains; preload",
  "X-Content-Type-Options": "nosniff",
  "X-Frame-Options": "DENY",
  "Referrer-Policy": "strict-origin-when-cross-origin",
  // 'unsafe-inline' on script-src is required for Astro Islands hydration; tighten with a nonce-based CSP post-MVP.
  "Content-Security-Policy":
    "default-src 'self'; script-src 'self' 'unsafe-inline'; style-src 'self' 'unsafe-inline'; img-src 'self' data: blob:; connect-src 'self' https://*.supabase.co; frame-ancestors 'none'; base-uri 'self'; form-action 'self'",
};

export const onRequest = defineMiddleware(async (context, next) => {
  const supabase = createClient(context.request.headers, context.cookies);

  if (supabase) {
    const {
      data: { user },
      error,
    } = await supabase.auth.getUser();
    if (error) {
      // Transient auth/Supabase failures fall through as "unauthenticated"
      // (fail-open to /auth/signin); log so the outage is diagnosable.
      console.error("[middleware] supabase.auth.getUser failed", { error });
    }
    context.locals.user = user ?? null;
    context.locals.profile = user ? await loadProfile(supabase, user.id) : null;
  } else {
    context.locals.user = null;
    context.locals.profile = null;
  }

  const { pathname } = context.url;

  const withSecurityHeaders = (response: Response): Response => {
    for (const [name, value] of Object.entries(SECURITY_HEADERS)) {
      response.headers.set(name, value);
    }
    return response;
  };

  if (isPublic(pathname)) {
    if (context.locals.user && pathname.startsWith("/auth/signin")) {
      return withSecurityHeaders(context.redirect("/dashboard"));
    }
  } else if (!context.locals.user) {
    return withSecurityHeaders(context.redirect("/auth/signin"));
  }

  return withSecurityHeaders(await next());
});
