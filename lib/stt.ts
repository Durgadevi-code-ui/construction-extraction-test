import "server-only";
import { ProviderNotConfiguredError } from "./ocr";

/**
 * Speech-to-text provider abstraction — same pattern as lib/ocr.ts.
 * runSTT() calls the PRIMARY provider (AssemblyAI). Backup interfaces
 * are reserved, not wired in, so swapping/adding a fallback later
 * doesn't touch the UI or database code.
 */

export type STTResult = {
  rawText: string;
  confidence: number | null;
  provider: string;
};

export type STTError = { error: string };

const ASSEMBLYAI_BASE = "https://api.assemblyai.com/v2";
const POLL_INTERVAL_MS = 1500;
const POLL_TIMEOUT_MS = 45_000;

/**
 * PRIMARY: AssemblyAI. Prioritizes accuracy on noisy real-world audio
 * and reports a confidence score — required so low-confidence
 * transcripts can be marked INVALID instead of guessed at.
 */
async function assemblyAISTT(fileBuffer: Buffer): Promise<STTResult> {
  const apiKey = process.env.ASSEMBLYAI_API_KEY;
  if (!apiKey) {
    throw new ProviderNotConfiguredError("Speech-to-text provider not configured.");
  }

  // 1. Upload the audio bytes.
  const uploadRes = await fetch(`${ASSEMBLYAI_BASE}/upload`, {
    method: "POST",
    headers: { authorization: apiKey },
    body: new Uint8Array(fileBuffer),
  });
  if (!uploadRes.ok) {
    throw new Error(`AssemblyAI upload failed: ${uploadRes.status}`);
  }
  const { upload_url: uploadUrl } = await uploadRes.json();

  // 2. Request a transcript. This app only ever records/uploads English
  // construction-site speech, so the language is pinned explicitly —
  // without this, AssemblyAI's automatic language detection can guess
  // wrong on accented English and return the transcript in a script
  // like Devanagari instead of English.
  const transcriptRes = await fetch(`${ASSEMBLYAI_BASE}/transcript`, {
    method: "POST",
    headers: { authorization: apiKey, "content-type": "application/json" },
    body: JSON.stringify({
      audio_url: uploadUrl,
      language_code: "en",
      language_detection: false,
    }),
  });
  if (!transcriptRes.ok) {
    throw new Error(`AssemblyAI transcript request failed: ${transcriptRes.status}`);
  }
  const { id } = await transcriptRes.json();

  // 3. Poll until done.
  const startedAt = Date.now();
  while (Date.now() - startedAt < POLL_TIMEOUT_MS) {
    await new Promise((r) => setTimeout(r, POLL_INTERVAL_MS));
    const pollRes = await fetch(`${ASSEMBLYAI_BASE}/transcript/${id}`, {
      headers: { authorization: apiKey },
    });
    const data = await pollRes.json();

    if (data.status === "completed") {
      return {
        rawText: (data.text ?? "").trim(),
        confidence: typeof data.confidence === "number" ? data.confidence : null,
        provider: "assemblyai",
      };
    }
    if (data.status === "error") {
      throw new Error(`AssemblyAI transcription error: ${data.error}`);
    }
    // else: status is "queued" or "processing" — keep polling
  }

  throw new Error("AssemblyAI transcription timed out.");
}

/**
 * BACKUP (documented interface only — not called by runSTT() yet).
 * Signature matches assemblyAISTT so wiring in a real fallback later
 * is a one-line change.
 */
async function deepgramSTT(fileBuffer: Buffer): Promise<STTResult> {
  void fileBuffer;
  throw new Error(
    "Deepgram STT backup is not implemented yet. Interface reserved for future fallback wiring."
  );
}

/** BACKUP (documented interface only — not called by runSTT() yet). */
async function googleSTT(fileBuffer: Buffer): Promise<STTResult> {
  void fileBuffer;
  throw new Error(
    "Google Speech-to-Text backup is not implemented yet. Interface reserved for future fallback wiring."
  );
}

export async function runSTT(fileBuffer: Buffer): Promise<STTResult | STTError> {
  try {
    return await assemblyAISTT(fileBuffer);
  } catch (err) {
    if (err instanceof ProviderNotConfiguredError) {
      return { error: "Speech-to-text provider not configured." };
    }
    console.error("STT provider error:", err);
    return { error: "Speech-to-text extraction failed. Please try again." };
  }
}

void deepgramSTT;
void googleSTT;
