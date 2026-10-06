export const DEFAULT_COMPOSER_ROWS = 2;

export type ComposerTextareaSizing = {
  heightPx: number;
  overflowY: "hidden" | "auto";
};

/**
 * The composer textarea keeps a fixed height and never resizes — input taller
 * than {@link DEFAULT_COMPOSER_ROWS} scrolls inside the box instead of growing
 * it. It used to expand past a row threshold, so the box jumped as the user
 * typed across that boundary.
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

  return {
    heightPx: DEFAULT_COMPOSER_ROWS * lineHeightPx + verticalPaddingPx,
    overflowY: safeRows > DEFAULT_COMPOSER_ROWS ? "auto" : "hidden",
  };
}
