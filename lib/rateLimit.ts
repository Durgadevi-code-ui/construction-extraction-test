import "server-only";
import { createHash } from "crypto";
import { NextResponse } from "next/server";
import { getSupabaseServiceRoleClient } from "./supabaseAdmin";

/**
 * Shared, fixed-window rate limiting for the routes that are expensive
 * (paid OCR / speech-to-text, uploads, workbook parsing) or that an
 * anonymous caller can hammer (login, Admin bootstrap).
 *
 * The counter lives in Postgres (public.rate_limit_hit, see
 * supabase/migrations/00000000000023_rate_limits.sql), reached with the
 * service-role client — so every serverless instance shares it, unlike an
 * in-memory counter, and no new service or credential is needed.
 *
 * Configuration (RATE_LIMIT_BACKEND):
 *   - unset: "supabase" in a Vercel production deployment
 *     (VERCEL_ENV=production — migration 00000000000023 is applied there),
 *     otherwise off (local development, Preview, tests).
 *   - "off": disabled — every request is allowed and a warning is logged
 *     once. The explicit kill switch for any environment.
 *   - "supabase": enforced. If the counter itself can't be reached, a
 *     rule with `failClosed` (the expensive operations) answers 503
 *     instead of running unprotected; the others (login) are allowed,
 *     since Supabase Auth applies its own limits there and a database
 *     hiccup must not lock every user out.
 *
 * Identifiers (IP addresses, emails) are hashed before they are stored.
 */

export type RateLimitRule = {
  /** Stable key prefix, e.g. "extraction". */
  name: string;
  /** Requests allowed per window. */
  limit: number;
  windowSeconds: number;
  /** When the shared counter is unavailable: deny (true) or allow (false). */
  failClosed: boolean;
};

export type RateLimitResult =
  | { allowed: true }
  | { allowed: false; reason: "limited" | "unavailable"; retryAfterSeconds: number };

/** One counted hit: how many hits this window has seen (including this
 * one), and when the window resets. */
export type RateLimitStore = {
  hit(key: string, windowSeconds: number): Promise<{ count: number; resetAt: Date }>;
};

export const RATE_LIMITS = {
  /** Paid OCR / speech-to-text + storage writes, per signed-in user. A
   * Worker sends a handful of updates a day; the ambiguity / task
   * confirmation steps resend at most a couple more each. */
  extraction: { name: "extraction", limit: 30, windowSeconds: 10 * 60, failClosed: true },
  /** Live-update photo / voice evidence uploads, per signed-in user. */
  liveUpdateUpload: { name: "live-update-upload", limit: 60, windowSeconds: 10 * 60, failClosed: true },
  /** Workbook parsing (import preview + commit), per signed-in user. */
  workbookImport: { name: "workbook-import", limit: 40, windowSeconds: 60 * 60, failClosed: true },
  /** Workbook export (re-parses the stored upload), per signed-in user. */
  workbookExport: { name: "workbook-export", limit: 30, windowSeconds: 10 * 60, failClosed: true },
  /** Unauthenticated, one-time Admin bootstrap, per client IP. */
  bootstrap: { name: "bootstrap", limit: 5, windowSeconds: 60 * 60, failClosed: true },
  /** Password login attempts, per client IP and per email address. */
  loginPerIp: { name: "login-ip", limit: 30, windowSeconds: 10 * 60, failClosed: false },
  loginPerEmail: { name: "login-email", limit: 10, windowSeconds: 10 * 60, failClosed: false },
  /** Password-reset emails, per client IP and per email address. */
  passwordResetPerIp: { name: "reset-ip", limit: 20, windowSeconds: 60 * 60, failClosed: false },
  passwordResetPerEmail: { name: "reset-email", limit: 5, windowSeconds: 60 * 60, failClosed: false },
} as const satisfies Record<string, RateLimitRule>;

/** Retry-After for a 503 when the counter is unavailable. */
const UNAVAILABLE_RETRY_SECONDS = 30;

const supabaseStore: RateLimitStore = {
  async hit(key, windowSeconds) {
    const { data, error } = await getSupabaseServiceRoleClient().rpc("rate_limit_hit", {
      p_key: key,
      p_window_seconds: windowSeconds,
    });
    if (error) throw new Error(`rate_limit_hit failed: ${error.message}`);
    const row = Array.isArray(data) ? data[0] : data;
    if (!row || typeof row.hit_count !== "number" || !row.reset_at) {
      throw new Error("rate_limit_hit returned no row.");
    }
    return { count: row.hit_count, resetAt: new Date(row.reset_at) };
  },
};

