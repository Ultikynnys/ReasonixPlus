import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterAll } from "vitest";

const home = mkdtempSync(join(tmpdir(), "reasonix-test-home-"));
process.env.USERPROFILE = home;
process.env.HOME = home;
Reflect.deleteProperty(process.env, "REASONIX_HOME");

afterAll(() => {
  rmSync(home, { recursive: true, force: true });
});
