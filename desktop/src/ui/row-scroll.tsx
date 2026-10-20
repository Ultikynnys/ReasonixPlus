import { type ReactNode, createContext, useContext, useLayoutEffect, useRef } from "react";
import { useStickyBottom } from "./useStickyBottom";

/** px from the bottom within which a follow stream still counts as "pinned". */
const FOLLOW_PIN_THRESHOLD = 8;

/** Whether this subtree already sits in a row window, so a nested list defers to
 *  the outer box instead of opening a second scrollbar inside it. */
const InRowWindow = createContext(false);

/** True when rendered inside an existing row window (see {@link RowScroll}). */
export function useInRowWindow(): boolean {
  return useContext(InRowWindow);
}

/** The re-follow trigger for a live stream: changes on new text and on the
 *  live→settled flip, so a settling card pins its tail once more. */
export function liveFollowKey(text: string, streaming: boolean): string {
  return `${streaming ? "live" : "settled"}:${text}`;
}

/**
 * The one bounded card body every long card shares (thinking, shell output, plan
 * confirmation, subagent). `.row-scroll` windows it to `--scroll-rows` rows of its
 * own line-height (6 by default) and scrolls the rest, so nothing is truncated.
 * `follow` pins the tail while content streams (an up-scroll releases it, the
 * bottom re-pins); without it the body opens at the top, for static content.
 * Mounted only while the card is expanded, so a collapsed long card costs nothing.
 */
export function RowScroll({
  className,
  label,
  follow = false,
  followKey,
  children,
}: {
  /** The body's own class, carrying its typography and padding (e.g. "stream"). */
  className?: string;
  /** Accessible name; only live streams pass one, which makes the box a log. */
  label?: string;
  follow?: boolean;
  /** Re-follow when this changes — streams pass {@link liveFollowKey}. Primitives
   *  only: an object identity would rebuild the effect on every render. */
  followKey?: string | number | boolean;
  children: ReactNode;
}) {
  const ref = useRef<HTMLDivElement>(null);
  const sticky = useStickyBottom(ref, {
    threshold: FOLLOW_PIN_THRESHOLD,
    scrollToBottom: () => {
      const el = ref.current;
      if (el) el.scrollTop = el.scrollHeight;
    },
  });

  // The observer's lifetime is mount + the follow flag, never the content: keying
  // it on the streamed text would tear it down and rebuild it on every token.
  useLayoutEffect(() => {
    if (!follow) return;
    const el = ref.current;
    if (!el) return;
    if (typeof ResizeObserver === "undefined") return;
    const observer = new ResizeObserver(() => sticky.follow());
    observer.observe(el);
    return () => observer.disconnect();
  }, [follow, sticky]);

  // Pin on mount and whenever the followed content changes.
  // biome-ignore lint/correctness/useExhaustiveDependencies: followKey is a re-run trigger the body never reads
  useLayoutEffect(() => {
    if (follow) sticky.follow();
  }, [follow, followKey, sticky]);

  return (
    <InRowWindow.Provider value={true}>
      <div
        ref={ref}
        className={className ? `row-scroll ${className}` : "row-scroll"}
        {...(label ? { role: "log" as const, "aria-label": label } : {})}
      >
        {children}
      </div>
    </InRowWindow.Provider>
  );
}
