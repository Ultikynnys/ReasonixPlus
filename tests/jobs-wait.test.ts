/** JobRegistry: waitForJob() wake conditions and output caps. Real spawns, inline `node -e`. */

import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { DEFAULT_READ_MAX_CHARS, JobRegistry } from "../src/tools/jobs.js";
import { disposeJobDir, makeJobDir } from "./support/job-fixture.js";

describe("JobRegistry waitForJob", () => {
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

  it("waitForJob() in output-or-exit mode wakes on new output before timeout", async () => {
    const res = await registry.start(
      `node -e "setTimeout(()=>console.log('second'), 300); setTimeout(()=>{}, 10000)"`,
      { cwd, waitSec: 0.1 },
    );
    const t0 = Date.now();
    const waited = await registry.waitForJob(res.jobId, {
      timeoutMs: 2000,
      waitFor: "output-or-exit",
    });
    const elapsed = Date.now() - t0;
    expect(waited?.exited).toBe(false);
    expect(waited?.exitCode).toBeNull();
    expect(waited?.latestOutput).toContain("second");
    expect(elapsed).toBeGreaterThanOrEqual(200);
    expect(elapsed).toBeLessThan(1500);
  });

  it("waitForJob() default exit mode ignores chatty progress until timeout", async () => {
    const res = await registry.start(
      `node -e "setInterval(()=>console.log('tick'), 50); setTimeout(()=>{}, 10000)"`,
      { cwd, waitSec: 0.1 },
    );
    const t0 = Date.now();
    const waited = await registry.waitForJob(res.jobId, { timeoutMs: 600 });
    const elapsed = Date.now() - t0;
    expect(waited?.exited).toBe(false);
    expect(waited?.exitCode).toBeNull();
    expect(elapsed).toBeGreaterThanOrEqual(550);
    expect(elapsed).toBeLessThan(1200);
  });

  it("waitForJob() default exit mode wakes on actual exit even with chatty output", async () => {
    const res = await registry.start(
      `node -e "const t=setInterval(()=>console.log('tick'),50); setTimeout(()=>{clearInterval(t); console.log('done'); process.exit(3)}, 400)"`,
      { cwd, waitSec: 0.1 },
    );
    const t0 = Date.now();
    const waited = await registry.waitForJob(res.jobId, { timeoutMs: 5000 });
    const elapsed = Date.now() - t0;
    expect(waited?.exited).toBe(true);
    expect(waited?.exitCode).toBe(3);
    expect(waited?.latestOutput).toContain("done");
    expect(elapsed).toBeLessThan(2000);
  });

  it("waitForJob() accepts timeoutMs up to the 300_000 cap", async () => {
    const res = await registry.start(`node -e "process.exit(0)"`, { cwd, waitSec: 1 });
    const waited = await registry.waitForJob(res.jobId, { timeoutMs: 250_000 });
    expect(waited?.exited).toBe(true);
    expect(waited?.exitCode).toBe(0);
  });

  it("waitForJob() returns immediately for an already-exited job", async () => {
    const res = await registry.start(`node -e "console.log('done'); process.exit(7)"`, {
      cwd,
      waitSec: 2,
    });
    const t0 = Date.now();
    const waited = await registry.waitForJob(res.jobId, { timeoutMs: 2000 });
    const elapsed = Date.now() - t0;
    expect(waited?.exited).toBe(true);
    expect(waited?.exitCode).toBe(7);
    expect(waited?.latestOutput).toContain("done");
    expect(elapsed).toBeLessThan(200);
  });

  it("waitForJob() times out cleanly when nothing changes", async () => {
    const res = await registry.start(`node -e "setTimeout(()=>{}, 10000)"`, {
      cwd,
      waitSec: 0.1,
    });
    const waited = await registry.waitForJob(res.jobId, { timeoutMs: 150 });
    expect(waited?.exited).toBe(false);
    expect(waited?.exitCode).toBeNull();
    expect(waited?.latestOutput).toBe("");
  });

  it("waitForJob() caps latestOutput to the char budget", { timeout: 20000 }, async () => {
    const cmd = `node -e "for (let i=0;i<9000;i++) console.log('line'+i+'-'+'y'.repeat(30)); process.exit(0)"`;
    const res = await registry.start(cmd, { cwd, waitSec: 0.1 });
    const waited = await registry.waitForJob(res.jobId, { timeoutMs: 8000 });
    expect(waited?.latestOutput.length ?? 0).toBeLessThanOrEqual(DEFAULT_READ_MAX_CHARS + 120);
  });
});
