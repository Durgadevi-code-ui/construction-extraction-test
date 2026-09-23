import { ChevronDown } from "lucide-react";

/** Best-effort display name derived from an email's local-part (e.g.
 * "ramesh.kumar@x.com" -> "Ramesh Kumar") — purely cosmetic, never used
 * for identity/authorization (that's already resolved server-side
 * before this ever renders). Falls back to the email itself when it
 * doesn't look like a plain name. */
function displayNameFromEmail(email: string): string {
  const local = email.split("@")[0] ?? email;
  const words = local.replace(/[._-]+/g, " ").trim();
  if (!words) return email;
  return words
    .split(" ")
    .map((w) => (w ? w[0].toUpperCase() + w.slice(1) : w))
    .join(" ");
}

function initialsFromEmail(email: string): string {
  const name = displayNameFromEmail(email);
  const parts = name.split(" ").filter(Boolean);
  if (parts.length >= 2) return (parts[0][0] + parts[1][0]).toUpperCase();
  return name.slice(0, 2).toUpperCase();
}

/**
 * Header profile pill — avatar initials + display name + role label,
 * shared by every dashboard's header (see DashboardShell/WorkerTabs).
 * Purely presentational: the name is a cosmetic best-effort guess from
 * the already-verified session email, never a new identity source, and
 * the chevron is decorative (no menu — Sign out already lives in the
 * sidebar, unchanged).
 */
export default function ProfileChip({ email, roleLabel }: { email: string; roleLabel: string }) {
  return (
    <div className="hidden md:flex items-center gap-2 rounded-full border border-line bg-white pl-1.5 pr-3 py-1.5">
      <span className="flex h-7 w-7 items-center justify-center rounded-full bg-brand text-white text-xs font-semibold">
        {initialsFromEmail(email)}
      </span>
      <span className="text-xs leading-tight">
        <span className="block font-medium text-foreground truncate max-w-[120px]">
          {displayNameFromEmail(email)}
        </span>
        <span className="block text-foreground-muted">{roleLabel}</span>
      </span>
      <ChevronDown className="h-3.5 w-3.5 text-foreground-muted" strokeWidth={2} />
    </div>
  );
}
