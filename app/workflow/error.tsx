"use client";

import { useEffect } from "react";
import Link from "next/link";
import { AlertTriangle, RotateCw } from "lucide-react";
import Button from "@/components/ui/Button";

/**
 * Error boundary for every /workflow page (Worker, Subcontractor,
 * Contractor, History). A server-side load failure (e.g. the database
 * being unreachable) lands here instead of the framework's default
 * error page. In production Next.js replaces a Server Component's error
 * message with a generic one plus a digest, so no internal detail is
 * shown; the digest is what matches the server log.
 */
export default function WorkflowError({
  error,
  retry,
}: {
  error: Error & { digest?: string };
  retry: () => void;
}) {
  useEffect(() => {
    console.error("Workflow page failed to load:", error);
  }, [error]);

  return (
    <main className="flex-1 flex items-center justify-center bg-background min-h-screen p-6">
      <div className="max-w-md w-full rounded-lg border border-line bg-surface p-6 text-center space-y-3 shadow-sm">
        <AlertTriangle className="mx-auto h-8 w-8 text-error" strokeWidth={1.75} aria-hidden />
        <h1 className="text-lg font-semibold text-foreground">This page couldn&apos;t be loaded</h1>
        <p className="text-sm text-foreground-secondary">
          Something went wrong while loading your data. Please try again. If it keeps happening, contact your
          Admin.
        </p>
        {error.digest && <p className="text-[11px] text-foreground-muted">Reference: {error.digest}</p>}
        <div className="flex items-center justify-center gap-2 pt-1">
          <Button onClick={() => retry()}>
            <RotateCw className="h-4 w-4" strokeWidth={2} aria-hidden />
            Try again
          </Button>
          <Link
            href="/workflow"
            className="rounded-lg border border-brand px-4 py-2 text-sm font-medium text-brand transition-colors duration-150 hover:bg-brand-soft"
          >
            Go to my dashboard
          </Link>
        </div>
      </div>
    </main>
  );
}
