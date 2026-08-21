/**
 * Normalization + validation — pure functions, no I/O, easy to unit
 * test in isolation from the OCR/STT providers.
 */

export type ValidationOutcome = {
  status: "VALID" | "INVALID";
  reason: string;
};

const CONFIDENCE_THRESHOLD = 0.6;
const MIN_READABLE_CHARS = 3;
const MIN_VOICE_WORDS = 1;

/** Collapse whitespace, trim — deterministic, never guesses content. */
export function normalizeText(raw: string): string {
  return raw.replace(/\s+/g, " ").trim();
}

function isOnlySpecialCharacters(text: string): boolean {
  return text.length > 0 && !/[a-zA-Z0-9]/.test(text);
}

export function validateHandwritten(
  rawText: string,
  confidence: number | null
): ValidationOutcome {
  const normalized = normalizeText(rawText);

  if (normalized.length === 0) {
    return { status: "INVALID", reason: "Extracted text is empty." };
  }
  if (normalized.toUpperCase() === "UNREADABLE") {
    return { status: "INVALID", reason: "Handwriting could not be read." };
  }
  if (normalized.length < MIN_READABLE_CHARS) {
    return {
      status: "INVALID",
      reason: `Extracted text is too short (minimum ${MIN_READABLE_CHARS} characters).`,
    };
  }
  if (isOnlySpecialCharacters(normalized)) {
    return { status: "INVALID", reason: "Extracted text contains no readable characters." };
  }
  if (confidence !== null && confidence < CONFIDENCE_THRESHOLD) {
    return {
      status: "INVALID",
      reason: `OCR confidence too low (${confidence.toFixed(2)} < ${CONFIDENCE_THRESHOLD}).`,
    };
  }
  return { status: "VALID", reason: "Handwriting extracted with acceptable confidence." };
}

export function validateVoice(
  rawText: string,
  confidence: number | null
): ValidationOutcome {
  const normalized = normalizeText(rawText);

  if (normalized.length === 0) {
    return { status: "INVALID", reason: "Transcript is empty (likely silence)." };
  }
  const wordCount = normalized.split(" ").filter(Boolean).length;
  if (wordCount < MIN_VOICE_WORDS) {
    return { status: "INVALID", reason: "Transcript has no recognizable words." };
  }
  if (normalized.length < MIN_READABLE_CHARS) {
    return {
      status: "INVALID",
      reason: `Transcript is too short (minimum ${MIN_READABLE_CHARS} characters).`,
    };
  }
  if (isOnlySpecialCharacters(normalized)) {
    return { status: "INVALID", reason: "Transcript contains no readable characters." };
  }
  if (confidence !== null && confidence < CONFIDENCE_THRESHOLD) {
    return {
      status: "INVALID",
      reason: `Transcription confidence too low (${confidence.toFixed(2)} < ${CONFIDENCE_THRESHOLD}).`,
    };
  }
  return { status: "VALID", reason: "Voice transcribed with acceptable confidence." };
}

export function validateTypedText(rawText: string): ValidationOutcome {
  const normalized = normalizeText(rawText);

  if (normalized.length === 0) {
    return { status: "INVALID", reason: "Text is empty." };
  }
  if (normalized.length < MIN_READABLE_CHARS) {
    return {
      status: "INVALID",
      reason: `Text is too short (minimum ${MIN_READABLE_CHARS} characters).`,
    };
  }
  if (isOnlySpecialCharacters(normalized)) {
    return { status: "INVALID", reason: "Text contains only special characters." };
  }
  return { status: "VALID", reason: "Text passed validation." };
}
