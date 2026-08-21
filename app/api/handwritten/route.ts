import { NextRequest, NextResponse } from "next/server";
import { getSupabaseClient, STORAGE_BUCKETS } from "@/lib/supabase";
import { runOCR } from "@/lib/ocr";
import { normalizeText, validateHandwritten } from "@/lib/validation";

export const runtime = "nodejs";

const ALLOWED_TYPES = ["image/png", "image/jpeg", "image/webp", "image/heic"];
const MAX_SIZE_BYTES = 10 * 1024 * 1024; // 10MB

export async function POST(request: NextRequest) {
  const supabase = getSupabaseClient();

  try {
    const formData = await request.formData();
    const file = formData.get("image");

    if (!file || !(file instanceof File)) {
      return NextResponse.json({ error: "No image file provided." }, { status: 400 });
    }
    if (!ALLOWED_TYPES.includes(file.type)) {
      return NextResponse.json(
        { error: `Unsupported image type: ${file.type || "unknown"}.` },
        { status: 400 }
      );
    }
    if (file.size > MAX_SIZE_BYTES) {
      return NextResponse.json({ error: "Image exceeds the 10MB limit." }, { status: 400 });
    }

    const arrayBuffer = await file.arrayBuffer();
    const buffer = Buffer.from(arrayBuffer);

    // 1. Create the submission row (PROCESSING) before any provider call.
    const { data: submission, error: insertError } = await supabase
      .from("submissions")
      .insert({ input_type: "HANDWRITTEN", status: "PROCESSING" })
      .select()
      .single();
    if (insertError || !submission) {
      throw new Error(insertError?.message ?? "Failed to create submission.");
    }

    // 2. Store the raw image in Supabase Storage under handwritten/.
    const path = `${submission.id}.${file.type.split("/")[1] || "bin"}`;
    const { error: uploadError } = await supabase.storage
      .from(STORAGE_BUCKETS.HANDWRITTEN)
      .upload(path, buffer, { contentType: file.type, upsert: true });
    if (uploadError) {
      await supabase
        .from("submissions")
        .update({ status: "INVALID" })
        .eq("id", submission.id);
      throw new Error(`Storage upload failed: ${uploadError.message}`);
    }
    await supabase.from("submissions").update({ raw_file_path: path }).eq("id", submission.id);

    // 3. Run OCR.
    const ocrResult = await runOCR(buffer, file.type);
    if ("error" in ocrResult) {
      await supabase.from("submissions").update({ status: "INVALID" }).eq("id", submission.id);
      return NextResponse.json({ error: ocrResult.error }, { status: 503 });
    }

    // 4. Normalize + validate.
    const normalized = normalizeText(ocrResult.rawText);
    const validation = validateHandwritten(ocrResult.rawText, ocrResult.confidence);

    // 5. Persist extracted_results and final submission status.
    await supabase.from("extracted_results").insert({
      submission_id: submission.id,
      raw_extracted_text: ocrResult.rawText,
      normalized_text: normalized,
      confidence: ocrResult.confidence,
      validation_reason: validation.reason,
    });
    await supabase
      .from("submissions")
      .update({ status: validation.status })
      .eq("id", submission.id);

    return NextResponse.json({
      submissionId: submission.id,
      rawText: ocrResult.rawText,
      normalizedText: normalized,
      confidence: ocrResult.confidence,
      status: validation.status,
      reason: validation.reason,
    });
  } catch (err) {
    console.error("Handwritten pipeline error:", err);
    const message = err instanceof Error ? err.message : "Processing failed.";
    return NextResponse.json({ error: message }, { status: 500 });
  }
}
