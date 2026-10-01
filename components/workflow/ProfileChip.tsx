/** Best-effort display name derived from an email's local-part (e.g.
 * "ramesh.kumar@x.com" -> "Ramesh Kumar") — purely cosmetic, never used
 * for identity/authorization (that's already resolved server-side
 * before this ever renders). Falls back to the email itself when it
 * doesn't look like a plain name.
 *
 * Role-named accounts (e.g. "electrical.foreman@…") would otherwise
 * surface the legacy internal role codes, so those words are shown in
 * the business terminology used everywhere else (lib/format.ts
 * humanizeRole: FOREMAN = Subcontractor, SUPERVISOR = Contractor) —
 * display text only, the email/account itself is untouched. */
const LEGACY_ROLE_WORDS: Record<string, string> = {
  foreman: "Subcontractor",
  supervisor: "Contractor",
};

function displayNameFromEmail(email: string): string {
  const local = email.split("@")[0] ?? email;
  const words = local.replace(/[._-]+/g, " ").trim();
  if (!words) return email;
  return words
    .split(" ")
    .map((w) => LEGACY_ROLE_WORDS[w.toLowerCase()] ?? (w ? w[0].toUpperCase() + w.slice(1) : w))
    .join(" ");
}

function initialsFromEmail(email: string): string {
  const name = displayNameFromEmail(email);
  const parts = name.split(" ").filter(Boolean);
  if (parts.length >= 2) return (parts[0][0] + parts[1][0]).toUpperCase();
  return name.slice(0, 2).toUpperCase();
}

/**
 * Profile control in the shared sidebar, directly above Sign out (see
 * DashboardShell) — avatar initials + display name + role label, one per
 * page for every role. With `onClick` it opens that role's Profile tab
 * (`active` while it's open); without, it's display-only (e.g. Admin,
 * which has no Profile tab). The name is a cosmetic best-effort guess
 * from the already-verified session email, never a new identity source.
 */
export default function ProfileChip({
  email,
  roleLabel,
  onClick,
  active = false,
}: {
  email: string;
  roleLabel: string;
  onClick?: () => void;
  active?: boolean;
}) {
  const content = (
    <>
      <span className="flex h-8 w-8 shrink-0 items-center justify-center rounded-full bg-white text-brand text-xs font-semibold">
        {initialsFromEmail(email)}
      </span>
      <span className="min-w-0 text-left text-xs leading-tight">
        <span className="block font-medium truncate">{displayNameFromEmail(email)}</span>
        <span className="block text-white/60 truncate">{roleLabel}</span>
      </span>
    </>
  );
  const className = `w-full min-w-0 flex items-center gap-2.5 rounded-lg px-2 py-2 transition-colors duration-150 ${
    active ? "bg-brand text-white shadow-sm" : "text-white/90"
  }`;
  if (!onClick) return <div className={className}>{content}</div>;
  return (
    <button
      type="button"
      onClick={onClick}
      aria-current={active ? "page" : undefined}
      aria-label={`Profile — ${displayNameFromEmail(email)}, ${roleLabel}`}
      className={`${className} ${active ? "" : "hover:bg-white/10 hover:text-white"}`}
    >
      {content}
    </button>
  );
}
