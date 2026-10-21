/** JobRegistry: the persistent flag surviving session and workspace teardown. Real spawns. */

import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { JobRegistry } from "../src/tools/jobs.js";
import { disposeJobDir, makeJobDir, waitFor } from "./support/job-fixture.js";

describe("JobRegistry persistence", () => {
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

  it(
    "marks jobs persistent and spares them on a session-scoped shutdown",
    { timeout: 20000 },
    async () => {
      const persistent = await registry.start(`node -e "setTimeout(()=>{}, 10000)"`, {
        cwd,
        waitSec: 0.2,
        persistent: true,
      });
      const ephemeral = await registry.start(`node -e "setTimeout(()=>{}, 10000)"`, {
        cwd,
        waitSec: 0.2,
      });
      expect(registry.runningCount()).toBe(2);
      expect(registry.list().find((j) => j.id === persistent.jobId)?.persistent).toBe(true);
      expect(registry.list().find((j) => j.id === ephemeral.jobId)?.persistent).toBe(false);

      // Stop / New chat: session-scoped teardown spares the persistent job.
      await registry.shutdown(3000, { keepPersistent: true });
      await waitFor(() => registry.runningCount() === 1, 3000);
      expect(registry.read(persistent.jobId)?.running).toBe(true);
      expect(registry.read(ephemeral.jobId)?.running).toBe(false);

      // Workspace / app close: a full shutdown kills it too.
      await registry.shutdown(3000);
      await waitFor(() => registry.runningCount() === 0, 3000);
      expect(registry.runningCount()).toBe(0);
    },
  );

  it("cancelAll({ keepPersistent: true }) spares persistent jobs", { timeout: 15000 }, async () => {
    const persistent = await registry.start(`node -e "setTimeout(()=>{}, 10000)"`, {
      cwd,
      waitSec: 0.2,
      persistent: true,
    });
    const ephemeral = await registry.start(`node -e "setTimeout(()=>{}, 10000)"`, {
      cwd,
      waitSec: 0.2,
    });
    registry.cancelAll({ keepPersistent: true });
    expect(registry.read(persistent.jobId)?.running).toBe(true);
    expect(registry.read(ephemeral.jobId)?.running).toBe(false);
  });

  it("stop() ends a persistent job (the explicit close path)", { timeout: 15000 }, async () => {
    const p = await registry.start(`node -e "setTimeout(()=>{}, 10000)"`, {
      cwd,
      waitSec: 0.2,
      persistent: true,
    });
    const rec = await registry.stop(p.jobId, { graceMs: 200 });
    expect(rec?.running).toBe(false);
    expect(rec?.persistent).toBe(true);
  });
});
