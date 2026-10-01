import { formatMoney, formatPercent } from "@/lib/format";
import { progressColorClass, progressSoftClass } from "@/lib/progressColor";

/**
 * Compact "72.5% · $12,500" chip — a progress percentage with the
 * amount/value it represents, tinted by the shared progress bands (see
 * lib/progressColor.ts: 0–25% red, >25–50% orange, >50–75% yellow,
 * >75% green) using the
 * light theme tints only. The number itself stays dark text for
 * contrast; the colored dot and soft background carry the status. Both
 * values are passed in already computed — nothing is calculated here.
 * `amount` omitted/null renders the percentage alone (never a fake $0).
 */
export default function ProgressValue({
  percent,
  amount,
  title,
}: {
  percent: number | null;
  amount?: number | null;
  title?: string;
}) {
  return (
    <span
      title={title}
      className={`inline-flex items-center gap-1.5 rounded-full border px-2 py-0.5 text-xs whitespace-nowrap tabular-nums ${progressSoftClass(percent)}`}
    >
      <span className={`h-1.5 w-1.5 shrink-0 rounded-full ${progressColorClass(percent, "bg")}`} aria-hidden />
      <span className="font-semibold text-foreground">{formatPercent(percent)}</span>
      {amount !== null && amount !== undefined && (
        <span className="text-foreground-secondary">· {formatMoney(amount)}</span>
      )}
    </span>
  );
}
