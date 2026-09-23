"use client";

import { useRouter } from "next/navigation";
import { useState } from "react";

type Props = {
  departments: { departmentId: string; departmentName: string; projectName: string }[];
};

/**
 * Creates the first ADMIN-role user so Admin Setup can be reached at
 * all — get-or-create by email, exactly the same pattern
 * lib/construction.ts already uses for the extraction-test worker, not
 * a new auth mechanism. Requires an existing department because every
 * user in this schema (Worker/Foreman/Supervisor/Admin alike) hangs off
 * one; if none exist yet, use Admin Setup's own Departments tab is
 * unreachable too — seed at least one Company/Project/Department first.
 */
export default function BootstrapAdminForm({ departments }: Props) {
  const router = useRouter();
  const [email, setEmail] = useState("");
  const [departmentId, setDepartmentId] = useState(departments[0]?.departmentId ?? "");
  const [submitting, setSubmitting] = useState(false);
  const [error, setError] = useState<string | null>(null);

  async function handleSubmit(e: React.FormEvent) {
    e.preventDefault();
    setError(null);
    setSubmitting(true);
    try {
      const res = await fetch("/api/admin/bootstrap", {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ email, departmentId }),
      });
      const data = await res.json();
      if (!res.ok) throw new Error(data.error ?? "Failed to create admin user.");
      router.push(`/admin/setup?userId=${data.userId}`);
    } catch (err) {
      setError(err instanceof Error ? err.message : "Failed to create admin user.");
    } finally {
      setSubmitting(false);
    }
  }

  if (departments.length === 0) {
    return (
      <section className="bg-white rounded-lg border border-line p-4 text-sm text-foreground-secondary">
        No departments exist yet, so an admin user cannot be created (every user belongs to a
        department in this schema). Seed at least one Company/Project/Department directly first.
      </section>
    );
  }

  return (
    <form
      onSubmit={handleSubmit}
      className="bg-white rounded-lg border border-line p-4 space-y-3"
    >
      <h2 className="font-semibold text-foreground text-sm">Create Admin User</h2>
      <div>
        <label className="block text-sm font-medium text-foreground-secondary mb-1">Email</label>
        <input
          type="email"
          required
          value={email}
          onChange={(e) => setEmail(e.target.value)}
          className="w-full rounded border border-line px-3 py-2 text-sm"
          placeholder="admin@abcconstruction.com"
        />
      </div>
      <div>
        <label className="block text-sm font-medium text-foreground-secondary mb-1">Department</label>
        <select
          value={departmentId}
          onChange={(e) => setDepartmentId(e.target.value)}
          className="w-full rounded border border-line px-3 py-2 text-sm"
        >
          {departments.map((d) => (
            <option key={d.departmentId} value={d.departmentId}>
              {d.projectName} / {d.departmentName}
            </option>
          ))}
        </select>
      </div>
      <button
        type="submit"
        disabled={submitting}
        className="rounded bg-brand text-white text-sm font-medium px-4 py-2 disabled:opacity-50"
      >
        {submitting ? "Creating…" : "Create Admin User"}
      </button>
      {error && <p className="text-sm text-error">{error}</p>}
    </form>
  );
}
