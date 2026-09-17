/**
 * Reusable horizontal grouped bar chart (hand-built SVG, no charting
 * library) — one row per group (e.g. a department), one bar per series
 * within the row (e.g. "Estimated" vs "Approved", or "This Month" vs
 * "Last Month"). Values within one chart must share a unit (this
 * component doesn't know or care what the unit is) — the Dashboard only
 * ever feeds it dollar values for exactly that reason: physical
 * quantities (m, m², LF, ...) differ per work item and can't be pooled
 * into one bar the way currency can (see lib/dashboard.ts module doc).
 * Hover tooltips use the native title attribute (via a wrapping <a>-less
 * <g title>-equivalent, an invisible full-width <rect> per bar row) per
 * this feature's no-new-dependency constraint.
 */

export type BarSeriesSpec = { key: string; label: string; colorClass: string; fill: string };
export type BarGroup = { label: string; values: Record<string, number | null> };

const ROW_HEIGHT = 18;
const ROW_GAP = 6;
const LABEL_WIDTH = 132;
const VALUE_WIDTH = 84;
const CHART_WIDTH = 320;

export default function GroupedBarChart({
  groups,
  series,
  valueFormatter = (v) => v.toLocaleString(),
}: {
  groups: BarGroup[];
  series: BarSeriesSpec[];
  valueFormatter?: (value: number) => string;
}) {
  if (groups.length === 0) {
    return <p className="text-sm text-foreground-muted">No data to chart yet.</p>;
  }

  const maxValue = Math.max(1, ...groups.flatMap((g) => series.map((s) => g.values[s.key] ?? 0)));
  const barAreaWidth = CHART_WIDTH;
  const rowsPerGroup = series.length;
  const groupHeight = rowsPerGroup * ROW_HEIGHT + (rowsPerGroup - 1) * 2 + ROW_GAP;
  const totalHeight = groups.length * groupHeight;
  const totalWidth = LABEL_WIDTH + barAreaWidth + VALUE_WIDTH;

  return (
    <div className="space-y-3">
      <div className="flex flex-wrap gap-3">
        {series.map((s) => (
          <span key={s.key} className="flex items-center gap-1.5 text-xs text-foreground-secondary">
            <span className={`inline-block h-2.5 w-2.5 rounded-sm ${s.colorClass}`} />
            {s.label}
          </span>
        ))}
      </div>

      <svg
        viewBox={`0 0 ${totalWidth} ${totalHeight}`}
        width="100%"
        role="img"
        aria-label="Grouped comparison chart"
        style={{ maxWidth: totalWidth }}
      >
        {groups.map((group, groupIndex) => {
          const groupY = groupIndex * groupHeight;
          return (
            <g key={group.label}>
              {series.map((s, seriesIndex) => {
                const rowY = groupY + seriesIndex * (ROW_HEIGHT + 2);
                const value = group.values[s.key];
                const barWidth =
                  value === null || value === undefined ? 0 : (value / maxValue) * barAreaWidth;
                return (
                  <g key={s.key}>
                    {seriesIndex === 0 && (
                      <text
                        x={0}
                        y={rowY + (ROW_HEIGHT * rowsPerGroup) / 2 + 4}
                        className="fill-[#111827] text-[10px] font-medium"
                      >
                        <title>{group.label}</title>
                        {truncate(group.label, 20)}
                      </text>
                    )}
                    <rect
                      x={LABEL_WIDTH}
                      y={rowY}
                      width={barAreaWidth}
                      height={ROW_HEIGHT}
                      className="fill-[#f0f1f3]"
                      rx={3}
                    />
                    <rect
                      x={LABEL_WIDTH}
                      y={rowY}
                      width={barWidth}
                      height={ROW_HEIGHT}
                      fill={s.fill}
                      rx={3}
                      style={{ transition: "width 500ms ease-out" }}
                    >
                      <title>
                        {group.label} · {s.label}:{" "}
                        {value !== null && value !== undefined ? valueFormatter(value) : "Not available"}
                      </title>
                    </rect>
                    <text
                      x={LABEL_WIDTH + barAreaWidth + 8}
                      y={rowY + ROW_HEIGHT / 2 + 4}
                      className="fill-[#4b5563] text-[10px] tabular-nums"
                    >
                      {value !== null && value !== undefined ? valueFormatter(value) : "—"}
                    </text>
                  </g>
                );
              })}
            </g>
          );
        })}
      </svg>
    </div>
  );
}

function truncate(label: string, max: number): string {
  return label.length > max ? `${label.slice(0, max - 1)}…` : label;
}
