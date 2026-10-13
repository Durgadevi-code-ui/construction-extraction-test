import type { NextConfig } from "next";

const isDev = process.env.NODE_ENV === "development";

/** Origin of the Supabase project: Live Update photos/voice notes are
 * shown from short-lived signed storage URLs on it (lib/liveUpdates.ts).
 * The browser never calls Supabase's API itself (everything goes through
 * /api/*), so it is needed only for img/media. */
function supabaseOrigin(): string {
  try {
    return new URL(process.env.NEXT_PUBLIC_SUPABASE_URL ?? "").origin;
  } catch {
    return "";
  }
}

/**
 * Content-Security-Policy, following the "Without Nonces" setup in
 * node_modules/next/dist/docs/01-app/02-guides/content-security-policy.md.
 * Nonces would force every page to render dynamically, so inline scripts
 * stay allowed ('unsafe-inline' — Next's own hydration scripts and the
 * theme script in app/layout.tsx are inline); this policy therefore does
 * NOT stop an injected inline script. What it does enforce: scripts only
 * from this site (no third-party script origins), no plugins (object-src),
 * no <base> hijacking, forms post only here, no framing by other sites,
 * and fetch/XHR only to this site — so injected code can't send data to
 * another origin with fetch.
 *   - img/media: this site, data:/blob: (camera + upload previews, the
 *     Excel download), and Supabase signed URLs.
 *   - dev only: 'unsafe-eval' (React's dev tooling) and ws: (hot reload).
 */
const supabase = supabaseOrigin();
const contentSecurityPolicy = [
  "default-src 'self'",
  `script-src 'self' 'unsafe-inline'${isDev ? " 'unsafe-eval'" : ""}`,
  "style-src 'self' 'unsafe-inline'",
  `img-src 'self' data: blob:${supabase ? ` ${supabase}` : ""}`,
  `media-src 'self' blob:${supabase ? ` ${supabase}` : ""}`,
  "font-src 'self' data:",
  `connect-src 'self'${isDev ? " ws:" : ""}`,
  "worker-src 'self' blob:",
  "object-src 'none'",
  "base-uri 'self'",
  "form-action 'self'",
  "frame-src 'none'",
  "frame-ancestors 'self'",
  // Only on Vercel (always HTTPS); a local `next start` is plain http.
  ...(process.env.VERCEL === "1" ? ["upgrade-insecure-requests"] : []),
].join("; ");

const nextConfig: NextConfig = {
  // Hides the built-in dev-mode route indicator (bottom-left "Rendering…"
  // overlay) — framework chrome, not app UI; dev-only, no production
  // effect, and Next 16's devIndicators API has no icon-customization
  // option (only `position` or disabling it entirely).
  devIndicators: false,
  // Security headers on every response (see
  // node_modules/next/dist/docs/.../next-config-js/headers.md). Framing is
  // limited to this same site (the app never frames itself or anyone
  // else); the camera and microphone (CameraCapture, VoiceUpload) are
  // allowed for this site only, every other powerful feature for nobody.
  // HSTS: Vercel already sends it for its domains; sending it here too
  // covers a custom domain and is ignored by browsers over plain http.
  async headers() {
    return [
      {
        source: "/:path*",
        headers: [
          { key: "X-Content-Type-Options", value: "nosniff" },
          { key: "X-Frame-Options", value: "SAMEORIGIN" },
          { key: "Content-Security-Policy", value: contentSecurityPolicy },
          { key: "Referrer-Policy", value: "strict-origin-when-cross-origin" },
          {
            key: "Permissions-Policy",
            value: "camera=(self), microphone=(self), geolocation=(), payment=(), usb=(), serial=(), bluetooth=()",
          },
          { key: "Strict-Transport-Security", value: "max-age=63072000" },
        ],
      },
    ];
  },
};

export default nextConfig;
