import { useCallback, useEffect, useMemo, useRef, useState } from "react";
import { createRoot } from "react-dom/client";
import {
  JumpBar,
  type JumpMessage,
  MIN_DOT_GAP,
  conversationSpans,
  projectMarks,
} from "../src/ui/jump-bar";
import { useAutoScroll } from "../src/ui/useAutoScroll";
import { useIsScrollable } from "../src/ui/useIsScrollable";

/**
 * Deterministic stand-in for the transcript: fixed-height answer blocks instead
 * of streamed text, so "streaming" is a scripted per-frame height increase and
 * every assertion is reproducible without a model.
 */

const QUESTION_PX = 24;
/** Stamp of the first recorded turn, and the spacing between turns. The map is
 *  projected from these, so they are the fixture's real inputs. */
const BASE_TS = 1_700_000_000_000;
const TURN_GAP_MS = 60_000;

interface TurnFixture {
  question: string;
  answerPx: number;
}

interface Scenario {
  turns: number;
  answerPx: number;
  lastAnswerPx: number;
}

/** Five short turns with one long answer: the real-world shape the old
 *  content-weight map stacked against the top of the track. */
const CLUSTERED: Scenario = { turns: 5, answerPx: 200, lastAnswerPx: 30000 };
const TINY: Scenario = { turns: 2, answerPx: 10, lastAnswerPx: 10 };

const fixture = ({ turns, answerPx, lastAnswerPx }: Scenario): TurnFixture[] =>
  Array.from({ length: turns }, (_, i) => ({
    question: `Probe question ${i + 1}`,
    answerPx: i === turns - 1 ? lastAnswerPx : answerPx,
  }));

