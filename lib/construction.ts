import "server-only";
import type { SupabaseClient } from "@supabase/supabase-js";
import { getCurrentUser } from "./session";
import { getUserContext } from "./authContext";
import { getSupabaseServiceRoleClient } from "./supabaseAdmin";

/**
 * Resolves extraction submissions to the Construction Automation schema
 * (projects / departments / work_items / users) by querying the existing
 * seeded data — never by hardcoding IDs.
 *
 * Test-app scope: there is no project picker or login in the UI, so the
 * target project is fixed by project_code and the work item is inferred
 * from the extracted text (keyword match against work_items.description_of_work,
 * or an explicit line item code like "W003" mentioned in the text).
 */

const DEFAULT_PROJECT_CODE =
  process.env.CONSTRUCTION_PROJECT_CODE?.trim() || "PRJ001";

const TEST_WORKER_EMAIL =
  process.env.CONSTRUCTION_TEST_WORKER_EMAIL?.trim() ||
  "extraction-test-worker@abc-construction.internal";

export type ConstructionContext = {
  projectId: string;
  departmentId: string;
  workItemId: string;
  workerId: string;
  workItemCode: string;
  workItemDescription: string;
};

type WorkItemRow = {
  work_item_id: string;
  line_item_no: string;
  description_of_work: string;
  department_id: string;
};

async function getProject(supabase: SupabaseClient) {
  const { data, error } = await supabase
    .from("projects")
    .select("project_id, company_id, project_code")
    .eq("project_code", DEFAULT_PROJECT_CODE)
    .single();

  if (error || !data) {
    throw new Error(
      `Construction project with project_code '${DEFAULT_PROJECT_CODE}' was not found: ${
        error?.message ?? "no matching row"
      }`
    );
  }

  return data;
}

async function getWorkItems(
  supabase: SupabaseClient,
  projectId: string
): Promise<WorkItemRow[]> {
  const { data, error } = await supabase
    .from("work_items")
    .select("work_item_id, line_item_no, description_of_work, department_id")
    .eq("project_id", projectId);

  if (error) {
    throw new Error(`Failed to load work items: ${error.message}`);
  }
  if (!data || data.length === 0) {
    throw new Error(`No work items found for project ${projectId}`);
  }

  return data;
}

const STOPWORDS = new Set([
  "the", "a", "an", "of", "and", "or", "to", "in", "on", "for", "with",
  "work", "works", "today", "completed", "complete", "is", "was", "were",
  "are", "at", "this", "that", "progress", "status", "update",
]);

function tokenize(text: string): string[] {
  return (
    text
      .toLowerCase()
      .match(/[a-z0-9]+/g)
      ?.filter((word) => word.length > 2 && !STOPWORDS.has(word)) ?? []
  );
}

/**
 * Picks the work item the text is most likely describing.
 *
 * 1. An explicit line item code mentioned in the text (e.g. "W003") wins
 *    outright.
 * 2. Otherwise, the work item whose description shares the most keywords
 *    with the text wins.
 * 3. If nothing matches at all (empty/unrecognizable text, e.g. a failed
 *    OCR/STT attempt), falls back to the lowest line_item_no so a FK-valid
 *    row can still be recorded for the failed attempt.
 */
export function matchWorkItem(
  text: string,
  workItems: WorkItemRow[]
): WorkItemRow {
  const upperText = text.toUpperCase();
  const lineItemMatch = workItems.find((item) =>
    upperText.includes(item.line_item_no.toUpperCase())
  );
  if (lineItemMatch) {
    return lineItemMatch;
  }

  const inputTokens = new Set(tokenize(text));

  let best: WorkItemRow | null = null;
  let bestScore = 0;
  for (const item of workItems) {
    const descriptionTokens = tokenize(item.description_of_work);
    const score = descriptionTokens.filter((token) =>
      inputTokens.has(token)
    ).length;
    if (score > bestScore) {
      bestScore = score;
      best = item;
    }
  }

  if (best) {
    return best;
  }

  return [...workItems].sort((a, b) =>
    a.line_item_no.localeCompare(b.line_item_no)
  )[0];
}

/**
 * There is no auth/login in this test app, so submissions have no real
 * logged-in worker. worker_id is NOT NULL on extraction_submissions, so
 * we get-or-create a single reusable "Extraction Test Worker" row scoped
 * to the matched work item's department, instead of inventing a UUID.
 */
