import "server-only";
import { ApiError, GoogleGenAI } from "@google/genai";

/**
 * OCR provider abstraction.
 *
 * Image → Gemini Vision → Extracted Text
 *
 * Database saving is handled by the API route.
 * This file is responsible only for OCR processing.
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
 * Gemini Vision model.
 *
 * Can be changed from .env.local without changing this code.
 *
 * Example:
 * GEMINI_VISION_MODEL=gemini-3.6-flash
 */
const DEFAULT_VISION_MODEL = "gemini-3.6-flash";

const VISION_MODEL =
  process.env.GEMINI_VISION_MODEL?.trim() ||
  DEFAULT_VISION_MODEL;

/**
 * Prompt used for handwritten construction notes.
 */
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

/**
 * Server-side provider error logging.
 */
function logProviderError(context: {
  model: string;
  mimeType: string;
  bufferSize: number;
  error: unknown;
}): void {
  const {
    model,
    mimeType,
    bufferSize,
    error,
  } = context;

  console.error(
    "================ GEMINI OCR ERROR ================"
  );

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

  console.error(
    "=================================================="
  );
}

/**
 * Converts provider errors into safe messages.
 */
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

/**
 * PRIMARY OCR PROVIDER
 *
 * Image → Gemini Vision → Text
 */
async function geminiVisionOCR(
  fileBuffer: Buffer,
  mimeType: string
): Promise<OCRResult> {

  const apiKey = process.env.GEMINI_API_KEY;

  if (!apiKey) {
    throw new ProviderNotConfiguredError(
      "OCR provider not configured."
    );
  }

  if (!mimeType.startsWith("image/")) {
    throw new Error(
      `Unsupported mime type: ${mimeType}`
    );
  }

  if (fileBuffer.length === 0) {
    throw new Error("Empty image buffer.");
  }

  const ai = new GoogleGenAI({
    apiKey,
  });

  try {
    const response = await ai.models.generateContent({
      model: VISION_MODEL,

      contents: [
        {
          role: "user",

          parts: [
            {
              text: EXTRACTION_PROMPT,
            },

            {
              inlineData: {
                mimeType,
                data: fileBuffer.toString("base64"),
              },
            },
          ],
        },
      ],
    });

    const text = response.text;

    if (!text || !text.trim()) {
      throw new Error(
        "Gemini returned an empty response."
      );
    }

    return parseTextAndConfidence(
      text,
      "gemini_vision"
    );

  } catch (error) {

    logProviderError({
      model: VISION_MODEL,
      mimeType,
      bufferSize: fileBuffer.length,
      error,
    });

    throw new Error(
      toCleanErrorMessage(error)
    );
  }
}

/**
 * A classifier/provider-level failure — network error, auth failure,
 * rate limit/quota exhaustion, model unavailable, etc. Deliberately a
 * DIFFERENT shape from "the model looked at the photo and couldn't
 * confidently tell" (see ImageDepartmentClassification.detectedDepartment
 * === null below): a failure here means the classification never
 * actually happened, so callers must never treat it as an "unclear
 * image" verdict, let alone a department match — see
 * lib/construction.ts assessImageSubmissionRelevance, which maps this
 * to its own "checkFailed" status (a retryable error), distinct from
 * "vague" (a real, completed, inconclusive classification).
 * `category` is safe, coarse-grained metadata for server logs/alerting
 * (never the raw error or any request/response body).
 */
export type ImageClassificationError = {
  error: string;
  category: "not_configured" | "invalid_input" | "auth" | "rate_limit" | "model_unavailable" | "provider_unavailable" | "unknown";
};

function categorizeClassificationError(error: unknown): ImageClassificationError["category"] {
  if (error instanceof ApiError) {
    switch (error.status) {
      case 400:
        return "invalid_input";
      case 401:
      case 403:
        return "auth";
      case 404:
        return "model_unavailable";
      case 429:
        return "rate_limit";
      default:
        return error.status >= 500 ? "provider_unavailable" : "unknown";
    }
  }
  return "unknown";
}

