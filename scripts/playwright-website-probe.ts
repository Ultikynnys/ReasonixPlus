/** Drives the real managed WebKit at real websites and reports what it can extract.
 *  Run from source: `npm run probe:websites [-- --only jobs] [-- --json]`. */
import { parse as parseHtml } from "node-html-parser";
import { closeBrowserSearches, withManagedPage } from "../src/tools/browser-search.js";
import {
  documentText,
  headingOf,
  isBlocked,
  read80Level,
  readArtStation,
  readBlenderJobs,
  readBlobPage,
  readRemoteOk,
  readRepoRoot,
  readTreePage,
  readWeWorkRemotely,
  titleOf,
} from "./lib/site-readers.js";

/** Blender docs the probe looks for: the manual aliases the current LTS, so this pins
 *  the version being read rather than whatever is newest. */
const VERSION = "5.2";

interface Scenario {
  name: string;
  /** Group used by --only. */
  group: string;
  url: string;
  /** Selector worth waiting for; a timeout is reported, never fatal. */
  waitFor?: string;
  /** How this site is allowed to end: "ok" needs the predicate, "blocked" and "timeout"
   *  record an anti-bot wall or an unreachable host as the expected result. */
  expectation?: "ok" | "blocked" | "timeout";
  expect?: (facts: Record<string, unknown>) => boolean;
  /** Facts this page exposes, read from its HTML. */
  read: (html: string, url: string) => Record<string, unknown>;
}

/** A readable JSON body, unwrapped from the `<pre>` a browser renders it in. */
function readJsonBody(pick: (body: Record<string, unknown>) => Record<string, unknown>) {
  return (html: string): Record<string, unknown> => {
    try {
      return pick(JSON.parse(documentText(html)) as Record<string, unknown>);
    } catch {
      return { parseError: "not JSON", head: documentText(html).slice(0, 120) };
    }
  };
}

