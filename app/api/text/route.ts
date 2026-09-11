import { NextRequest, NextResponse } from "next/server";
import { getSupabaseClient } from "@/lib/supabase";
import { normalizeText, validateTypedText } from "@/lib/validation";
import { resolveConstructionContext } from "@/lib/construction";

export const runtime = "nodejs";

export async function POST(request: NextRequest) {
  const supabase = getSupabaseClient();

  try {
    const body = await request.json();
    const originalText: unknown = body?.text;

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
    });
  } catch (err) {
    console.error("Text pipeline error:", err);

    const message = err instanceof Error ? err.message : "Processing failed.";

    return NextResponse.json({ error: message }, { status: 500 });
  }
}
