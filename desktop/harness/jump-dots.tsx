import { useCallback, useEffect, useMemo, useRef, useState } from "react";
import { createRoot } from "react-dom/client";
import {
  JumpBar,
  MIN_DOT_GAP,
  dotTopForOffset,
  separateTops,
  trackMetrics,
} from "../src/ui/jump-bar";
import { useAutoScroll } from "../src/ui/useAutoScroll";
import { useIsScrollable } from "../src/ui/useIsScrollable";

/**
 * Deterministic stand-in for the transcript: fixed-height answer blocks instead
 * of streamed text, so "streaming" is a scripted per-frame height increase and
 * every assertion is reproducible without a model.
 */

const QUESTION_PX = 24;

// Expected positions come from the component's own helpers: one mapping, so the
// probe and the thing it probes cannot drift apart. (An earlier revision of this
// harness re-derived the mapping locally so it could also run against the pre-fix
// component; those pre-fix numbers are recorded in the plan history instead.)

interface TurnFixture {
  question: string;
  answerPx: number;
}

interface Scenario {
  turns: number;
  answerPx: number;
  lastAnswerPx: number;
}

/** Five short turns with one long answer: the real-world shape that stacks every
 *  dot near the top of the track (a live chat with a long reply). */
const CLUSTERED: Scenario = { turns: 5, answerPx: 200, lastAnswerPx: 30000 };
const TINY: Scenario = { turns: 2, answerPx: 10, lastAnswerPx: 10 };

const fixture = ({ turns, answerPx, lastAnswerPx }: Scenario): TurnFixture[] =>
  Array.from({ length: turns }, (_, i) => ({
    question: `Probe question ${i + 1}`,
    answerPx: i === turns - 1 ? lastAnswerPx : answerPx,
  }));

interface AssertionResult {
  id: string;
  name: string;
  pass: boolean;
  detail: string;
}

interface HarnessResults {
  passed: number;
  failed: number;
  assertions: AssertionResult[];
}

/** Imperative control surface the assertions (and a human) drive the page with. */
interface HarnessControl {
  reset: (scenario: Scenario) => void;
  setStreamed: (px: number) => void;
  addStreamed: (px: number) => void;
  setBusy: (busy: boolean) => void;
}

declare global {
  interface Window {
    __harness?: {
      results: () => HarnessResults | null;
      /** What the dots should read right now, straight from the component's own
       *  helpers: a probe never re-implements the mapping to check it. */
      expected: () => number[];
      run: () => Promise<HarnessResults>;
      control: HarnessControl;
    };
  }
}

const frame = (): Promise<void> => new Promise((resolve) => requestAnimationFrame(() => resolve()));
const frames = async (count: number): Promise<void> => {
  for (let i = 0; i < count; i += 1) await frame();
};

const threadEl = (): HTMLElement | null =>
  [...document.querySelectorAll<HTMLElement>(".thread")].find(
    (el) => el.getBoundingClientRect().width > 0,
  ) ?? null;

const dots = (): HTMLElement[] => [...document.querySelectorAll<HTMLElement>(".jump-dot")];

const dotTops = (): number[] => dots().map((dot) => Number.parseFloat(dot.style.top) || 0);

/** Content-space offset of every turn, the coordinate the dots are mapped from. */
const anchors = (thread: HTMLElement): { turn: number; offset: number }[] => {
  const rect = thread.getBoundingClientRect();
  return [...thread.querySelectorAll<HTMLElement>("[data-turn]")].map((el) => ({
    turn: Number(el.getAttribute("data-turn")),
    offset: el.getBoundingClientRect().top - rect.top + thread.scrollTop,
  }));
};

/** What the dots should read right now, computed from the live geometry. */
const expectedTops = (thread: HTMLElement): number[] => {
  const m = trackMetrics(thread);
  return separateTops(
    anchors(thread).map((a) => dotTopForOffset(a.offset, m)),
    m.trackHeight,
    MIN_DOT_GAP,
  ).map((top) => Math.round(top));
};

/** Wait until the transcript has grown enough to overflow, so the bar exists. */
const waitForBar = async (): Promise<boolean> => {
  for (let i = 0; i < 180; i += 1) {
    if (dots().length > 0 && threadEl()) return true;
    await frame();
  }
  return false;
};

