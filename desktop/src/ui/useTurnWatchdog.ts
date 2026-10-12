import { useEffect, useRef } from "react";

const POLL_INTERVAL_MS = 5_000;
const STALE_ACK_MS = 10_000;

/** Turn-state parity watchdog: while a turn is engaged (daemon-owned busy or an
 *  unacked optimistic send), probe the daemon's authoritative tab_status every
 *  poll cycle, on focus, and on reconnect; release a send the daemon never acked. */
export function useTurnWatchdog(opts: {
  engaged: boolean;
  awaitingAckWithoutBusy: boolean;
  connected: boolean;
  probe: () => void;
  onStaleAck: () => void;
}): void {
  const probeRef = useRef(opts.probe);
  probeRef.current = opts.probe;
  const staleRef = useRef(opts.onStaleAck);
  staleRef.current = opts.onStaleAck;

  // Tearing down on connected=false (rpc_exit) and re-probing on reconnect is
  // the same effect: connected is in the dep array.
  useEffect(() => {
    if (!opts.engaged || !opts.connected) return;
    probeRef.current();
    const id = window.setInterval(() => probeRef.current(), POLL_INTERVAL_MS);
    return () => window.clearInterval(id);
  }, [opts.engaged, opts.connected]);

  useEffect(() => {
    if (!opts.engaged) return;
    const onFocus = () => probeRef.current();
    window.addEventListener("focus", onFocus);
    return () => window.removeEventListener("focus", onFocus);
  }, [opts.engaged]);

  useEffect(() => {
    if (!opts.awaitingAckWithoutBusy) return;
    const id = window.setTimeout(() => staleRef.current(), STALE_ACK_MS);
    return () => window.clearTimeout(id);
  }, [opts.awaitingAckWithoutBusy]);
}
