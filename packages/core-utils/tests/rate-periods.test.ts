import { describe, expect, it } from "vitest";
import { PROVIDER_DOCUMENTS } from "../src/providers.generated.js";
import {
  PROVIDER_SPECS,
  parseProviderRegistry,
  providerRatePrices,
  providerRateSchedule,
  providerSpec,
  providerString,
  requireProviderSpec,
} from "../src/provider-registry.js";
import {
  type RateSchedule,
  blendedRateCost,
  isOffPeakRate,
  isPeakPricedModel,
  isPeakRate,
  isRateScheduleWeekend,
  minutesUntilRateChangeForSchedule,
  rateCost,
  ratePeriodForSchedule,
  ratePricesForModel,
} from "../src/rate-periods.js";

/** Weekday fixture — 2026-01-01 (Thursday). */
function weekday(hour: number, minute = 0): Date {
  return new Date(Date.UTC(2026, 0, 1, hour, minute));
}

/** Saturday 2026-09-05. */
function saturday(hour: number, minute = 0): Date {
  return new Date(Date.UTC(2026, 8, 5, hour, minute));
}

/** Sunday 2026-09-06. */
function sunday(hour: number, minute = 0): Date {
  return new Date(Date.UTC(2026, 8, 6, hour, minute));
}

/** Monday 2026-09-07. */
function monday(hour: number, minute = 0): Date {
  return new Date(Date.UTC(2026, 8, 7, hour, minute));
}

/** The calendar a provider declares, failing the test when it declares none. */
function declaredSchedule(id: "deepseek" | "ollama" | "zai"): RateSchedule {
  const schedule = providerRateSchedule(requireProviderSpec(id));
  if (!schedule) throw new Error(`${id}.json declares no billing.schedule`);
  return schedule;
}

/** `minutes from midnight` → `HH:MM`, the shape rate copy is written in. */
function clock(minute: number): string {
  const wrapped = ((minute % 1440) + 1440) % 1440;
  return `${String(Math.floor(wrapped / 60)).padStart(2, "0")}:${String(wrapped % 60).padStart(2, "0")}`;
}

const isPeakDeclared = (date: Date, id: "deepseek" | "ollama" | "zai"): boolean =>
  isPeakRate(date, declaredSchedule(id));

describe("declared rate schedules", () => {
  it("keeps peak hours in the provider JSON, not in code", () => {
    // Reads the declaration through the same accessor the status bar uses.
    expect(providerRateSchedule("deepseek")).toEqual({
      peakWindowsUtc: [
        { startMinute: 60, endMinute: 240 },
        { startMinute: 360, endMinute: 600 },
      ],
      weekendOffsetMinutes: 480,
    });
    expect(declaredSchedule("ollama")).toEqual({
      peakWindowsUtc: [{ startMinute: 720, endMinute: 1080 }],
      weekendOffsetMinutes: 0,
    });
    // The schedule is hours and a weekend calendar, nothing else: a price factor
    // per provider read inconsistently, so the copy carries the discount wording.
    expect(declaredSchedule("zai")).toEqual({
      peakWindowsUtc: [{ startMinute: 360, endMinute: 600 }],
      weekendOffsetMinutes: 480,
    });
    // Only providers that bill a peak rate carry a calendar; the accessor
    // resolves an id, a spec and an unknown id the same way for every caller.
    expect(
      PROVIDER_SPECS.filter((spec) => spec.billing.schedule !== null)
        .map((spec) => spec.id)
        .sort(),
    ).toEqual(["deepseek", "ollama", "zai"]);
    expect(providerRateSchedule("openai")).toBeNull();
    expect(providerRateSchedule(providerSpec("gemini"))).toBeNull();
    expect(providerRateSchedule("no-such-provider")).toBeNull();
  });

  it("spells every declared window in the provider's own rate copy", () => {
    for (const spec of PROVIDER_SPECS) {
      const schedule = spec.billing.schedule;
      if (!schedule) continue;
      const copy = [providerString(spec, "offPeakTitle"), providerString(spec, "peakTitle")]
        .filter((line): line is string => !!line)
        .join(" ");
      expect(copy, `${spec.id} must spell its peak hours`).not.toBe("");
      // A boundary is legitimate in UTC or on the billing calendar (Z.AI names
      // both), so either form satisfies the check and no other clock time does.
      const boundaryForms = schedule.peakWindowsUtc.flatMap((window) =>
        [window.startMinute, window.endMinute].map((minute) => [
          clock(minute),
          clock(minute + schedule.weekendOffsetMinutes),
        ]),
      );
      const mentioned = new Set(copy.match(/\d{1,2}:\d{2}/g) ?? []);
      // Every boundary is spelled out, in UTC or on the billing calendar.
      for (const forms of boundaryForms) {
        expect(
          forms.some((time) => mentioned.has(time)),
          `${spec.id} copy · ${forms[0]}`,
        ).toBe(true);
      }
      // ...and no stale hour lingers from a previous calendar.
      const stale = [...mentioned].filter(
        (time) => !boundaryForms.some((forms) => forms.includes(time)),
      );
      expect(stale, `${spec.id} copy names a stale hour`).toEqual([]);
    }
  });

  it("rejects a malformed window instead of silently never peaking", () => {
    const document = JSON.parse(
      JSON.stringify(PROVIDER_DOCUMENTS.find((entry) => entry.file === "deepseek.json")?.document),
    ) as {
      billing: {
        schedule: {
          peakWindowsUtc: { startMinute: number; endMinute: number }[];
          weekendOffsetMinutes: number;
        };
      };
    };
    const parse = () => parseProviderRegistry({ providers: [document] });
    document.billing.schedule.peakWindowsUtc[0] = { startMinute: 600, endMinute: 600 };
    expect(parse).toThrow(/peakWindowsUtc\[0\]/);

    document.billing.schedule.peakWindowsUtc[0] = { startMinute: 60, endMinute: 1500 };
    expect(parse).toThrow(/minute-of-day/);

    document.billing.schedule.peakWindowsUtc = [];
    expect(parse).toThrow(/at least one window/);

    document.billing.schedule.peakWindowsUtc = [{ startMinute: 60, endMinute: 240 }];
    document.billing.schedule.weekendOffsetMinutes = 2000;
    expect(parse).toThrow(/within one day/);
  });
});