async function getOrCreateTestWorker(
  supabase: SupabaseClient,
  departmentId: string
): Promise<string> {
  const { data: existing, error: findError } = await supabase
    .from("users")
    .select("user_id")
    .eq("user_mail", TEST_WORKER_EMAIL)
    .maybeSingle();

  if (findError) {
    throw new Error(`Failed to look up test worker: ${findError.message}`);
  }
  if (existing) {
    return existing.user_id;
  }

  const { data: created, error: createError } = await supabase
    .from("users")
    .insert({
      department_id: departmentId,
      user_mail: TEST_WORKER_EMAIL,
      user_role: "WORKER",
      first_name: "Extraction",
      last_name: "Test Worker",
      status: "Active",
    })
    .select("user_id")
    .single();

  if (createError || !created) {
    throw new Error(
      `Failed to create test worker: ${
        createError?.message ?? "no row returned"
      }`
    );
  }

  return created.user_id;
}

/**
 * A worker's department, and every other department in the same
 * project, each represented as the pooled vocabulary of their own real
 * work item descriptions — the "source of truth" assessSubmissionRelevance
 * compares free text against. Built from `work_items`, never a
 * hardcoded per-trade word list, so it automatically reflects whatever
 * departments/work items a given project actually has (per-project,
 * per-department — safe for a worker who has different departments on
 * different projects; see getUserContext's availableProjects).
 */
export type DepartmentVocabulary = {
  departmentId: string;
  departmentName: string;
  /** Every work item description in this department, already tokenized
   * and pooled into one set (duplicates collapsed) — this IS the
   * department's "vocabulary" for relevance comparison. */
  tokens: Set<string>;
};

/** One query, grouped in JS — a project's work item catalog is small
 * (dozens to low hundreds of rows), so this is cheap and avoids a
 * separate round trip per department. */
export async function getProjectDepartmentVocabulary(
  supabase: SupabaseClient,
  projectId: string
): Promise<DepartmentVocabulary[]> {
  const { data, error } = await supabase
    .from("work_items")
    .select("department_id, description_of_work, departments(department_name)")
    .eq("project_id", projectId);

  if (error) {
    throw new Error(`Failed to load department vocabulary: ${error.message}`);
  }

  const byDepartment = new Map<string, DepartmentVocabulary>();
  for (const row of data ?? []) {
    const departmentId = row.department_id as string;
    const departmentsField = row.departments as { department_name: string } | { department_name: string }[] | null;
    const departmentName = Array.isArray(departmentsField)
      ? (departmentsField[0]?.department_name ?? "(unknown department)")
      : (departmentsField?.department_name ?? "(unknown department)");

    let entry = byDepartment.get(departmentId);
    if (!entry) {
      entry = { departmentId, departmentName, tokens: new Set() };
      byDepartment.set(departmentId, entry);
    }
    for (const token of tokenize(row.description_of_work as string)) {
      entry.tokens.add(token);
    }
  }

  return [...byDepartment.values()];
}

export type RelevanceResult =
  | { status: "valid" }
  | { status: "wrongDepartment"; matchedDepartmentName: string | null }
  | { status: "vague" }
  | { status: "workItemMismatch" }
  /** Reserved for a check that could not run at all (provider/network
   * failure) as opposed to "vague" (a completed check that came back
   * inconclusive). Not currently produced by any TEXT/VOICE relevance
   * path below — images no longer run a department classification at
   * all (that check was intentionally removed; see components/workflow/
   * LiveUpdateBar.tsx and app/api/handwritten/route.ts) — kept in the
   * union so ValidationPanel.tsx's mirrored type and rendering stay
   * valid without change. */
  | { status: "checkFailed" };

/**
 * A terse update ("40% done today", "finished", "2 more rooms") has too
 * few substantive words to judge at all — reported as "vague", not a
 * department guess, so a worker jotting a quick status update is asked
 * for more detail instead of getting a confusing "wrong department"
 * message. Below this, no comparison is attempted.
 */
const MIN_TOKENS_TO_JUDGE = 2;

