import { NextRequest, NextResponse } from "next/server";
import { getSupabaseClient } from "@/lib/supabase";
import { normalizeText, validateTypedText } from "@/lib/validation";
import {
  resolveConstructionContext,
  assessWorkerSubmissionRelevance,
  resolveWorkItemAmbiguity,
  textMatchesWorkItem,
  detectTaskConflict,
  type WorkItemAmbiguityResult,
} from "@/lib/construction";

import { getCurrentUser } from "@/lib/session";
import { resolveTaskForWorker } from "@/lib/workflow";

export const runtime = "nodejs";

export async function POST(request: NextRequest) {
  const supabase = getSupabaseClient();

  try {
    const body = await request.json();
    const originalText: unknown = body?.text;
    // Optional — the real Worker Dashboard (components/workflow/
    // DailyWorkUpdate.tsx) knows which work item it's updating and
    // passes that item's own description through, so the single
    // combined Validation step (see components/ValidationPanel.tsx) can
    // also confirm the extracted text is actually about that work item,
    // not just that it's readable — see assessWorkerSubmissionRelevance.
    // Omitted entirely by the standalone Extraction Accuracy Test tool.
    const selectedWorkItemDescription: unknown = body?.workItemDescription;
    const selectedWorkItemDescriptionOrNull =
      typeof selectedWorkItemDescription === "string" ? selectedWorkItemDescription : null;

    if (typeof originalText !== "string") {
      return NextResponse.json(
        { error: "No text provided." },
        { status: 400 }
      );
    }

    // ------------------------------------------------------------
    // 1. Normalize + validate
    // ------------------------------------------------------------

    const normalized = normalizeText(originalText);
    const validation = validateTypedText(originalText);

    // Similar work items: if the text can't single out ONE of the
    // worker's assigned work items, ask instead of guessing — before
    // anything is saved. Existing relevance rejections still take
    // precedence (only an otherwise-valid text is ever asked). Both ids
    // are optional and re-verified server-side against the worker's own
    // assignments (resolveWorkItemAmbiguity).
    const selectedWorkItemId: unknown = body?.workItemId;
    const confirmedWorkItemId: unknown = body?.confirmedWorkItemId;
    const hasSelectedWorkItem = typeof selectedWorkItemId === "string" && !!selectedWorkItemId;
    // Whether the Worker actually clicked this work item in
    // WorkItemSelector, vs. it being the system's own auto-suggested
    // default (see app/workflow/worker/page.tsx isAutoSuggested) —
    // defaults to true so any caller that omits it (e.g. the standalone
    // Extraction Accuracy Test tool) keeps the old "trust it" behavior.
    const hasExplicitSelection: boolean = body?.workItemExplicitlySelected !== false;

    // Optional Task context: never trusted from the client — it must be
    // one of the selected work item's own tasks AND that work item must be
    // one this worker is assigned to (resolveTaskForWorker). The relevance
    // and similar-work-item checks below still run regardless of task.
    const taskId: unknown = body?.taskId;
    // The worker's answer to a PREVIOUS taskConflict response from this
    // same endpoint (see below) — "keep" = "Continue with <selected
    // task>", "switch" = "Use <suggested task>" instead. Absent on a
    // first attempt, exactly like confirmedWorkItemId's role in the
    // work-item ambiguity flow below; nothing is ever saved until one
    // of these resolves the conflict (or none existed in the first
    // place).
    const taskConflictDecision: unknown = body?.taskConflictDecision;
    let task: { id: string; label: string } | null = null;
    if (typeof taskId === "string" && taskId) {
      const currentUser = await getCurrentUser();
      if (!currentUser || !hasSelectedWorkItem) {
        return NextResponse.json({ error: "A task requires a selected work item." }, { status: 400 });
      }
      let resolved;
      try {
        resolved = await resolveTaskForWorker(supabase, currentUser.userId, selectedWorkItemId as string, taskId);
      } catch {
        return NextResponse.json(
          { error: "That task does not belong to the selected work item." },
          { status: 400 }
        );
      }
      task = { id: resolved.id, label: resolved.label };

      // The selected Task is a structured claim, same as the selected
      // Work Item below — never silently stored when the actual typed
      // text clearly names a DIFFERENT task (see detectTaskConflict).
      // "keep" (worker explicitly chose to continue with their
      // original selection) skips this check entirely, same as
      // resolveWorkItemAmbiguity's confirmedWorkItemId short-circuit.
      if (taskConflictDecision !== "keep") {
        const conflict = detectTaskConflict(originalText, task, resolved.allTasks);
        if (conflict.status === "conflict") {
          if (taskConflictDecision === "switch") {
            // conflict.matchedTask already came from resolved.allTasks
            // (every Active task of THIS work item, already
            // authorization-checked above) — safe to use directly, no
            // second resolveTaskForWorker round trip needed.
            task = { id: conflict.matchedTask.id, label: conflict.matchedTask.label };
          } else {
            // Nothing saved yet — ask, exactly like the work-item
            // ambiguity "ambiguous" response below. The worker picks
            // Continue/Use suggested/Cancel; Cancel is purely a client-
            // side no-op (nothing to tell the server).
            return NextResponse.json({
              taskConflict: {
                selectedTask: task,
                suggestedTask: conflict.matchedTask,
              },
            });
          }
        }
      }
    }

    // Similar work items (only for a text that passed basic validation and
    // a selected work item): the text either points at ONE assigned item
    // (identified - possibly not the selected one - with strong evidence),
    // ties between several (ask, never guess), or the worker has just
    // confirmed one. Every candidate is re-verified against the worker's
    // own assignments inside resolveWorkItemAmbiguity.
    let selectedDescription = selectedWorkItemDescriptionOrNull;
    let confirmedWorkItem = null;
    let userConfirmed = false;
    let resolution: WorkItemAmbiguityResult = { status: "clear" };
    if (validation.status === "VALID" && hasSelectedWorkItem) {
      resolution = await resolveWorkItemAmbiguity(
        supabase,
        originalText,
        selectedWorkItemId as string,
        typeof confirmedWorkItemId === "string" && confirmedWorkItemId ? confirmedWorkItemId : null,
        hasExplicitSelection
      );
      if (resolution.status === "invalidConfirmation") {
        return NextResponse.json(
          { error: "That work item is not one of your assigned work items." },
          { status: 400 }
        );
      }
      if (resolution.status === "confirmed" || resolution.status === "resolved") {
        confirmedWorkItem = resolution.workItem;
        selectedDescription = resolution.workItem.description;
        userConfirmed = resolution.status === "confirmed";
      }
    }

    let relevance = await assessWorkerSubmissionRelevance(
      supabase,
      originalText,
      selectedDescription,
      hasSelectedWorkItem ? (selectedWorkItemId as string) : null
    );

    // A terse update ("Drywall work completed today.") is "vague" on its
    // own, but once the worker has explicitly confirmed a specific
    // assigned item AND the text names that item's subject, it is judged
    // against that item instead. Wrong-department / mismatch results are
    // never softened.
    if (
      relevance.status === "vague" &&
      userConfirmed &&
      confirmedWorkItem &&
      textMatchesWorkItem(originalText, confirmedWorkItem.description)
    ) {
      relevance = { status: "valid" };
    }

    // Ask when the text ties between similar items - if it is otherwise
    // valid, or merely terse but about the selected item's own family.
    if (
      resolution.status === "ambiguous" &&
      (relevance.status === "valid" || (relevance.status === "vague" && resolution.selectedInTie))
    ) {
      return NextResponse.json({ ambiguity: { candidates: resolution.candidates } });
    }

    // ------------------------------------------------------------
    // 2. Resolve project / department / work item / worker from the
    //    Construction Automation schema (never hardcoded).
    // ------------------------------------------------------------

    let context;
    try {
      context = await resolveConstructionContext(supabase, originalText);
    } catch (ctxErr) {
      console.error("Failed to resolve construction context:", ctxErr);
      return NextResponse.json(
        { error: "Could not resolve project/work item mapping." },
        { status: 500 }
      );
    }

    // ------------------------------------------------------------
    // 3. Save into extraction_submissions
    // ------------------------------------------------------------

    const { data: submission, error: insertError } = await supabase
      .from("extraction_submissions")
      .insert({
        project_id: context.projectId,
        department_id: context.departmentId,
        work_item_id: context.workItemId,
        worker_id: context.workerId,

        input_type: "TEXT",
        storage_path: null,
        raw_input_text: originalText,

        provider: "INTERNAL",
        processing_type: "TEXT_NORMALIZATION",

        raw_output: originalText,
        normalized_output: normalized,
        confidence_score: null,

        processing_status: "COMPLETED",
        processing_error: null,
        processed_at: new Date().toISOString(),

        validation_status: validation.status,
        validation_errors:
          validation.status === "INVALID" ? { reason: validation.reason } : null,
        validated_at: new Date().toISOString(),

        submission_status:
          validation.status === "VALID" ? "PENDING_REVIEW" : "REJECTED",
      })
      .select()
      .single();

    if (insertError || !submission) {
      console.error("Failed to save extraction_submissions:", insertError);
      return NextResponse.json(
        {
          error: `Failed to save submission: ${
            insertError?.message ?? "unknown error"
          }`,
        },
        { status: 500 }
      );
    }

    // ------------------------------------------------------------
    // 4. Return response
    // ------------------------------------------------------------

    return NextResponse.json({
      submissionId: submission.extraction_submission_id,
      rawText: originalText,
      normalizedText: normalized,
      confidence: null,
      status: validation.status,
      reason: validation.reason,
      workItem: {
        code: context.workItemCode,
        description: context.workItemDescription,
      },
      // Department + work-item relevance, resolved from the REAL
      // signed-in worker's session/project (see
      // assessWorkerSubmissionRelevance) — { status: "notChecked" } for
      // any caller with no real Worker session (e.g. the standalone
      // Extraction Accuracy Test tool), same as before.
      relevance,
      confirmedWorkItem,
      task,
    });
  } catch (err) {
    console.error("Text pipeline error:", err);

    const message = err instanceof Error ? err.message : "Processing failed.";

    return NextResponse.json({ error: message }, { status: 500 });
  }
}