export type ImageDepartmentClassification = {
  /** The exact department name (from the list passed in) the model
   * judged the photo's physical work to belong to — null when the
   * model couldn't confidently tell (unclear/blurry/unrelated photo),
   * NOT an error. Always one of the caller's own department names or
   * null — a model response that doesn't exactly match any given name
   * is treated as null, never passed through as free text (see
   * parseClassification). */
  detectedDepartment: string | null;
  /** null when no work item description was given to compare against,
   * or the model couldn't tell; true/false only when a work item
   * description was passed AND the model took a position on it. */
  workItemRelevant: boolean | null;
  confidence: number | null;
};

/**
 * Prompt used for department classification — deliberately separate
 * from EXTRACTION_PROMPT above (which reads NOTE TEXT off an image, not
 * the physical work shown in it). This is the actual visual check: is
 * the construction work in this photo relevant to a given department,
 * not "is there legible text on it."
 */
function buildClassificationPrompt(departmentNames: string[], selectedWorkItemDescription: string | null): string {
  const departmentList = departmentNames.map((name) => `- ${name}`).join("\n");
  const workItemInstruction = selectedWorkItemDescription
    ? `\nThe worker's currently selected work item is described as: "${selectedWorkItemDescription}". Also judge whether the photo plausibly shows work related to that specific description.`
    : "";

  return `
You are looking at a construction site photograph. Identify which ONE of the
following construction departments/trades the physical work shown in the photo
most likely belongs to, based on the materials, equipment, and installation
work visible in the image (not any text written on it):

${departmentList}
${workItemInstruction}

Rules:
- If the photo shows clear, recognizable evidence of the materials,
  equipment, or installation work typical of ONE of the trades above —
  even an ordinary phone photo, imperfectly framed, poorly lit, or with
  no text visible anywhere in it — name that department. A normal,
  everyday jobsite photo of real work is expected; do not withhold a
  department name just because the photo isn't professional-quality or
  isn't 100% unambiguous.
- Reserve NONE for photos that genuinely show no recognizable
  construction trade work at all — e.g. a blank wall, an unrelated
  object, a document/screenshot, or something too generic/zoomed out to
  identify any trade.
- Respond with the EXACT department name from the list above, copied
  exactly (no extra words, quotes, or formatting).
- Never invent a department name that isn't in the list above.

Respond in exactly this format (3 lines, nothing else):
DEPARTMENT: <exact department name from the list, or NONE>
WORK_ITEM_RELEVANT: <YES, NO, or N/A>
CONFIDENCE: 0.xx
`.trim();
}

/** Strips formatting noise a model commonly adds despite being told not
 * to (markdown emphasis, surrounding quotes, a trailing period/colon)
 * so a genuinely correct answer like "**Electrical Department**" or
 * "Electrical Department." isn't discarded as unparseable. Never
 * changes the actual words, only incidental punctuation around them —
 * matching still requires the cleaned text to equal (or, as a second
 * pass, contain) a REAL department name; see detectedDepartment below. */
