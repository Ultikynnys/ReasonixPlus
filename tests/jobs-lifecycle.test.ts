/** JobRegistry: start/read/stop/list/shutdown over real spawns via inline `node -e` scripts. */

import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { JobRegistry } from "../src/tools/jobs.js";
import { disposeJobDir, makeJobDir, waitFor } from "./support/job-fixture.js";

describe("JobRegistry lifecycle", () => {
  let cwd: string;
  let registry: JobRegistry;

  beforeEach(() => {
    cwd = makeJobDir();
    registry = new JobRegistry();
  });
  afterEach(async () => {
    await registry.shutdown(1500);
    await disposeJobDir(cwd);
  });

  it("returns after waitSec for a process that stays alive", async () => {
    // Long-lived child that prints a line and sleeps 10s. We'll return
    // after waitSec=1 while it's still running.
    const cmd = `node -e "console.log('hi'); setTimeout(() => {}, 10000)"`;
    const t0 = Date.now();
    const res = await registry.start(cmd, { cwd, waitSec: 1 });
    const elapsed = Date.now() - t0;
    expect(res.stillRunning).toBe(true);
    expect(res.preview).toContain("hi");
    expect(elapsed).toBeGreaterThanOrEqual(900);
    // readiness pattern may or may not match "hi" depending on env;
    // the test's primary claim is "we came back without waiting 10s".
    expect(elapsed).toBeLessThan(3000);
  });

  it("short-circuits on ready signal before waitSec elapses", async () => {
    // Print a known ready banner immediately; waitSec=5 should be
    // cut short when the regex fires.
    const cmd = `node -e "console.log('listening on http://localhost:1234'); setTimeout(() => {}, 10000)"`;
    const t0 = Date.now();
    const res = await registry.start(cmd, { cwd, waitSec: 5 });
    const elapsed = Date.now() - t0;
    expect(res.stillRunning).toBe(true);
    expect(res.readyMatched).toBe(true);
    // Must be well under the 5s ceiling — startup + ready-regex match
    // should land in a few hundred ms at most.
    expect(elapsed).toBeLessThan(2500);
  });

  it("captures exit code when the child dies during wait", async () => {
    const cmd = `node -e "console.log('bye'); process.exit(7)"`;
    const res = await registry.start(cmd, { cwd, waitSec: 3 });
    expect(res.stillRunning).toBe(false);
    expect(res.exitCode).toBe(7);
    expect(res.preview).toContain("bye");
  });

  it("stop() kills a running job", { timeout: 15000 }, async () => {
    const cmd = `node -e "setTimeout(()=>{}, 10000)"`;
    const res = await registry.start(cmd, { cwd, waitSec: 0.2 });
    expect(res.stillRunning).toBe(true);
    const rec = await registry.stop(res.jobId, { graceMs: 200 });
    expect(rec?.running).toBe(false);
  });

  it("stop() on an already-exited job is idempotent", async () => {
    const cmd = `node -e "process.exit(0)"`;
    const res = await registry.start(cmd, { cwd, waitSec: 2 });
    expect(res.stillRunning).toBe(false);
    const rec = await registry.stop(res.jobId);
    expect(rec?.running).toBe(false);
    expect(rec?.exitCode).toBe(0);
  });

  it("list() reports running and exited jobs together", async () => {
    const running = await registry.start(`node -e "setTimeout(()=>{}, 10000)"`, {
      cwd,
      waitSec: 0.2,
    });
    const exited = await registry.start(`node -e "process.exit(0)"`, { cwd, waitSec: 2 });
    const rows = registry.list();
    expect(rows).toHaveLength(2);
    const r1 = rows.find((r) => r.id === running.jobId);
    const r2 = rows.find((r) => r.id === exited.jobId);
    expect(r1?.running).toBe(true);
    expect(r2?.running).toBe(false);
    expect(r2?.exitCode).toBe(0);
  });

  it("runningCount() reflects live state", { timeout: 15000 }, async () => {
    expect(registry.runningCount()).toBe(0);
    const a = await registry.start(`node -e "setTimeout(()=>{}, 10000)"`, { cwd, waitSec: 0.2 });
    expect(registry.runningCount()).toBe(1);
    await registry.stop(a.jobId);
    // Windows taskkill /T resolves before the OS finishes reaping the
    // child tree; poll briefly so we test "settles to 0", not "is 0 right now".
    await waitFor(() => registry.runningCount() === 0, 2000);
    expect(registry.runningCount()).toBe(0);
  });

  it("rejects shell operators with a clear message", async () => {
    await expect(registry.start("echo hi | grep h", { cwd })).rejects.toThrow(/shell operator/);
  });

  it("read() returns null for unknown job id", () => {
    expect(registry.read(999)).toBeNull();
  });

  it("shutdown() kills all running jobs", { timeout: 15000 }, async () => {
    await registry.start(`node -e "setTimeout(()=>{}, 10000)"`, { cwd, waitSec: 0.2 });
    await registry.start(`node -e "setTimeout(()=>{}, 10000)"`, { cwd, waitSec: 0.2 });
    expect(registry.runningCount()).toBe(2);
    // Conversation cancellation and a repeated Stop can race two shutdown calls.
    // Both must settle while the registry converges to no live processes.
    await Promise.all([registry.shutdown(4000), registry.shutdown(4000)]);
    await waitFor(() => registry.runningCount() === 0, 2000);
    expect(registry.runningCount()).toBe(0);
  });

  it("cancelAll() force-kills every running job immediately", { timeout: 15000 }, async () => {
    await registry.start(`node -e "setTimeout(()=>{}, 10000)"`, { cwd, waitSec: 0.2 });
    await registry.start(`node -e "setTimeout(()=>{}, 10000)"`, { cwd, waitSec: 0.2 });
    expect(registry.runningCount()).toBe(2);
    // Synchronous force-cancel — no SIGTERM grace, so the count drops to 0
    // before the fold's summary call that follows it in the loop.
    registry.cancelAll();
    expect(registry.runningCount()).toBe(0);
    // list() must no longer report the jobs as running, either.
    expect(registry.list().every((j) => !j.running)).toBe(true);
  });
});
