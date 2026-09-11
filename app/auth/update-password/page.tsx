import UpdatePasswordForm from "@/components/auth/UpdatePasswordForm";

export const dynamic = "force-dynamic";

/** Reached only via app/auth/confirm/route.ts after a valid password-
 * reset link click, which establishes the session this form's
 * updatePassword Server Action acts on. */
export default function UpdatePasswordPage() {
  return (
    <main className="min-h-screen py-16 px-4">
      <div className="max-w-sm mx-auto space-y-6">
        <h1 className="text-2xl font-bold text-foreground">Set a New Password</h1>
        <UpdatePasswordForm />
      </div>
    </main>
  );
}
