/** Left offset that right-aligns a picker with its trigger: the popup's right
 *  edge meets the trigger's own, slid left only when it would leave the viewport. */
export function menuPopLeft(options: {
  triggerRight: number;
  width: number;
  viewportWidth: number;
  pad: number;
}): number {
  const { triggerRight, width, viewportWidth, pad } = options;
  return Math.max(pad, Math.min(triggerRight - width, viewportWidth - width - pad));
}
