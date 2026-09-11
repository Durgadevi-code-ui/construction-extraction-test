import { NextRequest, NextResponse } from "next/server";
import type { EmailOtpType } from "@supabase/supabase-js";
import { createSupabaseServerClient } from "@/lib/supabaseServer";

export const runtime = "nodejs";

/**
 * Lands here from a Supabase Auth email link (password reset today —
 * see requestPasswordReset in app/login/actions.ts; the same route
 * would also handle a future signup-confirmation link, since Supabase
 * builds both the same way: this app's redirectTo URL + Supabase's own
 * appended token_hash/type). Verifies the one-time token server-side
 * via verifyOtp, which establishes a real session (the same session
 * cookie mechanism as a password login) before handing off to `next`.
 *
 * This is Supabase's own documented pattern for Next.js + @supabase/ssr
 * — not a custom token scheme this app invented.
 */
export async function GET(request: NextRequest) {
  const { searchParams, origin } = new URL(request.url);
  const tokenHash = searchParams.get("token_hash");
  const type = searchParams.get("type") as EmailOtpType | null;
  const next = searchParams.get("next") ?? "/account";

  if (tokenHash && type) {
    const supabase = await createSupabaseServerClient();
    const { error } = await supabase.auth.verifyOtp({ type, token_hash: tokenHash });
    if (!error) {
      return NextResponse.redirect(`${origin}${next}`);
    }
  }

  return NextResponse.redirect(`${origin}/login?error=invalid_or_expired_link`);
}