async function assertIdleStable(control: HarnessControl): Promise<AssertionResult> {
  control.reset(CLUSTERED);
  await frames(20);
  const bar = await waitForBar();
  if (!bar) {
    return { id: "A", name: "dots hold still at idle", pass: false, detail: "no dots rendered" };
  }
  const before = dotTops().join(",");
  let changes = 0;
  let firstChange = "";
  for (let i = 0; i < 90; i += 1) {
    await frame();
    const now = dotTops().join(",");
    if (now !== before) {
      changes += 1;
      firstChange = `${before} -> ${now}`;
    }
  }
  return {
    id: "A",
    name: "dots hold still at idle",
    pass: changes === 0,
    detail: `90 frames, ${changes} layout change(s)${firstChange ? `, first ${firstChange}` : ""}`,
  };
}

/** Growth must be reflected within one frame; the deferral this replaced took
 *  ~1.2s, which is what made the dots land in whole-tens-of-pixels steps. */
async function assertGrowthTracked(control: HarnessControl): Promise<AssertionResult> {
  control.reset(CLUSTERED);
  await frames(20);
  if (!(await waitForBar())) {
    return { id: "B", name: "growth is tracked every frame", pass: false, detail: "no dots" };
  }
  let mismatches = 0;
  let maxLag = 0;
  let steps = 0;
  let worst = "";
  control.setBusy(true);
  for (let i = 0; i < 90; i += 1) {
    control.addStreamed(64);
    await frame();
    steps += 1;
    const thread = threadEl();
    if (!thread) break;
    let lag = 0;
    while (lag < 4 && expectedTops(thread).join(",") !== dotTops().join(",")) {
      await frame();
      lag += 1;
    }
    if (lag > 0) maxLag = Math.max(maxLag, lag);
    if (lag >= 4) {
      mismatches += 1;
      if (!worst) worst = `expected ${expectedTops(thread).join(",")} got ${dotTops().join(",")}`;
    }
  }
  control.setBusy(false);
  return {
    id: "B",
    name: "growth is tracked every frame",
    pass: mismatches === 0,
    detail: `${steps} growth frames, max lag ${maxLag} frame(s), ${mismatches} unresolved${worst ? ` (${worst})` : ""}`,
  };
}

/** The bug that started this: dots stacked within 2px, so the top-most dot of the
 *  stack swallowed every click aimed at its neighbours. */
async function assertDotsReachable(control: HarnessControl): Promise<AssertionResult> {
  control.reset(CLUSTERED);
  await frames(20);
  if (!(await waitForBar())) {
    return { id: "C", name: "every dot reachable and separated", pass: false, detail: "no dots" };
  }
  const tops = dotTops();
  const gaps = tops.slice(1).map((top, i) => Math.round((top - tops[i]!) * 10) / 10);
  const tooTight = gaps.filter((gap) => gap < MIN_DOT_GAP - 1);
  const misHit = dots().filter((dot) => {
    const rect = dot.getBoundingClientRect();
    const hit = document.elementFromPoint(
      rect.left + rect.width / 2,
      rect.top + rect.height / 2,
    );
    return hit !== dot;
  });
  return {
    id: "C",
    name: "every dot reachable and separated",
    pass: tooTight.length === 0 && misHit.length === 0,
    detail: `tops [${tops.join(", ")}], gaps [${gaps.join(", ")}] (min ${MIN_DOT_GAP}), ${misHit.length}/${dots().length} dots not on top at their own centre`,
  };
}

/** The reported failure: clicking a dot during a live answer did not take you
 *  where the dot was. */
async function assertClickWhileGrowing(control: HarnessControl): Promise<AssertionResult> {
  control.reset(CLUSTERED);
  await frames(20);
  if (!(await waitForBar())) {
    return { id: "D", name: "click lands the turn while growing", pass: false, detail: "no dots" };
  }
  const thread = threadEl();
  if (!thread) return { id: "D", name: "click lands the turn", pass: false, detail: "no thread" };
  const target = dots().find((dot) => dot.dataset.turn === "4") ?? dots()[dots().length - 2];
  if (!target) {
    return { id: "D", name: "click lands the turn while growing", pass: false, detail: "no dot 4" };
  }
  const turn = target.dataset.turn!;
  // Busy first, settle, then click: in the app the turn-start pin happens when the
  // turn begins, long before the reader reaches for a dot.
  control.setBusy(true);
  await frames(6);
  target.click();
  let worstOffset = 0;
  for (let i = 0; i < 150; i += 1) {
    control.addStreamed(48);
    await frame();
    const el = thread.querySelector<HTMLElement>(`[data-turn="${turn}"]`);
    if (!el) continue;
    const offset = Math.abs(
      el.getBoundingClientRect().top - thread.getBoundingClientRect().top,
    );
    worstOffset = Math.max(worstOffset, offset);
  }
  control.setBusy(false);
  return {
    id: "D",
    name: "click lands the turn while growing",
    pass: worstOffset <= 2,
    detail: `after clicking turn ${turn}, its top drifted up to ${Math.round(worstOffset)}px from the viewport top while the answer kept growing`,
  };
}

