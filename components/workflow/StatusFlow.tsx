import type { WorkerSubmissionStatusCode } from "@/lib/format";
import Badge, { type BadgeVariant } from "@/components/ui/Badge";

type Props = {
  statusCode: WorkerSubmissionStatusCode;
};

/** Display labels only — codes (internal, used for lookups elsewhere) are unchanged. */
const STEPS: { code: WorkerSubmissionStatusCode; label: string }[] = [
  { code: "AWAITING_FOREMAN_REVIEW", label: "Subcontractor Review" },
  { code: "AWAITING_SUPERVISOR_APPROVAL", label: "Contractor Review" },
  { code: "APPROVED", label: "Approved" },
];

/** Index of the step currently active for a given status. Rollback
 * reverts the flow back to the Supervisor Review stage. */
const CURRENT_STEP_INDEX: Record<WorkerSubmissionStatusCode, number> = {
  AWAITING_FOREMAN_REVIEW: 0,
  AWAITING_SUPERVISOR_APPROVAL: 1,
  APPROVED: 2,
  ROLLED_BACK: 1,
};

type NodeState = "done" | "current" | "upcoming" | "rolled-back";

/**
 * Purely a frontend representation of the existing derived workflow
 * state (Worker Submitted -> Foreman Review -> Supervisor Review ->
 * Approved, with Rollback shown as a branch back to Supervisor
 * Review). No new statuses, no backend changes — statusCode is the
 * same WorkerSubmissionStatusCode already derived elsewhere.
 */
export default function StatusFlow({ statusCode }: Props) {
  const currentIndex = CURRENT_STEP_INDEX[statusCode];
  const rolledBack = statusCode === "ROLLED_BACK";

  function stateFor(stepIndex: number): NodeState {
    if (rolledBack && stepIndex === currentIndex) return "rolled-back";
    if (stepIndex < currentIndex) return "done";
    if (stepIndex === currentIndex) return "current";
    return "upcoming";
  }

  return (
    <div className="flex items-center gap-1 text-xs flex-wrap">
      <FlowNode label="Submitted" state="done" />
      <FlowConnector active />
      {STEPS.map((step, i) => (
        <span key={step.code} className="flex items-center gap-1">
          <FlowNode label={step.label} state={stateFor(i)} />
          {i < STEPS.length - 1 && <FlowConnector active={i < currentIndex} />}
        </span>
      ))}
    </div>
  );
}

function FlowConnector({ active }: { active: boolean }) {
  return <span className={`h-px w-4 ${active ? "bg-brand/60" : "bg-line"}`} />;
}

function FlowNode({ label, state }: { label: string; state: NodeState }) {
  const variants: Record<NodeState, BadgeVariant> = {
    done: "success",
    current: "brand",
    upcoming: "neutral",
    "rolled-back": "error",
  };
  return <Badge variant={variants[state]}>{state === "rolled-back" ? "Rolled Back" : label}</Badge>;
}
