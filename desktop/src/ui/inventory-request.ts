import { useEffect } from "react";

/** Ask the daemon for an inventory (skills, plugins) when the surface that lists it opens.
 *  The snapshot arrives as an event, so this only has to fire once per open. */
export function useInventoryRequest(onRequest?: () => void): void {
  useEffect(() => {
    onRequest?.();
  }, [onRequest]);
}
