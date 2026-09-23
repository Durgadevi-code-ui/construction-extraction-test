"use client";

import { useActionState } from "react";
import { updatePassword, type AuthFormState } from "@/app/login/actions";

export default function UpdatePasswordForm() {
  const [state, formAction, pending] = useActionState<AuthFormState, FormData>(
    updatePassword,
    undefined
  );

  return (
    <form action={formAction} className="bg-white rounded-lg border border-line p-6 space-y-4">
      <div>
        <label className="block text-sm font-medium text-foreground-secondary mb-1" htmlFor="password">
          New Password
        </label>
        <input
          id="password"
          name="password"
          type="password"
          required
          minLength={8}
          autoComplete="new-password"
          className="w-full rounded border border-line px-3 py-2 text-sm"
        />
      </div>
      <div>
        <label className="block text-sm font-medium text-foreground-secondary mb-1" htmlFor="confirmPassword">
          Confirm New Password
        </label>
        <input
          id="confirmPassword"
          name="confirmPassword"
          type="password"
          required
          minLength={8}
          autoComplete="new-password"
          className="w-full rounded border border-line px-3 py-2 text-sm"
        />
      </div>

      {state?.error && <p className="text-sm text-error">{state.error}</p>}

      <button
        type="submit"
        disabled={pending}
        className="w-full rounded bg-brand text-white text-sm font-medium px-4 py-2 disabled:opacity-50"
      >
        {pending ? "Saving…" : "Set New Password"}
      </button>
    </form>
  );
}
