// The settings parity nets read the shared wire contract itself rather than a copy of it:
// one net checks that every patch field reaches a `settings_save` branch, the other that
// every event field reaches the reducer's state.
import { sourceFile } from "./css.js";

/** The protocol module both nets read. */
export const protocolSource = sourceFile("packages/core-utils/src/desktop-protocol.ts");

/** Fields one exported interface declares, in source order. A field is declared on one
 *  line at two-space indent, which is what keeps a nested literal, a method signature or
 *  a comment from reading as a field. */
export function interfaceFields(name: string, source: string = protocolSource): string[] {
  const start = source.indexOf(`export interface ${name} {`);
  if (start === -1) throw new Error(`no interface ${name} in the protocol source`);
  const fields: string[] = [];
  for (const line of source.slice(start).split("\n").slice(1)) {
    if (line.startsWith("}")) return fields;
    const declared = /^ {2}([A-Za-z0-9_]+)\??:/.exec(line);
    if (declared?.[1]) fields.push(declared[1]);
  }
  throw new Error(`interface ${name} is unterminated in the protocol source`);
}