const SCENARIOS: Scenario[] = [
  {
    name: "jobs: blender.org openings",
    group: "jobs",
    url: "https://www.blender.org/jobs/",
    waitFor: 'a[href*="/jobs/"]',
    expect: (facts) => Number(facts.openings) >= 1,
    read: readBlenderJobs,
  },
  {
    name: "jobs: we work remotely (design)",
    group: "jobs",
    url: "https://weworkremotely.com/categories/remote-design-jobs",
    waitFor: "li h3, h3",
    expect: (facts) => Number(facts.listings) >= 5 && Number(facts.modeling) >= 1,
    read: readWeWorkRemotely,
  },
  {
    name: "jobs: artstation (art postings)",
    group: "jobs",
    url: "https://www.artstation.com/jobs",
    waitFor: 'a[href*="/jobs/"]',
    expect: (facts) => Number(facts.postings) >= 10,
    read: readArtStation,
  },
  {
    name: "jobs: remoteok api (json board)",
    group: "jobs",
    url: "https://remoteok.com/api",
    expect: (facts) => Number(facts.postings) >= 50,
    read: readRemoteOk,
  },
  {
    name: "jobs: 80.lv (game art board)",
    group: "jobs",
    url: "https://80.lv/jobs",
    waitFor: "h2, h3",
    expect: (facts) => Number(facts.modeling) >= 3,
    read: read80Level,
  },
  {
    name: "jobs: behance (expects an anti-bot wall)",
    group: "jobs",
    url: "https://www.behance.net/joblist",
    expectation: "blocked",
    read: () => ({}),
  },
  {
    name: "jobs: cgsociety (expects a dead host)",
    group: "jobs",
    url: "https://www.cgsociety.org/jobs",
    expectation: "timeout",
    read: () => ({}),
  },
  {
    name: "github repo root",
    group: "github",
    url: "https://github.com/microsoft/playwright",
    waitFor: 'a[href*="/blob/"]',
    expect: (facts) => Number(facts.rootFileCount) > 0,
    read: readRepoRoot,
  },
  {
    name: "github folder listing",
    group: "github",
    url: "https://github.com/microsoft/playwright/tree/main/packages",
    waitFor: '[aria-label="Files"], [role="grid"]',
    expect: (facts) => Number(facts.folderCount) + Number(facts.fileCount) >= 5,
    read: readTreePage,
  },
  {
    name: "github blob page (file info)",
    group: "github",
    url: "https://github.com/microsoft/playwright/blob/main/package.json",
    waitFor: 'a[href*="raw.githubusercontent.com"]',
    expect: (facts) => facts.hasRawLink === true || Number(facts.lineCount) > 0,
    read: readBlobPage,
  },
  {
    name: "github raw file (contents)",
    group: "github",
    url: "https://raw.githubusercontent.com/microsoft/playwright/main/package.json",
    expect: (facts) => typeof facts.version === "string",
    read: readJsonBody((pkg) => ({
      name: pkg.name,
      version: pkg.version,
      scripts: Object.keys((pkg.scripts as object) ?? {}).length,
    })),
  },
  {
    name: "github api contents (authoritative file info)",
    group: "github",
    url: "https://api.github.com/repos/microsoft/playwright/contents/package.json",
    expect: (facts) => typeof facts.size === "number",
    read: readJsonBody((body) => ({
      size: body.size,
      sha: body.sha,
      downloadUrl: Boolean(body.download_url),
    })),
  },
  {
    name: "documentation page",
    group: "docs",
    url: "https://playwright.dev/docs/browsers",
    waitFor: "main h1",
    expect: (facts) => String(facts.title).length > 0,
    read: (html) => ({
      title: titleOf(html),
      heading: headingOf(html),
      paragraphs: parseHtml(html).querySelectorAll("main p").length,
    }),
  },
  {
    name: "blender api docs: which versions exist",
    group: "blender",
    url: "https://docs.blender.org/api/",
    expect: (facts) => (facts.versions as string[]).includes(VERSION),
    read: (html) => {
      const versions = new Set<string>();
      for (const link of parseHtml(html).querySelectorAll("a[href]")) {
        const match = /(?:^|\/)(\d+\.\d+)\/?$/.exec(link.getAttribute("href") ?? "");
        if (match?.[1]) versions.add(match[1]);
      }
      const sorted = [...versions].sort((a, b) => Number(b) - Number(a));
      return { title: titleOf(html), versions: sorted, newest: sorted[0] ?? null };
    },
  },
  {
    name: "blender manual root (aliases the current LTS)",
    group: "blender",
    url: "https://docs.blender.org/manual/",
    waitFor: "h1",
    expect: (facts) => String(facts.title).includes(VERSION),
    read: (html) => ({
      title: titleOf(html),
      heading: headingOf(html),
      chapters: parseHtml(html).querySelectorAll("a.reference.internal").length,
    }),
  },
  {
    name: `blender ${VERSION} manual page`,
    group: "blender",
    url: `https://docs.blender.org/manual/en/${VERSION}/modeling/meshes/index.html`,
    waitFor: "h1",
    expect: (facts) => String(facts.heading).includes("Mesh"),
    read: (html) => ({
      title: titleOf(html),
      heading: headingOf(html),
      sections: parseHtml(html).querySelectorAll("section").length,
      version: new RegExp(VERSION.replace(".", "\\.")).test(html),
    }),
  },
  {
    name: `blender ${VERSION} python api: bpy.types.Mesh members`,
    group: "blender",
    url: `https://docs.blender.org/api/${VERSION}/bpy.types.Mesh.html`,
    waitFor: "dl, h1",
    expect: (facts) => (facts.attributes as string[]).includes("vertices"),
    read: (html) => {
      const root = parseHtml(html);
      // Sphinx's py-domain: each member is a `<dt id="bpy.types.Mesh.x">` inside a
      // `<dl class="py method|attribute|property">`, which is where its kind lives.
      const rows = root.querySelectorAll("dt[id]").flatMap((node) => {
        const id = (node.getAttribute("id") ?? "").replace(/^bpy\.types\.Mesh\./, "");
        if (!id || id.startsWith("bpy.types.Mesh")) return [];
        const kind =
          (node.parentNode?.getAttribute("class") ?? "")
            .split(" ")
            .find((name) => ["method", "attribute", "property"].includes(name)) ?? "other";
        return [{ id, kind }];
      });
      return {
        title: titleOf(html),
        heading: headingOf(html),
        entryCount: rows.length,
        attributes: rows.filter((row) => row.kind !== "method").map((row) => row.id),
        methods: rows.filter((row) => row.kind === "method").map((row) => row.id),
      };
    },
  },
];

