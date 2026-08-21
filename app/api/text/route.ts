import { NextRequest, NextResponse } from "next/server";
import { getSupabaseClient } from "@/lib/supabase";
import { normalizeText, validateTypedText } from "@/lib/validation";

export const runtime = "nodejs";

export async function POST(request: NextRequest) {
  const supabase = getSupabaseClient();

  try {
    const body = await request.json();
    const originalText: unknown = body?.text;

    if (typeof originalText !== "string") {
      return NextResponse.json({ error: "No text provided." }, { status: 400 });
    }

    const { data: submission, error: insertError } = await supabase
      .from("submissions")
      .insert({ input_type: "TEXT", status: "PROCESSING", original_text: originalText })
      .select()
      .single();
    if (insertError || !submission) {
      throw new Error(insertError?.message ?? "Failed to create submission.");
    }

    // No AI call needed for typed text — deterministic normalization only.
    const normalized = normalizeText(originalText);
    const validation = validateTypedText(originalText);

    await supabase.from("extracted_results").insert({
      submission_id: submission.id,
      raw_extracted_text: originalText,
      normalized_text: normalized,
      confidence: null,
      validation_reason: validation.reason,
    });
    await supabase
      .from("submissions")
      .update({ status: validation.status })
      .eq("id", submission.id);

    return NextResponse.json({
      submissionId: submission.id,
      rawText: originalText,
      normalizedText: normalized,
      confidence: null,
      status: validation.status,
      reason: validation.reason,
    });
  } catch (err) {
    console.error("Text pipeline error:", err);
    const message = err instanceof Error ? err.message : "Processing failed.";
    return NextResponse.json({ error: message }, { status: 500 });
  }
}
