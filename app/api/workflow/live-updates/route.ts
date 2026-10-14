import { randomUUID } from "crypto";
import { NextRequest, NextResponse } from "next/server";
import { jsonError } from "@/lib/apiErrors";
import { getSupabaseServiceRoleClient } from "@/lib/supabaseAdmin";
import { getCurrentUser } from "@/lib/session";
import { RATE_LIMITS, rateLimitResponse } from "@/lib/rateLimit";
import { getUserContext } from "@/lib/workflow";
import {
  createLiveUpdate,
  listLiveUpdatesForReviewer,
  listLiveUpdatesForWorker,
  type LiveUpdateType,
} from "@/lib/liveUpdates";
import { detectImageKind, looksLikeAudio, storageExtension } from "@/lib/fileSignature";
import { MAX_CAPTION_LENGTH, tooLongError } from "@/lib/inputLimits";

/**
 * Review / Live Update evidence — entirely separate endpoint from the
 * real extraction pipeline (app/api/text|handwritten|voice/route.ts) and
 * from the progress workflow (app/api/workflow/worker|foreman|supervisor).
 * A POST here never touches extraction_submissions/OCR/STT/validation/
 * progress calculations; a GET here never appears in any approval queue.
 * See lib/liveUpdates.ts.
 *
 * Uses the SERVICE-ROLE client (lib/supabaseAdmin.ts), not the plain
 * anon client every other route in this app still uses (lib/supabase.ts)
 * — see supabase/migrations/00000000000014_live_updates_service_role_only.sql
 * for why: the live_updates table and its storage bucket have no
 * anon-reachable RLS/storage policy at all, so this route (and the
 * getCurrentUser()-verified session check below, which runs first, same
 * as every other workflow route) is the ONLY path to this data — a
 * caller holding just the public anon key cannot reach it directly.
 */

export const runtime = "nodejs";

const BUCKET = "live-updates";
const PHOTO_TYPES = ["image/png", "image/jpeg", "image/webp", "image/heic"];
const MAX_PHOTO_BYTES = 10 * 1024 * 1024;
const MAX_AUDIO_BYTES = 25 * 1024 * 1024;

function errorStatus(message: string): number {
  return message.includes("not authorized") ||
    message.includes("does not belong") ||
    // getUserContext (lib/authContext.ts) throws this exact message for
    // any authenticated caller with no active user_project_roles row —
    // an Admin (bootstrap admins never get one; see isAdminUser's doc)
    // or a deactivated Worker/Foreman/Contractor. Neither is authorized
    // to use Live Updates (see listLiveUpdatesForReviewer/
    // listLiveUpdatesForWorker in lib/liveUpdates.ts, which both require
    // a real Worker/Foreman/Contractor role), so this maps to 403 here —
    // a localized fix, since getUserContext itself is shared by the rest
    // of the app and must keep throwing this way for everything else
    // that calls it.
    message.includes("No active project/department assignment")
    ? 403
    : 500;
}

export async function GET(request: NextRequest) {
  const currentUser = await getCurrentUser();
  if (!currentUser) {
    return NextResponse.json({ error: "Not authenticated." }, { status: 401 });
  }

  const supabase = getSupabaseServiceRoleClient();

  try {
    // Optional ?projectId= — the reviewer page's current project context;
    // only ever selects among the caller's own Active roles.
    // ?departmentId= narrows within that project the same way (a user
    // holding several departments there).
    const projectId = request.nextUrl.searchParams.get("projectId") || undefined;
    const departmentId = request.nextUrl.searchParams.get("departmentId") || undefined;
    const ctx = await getUserContext(supabase, currentUser.userId, projectId ? { projectId, departmentId } : undefined);
    const updates =
      ctx.role === "WORKER"
        ? await listLiveUpdatesForWorker(supabase, currentUser.userId, {
            projectId: ctx.projectId,
            departmentId: ctx.departmentId,
          })
        : await listLiveUpdatesForReviewer(supabase, currentUser.userId, ctx.projectId, ctx.departmentId);

    return NextResponse.json({ updates });
  } catch (err) {
    const message = err instanceof Error ? err.message : "Failed to load live updates.";
    return jsonError(message, errorStatus(message));
  }
}

