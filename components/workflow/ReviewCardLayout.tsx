/**
 * Shared body layout for a review card — used by both the Subcontractor
 * queue (ForemanQueue) and the Contractor queue (SupervisorPanel) so the
 * two read the same way. The card starts with the work itself (Work ID,
 * Work, Description, then the caller's progress/amount/status rows as
 * `children`); the context — Project, Worker, Department — sits in a
 * compact box on the right (below the work details on small screens).
 * Purely presentational: every value is passed in unchanged, and each
 * caller keeps its own actions, edit state and review logic.
 */
export default function ReviewCardLayout({
  workItemCode,
  workItemDescription,
  description,
  projectName,
  workerName,
  departmentName,
  children,
}: {
  workItemCode: string;
  workItemDescription: string;
  /** The submission's own description — omitted when empty. */
  description?: string | null;
  projectName: string;
  workerName: string;
  departmentName: string;
  /** Progress / amount / status rows, rendered under the work details. */
  children?: React.ReactNode;
}) {
  return (
    <div className="grid gap-3 sm:grid-cols-[minmax(0,1fr)_14rem] sm:items-start">
      <div className="min-w-0 space-y-2">
        <p>
          <span className="text-foreground-secondary">Work ID:</span>{" "}
          <span className="font-semibold text-foreground">{workItemCode}</span>
        </p>
        <p>
          <span className="text-foreground-secondary">Work:</span> {workItemDescription}
        </p>
        {description && (
          <p>
            <span className="text-foreground-secondary">Description:</span> {description}
          </p>
        )}
        {children}
      </div>

      <dl className="rounded-lg border border-line-soft bg-surface-soft px-3 py-2 text-xs space-y-1.5">
        <div>
          <dt className="text-foreground-muted">Project</dt>
          <dd className="font-medium text-foreground break-words">{projectName}</dd>
        </div>
        <div>
          <dt className="text-foreground-muted">Worker</dt>
          <dd className="font-medium text-foreground break-words">{workerName}</dd>
        </div>
        <div>
          <dt className="text-foreground-muted">Department</dt>
          <dd className="font-medium text-foreground break-words">{departmentName}</dd>
        </div>
      </dl>
    </div>
  );
}
