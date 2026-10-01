"use client";

import { ListChecks, CheckCircle2, Clock, TrendingUp, Percent, DollarSign, ChevronRight } from "lucide-react";
import { useCountUp } from "@/components/workflow/useCountUp";
import { formatMoney, formatPercent } from "@/lib/format";
import { progressColorClass } from "@/lib/progressColor";

// One semantic color per metric so the six KPIs are distinguishable at a
// glance (previously brand teal and success green read as the same
// color). Theme tokens where one fits (success/brand), Tailwind's
// default palette for the hues the theme has no token for — icon chips
// only, card body stays white, same as before.
type KpiTone = "assigned" | "completed" | "pending" | "progress" | "remaining" | "revenue";

/** Where a KPI card leads when clicked — the caller passes a handler only
 * for cards that have a real destination on its page (e.g. Pending
 * Review -> Reviews); a card without one stays plain, never a dead link. */
export type KpiCardActions = Partial<Record<KpiTone, { onClick: () => void; label: string }>>;

const KPI_ICON_CHIP: Record<KpiTone, string> = {
  assigned: "bg-blue-600 text-white",
  completed: "bg-success text-white",
  pending: "bg-orange-500 text-white",
  progress: "bg-brand text-white",
  remaining: "bg-amber-400 text-amber-950",
  revenue: "bg-indigo-600 text-white",
};

function KpiCard({
  label,
  value,
  icon: Icon,
  highlight,
  tone,
  hint,
  chipClassName,
  action,
}: {
  label: string;
  value: React.ReactNode;
  icon: React.ComponentType<{ className?: string; strokeWidth?: number }>;
  highlight?: boolean;
  tone: KpiTone;
  hint?: string;
  /** Overrides the tone's icon-chip color (see ProgressKpiCard). */
  chipClassName?: string;
  /** Makes the whole card a button to its destination (see KpiCardActions). */
  action?: { onClick: () => void; label: string };
}) {
  const body = (
    <>
      <span className="flex items-start justify-between gap-2">
        <span className={`flex h-8 w-8 items-center justify-center rounded-lg ${chipClassName ?? KPI_ICON_CHIP[tone]}`}>
          <Icon className="h-4 w-4" strokeWidth={2} />
        </span>
        {action && (
          <ChevronRight
            className="h-4 w-4 text-foreground-muted transition-colors duration-150 group-hover:text-brand"
            strokeWidth={2}
            aria-hidden
          />
        )}
      </span>
      <span className="block">
        <span className={`block text-lg font-bold tabular-nums leading-tight ${highlight ? "text-warning" : "text-foreground"}`}>
          {value}
        </span>
        <span className="block text-xs text-foreground-secondary">{label}</span>
      </span>
    </>
  );
  const className = `flex flex-col gap-2 rounded-lg border p-3 text-left ${
    highlight ? "bg-warning-soft border-warning-border" : "bg-white border-line"
  }`;
  if (!action) {
    return (
      <div className={className} title={hint}>
        {body}
      </div>
    );
  }
  return (
    <button
      type="button"
      onClick={action.onClick}
      title={hint ? `${hint} — ${action.label}` : action.label}
      aria-label={`${label}: ${action.label}`}
      className={`group ${className} transition-colors duration-150 hover:border-brand hover:shadow-sm focus:outline-none focus-visible:ring-2 focus-visible:ring-brand/40`}
    >
      {body}
    </button>
  );
}

/** A percentage that counts up 0 → value on load (display only). */
function CountUpPercent({ value }: { value: number }) {
  return <>{formatPercent(useCountUp(value))}</>;
}

/** Overall Progress KPI — one count-up drives both the number and the
 * icon chip, which takes the shared progress-band color
 * (lib/progressColor.ts) of the CURRENT animated value. */
function ProgressKpiCard({ value, action }: { value: number; action?: { onClick: () => void; label: string } }) {
  const shown = useCountUp(value);
  return (
    <KpiCard
      action={action}
      icon={TrendingUp}
      label="Overall Progress"
      value={formatPercent(shown)}
      tone="progress"
      chipClassName={`${progressColorClass(shown, "bg")} text-white`}
    />
  );
}

/**
 * The dashboard KPI row shared by the Subcontractor Dashboard
 * (ForemanTabs) and the Contractor Dashboard (DashboardPanel's "kpis"
 * section): Assigned Work · Completed · Pending Review · Overall Progress
 * · Estimated Revenue · Work Left. Every value is passed in, already
 * computed by the caller from its existing data — nothing is calculated
 * here. `estimatedRevenue` null (no financial data for this viewer)
 * leaves that tile out rather than showing a fake $0. `actions` makes
 * individual cards clickable (see KpiCardActions).
 */
