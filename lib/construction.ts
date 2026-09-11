import "server-only";
import type { SupabaseClient } from "@supabase/supabase-js";

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
  "are", "at", "this", "that",
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
