/** Shared approval-gate test double: answers every gate.ask with a fixed verdict,
 *  records the kinds seen, and registers a listener so hasListeners() is true. */

import { type ConfirmationChoice, PauseGate } from "../../src/core/pause-gate.js";

export class ScriptedGate extends PauseGate {
  readonly kinds: string[] = [];
  private readonly choice: ConfirmationChoice;
  constructor(choice: ConfirmationChoice) {
    super();
    this.choice = choice;
    this.on(() => {});
  }
  override ask = ((opts: { kind: string }) => {
    this.kinds.push(opts.kind);
    return Promise.resolve(this.choice);
  }) as PauseGate["ask"];
}
