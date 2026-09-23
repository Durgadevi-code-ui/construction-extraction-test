import { randomUUID } from "crypto";
import { NextRequest, NextResponse } from "next/server";
import { getSupabaseClient, STORAGE_BUCKETS } from "@/lib/supabase";
import { runOCR } from "@/lib/ocr";
import { normalizeText, validateHandwritten } from "@/lib/validation";
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

const ALLOWED_TYPES = [
  "image/png",
  "image/jpeg",
  "image/webp",
  "image/heic",
];

const MAX_SIZE_BYTES = 10 * 1024 * 1024; // 10MB

export async function POST(request: NextRequest) {
  const supabase = getSupabaseClient();

  try {
    const formData = await request.formData();
    const file = formData.get("image");
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

    // ------------------------------------------------------------
    // 1. Validate image
    // ------------------------------------------------------------

    if (!file || !(file instanceof File)) {
      return NextResponse.json(
        { error: "No image file provided." },
        { status: 400 }
      );
    }

    if (!ALLOWED_TYPES.includes(file.type)) {
      return NextResponse.json(
        { error: `Unsupported image type: ${file.type || "unknown"}.` },
        { status: 400 }
      );
    }

    if (file.size > MAX_SIZE_BYTES) {
      return NextResponse.json(
        { error: "Image exceeds the 10MB limit." },
        { status: 400 }
      );
    }

    // ------------------------------------------------------------
    // 2. Read image
    // ------------------------------------------------------------

    const arrayBuffer = await file.arrayBuffer();
    const buffer = Buffer.from(arrayBuffer);

    // ------------------------------------------------------------
    // 3. Run OCR
    //
    //    No department classification is run against this image —
    //    department-based image blocking was intentionally removed
    //    (any relevant construction/site photo is allowed; only the
    //    OCR'd note TEXT is validated below, same as before that
    //    check ever existed). Text/voice department relevance is a
    //    separate, unaffected mechanism (see
    //    assessWorkerSubmissionRelevance, used by app/api/text and
    //    app/api/voice).
    // ------------------------------------------------------------

    const ocrResult = await runOCR(buffer, file.type);
    const ocrFailed = "error" in ocrResult;

    const rawText = ocrFailed ? "" : ocrResult.rawText;
    const confidence = ocrFailed ? null : ocrResult.confidence;
    const normalized = ocrFailed ? "" : normalizeText(rawText);

    const ocrValidation = ocrFailed
      ? { status: "INVALID" as const, reason: ocrResult.error }
      : validateHandwritten(ocrResult.rawText, ocrResult.confidence);

    const status = ocrValidation.status;
    const reason = ocrValidation.reason;

    // ------------------------------------------------------------
    // 4. Selected Work Item / Task context, applied to the OCR'd note
    //    TEXT — same shared functions app/api/text and app/api/voice
    //    use (resolveTaskForWorker, detectTaskConflict,
    //    resolveWorkItemAmbiguity, assessWorkerSubmissionRelevance),
    //    never a separate/vision-based system. Deliberately
    //    conservative: only runs when OCR actually found real text to
    //    judge — a plain site photo with no readable note text is
    //    accepted exactly as before (no relevance verdict fabricated
    //    from "nothing was read"), matching "do not blindly reject an
    //    image because it's visually difficult to classify."
    // ------------------------------------------------------------

    const hasOcrText = !ocrFailed && rawText.trim().length > 0 && rawText.trim().toUpperCase() !== "UNREADABLE";

    let task: { id: string; label: string } | null = null;
    if (hasOcrText && taskIdInput && selectedWorkItemId) {
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

    let selectedDescription = selectedWorkItemDescription;
    let confirmedWorkItem = null;
    let userConfirmed = false;
    let resolution: WorkItemAmbiguityResult = { status: "clear" };
    if (hasOcrText && status === "VALID" && selectedWorkItemId) {
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

    let relevance = hasOcrText
      ? await assessWorkerSubmissionRelevance(supabase, rawText, selectedDescription, selectedWorkItemId)
      : ({ status: "notChecked" } as const);

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
    // 5. Resolve project / department / work item / worker from the
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
    // 6. Upload image to Supabase Storage
    // ------------------------------------------------------------

    const path = `${randomUUID()}.${file.type.split("/")[1] || "bin"}`;

    const { error: uploadError } = await supabase.storage
      .from(STORAGE_BUCKETS.HANDWRITTEN)
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
    // 7. Save into extraction_submissions
    // ------------------------------------------------------------

    const { data: submission, error: insertError } = await supabase
      .from("extraction_submissions")
      .insert({
        project_id: context.projectId,
        department_id: context.departmentId,
        work_item_id: context.workItemId,
        worker_id: context.workerId,

        input_type: "HANDWRITTEN",
        storage_path: path,
        raw_input_text: null,

        provider: "Gemini Vision",
        processing_type: "OCR",

        raw_output: ocrFailed ? null : rawText,
        normalized_output: ocrFailed ? null : normalized,
        structured_output: ocrFailed
          ? null
          : { raw_text: rawText, normalized_text: normalized },
        confidence_score: confidence,

        processing_status: ocrFailed ? "FAILED" : "COMPLETED",
        processing_error: ocrFailed ? ocrResult.error : null,
        processed_at: new Date().toISOString(),

        validation_status: status,
        validation_errors: status === "INVALID" ? { reason } : null,
        validated_at: new Date().toISOString(),

        submission_status: status === "VALID" ? "PENDING_REVIEW" : "REJECTED",
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
    // 8. Return response
    // ------------------------------------------------------------

    if (ocrFailed) {
      return NextResponse.json({ error: ocrResult.error }, { status: 503 });
    }

    return NextResponse.json({
      submissionId: submission.extraction_submission_id,
      rawText,
      normalizedText: normalized,
      confidence,
      status,
      reason,
      workItem: {
        code: context.workItemCode,
        description: context.workItemDescription,
      },
      relevance,
      confirmedWorkItem,
      task,
    });
  } catch (err) {
    console.error("Handwritten pipeline error:", err);

    const message = err instanceof Error ? err.message : "Processing failed.";

    return NextResponse.json({ error: message }, { status: 500 });
  }
}