describe("DeepSeek rate periods", () => {
  it.each([
    [0, 59, true], // 00:59 — before the first peak window
    [1, 0, false], // 01:00 — first peak window starts
    [3, 59, false], // 03:59 — still inside the first peak window
    [4, 0, true], // 04:00 — first peak window ends (end-exclusive)
    [5, 59, true], // 05:59 — gap between the two peak windows
    [6, 0, false], // 06:00 — second peak window starts
    [9, 59, false], // 09:59 — still inside the second peak window
    [10, 0, true], // 10:00 — second peak window ends
    [23, 59, true], // 23:59 — off-peak
  ])("UTC %i:%02i off-peak = %s", (hour, minute, offPeak) => {
    expect(isOffPeakRate(weekday(hour, minute), declaredSchedule("deepseek"))).toBe(offPeak);
    expect(isPeakDeclared(weekday(hour, minute), "deepseek")).toBe(!offPeak);
  });

  it("weekends are off-peak all day", () => {
    for (const hour of [1, 3, 6, 9]) {
      expect(isPeakDeclared(saturday(hour), "deepseek")).toBe(false);
      expect(isPeakDeclared(sunday(hour), "deepseek")).toBe(false);
    }
    // Monday — weekday windows resume.
    expect(isPeakDeclared(monday(1), "deepseek")).toBe(true);
  });

  it("reads weekends on the Beijing calendar — Friday 16:00 UTC is already Saturday there", () => {
    const schedule = declaredSchedule("deepseek");
    expect(isRateScheduleWeekend(new Date(Date.UTC(2026, 8, 4, 16)), schedule)).toBe(true); // Sat 00:00 Beijing
    expect(isRateScheduleWeekend(new Date(Date.UTC(2026, 8, 4, 15, 59)), schedule)).toBe(false); // Fri 23:59 Beijing
  });

  it.each([
    [0, 0, 60], // 00:00 → 01:00 (peak)
    [3, 0, 60], // 03:00 → 04:00 (off-peak)
    [5, 0, 60], // 05:00 → 06:00 (peak)
    [9, 0, 60], // 09:00 → 10:00 (off-peak)
    [10, 0, 900], // 10:00 → 01:00 tomorrow (15h) — next day is Friday
    [12, 30, 750], // 12:30 → 01:00 tomorrow (12.5h)
  ])("counts from UTC %i:%02i to the next transition in %i min", (hour, minute, mins) => {
    expect(
      minutesUntilRateChangeForSchedule(weekday(hour, minute), declaredSchedule("deepseek")),
    ).toBe(mins);
  });

  it("counts through weekends to Monday 01:00 UTC", () => {
    const schedule = declaredSchedule("deepseek");
    expect(minutesUntilRateChangeForSchedule(saturday(3), schedule)).toBe(2760); // 46h
    expect(minutesUntilRateChangeForSchedule(sunday(12), schedule)).toBe(780); // 13h
    // Fri 18:00 Beijing → Mon 01:00 UTC = 63h.
    expect(minutesUntilRateChangeForSchedule(new Date(Date.UTC(2026, 8, 4, 10)), schedule)).toBe(
      3780,
    );
  });

  it("resolves the whole period in one call, agreeing with the single-value helpers", () => {
    const schedule = declaredSchedule("deepseek");
    for (const at of [weekday(0), weekday(2), weekday(9, 59), saturday(7), sunday(23, 59)]) {
      const period = ratePeriodForSchedule(at, schedule);
      expect(period.peak).toBe(isPeakRate(at, schedule));
      expect(period.minutesUntilChange).toBe(minutesUntilRateChangeForSchedule(at, schedule));
    }
  });
});

