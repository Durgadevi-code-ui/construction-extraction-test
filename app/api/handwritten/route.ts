import { randomUUID } from "crypto";
import { NextRequest, NextResponse } from "next/server";
import { getSupabaseClient, STORAGE_BUCKETS } from "@/lib/supabase";
import { runOCR } from "@/lib/ocr";
import { normalizeText, validateHandwritten } from "@/lib/validation";
import { resolveConstructionContext, assessImageSubmissionRelevance, imageRelevanceRejection } from "@/lib/construction";

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
    // Same optional work-item-relevance check as /api/text — see its
    // doc comment. A form field, not JSON, since this route already
    // reads multipart formData for the image itself.
    const selectedWorkItemDescriptionRaw = formData.get("workItemDescription");
    const selectedWorkItemDescription =
      typeof selectedWorkItemDescriptionRaw === "string" ? selectedWorkItemDescriptionRaw : null;

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
    // 3. Department relevance — looks at the actual physical
    //    construction work shown in the photo (Gemini Vision, a
    //    different prompt from runOCR's "read the note text" one —
    //    see lib/construction.ts assessImageSubmissionRelevance /
    //    lib/ocr.ts classifyConstructionImageDepartment). Runs BEFORE
    //    OCR, storage upload, and the extraction_submissions insert —
    //    a wrong-department, too-unclear, or classifier/provider-
    //    failure image must never be persisted or processed further
    //    (same shared imageRelevanceRejection helper and behavior as
    //    app/api/workflow/live-updates/route.ts's Live Update photo
    //    flow). A "notChecked" result (no real Worker session, e.g.
    //    the standalone Extraction Accuracy Test tool) falls through
    //    to the normal flow below, unchanged.
    // ------------------------------------------------------------

    const { relevance, visionChecked, ownDepartmentName } = await assessImageSubmissionRelevance(
      supabase,
      buffer,
      file.type,
      selectedWorkItemDescription
    );
    const rejection = imageRelevanceRejection(relevance, ownDepartmentName);
    if (rejection) {
      return NextResponse.json({ error: rejection.error }, { status: rejection.status });
    }

    // ------------------------------------------------------------
    // 4. Run OCR
    // ------------------------------------------------------------

    const ocrResult = await runOCR(buffer, file.type);
    const ocrFailed = "error" in ocrResult;

    const rawText = ocrFailed ? "" : ocrResult.rawText;
    const confidence = ocrFailed ? null : ocrResult.confidence;
    const normalized = ocrFailed ? "" : normalizeText(rawText);

    const ocrValidation = ocrFailed
      ? { status: "INVALID" as const, reason: ocrResult.error }
      : validateHandwritten(ocrResult.rawText, ocrResult.confidence);

    // The image was usefully processed if EITHER signal succeeded: OCR
    // found real note text, or the vision model rendered a verdict on
    // the photo's physical content (department match, or a genuine
    // "vague"/"notChecked" — anything that reached this point already
    // passed imageRelevanceRejection above, so it's never a rejection
    // reaching here). Only when neither worked at all is this
    // genuinely "extraction failed."
    const status: "VALID" | "INVALID" = ocrValidation.status === "VALID" || visionChecked ? "VALID" : "INVALID";
    const reason =
      ocrValidation.status === "VALID" ? ocrValidation.reason : visionChecked ? "Image analyzed." : ocrValidation.reason;

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

        // Reflects the COMBINED (OCR or vision) outcome, not OCR alone
        // — a real construction photo with no note text on it, whose
        // physical content the vision check successfully classified,
        // is genuinely "processed", not "failed".
        processing_status: ocrFailed && !visionChecked ? "FAILED" : "COMPLETED",
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

    // Only a genuine provider/infra failure with NO usable signal at
    // all (OCR errored AND the vision check couldn't run either) is a
    // hard failure — otherwise (e.g. OCR found nothing but vision
    // successfully classified the photo) this falls through to the
    // normal 200 response below with status/relevance reflecting
    // whichever signal actually worked.
    if (ocrFailed && !visionChecked) {
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
      // The VISUAL department/work-item check (see
      // assessImageSubmissionRelevance above) — looks at the photo's
      // actual physical content, not just any note text OCR'd off it.
      relevance,
    });
  } catch (err) {
    console.error("Handwritten pipeline error:", err);

    const message = err instanceof Error ? err.message : "Processing failed.";

    return NextResponse.json({ error: message }, { status: 500 });
  }
}
