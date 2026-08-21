import { NextRequest, NextResponse } from "next/server";
import { getSupabaseClient, STORAGE_BUCKETS } from "@/lib/supabase";
import { runSTT } from "@/lib/stt";
import { normalizeText, validateVoice } from "@/lib/validation";

export const runtime = "nodejs";

const MAX_SIZE_BYTES = 25 * 1024 * 1024; // 25MB

export async function POST(request: NextRequest) {
  const supabase = getSupabaseClient();

  try {
    const formData = await request.formData();
    const file = formData.get("audio");

    if (!file || !(file instanceof File)) {
      return NextResponse.json({ error: "No audio file provided." }, { status: 400 });
    }
    if (!file.type.startsWith("audio/") && file.type !== "video/webm") {
      return NextResponse.json(
        { error: `Unsupported audio type: ${file.type || "unknown"}.` },
        { status: 400 }
      );
    }
    if (file.size > MAX_SIZE_BYTES) {
      return NextResponse.json({ error: "Audio exceeds the 25MB limit." }, { status: 400 });
    }

    const arrayBuffer = await file.arrayBuffer();
    const buffer = Buffer.from(arrayBuffer);

    const { data: submission, error: insertError } = await supabase
      .from("submissions")
      .insert({ input_type: "VOICE", status: "PROCESSING" })
      .select()
      .single();
    if (insertError || !submission) {
      throw new Error(insertError?.message ?? "Failed to create submission.");
    }

    const ext = file.type.split("/")[1]?.replace(";codecs=opus", "") || "bin";
    const path = `${submission.id}.${ext}`;
    const { error: uploadError } = await supabase.storage
      .from(STORAGE_BUCKETS.VOICE)
      .upload(path, buffer, { contentType: file.type, upsert: true });
    if (uploadError) {
      await supabase.from("submissions").update({ status: "INVALID" }).eq("id", submission.id);
      throw new Error(`Storage upload failed: ${uploadError.message}`);
    }
    await supabase.from("submissions").update({ raw_file_path: path }).eq("id", submission.id);

    const sttResult = await runSTT(buffer);
    if ("error" in sttResult) {
      await supabase.from("submissions").update({ status: "INVALID" }).eq("id", submission.id);
      return NextResponse.json({ error: sttResult.error }, { status: 503 });
    }

    const normalized = normalizeText(sttResult.rawText);
    const validation = validateVoice(sttResult.rawText, sttResult.confidence);

    await supabase.from("extracted_results").insert({
      submission_id: submission.id,
      raw_extracted_text: sttResult.rawText,
      normalized_text: normalized,
      confidence: sttResult.confidence,
      validation_reason: validation.reason,
    });
    await supabase
      .from("submissions")
      .update({ status: validation.status })
      .eq("id", submission.id);

    return NextResponse.json({
      submissionId: submission.id,
      rawText: sttResult.rawText,
      normalizedText: normalized,
      confidence: sttResult.confidence,
      status: validation.status,
      reason: validation.reason,
    });
  } catch (err) {
    console.error("Voice pipeline error:", err);
    const message = err instanceof Error ? err.message : "Processing failed.";
    return NextResponse.json({ error: message }, { status: 500 });
  }
}