/**
 * Levels 1-2 of the Worker input relevance check (see AGENTS.md /
 * project spec section on Worker Dashboard validation):
 *   1. DEPARTMENT — does the free text read as work belonging to the
 *      worker's own department, using that department's real work item
 *      vocabulary (getProjectDepartmentVocabulary) vs. every OTHER
 *      department's in the same project? A worker's own department
 *      wins any tie/ambiguity (see "do not over-validate" — mentioning
 *      an adjacent trade in passing shouldn't trigger a false reject);
 *      only text that scores ZERO against the worker's own department
 *      AND scores something against a different one is reported
 *      wrongDepartment. Zero against every department is "vague", not
 *      a department guess — there's nothing to confidently name.
 *   2. WORK ITEM — only evaluated once department passes, and only
 *      when a specific work item's description was provided. Reuses
 *      the same tokenize/overlap technique, scoped to just that one
 *      item's own description (not the whole department's pooled
 *      vocabulary) — semantic-ish via shared keywords, not exact
 *      phrase matching, so "emergency power" text matches an
 *      "Emergency/Standby Power" item without the worker ever typing
 *      the work item number.
 *
 * Pure function — no DB access — so the department vocabulary is
 * fetched once per request (getProjectDepartmentVocabulary) and passed
 * in, not re-fetched here.
 */
export function assessSubmissionRelevance(params: {
  text: string;
  ownDepartmentId: string;
  departments: DepartmentVocabulary[];
  selectedWorkItemDescription?: string | null;
}): RelevanceResult {
  const { text, ownDepartmentId, departments, selectedWorkItemDescription } = params;
  const textTokens = new Set(tokenize(text));

  if (textTokens.size < MIN_TOKENS_TO_JUDGE) {
    return { status: "vague" };
  }

  const ownVocabulary = departments.find((d) => d.departmentId === ownDepartmentId);
  const ownScore = ownVocabulary
    ? [...textTokens].filter((token) => ownVocabulary.tokens.has(token)).length
    : 0;

  if (ownScore === 0) {
    let bestOther: DepartmentVocabulary | null = null;
    let bestOtherScore = 0;
    for (const dept of departments) {
      if (dept.departmentId === ownDepartmentId) continue;
      const score = [...textTokens].filter((token) => dept.tokens.has(token)).length;
      if (score > bestOtherScore) {
        bestOtherScore = score;
        bestOther = dept;
      }
    }
    if (bestOtherScore > 0) {
      return { status: "wrongDepartment", matchedDepartmentName: bestOther?.departmentName ?? null };
    }
    // No department — own or otherwise — shares any vocabulary with
    // this text. Too ambiguous to call a department mismatch; treated
    // the same as a too-short update.
    return { status: "vague" };
  }

  if (selectedWorkItemDescription) {
    const itemTokens = new Set(tokenize(selectedWorkItemDescription));
    const itemOverlap = itemTokens.size === 0 || [...textTokens].some((token) => itemTokens.has(token));
    if (!itemOverlap) {
      return { status: "workItemMismatch" };
    }
  }

  return { status: "valid" };
}

/** Whether the text shares at least one substantive word with a work
 * item's own description - used only after the worker has explicitly
 * confirmed that work item (see app/api/text/route.ts). */
export function textMatchesWorkItem(text: string, description: string): boolean {
  const itemTokens = new Set(tokenize(description));
  return tokenize(text).some((t) => itemTokens.has(t));
}

export type TaskConflictResult =
  | { status: "noConflict" }
  | { status: "conflict"; matchedTask: { id: string; label: string } };

/**
 * Detects when a worker's typed text clearly names a DIFFERENT task of
 * the same work item than the one they explicitly selected — e.g.
 * selected task "Install metal stud framing" but the text reads "Tape
 * and finish joints done today." Reuses the same tokenize/keyword-
 * overlap technique as assessSubmissionRelevance/textMatchesWorkItem —
 * semantic-ish via shared words, not exact phrase matching.
 *
 * Deliberately conservative: only flags a conflict when a DIFFERENT
 * task scores clearly higher than the selected one AND on at least two
 * shared substantive words — a terse update, or text that merely
 * mentions the selected task's own wording (even partially), is never
 * falsely flagged. This mirrors resolveWorkItemAmbiguity's "only ask/
 * flag on strong evidence" principle at the task level, so a worker who
 * picked the right task from the dropdown and typed a normal update is
 * never bothered.
 */
