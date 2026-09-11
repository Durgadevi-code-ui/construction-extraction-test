import type { WorkerSubmissionStatusCode } from "@/lib/format";

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
  const styles: Record<NodeState, string> = {
    done: "bg-green-50 text-green-700 border-green-200",
    current: "bg-brand-soft text-brand border-orange-200 font-semibold",
    upcoming: "bg-gray-50 text-gray-400 border-line",
    "rolled-back": "bg-red-50 text-red-700 border-red-200 font-semibold",
  };
  return (
    <span className={`px-2 py-1 rounded-full border whitespace-nowrap ${styles[state]}`}>
      {state === "rolled-back" ? "Rolled Back" : label}
    </span>
  );
}
