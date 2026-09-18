import { randomUUID } from "crypto";
import { NextRequest, NextResponse } from "next/server";
import { getSupabaseClient, STORAGE_BUCKETS } from "@/lib/supabase";
import { runSTT } from "@/lib/stt";
import { normalizeText, validateVoice } from "@/lib/validation";
import { resolveConstructionContext, assessWorkerSubmissionRelevance } from "@/lib/construction";

export const runtime = "nodejs";

const MAX_SIZE_BYTES = 25 * 1024 * 1024; // 25MB

export async function POST(request: NextRequest) {
  const supabase = getSupabaseClient();

  try {
    const formData = await request.formData();
    const file = formData.get("audio");
    // Same optional work-item-relevance check as /api/text — see its
    // doc comment.
    const selectedWorkItemDescriptionRaw = formData.get("workItemDescription");
    const selectedWorkItemDescription =
      typeof selectedWorkItemDescriptionRaw === "string" ? selectedWorkItemDescriptionRaw : null;

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
    // 2. Resolve project / department / work item / worker from the
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
    // 3. Store audio file
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
    // 4. Save into extraction_submissions
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
    // 5. Return response
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
      // Same relevance check as /api/text, applied to the transcript.
      relevance: await assessWorkerSubmissionRelevance(supabase, rawText, selectedWorkItemDescription),
    });
  } catch (err) {
    console.error("Voice pipeline error:", err);

    const message = err instanceof Error ? err.message : "Processing failed.";

    return NextResponse.json({ error: message }, { status: 500 });
  }
}
