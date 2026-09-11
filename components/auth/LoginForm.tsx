"use client";

import { useActionState } from "react";
import Link from "next/link";
import { login, type AuthFormState } from "@/app/login/actions";

export default function LoginForm({ next }: { next?: string }) {
  const [state, formAction, pending] = useActionState<AuthFormState, FormData>(login, undefined);

  return (
    <form action={formAction} className="bg-white rounded-lg border border-line p-6 space-y-4">
      {next && <input type="hidden" name="next" value={next} />}
      <div>
        <label className="block text-sm font-medium text-foreground-secondary mb-1" htmlFor="email">
          Email
        </label>
        <input
          id="email"
          name="email"
          type="email"
          required
          autoComplete="username"
          className="w-full rounded border border-line px-3 py-2 text-sm"
        />
      </div>
      <div>
        <label className="block text-sm font-medium text-foreground-secondary mb-1" htmlFor="password">
          Password
        </label>
        <input
          id="password"
          name="password"
          type="password"
          required
          autoComplete="current-password"
          className="w-full rounded border border-line px-3 py-2 text-sm"
        />
      </div>

      {state?.error && <p className="text-sm text-red-600">{state.error}</p>}

      <button
        type="submit"
        disabled={pending}
        className="w-full rounded bg-brand text-white text-sm font-medium px-4 py-2 disabled:opacity-50"
      >
        {pending ? "Signing in…" : "Sign In"}
      </button>

      <p className="text-center text-xs text-foreground-secondary">
        <Link href="/reset-password" className="text-brand hover:underline">
          Forgot your password?
        </Link>
      </p>
    </form>
  );
}
