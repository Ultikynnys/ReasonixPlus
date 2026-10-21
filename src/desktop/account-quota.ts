import type { CodexQuotaResult } from "../codex-backend.js";
import { QuotaCoordinator, type QuotaFetchObserver } from "./quota.js";

export type {
  QuotaDelivery,
  QuotaDeliveryResult,
} from "./quota.js";
export type { QuotaFetchObserver };

/** ChatGPT-plan Codex quota. A reply with no windows is a failure (not signed in,
 *  rejected, malformed), so it is never cached: the next read retries instead of
 *  serving "no data" for a whole TTL. */
export class AccountQuotaCoordinator extends QuotaCoordinator<CodexQuotaResult> {
  constructor(
    fetcher: () => Promise<CodexQuotaResult>,
    ttlMs = 15_000,
    now: () => number = Date.now,
    observer: QuotaFetchObserver<CodexQuotaResult> = {},
  ) {
    super(
      fetcher,
      ttlMs,
      {
        hasData: (value) => value.quota !== null,
        // A no-data reply must stay retryable: caching it would serve "not signed
        // in" for a whole TTL after the user signs in.
        cacheable: (value) => value.quota !== null,
        reason: (value) => value.reason,
      },
      now,
      observer,
    );
  }
}
