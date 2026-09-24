import Card from "@/components/ui/Card";
import Badge from "@/components/ui/Badge";

/**
 * Read-only Profile view for the Contractor/Subcontractor dashboards —
 * the signed-in user's own name/email plus their role and Current
 * Project/department (all already resolved server-side). No admin
 * fields; Sign out stays in the sidebar.
 */
export default function ProfilePanel({
  displayName,
  email,
  roleLabel,
  projectName,
  departmentName,
}: {
  displayName: string;
  email: string;
  roleLabel: string;
  projectName: string;
  departmentName: string;
}) {
  const initials = displayName
    .split(" ")
    .filter(Boolean)
    .slice(0, 2)
    .map((p) => p[0]?.toUpperCase())
    .join("");
  return (
    <Card className="max-w-xl space-y-4 text-sm">
      <div className="flex items-center gap-3">
        <span className="flex h-12 w-12 items-center justify-center rounded-full bg-brand text-white text-base font-semibold">
          {initials}
        </span>
        <div className="min-w-0">
          <p className="text-lg font-semibold text-foreground truncate">{displayName}</p>
          <Badge variant="brand" dot={false}>
            {roleLabel}
          </Badge>
        </div>
      </div>
      <dl className="divide-y divide-line rounded-lg border border-line">
        {(
          [
            ["Email", email],
            ["Current Project", projectName],
            ["Department", departmentName],
          ] as const
        ).map(([label, value]) => (
          <div key={label} className="flex items-center justify-between gap-3 px-3 py-2">
            <dt className="text-foreground-secondary">{label}</dt>
            <dd className="font-medium text-foreground text-right break-all">{value}</dd>
          </div>
        ))}
      </dl>
      <p className="text-xs text-foreground-muted">
        To change your name, project or department, contact your Admin.
      </p>
    </Card>
  );
}
