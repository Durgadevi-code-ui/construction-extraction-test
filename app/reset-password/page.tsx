import ResetPasswordForm from "@/components/auth/ResetPasswordForm";

export const dynamic = "force-dynamic";

export default function ResetPasswordPage() {
  return (
    <main className="min-h-screen py-16 px-4">
      <div className="max-w-sm mx-auto space-y-6">
        <div>
          <h1 className="text-2xl font-bold text-foreground">Reset Password</h1>
          <p className="text-sm text-foreground-secondary mt-1">
            We&apos;ll email you a link to set a new password.
          </p>
        </div>
        <ResetPasswordForm />
      </div>
    </main>
  );
}
