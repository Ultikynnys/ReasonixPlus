/** Parity net for settings persistence: a field the webview can send must have a
 *  `settings_save` branch in the daemon, or its control only ever changes the UI. */

import { readFileSync } from "node:fs";
import { join } from "node:path";
import { describe, expect, it } from "vitest";

const DAEMON = join(process.cwd(), "src/cli/commands/desktop.ts");
const PROTOCOL = join(process.cwd(), "packages/core-utils/src/desktop-protocol.ts");

/** Field names an interface body declares. Comments and nested literals cannot match,
 *  which is why the patch type keeps to named types. */
function interfaceFields(source: string, name: string): string[] {
  const start = source.indexOf(`export interface ${name} {`);
  expect(start, `no interface ${name}`).toBeGreaterThanOrEqual(0);
  const fields: string[] = [];
  for (const line of source.slice(start).split("\n").slice(1)) {
    if (line.startsWith("}")) break;
    const declared = /^ {2}([A-Za-z0-9_]+)\??:/.exec(line);
    if (declared?.[1]) fields.push(declared[1]);
  }
  return fields;
}

/** One command's branch: from its own `if` to the next command branch. */
function commandBranch(command: string): string {
  const source = readFileSync(DAEMON, "utf8");
  const start = source.indexOf(`if (msg.cmd === "${command}")`);
  expect(start, `no ${command} branch in the daemon`).toBeGreaterThanOrEqual(0);
  const next = source.indexOf('if (msg.cmd === "', start + 10);
  return source.slice(start, next > 0 ? next : undefined);
}

const branch = commandBranch("settings_save");
const handled = new Set([...branch.matchAll(/msg\.([A-Za-z0-9_]+)/g)].map((match) => match[1]));
const declared = interfaceFields(readFileSync(PROTOCOL, "utf8"), "SettingsPatch");

/** One field's own branch inside `settings_save`, from its guard to the next guard. */
function fieldBranch(field: string): string {
  const start = branch.indexOf(`if (msg.${field} !== undefined)`);
  expect(start, `no ${field} branch`).toBeGreaterThanOrEqual(0);
  const next = branch.indexOf("if (msg.", start + 10);
  return branch.slice(start, next > 0 ? next : undefined);
}

describe("settings_save wiring", () => {
  it("reads both sides instead of trusting a hand-kept list", () => {
    expect(declared.length).toBeGreaterThan(15);
    expect(declared).toContain("soundPackId");
    expect(handled.size).toBeGreaterThan(15);
  });

  it("persists every field the webview can send", () => {
    // A field with no branch silently reverts on the next echo, because the daemon never
    // heard about it.
    expect(declared.filter((field) => !handled.has(field))).toEqual([]);
  });

  it("carries no branch for a field the patch no longer declares", () => {
    expect([...handled].filter((key) => key !== "cmd" && !declared.includes(key))).toEqual([]);
  });

  it("stores a picked pack, so Use this pack is not a webview-only selection", () => {
    expect(fieldBranch("soundPackId")).toContain("saveSoundPackId(msg.soundPackId)");
  });

  it("re-emits settings after the pack write, so every tab follows the stored pack", () => {
    expect(fieldBranch("soundPackId")).toContain("emitSettings");
  });
});
