import { describe, expect, it } from "vitest";
import { sanitizeTerminalText, stripAnsi } from "../src/text.js";

const ESC = String.fromCharCode(27);
const BEL = String.fromCharCode(7);

describe("stripAnsi", () => {
  it("removes SGR color sequences", () => {
    expect(stripAnsi(`${ESC}[32m·${ESC}[39m${ESC}[33m·${ESC}[39m`)).toBe("··");
  });

  it("removes OSC sequences terminated by BEL or ST", () => {
    expect(stripAnsi(`${ESC}]8;;https://example.com${BEL}link${ESC}]8;;${BEL}`)).toBe("link");
    expect(stripAnsi(`${ESC}]0;window title${ESC}\\rest`)).toBe("rest");
  });

  it("removes bare Fe escapes and leaves plain text untouched", () => {
    expect(stripAnsi(`${ESC}cplain`)).toBe("plain");
    expect(stripAnsi("no escapes here")).toBe("no escapes here");
  });
});

describe("sanitizeTerminalText", () => {
  it("strips colors and collapses a CR progress line to its surviving frame", () => {
    expect(sanitizeTerminalText(`${ESC}[32m10%${ESC}[0m\r20%\r${ESC}[33m30%`)).toBe("30%");
  });

  it("drops non-printing control bytes but keeps tabs and newlines", () => {
    const raw = `a${String.fromCharCode(7)}b\tc\nd${String.fromCharCode(8)}e`;
    expect(sanitizeTerminalText(raw)).toBe("ab\tc\nde");
  });

  it("drops a trailing lone ESC", () => {
    expect(sanitizeTerminalText(`a${ESC}`)).toBe("a");
  });

  it("is a no-op for ordinary captured text", () => {
    expect(sanitizeTerminalText("Tests 4 passed (4)\n  Duration 1.2s")).toBe(
      "Tests 4 passed (4)\n  Duration 1.2s",
    );
  });
});