let storeOverride: RateLimitStore | null | undefined;
let warnedDisabled = false;

/** Tests only: force a store (or null = disabled); undefined restores
 * the environment-driven choice. */
export function setRateLimitStoreForTests(store: RateLimitStore | null | undefined): void {
  storeOverride = store;
  warnedDisabled = false;
}

/** The configured backend name (see the configuration notes above). */
export function rateLimitBackend(env: Record<string, string | undefined> = process.env): string {
  const explicit = (env.RATE_LIMIT_BACKEND ?? "").trim().toLowerCase();
  if (explicit) return explicit;
  return env.VERCEL_ENV === "production" ? "supabase" : "off";
}

function activeStore(): RateLimitStore | null {
  if (storeOverride !== undefined) return storeOverride;
  const backend = rateLimitBackend();
  if (backend === "supabase") return supabaseStore;
  if (backend && backend !== "off") {
    console.error(`Unknown RATE_LIMIT_BACKEND "${backend}" — rate limiting is disabled.`);
  }
  return null;
}

function hashIdentifier(identifier: string): string {
  return createHash("sha256").update(identifier).digest("hex").slice(0, 32);
}

/** Counts one request for `identifier` under `rule`. */
export async function checkRateLimit(
  rule: RateLimitRule,
  identifier: string,
  now: () => Date = () => new Date()
): Promise<RateLimitResult> {
  const store = activeStore();
  if (!store) {
    if (!warnedDisabled) {
      warnedDisabled = true;
      console.warn("Rate limiting is disabled (RATE_LIMIT_BACKEND=supabase enables it; it is on by default only in Vercel production).");
    }
    return { allowed: true };
  }

  try {
    const { count, resetAt } = await store.hit(`${rule.name}:${hashIdentifier(identifier)}`, rule.windowSeconds);
    if (count <= rule.limit) return { allowed: true };
    const retryAfterSeconds = Math.max(1, Math.ceil((resetAt.getTime() - now().getTime()) / 1000));
    return { allowed: false, reason: "limited", retryAfterSeconds };
  } catch (err) {
    console.error(`Rate limit check "${rule.name}" failed:`, err);
    return rule.failClosed
      ? { allowed: false, reason: "unavailable", retryAfterSeconds: UNAVAILABLE_RETRY_SECONDS }
      : { allowed: true };
  }
}

/** The user-facing message for a refused request. */
export function rateLimitMessage(result: Extract<RateLimitResult, { allowed: false }>): string {
  if (result.reason === "unavailable") {
    return "The service is busy right now. Please try again shortly.";
  }
  const minutes = Math.ceil(result.retryAfterSeconds / 60);
  return result.retryAfterSeconds < 60
    ? `Too many requests. Please wait ${result.retryAfterSeconds} seconds and try again.`
    : `Too many requests. Please wait ${minutes} minute${minutes === 1 ? "" : "s"} and try again.`;
}

/** null when allowed; otherwise the `{ error }` JSON response the routes
 * already use for failures — 429 (limit reached) or 503 (counter
 * unavailable for a fail-closed rule), with Retry-After. */
export async function rateLimitResponse(rule: RateLimitRule, identifier: string): Promise<NextResponse | null> {
  const result = await checkRateLimit(rule, identifier);
  if (result.allowed) return null;
  return NextResponse.json(
    { error: rateLimitMessage(result) },
    {
      status: result.reason === "limited" ? 429 : 503,
      headers: { "Retry-After": String(result.retryAfterSeconds) },
    }
  );
}

/**
 * The caller's IP, for per-IP limits. Only read from headers the hosting
 * platform itself sets: on Vercel (VERCEL=1) the edge network overwrites
 * x-forwarded-for / x-real-ip with the real client address, so a
 * client-supplied value never reaches the app. Anywhere else those
 * headers are client-controlled unless a trusted proxy rewrites them, so
 * they are ignored unless RATE_LIMIT_TRUST_PROXY_HEADERS=true is set for
 * such a deployment — every request then shares one "unknown" bucket,
 * which only matters when rate limiting is enabled there.
 */
export function clientIp(headers: Headers): string {
  const trusted = process.env.VERCEL === "1" || process.env.RATE_LIMIT_TRUST_PROXY_HEADERS === "true";
  if (!trusted) return "unknown";
  const forwarded = headers.get("x-vercel-forwarded-for") ?? headers.get("x-forwarded-for") ?? "";
  const first = forwarded.split(",")[0]?.trim();
  return first || headers.get("x-real-ip")?.trim() || "unknown";
}