/** The transcript the bar reads: one user record per turn, each stamped. */
const messagesFor = (turns: TurnFixture[]): JumpMessage[] =>
  turns.map((turn, i) => ({
    kind: "user",
    text: turn.question,
    turn: i + 1,
    ts: BASE_TS + i * TURN_GAP_MS,
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
  addTurn: () => void;
  /** The dots the visible transcript should be showing, straight from the
   *  component's own helpers: a probe never re-implements the mapping. */
  expected: () => number[];
}

declare global {
  interface Window {
    __harness?: {
      results: () => HarnessResults | null;
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

/** Content-space offset of every turn, the coordinate a click has to land on. */
const anchors = (thread: HTMLElement): { turn: number; offset: number }[] => {
  const rect = thread.getBoundingClientRect();
  return [...thread.querySelectorAll<HTMLElement>("[data-turn]")].map((el) => ({
    turn: Number(el.getAttribute("data-turn")),
    offset: el.getBoundingClientRect().top - rect.top + thread.scrollTop,
  }));
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

/** The first record anchors the top of the track: the first dot must be flush
 *  with the top edge, not merely near it. */
async function assertFirstDotAtTop(control: HarnessControl): Promise<AssertionResult> {
  control.reset(CLUSTERED);
  await frames(20);
  if (!(await waitForBar())) {
    return { id: "B", name: "first dot sits at the top edge", pass: false, detail: "no dots" };
  }
  const tops = dotTops();
  const expected = control.expected();
  const first = document.querySelector<HTMLElement>('.jump-dot[data-turn="1"]');
  const firstTop = first ? Number.parseFloat(first.style.top) : Number.NaN;
  return {
    id: "B",
    name: "first dot sits at the top edge",
    pass: firstTop === 0 && tops.join(",") === expected.join(","),
    detail: `turn 1 at ${firstTop}px, tops [${tops.join(", ")}], mapping [${expected.join(", ")}]`,
  };
}

/** The map is a function of the records, not of layout: an answer streaming
 *  taller must not move a single dot. */
async function assertInertWhileGrowing(control: HarnessControl): Promise<AssertionResult> {
  control.reset(CLUSTERED);
  await frames(20);
  if (!(await waitForBar())) {
    return {
      id: "C",
      name: "dots are inert while an answer streams",
      pass: false,
      detail: "no dots",
    };
  }
  const before = dotTops().join(",");
  let moves = 0;
  let worst = "";
  control.setBusy(true);
  for (let i = 0; i < 90; i += 1) {
    control.addStreamed(64);
    await frame();
    const now = dotTops().join(",");
    if (now !== before) {
      moves += 1;
      if (!worst) worst = `${before} -> ${now}`;
    }
  }
  control.setBusy(false);
  const expected = control.expected().join(",");
  const onMap = dotTops().join(",") === expected;
  return {
    id: "C",
    name: "dots are inert while an answer streams",
    pass: moves === 0 && onMap,
    detail: `90 growth frames, ${moves} move(s)${worst ? `, first ${worst}` : ""}, ${onMap ? "still on the mapping" : `off the mapping (expected [${expected}])`}`,
  };
}

/** A dot moves when, and only when, a record is written. */
async function assertMovesOnWrite(control: HarnessControl): Promise<AssertionResult> {
  control.reset(CLUSTERED);
  await frames(20);
  if (!(await waitForBar())) {
    return { id: "D", name: "a written record moves the dots", pass: false, detail: "no dots" };
  }
  const before = dotTops();
  control.addTurn();
  await frames(6);
  const after = dotTops();
  const expected = control.expected();
  const moved = after.length === before.length + 1 && after.join(",") !== before.join(",");
  return {
    id: "D",
    name: "a written record moves the dots",
    pass: moved && after.join(",") === expected.join(","),
    detail: `${before.length} dots [${before.join(", ")}] -> ${after.length} dots [${after.join(", ")}], mapping [${expected.join(", ")}]`,
  };
}

/** The bug that started the earlier work: dots stacked within 2px, so the top-most
 *  dot of the stack swallowed every click aimed at its neighbours. */
async function assertDotsReachable(control: HarnessControl): Promise<AssertionResult> {
  control.reset(CLUSTERED);
  await frames(20);
  if (!(await waitForBar())) {
    return { id: "E", name: "every dot reachable and separated", pass: false, detail: "no dots" };
  }
  const tops = dotTops();
  const gaps = tops.slice(1).map((top, i) => Math.round((top - tops[i]!) * 10) / 10);
  const tooTight = gaps.filter((gap) => gap < MIN_DOT_GAP - 1);
  const misHit = dots().filter((dot) => {
    const rect = dot.getBoundingClientRect();
    const hit = document.elementFromPoint(rect.left + rect.width / 2, rect.top + rect.height / 2);
    return hit !== dot;
  });
  return {
    id: "E",
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
    return { id: "F", name: "click lands the turn while growing", pass: false, detail: "no dots" };
  }
  const thread = threadEl();
  if (!thread) return { id: "F", name: "click lands the turn", pass: false, detail: "no thread" };
  const target = dots().find((dot) => dot.dataset.turn === "4") ?? dots()[dots().length - 2];
  if (!target) {
    return { id: "F", name: "click lands the turn while growing", pass: false, detail: "no dot 4" };
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
    const offset = Math.abs(el.getBoundingClientRect().top - thread.getBoundingClientRect().top);
    worstOffset = Math.max(worstOffset, offset);
  }
  control.setBusy(false);
  return {
    id: "F",
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
    return {
      id: "G",
      name: "hopping while growing lands and stays mapped",
      pass: false,
      detail: "no dots",
    };
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
    if (dotTops().join(",") !== control.expected().join(",")) {
      problems.push(
        `turn ${turn}: dots ${dotTops().join(",")} vs mapping ${control.expected().join(",")}`,
      );
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
    return { id: "H", name: "active marker follows the reader", pass: false, detail: "no dots" };
  }
  const anchor = anchors(thread).find((a) => a.turn === 3);
  if (!anchor) {
    return { id: "H", name: "active marker follows the reader", pass: false, detail: "no turn 3" };
  }
  thread.scrollTop = anchor.offset;
  await frames(20);
  const active = document.querySelector<HTMLElement>(".jump-dot[data-active]");
  return {
    id: "H",
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
    id: "I",
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

  const messages = useMemo(() => messagesFor(turns), [turns]);

  /** The dots the rendered transcript should show, from the component's own
   *  mapping — never a locally re-derived one. */
  const expected = useCallback((): number[] => {
    const el = threadEl();
    if (!el) return [];
    const trackHeight = Math.round(el.clientHeight);
    return projectMarks(conversationSpans(messages), trackHeight).map((mark) => mark.top);
  }, [messages]);

  const control = useMemo<HarnessControl>(
    () => ({
      reset: (scenario) => {
        setStreamed(0);
        setTurns(fixture(scenario));
      },
      setStreamed: (px) => setStreamed(px),
      addStreamed: (px) => setStreamed((prev) => prev + px),
      setBusy,
      addTurn: () =>
        setTurns((prev) => [
          ...prev,
          { question: `Probe question ${prev.length + 1}`, answerPx: 200 },
        ]),
      expected,
    }),
    [expected],
  );

  useEffect(() => {
    let cancelled = false;
    const run = async (): Promise<HarnessResults> => {
      const assertions: AssertionResult[] = [];
      assertions.push(await assertIdleStable(control));
      assertions.push(await assertFirstDotAtTop(control));
      assertions.push(await assertInertWhileGrowing(control));
      assertions.push(await assertMovesOnWrite(control));
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
      expected: () => control.expected(),
      run,
      control,
    };
    void frames(10).then(() => {
      if (!cancelled) void run();
    });
    return () => {
      cancelled = true;
      window.__harness = undefined;
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
      {scrollable ? <JumpBar messages={messages} threadEl={thread} onJump={unpinForJump} /> : null}
    </div>
  );
}

const host = document.getElementById("root");
if (!host) throw new Error("#root missing");
createRoot(host).render(<Harness />);
