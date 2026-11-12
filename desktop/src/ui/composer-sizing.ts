/** Rows the composer opens at, and the ceiling it grows to before it scrolls. */
export const DEFAULT_COMPOSER_ROWS = 1;
export const MAX_COMPOSER_ROWS = 4;

export type ComposerTextareaSizing = {
  heightPx: number;
  overflowY: "hidden" | "auto";
};

/**
 * The composer grows with its content between {@link DEFAULT_COMPOSER_ROWS} and
 * {@link MAX_COMPOSER_ROWS}; past the cap it scrolls inside the box instead of
 * taking more of the window. The stylesheet expresses the same clamp as
 * min-height / max-height plus `field-sizing: content`, so both ends stay here.
 */
export function getComposerTextareaSizing({
  contentRows,
  lineHeightPx,
  verticalPaddingPx,
}: {
  contentRows: number;
  lineHeightPx: number;
  verticalPaddingPx: number;
}): ComposerTextareaSizing {
  const safeRows = Math.max(1, Math.ceil(contentRows));
  const rows = Math.min(MAX_COMPOSER_ROWS, Math.max(DEFAULT_COMPOSER_ROWS, safeRows));

  return {
    heightPx: rows * lineHeightPx + verticalPaddingPx,
    overflowY: safeRows > MAX_COMPOSER_ROWS ? "auto" : "hidden",
  };
}
