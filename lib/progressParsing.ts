/**
 * Best-effort, conservative detection of a percentage the worker
 * already stated in their own confirmed update text — used only to
 * pre-fill the "Progress today (%)" field as a suggestion. Never
 * submits anything, never calls an API, never throws.
 *
 * Only matches a number directly attached to a percent indicator
 * ("%" or "percent"/"percentage"), so plain numbers elsewhere in the
 * text (work item codes, amounts, quantities, worker counts) are
 * never mistaken for a progress value. If more than one *distinct*
 * percentage is found, the result is ambiguous and null is returned
 * rather than guessing — the worker enters it manually instead.
 */
export function extractProgressPercentage(text: string): number | null {
  const PERCENT_PATTERN = /(\d{1,3}(?:\.\d+)?)\s*(?:%|percent(?:age)?\b)/gi;

  const candidates: number[] = [];
  let match: RegExpExecArray | null;

  while ((match = PERCENT_PATTERN.exec(text)) !== null) {
    const value = parseFloat(match[1]);
    if (Number.isFinite(value) && value >= 0 && value <= 100) {
      candidates.push(value);
    }
  }

  if (candidates.length === 0) return null;

  const distinctValues = new Set(candidates);
  if (distinctValues.size > 1) return null; // ambiguous — don't guess

  return candidates[0];
}

/**
 * Common spoken/written variants of the standard construction unit
 * abbreviations this app already stores in work_items.unit_of_measure
 * (e.g. "m3"). Extracted text says what a person actually wrote/said
 * ("35 Cubic meters"), not the stored code, so matching the code alone
 * missed real extractions — this maps each known code to the forms it
 * commonly appears as. Units not in this table (custom ones an admin
 * configured) still match literally, exactly as before.
 */
const UNIT_SYNONYMS: Record<string, string[]> = {
  m3: ["m3", "m³", "cubic met(?:er|re)s?", "cu\\.?\\s?m\\.?", "cum"],
  m2: ["m2", "m²", "square met(?:er|re)s?", "sq\\.?\\s?m\\.?", "sqm"],
  kg: ["kg", "kgs", "kilograms?"],
  m: ["m", "met(?:er|re)s?", "mtrs?"],
  ft: ["ft", "feet", "foot"],
};

function unitPattern(unitOfMeasure: string): string {
  const trimmed = unitOfMeasure.trim();
  const key = trimmed.toLowerCase();
  const synonyms = UNIT_SYNONYMS[key];
  const escaped = trimmed.replace(/[.*+?^${}()|[\]\\]/g, "\\$&");
  if (!synonyms) return escaped;
  return synonyms.join("|");
}

/** Words that mark a quantity as the planned/target amount rather than
 * what was actually completed — e.g. "...against the planned 50 cubic
 * meters" or "The planned quantity for this work item is 500 meters."
 * A quantity match is discarded when one of these appears anywhere
 * earlier in the *same sentence*, so the planned figure is never
 * mistaken for the completed one even when both share the same unit,
 * regardless of how many words separate the keyword from the number. */
const PLANNED_QUANTITY_CONTEXT = /\b(planned|plan|target|scheduled)\b/i;
const SENTENCE_BOUNDARY = /[.!?](?:\s|$)/g;

/** Start index (into `text`) of the sentence containing position
 * `index` — the character right after the nearest sentence-ending
 * punctuation before it, or 0 if this is the first sentence. */
function sentenceStart(text: string, index: number): number {
  let start = 0;
  SENTENCE_BOUNDARY.lastIndex = 0;
  let boundary: RegExpExecArray | null;
  while ((boundary = SENTENCE_BOUNDARY.exec(text)) !== null) {
    const boundaryEnd = boundary.index + boundary[0].length;
    if (boundaryEnd > index) break;
    start = boundaryEnd;
  }
  return start;
}

/**
 * Same conservative approach as extractProgressPercentage, applied to a
 * completed quantity instead: only matches a number immediately followed
 * by the work item's own unit of measure — or a common spoken variant of
 * it, see UNIT_SYNONYMS — so unrelated numbers (work item codes, worker
 * counts, dates) are never mistaken for it, and a planned-quantity
 * mention in the same sentence is excluded rather than counted.
 * Ambiguous (more than one distinct match remains) or no unit configured
 * -> null, and the worker enters it manually.
 */
export function extractCompletedQuantity(
  text: string,
  unitOfMeasure: string | null | undefined
): number | null {
  if (!unitOfMeasure || !unitOfMeasure.trim()) return null;

  // Trailing lookahead (not \b): \b only fires at a word/non-word
  // transition, and unit synonyms ending in a non-word Unicode
  // character (m², m³) are never followed by one — "30 m² of" has no
  // \w boundary after "²", so \b silently failed to match here.
  const pattern = new RegExp(
    `(\\d{1,9}(?:\\.\\d+)?)\\s*(?:${unitPattern(unitOfMeasure)})(?!\\w)`,
    "gi"
  );

  const candidates: number[] = [];
  let match: RegExpExecArray | null;

  while ((match = pattern.exec(text)) !== null) {
    const value = parseFloat(match[1]);
    if (!Number.isFinite(value) || value < 0) continue;

    const precedingContext = text.slice(sentenceStart(text, match.index), match.index);
    if (PLANNED_QUANTITY_CONTEXT.test(precedingContext)) continue; // this is the planned amount, not completed

    candidates.push(value);
  }

  if (candidates.length === 0) return null;

  const distinctValues = new Set(candidates);
  if (distinctValues.size > 1) return null; // still ambiguous — don't guess

  return candidates[0];
}
