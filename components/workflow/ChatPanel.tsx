"use client";

import { useEffect, useState } from "react";
import { Send, MessageSquare, ArrowLeft, Users as UsersIcon } from "lucide-react";
import Card from "@/components/ui/Card";
import { Select } from "@/components/ui/Input";
import EmptyState from "@/components/ui/EmptyState";

type ChatMessage = {
  chatMessageId: string;
  senderName: string;
  senderRole: string;
  body: string;
  createdAt: string;
  isOwn: boolean;
};

type ChatContact = {
  userId: string;
  name: string;
  role: string;
};

const ROLE_LABEL: Record<string, string> = {
  WORKER: "Worker",
  FOREMAN: "Subcontractor",
  SUPERVISOR: "Contractor",
  MANAGER: "Contractor",
  ADMIN: "Admin",
};

/** Sentinel conversation id for the project-wide broadcast thread —
 * every existing (pre-migration) message and any future broadcast post
 * lives here; every other id is a real userId (a private 1:1 thread). */
const TEAM_THREAD = "team";

const POLL_INTERVAL_MS = 10000;

function formatTime(iso: string): string {
  return new Date(iso).toLocaleString([], {
    month: "short",
    day: "numeric",
    hour: "2-digit",
    minute: "2-digit",
  });
}

/**
 * Project Communication / Chat — private, WhatsApp-style 1:1
 * conversations (plus one pinned "Team" broadcast thread for backward
 * compatibility with every message posted before this UI existed — see
 * lib/chat.ts module doc). All authorization happens server-side in
 * lib/chat.ts — this component only ever sends a projectId when
 * `projects` is supplied (the Admin case, who must pick one) and a
 * recipientUserId when a real contact (not "Team") is selected; every
 * other role's project/contact list is resolved/validated from their
 * own server-verified session, never trusted from here.
 */
