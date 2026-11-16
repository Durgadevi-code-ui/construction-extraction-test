import { NextRequest, NextResponse } from "next/server";
import { jsonError } from "@/lib/apiErrors";
import { getSupabaseClient } from "@/lib/supabase";
import { getCurrentUser } from "@/lib/session";
import { verifyReviewToken } from "@/lib/submissionReviewToken";

export const runtime = "nodejs";

/** The only submission_status values the extraction pipeline
 * (/api/text|voice|handwritten) ever writes, or this route sets. A real
 * Worker progress submission is 'SUBMITTED' (lib/workflow.ts
 * submitWorkerProgress) and must never be accepted/rejected from here —
 * that would pull it out of the Subcontractor's review queue. */
const PIPELINE_STATUSES = ["PENDING_REVIEW", "ACCEPTED", "REJECTED"];

/**
 * The submitter's own accept/reject of an AI-validated extraction
 * (components/TextInput|VoiceUpload|HandwritingUpload "Confirm"). Only
 * the signed-in user who created the submission may decide it: the
 * request must carry the reviewToken /api/text|voice|handwritten issued
 * for that submission to THIS session's user (lib/submissionReviewToken.ts)
 * — knowing the submission id is not enough.
 */
export async function POST(request: NextRequest) {
  const currentUser = await getCurrentUser();
  if (!currentUser) {
    return NextResponse.json({ error: "Not authenticated." }, { status: 401 });
  }

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
    if (!verifyReviewToken(body?.reviewToken, submissionId, currentUser.userId)) {
      return NextResponse.json(
        { error: "You can only confirm a submission you made in this session. Please submit it again." },
        { status: 403 }
      );
    }

    const { data: submission, error: fetchError } = await supabase
      .from("extraction_submissions")
      .select("validation_status, submission_status")
      .eq("extraction_submission_id", submissionId)
      .in("submission_status", PIPELINE_STATUSES)
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

    // One decision per submission (the review token stays valid for a
    // day, so it must not be replayable to flip an accepted submission to
    // rejected or back). Repeating the same decision — a double-click or
    // a network retry — is a no-op success; a different one is refused.
    const target = decision === "valid" ? "ACCEPTED" : "REJECTED";
    if (submission.submission_status === target) {
      return NextResponse.json({ submissionId, userValidation: decision });
    }
    if (submission.submission_status !== "PENDING_REVIEW") {
      return NextResponse.json({ error: "This submission has already been decided." }, { status: 409 });
    }

    const { data: updated, error: updateError } = await supabase
      .from("extraction_submissions")
      .update({ submission_status: target })
      .eq("extraction_submission_id", submissionId)
      .eq("submission_status", "PENDING_REVIEW")
      .select("extraction_submission_id");
    if (updateError) {
      throw new Error(updateError.message);
    }
    if (!updated || updated.length === 0) {
      // Decided concurrently by another request between the read and here.
      return NextResponse.json({ error: "This submission has already been decided." }, { status: 409 });
    }

    return NextResponse.json({ submissionId, userValidation: decision });
  } catch (err) {
    console.error("User validation pipeline error:", err);
    const message = err instanceof Error ? err.message : "Update failed.";
    return jsonError(message, 500);
  }
}
