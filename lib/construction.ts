import "server-only";
import type { SupabaseClient } from "@supabase/supabase-js";
import { getCurrentUser } from "./session";
import { getUserContext } from "./authContext";
import { classifyConstructionImageDepartment } from "./ocr";

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
  /** Image path only: the classifier/provider itself failed (network,
   * auth, rate limit/quota, model unavailable, unexpected exception,
   * or the worker's own department was missing from the project
   * catalog) — the photo was never actually looked at, so this is
   * NEVER conflated with "vague" (a completed classification that
   * came back inconclusive) or "wrongDepartment". Callers must reject
   * on this exactly like any other non-"valid" status, but with a
   * distinct, retryable message — see imageRelevanceRejection. */
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
  selectedWorkItemDescription: string | null
): Promise<RelevanceCheckResult> {
  try {
    const currentUser = await getCurrentUser();
    if (!currentUser) return { status: "notChecked" };

    const ctx = await getUserContext(supabase, currentUser.userId);
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

/**
 * The visual counterpart to assessWorkerSubmissionRelevance — same
 * session resolution, same RelevanceCheckResult shape (reusing the
 * existing structure rather than inventing a new one), but the
 * department verdict comes from actually looking at the photo's
 * physical content (lib/ocr.ts classifyConstructionImageDepartment,
 * Gemini Vision), not from OCR'd note text. This is what makes a photo
 * of real work with no writing on it classifiable at all — an
 * OCR-only check (assessWorkerSubmissionRelevance) has nothing to work
 * with for that case.
 *
 * Department-level match is the ONLY mandatory rule for an image. Work
 * item relevance (classification.workItemRelevant) is computed by the
 * model for information purposes only and is never used to block —
 * unlike the TEXT-based assessSubmissionRelevance, where a work-item
 * mismatch does still block. A photo can clearly show the correct
 * department's work without visually proving one narrow selected work
 * item description.
 *
 * FAIL-CLOSED for a confirmed authenticated Worker, with THREE distinct
 * outcomes below "valid" — never collapsed into one another:
 *   - "wrongDepartment": the classifier confidently identified a
 *     DIFFERENT real project department.
 *   - "vague": the classifier ran successfully but the photo itself
 *     didn't contain enough recognizable construction evidence to name
 *     any department confidently.
 *   - "checkFailed": the classifier/provider itself did not run to
 *     completion (not configured, network/auth/rate-limit/quota/
 *     provider error, an unexpected exception, or the worker's own
 *     department was missing from the project catalog). This is NOT
 *     "vague" — nothing about the image was actually judged — so it
 *     must never be reported to the worker as if their photo showed
 *     the wrong department or was unclear; see imageRelevanceRejection
 *     for the distinct retryable message.
 * `{ status: "notChecked" }` is returned ONLY when there is genuinely
 * no authenticated Worker to enforce a department against at all (no
 * session, or a non-Worker role, e.g. the standalone Extraction
 * Accuracy Test tool). A confirmed Worker's photo is never silently
 * accepted just because the check itself broke.
 *
 * `visionChecked` mirrors `relevance.status !== "notChecked"`.
 *
 * `ownDepartmentName` (the resolved worker's own real department, from
 * the server-verified session — never client-supplied) is returned
 * alongside so a caller that doesn't already have it on hand (e.g. the
 * Live Update photo route) can build a message like "...not Electrical
 * Department work" without a second session lookup. Null when no
 * Worker was confirmed, or when even the worker's own department
 * couldn't be resolved.
 *
 * Diagnostic logging below is permanent, safe production telemetry
 * (worker role/department/project, the real department names supplied
 * to the classifier, success/failure and failure category, the
 * detected department, and the final decision) — never the image
 * bytes, never any credential/token/PII. See AGENTS.md's diagnostic
 * logging requirement.
 */
export async function assessImageSubmissionRelevance(
  supabase: SupabaseClient,
  fileBuffer: Buffer,
  mimeType: string,
  selectedWorkItemDescription: string | null
): Promise<{ relevance: RelevanceCheckResult; visionChecked: boolean; ownDepartmentName: string | null }> {
  const currentUser = await getCurrentUser().catch(() => null);
  if (!currentUser) return { relevance: { status: "notChecked" }, visionChecked: false, ownDepartmentName: null };

  let ctx;
  try {
    ctx = await getUserContext(supabase, currentUser.userId);
  } catch {
    // Could not even confirm this caller IS a Worker — not the
    // fail-closed case (that requires a CONFIRMED Worker), so this
    // stays "notChecked" exactly like before.
    return { relevance: { status: "notChecked" }, visionChecked: false, ownDepartmentName: null };
  }
  if (ctx.role !== "WORKER") return { relevance: { status: "notChecked" }, visionChecked: false, ownDepartmentName: null };

  // From here on, this IS a confirmed authenticated Worker — every
  // return below is a real verdict or a fail-closed rejection, never
  // "notChecked".
  const logContext = {
    workerRole: ctx.role,
    workerDepartmentId: ctx.departmentId,
    projectId: ctx.projectId,
  };

  try {
    const departments = await getProjectDepartmentVocabulary(supabase, ctx.projectId);
    const ownDepartment = departments.find((d) => d.departmentId === ctx.departmentId);

    if (!ownDepartment) {
      console.log(
        "[image-department-check] " +
          JSON.stringify({
            ...logContext,
            availableDepartmentNames: departments.map((d) => d.departmentName),
            classifierSucceeded: false,
            failureCategory: "worker_department_not_in_catalog",
            decision: "checkFailed",
          })
      );
      return { relevance: { status: "checkFailed" }, visionChecked: true, ownDepartmentName: null };
    }

    const classification = await classifyConstructionImageDepartment(
      fileBuffer,
      mimeType,
      departments.map((d) => d.departmentName),
      selectedWorkItemDescription
    );

    if ("error" in classification) {
      console.log(
        "[image-department-check] " +
          JSON.stringify({
            ...logContext,
            workerDepartmentName: ownDepartment.departmentName,
            availableDepartmentNames: departments.map((d) => d.departmentName),
            classifierSucceeded: false,
            failureCategory: classification.category,
            decision: "checkFailed",
          })
      );
      return { relevance: { status: "checkFailed" }, visionChecked: true, ownDepartmentName: ownDepartment.departmentName };
    }

    const baseLog = {
      ...logContext,
      workerDepartmentName: ownDepartment.departmentName,
      availableDepartmentNames: departments.map((d) => d.departmentName),
      classifierSucceeded: true,
      detectedDepartment: classification.detectedDepartment,
      workItemRelevant: classification.workItemRelevant,
      confidence: classification.confidence,
    };

    if (classification.detectedDepartment === null) {
      console.log("[image-department-check] " + JSON.stringify({ ...baseLog, decision: "vague" }));
      return { relevance: { status: "vague" }, visionChecked: true, ownDepartmentName: ownDepartment.departmentName };
    }

    if (classification.detectedDepartment.toLowerCase() !== ownDepartment.departmentName.toLowerCase()) {
      console.log("[image-department-check] " + JSON.stringify({ ...baseLog, decision: "wrongDepartment" }));
      return {
        relevance: { status: "wrongDepartment", matchedDepartmentName: classification.detectedDepartment },
        visionChecked: true,
        ownDepartmentName: ownDepartment.departmentName,
      };
    }

    console.log("[image-department-check] " + JSON.stringify({ ...baseLog, decision: "valid" }));
    return { relevance: { status: "valid" }, visionChecked: true, ownDepartmentName: ownDepartment.departmentName };
  } catch (err) {
    // A confirmed Worker, but something unexpected failed while
    // actually running the check (DB error fetching the department
    // catalog, an unexpected throw from the vision call, etc.) —
    // fail-closed to "checkFailed" (rejected, retryable), never
    // "notChecked" (which callers treat as permission to accept the
    // photo anyway) and never "vague" (nothing was actually judged).
    console.log(
      "[image-department-check] " +
        JSON.stringify({
          ...logContext,
          classifierSucceeded: false,
          failureCategory: "unexpected_exception",
          decision: "checkFailed",
        })
    );
    return { relevance: { status: "checkFailed" }, visionChecked: true, ownDepartmentName: null };
  }
}

/**
 * Shared server-side mapping from an image relevance verdict to the
 * HTTP status + user-facing message a route should return BEFORE any
 * storage upload / database insert / notification — used identically
 * by both image flows (app/api/handwritten/route.ts "Today's Update"
 * and app/api/workflow/live-updates/route.ts "Live Update Photo") so
 * they can never drift into different wording or different rejection
 * behavior. Returns null for "valid"/"notChecked"/"workItemMismatch"
 * (images never produce workItemMismatch — see
 * assessImageSubmissionRelevance's doc — this case only exists because
 * the type is shared with the text-based RelevanceResult), meaning the
 * caller should proceed normally.
 *
 * Message wording deliberately distinguishes "wrong department" (a
 * confident, wrong classification) from "vague" (a completed but
 * inconclusive classification) from "checkFailed" (the classifier/
 * provider never actually ran) — conflating any of these would either
 * mislead the worker (e.g. blaming "Plumbing" for what was actually a
 * quota/network failure) or, worse, silently accept an unverified
 * image.
 */
export function imageRelevanceRejection(
  relevance: RelevanceCheckResult,
  ownDepartmentName: string | null
): { status: number; error: string } | null {
  const dept = ownDepartmentName ?? "your department";
  switch (relevance.status) {
    case "wrongDepartment":
      return {
        status: 422,
        error: `This image appears to show ${relevance.matchedDepartmentName ?? "another department's"} work, not ${dept} work. Please upload an image showing ${dept} work.`,
      };
    case "vague":
      return {
        status: 422,
        error: `We couldn't confidently identify the construction department from this image. Please upload a clearer photo showing ${dept} work.`,
      };
    case "checkFailed":
      return {
        status: 503,
        error: "We couldn't verify this image right now. Please try again.",
      };
    default:
      return null;
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
