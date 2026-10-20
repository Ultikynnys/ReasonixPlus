/** The shared busy ring for filled buttons. Reads light on the accent fill via
 *  currentColor and announces itself, so a locked-out button still says why. */
export function Throbber({ label }: { label: string }) {
  return <span className="spin btn-throbber" role="status" aria-label={label} />;
}