type OutcomeKind = "data" | "blocked" | "timeout" | "error";

interface Outcome {
  name: string;
  url: string;
  bytes: number | null;
  httpStatus: number | null;
  milliseconds: number;
  waited: "found" | "timeout" | "skipped";
  facts: Record<string, unknown>;
  kind: OutcomeKind;
  ok: boolean;
  error?: string;
}

async function runScenario(scenario: Scenario): Promise<Outcome> {
  const started = Date.now();
  const base = { name: scenario.name, url: scenario.url };
  try {
    const result = await withManagedPage(
      "webkit",
      (key, params) => (params ? `${key}: ${JSON.stringify(params)}` : key),
      async (page) => {
        const response = await page.goto(scenario.url, {
          waitUntil: "domcontentloaded",
          timeout: 30_000,
        });
        let waited: Outcome["waited"] = "skipped";
        if (scenario.waitFor) {
          try {
            await page.waitForSelector(scenario.waitFor, { timeout: 15_000 });
            waited = "found";
          } catch {
            waited = "timeout";
          }
        }
        // A challenge page starts navigating away, and content() then refuses to read it.
        const httpStatus = response?.status() ?? null;
        let html = "";
        try {
          html = await page.content();
        } catch {
          html = "";
        }
        return { html, httpStatus, waited };
      },
    );
    const facts = scenario.read(result.html, scenario.url);
    const blocked = isBlocked(result.html, result.httpStatus);
    const kind: OutcomeKind = blocked ? "blocked" : "data";
    const wanted = scenario.expectation ?? "ok";
    const ok =
      wanted === "blocked"
        ? blocked
        : wanted === "ok"
          ? !blocked && !!scenario.expect?.(facts)
          : false;
    return {
      ...base,
      bytes: result.html.length,
      httpStatus: result.httpStatus,
      milliseconds: Date.now() - started,
      waited: result.waited,
      facts,
      kind,
      ok,
    };
  } catch (err) {
    const message = err instanceof Error ? err.message.split("\n")[0]! : String(err);
    const timedOut = /timeout|timed out/i.test(message);
    return {
      ...base,
      bytes: null,
      httpStatus: null,
      milliseconds: Date.now() - started,
      waited: "skipped",
      facts: {},
      kind: timedOut ? "timeout" : "error",
      ok: scenario.expectation === "timeout" && timedOut,
      error: message,
    };
  }
}

const args = process.argv.slice(2);
const only = args.includes("--only") ? args[args.indexOf("--only") + 1] : undefined;
const asJson = args.includes("--json");

const outcomes: Outcome[] = [];
for (const scenario of SCENARIOS.filter((item) => !only || item.group === only)) {
  outcomes.push(await runScenario(scenario));
}
await closeBrowserSearches();

if (asJson) {
  console.log(JSON.stringify(outcomes, null, 2));
} else {
  for (const outcome of outcomes) {
    const size = outcome.bytes === null ? "—" : `${Math.round(outcome.bytes / 1024)} KB`;
    console.log(`\n${outcome.ok ? "PASS" : "FAIL"}  ${outcome.name}  (${outcome.milliseconds}ms)`);
    console.log(`      ${outcome.url}`);
    console.log(
      `      http ${outcome.httpStatus ?? "—"} · ${size} · wait ${outcome.waited} · ${outcome.kind}${outcome.error ? ` · error ${outcome.error}` : ""}`,
    );
    for (const [key, value] of Object.entries(outcome.facts)) {
      const rendered = Array.isArray(value) ? `[${value.join(", ")}]` : String(value);
      console.log(`      ${key}: ${rendered.slice(0, 160)}`);
    }
  }
  const failed = outcomes.filter((outcome) => !outcome.ok).length;
  console.log(`\n${outcomes.length - failed}/${outcomes.length} scenarios passed`);
}

process.exit(outcomes.every((outcome) => outcome.ok) ? 0 : 1);