describe("Ollama Cloud rate periods", () => {
  it.each([
    [11, 59, true],
    [12, 0, false],
    [17, 59, false],
    [18, 0, true],
  ])("UTC %i:%02i off-peak = %s", (hour, minute, offPeak) => {
    expect(isOffPeakRate(weekday(hour, minute), declaredSchedule("ollama"))).toBe(offPeak);
    expect(isPeakDeclared(weekday(hour, minute), "ollama")).toBe(!offPeak);
  });

  it("is off-peak throughout UTC weekends", () => {
    expect(isPeakDeclared(saturday(12), "ollama")).toBe(false);
    expect(isPeakDeclared(sunday(17, 59), "ollama")).toBe(false);
  });

  it("counts down through weekends to the next real transition", () => {
    const schedule = declaredSchedule("ollama");
    expect(minutesUntilRateChangeForSchedule(weekday(11, 30), schedule)).toBe(30);
    expect(minutesUntilRateChangeForSchedule(weekday(17, 30), schedule)).toBe(30);
    expect(minutesUntilRateChangeForSchedule(new Date(Date.UTC(2026, 8, 4, 18)), schedule)).toBe(
      3960,
    );
    expect(minutesUntilRateChangeForSchedule(sunday(12), schedule)).toBe(1440);
  });

  it("declares which hosted ids carry the peak price", () => {
    expect(requireProviderSpec("ollama").billing.peakModels).toEqual([
      "deepseek-v4.1-flash",
      "deepseek-v4-pro",
    ]);
    // A provider with no peak rate has no priced ids to inherit either.
    expect(requireProviderSpec("deepseek").billing.peakModels).toEqual([]);
  });

  it("matches a declared peak-priced id regardless of scheme or tag", () => {
    const peakModels = requireProviderSpec("ollama").billing.peakModels;
    for (const id of [
      "ollama/deepseek-v4.1-flash:1017",
      "ollama/deepseek-v4.1-flash:0731",
      "ollama/deepseek-v4-pro:0813",
      "deepseek-v4-pro:1017",
      "deepseek-v4.1-flash",
    ]) {
      expect(isPeakPricedModel(id, peakModels), id).toBe(true);
    }
    for (const id of [
      "ollama/llama3.1:latest",
      "ollama/gemma4",
      "ollama/clef",
      "ollama/deepseek-v4.1-flash-vision-exp",
      "qwen3/llama3.1",
    ]) {
      expect(isPeakPricedModel(id, peakModels), id).toBe(false);
    }
    expect(isPeakPricedModel("deepseek-v4.1-flash", [])).toBe(false);
    expect(isPeakPricedModel("deepseek-v4.1-flash", undefined)).toBe(false);
  });

  it("publishes a row for every id it bills, and prices the scheduled ones", () => {
    const spec = requireProviderSpec("ollama");
    const prices = providerRatePrices(spec);
    expect(prices).not.toBeNull();
    expect(prices!.scheduled).toEqual([...spec.billing.peakModels]);
    expect(prices!.offPeakFactor).toBe(0.5);
    // One triple for every row of the provider, declared once, none per model.
    expect(prices!.multipliers).toEqual({ input: 10, cachedInput: 200, output: 1 });
    // The declared scale the weighted cost divides by, so the multiple is data too.
    expect(prices!.divisor).toBe(5);
    expect(prices!.models["deepseek-v4.1-flash"]).toEqual({
      input: 0.3,
      cachedInput: 0.006,
      output: 1.2,
    });
    expect(prices!.models["deepseek-v4-pro"]).toEqual({
      input: 1.32,
      cachedInput: 0.044,
      output: 3.96,
    });
    // Every id the schedule reprices has a published row to reprice.
    for (const id of spec.billing.peakModels) expect(prices!.models[id], id).toBeDefined();
    // A provider that publishes no token price keeps the chip period-only.
    expect(providerRatePrices("deepseek")).toBeNull();
    expect(providerRatePrices("no-such-provider")).toBeNull();
  });

  it("derives off-peak for the scheduled ids and leaves the rest flat", () => {
    const prices = providerRatePrices("ollama");
    for (const model of ["ollama/deepseek-v4.1-flash:1017", "deepseek-v4-pro"]) {
      const row = ratePricesForModel(model, prices);
      expect(row, model).not.toBeNull();
      expect(row!.offPeak.input).toBeCloseTo(row!.peak.input * 0.5, 6);
      expect(row!.offPeak.cachedInput).toBeCloseTo(row!.peak.cachedInput * 0.5, 6);
      expect(row!.offPeak.output).toBeCloseTo(row!.peak.output * 0.5, 6);
    }
    // An id the schedule does not name bills one price all day.
    const flat = ratePricesForModel("ollama/gemma4", prices);
    expect(flat?.offPeak).toEqual(flat!.peak);
    // The row names the declared id, not the wire id it was asked about.
    expect(ratePricesForModel("ollama/deepseek-v4.1-flash:1017", prices)!.id).toBe(
      "deepseek-v4.1-flash",
    );
    // An id the provider does not price has no row, and neither has a provider
    // that publishes no table at all.
    expect(ratePricesForModel("ollama/llama3.1:latest", prices)).toBeNull();
    expect(ratePricesForModel("deepseek-v4.1-flash", null)).toBeNull();
    // A row that publishes a dash for a column charges nothing for it.
    expect(ratePricesForModel("ollama/clef", prices)).toEqual({
      id: "clef",
      peak: { input: 0.24, cachedInput: 0, output: 0 },
      offPeak: { input: 0.24, cachedInput: 0, output: 0 },
    });
    // A row missing only its cache still resolves, at the tagged wire id.
    expect(ratePricesForModel("ollama/nemotron-3-nano:30b", prices)).toEqual({
      id: "nemotron-3-nano",
      peak: { input: 0.06, cachedInput: 0, output: 0.24 },
      offPeak: { input: 0.06, cachedInput: 0, output: 0.24 },
    });
  });

  it("rejects a schedule or multipliers the declaration cannot back", () => {
    const template = PROVIDER_DOCUMENTS.find((entry) => entry.file === "ollama.json")?.document;
    const withSchedule = JSON.parse(JSON.stringify(template)) as {
      billing: { peakModels: string[] };
    };
    // The schedule may only reprice a published amount.
    withSchedule.billing.peakModels = ["deepseek-v4.1-flash", "gemma4x"];
    expect(() => parseProviderRegistry({ providers: [withSchedule] })).toThrow(/gemma4x/);

    const noMultipliers = JSON.parse(JSON.stringify(template)) as {
      billing: { prices: Record<string, unknown> };
    };
    // Every row is scored by these three values, so a table without them cannot score.
    delete noMultipliers.billing.prices.multipliers;
    expect(() => parseProviderRegistry({ providers: [noMultipliers] })).toThrow(
      /prices\.multipliers/,
    );

    const zeroed = JSON.parse(JSON.stringify(template)) as {
      billing: { prices: { multipliers: Record<string, number> } };
    };
    zeroed.billing.prices.multipliers = { input: 0, cachedInput: 0, output: 0 };
    expect(() => parseProviderRegistry({ providers: [zeroed] })).toThrow(/at least one column/);

    const emptyRow = JSON.parse(JSON.stringify(template)) as {
      billing: { prices: { models: Record<string, Record<string, unknown>> } };
    };
    // A row with every column blank would score 0x, so it is rejected as unpriced.
    emptyRow.billing.prices.models.gemma4 = {};
    expect(() => parseProviderRegistry({ providers: [emptyRow] })).toThrow(
      /models\.gemma4: expected at least one column/,
    );

    const noDivisor = JSON.parse(JSON.stringify(template)) as {
      billing: { prices: Record<string, unknown> };
    };
    // Every multiple divides by the declared scale, so it cannot be omitted or zero.
    delete noDivisor.billing.prices.divisor;
    expect(() => parseProviderRegistry({ providers: [noDivisor] })).toThrow(
      /prices\.divisor/,
    );
    const zeroDivisor = JSON.parse(JSON.stringify(template)) as {
      billing: { prices: { divisor: number } };
    };
    zeroDivisor.billing.prices.divisor = 0;
    expect(() => parseProviderRegistry({ providers: [zeroDivisor] })).toThrow(/above zero/);
  });

  it("charges each column by the provider's declared multipliers", () => {
    // Weights stated once and applied to every row, so no two models are ever scored on
    // different scales. Asserting one column at a time pins which multiplier it takes.
    const declared = { input: 10, cachedInput: 200, output: 1 };
    expect(blendedRateCost({ input: 1, cachedInput: 0, output: 0 }, declared)).toBeCloseTo(10, 6);
    expect(blendedRateCost({ input: 0, cachedInput: 1, output: 0 }, declared)).toBeCloseTo(200, 6);
    expect(blendedRateCost({ input: 0, cachedInput: 0, output: 1 }, declared)).toBeCloseTo(1, 6);
    // The cheapest declared row: 10 * 0.24, with the columns it omits charging nothing.
    expect(blendedRateCost({ input: 0.24, cachedInput: 0, output: 0 }, declared)).toBeCloseTo(
      2.4,
      6,
    );
  });

  it("scores every published row with no model divided by another", () => {
    const prices = providerRatePrices("ollama");
    // Each row's own amounts, charged by the one declared triple.
    const cases: Array<[string, number]> = [
      ["ollama/nemotron-3-nano:30b", 0.168],
      ["ollama/clef", 0.48],
      ["ollama/nemotron-3-super", 0.75],
      ["ollama/deepseek-v4.1-flash:1017", 0.54],
      ["ollama/gpt-oss:120b", 0.98],
      ["ollama/mistral-large-3", 1.3],
      ["ollama/minimax-m3.1-flash", 1.02],
      ["ollama/deepseek-v4-pro", 2.596],
      ["ollama/glm-5.3-flash", 1.6],
      ["ollama/gpt-oss:20b", 1.6],
      ["ollama/gemma4", 2.36],
      ["ollama/minimax-m2.7", 3.24],
      ["ollama/mistral-large-4", 4.578],
      ["ollama/nemotron-3-ultra", 4.8],
      ["ollama/minimax-m3", 6.48],
      ["ollama/kimi-k2.6", 9.1],
      ["ollama/muse-spark-open", 9.35],
      ["ollama/kimi-k2.7-code", 10.3],
      ["ollama/glm-5.3", 14.08],
      ["ollama/kimi-k3", 21],
    ];
    for (const [id, expected] of cases) {
      expect(rateCost(id, prices, false), id).toBeCloseTo(expected, 3);
    }
  });

  it("follows the calendar for a scheduled row and holds a flat one still", () => {
    const prices = providerRatePrices("ollama");
    expect(rateCost("ollama/deepseek-v4-pro", prices, true)).toBeCloseTo(5.192, 3);
    expect(rateCost("ollama/deepseek-v4-pro", prices, false)).toBeCloseTo(2.596, 3);
    // An id the schedule does not reprice costs the same either way.
    expect(rateCost("ollama/gemma4", prices, true)).toBeCloseTo(
      rateCost("ollama/gemma4", prices, false) as number,
      6,
    );
    // No published row, no provider table: no multiple rather than a guess.
    expect(rateCost("ollama/llama3.1:latest", prices, false)).toBeNull();
    expect(rateCost("deepseek-v4.1-flash", null, false)).toBeNull();
    expect(rateCost("deepseek-v4.1-flash", providerRatePrices("deepseek"), false)).toBeNull();
  });

  it("anchors the colour ramp on the multiple itself", () => {
    // 0.5x stays green and 3x turns red; nothing rescales a row against its neighbours.
    expect(rateCost("ollama/nemotron-3-nano:30b", providerRatePrices("ollama"), false)).toBeCloseTo(
      0.168,
      3,
    );
  });
});
describe("Z.AI GLM rate periods", () => {
  it.each([
    [5, 59, true], // 05:59 UTC — before the peak window
    [6, 0, false], // 06:00 UTC = 14:00 SGT — peak starts
    [9, 59, false], // 09:59 UTC = 17:59 SGT — still peak
    [10, 0, true], // 10:00 UTC = 18:00 SGT — peak ends (end-exclusive)
  ])("UTC %i:%02i off-peak = %s", (hour, minute, offPeak) => {
    expect(isOffPeakRate(weekday(hour, minute), declaredSchedule("zai"))).toBe(offPeak);
    expect(isPeakDeclared(weekday(hour, minute), "zai")).toBe(!offPeak);
  });

  it("is off-peak all weekend on the SGT billing calendar", () => {
    expect(isPeakDeclared(saturday(7), "zai")).toBe(false);
    expect(isPeakDeclared(sunday(7), "zai")).toBe(false);
  });


});
