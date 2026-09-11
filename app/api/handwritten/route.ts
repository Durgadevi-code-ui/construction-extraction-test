import { randomUUID } from "crypto";
import { NextRequest, NextResponse } from "next/server";
import { getSupabaseClient, STORAGE_BUCKETS } from "@/lib/supabase";
import { runOCR } from "@/lib/ocr";
import { normalizeText, validateHandwritten } from "@/lib/validation";
import { resolveConstructionContext } from "@/lib/construction";

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
    // ------------------------------------------------------------

    const ocrResult = await runOCR(buffer, file.type);
    const ocrFailed = "error" in ocrResult;

    const rawText = ocrFailed ? "" : ocrResult.rawText;
    const confidence = ocrFailed ? null : ocrResult.confidence;
    const normalized = ocrFailed ? "" : normalizeText(rawText);

    const validation = ocrFailed
      ? { status: "INVALID" as const, reason: ocrResult.error }
      : validateHandwritten(ocrResult.rawText, ocrResult.confidence);

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
    // 5. Upload image to Supabase Storage
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
    // 6. Save into extraction_submissions
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

    if (ocrFailed) {
      return NextResponse.json({ error: ocrResult.error }, { status: 503 });
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
    });
  } catch (err) {
    console.error("Handwritten pipeline error:", err);

    const message = err instanceof Error ? err.message : "Processing failed.";

    return NextResponse.json({ error: message }, { status: 500 });
  }
}