export function detectTaskConflict(
  text: string,
  selectedTask: { id: string; label: string },
  allTasks: { id: string; label: string }[]
): TaskConflictResult {
  const textTokens = new Set(tokenize(text));
  if (textTokens.size < MIN_TOKENS_TO_JUDGE) return { status: "noConflict" };

  const scoreFor = (label: string) =>
    tokenize(label).filter((token) => textTokens.has(token)).length;
  const selectedScore = scoreFor(selectedTask.label);

  let best: { id: string; label: string } | null = null;
  let bestScore = 0;
  for (const task of allTasks) {
    if (task.id === selectedTask.id) continue;
    const score = scoreFor(task.label);
    if (score > bestScore) {
      bestScore = score;
      best = task;
    }
  }

  if (best && bestScore >= 2 && bestScore > selectedScore) {
    return { status: "conflict", matchedTask: best };
  }
  return { status: "noConflict" };
}

export type RelevanceCheckResult = RelevanceResult | { status: "notChecked" };

/**
 * Session-aware wrapper around assessSubmissionRelevance — the one
 * entry point app/api/text|handwritten|voice/route.ts each call. Best-
 * effort and NEVER throws: the standalone Extraction Accuracy Test tool
 * (/dev/extraction-test) has no real session and no selected work item,
 * and a Contractor/Admin poking at that same tool isn't a Worker with a
 * department to check against — both cases, and any lookup failure,
 * degrade to "notChecked" (the old behavior: no relevance message shown
 * at all) rather than breaking extraction. Identity and
 * project/department come ONLY from the server-verified session
 * (getCurrentUser -> getUserContext), never from a client-supplied id —
 * the same authorization boundary every other Worker action in this app
 * already uses — so this can't be used to probe another
 * project/department's data.
 */
export async function assessWorkerSubmissionRelevance(
  supabase: SupabaseClient,
  text: string,
  selectedWorkItemDescription: string | null,
  selectedWorkItemId?: string | null
): Promise<RelevanceCheckResult> {
  try {
    const currentUser = await getCurrentUser();
    if (!currentUser) return { status: "notChecked" };

    // A worker on several projects is judged against the project of the
    // work item they selected, not always their first one. A work item
    // outside their own projects just falls back to the default context
    // (getUserContext ignores a project the user has no Active role in).
    // Same for a worker holding two departments in one project: judge
    // against the selected work item's own department, not their first.
    let projectId: string | undefined;
    let departmentId: string | undefined;
    if (selectedWorkItemId) {
      const { data } = await supabase
        .from("work_items")
        .select("project_id, department_id")
        .eq("work_item_id", selectedWorkItemId)
        .maybeSingle();
      projectId = (data?.project_id as string | undefined) ?? undefined;
      departmentId = (data?.department_id as string | undefined) ?? undefined;
    }
    const ctx = await getUserContext(supabase, currentUser.userId, projectId ? { projectId, departmentId } : undefined);
    if (ctx.role !== "WORKER") return { status: "notChecked" };

    const departments = await getProjectDepartmentVocabulary(supabase, ctx.projectId);
    return assessSubmissionRelevance({
      text,
      ownDepartmentId: ctx.departmentId,
      departments,
      selectedWorkItemDescription,
    });
  } catch {
    return { status: "notChecked" };
  }
}

export type WorkItemCandidate = {
  workItemId: string;
  code: string;
  description: string;
  plannedQuantity: number | null;
  unitOfMeasure: string | null;
};

export type WorkItemAmbiguityResult =
  | { status: "clear" }
  /** `selectedInTie`: the worker's currently selected item is one of the
   * tied candidates (the text is about that family of similar items). */
  | { status: "ambiguous"; candidates: WorkItemCandidate[]; selectedInTie: boolean }
  /** No longer produced by resolveWorkItemAmbiguity below (a strong
   * conflict with an explicitly selected item is always asked about via
   * "ambiguous" now, never silently switched) — kept in the type only
   * so existing callers that still check for it keep compiling. */
  | { status: "resolved"; workItem: WorkItemCandidate }
  | { status: "confirmed"; workItem: WorkItemCandidate }
  | { status: "invalidConfirmation" };

/** Like `tokenize`, but keeps 1-2 character tokens ("1", "2", "l2") —
 * those are exactly what tells "Level 1" from "Level 2" apart. */
function tokenizeDistinguishing(text: string): string[] {
  return text.toLowerCase().match(/[a-z0-9]+/g)?.filter((w) => !STOPWORDS.has(w)) ?? [];
}

