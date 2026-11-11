import { ReadOnlyProvider } from "@/components/ui/ReadOnly";
import { isDemoSession } from "@/lib/session";

/**
 * Tells every workflow screen whether this is a read-only Demo Login
 * session (banner + disabled write controls, components/ui/ReadOnly.tsx).
 * UI only — no access decision is made here; each page still calls
 * requireCurrentUser() and every write is refused server-side for demo
 * sessions (proxy.ts, lib/session.ts demoWriteRefusal).
 */
export default async function WorkflowLayout({ children }: { children: React.ReactNode }) {
  return <ReadOnlyProvider readOnly={await isDemoSession()}>{children}</ReadOnlyProvider>;
}
