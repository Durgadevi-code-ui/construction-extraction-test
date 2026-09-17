/**
 * Shared card surface — the one enterprise-record visual language used
 * everywhere (white surface, subtle border, soft shadow, rounded-xl,
 * consistent padding) so screens stop re-declaring the same classes
 * slightly differently.
 */
export default function Card({
  className = "",
  children,
}: {
  className?: string;
  children: React.ReactNode;
}) {
  return (
    <div className={`rounded-xl border border-line bg-surface p-5 shadow-sm ${className}`}>
      {children}
    </div>
  );
}