export default function ChatPanel({
  projects,
}: {
  /** Only Admin needs a project picker — everyone else's project is
   * resolved server-side from their own active assignment. */
  projects?: { projectId: string; projectName: string }[];
}) {
  const [projectId, setProjectId] = useState(projects?.[0]?.projectId ?? "");
  const [contacts, setContacts] = useState<ChatContact[]>([]);
  const [contactsLoading, setContactsLoading] = useState(true);
  const [selectedPeer, setSelectedPeer] = useState<string>(TEAM_THREAD);
  const [showThreadOnMobile, setShowThreadOnMobile] = useState(false);
  const [messages, setMessages] = useState<ChatMessage[]>([]);
  const [loading, setLoading] = useState(true);
  const [text, setText] = useState("");
  const [sending, setSending] = useState(false);
  const [error, setError] = useState<string | null>(null);

  const needsProject = !!projects && !projectId;

  async function refreshContacts() {
    if (needsProject) {
      setContactsLoading(false);
      return;
    }
    setContactsLoading(true);
    try {
      const params = new URLSearchParams({ contacts: "1" });
      if (projectId) params.set("projectId", projectId);
      const res = await fetch(`/api/workflow/chat?${params.toString()}`);
      const data = await res.json();
      if (!res.ok) throw new Error(data.error ?? "Failed to load contacts.");
      setContacts(data.contacts ?? []);
    } catch {
      // A failed contact list must never block the already-selected
      // "Team" thread from working — just leave the list empty.
    } finally {
      setContactsLoading(false);
    }
  }

  async function refreshMessages(showLoading: boolean) {
    if (needsProject) {
      setLoading(false);
      return;
    }
    if (showLoading) setLoading(true);
    try {
      const params = new URLSearchParams();
      if (projectId) params.set("projectId", projectId);
      if (selectedPeer !== TEAM_THREAD) params.set("peer", selectedPeer);
      const res = await fetch(`/api/workflow/chat?${params.toString()}`);
      const data = await res.json();
      if (!res.ok) throw new Error(data.error ?? "Failed to load messages.");
      setMessages(data.messages);
      setError(null);
    } catch (err) {
      setError(err instanceof Error ? err.message : "Failed to load messages.");
    } finally {
      if (showLoading) setLoading(false);
    }
  }

  useEffect(() => {
    async function run() {
      await refreshContacts();
    }
    run();
    // eslint-disable-next-line react-hooks/exhaustive-deps -- refreshContacts closes over projectId/needsProject, both already in this dependency list
  }, [projectId, needsProject]);

  useEffect(() => {
    async function run(showLoading: boolean) {
      await refreshMessages(showLoading);
    }
    run(true);
    // Background polls must not flip `loading` back to true — doing so
    // was tearing out the rendered message list every 10s and replacing
    // it with the "Loading messages…" placeholder, which read as the
    // panel flickering/closing.
    const interval = setInterval(() => run(false), POLL_INTERVAL_MS);
    return () => clearInterval(interval);
    // eslint-disable-next-line react-hooks/exhaustive-deps -- refreshMessages closes over projectId/needsProject/selectedPeer, all already in this dependency list
  }, [projectId, needsProject, selectedPeer]);

  function selectConversation(peer: string) {
    setSelectedPeer(peer);
    setShowThreadOnMobile(true);
  }

  async function handleSend(e: React.FormEvent) {
    e.preventDefault();
    if (!text.trim() || sending || needsProject) return;
    setSending(true);
    setError(null);
    try {
      const res = await fetch("/api/workflow/chat", {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({
          body: text,
          projectId: projectId || undefined,
          recipientUserId: selectedPeer !== TEAM_THREAD ? selectedPeer : undefined,
        }),
      });
      const data = await res.json();
      if (!res.ok) throw new Error(data.error ?? "Failed to send message.");
      setText("");
      await refreshMessages(false);
    } catch (err) {
      setError(err instanceof Error ? err.message : "Failed to send message.");
    } finally {
      setSending(false);
    }
  }

  const selectedContact = contacts.find((c) => c.userId === selectedPeer);
  const threadTitle = selectedPeer === TEAM_THREAD ? "Team" : selectedContact?.name ?? "Conversation";
  const threadSubtitle =
    selectedPeer === TEAM_THREAD
      ? "Everyone in this project"
      : selectedContact
        ? ROLE_LABEL[selectedContact.role] ?? selectedContact.role
        : undefined;

  return (
    <Card className="!p-0 overflow-hidden flex flex-col lg:flex-row min-h-[420px]">
      {/* Conversation list — hidden on mobile once a thread is open,
          always visible at lg+ alongside the thread. */}
      <div
        className={`w-full lg:w-64 shrink-0 border-b lg:border-b-0 lg:border-r border-line flex flex-col ${
          showThreadOnMobile ? "hidden lg:flex" : "flex"
        }`}
      >
        <div className="px-4 py-3 border-b border-line flex items-center justify-between gap-2">
          <h2 className="font-semibold text-foreground text-sm">Communication</h2>
          {projects && projects.length > 0 && (
            <Select
              value={projectId}
              onChange={(e) => setProjectId(e.target.value)}
              className="max-w-[140px] text-xs"
            >
              <option value="">Select…</option>
              {projects.map((p) => (
                <option key={p.projectId} value={p.projectId}>
                  {p.projectName}
                </option>
              ))}
            </Select>
          )}
        </div>

        {needsProject ? (
          <div className="p-4">
            <EmptyState icon={MessageSquare} title="Select a project to view its communication." />
          </div>
        ) : (
          <div className="flex-1 overflow-y-auto">
            <button
              type="button"
              onClick={() => selectConversation(TEAM_THREAD)}
              className={`w-full flex items-center gap-2.5 px-4 py-3 text-left text-sm border-b border-line-soft transition-colors duration-150 ${
                selectedPeer === TEAM_THREAD ? "bg-brand-soft" : "hover:bg-surface-hover"
              }`}
            >
              <span className="flex h-8 w-8 shrink-0 items-center justify-center rounded-full bg-brand text-white">
                <UsersIcon className="h-4 w-4" strokeWidth={2} />
              </span>
              <span className="min-w-0">
                <span className="block font-medium text-foreground truncate">Team</span>
                <span className="block text-xs text-foreground-muted truncate">Everyone in this project</span>
              </span>
            </button>

            {contactsLoading ? (
              <p className="px-4 py-4 text-xs text-foreground-muted">Loading contacts…</p>
            ) : contacts.length === 0 ? (
              <p className="px-4 py-4 text-xs text-foreground-muted">No other users in this project yet.</p>
            ) : (
              contacts.map((c) => (
                <button
                  key={c.userId}
                  type="button"
                  onClick={() => selectConversation(c.userId)}
                  className={`w-full flex items-center gap-2.5 px-4 py-3 text-left text-sm border-b border-line-soft transition-colors duration-150 ${
                    selectedPeer === c.userId ? "bg-brand-soft" : "hover:bg-surface-hover"
                  }`}
                >
                  <span className="flex h-8 w-8 shrink-0 items-center justify-center rounded-full bg-info text-white text-xs font-semibold">
                    {c.name.slice(0, 1).toUpperCase()}
                  </span>
                  <span className="min-w-0">
                    <span className="block font-medium text-foreground truncate">{c.name}</span>
                    <span className="block text-xs text-foreground-muted truncate">
                      {ROLE_LABEL[c.role] ?? c.role}
                    </span>
                  </span>
                </button>
              ))
            )}
          </div>
        )}
      </div>

      {/* Selected conversation — hidden on mobile until a conversation
          is chosen; always visible at lg+. */}
      <div
        className={`flex-1 min-w-0 flex-col ${
          showThreadOnMobile ? "flex" : "hidden lg:flex"
        }`}
      >
        <div className="px-5 py-3 border-b border-line flex items-center gap-2.5">
          <button
            type="button"
            onClick={() => setShowThreadOnMobile(false)}
            className="lg:hidden -ml-1 p-1 text-foreground-secondary"
            aria-label="Back to conversations"
          >
            <ArrowLeft className="h-4 w-4" strokeWidth={2} />
          </button>
          <div className="min-w-0">
            <p className="font-semibold text-foreground text-sm truncate">{threadTitle}</p>
            {threadSubtitle && <p className="text-xs text-foreground-muted truncate">{threadSubtitle}</p>}
          </div>
        </div>

        {error && (
          <p className="mx-5 mt-3 rounded-lg border border-error-border bg-error-soft px-3 py-2 text-sm text-error">
            {error}
          </p>
        )}

        {needsProject ? (
          <div className="flex-1" />
        ) : loading ? (
          <p className="px-5 py-6 text-sm text-foreground-muted">Loading messages…</p>
        ) : messages.length === 0 ? (
          <div className="flex-1 p-5">
            <EmptyState icon={MessageSquare} title="No messages yet — start the conversation." />
          </div>
        ) : (
          <div className="flex-1 overflow-y-auto px-5 py-4 space-y-3 max-h-[420px]">
            {messages.map((m) => (
              <div key={m.chatMessageId} className={`flex ${m.isOwn ? "justify-end" : "justify-start"}`}>
                <div
                  className={`max-w-[80%] rounded-xl px-3.5 py-2.5 text-sm ${
                    m.isOwn
                      ? "bg-brand text-white"
                      : "bg-surface-soft border border-line text-foreground"
                  }`}
                >
                  {!m.isOwn && selectedPeer === TEAM_THREAD && (
                    <p className="text-[11px] font-semibold mb-0.5 text-info">
                      {m.senderName}{" "}
                      <span className="font-normal text-foreground-muted">
                        · {ROLE_LABEL[m.senderRole] ?? m.senderRole}
                      </span>
                    </p>
                  )}
                  <p className="whitespace-pre-wrap break-words">{m.body}</p>
                  <p className={`text-[10px] mt-1 ${m.isOwn ? "text-white/70" : "text-foreground-muted"}`}>
                    {formatTime(m.createdAt)}
                  </p>
                </div>
              </div>
            ))}
          </div>
        )}

        <form onSubmit={handleSend} className="border-t border-line p-3 flex items-center gap-2">
          <input
            type="text"
            value={text}
            onChange={(e) => setText(e.target.value)}
            placeholder="Type a message…"
            disabled={needsProject || sending}
            maxLength={2000}
            className="flex-1 rounded-lg border border-line bg-white text-foreground px-3 py-2 text-sm placeholder:text-foreground-placeholder transition-colors duration-150 focus:outline-none focus:border-brand focus:ring-2 focus:ring-brand/20 disabled:opacity-50"
          />
          <button
            type="submit"
            disabled={needsProject || sending || !text.trim()}
            className="inline-flex items-center gap-1.5 rounded-lg bg-success hover:bg-success/90 text-white px-4 py-2 text-sm font-semibold transition-colors duration-150 disabled:opacity-50"
          >
            <Send className="h-4 w-4" strokeWidth={2} />
            Send
          </button>
        </form>
      </div>
    </Card>
  );
}
