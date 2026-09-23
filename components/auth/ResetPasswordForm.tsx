"use client";

import { useActionState } from "react";
import { requestPasswordReset, type AuthFormState } from "@/app/login/actions";

export default function ResetPasswordForm() {
  const [state, formAction, pending] = useActionState<AuthFormState, FormData>(
    requestPasswordReset,
    undefined
  );

  return (
    <form action={formAction} className="bg-white rounded-lg border border-line p-6 space-y-4">
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

      {state?.error && <p className="text-sm text-error">{state.error}</p>}
      {state?.message && <p className="text-sm text-success">{state.message}</p>}

      <button
        type="submit"
        disabled={pending}
        className="w-full rounded bg-brand text-white text-sm font-medium px-4 py-2 disabled:opacity-50"
      >
        {pending ? "Sending…" : "Send Reset Link"}
      </button>
    </form>
  );
}