function cleanDepartmentText(raw: string): string {
  return raw
    .replace(/[*_`]/g, "")
    .replace(/^["'\s]+|["'.,:;\s]+$/g, "")
    .trim();
}

function parseClassification(raw: string, departmentNames: string[]): ImageDepartmentClassification {
  const departmentMatch = raw.match(/DEPARTMENT:\s*(.+)/i);
  const relevantMatch = raw.match(/WORK_ITEM_RELEVANT:\s*(YES|NO|N\/A)/i);
  const confidenceMatch = raw.match(/CONFIDENCE:\s*([0-9.]+)/i);

  const cleanedDepartment = cleanDepartmentText(departmentMatch?.[1] ?? "");
  // Pass 1: exact (case-insensitive) match, as before. Pass 2 — only
  // when pass 1 finds nothing and the cleaned text isn't literally
  // "NONE" — falls back to "does the cleaned response CONTAIN a real
  // department name," which tolerates a model that answers with minor
  // extra wording (e.g. "The DEPARTMENT: Electrical Department" despite
  // the format instruction) without ever accepting a hallucinated or
  // paraphrased name: the containment check is still anchored to the
  // caller's own real department list, never free text.
  const detectedDepartment =
    departmentNames.find((name) => name.toLowerCase() === cleanedDepartment.toLowerCase()) ??
    (cleanedDepartment.toUpperCase() !== "NONE" && cleanedDepartment.length > 0
      ? (departmentNames.find((name) => cleanedDepartment.toLowerCase().includes(name.toLowerCase())) ?? null)
      : null);

  const relevantRaw = relevantMatch?.[1]?.toUpperCase();
  const workItemRelevant = relevantRaw === "YES" ? true : relevantRaw === "NO" ? false : null;

  const confidence = confidenceMatch ? Math.min(1, Math.max(0, parseFloat(confidenceMatch[1]))) : null;

  return { detectedDepartment, workItemRelevant, confidence };
}

/**
 * Visual department classification — the actual "look at the physical
 * work in the photo" check, as opposed to runOCR's "read the note text
 * off the photo" check. Same provider/model/client setup as
 * geminiVisionOCR, different prompt and parsing. Reused by
 * lib/construction.ts assessImageSubmissionRelevance for the Worker
 * image-upload department/work-item relevance check.
 */
export async function classifyConstructionImageDepartment(
  fileBuffer: Buffer,
  mimeType: string,
  departmentNames: string[],
  selectedWorkItemDescription: string | null
): Promise<ImageDepartmentClassification | ImageClassificationError> {
  const apiKey = process.env.GEMINI_API_KEY;
  if (!apiKey) {
    return { error: "Vision classification provider not configured.", category: "not_configured" };
  }
  if (!mimeType.startsWith("image/")) {
    return { error: `Unsupported mime type: ${mimeType}`, category: "invalid_input" };
  }
  if (fileBuffer.length === 0) {
    return { error: "Empty image buffer.", category: "invalid_input" };
  }
  if (departmentNames.length === 0) {
    return { error: "No department catalog available to classify against.", category: "invalid_input" };
  }

  const ai = new GoogleGenAI({ apiKey });

  try {
    const response = await ai.models.generateContent({
      model: VISION_MODEL,
      contents: [
        {
          role: "user",
          parts: [
            { text: buildClassificationPrompt(departmentNames, selectedWorkItemDescription) },
            { inlineData: { mimeType, data: fileBuffer.toString("base64") } },
          ],
        },
      ],
    });

    const text = response.text;
    if (!text || !text.trim()) {
      throw new Error("Gemini returned an empty response.");
    }

    return parseClassification(text, departmentNames);
  } catch (error) {
    logProviderError({ model: VISION_MODEL, mimeType, bufferSize: fileBuffer.length, error });
    return { error: toCleanErrorMessage(error), category: categorizeClassificationError(error) };
  }
}

/**
 * BACKUP OCR PROVIDER
 *
 * Reserved for future implementation.
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

/**
 * Provider configuration error.
 */
export class ProviderNotConfiguredError
  extends Error {}

/**
 * Extract:
 *
 * ABC Commercial Building brick masonry work
 * 120 square feet completed today.
 *
 * CONFIDENCE: 0.94
 *
 * into:
 *
 * rawText = ABC Commercial Building brick masonry work...
 * confidence = 0.94
 */
function parseTextAndConfidence(
  raw: string,
  provider: string
): OCRResult {

  const match = raw.match(
    /CONFIDENCE:\s*([0-9.]+)\s*$/i
  );

  const confidence = match
    ? Math.min(
        1,
        Math.max(
          0,
          parseFloat(match[1])
        )
      )
    : null;

  const text = match
    ? raw
        .slice(0, match.index)
        .trim()
    : raw.trim();

  return {
    rawText: text,
    confidence,
    provider,
  };
}

/**
 * Main OCR function used by the API route.
 *
 * This function does NOT save anything to Supabase.
 *
 * It only returns:
 *
 * {
 *   rawText,
 *   confidence,
 *   provider
 * }
 */
export async function runOCR(
  fileBuffer: Buffer,
  mimeType: string
): Promise<OCRResult | OCRError> {

  try {

    return await geminiVisionOCR(
      fileBuffer,
      mimeType
    );

  } catch (err) {

    if (
      err instanceof ProviderNotConfiguredError
    ) {
      return {
        error: "OCR provider not configured.",
      };
    }

    const message =
      err instanceof Error
        ? err.message
        : "OCR extraction failed. Please try again.";

    return {
      error: message,
    };
  }
}

/**
 * Keep backup provider interface available
 * for future fallback implementation.
 */
void azureDocumentIntelligenceOCR;