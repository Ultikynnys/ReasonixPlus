import { describe, expect, it } from "vitest";
import {
  documentText,
  headingOf,
  isBlocked,
  modelingOf,
  read80Level,
  readArtStation,
  readBlenderJobs,
  readBlobPage,
  readRemoteOk,
  readRepoRoot,
  readTreePage,
  readWeWorkRemotely,
  titleOf,
  visibleText,
} from "../scripts/lib/site-readers.js";

/** Markup shapes below are trimmed copies of the live pages the probe reads. */

describe("github readers", () => {
  it("lists only root-level files, keeping the default branch", () => {
    const html = `
      <html><head><title>repo</title></head><body>
        <a href="/o/r/blob/main/README.md">README</a>
        <a href="/o/r/tree/main/packages">packages</a>
      </body></html>`;
    const facts = readRepoRoot(html);
    expect(facts.title).toBe("repo");
    expect(facts.rootFiles).toEqual(["README.md"]);
    expect(facts.defaultBranch).toBe("main");
  });

  it("returns a folder's children only, not its own breadcrumb", () => {
    // The bug this guards: matching "/tree/main/packages" also matched the page itself.
    const html = `
      <html><body>
        <a href="/o/r/tree/main/packages">packages</a>
        <a href="/o/r/tree/main/packages/core">core</a>
        <a href="/o/r/tree/main/packages/cli">cli</a>
        <a href="/o/r/blob/main/packages/index.ts">index.ts</a>
        <a href="/o/r/tree/main/other">other</a>
      </body></html>`;
    const facts = readTreePage(html, "https://github.com/o/r/tree/main/packages");
    expect(facts.branch).toBe("main");
    expect(facts.folders).toEqual(["core", "cli"]);
    expect(facts.files).toEqual(["index.ts"]);
    expect(facts.folderCount).toBe(2);
  });

  it("reads the line count GitHub prints for a file", () => {
    const html = `<html><body><div>1,234 lines (1,000 loc) · 40.2 KB</div>
      <a href="https://raw.githubusercontent.com/o/r/main/a.ts">Raw</a></body></html>`;
    expect(readBlobPage(html)).toMatchObject({ lineCount: 1234, hasRawLink: true });
  });
});

describe("jobs readers", () => {
  it("takes Blender's role title from the card, not the excerpt", () => {
    const html = `
      <html><body>
        <a href="/jobs/">All jobs</a>
        <a href="https://www.blender.org/jobs/senior-dev/">
          <div class="cards-item-title">Senior Software Engineer</div>
          <div class="cards-item-excerpt">We are looking for a passionate engineer!</div>
        </a>
        <a href="https://www.blender.org/jobs/3d-artist/">
          <div class="cards-item-title">3D Artist</div>
        </a>
      </body></html>`;
    const facts = readBlenderJobs(html);
    expect(facts.roles).toEqual(["Senior Software Engineer", "3D Artist"]);
    expect(facts.openings).toBe(2);
    expect(facts.modeling).toBe(1);
  });

  it("counts ArtStation postings but not studios or the index", () => {
    const html = `
      <html><body>
        <a href="/jobs/all">All</a>
        <a href="/jobs/c/kinkoid-studio">Kinkoid</a>
        <a href="/jobs/nGVq">3D Character Artist</a>
        <a href="/jobs/XLlX">Environment Artist</a>
        <a href="/jobs/nGVq">3D Character Artist again</a>
      </body></html>`;
    const facts = readArtStation(html);
    expect(facts.postings).toBe(2);
    expect(facts.sample).toEqual(["3D Character Artist", "Environment Artist"]);
    expect(facts.modeling).toBe(2);
  });

  it("finds modelling roles among general listings", () => {
    const html = `<html><body>
      <li><h3>Senior 3D Designer</h3></li>
      <li><h3>Account Manager</h3></li>
      <li><h3>Rigger</h3></li>
    </body></html>`;
    expect(readWeWorkRemotely(html)).toMatchObject({ listings: 3, modeling: 2 });
    expect(read80Level(html)).toMatchObject({ modeling: 2 });
  });

  it("reads the RemoteOK JSON array and skips its legal notice", () => {
    const payload = [
      { legal: "API Terms of Service" },
      { position: "Senior 3D Artist", company: "Studio", tags: ["3d", "design"] },
      { position: "Backend Engineer", company: "Shop", tags: ["node"] },
    ];
    // A browser wraps a text/plain JSON body in <pre>; the reader has to unwrap it.
    const html = `<html><body><pre>${JSON.stringify(payload)}</pre></body></html>`;
    const facts = readRemoteOk(html);
    expect(facts.postings).toBe(2);
    expect(facts.modeling).toBe(1);
    expect(facts.modelingTitles).toEqual(["Senior 3D Artist @ Studio"]);
  });

  it("reports a malformed board instead of throwing", () => {
    expect(readRemoteOk("<html><body><pre>not json</pre></body></html>")).toMatchObject({
      parseError: "not JSON",
    });
  });
});

describe("shared extraction", () => {
  it("unwraps a <pre> body and reads title/heading", () => {
    const html =
      '<html><head><title>T</title></head><body><pre>{"a":1}</pre><h1>H</h1></body></html>';
    expect(documentText(html)).toContain('{"a":1}');
    expect(titleOf(html)).toBe("T");
    expect(headingOf(html)).toBe("H");
  });

  it("matches modelling titles on whole words only", () => {
    expect(modelingOf(["3D Artist", "Artisan Baker", "Realtime Rigger"]).count).toBe(2);
    // "Artist" inside "Artisan" is not a role; a bare "Unreal" tag is, which is the
    // price of keyword matching on a listing title.
    expect(modelingOf(["Real Estate Agent"]).count).toBe(0);
  });

  it("does not call a healthy page blocked just because a script mentions captcha", () => {
    // The bug this guards: ArtStation shipped 30 postings and was labelled a wall.
    const healthy = `<html><body><h1>Jobs</h1>
      <script>var cfg = { captcha: "recaptcha-site-key", accessDenied: false };</script>
    </body></html>`;
    expect(visibleText(healthy)).not.toContain("captcha");
    expect(isBlocked(healthy, 200)).toBe(false);
  });

  it("calls a refusal blocked", () => {
    expect(isBlocked("<html><body>Just a moment…</body></html>", 200)).toBe(true);
    expect(isBlocked("", 403)).toBe(true);
    expect(isBlocked("short body", 429)).toBe(true);
    // A challenge page that navigated away leaves nothing to read, only the status.
    expect(isBlocked("", 503)).toBe(true);
    expect(isBlocked("<html><body>fine</body></html>", 200)).toBe(false);
  });
});
