import { ReadOnlyProvider } from "@/components/ui/ReadOnly";
import { isDemoSession } from "@/lib/session";

/** Same as app/workflow/layout.tsx, for Admin Setup. */
export default async function AdminSetupLayout({ children }: { children: React.ReactNode }) {
  return <ReadOnlyProvider readOnly={await isDemoSession()}>{children}</ReadOnlyProvider>;
}
