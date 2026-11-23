/** The thread's text size in px at rest. Every other text size in the app is a share of
 *  it, held as the `--fs-*` ladder in styles.css, so one slider moves all of the type
 *  while the chrome's paddings and widths keep their proportions. */
export const BASE_TEXT_PX = 14;

export const TEXT_SIZE_RANGE = { min: 10, max: 20, step: 1 } as const;

/** A stored value is usable only if it is a whole px inside the slider's range. */
export function isTextSizePx(value: unknown): value is number {
  return (
    typeof value === "number" &&
    Number.isInteger(value) &&
    value >= TEXT_SIZE_RANGE.min &&
    value <= TEXT_SIZE_RANGE.max
  );
}

/** Clamps anything, so a hand-edited stored value cannot push the type off the ladder. */
export function clampTextSizePx(value: number): number {
  const { min, max } = TEXT_SIZE_RANGE;
  if (!Number.isFinite(value)) return BASE_TEXT_PX;
  return Math.min(max, Math.max(min, Math.round(value)));
}

const STORE_KEY = "reasonix.fontSize";
/** The retired three-step scale, read once so an existing install keeps its size. */
const LEGACY_KEY = "reasonix.fontScale";
const LEGACY_PX: Record<string, number> = { small: 12, medium: 14, large: 16 };

/** The stored size, or the legacy step it was set to, or the base. */
export function readStoredTextSize(): number {
  const stored = localStorage.getItem(STORE_KEY);
  if (stored !== null) {
    const value = Number(stored);
    if (isTextSizePx(value)) return value;
  }
  const legacy = localStorage.getItem(LEGACY_KEY);
  const migrated = legacy ? LEGACY_PX[legacy] : undefined;
  return migrated ?? BASE_TEXT_PX;
}

export function storeTextSize(value: number): void {
  localStorage.setItem(STORE_KEY, String(value));
}
