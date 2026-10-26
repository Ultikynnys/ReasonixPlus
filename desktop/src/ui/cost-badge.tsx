/** The cost multiple that sits beside a model name: one shape for a picker row, a
 *  composer pill and a Settings row, so the box, the ramp variable and the tooltip can
 *  never drift apart between surfaces. */

import type { ModelCost } from "../model-cost";

export function CostBadge({ cost }: { cost?: ModelCost | null }) {
  if (!cost) return null;
  return (
    <span className="badge cost" style={{ ["--cost-t" as string]: cost.level }} title={cost.title}>
      {cost.label}
    </span>
  );
}
