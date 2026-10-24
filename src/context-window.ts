/** Bounds of a context window any server can have: the user-setting clamp, learned-window
 *  validation and per-model overrides all read these. Distinct from the cloud floor. */
export const SMALLEST_WINDOW_TOKENS = 1_024;
export const LARGEST_WINDOW_TOKENS = 1_000_000;