/** The reported failure in full: hopping around a live chat must land each turn,
 *  keep the marker on it, and leave every dot sitting on its mapped spot. */
async function assertHopsWhileGrowing(control: HarnessControl): Promise<AssertionResult> {
  control.reset(CLUSTERED);
  await frames(20);
  const thread = threadEl();
  if (!thread || !(await waitForBar())) {
    return { id: "G", name: "hopping while growing lands and stays mapped", pass: false, detail: "no dots" };
  }
  control.setBusy(true);
  await frames(6);

  const hops = [1, 5, 2, 4];
  const problems: string[] = [];
  for (const turn of hops) {
    const dot = dots().find((d) => d.dataset.turn === String(turn));
    if (!dot) {
      problems.push(`turn ${turn}: no dot`);
      continue;
    }
    dot.click();
    // Keep the answer growing while the jump settles, so the "and it holds" half
    // is exercised rather than assumed.
    let elapsed = 0;
    let still = 0;
    let last = thread.scrollTop;
    while (elapsed < 150 && still < 6) {
      control.addStreamed(48);
      await frame();
      elapsed += 1;
      still = thread.scrollTop === last ? still + 1 : 0;
      last = thread.scrollTop;
    }
    const el = thread.querySelector<HTMLElement>(`[data-turn="${turn}"]`);
    const offTop = el
      ? Math.abs(el.getBoundingClientRect().top - thread.getBoundingClientRect().top)
      : Number.NaN;
    const active = document.querySelector<HTMLElement>(".jump-dot[data-active]")?.dataset.turn;
    if (!(offTop <= 2)) problems.push(`turn ${turn}: landed ${Math.round(offTop)}px off`);
    if (active !== String(turn)) problems.push(`turn ${turn}: marker on ${active ?? "none"}`);
    if (dotTops().join(",") !== expectedTops(thread).join(",")) {
      problems.push(`turn ${turn}: dots ${dotTops().join(",")} vs mapping ${expectedTops(thread).join(",")}`);
    }
  }
  control.setBusy(false);
  return {
    id: "G",
    name: "hopping while growing lands and stays mapped",
    pass: problems.length === 0,
    detail:
      problems.length === 0
        ? `hops ${hops.join(" -> ")}: each landed flush, marker on the clicked turn, every dot on its mapped spot`
        : problems.join("; "),
  };
}

/** The orange marker is "you are here", not "the newest turn". */
async function assertActiveFollowsScroll(control: HarnessControl): Promise<AssertionResult> {
  control.reset(CLUSTERED);
  await frames(20);
  const thread = threadEl();
  if (!thread || !(await waitForBar())) {
    return { id: "E", name: "active marker follows the reader", pass: false, detail: "no dots" };
  }
  const anchor = anchors(thread).find((a) => a.turn === 3);
  if (!anchor) {
    return { id: "E", name: "active marker follows the reader", pass: false, detail: "no turn 3" };
  }
  thread.scrollTop = anchor.offset;
  await frames(20);
  const active = document.querySelector<HTMLElement>(".jump-dot[data-active]");
  return {
    id: "E",
    name: "active marker follows the reader",
    pass: active?.dataset.turn === "3",
    detail: `scrolled to turn 3; active marker is turn ${active?.dataset.turn ?? "none"}`,
  };
}

async function assertBarHiddenWhenFits(control: HarnessControl): Promise<AssertionResult> {
  control.reset(TINY);
  await frames(30);
  const bar = document.querySelector(".jump-bar");
  const thread = threadEl();
  return {
    id: "F",
    name: "no bar when the transcript fits",
    pass: bar === null,
    detail: bar
      ? `bar rendered with scrollHeight ${thread?.scrollHeight} vs clientHeight ${thread?.clientHeight}`
      : "no bar while the transcript cannot scroll",
  };
}

