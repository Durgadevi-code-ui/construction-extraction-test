import "server-only";
import { ApiError, GoogleGenAI } from "@google/genai";

/**
 * OCR provider abstraction.
 *
 * runOCR() is what callers use. It always calls the PRIMARY provider
 * (Gemini Vision). The other function is a documented backup
 * interface — same shape, not wired in as automatic fallback, so
 * adding a real fallback later is a one-line change in runOCR() and
 * never touches the UI or database code.
 */

export type OCRResult = {
  rawText: string;
  confidence: number | null;
  provider: string;
};

export type OCRError = {
  error: string;
};

/**
 * Google periodically retires specific Gemini model snapshots for new
 * API keys well before the model is fully shut down (this is what
 * produced the "no longer available to new users" 404 on
 * gemini-2.5-flash). GEMINI_VISION_MODEL lets the model be swapped via
 * env var — no code change or redeploy of logic — the next time that
 * happens; the default here is the current GA multimodal model.
 */
const DEFAULT_VISION_MODEL = "gemini-3.6-flash";
const VISION_MODEL = process.env.GEMINI_VISION_MODEL?.trim() || DEFAULT_VISION_MODEL;

const EXTRACTION_PROMPT = `
You are extracting text from a construction site note, which may be handwritten or printed.

Rules:
- Extract exactly what is written.
- Do not summarize.
- Do not guess unreadable words.
- Do not invent numbers or quantities.
- If a word is unclear, write [unclear].
- If nothing is readable, return exactly: UNREADABLE

After the extracted text, add a final line in this exact format:
CONFIDENCE: 0.xx
`.trim();

/** Full diagnostics to the server console only — never sent to the client. */
function logProviderError(context: {
  model: string;
  mimeType: string;
  bufferSize: number;
  error: unknown;
}): void {
  const { model, mimeType, bufferSize, error } = context;
  console.error("================ GEMINI OCR ERROR ================");
  console.error("Model:", model);
  console.error("Mime type:", mimeType);
  console.error("Buffer size:", bufferSize);
  if (error instanceof ApiError) {
    console.error("Status:", error.status);
    console.error("Message:", error.message);
  } else if (error instanceof Error) {
    console.error("Message:", error.message);
    console.error("Stack:", error.stack);
  } else {
    console.error("Error:", error);
  }
  console.error("==================================================");
}

/** Maps any thrown error to a short, safe message fit to return to the client. */
function toCleanErrorMessage(error: unknown): string {
  if (error instanceof ApiError) {
    switch (error.status) {
      case 400:
        return "OCR request was rejected as invalid.";
      case 401:
      case 403:
        return "OCR provider authentication failed.";
      case 404:
        return "OCR model is currently unavailable.";
      case 429:
        return "OCR provider rate limit reached. Please try again shortly.";
      default:
        return error.status >= 500
          ? "OCR provider is temporarily unavailable. Please try again."
          : "OCR extraction failed. Please try again.";
    }
  }
  return "OCR extraction failed. Please try again.";
}

/** PRIMARY: Gemini Vision. */
async function geminiVisionOCR(
  fileBuffer: Buffer,
  mimeType: string
): Promise<OCRResult> {
  const apiKey = process.env.GEMINI_API_KEY;

  if (!apiKey) {
    throw new ProviderNotConfiguredError("OCR provider not configured.");
  }
  if (!mimeType.startsWith("image/")) {
    throw new Error(`Unsupported mime type: ${mimeType}`);
  }
  if (fileBuffer.length === 0) {
    throw new Error("Empty image buffer.");
  }

  const ai = new GoogleGenAI({ apiKey });

  try {
    const response = await ai.models.generateContent({
      model: VISION_MODEL,
      contents: [
        {
          role: "user",
          parts: [
            { text: EXTRACTION_PROMPT },
            { inlineData: { mimeType, data: fileBuffer.toString("base64") } },
          ],
        },
      ],
    });

    const text = response.text;
    if (!text || !text.trim()) {
      throw new Error("Gemini returned an empty response.");
    }

    return parseTextAndConfidence(text, "gemini_vision");
  } catch (error) {
    logProviderError({ model: VISION_MODEL, mimeType, bufferSize: fileBuffer.length, error });
    throw new Error(toCleanErrorMessage(error));
  }
}

/**
 * BACKUP (documented interface only — not called by runOCR() yet).
 * Signature matches geminiVisionOCR so wiring in a real fallback later
 * is a one-line change.
 */
async function azureDocumentIntelligenceOCR(
  fileBuffer: Buffer,
  mimeType: string
): Promise<OCRResult> {
  void fileBuffer;
  void mimeType;
  throw new Error(
    "Azure Document Intelligence OCR backup is not implemented yet. Interface reserved for future fallback wiring."
  );
}

export class ProviderNotConfiguredError extends Error {}

/** Shared helper: parses the "...text...\nCONFIDENCE: 0.xx" convention. */
function parseTextAndConfidence(raw: string, provider: string): OCRResult {
  const match = raw.match(/CONFIDENCE:\s*([0-9.]+)\s*$/i);
  const confidence = match ? Math.min(1, Math.max(0, parseFloat(match[1]))) : null;
  const text = match ? raw.slice(0, match.index).trim() : raw.trim();
  return { rawText: text, confidence, provider };
}

/**
 * Entry point used by the API route. Swallows provider-not-configured
 * into a clean user-facing message instead of throwing/crashing. By
 * the time an error reaches here it has already been logged in full
 * and reduced to a safe message in geminiVisionOCR(), so this is a
 * plain relay — it never forwards a raw provider error to the client.
 */
export async function runOCR(
  fileBuffer: Buffer,
  mimeType: string
): Promise<OCRResult | OCRError> {
  try {
    return await geminiVisionOCR(fileBuffer, mimeType);
  } catch (err) {
    if (err instanceof ProviderNotConfiguredError) {
      return { error: "OCR provider not configured." };
    }
    const message = err instanceof Error ? err.message : "OCR extraction failed. Please try again.";
    return { error: message };
  }
}

// Referenced so the backup interface is exercised by TypeScript (kept
// intentionally unused otherwise) and documented for future wiring.
void azureDocumentIntelligenceOCR;
