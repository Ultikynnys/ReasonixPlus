import { recordFrontendDiagnostic } from "./diagnostics";

export interface LoadingTimingStep {
  step: string;
  tabId?: string;
  deltaMs: number;
  cumulativeMs: number;
  details?: Record<string, unknown>;
}

export class StartupTimingTracker {
  private readonly startedAt: number;
  private lastMark: number;
  private completed = false;

  constructor(startedAt: number = performance.now()) {
    this.startedAt = startedAt;
    this.lastMark = startedAt;
  }

  mark(
    step: string,
    options: { tabId?: string; details?: Record<string, unknown> } = {},
  ): LoadingTimingStep {
    const now = performance.now();
    const deltaMs = Number((now - this.lastMark).toFixed(2));
    const cumulativeMs = Number((now - this.startedAt).toFixed(2));
    this.lastMark = now;

    const entry: LoadingTimingStep = {
      step,
      ...(options.tabId ? { tabId: options.tabId } : {}),
      deltaMs,
      cumulativeMs,
      ...(options.details ? { details: options.details } : {}),
    };
    return entry;
  }

  finish(reason: string, details: Record<string, unknown> = {}): void {
    if (this.completed) return;
    this.completed = true;
    const finalStep = this.mark(`throbber_dismissed:${reason}`, { details });
    // One event per boot: the reason the splash lifted is the only trace of which gate
    // opened first, and the console line that used to carry it is gone.
    recordFrontendDiagnostic(
      "frontend.throbber_dismissed",
      { reason, elapsedMs: finalStep.cumulativeMs, ...details },
      "info",
    );
  }

  fail(reason: string, details: Record<string, unknown> = {}): void {
    if (this.completed) return;
    this.completed = true;
    const finalStep = this.mark(`loading_failed:${reason}`, { details });
    // Keep the failure visible in the in-app diagnostics log now that the console flood is gone.
    recordFrontendDiagnostic(
      "frontend.loading_failed",
      { reason, abortedAfterMs: finalStep.cumulativeMs, ...details },
      "error",
    );
  }
}
