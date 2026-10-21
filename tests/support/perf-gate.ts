import { existsSync } from "node:fs";
import { join } from "node:path";

const flag = (process.env.REASONIX_PERF ?? "").trim().toLowerCase();

/** Scale/perf probes cost tens of seconds and cannot fail except on a blow-up, so
 *  they stay out of `npm test`. Turn them on with `npm run test:perf`, or touch
 *  local/perf-probe/.scale (gitignored) for a one-off `npx vitest run`. */
export const PERF_ENABLED =
  flag === "1" ||
  flag === "true" ||
  flag === "yes" ||
  existsSync(join(process.cwd(), "local", "perf-probe", ".scale"));
