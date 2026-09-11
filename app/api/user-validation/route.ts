import { NextRequest, NextResponse } from "next/server";
import { getSupabaseClient } from "@/lib/supabase";

export const runtime = "nodejs";

export async function POST(request: NextRequest) {
  const supabase = getSupabaseClient();

  try {
    const body = await request.json();
    const submissionId: unknown = body?.submissionId;
    const decision: unknown = body?.decision;

    if (typeof submissionId !== "string") {
      return NextResponse.json({ error: "No submissionId provided." }, { status: 400 });
    }
    if (decision !== "valid" && decision !== "invalid") {
      return NextResponse.json(
        { error: "decision must be 'valid' or 'invalid'." },
        { status: 400 }
      );
    }

    const { data: submission, error: fetchError } = await supabase
      .from("extraction_submissions")
      .select("validation_status")
      .eq("extraction_submission_id", submissionId)
      .single();
    if (fetchError || !submission) {
      return NextResponse.json({ error: "Submission not found." }, { status: 404 });
    }
    if (submission.validation_status !== "VALID") {
      return NextResponse.json(
        { error: "User validation requires AI validation to be VALID first." },
        { status: 409 }
      );
    }

    const { error: updateError } = await supabase
      .from("extraction_submissions")
      .update({
        submission_status: decision === "valid" ? "ACCEPTED" : "REJECTED",
      })
      .eq("extraction_submission_id", submissionId);
    if (updateError) {
      throw new Error(updateError.message);
    }

    return NextResponse.json({ submissionId, userValidation: decision });
  } catch (err) {
    console.error("User validation pipeline error:", err);
    const message = err instanceof Error ? err.message : "Update failed.";
    return NextResponse.json({ error: message }, { status: 500 });
  }
}
