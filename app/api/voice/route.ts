import { randomUUID } from "crypto";
import { NextRequest, NextResponse } from "next/server";
import { getSupabaseClient, STORAGE_BUCKETS } from "@/lib/supabase";
import { runSTT } from "@/lib/stt";
import { normalizeText, validateVoice } from "@/lib/validation";
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

const MAX_SIZE_BYTES = 25 * 1024 * 1024; // 25MB

/**
 * Voice input — same selected Project/Work Item/Task context handling as
 * app/api/text/route.ts, applied to the SPEECH-TO-TEXT TRANSCRIPT once
 * it exists (never a separate voice-specific validation system; see
 * that route's doc for the full rationale of each shared function
 * reused below: resolveWorkItemAmbiguity, resolveTaskForWorker,
 * detectTaskConflict, assessWorkerSubmissionRelevance,
 * textMatchesWorkItem). Ambiguity/task-conflict responses use the exact
 * same { ambiguity } / { taskConflict } shapes the Text flow already
 * uses so the client-side confirmation UI pattern is identical.
 */
export async function POST(request: NextRequest) {
  const supabase = getSupabaseClient();

  try {
    const formData = await request.formData();
    const file = formData.get("audio");
    const selectedWorkItemDescriptionRaw = formData.get("workItemDescription");
    const selectedWorkItemDescription =
      typeof selectedWorkItemDescriptionRaw === "string" ? selectedWorkItemDescriptionRaw : null;
    const selectedWorkItemIdRaw = formData.get("workItemId");
    const selectedWorkItemId = typeof selectedWorkItemIdRaw === "string" && selectedWorkItemIdRaw ? selectedWorkItemIdRaw : null;
    const confirmedWorkItemIdRaw = formData.get("confirmedWorkItemId");
    const confirmedWorkItemIdInput =
      typeof confirmedWorkItemIdRaw === "string" && confirmedWorkItemIdRaw ? confirmedWorkItemIdRaw : null;
    const taskIdRaw = formData.get("taskId");
    const taskIdInput = typeof taskIdRaw === "string" && taskIdRaw ? taskIdRaw : null;
    const taskConflictDecisionRaw = formData.get("taskConflictDecision");
    const taskConflictDecision = typeof taskConflictDecisionRaw === "string" ? taskConflictDecisionRaw : null;
    // See app/api/text/route.ts for the full rationale — defaults to
    // explicit (true) so an omitted field keeps the old "trust it" behavior.
    const hasExplicitSelection = formData.get("workItemExplicitlySelected") !== "false";

    if (!file || !(file instanceof File)) {
      return NextResponse.json(
        { error: "No audio file provided." },
        { status: 400 }
      );
    }

    if (!file.type.startsWith("audio/") && file.type !== "video/webm") {
      return NextResponse.json(
        { error: `Unsupported audio type: ${file.type || "unknown"}.` },
        { status: 400 }
      );
    }

    if (file.size > MAX_SIZE_BYTES) {
      return NextResponse.json(
        { error: "Audio exceeds the 25MB limit." },
        { status: 400 }
      );
    }

    const arrayBuffer = await file.arrayBuffer();
    const buffer = Buffer.from(arrayBuffer);

    // ------------------------------------------------------------
    // 1. Speech to text
    // ------------------------------------------------------------

    const sttResult = await runSTT(buffer);
    const sttFailed = "error" in sttResult;

    const rawText = sttFailed ? "" : sttResult.rawText;
    const confidence = sttFailed ? null : sttResult.confidence;
    const normalized = sttFailed ? "" : normalizeText(rawText);

    const validation = sttFailed
      ? { status: "INVALID" as const, reason: sttResult.error }
      : validateVoice(sttResult.rawText, sttResult.confidence);

    // ------------------------------------------------------------
    // 2. Task context (validated server-side, never trusted from the
    //    client) — same resolveTaskForWorker + detectTaskConflict as
    //    /api/text, run against the TRANSCRIPT. Skipped entirely when
    //    STT failed (nothing to judge) or no task was selected (Task
    //    Context feature disabled, or no task chosen).
    // ------------------------------------------------------------

    let task: { id: string; label: string } | null = null;
    if (!sttFailed && taskIdInput && selectedWorkItemId) {
      const currentUser = await getCurrentUser();
      if (currentUser) {
        let resolved;
        try {
          resolved = await resolveTaskForWorker(supabase, currentUser.userId, selectedWorkItemId, taskIdInput);
        } catch {
          return NextResponse.json(
            { error: "That task does not belong to the selected work item." },
            { status: 400 }
          );
        }
        task = { id: resolved.id, label: resolved.label };

        if (taskConflictDecision !== "keep") {
          const conflict = detectTaskConflict(rawText, task, resolved.allTasks);
          if (conflict.status === "conflict") {
            if (taskConflictDecision === "switch") {
              task = { id: conflict.matchedTask.id, label: conflict.matchedTask.label };
            } else {
              return NextResponse.json({
                taskConflict: { selectedTask: task, suggestedTask: conflict.matchedTask },
              });
            }
          }
        }
      }
    }

    // ------------------------------------------------------------
    // 3. Similar work items — same resolveWorkItemAmbiguity as
    //    /api/text, run against the transcript once it passed basic
    //    validation.
    // ------------------------------------------------------------

    let selectedDescription = selectedWorkItemDescription;
    let confirmedWorkItem = null;
    let userConfirmed = false;
    let resolution: WorkItemAmbiguityResult = { status: "clear" };
    if (!sttFailed && validation.status === "VALID" && selectedWorkItemId) {
      resolution = await resolveWorkItemAmbiguity(
        supabase,
        rawText,
        selectedWorkItemId,
        confirmedWorkItemIdInput,
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

    let relevance = sttFailed
      ? { status: "notChecked" as const }
      : await assessWorkerSubmissionRelevance(supabase, rawText, selectedDescription, selectedWorkItemId);

    if (
      relevance.status === "vague" &&
      userConfirmed &&
      confirmedWorkItem &&
      textMatchesWorkItem(rawText, confirmedWorkItem.description)
    ) {
      relevance = { status: "valid" };
    }

    if (
      resolution.status === "ambiguous" &&
      (relevance.status === "valid" || (relevance.status === "vague" && resolution.selectedInTie))
    ) {
      return NextResponse.json({ ambiguity: { candidates: resolution.candidates } });
    }

    // ------------------------------------------------------------
    // 4. Resolve project / department / work item / worker from the
    //    Construction Automation schema (never hardcoded).
    // ------------------------------------------------------------

    let context;
    try {
      context = await resolveConstructionContext(supabase, rawText);
    } catch (ctxErr) {
      console.error("Failed to resolve construction context:", ctxErr);
      return NextResponse.json(
        { error: "Could not resolve project/work item mapping." },
        { status: 500 }
      );
    }

    // ------------------------------------------------------------
    // 5. Store audio file
    // ------------------------------------------------------------

    const ext = file.type.split("/")[1]?.replace(";codecs=opus", "") || "bin";
    const path = `${randomUUID()}.${ext}`;

    const { error: uploadError } = await supabase.storage
      .from(STORAGE_BUCKETS.VOICE)
      .upload(path, buffer, {
        contentType: file.type,
        upsert: true,
      });

    if (uploadError) {
      console.error("Storage upload failed:", uploadError);
      return NextResponse.json(
        { error: `Storage upload failed: ${uploadError.message}` },
        { status: 500 }
      );
    }

    // ------------------------------------------------------------
    // 6. Save into extraction_submissions
    // ------------------------------------------------------------

    const { data: submission, error: insertError } = await supabase
      .from("extraction_submissions")
      .insert({
        project_id: context.projectId,
        department_id: context.departmentId,
        work_item_id: context.workItemId,
        worker_id: context.workerId,

        input_type: "VOICE",
        storage_path: path,
        raw_input_text: sttFailed ? null : rawText,

        provider: "AssemblyAI",
        processing_type: "STT",

        raw_output: sttFailed ? null : rawText,
        normalized_output: sttFailed ? null : normalized,
        confidence_score: confidence,

        processing_status: sttFailed ? "FAILED" : "COMPLETED",
        processing_error: sttFailed ? sttResult.error : null,
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
    // 7. Return response
    // ------------------------------------------------------------

    if (sttFailed) {
      return NextResponse.json({ error: sttResult.error }, { status: 503 });
    }

    return NextResponse.json({
      submissionId: submission.extraction_submission_id,
      rawText,
      normalizedText: normalized,
      confidence,
      status: validation.status,
      reason: validation.reason,
      workItem: {
        code: context.workItemCode,
        description: context.workItemDescription,
      },
      relevance,
      confirmedWorkItem,
      task,
    });
  } catch (err) {
    console.error("Voice pipeline error:", err);

    const message = err instanceof Error ? err.message : "Processing failed.";

    return NextResponse.json({ error: message }, { status: 500 });
  }
}