const summarize = (assertions: AssertionResult[]): HarnessResults => ({
  passed: assertions.filter((a) => a.pass).length,
  failed: assertions.filter((a) => !a.pass).length,
  assertions,
});

function Harness() {
  const [turns, setTurns] = useState<TurnFixture[]>(() => fixture(CLUSTERED));
  const [streamed, setStreamed] = useState(0);
  const [busy, setBusy] = useState(false);
  const [results, setResults] = useState<HarnessResults | null>(null);
  const resultsRef = useRef<HarnessResults | null>(null);
  const threadRef = useRef<HTMLDivElement | null>(null);
  const innerRef = useRef<HTMLDivElement | null>(null);
  const [thread, setThread] = useState<HTMLDivElement | null>(null);
  const bindThread = useCallback((el: HTMLDivElement | null) => {
    threadRef.current = el;
    setThread(el);
  }, []);

  const { unpinForJump } = useAutoScroll(threadRef, innerRef, busy);
  const scrollable = useIsScrollable(threadRef, innerRef);

  const control = useMemo<HarnessControl>(
    () => ({
      reset: (scenario) => {
        setStreamed(0);
        setTurns(fixture(scenario));
      },
      setStreamed: (px) => setStreamed(px),
      addStreamed: (px) => setStreamed((prev) => prev + px),
      setBusy,
    }),
    [],
  );

  const messages = useMemo(
    () => turns.map((turn, i) => ({ kind: "user", text: turn.question, turn: i + 1 })),
    [turns],
  );

  useEffect(() => {
    let cancelled = false;
    const run = async (): Promise<HarnessResults> => {
      const assertions: AssertionResult[] = [];
      assertions.push(await assertIdleStable(control));
      assertions.push(await assertGrowthTracked(control));
      assertions.push(await assertDotsReachable(control));
      assertions.push(await assertClickWhileGrowing(control));
      assertions.push(await assertHopsWhileGrowing(control));
      assertions.push(await assertActiveFollowsScroll(control));
      assertions.push(await assertBarHiddenWhenFits(control));
      const summary = summarize(assertions);
      resultsRef.current = summary;
      if (!cancelled) {
        setResults(summary);
        document.title = `harness ${summary.passed}/${assertions.length}`;
      }
      return summary;
    };
    // The published handle reads a ref, not the state it writes: depending on
    // `results` here would re-run the whole suite on every publish.
    window.__harness = {
      results: () => resultsRef.current,
      expected: () => {
        const el = threadEl();
        return el ? expectedTops(el) : [];
      },
      run,
      control,
    };
    void frames(10).then(() => {
      if (!cancelled) void run();
    });
    return () => {
      cancelled = true;
      delete window.__harness;
    };
  }, [control]);

  const lastIndex = turns.length - 1;

  return (
    <div className="main probe-shell" style={{ position: "relative" }}>
      <div className="probe-head">
        <h1>
          Jump-dot harness — self-test{" "}
          {results ? `${results.passed}/${results.assertions.length} passed` : "running…"}
        </h1>
        <ul className="probe-list">
          {(results?.assertions ?? []).map((a) => (
            <li key={a.id} data-pass={a.pass ? "true" : "false"}>
              [{a.pass ? "PASS" : "FAIL"}] {a.id} {a.name} — {a.detail}
            </li>
          ))}
        </ul>
      </div>
      <div className="thread-wrap">
        <div className="thread" ref={bindThread}>
          <div className="thread-inner" ref={innerRef}>
            {turns.map((turn, i) => (
              <div key={turn.question} data-turn={i + 1}>
                <div className="probe-user" style={{ height: QUESTION_PX }}>
                  {turn.question}
                </div>
                <div
                  className="probe-fill"
                  style={{ height: `${turn.answerPx + (i === lastIndex ? streamed : 0)}px` }}
                />
              </div>
            ))}
          </div>
        </div>
      </div>
      {scrollable ? (
        <JumpBar
          messages={messages}
          threadEl={thread}
          busy={busy}
          onJump={unpinForJump}
        />
      ) : null}
    </div>
  );
}

const host = document.getElementById("root");
if (!host) throw new Error("#root missing");
createRoot(host).render(<Harness />);
