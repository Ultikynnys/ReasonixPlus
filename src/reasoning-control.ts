import {
  type ProviderReasoningRule,
  type ReasoningEffort,
  modelReasoningContract,
  resolveReasoningEffort,
} from "@reasonix/core-utils";

/** One request's effort decision after the model's contract, the user's toggle
 *  and the model's real ladder are combined. Every wire builder reads this so
 *  the same request cannot disagree with itself across transports. */
export interface ReasoningControl {
  contract: ProviderReasoningRule;
  /** Level expressible on the wire, or undefined when the model has no ladder. */
  effort?: ReasoningEffort;
  thinking?: "enabled" | "disabled";
  /** Application budget preset, when the contract controls depth by budget. */
  budget?: number;
}

export interface ReasoningControlInput {
  provider: string;
  model: string;
  reasoningEffort?: ReasoningEffort;
  thinking?: "enabled" | "disabled";
  /** Levels the model actually accepts, from discovery or the declaration. */
  supported: readonly ReasoningEffort[];
}

export function reasoningControl(input: ReasoningControlInput): ReasoningControl {
  const contract = modelReasoningContract(input.provider, input.model);
  // A forced-thinking model cannot honor "disabled": GLM-5.3 and Gemini 2.5 Pro
  // keep thinking on and would reject or ignore the off signal.
  const disabled = input.thinking === "disabled" && !contract.forcedThinking;
  const thinking = contract.forcedThinking ? "enabled" : disabled ? "disabled" : input.thinking;
  const effort =
    disabled || input.reasoningEffort === undefined
      ? undefined
      : (resolveReasoningEffort(
          input.provider,
          input.model,
          input.reasoningEffort,
          input.supported,
        ) ?? undefined);
  return {
    contract,
    ...(effort ? { effort } : {}),
    ...(thinking ? { thinking } : {}),
    ...(effort !== undefined && contract.budgets[effort] !== undefined
      ? { budget: contract.budgets[effort] }
      : {}),
  };
}
