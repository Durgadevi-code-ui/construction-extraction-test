"use client";

import { useActionState } from "react";
import Link from "next/link";
import { login, type AuthFormState } from "@/app/login/actions";
import Button from "@/components/ui/Button";
import Input, { Label } from "@/components/ui/Input";

/**
 * Deliberately no <Card> wrapper here (unlike most forms in this app) —
 * this renders directly inside the login page's own right-hand panel,
 * which is already its own flat surface; nesting another bordered/
 * shadowed card on top of it would recreate the "card floating over a
 * background" look the login redesign specifically avoids. Fields,
 * validation, and the `login` server action are unchanged.
 */
export default function LoginForm({ next }: { next?: string }) {
  const [state, formAction, pending] = useActionState<AuthFormState, FormData>(login, undefined);

  return (
    <form action={formAction} className="space-y-4">
      {next && <input type="hidden" name="next" value={next} />}
      <div>
        <Label htmlFor="email">Email</Label>
        <Input id="email" name="email" type="email" required autoComplete="username" />
      </div>
      <div>
        <Label htmlFor="password">Password</Label>
        <Input id="password" name="password" type="password" required autoComplete="current-password" />
      </div>

      {state?.error && (
        <p className="rounded-lg border border-error-border bg-error-soft px-3 py-2 text-sm text-error">
          {state.error}
        </p>
      )}

      <Button type="submit" disabled={pending} className="w-full">
        {pending ? "Signing in…" : "Sign In"}
      </Button>

      <p className="text-center text-xs text-foreground-secondary">
        <Link href="/reset-password" className="text-brand hover:underline">
          Forgot your password?
        </Link>
      </p>
    </form>
  );
}