export function DashboardKpiCards({
  totalWorkItems,
  completedCount,
  pendingReviews,
  overallProgressPercent,
  estimatedRevenue,
  revenueHint,
  workLeftPercent,
  actions = {},
}: {
  actions?: KpiCardActions;
  totalWorkItems: number;
  completedCount: number;
  pendingReviews: number;
  overallProgressPercent: number;
  estimatedRevenue: number | null;
  revenueHint: string;
  workLeftPercent: number;
}) {
  return (
    <section className="grid grid-cols-2 sm:grid-cols-3 gap-3">
      <KpiCard icon={ListChecks} label="Assigned Work" value={`${totalWorkItems}`} tone="assigned" action={actions.assigned} />
      <KpiCard icon={CheckCircle2} label="Completed" value={`${completedCount}`} tone="completed" action={actions.completed} />
      <KpiCard
        action={actions.pending}
        icon={Clock}
        label="Pending Review"
        value={`${pendingReviews}`}
        tone="pending"
        highlight={pendingReviews > 0}
      />
      {/* Progress and the value it has earned sit side by side. */}
      <ProgressKpiCard value={overallProgressPercent} action={actions.progress} />
      {estimatedRevenue !== null && (
        <KpiCard
          action={actions.revenue}
          icon={DollarSign}
          tone="revenue"
          label="Estimated Revenue"
          value={formatMoney(estimatedRevenue)}
          hint={revenueHint}
        />
      )}
      <KpiCard
        icon={Percent}
        label="Work Left"
        value={<CountUpPercent value={workLeftPercent} />}
        tone="remaining"
        action={actions.remaining}
      />
    </section>
  );
}

/** The KPI values both dashboards already pass to DashboardKpiCards. */
export type DashboardKpiValues = {
  totalWorkItems: number;
  completedCount: number;
  pendingReviews: number;
  overallProgressPercent: number;
  /** null = no financial data for this viewer (sentence left out). */
  estimatedRevenue: number | null;
  workLeftPercent: number;
};

function count(n: number, singular: string, plural = `${singular}s`): string {
  return `${n} ${n === 1 ? singular : plural}`;
}

/**
 * Plain-language description of the dashboard KPI row, for the Summary
 * tab of the Subcontractor and Contractor Dashboards — the same values
 * the KPI cards show (passed in by the caller, never recalculated here),
 * written as sentences so they read without interpreting the numbers.
 * Rule-based text from application data only; nothing is generated.
 */
export function KpiSummaryText({
  scopeLabel,
  totalWorkItems,
  completedCount,
  pendingReviews,
  overallProgressPercent,
  estimatedRevenue,
  workLeftPercent,
}: DashboardKpiValues & {
  /** What the numbers cover, e.g. "Electrical Department". */
  scopeLabel: string;
}) {
  const open = totalWorkItems - completedCount;
  const reviewSentence =
    pendingReviews === 0
      ? "No submissions are currently awaiting your review."
      : `${count(pendingReviews, "submission is", "submissions are")} currently awaiting your review.`;

  if (totalWorkItems === 0) {
    return (
      <div className="space-y-1 text-foreground">
        <p className="font-medium">{scopeLabel} has no assigned work items yet.</p>
        <p>{reviewSentence}</p>
      </div>
    );
  }

  const status =
    completedCount === totalWorkItems
      ? `All ${count(totalWorkItems, "work item")} ${totalWorkItems === 1 ? "is" : "are"} completed.`
      : completedCount === 0
        ? `None of them ${totalWorkItems === 1 ? "is" : "are"} completed yet, so all ${totalWorkItems} ${totalWorkItems === 1 ? "is" : "are"} still open.`
        : `${count(completedCount, "work item is", "work items are")} completed, while ${open} ${open === 1 ? "is" : "are"} still open.`;

  return (
    <div className="space-y-1 text-foreground">
      <p className="font-medium">
        {scopeLabel} currently has {count(totalWorkItems, "assigned work item")}. {status}
      </p>
      <p>
        Overall progress is {formatPercent(overallProgressPercent)}, with {formatPercent(workLeftPercent)} of the work
        remaining.
        {estimatedRevenue !== null &&
          ` Based on the approved progress so far, the estimated revenue is ${formatMoney(estimatedRevenue)}.`}
      </p>
      <p>{reviewSentence}</p>
    </div>
  );
}