/**
 * Similar-work-item handling for a Worker's typed update. Purely
 * additive to assessWorkerSubmissionRelevance (which still runs, and
 * still rejects wrong-department/vague/mismatched text exactly as
 * before) — this only decides whether the text points at ONE of the
 * worker's own assigned work items or is a tie between several similar
 * ones ("Electrical Installation — Level 1/2/3" with text that never
 * says which level).
 *
 * Candidates come only from the worker's own Active work_item_assignments
 * (server-verified session), narrowed to the same project + department
 * as the work item they currently have selected — no names, numbers or
 * projects are hardcoded, so new projects/work items/assignments are
 * picked up automatically. A tie is reported ambiguous ONLY when the
 * text contains nothing (a level number, a line item code, another
 * distinguishing word) that singles out exactly one of the tied items;
 * otherwise it is "clear" and the worker is not bothered. Anything
 * unexpected (no worker session, non-Worker role, lookup failure)
 * degrades to "clear" — the old behavior — never blocks extraction.
 *
 * `confirmedWorkItemId` (the worker's pick from a previous "ambiguous"
 * answer) is re-verified against that same assigned set here, so it can
 * never be used to target a work item that isn't theirs.
 */
export async function resolveWorkItemAmbiguity(
  supabase: SupabaseClient,
  text: string,
  selectedWorkItemId: string,
  confirmedWorkItemId?: string | null,
  /** Whether `selectedWorkItemId` is the Worker's own explicit choice
   * (picked in WorkItemSelector) as opposed to the system's own
   * auto-suggested default (see page.tsx's isAutoSuggested). Defaults to
   * true (explicit) so every pre-existing caller that doesn't pass this
   * keeps its old behavior. Only affects the "text gives no signal at
   * all" branch below (see its own comment) — CASE 1/3/4 (a signal
   * clearly matches, or clearly conflicts with, the selection) are
   * unaffected either way, since those never depended on how the
   * selection was made. */
  hasExplicitSelection: boolean = true
): Promise<WorkItemAmbiguityResult> {
  try {
    const currentUser = await getCurrentUser();
    if (!currentUser) return { status: "clear" };
    const ctx = await getUserContext(supabase, currentUser.userId);
    if (ctx.role !== "WORKER") return { status: "clear" };

    const { data, error } = await getSupabaseServiceRoleClient()
      .from("work_item_assignments")
      .select(
        "work_items!inner(work_item_id, line_item_no, description_of_work, department_id, project_id, planned_quantity, unit_of_measure, status)"
      )
      .eq("user_id", currentUser.userId)
      .eq("status", "Active")
      .eq("work_items.status", "Active");
    if (error) return { status: "clear" };

    type Row = {
      work_item_id: string;
      line_item_no: string;
      description_of_work: string;
      department_id: string;
      project_id: string;
      planned_quantity: number | null;
      unit_of_measure: string | null;
    };
    const assigned = ((data ?? []) as unknown as { work_items: Row | Row[] | null }[])
      .map((r) => (Array.isArray(r.work_items) ? r.work_items[0] : r.work_items))
      .filter((w): w is Row => !!w);

    const selected = assigned.find((w) => w.work_item_id === selectedWorkItemId);
    if (!selected) return { status: "clear" };

    const pool = assigned
      .filter((w) => w.project_id === selected.project_id && w.department_id === selected.department_id)
      .sort((a, b) => a.line_item_no.localeCompare(b.line_item_no));
    const toCandidate = (w: Row): WorkItemCandidate => ({
      workItemId: w.work_item_id,
      code: w.line_item_no,
      description: w.description_of_work,
      plannedQuantity: w.planned_quantity,
      unitOfMeasure: w.unit_of_measure,
    });

    if (confirmedWorkItemId) {
      const chosen = pool.find((w) => w.work_item_id === confirmedWorkItemId);
      return chosen
        ? { status: "confirmed", workItem: toCandidate(chosen) }
        : { status: "invalidConfirmation" };
    }

    const textTokens = new Set(tokenize(text));
    const scored = pool.map((w) => ({
      row: w,
      score: tokenize(w.description_of_work).filter((t) => textTokens.has(t)).length,
    }));
    const top = Math.max(0, ...scored.map((s) => s.score));
    if (top === 0) return { status: "clear" };

    const tied = scored.filter((s) => s.score === top).map((s) => s.row);
    if (tied.length < 2) return { status: "clear" };

    const tiedTokenSets = tied.map(
      (w) =>
        new Set([
          ...tokenizeDistinguishing(w.description_of_work),
          ...tokenizeDistinguishing(w.line_item_no),
        ])
    );
    const textDistinguishingTokens = new Set(tokenizeDistinguishing(text));
    const uniqueTokens = (i: number) =>
      [...tiedTokenSets[i]].filter((t) => !tiedTokenSets.every((set) => set.has(t)));
    const mentionedIdx = tied
      .map((_, i) => i)
      .filter((i) => uniqueTokens(i).some((t) => textDistinguishingTokens.has(t)));
    const mentioned = mentionedIdx.map((i) => tied[i]);
    // Singles out the very item the worker has selected -> nothing to ask.
    if (mentioned.length === 1 && mentioned[0].work_item_id === selectedWorkItemId) {
      return { status: "clear" };
    }

    const selectedInTie = tied.some((w) => w.work_item_id === selectedWorkItemId);

    // The text gives NO signal distinguishing between the tied family
    // members at all (e.g. "Drywall work is progressing" scores equally
    // against Level 1/2/3) — there is nothing for the worker to
    // disambiguate. If the worker EXPLICITLY selected this item, that
    // selection is trusted as-is rather than asking a question the text
    // itself can't answer (CASE 1/2 in the spec). But when the "selected"
    // item is only the system's own auto-suggested default (the worker
    // never actually picked one), silently trusting it would mean a
    // Worker who typed "Drywall installation completed" with no level
    // selected never gets asked which level they mean — so fall through
    // to the ambiguous return below instead (CASE 2: ask).
    if (mentioned.length === 0 && selectedInTie && hasExplicitSelection) {
      return { status: "clear" };
    }

    // Singles out a DIFFERENT item of the same similar family than the
    // one currently selected - only on strong evidence, never a bare
    // number that could just be a quantity ("2 rooms"). This is a
    // genuine conflict with the worker's own explicit selection, so it
    // is ALWAYS asked about (never silently switched): a two-way choice
    // between exactly the selected item and the one the text suggests,
    // not the whole tied family.
    if (mentioned.length === 1 && selectedInTie) {
      const i = mentionedIdx[0];
      const m = mentioned[0];
      const textSeq = tokenizeDistinguishing(text);
      const descSeq = tokenizeDistinguishing(m.description_of_work);
      const codeTokens = new Set(tokenizeDistinguishing(m.line_item_no));
      const strong = uniqueTokens(i).some((u) => {
        if (!textDistinguishingTokens.has(u)) return false;
        if (codeTokens.has(u)) return true; // line item code
        if (!/^\d+$/.test(u)) return true; // a distinguishing word
        // bare number: only with the same "<word> <number>" pair as in the
        // item's own description (e.g. "level 2")
        return textSeq.some(
          (t, k) => t === u && k > 0 && descSeq.some((d, j) => d === u && j > 0 && descSeq[j - 1] === textSeq[k - 1])
        );
      });
      if (strong && m.work_item_id !== selectedWorkItemId) {
        return {
          status: "ambiguous",
          candidates: [toCandidate(selected), toCandidate(m)],
          selectedInTie: true,
        };
      }
    }

    return { status: "ambiguous", candidates: tied.map(toCandidate), selectedInTie };
  } catch {
    return { status: "clear" };
  }
}
/**
 * Resolves project/department/work_item/worker IDs for a piece of
 * extracted text by querying the existing Construction Automation data.
 * Throws only on real infra problems (project missing, DB error) — an
 * empty/unmatched `text` (e.g. a failed OCR/STT attempt) still resolves,
 * via matchWorkItem's fallback, so failed attempts can still be recorded.
 */
export async function resolveConstructionContext(
  supabase: SupabaseClient,
  text: string
): Promise<ConstructionContext> {
  const project = await getProject(supabase);
  const workItems = await getWorkItems(supabase, project.project_id);
  const matched = matchWorkItem(text, workItems);
  const workerId = await getOrCreateTestWorker(supabase, matched.department_id);

  return {
    projectId: project.project_id,
    departmentId: matched.department_id,
    workItemId: matched.work_item_id,
    workerId,
    workItemCode: matched.line_item_no,
    workItemDescription: matched.description_of_work,
  };
}
