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