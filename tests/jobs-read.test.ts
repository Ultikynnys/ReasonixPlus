/** JobRegistry: read() output view, cursors and the char-budget cap. Real spawns, inline `node -e`. */

import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { DEFAULT_READ_MAX_CHARS, JobRegistry } from "../src/tools/jobs.js";
import { disposeJobDir, makeJobDir, waitFor } from "./support/job-fixture.js";

describe("JobRegistry reads", () => {
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

  it("read(jobId) returns live output and running flag", async () => {
    const cmd = `node -e "console.log('a'); setTimeout(() => console.log('b'), 80); setTimeout(() => {}, 10000)"`;
    const res = await registry.start(cmd, { cwd, waitSec: 1.5 });
    let early = registry.read(res.jobId);
    for (let i = 0; i < 20 && !early?.output.includes("a"); i++) {
      await new Promise((r) => setTimeout(r, 100));
      early = registry.read(res.jobId);
    }
    expect(early?.running).toBe(true);
    expect(early?.output).toContain("a");
    let later = registry.read(res.jobId);
    for (let i = 0; i < 20 && !later?.output.includes("b"); i++) {
      await new Promise((r) => setTimeout(r, 100));
      later = registry.read(res.jobId);
    }
    expect(later?.output).toContain("b");
    expect((later?.byteLength ?? 0) >= (early?.byteLength ?? 0)).toBe(true);
  });

  it("read supports `since` for incremental polling", async () => {
    // `first` prints synchronously at child startup so snap catches it
    // reliably; `second` is delayed well past the waitSec ceiling so it
    // arrives AFTER the snapshot, guaranteeing the `since`-slice actually
    // has new bytes to return.
    const cmd = `node -e "console.log('first'); setTimeout(()=>console.log('second'), 1500); setTimeout(()=>{}, 10000)"`;
    const res = await registry.start(cmd, { cwd, waitSec: 0.6 });
    // Poll briefly in case Windows node startup is slow — we need
    // `first` in the buffer before capturing the cursor, otherwise the
    // whole premise of the test falls apart.
    let snap = registry.read(res.jobId);
    for (let i = 0; i < 10 && !snap?.output.includes("first"); i++) {
      await new Promise((r) => setTimeout(r, 100));
      snap = registry.read(res.jobId);
    }
    expect(snap?.output).toContain("first");
    expect(snap?.output).not.toContain("second");
    const cursor = snap?.byteLength ?? 0;
    expect(cursor).toBeGreaterThan(0);
    // Wait past the delayed print so we have new content.
    await new Promise((r) => setTimeout(r, 1800));
    const delta = registry.read(res.jobId, { since: cursor });
    expect(delta?.output).not.toContain("first");
    expect(delta?.output).toContain("second");
  });

  it("tailLines caps returned output to the last N lines", async () => {
    const cmd = `node -e "for (let i=0;i<50;i++) console.log('line'+i); setTimeout(()=>{}, 10000)"`;
    const res = await registry.start(cmd, { cwd, waitSec: 0.5 });
    await waitFor(() => registry.read(res.jobId)?.output.includes("line49") ?? false, 3000);
    const tailed = registry.read(res.jobId, { tailLines: 5 });
    const lines = (tailed?.output ?? "").split("\n").filter(Boolean);
    expect(lines.length).toBeLessThanOrEqual(5);
    expect(tailed?.output).toContain("line49");
    expect(tailed?.output).not.toContain("line0\n");
  });

  it(
    "read() caps a dense buffer to the char budget (context guard)",
    { timeout: 20000 },
    async () => {
      const cmd = `node -e "for (let i=0;i<9000;i++) console.log('line'+i+'-'+'y'.repeat(30))"`;
      const res = await registry.start(cmd, { cwd, waitSec: 3 });
      await registry.waitForJob(res.jobId, { timeoutMs: 8000 });
      const full = registry.read(res.jobId, { tailLines: 0 });
      expect(full?.output.length ?? 0).toBeLessThanOrEqual(DEFAULT_READ_MAX_CHARS + 120);
      expect(full?.output).toContain("elided");
      // A plain tail read is bounded too.
      const tail = registry.read(res.jobId);
      expect(tail?.output.length ?? 0).toBeLessThanOrEqual(DEFAULT_READ_MAX_CHARS + 120);
    },
  );

  it(
    "read({ since }) caps a head read and points at the next cursor",
    { timeout: 20000 },
    async () => {
      const cmd = `node -e "for (let i=0;i<9000;i++) console.log('line'+i+'-'+'y'.repeat(30))"`;
      const res = await registry.start(cmd, { cwd, waitSec: 3 });
      await registry.waitForJob(res.jobId, { timeoutMs: 8000 });
      const head = registry.read(res.jobId, { since: 0 });
      expect(head?.output.length ?? 0).toBeLessThanOrEqual(DEFAULT_READ_MAX_CHARS + 120);
      expect(head?.output).toContain("continue with since=");
    },
  );
});