export async function POST(request: NextRequest) {
  const currentUser = await getCurrentUser();
  if (!currentUser) {
    return NextResponse.json({ error: "Not authenticated." }, { status: 401 });
  }
  const limited = await rateLimitResponse(RATE_LIMITS.liveUpdateUpload, currentUser.userId);
  if (limited) return limited;

  const supabase = getSupabaseServiceRoleClient();

  try {
    const formData = await request.formData();
    const file = formData.get("file");
    const type = formData.get("type");
    const workItemId = formData.get("workItemId");
    const caption = formData.get("caption");

    if (!file || !(file instanceof File)) {
      return NextResponse.json({ error: "No file provided." }, { status: 400 });
    }
    if (type !== "PHOTO" && type !== "VOICE") {
      return NextResponse.json({ error: "Invalid update type." }, { status: 400 });
    }
    const captionError = tooLongError(caption, MAX_CAPTION_LENGTH, "Caption");
    if (captionError) {
      return NextResponse.json({ error: captionError }, { status: 400 });
    }

    if (type === "PHOTO") {
      if (!PHOTO_TYPES.includes(file.type)) {
        return NextResponse.json(
          { error: `Unsupported image type: ${file.type || "unknown"}.` },
          { status: 400 }
        );
      }
      if (file.size > MAX_PHOTO_BYTES) {
        return NextResponse.json({ error: "Image exceeds the 10MB limit." }, { status: 400 });
      }
    } else {
      if (!file.type.startsWith("audio/") && file.type !== "video/webm") {
        return NextResponse.json(
          { error: `Unsupported audio type: ${file.type || "unknown"}.` },
          { status: 400 }
        );
      }
      if (file.size > MAX_AUDIO_BYTES) {
        return NextResponse.json({ error: "Audio exceeds the 25MB limit." }, { status: 400 });
      }
    }

    const arrayBuffer = await file.arrayBuffer();
    const buffer = Buffer.from(arrayBuffer);

    // The declared type above is browser-supplied; check the actual bytes
    // before anything is stored.
    if (type === "PHOTO" ? !detectImageKind(buffer) : !looksLikeAudio(buffer)) {
      return NextResponse.json(
        {
          error:
            type === "PHOTO"
              ? "This file is not a valid PNG, JPEG, WebP or HEIC image."
              : "This file is not a supported audio recording.",
        },
        { status: 400 }
      );
    }

    // No department classification runs against a Live Update photo —
    // department-based image blocking was intentionally removed. Any
    // relevant construction/site photo is accepted; department/context
    // validation continues to apply only to Live Update TEXT/VOICE
    // captions where already implemented, untouched by this change.

    const ext = storageExtension(file.type);
    // Prefixed by the uploader's own user id — never another user's, and
    // never derived from anything the client sends — so files are at
    // least self-organized per worker within the bucket even though the
    // authorization boundary is enforced by createLiveUpdate below, not
    // by storage path structure.
    const path = `${currentUser.userId}/${randomUUID()}.${ext}`;

    const { error: uploadError } = await supabase.storage.from(BUCKET).upload(path, buffer, {
      contentType: file.type,
      upsert: false,
    });

    if (uploadError) {
      return jsonError("Failed to upload the file: " + uploadError.message, 500);
    }

    // createLiveUpdate is where the Worker role / work item assignment is
    // checked — if it refuses, don't leave the just-uploaded file behind
    // with no row pointing at it.
    try {
      await createLiveUpdate(supabase, {
        workerId: currentUser.userId,
        workItemId: typeof workItemId === "string" && workItemId ? workItemId : null,
        updateType: type as LiveUpdateType,
        storagePath: path,
        caption: typeof caption === "string" ? caption : null,
      });
    } catch (err) {
      await supabase.storage.from(BUCKET).remove([path]).catch(() => undefined);
      throw err;
    }

    return NextResponse.json({ ok: true });
  } catch (err) {
    const message = err instanceof Error ? err.message : "Failed to save live update.";
    return jsonError(message, errorStatus(message));
  }
}
