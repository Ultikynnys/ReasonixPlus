import { lookup } from "node:dns/promises";
import { existsSync, mkdtempSync, readFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { SEARCH_ENGINE_SPECS, searchEngineDeclared } from "@reasonix/core-utils";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { loadBaiduApiKey, loadMetasoApiKey, writeConfig } from "../src/config.js";
import { ToolRegistry } from "../src/tools.js";
import {
  __setBrowserCoreLoaderForTests,
  closeBrowserSearches,
} from "../src/tools/browser-search.js";
import {
  closeWebFetchPages,
  fillQueryTemplate,
  formatSearchResults,
  htmlToText,
  parseBingResults,
  parseSearxngHtmlResults,
  registerWebTools,
  webFetch,
  webSearch,
} from "../src/tools/web.js";
import { pageStub } from "./support/page-stub.js";

vi.mock("node:dns/promises", () => ({
  lookup: vi.fn(async () => [{ address: "93.184.216.34", family: 4 }]),
}));

describe("htmlToText", () => {
  it("strips script/style/nav/footer and preserves paragraph breaks", () => {
    const html = `
      <html><head><title>x</title><style>body{color:red}</style></head>
      <body>
        <nav><a>skip</a></nav>
        <p>Hello <strong>world</strong>.</p>
        <p>Second paragraph.</p>
        <script>evil()</script>
        <footer>fine print</footer>
      </body></html>
    `;
    const out = htmlToText(html);
    expect(out).toContain("Hello world.");
    expect(out).toContain("Second paragraph.");
    expect(out).not.toContain("evil");
    expect(out).not.toContain("skip");
    expect(out).not.toContain("fine print");
    expect(out).not.toContain("color:red");
    expect(out).toMatch(/Hello world\.\n\nSecond paragraph\./);
  });

  it("drops the doctype the parser reports as text", () => {
    // A rendered document starts with the declaration; it must not lead the extracted text.
    const out = htmlToText("<!DOCTYPE html><html><body><p>Body copy</p></body></html>");
    expect(out).toBe("Body copy");
  });

  it("decodes the common entities", () => {
    expect(htmlToText("<p>a &amp; b &lt;c&gt; &quot;d&quot;</p>")).toContain('a & b <c> "d"');
  });

  it("collapses whitespace runs but keeps paragraph breaks", () => {
    const out = htmlToText("<p>one    two</p><p>three</p>");
    expect(out).toBe("one two\n\nthree");
  });
});

describe("parseBingResults", () => {
  // Fixture mirrors the shape cn.bing.com returns as of 2026-05 (captured live).
  // Each result is a `<li class="b_algo">` with `<h2><a href>` + `<div class="b_caption"><p>`.
  const sampleHtml = `
    <ol id="b_results">
      <li class="b_algo" data-id iid=SERP.5339>
        <h2 class="">
          <a target="_blank" href="https://example.com/a" h="ID=SERP,5145.2">
            <strong>Flutter</strong> 3.19 release notes
          </a>
        </h2>
        <div class="b_caption">
          <p class="b_lineclamp2">Flutter 3.19 introduces <strong>new Navigator</strong>&nbsp;APIs &amp; more.</p>
        </div>
      </li>
      <li class="b_algo" data-id iid=SERP.5340>
        <h2><a target="_blank" href="https://medium.com/flutter/x">What's new in 3.19</a></h2>
        <div class="b_caption"><p>An overview post.</p></div>
      </li>
    </ol>
  `;

  it("extracts title/url/snippet from b_algo blocks", () => {
    const items = parseBingResults(sampleHtml);
    expect(items).toHaveLength(2);
    expect(items[0]).toEqual({
      title: "Flutter 3.19 release notes",
      url: "https://example.com/a",
      snippet: "Flutter 3.19 introduces new Navigator APIs & more.",
    });
    expect(items[1]).toEqual({
      title: "What's new in 3.19",
      url: "https://medium.com/flutter/x",
      snippet: "An overview post.",
    });
  });

  it("returns empty on markup that doesn't match the expected shape", () => {
    expect(parseBingResults("<html><body>nothing here</body></html>")).toEqual([]);
  });

  it("handles a b_algo block with no b_caption sibling (empty snippet)", () => {
    const html = `
      <li class="b_algo">
        <h2><a href="https://example.com/s">Solo</a></h2>
      </li>
    `;
    const items = parseBingResults(html);
    expect(items).toHaveLength(1);
    expect(items[0]).toEqual({
      title: "Solo",
      url: "https://example.com/s",
      snippet: "",
    });
  });

  it("skips a b_algo block missing the h2 anchor", () => {
    const html = `
      <li class="b_algo">
        <div class="b_caption"><p>orphan snippet</p></div>
      </li>
    `;
    expect(parseBingResults(html)).toEqual([]);
  });

  it("drops promoted blocks and ad-click links", () => {
    const html = `
      <ol id="b_results">
        <li class="b_algo b_ad"><h2><a href="https://ads.example/sale">Buy now</a></h2>
          <div class="b_caption"><p>sponsored offer</p></div></li>
        <li class="b_algo"><h2>
          <a href="https://www.bing.com/aclick?ld=e4Xyz&u=https%3a%2f%2fads.example%2f2">Another ad</a>
        </h2><div class="b_caption"><p>ad copy</p></div></li>
        <li class="b_algo" aria-label="Sponsored"><h2><a href="https://ads.example/3">Third ad</a></h2></li>
        <li class="b_algo"><h2><a href="https://docs.example/real">Real docs page</a></h2>
          <div class="b_caption"><p>the actual answer</p></div></li>
      </ol>
    `;
    expect(parseBingResults(html)).toEqual([
      {
        title: "Real docs page",
        url: "https://docs.example/real",
        snippet: "the actual answer",
      },
    ]);
  });

  it("unwraps click-tracking redirects and strips tracking params", () => {
    const target = "https://api-docs.example.com/guide";
    const encoded = Buffer.from(target, "utf-8").toString("base64url");
    const html = `
      <ol id="b_results">
        <li class="b_algo"><h2>
          <a href="/ck/a?u=a1${encoded}&hl=en">Wrapped result</a>
        </h2><div class="b_caption"><p>unwrapped</p></div></li>
        <li class="b_algo"><h2>
          <a href="https://docs.example.com/other?utm_source=bing&utm_medium=cpc&keep=1#frag">Tracked result</a>
        </h2><div class="b_caption"><p>cleaned</p></div></li>
      </ol>
    `;
    expect(parseBingResults(html)).toEqual([
      { title: "Wrapped result", url: target, snippet: "unwrapped" },
      {
        title: "Tracked result",
        url: "https://docs.example.com/other?keep=1#frag",
        snippet: "cleaned",
      },
    ]);
  });

  it("returns a readable snippet when a rich card nests a stylesheet", () => {
    // Reproduced from a live SERP: the block carries Bing's stylesheet inline, and its
    // textContent is thousands of characters of CSS rather than a summary.
    const css = ".b_richcard+.b_factrow{margin-top:-10px}.tab-head{display:flex}";
    const html = `
      <ol id="b_results">
        <li class="b_algo">
          <style>${css}</style>
          <h2><a href="https://doc.rust-lang.org/std/slice/">std::slice - Rust</a></h2>
          <div class="b_attribution">Rust Programming Language</div>
          <div class="b_caption"><p>Utilities for the slice primitive type.</p></div>
        </li>
      </ol>
    `;
    const [result] = parseBingResults(html);
    expect(result?.snippet).toBe("Utilities for the slice primitive type.");
    expect(result?.snippet).not.toContain("{");
    expect(result?.snippet).not.toContain("margin-top");
  });

  it("drops a snippet that is only stylesheet, rather than shipping CSS", () => {
    const html = `
      <ol id="b_results">
        <li class="b_algo">
          <h2><a href="https://docs.example.com/a">A page</a></h2>
          <style>.tab-menu li{padding:0 16px}.tab-active{color:#111}</style>
          <div class="b_caption"><p>.b_richcard+.b_factrow{margin-top:-10px}</p></div>
        </li>
      </ol>
    `;
    // The caption itself is CSS: better an empty summary than 4KB of stylesheet.
    expect(parseBingResults(html)[0]?.snippet).toBe("");
  });

  it("caps a long snippet instead of pasting a whole block", () => {
    const long = "word ".repeat(400);
    const html = `
      <ol id="b_results">
        <li class="b_algo"><h2><a href="https://docs.example.com/long">Long</a></h2>
          <div class="b_caption"><p>${long}</p></div></li>
      </ol>
    `;
    const snippet = parseBingResults(html)[0]?.snippet ?? "";
    expect(snippet.length).toBeLessThanOrEqual(321);
    expect(snippet.endsWith("…")).toBe(true);
  });

  it("keeps words apart when a block's text sits in sibling elements", () => {
    // Live SERP markup glues textContent: "Rust Programming Languagehttps://doc.rust-lang.org".
    const html = `
      <ol id="b_results">
        <li class="b_algo">
          <h2><a href="https://doc.rust-lang.org/std/slice/">std::slice - Rust</a></h2>
          <div class="b_attribution">Rust Programming Language</div>
          <div>https://doc.rust-lang.org › std › slice</div>
        </li>
      </ol>
    `;
    const [result] = parseBingResults(html);
    expect(result?.snippet).toContain("Rust Programming Language https://doc.rust-lang.org");
  });

  it("never splits a word that markup broke mid-token", () => {
    // Bing bolds query terms, so "windows" arrives as win<strong>dows</strong>.
    const html = `
      <ol id="b_results">
        <li class="b_algo">
          <h2><a href="https://docs.example.com/w">Getting <strong>started</strong></a></h2>
          <div class="b_caption"><p>All about win<strong>dows</strong> and https://doc.<span>rust-lang.org</span></p></div>
        </li>
      </ol>
    `;
    const [result] = parseBingResults(html);
    expect(result?.title).toBe("Getting started");
    // Block boundaries still separate, inline spans must not.
    expect(result?.snippet).toBe("All about windows and https://doc.rust-lang.org");
  });

  it("never splits a surrogate pair when it caps text", () => {
    // A 320-unit cut landing mid-emoji used to leave a lone surrogate (issue #1970).
    const emoji = "🙂";
    const text = `${"a ".repeat(159)}${emoji.repeat(40)}`;
    const html = `
      <ol id="b_results">
        <li class="b_algo"><h2><a href="https://docs.example.com/e">Emoji</a></h2>
          <div class="b_caption"><p>${text}</p></div></li>
      </ol>
    `;
    const snippet = parseBingResults(html)[0]?.snippet ?? "";
    expect(snippet.isWellFormed?.()).not.toBe(false);
    expect(snippet).not.toMatch(/[\uD800-\uDBFF](?![\uDC00-\uDFFF])/);
  });

  it("caps a title that a drifted layout stretched into a sentence", () => {
    const long = "Title word ".repeat(60);
    const html = `
      <ol id="b_results">
        <li class="b_algo"><h2><a href="https://docs.example.com/t">${long}</a></h2></li>
      </ol>
    `;
    const result = parseBingResults(html)[0];
    expect((result?.title.length ?? 0) <= 201).toBe(true);
    expect(result?.title.endsWith("…")).toBe(true);
  });

  it("keeps a destination anchor and drops a tracking fragment", () => {
    const html = `
      <ol id="b_results">
        <li class="b_algo"><h2>
          <a href="https://github.com/o/r/blob/main/src/a.ts#L120-L130">code lines</a>
        </h2></li>
        <li class="b_algo"><h2>
          <a href="https://docs.example.com/api#authentication">docs section</a>
        </h2></li>
        <li class="b_algo"><h2>
          <a href="https://docs.example.com/x#utm_source=bing">tracked</a>
        </h2></li>
      </ol>
    `;
    // An anchor is where the answer lives (`#L120` lines, `#auth` section), not bookkeeping.
    expect(parseBingResults(html).map((result) => result.url)).toEqual([
      "https://github.com/o/r/blob/main/src/a.ts#L120-L130",
      "https://docs.example.com/api#authentication",
      "https://docs.example.com/x",
    ]);
  });

  it("collapses duplicate destinations and skips unusable hrefs", () => {
    const html = `
      <ol id="b_results">
        <li class="b_algo"><h2><a href="https://docs.example/a">Docs</a></h2></li>
        <li class="b_algo"><h2><a href="https://docs.example/a?utm_source=x">Docs again</a></h2></li>
        <li class="b_algo"><h2><a href="javascript:void(0)">Not a page</a></h2></li>
        <li class="b_algo"><h2><a href="https://www.bing.com/search?q=more">Search Bing</a></h2></li>
        <li class="b_algo"><h2><a href="https://example.org/b">Elsewhere</a></h2></li>
      </ol>
    `;
    const items = parseBingResults(html);
    expect(items.map((item) => item.url)).toEqual([
      "https://docs.example/a",
      "https://example.org/b",
    ]);
    expect(items[0]?.title).toBe("Docs");
  });

  it("falls back to the block's own text when a hit has no caption", () => {
    const html = `
      <li class="b_algo">
        <h2><a href="https://docs.example/t">Title here</a></h2>
        <div class="b_text">Readable body text without a caption.</div>
      </li>
    `;
    const [item] = parseBingResults(html);
    // The title is stripped so the snippet is body text only, not a repeat of the title.
    expect(item?.snippet).toBe("Readable body text without a caption.");
  });

  it("harvests anchors from the results container when the block markup drifts", () => {
    const html = `
      <div id="b_results">
        <div class="answer"><a href="https://docs.example/new">Docs answer</a>
          <span>answer body</span></div>
      </div>
    `;
    const items = parseBingResults(html);
    expect(items).toHaveLength(1);
    expect(items[0]?.url).toBe("https://docs.example/new");
  });
});
describe("parseSearxngHtmlResults", () => {
  const sampleHtml = `
    <article class="result">
      <h3><a href="https://example.com/rust">Rust programming language</a></h3>
      <p>A systems language focused on safety and concurrency.</p>
    </article>
    <article class="result">
      <h3><a href="https://example.com/go">Go by example</a></h3>
      <p>Learn Go with annotated example programs.</p>
    </article>
  `;

  it("extracts title/url/snippet from article.result markup", () => {
    const items = parseSearxngHtmlResults(sampleHtml);
    expect(items).toHaveLength(2);
    expect(items[0]).toEqual({
      title: "Rust programming language",
      url: "https://example.com/rust",
      snippet: "A systems language focused on safety and concurrency.",
    });
    expect(items[1]).toEqual({
      title: "Go by example",
      url: "https://example.com/go",
      snippet: "Learn Go with annotated example programs.",
    });
  });

  it("falls back to h3 a[href] when no article.result exists", () => {
    const html = `
      <div>
        <h3><a href="https://example.com/x">Title X</a></h3>
        <p>Snippet for X.</p>
      </div>
    `;
    const items = parseSearxngHtmlResults(html);
    expect(items).toHaveLength(1);
    expect(items[0]).toEqual({
      title: "Title X",
      url: "https://example.com/x",
      snippet: "Snippet for X.",
    });
  });

  it("returns empty on markup with no recognizable results", () => {
    expect(parseSearxngHtmlResults("<html><body>nothing here</body></html>")).toEqual([]);
  });
});

describe("webSearch", () => {
  const twoResultsHtml = `
    <li class="b_algo"><h2><a href="https://example.com/a">A</a></h2>
      <div class="b_caption"><p>snippet A</p></div></li>
    <li class="b_algo"><h2><a href="https://example.com/b">B</a></h2>
      <div class="b_caption"><p>snippet B</p></div></li>`;

  it("caps the DeepSeek query at the documented 128 characters", async () => {
    const originalFetch = globalThis.fetch;
    const originalKey = process.env.DEEPSEEK_API_KEY;
    process.env.DEEPSEEK_API_KEY = "sk-deepseek-test";
    let sent = "";
    globalThis.fetch = vi.fn(async (_url: string | URL, init?: RequestInit) => {
      sent = (JSON.parse(String(init?.body)) as { query: string }).query;
      return new Response(JSON.stringify({ results: [] }), {
        status: 200,
        headers: { "Content-Type": "application/json" },
      });
    }) as unknown as typeof fetch;
    try {
      await webSearch("q".repeat(300), { engine: "deepseek" });
      expect(sent).toHaveLength(128);
    } finally {
      globalThis.fetch = originalFetch;
      if (originalKey === undefined) {
        // biome-ignore lint/performance/noDelete: restoring an absent env var
        delete process.env.DEEPSEEK_API_KEY;
      } else {
        process.env.DEEPSEEK_API_KEY = originalKey;
      }
    }
  });

  it("calls Z.AI search-prime and normalizes results", async () => {
    const originalFetch = globalThis.fetch;
    const originalKey = process.env.ZAI_API_KEY;
    process.env.ZAI_API_KEY = "zai-search-key";
    let capturedUrl = "";
    let capturedInit: RequestInit | undefined;
    globalThis.fetch = vi.fn(async (url: string | URL, init?: RequestInit) => {
      capturedUrl = String(url);
      capturedInit = init;
      return new Response(
        JSON.stringify({
          search_result: [{ title: "GLM", link: "https://example.com/glm", content: "GLM result" }],
        }),
        { status: 200, headers: { "Content-Type": "application/json" } },
      );
    }) as unknown as typeof fetch;
    try {
      const out = await webSearch("glm models", { engine: "zai", topK: 99 });
      expect(capturedUrl).toBe("https://api.z.ai/api/paas/v4/web_search");
      expect((capturedInit?.headers as Record<string, string>).Authorization).toBe(
        "Bearer zai-search-key",
      );
      expect(JSON.parse(String(capturedInit?.body))).toEqual({
        search_engine: "search-prime",
        search_query: "glm models",
        count: 50,
      });
      expect(out).toEqual([
        { title: "GLM", url: "https://example.com/glm", snippet: "GLM result" },
      ]);
    } finally {
      globalThis.fetch = originalFetch;
      // biome-ignore lint/performance/noDelete: restore exact env state
      if (originalKey === undefined) delete process.env.ZAI_API_KEY;
      else process.env.ZAI_API_KEY = originalKey;
    }
  });

  it("fails explicitly when Z.AI search has no API key", async () => {
    const originalKey = process.env.ZAI_API_KEY;
    // biome-ignore lint/performance/noDelete: test requires the key to be absent
    delete process.env.ZAI_API_KEY;
    try {
      await expect(webSearch("glm", { engine: "zai", configPath: "missing.json" })).rejects.toThrow(
        /Z\.AI search requires an API key/,
      );
    } finally {
      if (originalKey !== undefined) process.env.ZAI_API_KEY = originalKey;
    }
  });

  it("GETs cn.bing.com with a browser UA and query string", async () => {
    const captured: { url: string; method: string; ua: string } = { url: "", method: "", ua: "" };
    const originalFetch = globalThis.fetch;
    globalThis.fetch = vi.fn(async (url: string | URL, init?: RequestInit) => {
      captured.url = String(url);
      captured.method = init?.method ?? "GET";
      const headers = (init?.headers ?? {}) as Record<string, string>;
      captured.ua = headers["User-Agent"] ?? "";
      return new Response(twoResultsHtml, {
        status: 200,
        headers: { "Content-Type": "text/html" },
      });
    }) as unknown as typeof fetch;
    try {
      const out = await webSearch("flutter 3.19", { topK: 2 });
      expect(captured.url).toContain("cn.bing.com/search");
      expect(captured.url).toContain("q=flutter%203.19");
      expect(captured.method).toBe("GET");
      expect(captured.ua).toMatch(/Mozilla\/5.0/);
      expect(out).toHaveLength(2);
      expect(out[0]?.title).toBe("A");
    } finally {
      globalThis.fetch = originalFetch;
    }
  });

  it("clamps topK to [1, 10]", async () => {
    const originalFetch = globalThis.fetch;
    globalThis.fetch = vi.fn(
      async () => new Response(twoResultsHtml, { status: 200 }),
    ) as unknown as typeof fetch;
    try {
      const outMax = await webSearch("x", { topK: 99 });
      expect(outMax.length).toBeLessThanOrEqual(10);
      const outMin = await webSearch("x", { topK: 0 });
      expect(outMin.length).toBe(1);
    } finally {
      globalThis.fetch = originalFetch;
    }
  });

  it("throws on non-2xx", async () => {
    const originalFetch = globalThis.fetch;
    globalThis.fetch = vi.fn(
      async () => new Response("blocked", { status: 429 }),
    ) as unknown as typeof fetch;
    try {
      await expect(webSearch("q")).rejects.toThrow(/web_search 429/);
    } finally {
      globalThis.fetch = originalFetch;
    }
  });

  it("annotates 429 with a wait-and-retry hint", async () => {
    const originalFetch = globalThis.fetch;
    globalThis.fetch = vi.fn(
      async () => new Response("blocked", { status: 429 }),
    ) as unknown as typeof fetch;
    try {
      await expect(webSearch("q")).rejects.toThrow(/web_search 429.*try:.*wait/);
    } finally {
      globalThis.fetch = originalFetch;
    }
  });

  it("annotates 403 with a hint that the backend is blocking", async () => {
    const originalFetch = globalThis.fetch;
    globalThis.fetch = vi.fn(
      async () => new Response("forbidden", { status: 403 }),
    ) as unknown as typeof fetch;
    try {
      await expect(webSearch("q")).rejects.toThrow(/web_search 403.*try:/);
    } finally {
      globalThis.fetch = originalFetch;
    }
  });

  it("annotates 5xx with a transient-retry hint", async () => {
    const originalFetch = globalThis.fetch;
    globalThis.fetch = vi.fn(
      async () => new Response("broken", { status: 503 }),
    ) as unknown as typeof fetch;
    try {
      await expect(webSearch("q")).rejects.toThrow(/web_search 503.*try:.*retry in 30s/);
    } finally {
      globalThis.fetch = originalFetch;
    }
  });

  it("never substitutes another engine when the configured backend is unreachable", async () => {
    const originalFetch = globalThis.fetch;
    const calls: string[] = [];
    globalThis.fetch = vi.fn(async (url: string | URL) => {
      calls.push(String(url));
      throw new TypeError("fetch failed");
    }) as unknown as typeof fetch;
    try {
      await expect(webSearch("q", { engine: "searxng" })).rejects.toThrow(/Cannot reach/);
      // One attempt, on the configured engine's endpoint only: a fallback index
      // would answer with a different index's results under this engine's name.
      expect(calls).toHaveLength(1);
      expect(calls[0]).toContain("localhost:8080");
    } finally {
      globalThis.fetch = originalFetch;
    }
  });

  it("surfaces a credentialed engine's rate limit instead of searching elsewhere", async () => {
    const originalFetch = globalThis.fetch;
    const originalKey = process.env.OLLAMA_API_KEY;
    process.env.OLLAMA_API_KEY = "ollama-test-key";
    const calls: string[] = [];
    globalThis.fetch = vi.fn(async (url: string | URL) => {
      calls.push(String(url));
      return new Response(JSON.stringify({ error: "You reached your weekly limit." }), {
        status: 429,
      });
    }) as unknown as typeof fetch;
    try {
      await expect(webSearch("q", { engine: "ollama" })).rejects.toThrow(/rate-limited|quota/);
      expect(calls).toHaveLength(1);
      expect(calls[0]).toContain("ollama.com");
    } finally {
      globalThis.fetch = originalFetch;
      if (originalKey === undefined) {
        // biome-ignore lint/performance/noDelete: restoring an absent env var
        delete process.env.OLLAMA_API_KEY;
      } else {
        process.env.OLLAMA_API_KEY = originalKey;
      }
    }
  });

  it("returns [] on a legitimately empty 'No results' page", async () => {
    const originalFetch = globalThis.fetch;
    globalThis.fetch = vi.fn(
      async () =>
        new Response("<html><body>Your search did not match any documents.</body></html>", {
          status: 200,
        }),
    ) as unknown as typeof fetch;
    try {
      const out = await webSearch("zzyzx nothing here");
      expect(out).toEqual([]);
    } finally {
      globalThis.fetch = originalFetch;
    }
  });

  it("surfaces a clear error on an anti-bot interstitial", async () => {
    const originalFetch = globalThis.fetch;
    globalThis.fetch = vi.fn(
      async () =>
        new Response("<html>Please solve the captcha to continue.</html>", { status: 200 }),
    ) as unknown as typeof fetch;
    try {
      await expect(webSearch("q")).rejects.toThrow(/anti-bot|rate-limited|blocked/);
    } finally {
      globalThis.fetch = originalFetch;
    }
  });

  it("surfaces a diagnostic error when the response looks like neither empty-nor-results", async () => {
    const originalFetch = globalThis.fetch;
    globalThis.fetch = vi.fn(
      async () =>
        new Response("<html><body>totally unexpected shape</body></html>", { status: 200 }),
    ) as unknown as typeof fetch;
    try {
      await expect(webSearch("q")).rejects.toThrow(/doesn't look like a real empty page/);
    } finally {
      globalThis.fetch = originalFetch;
    }
  });
});

describe("searchMetaso", () => {
  const originalMetasoKey = process.env.METASO_API_KEY;
  const sampleResponse = {
    credits: 3,
    total: 72,
    webpages: [
      {
        title: "Result One",
        link: "https://example.com/1",
        snippet: "Snippet one.",
        score: "high",
        position: 1,
      },
      {
        title: "Result Two",
        link: "https://example.com/2",
        summary: "Summary two.",
        score: "medium",
        position: 2,
      },
    ],
  };

  beforeEach(() => {
    process.env.METASO_API_KEY = "test-metaso-key";
  });

  afterEach(() => {
    if (originalMetasoKey === undefined) {
      // biome-ignore lint/performance/noDelete: env var must be restored to absent
      delete process.env.METASO_API_KEY;
    } else {
      process.env.METASO_API_KEY = originalMetasoKey;
    }
  });

  it("requires an API key before contacting Metaso", async () => {
    // biome-ignore lint/performance/noDelete: env var must be absent, not "undefined"
    delete process.env.METASO_API_KEY;
    const originalFetch = globalThis.fetch;
    globalThis.fetch = vi.fn() as unknown as typeof fetch;
    try {
      await expect(webSearch("q", { engine: "metaso" })).rejects.toThrow(/Metaso.*API key/i);
      expect(globalThis.fetch).not.toHaveBeenCalled();
    } finally {
      globalThis.fetch = originalFetch;
    }
  });

  it("POSTs to metaso API with JSON body and auth header", async () => {
    const captured: { url: string; method: string; headers: Record<string, string>; body: string } =
      { url: "", method: "", headers: {}, body: "" };
    const originalFetch = globalThis.fetch;
    globalThis.fetch = vi.fn(async (url: string | URL, init?: RequestInit) => {
      captured.url = String(url);
      captured.method = init?.method ?? "GET";
      captured.headers = (init?.headers ?? {}) as Record<string, string>;
      captured.body = String(init?.body ?? "");
      return new Response(JSON.stringify(sampleResponse), {
        status: 200,
        headers: { "Content-Type": "application/json" },
      });
    }) as unknown as typeof fetch;
    try {
      const out = await webSearch("test query", { engine: "metaso", topK: 5 });
      expect(captured.url).toContain("metaso.cn/api/v1/search");
      expect(captured.method).toBe("POST");
      expect(captured.headers.Authorization).toBe(`Bearer ${loadMetasoApiKey()}`);
      expect(captured.headers["Content-Type"]).toBe("application/json");
      const body = JSON.parse(captured.body);
      expect(body.q).toBe("test query");
      expect(body.scope).toBe("webpage");
      expect(body.size).toBe(5);
      expect(out).toHaveLength(2);
      expect(out[0]).toEqual({
        title: "Result One",
        url: "https://example.com/1",
        snippet: "Snippet one.",
      });
      expect(out[1]).toEqual({
        title: "Result Two",
        url: "https://example.com/2",
        snippet: "Summary two.",
      });
    } finally {
      globalThis.fetch = originalFetch;
    }
  });

  it("throws daily limit error on code 3003", async () => {
    const originalFetch = globalThis.fetch;
    globalThis.fetch = vi.fn(
      async () =>
        new Response(JSON.stringify({ code: 3003, message: "今日调用次数已达上限" }), {
          status: 200,
          headers: { "Content-Type": "application/json" },
        }),
    ) as unknown as typeof fetch;
    try {
      await expect(webSearch("q", { engine: "metaso" })).rejects.toThrow(/daily search limit/);
      await expect(webSearch("q", { engine: "metaso" })).rejects.toThrow(
        /metaso.cn\/search-api\/playground/,
      );
    } finally {
      globalThis.fetch = originalFetch;
    }
  });

  it("throws unauthorized error on code 2005 (invalid API key)", async () => {
    const originalFetch = globalThis.fetch;
    globalThis.fetch = vi.fn(
      async () =>
        new Response(JSON.stringify({ code: 2005, message: "API密钥无效" }), {
          status: 200,
          headers: { "Content-Type": "application/json" },
        }),
    ) as unknown as typeof fetch;
    try {
      await expect(webSearch("q", { engine: "metaso" })).rejects.toThrow(/API key rejected/);
    } finally {
      globalThis.fetch = originalFetch;
    }
  });

  it("throws rate limit error on 429", async () => {
    const originalFetch = globalThis.fetch;
    globalThis.fetch = vi.fn(
      async () =>
        new Response(JSON.stringify({ message: "rate limited" }), {
          status: 429,
          headers: { "Content-Type": "application/json" },
        }),
    ) as unknown as typeof fetch;
    try {
      await expect(webSearch("q", { engine: "metaso" })).rejects.toThrow(/rate-limited/);
    } finally {
      globalThis.fetch = originalFetch;
    }
  });

  it("returns empty array on 0 results", async () => {
    const originalFetch = globalThis.fetch;
    globalThis.fetch = vi.fn(
      async () =>
        new Response(JSON.stringify({ credits: 1, total: 0 }), {
          status: 200,
          headers: { "Content-Type": "application/json" },
        }),
    ) as unknown as typeof fetch;
    try {
      const out = await webSearch("q", { engine: "metaso" });
      expect(out).toEqual([]);
    } finally {
      globalThis.fetch = originalFetch;
    }
  });

  it("clamps topK to [1, 100]", async () => {
    const originalFetch = globalThis.fetch;
    globalThis.fetch = vi.fn(
      async () =>
        new Response(JSON.stringify(sampleResponse), {
          status: 200,
          headers: { "Content-Type": "application/json" },
        }),
    ) as unknown as typeof fetch;
    try {
      const outMax = await webSearch("x", { engine: "metaso", topK: 999 });
      expect(outMax.length).toBeLessThanOrEqual(2);
      const outMin = await webSearch("x", { engine: "metaso", topK: 0 });
      expect(outMin.length).toBe(1);
    } finally {
      globalThis.fetch = originalFetch;
    }
  });
});

describe("searchBaidu", () => {
  const originalBaiduKey = process.env.BAIDU_API_KEY;

  beforeEach(() => {
    process.env.BAIDU_API_KEY = "test-baidu-key";
  });

  afterEach(() => {
    if (originalBaiduKey === undefined) {
      // biome-ignore lint/performance/noDelete: env var must be restored to absent
      delete process.env.BAIDU_API_KEY;
    } else {
      process.env.BAIDU_API_KEY = originalBaiduKey;
    }
  });

  it("requires an API key before contacting Baidu AI Search", async () => {
    // biome-ignore lint/performance/noDelete: env var must be absent, not "undefined"
    delete process.env.BAIDU_API_KEY;
    const originalFetch = globalThis.fetch;
    globalThis.fetch = vi.fn() as unknown as typeof fetch;
    try {
      await expect(webSearch("q", { engine: "baidu" })).rejects.toThrow(/Baidu.*API key/i);
      expect(globalThis.fetch).not.toHaveBeenCalled();
    } finally {
      globalThis.fetch = originalFetch;
    }
  });

  it("POSTs to Baidu AI Search with JSON body and auth header", async () => {
    const captured: { url: string; method: string; headers: Record<string, string>; body: string } =
      { url: "", method: "", headers: {}, body: "" };
    const originalFetch = globalThis.fetch;
    globalThis.fetch = vi.fn(async (url: string | URL, init?: RequestInit) => {
      captured.url = String(url);
      captured.method = init?.method ?? "GET";
      captured.headers = (init?.headers ?? {}) as Record<string, string>;
      captured.body = String(init?.body ?? "");
      return new Response(
        JSON.stringify({
          references: [
            { title: "Result One", url: "https://example.com/1", content: "Snippet one." },
            { title: "Result Two", url: "https://example.com/2", content: "Snippet two." },
          ],
        }),
        {
          status: 200,
          headers: { "Content-Type": "application/json" },
        },
      );
    }) as unknown as typeof fetch;
    try {
      const out = await webSearch("test query", { engine: "baidu", topK: 5 });
      expect(captured.url).toBe("https://qianfan.baidubce.com/v2/ai_search/web_search");
      expect(captured.method).toBe("POST");
      expect(captured.headers.Authorization).toBe(`Bearer ${loadBaiduApiKey()}`);
      expect(captured.headers["Content-Type"]).toBe("application/json");
      const body = JSON.parse(captured.body);
      expect(body.messages).toEqual([{ role: "user", content: "test query" }]);
      expect(out).toEqual([
        { title: "Result One", url: "https://example.com/1", snippet: "Snippet one." },
        { title: "Result Two", url: "https://example.com/2", snippet: "Snippet two." },
      ]);
    } finally {
      globalThis.fetch = originalFetch;
    }
  });

  it("returns [] when Baidu returns no references", async () => {
    const originalFetch = globalThis.fetch;
    globalThis.fetch = vi.fn(
      async () =>
        new Response(JSON.stringify({ references: [] }), {
          status: 200,
          headers: { "Content-Type": "application/json" },
        }),
    ) as unknown as typeof fetch;
    try {
      await expect(webSearch("empty", { engine: "baidu" })).resolves.toEqual([]);
    } finally {
      globalThis.fetch = originalFetch;
    }
  });

  it("skips Baidu references without a URL or title", async () => {
    const originalFetch = globalThis.fetch;
    globalThis.fetch = vi.fn(
      async () =>
        new Response(
          JSON.stringify({
            references: [
              { title: "No URL", content: "skip" },
              { url: "https://example.com/no-title", content: "skip" },
              { title: "Good", url: "https://example.com/good", content: "keep" },
            ],
          }),
          { status: 200, headers: { "Content-Type": "application/json" } },
        ),
    ) as unknown as typeof fetch;
    try {
      await expect(webSearch("mixed", { engine: "baidu" })).resolves.toEqual([
        { title: "Good", url: "https://example.com/good", snippet: "keep" },
      ]);
    } finally {
      globalThis.fetch = originalFetch;
    }
  });

  it("clamps Baidu topK to [1, 10]", async () => {
    const references = Array.from({ length: 12 }, (_, i) => ({
      title: `Result ${i + 1}`,
      url: `https://example.com/${i + 1}`,
      content: `Snippet ${i + 1}`,
    }));
    const originalFetch = globalThis.fetch;
    globalThis.fetch = vi.fn(
      async () =>
        new Response(JSON.stringify({ references }), {
          status: 200,
          headers: { "Content-Type": "application/json" },
        }),
    ) as unknown as typeof fetch;
    try {
      await expect(webSearch("x", { engine: "baidu", topK: 99 })).resolves.toHaveLength(10);
      await expect(webSearch("x", { engine: "baidu", topK: 0 })).resolves.toHaveLength(1);
    } finally {
      globalThis.fetch = originalFetch;
    }
  });

  it("throws Baidu auth error on 401 and 403", async () => {
    const originalFetch = globalThis.fetch;
    globalThis.fetch = vi.fn(
      async () => new Response(JSON.stringify({ error: "invalid key" }), { status: 401 }),
    ) as unknown as typeof fetch;
    try {
      await expect(webSearch("q", { engine: "baidu" })).rejects.toThrow(/Baidu.*API key/i);
    } finally {
      globalThis.fetch = originalFetch;
    }
  });

  it("throws Baidu rate-limit error on 429", async () => {
    const originalFetch = globalThis.fetch;
    globalThis.fetch = vi.fn(
      async () => new Response(JSON.stringify({ error: "rate limited" }), { status: 429 }),
    ) as unknown as typeof fetch;
    try {
      await expect(webSearch("q", { engine: "baidu" })).rejects.toThrow(/rate-limit|quota/i);
    } finally {
      globalThis.fetch = originalFetch;
    }
  });

  it("throws Baidu parse error on invalid JSON", async () => {
    const originalFetch = globalThis.fetch;
    globalThis.fetch = vi.fn(
      async () => new Response("not json", { status: 200 }),
    ) as unknown as typeof fetch;
    try {
      await expect(webSearch("q", { engine: "baidu" })).rejects.toThrow(/unparseable/i);
    } finally {
      globalThis.fetch = originalFetch;
    }
  });
});

describe("searchTavily", () => {
  const sampleResponse = {
    query: "test query",
    results: [
      {
        title: "First Hit",
        url: "https://example.com/1",
        content: "First snippet.",
        score: 0.93,
      },
      {
        title: "Second Hit",
        url: "https://example.com/2",
        content: "Second snippet.",
        score: 0.81,
      },
    ],
    response_time: 0.42,
  };

  it("requires an API key — throws a setup-pointing error when none is set", async () => {
    const origKey = process.env.TAVILY_API_KEY;
    // biome-ignore lint/performance/noDelete: env var must be absent, not "undefined"
    delete process.env.TAVILY_API_KEY;
    try {
      await expect(webSearch("q", { engine: "tavily" })).rejects.toThrow(/Tavily.*API key/i);
      // Plain-string match — checking the error message includes the signup URL,
      // not testing URL safety; using a regex here trips CodeQL's missing-anchor rule.
      await expect(webSearch("q", { engine: "tavily" })).rejects.toThrow("tavily.com");
    } finally {
      if (origKey !== undefined) process.env.TAVILY_API_KEY = origKey;
    }
  });

  it("POSTs to Tavily with the api_key in the body", async () => {
    const origKey = process.env.TAVILY_API_KEY;
    process.env.TAVILY_API_KEY = "tvly-test-key";
    const captured: { url: string; method: string; body: string } = {
      url: "",
      method: "",
      body: "",
    };
    const originalFetch = globalThis.fetch;
    globalThis.fetch = vi.fn(async (url: string | URL, init?: RequestInit) => {
      captured.url = String(url);
      captured.method = init?.method ?? "GET";
      captured.body = String(init?.body ?? "");
      return new Response(JSON.stringify(sampleResponse), {
        status: 200,
        headers: { "Content-Type": "application/json" },
      });
    }) as unknown as typeof fetch;
    try {
      const out = await webSearch("test query", { engine: "tavily", topK: 5 });
      expect(captured.url).toBe("https://api.tavily.com/search");
      expect(captured.method).toBe("POST");
      const body = JSON.parse(captured.body);
      expect(body.api_key).toBe("tvly-test-key");
      expect(body.query).toBe("test query");
      expect(body.max_results).toBe(5);
      expect(out).toHaveLength(2);
      expect(out[0]).toEqual({
        title: "First Hit",
        url: "https://example.com/1",
        snippet: "First snippet.",
      });
    } finally {
      globalThis.fetch = originalFetch;
      if (origKey === undefined) {
        // biome-ignore lint/performance/noDelete: same reason — must drop, not set to "undefined"
        delete process.env.TAVILY_API_KEY;
      } else {
        process.env.TAVILY_API_KEY = origKey;
      }
    }
  });

  it("maps 401/403 to a key-rejected error", async () => {
    const origKey = process.env.TAVILY_API_KEY;
    process.env.TAVILY_API_KEY = "tvly-bad";
    const originalFetch = globalThis.fetch;
    globalThis.fetch = vi.fn(
      async () => new Response("forbidden", { status: 403 }),
    ) as unknown as typeof fetch;
    try {
      await expect(webSearch("q", { engine: "tavily" })).rejects.toThrow(/Tavily.*rejected/i);
    } finally {
      globalThis.fetch = originalFetch;
      if (origKey === undefined) {
        // biome-ignore lint/performance/noDelete: same reason
        delete process.env.TAVILY_API_KEY;
      } else {
        process.env.TAVILY_API_KEY = origKey;
      }
    }
  });

  it("maps 429 to a quota/rate-limit error", async () => {
    const origKey = process.env.TAVILY_API_KEY;
    process.env.TAVILY_API_KEY = "tvly-test-key";
    const originalFetch = globalThis.fetch;
    globalThis.fetch = vi.fn(
      async () => new Response("too many", { status: 429 }),
    ) as unknown as typeof fetch;
    try {
      await expect(webSearch("q", { engine: "tavily" })).rejects.toThrow(/quota|rate-limit/i);
    } finally {
      globalThis.fetch = originalFetch;
      if (origKey === undefined) {
        // biome-ignore lint/performance/noDelete: same reason
        delete process.env.TAVILY_API_KEY;
      } else {
        process.env.TAVILY_API_KEY = origKey;
      }
    }
  });

  it("returns empty array when results is empty", async () => {
    const origKey = process.env.TAVILY_API_KEY;
    process.env.TAVILY_API_KEY = "tvly-test-key";
    const originalFetch = globalThis.fetch;
    globalThis.fetch = vi.fn(
      async () =>
        new Response(JSON.stringify({ query: "x", results: [] }), {
          status: 200,
          headers: { "Content-Type": "application/json" },
        }),
    ) as unknown as typeof fetch;
    try {
      const out = await webSearch("x", { engine: "tavily" });
      expect(out).toEqual([]);
    } finally {
      globalThis.fetch = originalFetch;
      if (origKey === undefined) {
        // biome-ignore lint/performance/noDelete: same reason
        delete process.env.TAVILY_API_KEY;
      } else {
        process.env.TAVILY_API_KEY = origKey;
      }
    }
  });
});

describe("searchPerplexity", () => {
  const sampleResponse = {
    choices: [{ message: { content: "Synthesized answer about the query." } }],
    citations: [
      { url: "https://source.example.com/a", title: "Source A" },
      "https://source.example.com/b",
    ],
  };

  it("requires an API key — throws a setup-pointing error when none is set", async () => {
    const origKey = process.env.PERPLEXITY_API_KEY;
    // biome-ignore lint/performance/noDelete: env var must be absent, not "undefined"
    delete process.env.PERPLEXITY_API_KEY;
    try {
      await expect(webSearch("q", { engine: "perplexity" })).rejects.toThrow(
        /Perplexity.*API key/i,
      );
      await expect(webSearch("q", { engine: "perplexity" })).rejects.toThrow("perplexity.ai");
    } finally {
      if (origKey !== undefined) process.env.PERPLEXITY_API_KEY = origKey;
    }
  });

  it("POSTs to Perplexity with bearer auth and sonar model", async () => {
    const origKey = process.env.PERPLEXITY_API_KEY;
    process.env.PERPLEXITY_API_KEY = "pplx-test-key";
    const captured: { url: string; method: string; auth: string; body: string } = {
      url: "",
      method: "",
      auth: "",
      body: "",
    };
    const originalFetch = globalThis.fetch;
    globalThis.fetch = vi.fn(async (url: string | URL, init?: RequestInit) => {
      captured.url = String(url);
      captured.method = init?.method ?? "GET";
      captured.auth = String((init?.headers as Record<string, string>)?.Authorization ?? "");
      captured.body = String(init?.body ?? "");
      return new Response(JSON.stringify(sampleResponse), {
        status: 200,
        headers: { "Content-Type": "application/json" },
      });
    }) as unknown as typeof fetch;
    try {
      const out = await webSearch("test query", { engine: "perplexity", topK: 5 });
      expect(captured.url).toBe("https://api.perplexity.ai/chat/completions");
      expect(captured.method).toBe("POST");
      expect(captured.auth).toBe("Bearer pplx-test-key");
      const body = JSON.parse(captured.body);
      expect(body.model).toBe("sonar");
      expect(body.messages[0].content).toBe("test query");
      // First result is the AI answer (url:"" sentinel + answer field)
      expect(out[0]).toEqual({
        title: "Synthesized answer about the query.",
        url: "",
        snippet: "",
        answer: "Synthesized answer about the query.",
      });
      // Citations follow — both object and string forms
      expect(out[1]?.url).toBe("https://source.example.com/a");
      expect(out[1]?.title).toBe("Source A");
      expect(out[2]?.url).toBe("https://source.example.com/b");
    } finally {
      globalThis.fetch = originalFetch;
      if (origKey === undefined) {
        // biome-ignore lint/performance/noDelete: same reason
        delete process.env.PERPLEXITY_API_KEY;
      } else {
        process.env.PERPLEXITY_API_KEY = origKey;
      }
    }
  });

  it("maps 401/403 to a key-rejected error", async () => {
    const origKey = process.env.PERPLEXITY_API_KEY;
    process.env.PERPLEXITY_API_KEY = "pplx-bad";
    const originalFetch = globalThis.fetch;
    globalThis.fetch = vi.fn(
      async () => new Response("forbidden", { status: 403 }),
    ) as unknown as typeof fetch;
    try {
      await expect(webSearch("q", { engine: "perplexity" })).rejects.toThrow(
        /Perplexity.*rejected/i,
      );
    } finally {
      globalThis.fetch = originalFetch;
      if (origKey === undefined) {
        // biome-ignore lint/performance/noDelete: same reason
        delete process.env.PERPLEXITY_API_KEY;
      } else {
        process.env.PERPLEXITY_API_KEY = origKey;
      }
    }
  });

  it("maps 429 to a rate-limit error", async () => {
    const origKey = process.env.PERPLEXITY_API_KEY;
    process.env.PERPLEXITY_API_KEY = "pplx-test-key";
    const originalFetch = globalThis.fetch;
    globalThis.fetch = vi.fn(
      async () => new Response("too many", { status: 429 }),
    ) as unknown as typeof fetch;
    try {
      await expect(webSearch("q", { engine: "perplexity" })).rejects.toThrow(/rate-limit/i);
    } finally {
      globalThis.fetch = originalFetch;
      if (origKey === undefined) {
        // biome-ignore lint/performance/noDelete: same reason
        delete process.env.PERPLEXITY_API_KEY;
      } else {
        process.env.PERPLEXITY_API_KEY = origKey;
      }
    }
  });

  it("maps unparseable JSON to a parse error", async () => {
    const origKey = process.env.PERPLEXITY_API_KEY;
    process.env.PERPLEXITY_API_KEY = "pplx-test-key";
    const originalFetch = globalThis.fetch;
    globalThis.fetch = vi.fn(
      async () => new Response("<html>not json</html>", { status: 200 }),
    ) as unknown as typeof fetch;
    try {
      await expect(webSearch("q", { engine: "perplexity" })).rejects.toThrow(/unparseable/i);
    } finally {
      globalThis.fetch = originalFetch;
      if (origKey === undefined) {
        // biome-ignore lint/performance/noDelete: same reason
        delete process.env.PERPLEXITY_API_KEY;
      } else {
        process.env.PERPLEXITY_API_KEY = origKey;
      }
    }
  });
});

describe("searchExa", () => {
  const sampleResponse = {
    answer: "Exa synthesized answer.",
    citations: [
      {
        title: "Citation A",
        url: "https://exa.example.com/a",
        text: "Snippet A.",
      },
      {
        title: "Citation B",
        url: "https://exa.example.com/b",
        text: "Snippet B.",
      },
    ],
  };

  it("requires an API key — throws a setup-pointing error when none is set", async () => {
    const origKey = process.env.EXA_API_KEY;
    // biome-ignore lint/performance/noDelete: env var must be absent, not "undefined"
    delete process.env.EXA_API_KEY;
    try {
      await expect(webSearch("q", { engine: "exa" })).rejects.toThrow(/Exa.*API key/i);
      await expect(webSearch("q", { engine: "exa" })).rejects.toThrow("exa.ai");
    } finally {
      if (origKey !== undefined) process.env.EXA_API_KEY = origKey;
    }
  });

  it("POSTs to Exa /answer with x-api-key header", async () => {
    const origKey = process.env.EXA_API_KEY;
    process.env.EXA_API_KEY = "exa-test-key";
    const captured: { url: string; method: string; auth: string; body: string } = {
      url: "",
      method: "",
      auth: "",
      body: "",
    };
    const originalFetch = globalThis.fetch;
    globalThis.fetch = vi.fn(async (url: string | URL, init?: RequestInit) => {
      captured.url = String(url);
      captured.method = init?.method ?? "GET";
      captured.auth = String((init?.headers as Record<string, string>)?.["x-api-key"] ?? "");
      captured.body = String(init?.body ?? "");
      return new Response(JSON.stringify(sampleResponse), {
        status: 200,
        headers: { "Content-Type": "application/json" },
      });
    }) as unknown as typeof fetch;
    try {
      const out = await webSearch("test query", { engine: "exa", topK: 5 });
      expect(captured.url).toBe("https://api.exa.ai/answer");
      expect(captured.method).toBe("POST");
      expect(captured.auth).toBe("exa-test-key");
      const body = JSON.parse(captured.body);
      expect(body.query).toBe("test query");
      expect(out[0]).toEqual({
        title: "Exa synthesized answer.",
        url: "",
        snippet: "",
        answer: "Exa synthesized answer.",
      });
      expect(out[1]).toEqual({
        title: "Citation A",
        url: "https://exa.example.com/a",
        snippet: "Snippet A.",
      });
    } finally {
      globalThis.fetch = originalFetch;
      if (origKey === undefined) {
        // biome-ignore lint/performance/noDelete: same reason
        delete process.env.EXA_API_KEY;
      } else {
        process.env.EXA_API_KEY = origKey;
      }
    }
  });

  it("maps 401/403 to a key-rejected error", async () => {
    const origKey = process.env.EXA_API_KEY;
    process.env.EXA_API_KEY = "exa-bad";
    const originalFetch = globalThis.fetch;
    globalThis.fetch = vi.fn(
      async () => new Response("forbidden", { status: 403 }),
    ) as unknown as typeof fetch;
    try {
      await expect(webSearch("q", { engine: "exa" })).rejects.toThrow(/Exa.*rejected/i);
    } finally {
      globalThis.fetch = originalFetch;
      if (origKey === undefined) {
        // biome-ignore lint/performance/noDelete: same reason
        delete process.env.EXA_API_KEY;
      } else {
        process.env.EXA_API_KEY = origKey;
      }
    }
  });

  it("maps 429 to a rate-limit/quota error", async () => {
    const origKey = process.env.EXA_API_KEY;
    process.env.EXA_API_KEY = "exa-test-key";
    const originalFetch = globalThis.fetch;
    globalThis.fetch = vi.fn(
      async () => new Response("too many", { status: 429 }),
    ) as unknown as typeof fetch;
    try {
      await expect(webSearch("q", { engine: "exa" })).rejects.toThrow(/rate-limit|quota/i);
    } finally {
      globalThis.fetch = originalFetch;
      if (origKey === undefined) {
        // biome-ignore lint/performance/noDelete: same reason
        delete process.env.EXA_API_KEY;
      } else {
        process.env.EXA_API_KEY = origKey;
      }
    }
  });

  it("maps unparseable JSON to a parse error", async () => {
    const origKey = process.env.EXA_API_KEY;
    process.env.EXA_API_KEY = "exa-test-key";
    const originalFetch = globalThis.fetch;
    globalThis.fetch = vi.fn(
      async () => new Response("<html>not json</html>", { status: 200 }),
    ) as unknown as typeof fetch;
    try {
      await expect(webSearch("q", { engine: "exa" })).rejects.toThrow(/unparseable/i);
    } finally {
      globalThis.fetch = originalFetch;
      if (origKey === undefined) {
        // biome-ignore lint/performance/noDelete: same reason
        delete process.env.EXA_API_KEY;
      } else {
        process.env.EXA_API_KEY = origKey;
      }
    }
  });
});

describe.skipIf(!searchEngineDeclared("brave"))("searchBrave", () => {
  const sampleResponse = {
    web: {
      results: [
        {
          title: "Brave Result One",
          url: "https://brave.example.com/1",
          description: "First snippet.",
        },
        {
          title: "Brave Result Two",
          url: "https://brave.example.com/2",
          description: "Second snippet.",
        },
      ],
    },
  };

  it("requires an API key — throws a setup-pointing error when none is set", async () => {
    const origKey = process.env.BRAVE_SEARCH_API_KEY;
    const origKeyShort = process.env.BRAVE_API_KEY;
    // biome-ignore lint/performance/noDelete: env var must be absent, not "undefined"
    delete process.env.BRAVE_SEARCH_API_KEY;
    // biome-ignore lint/performance/noDelete: also clear the short alias
    delete process.env.BRAVE_API_KEY;
    try {
      await expect(webSearch("q", { engine: "brave", configPath: "missing.json" })).rejects.toThrow(
        /Brave.*API key/i,
      );
      await expect(webSearch("q", { engine: "brave", configPath: "missing.json" })).rejects.toThrow(
        "brave.com/search/api",
      );
    } finally {
      if (origKey !== undefined) process.env.BRAVE_SEARCH_API_KEY = origKey;
      if (origKeyShort !== undefined) process.env.BRAVE_API_KEY = origKeyShort;
    }
  });

  it("GETs Brave Search API with X-Subscription-Token header and query params", async () => {
    const origKey = process.env.BRAVE_SEARCH_API_KEY;
    process.env.BRAVE_SEARCH_API_KEY = "brave-test-key";
    const captured: { url: string; method: string; token: string } = {
      url: "",
      method: "",
      token: "",
    };
    const originalFetch = globalThis.fetch;
    globalThis.fetch = vi.fn(async (url: string | URL, init?: RequestInit) => {
      captured.url = String(url);
      captured.method = init?.method ?? "GET";
      captured.token = String(
        (init?.headers as Record<string, string>)?.["X-Subscription-Token"] ?? "",
      );
      return new Response(JSON.stringify(sampleResponse), {
        status: 200,
        headers: { "Content-Type": "application/json" },
      });
    }) as unknown as typeof fetch;
    try {
      const out = await webSearch("test query", { engine: "brave", topK: 5 });
      expect(captured.url).toContain("api.search.brave.com/res/v1/web/search");
      expect(captured.url).toContain("q=test%20query");
      expect(captured.url).toContain("count=5");
      expect(captured.method).toBe("GET");
      expect(captured.token).toBe("brave-test-key");
      expect(out).toHaveLength(2);
      expect(out[0]).toEqual({
        title: "Brave Result One",
        url: "https://brave.example.com/1",
        snippet: "First snippet.",
      });
      expect(out[1]).toEqual({
        title: "Brave Result Two",
        url: "https://brave.example.com/2",
        snippet: "Second snippet.",
      });
    } finally {
      globalThis.fetch = originalFetch;
      if (origKey === undefined) {
        // biome-ignore lint/performance/noDelete: same reason
        delete process.env.BRAVE_SEARCH_API_KEY;
      } else {
        process.env.BRAVE_SEARCH_API_KEY = origKey;
      }
    }
  });

  it("maps 401/403 to a key-rejected error", async () => {
    const origKey = process.env.BRAVE_SEARCH_API_KEY;
    process.env.BRAVE_SEARCH_API_KEY = "brave-bad";
    const originalFetch = globalThis.fetch;
    globalThis.fetch = vi.fn(
      async () => new Response("forbidden", { status: 403 }),
    ) as unknown as typeof fetch;
    try {
      await expect(webSearch("q", { engine: "brave" })).rejects.toThrow(/Brave.*rejected/i);
    } finally {
      globalThis.fetch = originalFetch;
      if (origKey === undefined) {
        // biome-ignore lint/performance/noDelete: same reason
        delete process.env.BRAVE_SEARCH_API_KEY;
      } else {
        process.env.BRAVE_SEARCH_API_KEY = origKey;
      }
    }
  });

  it("maps 429 to a rate-limit/quota error", async () => {
    const origKey = process.env.BRAVE_SEARCH_API_KEY;
    process.env.BRAVE_SEARCH_API_KEY = "brave-test-key";
    const originalFetch = globalThis.fetch;
    globalThis.fetch = vi.fn(
      async () => new Response("too many", { status: 429 }),
    ) as unknown as typeof fetch;
    try {
      await expect(webSearch("q", { engine: "brave" })).rejects.toThrow(/rate-limit|quota/i);
    } finally {
      globalThis.fetch = originalFetch;
      if (origKey === undefined) {
        // biome-ignore lint/performance/noDelete: same reason
        delete process.env.BRAVE_SEARCH_API_KEY;
      } else {
        process.env.BRAVE_SEARCH_API_KEY = origKey;
      }
    }
  });

  it("maps unparseable JSON to a parse error", async () => {
    const origKey = process.env.BRAVE_SEARCH_API_KEY;
    process.env.BRAVE_SEARCH_API_KEY = "brave-test-key";
    const originalFetch = globalThis.fetch;
    globalThis.fetch = vi.fn(
      async () => new Response("<html>not json</html>", { status: 200 }),
    ) as unknown as typeof fetch;
    try {
      await expect(webSearch("q", { engine: "brave" })).rejects.toThrow(/unparseable/i);
    } finally {
      globalThis.fetch = originalFetch;
      if (origKey === undefined) {
        // biome-ignore lint/performance/noDelete: same reason
        delete process.env.BRAVE_SEARCH_API_KEY;
      } else {
        process.env.BRAVE_SEARCH_API_KEY = origKey;
      }
    }
  });

  it("returns empty array when web.results is missing or empty", async () => {
    const origKey = process.env.BRAVE_SEARCH_API_KEY;
    process.env.BRAVE_SEARCH_API_KEY = "brave-test-key";
    const originalFetch = globalThis.fetch;
    globalThis.fetch = vi.fn(
      async () =>
        new Response(JSON.stringify({ web: { results: [] } }), {
          status: 200,
          headers: { "Content-Type": "application/json" },
        }),
    ) as unknown as typeof fetch;
    try {
      const out = await webSearch("x", { engine: "brave" });
      expect(out).toEqual([]);
    } finally {
      globalThis.fetch = originalFetch;
      if (origKey === undefined) {
        // biome-ignore lint/performance/noDelete: same reason
        delete process.env.BRAVE_SEARCH_API_KEY;
      } else {
        process.env.BRAVE_SEARCH_API_KEY = origKey;
      }
    }
  });

  it("clamps topK to [1, 20]", async () => {
    const origKey = process.env.BRAVE_SEARCH_API_KEY;
    process.env.BRAVE_SEARCH_API_KEY = "brave-test-key";
    const originalFetch = globalThis.fetch;
    globalThis.fetch = vi.fn(
      async () =>
        new Response(JSON.stringify(sampleResponse), {
          status: 200,
          headers: { "Content-Type": "application/json" },
        }),
    ) as unknown as typeof fetch;
    try {
      const outMax = await webSearch("x", { engine: "brave", topK: 99 });
      expect(outMax.length).toBeLessThanOrEqual(2);
      const outMin = await webSearch("x", { engine: "brave", topK: 0 });
      expect(outMin.length).toBe(1);
    } finally {
      globalThis.fetch = originalFetch;
      if (origKey === undefined) {
        // biome-ignore lint/performance/noDelete: same reason
        delete process.env.BRAVE_SEARCH_API_KEY;
      } else {
        process.env.BRAVE_SEARCH_API_KEY = origKey;
      }
    }
  });
});

describe("formatSearchResults", () => {
  it("renders a query header + numbered list", () => {
    const out = formatSearchResults("hello", [
      { title: "One", url: "https://one", snippet: "first" },
      { title: "Two", url: "https://two", snippet: "second" },
    ]);
    expect(out).toMatch(/query: hello/);
    expect(out).toMatch(/results \(2\)/);
    expect(out).toMatch(/1\. One\n\s+https:\/\/one\n\s+first/);
    expect(out).toMatch(/2\. Two/);
  });

  it("renders the engine line when one is provided", () => {
    const out = formatSearchResults(
      "hello",
      [{ title: "One", url: "https://one", snippet: "" }],
      "tavily",
    );
    expect(out).toMatch(/query: hello\nengine: tavily/);
  });

  it("omits the engine line when none is provided", () => {
    const out = formatSearchResults("hello", [{ title: "One", url: "https://one", snippet: "" }]);
    expect(out).not.toMatch(/engine:/);
  });

  it("renders answer + sources dual-section when an AI answer is present", () => {
    const out = formatSearchResults("hello", [
      { title: "An AI answer.", url: "", snippet: "", answer: "An AI answer." },
      { title: "Citation A", url: "https://a", snippet: "snippet a" },
      { title: "Citation B", url: "https://b", snippet: "" },
    ]);
    expect(out).toMatch(/answer:\n\s+An AI answer\./);
    expect(out).toMatch(/sources \(2\)/);
    expect(out).toMatch(/1\. Citation A\n\s+https:\/\/a\n\s+snippet a/);
    expect(out).toMatch(/2\. Citation B/);
    expect(out).not.toMatch(/^results \(/m);
  });

  it("renders zero-result guidance when results are empty", () => {
    const out = formatSearchResults("obscure item 2881", [], "brave");
    expect(out).toMatch(/query: obscure item 2881/);
    expect(out).toMatch(/engine: brave/);
    expect(out).toMatch(/results \(0\): \(no matches found\)/);
    expect(out).toMatch(/\[Guidance\] Search returned 0 results/);
    expect(out).toMatch(/Do not repeat searches for this topic/);
  });
});

describe("registerWebTools", () => {
  const isolatedConfigPath = "/tmp/reasonix-web-tools-test-config-does-not-exist.json";

  it("registers web_search and web_fetch", () => {
    const registry = new ToolRegistry();
    registerWebTools(registry, { configPath: isolatedConfigPath });
    expect(registry.size).toBe(2);
  });

  it("web_fetch refuses non-http(s) urls", async () => {
    const registry = new ToolRegistry();
    registerWebTools(registry, { configPath: isolatedConfigPath });
    const out = await registry.dispatch("web_fetch", JSON.stringify({ url: "file:///etc/passwd" }));
    expect(out).toMatch(/must start with http/);
  });

  it("web_search dispatch returns formatted results", async () => {
    const html = `
      <li class="b_algo"><h2><a href="https://example.com/a">A</a></h2>
        <div class="b_caption"><p>snippet A</p></div></li>
      <li class="b_algo"><h2><a href="https://example.com/b">B</a></h2>
        <div class="b_caption"><p>snippet B</p></div></li>`;
    const originalFetch = globalThis.fetch;
    globalThis.fetch = vi.fn(
      async () => new Response(html, { status: 200, headers: { "Content-Type": "text/html" } }),
    ) as unknown as typeof fetch;
    try {
      const registry = new ToolRegistry();
      registerWebTools(registry, { configPath: isolatedConfigPath });
      const out = await registry.dispatch(
        "web_search",
        JSON.stringify({ query: "flutter 3.19", topK: 2 }),
      );
      expect(out).toContain("query: flutter 3.19");
      expect(out).toContain("engine: bing");
      expect(out).toContain("https://example.com/a");
      expect(out).toContain("snippet A");
    } finally {
      globalThis.fetch = originalFetch;
    }
  });

  it("fails the call when the configured engine fails, without a substitute engine", async () => {
    const originalFetch = globalThis.fetch;
    const calls: string[] = [];
    globalThis.fetch = vi.fn(async (url: string | URL) => {
      calls.push(String(url));
      throw new TypeError("fetch failed");
    }) as unknown as typeof fetch;
    try {
      const registry = new ToolRegistry();
      registerWebTools(registry, { configPath: isolatedConfigPath });
      const out = await registry.dispatch("web_search", JSON.stringify({ query: "q" }));
      expect(out).toContain("Cannot reach");
      expect(out).not.toContain("[fallback]");
      expect(calls).toHaveLength(1);
    } finally {
      globalThis.fetch = originalFetch;
    }
  });

  it("appends consecutive search directive on repeated empty searches", async () => {
    const emptyHtml = "<html><body>Your search did not match any documents.</body></html>";
    const originalFetch = globalThis.fetch;
    globalThis.fetch = vi.fn(
      async () =>
        new Response(emptyHtml, { status: 200, headers: { "Content-Type": "text/html" } }),
    ) as unknown as typeof fetch;
    try {
      const registry = new ToolRegistry();
      registerWebTools(registry, { configPath: isolatedConfigPath });
      const first = await registry.dispatch(
        "web_search",
        JSON.stringify({ query: "obscure-tool-1", topK: 2 }),
      );
      expect(first).toContain("[Guidance] Search returned 0 results");
      expect(first).not.toContain("[Directive]");

      const second = await registry.dispatch(
        "web_search",
        JSON.stringify({ query: "obscure-tool-2", topK: 2 }),
      );
      expect(second).toContain("[Directive] Consecutive web searches returned 0 results");
      expect(second).toContain("STOP web searches for this issue");
    } finally {
      globalThis.fetch = originalFetch;
    }
  });

  it("web_fetch dispatch returns title + body text", async () => {
    const originalFetch = globalThis.fetch;
    globalThis.fetch = vi.fn(
      async () =>
        new Response(
          "<html><head><title>Demo</title></head><body><p>Hello world.</p></body></html>",
          { status: 200, headers: { "Content-Type": "text/html; charset=utf-8" } },
        ),
    ) as unknown as typeof fetch;
    try {
      const registry = new ToolRegistry();
      registerWebTools(registry, { configPath: isolatedConfigPath });
      const out = await registry.dispatch(
        "web_fetch",
        JSON.stringify({ url: "https://example.com/" }),
      );
      expect(out).toContain("Demo");
      expect(out).toContain("https://example.com/");
      expect(out).toContain("Hello world.");
      expect(out).toContain("engine: bing");
    } finally {
      globalThis.fetch = originalFetch;
    }
  });

  it("web_search can dispatch through Ollama cloud", async () => {
    const configPath = "/tmp/reasonix-web-tools-ollama-search-test.json";
    writeConfig({ webSearchEngine: "ollama", ollamaApiKey: "ollama-test-key" }, configPath);
    const originalFetch = globalThis.fetch;
    globalThis.fetch = vi.fn(async (_url, init) => {
      expect(_url).toBe("https://ollama.com/api/web_search");
      expect((init as RequestInit).headers).toMatchObject({
        Authorization: "Bearer ollama-test-key",
      });
      expect(JSON.parse((init as RequestInit).body as string)).toMatchObject({
        query: "reasonix",
        max_results: 2,
      });
      return new Response(
        JSON.stringify({
          results: [{ title: "Reasonix", url: "https://example.com/r", content: "Result body" }],
        }),
        { status: 200, headers: { "Content-Type": "application/json" } },
      );
    }) as unknown as typeof fetch;
    try {
      const registry = new ToolRegistry();
      registerWebTools(registry, { configPath });
      const out = await registry.dispatch(
        "web_search",
        JSON.stringify({ query: "reasonix", topK: 2 }),
      );
      expect(out).toContain("https://example.com/r");
      expect(out).toContain("Result body");
    } finally {
      globalThis.fetch = originalFetch;
    }
  });

  it("web_fetch can dispatch through Ollama cloud when selected", async () => {
    const configPath = "/tmp/reasonix-web-tools-ollama-fetch-test.json";
    writeConfig({ webSearchEngine: "ollama", ollamaApiKey: "ollama-test-key" }, configPath);
    const originalFetch = globalThis.fetch;
    globalThis.fetch = vi.fn(async (_url, init) => {
      expect(_url).toBe("https://ollama.com/api/web_fetch");
      expect((init as RequestInit).headers).toMatchObject({
        Authorization: "Bearer ollama-test-key",
      });
      expect(JSON.parse((init as RequestInit).body as string)).toMatchObject({
        url: "https://example.com/page",
      });
      return new Response(
        JSON.stringify({
          title: "Fetched",
          content: "Fetched content",
          links: ["https://example.com/next"],
        }),
        { status: 200, headers: { "Content-Type": "application/json" } },
      );
    }) as unknown as typeof fetch;
    try {
      const registry = new ToolRegistry();
      registerWebTools(registry, { configPath });
      const out = await registry.dispatch(
        "web_fetch",
        JSON.stringify({ url: "https://example.com/page" }),
      );
      expect(out).toContain("Fetched");
      expect(out).toContain("Fetched content");
      expect(out).toContain("https://example.com/next");
      expect(out).toContain("engine: ollama");
    } finally {
      globalThis.fetch = originalFetch;
    }
  });

  it("maps an engine fetch API's status onto that engine's declared copy", async () => {
    const configPath = "/tmp/reasonix-web-tools-engine-fetch-errors.json";
    const originalFetch = globalThis.fetch;
    const originalKey = process.env.OLLAMA_API_KEY;
    process.env.OLLAMA_API_KEY = "ollama-test-key";
    try {
      for (const [status, expected] of [
        [401, /Ollama API key rejected/],
        [429, /Ollama web fetch is rate-limited or quota-limited/],
        [503, /Ollama web fetch returned HTTP 503/],
      ] as const) {
        writeConfig({ webSearchEngine: "ollama" }, configPath);
        globalThis.fetch = vi.fn(
          async () => new Response("nope", { status }),
        ) as unknown as typeof fetch;
        const registry = new ToolRegistry();
        registerWebTools(registry, { configPath });
        const out = await registry.dispatch(
          "web_fetch",
          JSON.stringify({ url: "https://example.com/page" }),
        );
        expect(out).toMatch(expected);
      }
    } finally {
      globalThis.fetch = originalFetch;
      if (originalKey === undefined) {
        // biome-ignore lint/performance/noDelete: restoring an absent env var
        delete process.env.OLLAMA_API_KEY;
      } else {
        process.env.OLLAMA_API_KEY = originalKey;
      }
    }
  });

  it("web_search can dispatch through DeepSeek's own Search API", async () => {
    const configPath = "/tmp/reasonix-web-tools-deepseek-search-test.json";
    writeConfig({ webSearchEngine: "deepseek" }, configPath);
    const originalFetch = globalThis.fetch;
    const originalKey = process.env.DEEPSEEK_API_KEY;
    // Env outranks the config store, so this keeps the test off any real key.
    process.env.DEEPSEEK_API_KEY = "sk-deepseek-test";
    globalThis.fetch = vi.fn(async (url, init) => {
      expect(url).toBe("https://api.deepseek.com/v1/tools/search");
      expect((init as RequestInit).headers).toMatchObject({
        Authorization: "Bearer sk-deepseek-test",
      });
      expect(JSON.parse((init as RequestInit).body as string)).toMatchObject({
        query: "deepseek balance",
        count: 2,
        need_content: false,
      });
      return new Response(
        JSON.stringify({
          results: [
            {
              title: "Balance API",
              url: "https://api-docs.deepseek.com/api/get-user-balance",
              snippet: "Returns the account balance.",
              summary: "longer summary",
            },
            { title: "No url", snippet: "dropped" },
          ],
        }),
        { status: 200, headers: { "Content-Type": "application/json" } },
      );
    }) as unknown as typeof fetch;
    try {
      const registry = new ToolRegistry();
      registerWebTools(registry, { configPath });
      const out = await registry.dispatch(
        "web_search",
        JSON.stringify({ query: "deepseek balance", topK: 2 }),
      );
      expect(out).toContain("engine: deepseek");
      expect(out).toContain("Balance API");
      expect(out).toContain("https://api-docs.deepseek.com/api/get-user-balance");
      expect(out).toContain("Returns the account balance.");
      expect(out).not.toContain("No url");
    } finally {
      globalThis.fetch = originalFetch;
      if (originalKey === undefined) {
        // biome-ignore lint/performance/noDelete: restoring an absent env var
        delete process.env.DEEPSEEK_API_KEY;
      } else {
        process.env.DEEPSEEK_API_KEY = originalKey;
      }
    }
  });

  it("web_fetch can dispatch through DeepSeek's Fetch API when selected", async () => {
    const configPath = "/tmp/reasonix-web-tools-deepseek-fetch-test.json";
    writeConfig({ webSearchEngine: "deepseek" }, configPath);
    const originalFetch = globalThis.fetch;
    const originalKey = process.env.DEEPSEEK_API_KEY;
    process.env.DEEPSEEK_API_KEY = "sk-deepseek-test";
    globalThis.fetch = vi.fn(async (url, init) => {
      expect(url).toBe("https://api.deepseek.com/v1/tools/fetch");
      expect(JSON.parse((init as RequestInit).body as string)).toEqual({
        url: "https://example.com/page",
      });
      return new Response(
        JSON.stringify({ title: "Fetched page", content: "# Heading\n\nBody as markdown." }),
        { status: 200, headers: { "Content-Type": "application/json" } },
      );
    }) as unknown as typeof fetch;
    try {
      const registry = new ToolRegistry();
      registerWebTools(registry, { configPath });
      const out = await registry.dispatch(
        "web_fetch",
        JSON.stringify({ url: "https://example.com/page" }),
      );
      expect(out).toContain("engine: deepseek");
      expect(out).toContain("Fetched page");
      expect(out).toContain("Body as markdown.");
    } finally {
      globalThis.fetch = originalFetch;
      if (originalKey === undefined) {
        // biome-ignore lint/performance/noDelete: restoring an absent env var
        delete process.env.DEEPSEEK_API_KEY;
      } else {
        process.env.DEEPSEEK_API_KEY = originalKey;
      }
    }
  });
});

/** The keyless engine end to end at tool level: config to engine to managed browser. */
describe("web_search through the managed browser engine", () => {
  const declared = searchEngineDeclared("playwright-webkit");
  const configDir = mkdtempSync(join(tmpdir(), "reasonix-web-search-browser-"));
  const configPath = join(configDir, "config.json");
  const DDG_HTML = `
    <div class="result results_links web-result">
      <a class="result__a" href="https://example.com/docs">Deepseek balance docs</a>
      <a class="result__snippet" href="https://example.com/docs">alpha snippet</a>
    </div>
    <div class="result results_links web-result">
      <a class="result__a" href="https://example.com/api">Deepseek balance API</a>
      <a class="result__snippet" href="https://example.com/api">beta snippet</a>
    </div>`;

  beforeEach(() => {
    writeConfig({ webSearchEngine: "playwright-webkit" }, configPath);
  });

  afterEach(async () => {
    await closeWebFetchPages();
    await closeBrowserSearches();
    __setBrowserCoreLoaderForTests(null);
  });

  /** A playwright-core stand-in whose DuckDuckGo page is already rendered. */
  function fakeCore(html = DDG_HTML) {
    return {
      kind: "ok" as const,
      core: {
        webkit: {
          executablePath: () => "/fake/chrome",
          launch: async () => ({
            newContext: async () => ({
              newPage: async () =>
                pageStub({ html, title: "SERP", url: "https://duckduckgo.com/" }).page,
              close: async () => undefined,
            }),
            close: async () => undefined,
          }),
        },
      } as never,
      executablePath: "/fake/chrome",
    };
  }

  it.skipIf(!declared)("dispatches the configured engine and formats its hits", async () => {
    __setBrowserCoreLoaderForTests(() => fakeCore());
    const registry = new ToolRegistry();
    registerWebTools(registry, { configPath });
    const out = await registry.dispatch(
      "web_search",
      JSON.stringify({ query: "deepseek balance", topK: 2 }),
    );
    expect(out).toContain("query: deepseek balance");
    expect(out).toContain("engine: playwright-webkit");
    expect(out).toContain("https://example.com/docs");
    expect(out).toContain("alpha snippet");
  });

  it.skipIf(!declared)(
    "surfaces the install guidance when the browser build is absent",
    async () => {
      __setBrowserCoreLoaderForTests(() => ({ kind: "notInstalled" }));
      const registry = new ToolRegistry();
      registerWebTools(registry, { configPath });
      const out = await registry.dispatch(
        "web_search",
        JSON.stringify({ query: "deepseek balance" }),
      );
      expect(out).toContain("npx playwright install webkit");
    },
  );

  it.skipIf(!declared)(
    "reads the SERP through the session page and keeps it for the fetch",
    async () => {
      const stubs: Array<ReturnType<typeof pageStub>> = [];
      const core = {
        kind: "ok" as const,
        core: {
          webkit: {
            executablePath: () => "/fake/chrome",
            launch: async () => ({
              newContext: async () => ({
                newPage: async () => {
                  const stub = pageStub({
                    html: DDG_HTML,
                    title: "SERP",
                    url: "https://duckduckgo.com/",
                  });
                  stubs.push(stub);
                  return stub.page;
                },
                close: async () => undefined,
              }),
              close: async () => undefined,
            }),
          },
        } as never,
        executablePath: "/fake/chrome",
      };
      __setBrowserCoreLoaderForTests(() => core);
      const registry = new ToolRegistry();
      registerWebTools(registry, { configPath });
      const sessionName = "shared-page";
      const rootDir = mkdtempSync(join(tmpdir(), "reasonix-web-search-shared-"));

      const found = (await registry.dispatch(
        "web_search",
        JSON.stringify({ query: "deepseek balance", topK: 2 }),
        { sessionName },
      )) as string;
      expect(found).toContain("https://example.com/docs");

      // The fetch acts on the page the search left: no second page, one stub.
      const fetched = (await registry.dispatch("web_fetch", JSON.stringify({ action: "read" }), {
        sessionName,
        rootDir,
      })) as string;
      expect(stubs).toHaveLength(1);
      expect(fetched).toContain("alpha snippet");
    },
  );

  it.skipIf(!declared)("lets a per-call Stop cancel a browser search", async () => {
    let resolutions = 0;
    __setBrowserCoreLoaderForTests(() => {
      resolutions += 1;
      return fakeCore();
    });
    const registry = new ToolRegistry();
    registerWebTools(registry, { configPath });
    const controller = new AbortController();
    controller.abort();
    const out = await registry.dispatch(
      "web_search",
      JSON.stringify({ query: "deepseek balance" }),
      { cancelSignal: controller.signal },
    );
    expect(out).toContain("cancelledByUser");
    // The search aborted before touching the browser install.
    expect(resolutions).toBe(0);
  });

  it("leaves a direct-read engine on its own transport", async () => {
    let resolutions = 0;
    __setBrowserCoreLoaderForTests(() => {
      resolutions += 1;
      return { kind: "notInstalled" };
    });
    const directDir = mkdtempSync(join(tmpdir(), "reasonix-web-search-direct-"));
    const directConfig = join(directDir, "config.json");
    writeConfig({ webSearchEngine: "bing" }, directConfig);
    const originalFetch = globalThis.fetch;
    globalThis.fetch = vi.fn(
      async () =>
        new Response(
          '<li class="b_algo"><h2><a href="https://example.com/hit">Deepseek balance</a></h2></li>',
          { status: 200, headers: { "content-type": "text/html" } },
        ),
    ) as unknown as typeof fetch;
    try {
      const registry = new ToolRegistry();
      registerWebTools(registry, { configPath: directConfig });
      const out = (await registry.dispatch(
        "web_search",
        JSON.stringify({ query: "deepseek balance" }),
        { sessionName: "direct-engine" },
      )) as string;
      expect(out).toContain("engine: bing");
      expect(out).toContain("https://example.com/hit");
      // A non-browser engine never opens the shared page.
      expect(resolutions).toBe(0);
    } finally {
      globalThis.fetch = originalFetch;
    }
  });

  it.each(["ollama", "deepseek"])("web_fetch on %s keeps its own fetch API", async (engine) => {
    const dir = mkdtempSync(join(tmpdir(), "reasonix-engine-fetch-api-"));
    const configPath = join(dir, "config.json");
    writeConfig({ webSearchEngine: engine }, configPath);
    const registry = new ToolRegistry();
    registerWebTools(registry, { configPath });
    const originalFetch = globalThis.fetch;
    // Offline: the engine's own API answers with a server error, so the copy proves routing.
    globalThis.fetch = vi.fn(
      async () =>
        new Response("[]", { status: 500, headers: { "content-type": "application/json" } }),
    ) as unknown as typeof fetch;
    try {
      const out = (await registry.dispatch(
        "web_fetch",
        JSON.stringify({ url: "https://example.com/page" }),
        { sessionName: `api-${engine}`, rootDir: dir },
      )) as string;
      // Its own declaration answers: not a browser render, not the generic read.
      expect(out).toMatch(/web_fetch: (Ollama|DeepSeek)/);
      expect(out).not.toContain("WebKit");
      expect(out).not.toContain("preview:");
    } finally {
      globalThis.fetch = originalFetch;
    }
  });
});

/** Rendering a page in the managed browser: the text a plain read cannot see, plus the
 *  screenshot the card shows. */
describe("web_fetch through the managed browser engine", () => {
  const declared = searchEngineDeclared("playwright-webkit");
  const configDir = mkdtempSync(join(tmpdir(), "reasonix-web-fetch-browser-"));
  const configPath = join(configDir, "config.json");
  const rootDir = mkdtempSync(join(tmpdir(), "reasonix-web-fetch-root-"));
  const PAGE_HTML =
    "<html><head><title>Rendered Page</title></head><body><p>script-rendered body text</p></body></html>";

  let contexts: Array<{ viewport?: { width: number; height: number } }> = [];

  beforeEach(() => {
    contexts = [];
    writeConfig({ webSearchEngine: "playwright-webkit" }, configPath);
  });

  afterEach(async () => {
    await closeWebFetchPages();
    await closeBrowserSearches();
    __setBrowserCoreLoaderForTests(null);
  });

  /** A playwright-core stand-in that renders a page and captures it. */
  function renderingCore(overrides: { screenshotError?: Error } = {}) {
    return {
      kind: "ok" as const,
      core: {
        webkit: {
          executablePath: () => "/fake/chrome",
          launch: async () => ({
            newContext: async (contextOpts: unknown) => {
              contexts.push(contextOpts);
              return {
                newPage: async () =>
                  pageStub({
                    html: PAGE_HTML,
                    title: "Rendered Page",
                    url: "https://example.com/final",
                    screenshotError: overrides.screenshotError,
                  }).page,
                close: async () => undefined,
              };
            },
            close: async () => undefined,
          }),
        },
      } as never,
      executablePath: "/fake/chrome",
    };
  }

  it.skipIf(!declared)("renders the page and reports its preview for the card", async () => {
    __setBrowserCoreLoaderForTests(() => renderingCore());
    const registry = new ToolRegistry();
    registerWebTools(registry, { configPath });
    const out = (await registry.dispatch(
      "web_fetch",
      JSON.stringify({ url: "https://example.com/page" }),
      { rootDir },
    )) as string;

    expect(out).toContain("engine: playwright-webkit");
    expect(out).toContain("script-rendered body text");
    expect(out).toContain("https://example.com/final");
    // The card finds the preview through this line, so it names a real PNG on disk.
    const preview = /^preview: (.+)$/m.exec(out)?.[1];
    expect(preview).toBeTruthy();
    expect(existsSync(preview!)).toBe(true);
    expect(preview).toContain(".reasonix");
    expect(readFileSync(preview!).toString()).toBe("page-png");
    // A render is a small transient window, not the SERP viewport.
    expect(contexts[0]?.viewport).toEqual({ width: 900, height: 1200 });
  });

  it.skipIf(!declared)("keeps the rendered text when the capture fails", async () => {
    __setBrowserCoreLoaderForTests(() =>
      renderingCore({ screenshotError: new Error("no capture") }),
    );
    const registry = new ToolRegistry();
    registerWebTools(registry, { configPath });
    const out = (await registry.dispatch(
      "web_fetch",
      JSON.stringify({ url: "https://example.com/page" }),
      { rootDir },
    )) as string;

    expect(out).toContain("script-rendered body text");
    expect(out).not.toContain("preview:");
  });

  it.skipIf(!declared)("falls back to a plain read when the browser is missing", async () => {
    __setBrowserCoreLoaderForTests(() => ({ kind: "notInstalled" }));
    const originalFetch = globalThis.fetch;
    globalThis.fetch = vi.fn(
      async () =>
        new Response("<html><head><title>Plain</title></head><body>plain body</body></html>", {
          status: 200,
          headers: { "content-type": "text/html" },
        }),
    ) as unknown as typeof fetch;
    try {
      const registry = new ToolRegistry();
      registerWebTools(registry, { configPath });
      const out = (await registry.dispatch(
        "web_fetch",
        JSON.stringify({ url: "https://example.com/page" }),
        { rootDir },
      )) as string;

      expect(out).toContain("plain body");
      // The reader is told the text came from a plain read, not a render.
      expect(out).toContain("render: unavailable");
      expect(out).not.toContain("preview:");
    } finally {
      globalThis.fetch = originalFetch;
    }
  });
});

/** A host that refuses a plain client but renders for a real browser: the refusal must
 *  not end the fetch when a managed build is available. */
describe("web_fetch through a bot-blocking host", () => {
  const declared = searchEngineDeclared("playwright-webkit");
  const configDir = mkdtempSync(join(tmpdir(), "reasonix-web-fetch-blocked-"));
  const configPath = join(configDir, "config.json");
  const rootDir = mkdtempSync(join(tmpdir(), "reasonix-web-fetch-blocked-root-"));
  const RENDERED_HTML =
    "<html><head><title>Blocked page rendered</title></head><body><p>gag listing text</p></body></html>";

  beforeEach(() => {
    // A direct-read engine: this is the case the browser covers as a fallback.
    writeConfig({ webSearchEngine: "bing" }, configPath);
  });

  afterEach(async () => {
    await closeWebFetchPages();
    await closeBrowserSearches();
    __setBrowserCoreLoaderForTests(null);
  });

  function renderedCore() {
    return {
      kind: "ok" as const,
      core: {
        webkit: {
          executablePath: () => "/fake/chrome",
          launch: async () => ({
            newContext: async () => ({
              newPage: async () =>
                pageStub({
                  html: RENDERED_HTML,
                  title: "Blocked page rendered",
                  url: "https://9gag.com/tag/rick-roll",
                  status: 403,
                }).page,
              close: async () => undefined,
            }),
            close: async () => undefined,
          }),
        },
      } as never,
      executablePath: "/fake/chrome",
    };
  }

  function answeringFetch(status: number) {
    return vi.fn(
      async () =>
        new Response("<html><body>plain</body></html>", {
          status,
          headers: { "content-type": "text/html" },
        }),
    ) as unknown as typeof fetch;
  }

  it.skipIf(!declared)("renders the page when the plain read is refused with 403", async () => {
    __setBrowserCoreLoaderForTests(() => renderedCore());
    const originalFetch = globalThis.fetch;
    globalThis.fetch = answeringFetch(403);
    try {
      const registry = new ToolRegistry();
      registerWebTools(registry, { configPath });
      const out = (await registry.dispatch(
        "web_fetch",
        JSON.stringify({ url: "https://9gag.com/tag/rick-roll" }),
        { rootDir },
      )) as string;

      expect(out).toContain("gag listing text");
      expect(out).toMatch(/^preview: /m);
      // The reader is told the plain read was refused rather than silently swapped.
      expect(out).toContain("render: plain read refused (403)");
    } finally {
      globalThis.fetch = originalFetch;
    }
  });

  it.skipIf(!declared)("reports the refusal when no managed build can render", async () => {
    __setBrowserCoreLoaderForTests(() => ({ kind: "notInstalled" }));
    const originalFetch = globalThis.fetch;
    globalThis.fetch = answeringFetch(403);
    try {
      const registry = new ToolRegistry();
      registerWebTools(registry, { configPath });
      const out = (await registry.dispatch(
        "web_fetch",
        JSON.stringify({ url: "https://9gag.com/tag/rick-roll" }),
        { rootDir },
      )) as string;
      // No build to render with, so the refusal itself is the answer, unchanged.
      expect(out).toContain("403");
      expect(out).not.toContain("preview:");
    } finally {
      globalThis.fetch = originalFetch;
    }
  });

  it("leaves other statuses on the direct path", async () => {
    const originalFetch = globalThis.fetch;
    globalThis.fetch = answeringFetch(404);
    try {
      const registry = new ToolRegistry();
      registerWebTools(registry, { configPath });
      const out = (await registry.dispatch(
        "web_fetch",
        JSON.stringify({ url: "https://example.com/gone" }),
        { rootDir },
      )) as string;
      // Only bot-gate statuses reach for the browser; a real 404 stays a 404.
      expect(out).toContain("404");
    } finally {
      globalThis.fetch = originalFetch;
    }
  });

  it("reads a plain url directly on a direct-read engine", async () => {
    // The fast path stays fast: no browser launch, no page kept open.
    __setBrowserCoreLoaderForTests(() => ({ kind: "notInstalled" }));
    const originalFetch = globalThis.fetch;
    globalThis.fetch = vi.fn(
      async () =>
        new Response("<html><body>direct body</body></html>", {
          status: 200,
          headers: { "content-type": "text/html" },
        }),
    ) as unknown as typeof fetch;
    try {
      const registry = new ToolRegistry();
      registerWebTools(registry, { configPath });
      const out = (await registry.dispatch(
        "web_fetch",
        JSON.stringify({ url: "https://example.com/plain" }),
        { rootDir },
      )) as string;
      expect(out).toContain("direct body");
      expect(out).not.toContain("page:");
      expect(out).not.toContain("render: unavailable");
    } finally {
      globalThis.fetch = originalFetch;
    }
  });

  it("asks for a url when a control action has no page open", async () => {
    const registry = new ToolRegistry();
    registerWebTools(registry, { configPath });
    const out = (await registry.dispatch("web_fetch", JSON.stringify({ action: "scroll" }), {
      rootDir,
      sessionName: "fresh-direct-session",
    })) as string;
    expect(out).toContain("pass a url to open one");
  });
});

/** Driving one page across calls: the loop that reaches content a single read cannot. */
/** Searching a site's own page instead of a fixed SERP: the freedom a browser gives. */
describe("web_search over a supplied page", () => {
  const declared = searchEngineDeclared("playwright-webkit");
  const LISTING = `
    <html><body>
      <nav><a href="/about">About this site</a></nav>
      <main>
        <article><a href="/watch?v=aaa">Rock material tutorial for Substance Designer</a>
          <p>Rock and moss cliff material in Substance Designer from scratch.</p></article>
        <article><a href="/watch?v=bbb">Material artist portfolio review</a>
          <p>Portfolio critique for environment artists.</p></article>
        <article><a href="https://example.com/extra">External material reference</a></article>
      </main>
      <a href="#top">back to top</a>
      <a href="javascript:void(0)">menu</a>
    </body></html>`;

  const configDir = mkdtempSync(join(tmpdir(), "reasonix-web-url-search-"));
  const configPath = join(configDir, "config.json");
  const rootDir = mkdtempSync(join(tmpdir(), "reasonix-web-url-search-root-"));

  beforeEach(() => {
    writeConfig({ webSearchEngine: "playwright-webkit" }, configPath);
  });

  afterEach(async () => {
    await closeWebFetchPages();
    await closeBrowserSearches();
    __setBrowserCoreLoaderForTests(null);
  });

  function listingCore() {
    return {
      kind: "ok" as const,
      core: {
        webkit: {
          executablePath: () => "/fake/chrome",
          launch: async () => ({
            newContext: async () => ({
              newPage: async () =>
                pageStub({
                  html: LISTING,
                  title: "Site search",
                  url: "https://videos.example/search?q=rock",
                }).page,
              close: async () => undefined,
            }),
            close: async () => undefined,
          }),
        },
      } as never,
      executablePath: "/fake/chrome",
    };
  }

  it("fills the query into the template", () => {
    expect(fillQueryTemplate("https://x.test/search?q={q}", "material artist")).toBe(
      "https://x.test/search?q=material%20artist",
    );
    expect(fillQueryTemplate("https://x.test/s?q=%s", "a&b")).toBe("https://x.test/s?q=a%26b");
    // No placeholder: a fixed listing page is read as-is.
    expect(fillQueryTemplate("https://x.test/tag/rick-roll", "ignored")).toBe(
      "https://x.test/tag/rick-roll",
    );
  });

  it.skipIf(!declared)("reads the page's links, ranked and de-duplicated", async () => {
    __setBrowserCoreLoaderForTests(() => listingCore());
    const registry = new ToolRegistry();
    registerWebTools(registry, { configPath });
    const out = (await registry.dispatch(
      "web_search",
      JSON.stringify({
        query: "material rock tutorial",
        url: "https://videos.example/search?q={q}",
        topK: 2,
      }),
      { sessionName: "page-search", rootDir },
    )) as string;

    expect(out).toContain("source: https://videos.example/search?q=rock");
    // The most on-query link wins, and relative hrefs were resolved against the page.
    expect(out).toContain("https://videos.example/watch?v=aaa");
    expect(out).toContain("Rock material tutorial");
    expect(out).toContain("v=bbb");
    // Anchors and javascript: links are navigation, not results.
    expect(out).not.toContain("#top");
    expect(out).not.toContain("javascript:");
    expect(out).not.toContain("About this site");
  });

  it.skipIf(!declared)("honours a linkSelector for a page full of navigation", async () => {
    __setBrowserCoreLoaderForTests(() => listingCore());
    const registry = new ToolRegistry();
    registerWebTools(registry, { configPath });
    const out = (await registry.dispatch(
      "web_search",
      JSON.stringify({
        query: "material",
        url: "https://videos.example/search?q={q}",
        linkSelector: "article a",
      }),
      { sessionName: "page-search-selector", rootDir },
    )) as string;

    expect(out).toContain("watch?v=aaa");
    expect(out).toContain("watch?v=bbb");
    expect(out).not.toContain("/about");
  });

  it.skipIf(!declared)("says so when the page has no result links", async () => {
    __setBrowserCoreLoaderForTests(
      () =>
        ({
          kind: "ok",
          core: {
            webkit: {
              executablePath: () => "/fake/chrome",
              launch: async () => ({
                newContext: async () => ({
                  newPage: async () =>
                    pageStub({
                      html: "<html><body><p>nothing</p></body></html>",
                      title: "x",
                      url: "https://empty.test/",
                    }).page,
                  close: async () => undefined,
                }),
                close: async () => undefined,
              }),
            },
          },
        }) as never,
    );
    const registry = new ToolRegistry();
    registerWebTools(registry, { configPath });
    const out = (await registry.dispatch(
      "web_search",
      JSON.stringify({ query: "x", url: "https://empty.test/search?q={q}" }),
      { sessionName: "page-search-empty", rootDir },
    )) as string;
    expect(out).toContain("no result links on");
    expect(out).toContain("linkSelector");
  });
});

describe("web_fetch page control", () => {
  const declared = searchEngineDeclared("playwright-webkit");
  const configDir = mkdtempSync(join(tmpdir(), "reasonix-web-fetch-drive-"));
  const configPath = join(configDir, "config.json");
  const rootDir = mkdtempSync(join(tmpdir(), "reasonix-web-fetch-drive-root-"));
  const PAGE_HTML =
    "<html><head><title>Driven Page</title></head><body><p>body copy</p><div id=comments>thread</div></body></html>";

  beforeEach(() => {
    writeConfig({ webSearchEngine: "playwright-webkit" }, configPath);
  });

  afterEach(async () => {
    await closeWebFetchPages();
    await closeBrowserSearches();
    __setBrowserCoreLoaderForTests(null);
  });

  function drivingCore(stubOptions: Partial<Parameters<typeof pageStub>[0]> = {}) {
    const stubs: Array<ReturnType<typeof pageStub>> = [];
    const core = {
      kind: "ok" as const,
      core: {
        webkit: {
          executablePath: () => "/fake/chrome",
          launch: async () => ({
            newContext: async () => ({
              newPage: async () => {
                const stub = pageStub({
                  html: PAGE_HTML,
                  title: "Driven Page",
                  url: "https://example.com/driving",
                  ...stubOptions,
                });
                stubs.push(stub);
                return stub.page;
              },
              close: async () => undefined,
            }),
            close: async () => undefined,
          }),
        },
      } as never,
      executablePath: "/fake/chrome",
    };
    return { core, stubs };
  }

  async function drive(args: Record<string, unknown>, session = "drive") {
    const registry = new ToolRegistry();
    registerWebTools(registry, { configPath });
    return (await registry.dispatch("web_fetch", JSON.stringify(args), {
      rootDir,
      sessionName: session,
    })) as string;
  }

  it.skipIf(!declared)("keeps the page open so the next call does not navigate again", async () => {
    const { core, stubs } = drivingCore();
    __setBrowserCoreLoaderForTests(() => core);

    const opened = await drive({ url: "https://example.com/driving" });
    expect(opened).toContain("engine: playwright-webkit");
    expect(opened).toContain("body copy");
    // The state line is what tells a caller whether more is below.
    expect(opened).toMatch(/^page: acted=no scrollY=0\/2400/m);

    const read = await drive({ action: "read" });
    expect(read).toContain("body copy");
    // One page, one navigation: the second call reused it.
    expect(stubs).toHaveLength(1);
    expect(stubs[0]!.calls.gotos).toEqual(["https://example.com/driving"]);
  });

  it.skipIf(!declared)("reports scrolling and what is left below", async () => {
    const { core, stubs } = drivingCore({ scrollStep: 1200, present: { "#comments": true } });
    __setBrowserCoreLoaderForTests(() => core);

    await drive({ url: "https://example.com/driving" });
    const scrolled = await drive({ action: "scroll", scrolls: 1, selector: "#comments" });
    expect(stubs[0]!.calls.keys).toEqual(["End"]);
    expect(scrolled).toContain("scrollY=1200/2400");
    expect(scrolled).toContain("below=0 (end of page)");
    expect(scrolled).toContain("acted=yes");
    expect(scrolled).toContain("present: #comments=yes");
  });

  it.skipIf(!declared)("returns the probed section on its own", async () => {
    const { core } = drivingCore({
      present: { "#comments": true },
      sectionText: "@someone: funniest thread here",
    });
    __setBrowserCoreLoaderForTests(() => core);

    await drive({ url: "https://example.com/driving" });
    const read = await drive({ action: "read", selector: "#comments" });
    // The section arrives separately, so page chrome cannot crowd it out of the cap.
    expect(read).toContain("section [#comments]:");
    expect(read).toContain("funniest thread here");
  });

  it.skipIf(!declared)("clicks a selector and reports whether it exists", async () => {
    const { core, stubs } = drivingCore({ present: { "#comments": true } });
    __setBrowserCoreLoaderForTests(() => core);

    await drive({ url: "https://example.com/driving" });
    const clicked = await drive({ action: "click", selector: "#comments" });
    expect(stubs[0]!.calls.clicks).toEqual(["#comments"]);
    expect(clicked).toContain("present: #comments=yes");
  });

  it.skipIf(!declared)("waits for a slow section and says whether it arrived", async () => {
    const { core } = drivingCore({ present: { "#comments": false } });
    __setBrowserCoreLoaderForTests(() => core);

    await drive({ url: "https://example.com/driving" });
    const waited = await drive({ action: "wait", selector: "#comments" });
    expect(waited).toContain("present: #comments=no");
    expect(waited).toContain("acted=yes");
  });

  it.skipIf(!declared)("refuses an action with no page open", async () => {
    const { core } = drivingCore();
    __setBrowserCoreLoaderForTests(() => core);
    const out = await drive({ action: "scroll" }, "empty-session");
    expect(out).toContain("no page is open in this session");
  });

  it.skipIf(!declared)("saves a long page to the workspace and returns only its head", async () => {
    const marker = "LAST-PARAGRAPH-MARKER";
    const longBody = `<p>${"filler copy ".repeat(600)}</p><h2>Install</h2><ul><li>step one</li><li>step two</li></ul><p>${marker}</p>`;
    const { core } = drivingCore({
      html: `<html><head><title>Long Page</title></head><body>${longBody}</body></html>`,
    });
    __setBrowserCoreLoaderForTests(() => core);

    const out = await drive({
      url: "https://example.com/driving",
      outFile: ".reasonix/pages/long-page.md",
    });
    expect(out).toContain("saved:");
    expect(out).not.toContain(marker);

    const saved = readFileSync(join(rootDir, ".reasonix/pages/long-page.md"), "utf8");
    // The file carries what the tool result never could: the whole body.
    expect(saved).toContain(marker);
    expect(saved).toContain("url: https://example.com/driving");
    expect(saved).toContain("title: Driven Page");
    // Structure survives, so the file tools can outline and grep it.
    expect(saved).toContain("## Install");
    expect(saved).toContain("- step one");
    expect(saved.length).toBeGreaterThan(5_000);
  });

  it.skipIf(!declared)("auto-names the file when the caller passes a directory", async () => {
    const { core } = drivingCore();
    __setBrowserCoreLoaderForTests(() => core);
    const out = await drive({ url: "https://example.com/driving", outFile: "pages/" });
    const path = /^saved: (.+?) \(/m.exec(out)?.[1] ?? "";
    expect(path).toContain(join("pages", "page-"));
    expect(path).toContain("driven-page");
    expect(existsSync(path)).toBe(true);
  });

  it.skipIf(!declared)("refuses to write outside the workspace", async () => {
    const { core } = drivingCore();
    __setBrowserCoreLoaderForTests(() => core);
    const out = await drive({ url: "https://example.com/driving", outFile: "../../escape.md" });
    expect(out).toContain("inside the workspace");
    expect(existsSync(join(rootDir, "..", "..", "escape.md"))).toBe(false);
  });

  it.skipIf(!declared)("status reports the page without reading it or navigating", async () => {
    const { core, stubs } = drivingCore();
    __setBrowserCoreLoaderForTests(() => core);

    await drive({ url: "https://example.com/driving" });
    const before = stubs[0]!.calls.screenshots;
    const status = await drive({ action: "status" });
    // Inspecting is free: the url and position come back without a screenshot or a reload.
    expect(status).toContain("example.com/driving");
    expect(status).toContain("page:");
    expect(stubs[0]!.calls.gotos).toHaveLength(1);
    expect(stubs[0]!.calls.screenshots).toBe(before);
  });

  it.skipIf(!declared)("status reports a closed page instead of failing", async () => {
    const { core } = drivingCore();
    __setBrowserCoreLoaderForTests(() => core);
    expect(await drive({ action: "status" }, "status-empty")).toContain("page: closed");
  });

  it.skipIf(!declared)("close shuts the page so the next call opens a fresh one", async () => {
    const { core, stubs } = drivingCore();
    __setBrowserCoreLoaderForTests(() => core);

    await drive({ url: "https://example.com/driving" });
    expect(await drive({ action: "close" })).toContain("page: closed");
    await drive({ url: "https://example.com/driving" });
    expect(stubs).toHaveLength(2);
  });

  it.skipIf(!declared)("keeps the page open past any idle period", async () => {
    vi.useFakeTimers();
    try {
      const { core, stubs } = drivingCore();
      __setBrowserCoreLoaderForTests(() => core);
      await drive({ url: "https://example.com/driving" });
      expect(stubs).toHaveLength(1);

      // A long think must not cost the agent the page it was reading.
      await vi.advanceTimersByTimeAsync(30 * 60_000);
      const read = await drive({ action: "read" });
      expect(read).toContain("body copy");
      expect(stubs).toHaveLength(1);
    } finally {
      vi.useRealTimers();
    }
  });
});

/** The browser page is opt-in by declaration, so every other engine keeps its own
 *  transport: a search or a fetch there must never resolve, launch, or open a browser. */
describe("engines that declare no browser", () => {
  const engines = SEARCH_ENGINE_SPECS.filter((spec) => spec.browser === null).map(
    (spec) => spec.id,
  );

  function noBrowserCore(counter: { resolutions: number }) {
    __setBrowserCoreLoaderForTests(() => {
      counter.resolutions += 1;
      return { kind: "notInstalled" };
    });
  }

  function answeredFetch() {
    return vi.fn(
      async () =>
        new Response("<html><body>no results here</body></html>", {
          status: 200,
          headers: { "content-type": "text/html" },
        }),
    ) as unknown as typeof fetch;
  }

  function configFor(engine: string): string {
    const dir = mkdtempSync(join(tmpdir(), "reasonix-engine-matrix-"));
    const path = join(dir, "config.json");
    writeConfig({ webSearchEngine: engine }, path);
    return path;
  }

  it("covers the whole declared set", () => {
    // Derived from the registry: a new engine joins this check without editing it.
    expect(engines).toContain("bing");
    expect(engines.length).toBeGreaterThanOrEqual(10);
  });

  it.each(engines)("web_search on %s never touches a browser", async (engine) => {
    const counter = { resolutions: 0 };
    noBrowserCore(counter);
    const originalFetch = globalThis.fetch;
    globalThis.fetch = answeredFetch();
    try {
      const registry = new ToolRegistry();
      registerWebTools(registry, { configPath: configFor(engine) });
      const out = (await registry.dispatch(
        "web_search",
        JSON.stringify({ query: "deepseek balance" }),
        { sessionName: `matrix-search-${engine}` },
      )) as string;
      // Whether it answers or reports its own missing key, it never reaches for WebKit.
      expect(out).not.toContain("WebKit");
      expect(counter.resolutions).toBe(0);
    } finally {
      globalThis.fetch = originalFetch;
    }
  });

  it.each(engines)("web_fetch on %s never touches a browser", async (engine) => {
    const counter = { resolutions: 0 };
    noBrowserCore(counter);
    const originalFetch = globalThis.fetch;
    globalThis.fetch = answeredFetch();
    try {
      const registry = new ToolRegistry();
      registerWebTools(registry, { configPath: configFor(engine) });
      const out = (await registry.dispatch(
        "web_fetch",
        JSON.stringify({ url: "https://example.com/page" }),
        { sessionName: `matrix-fetch-${engine}`, rootDir: tmpdir() },
      )) as string;
      expect(out).not.toContain("WebKit");
      expect(out).not.toContain("render:");
      expect(counter.resolutions).toBe(0);
    } finally {
      globalThis.fetch = originalFetch;
    }
  });
});

describe("webFetch", () => {
  const mockedLookup = vi.mocked(lookup);
  beforeEach(() => {
    mockedLookup.mockResolvedValue([{ address: "93.184.216.34", family: 4 }]);
  });

  it("extracts title + body text from an html response", async () => {
    const originalFetch = globalThis.fetch;
    globalThis.fetch = vi.fn(
      async () =>
        new Response(
          "<html><head><title>Demo</title></head><body><p>Hello world.</p></body></html>",
          { status: 200, headers: { "Content-Type": "text/html; charset=utf-8" } },
        ),
    ) as unknown as typeof fetch;
    try {
      const page = await webFetch("https://example.com/demo");
      expect(page.title).toBe("Demo");
      expect(page.text).toContain("Hello world.");
      expect(page.text).not.toContain("<title>");
      expect(page.truncated).toBe(false);
    } finally {
      globalThis.fetch = originalFetch;
    }
  });

  it("truncates long pages and flags the result", async () => {
    const originalFetch = globalThis.fetch;
    const big = `<html><body><p>${"a".repeat(50_000)}</p></body></html>`;
    globalThis.fetch = vi.fn(
      async () => new Response(big, { status: 200, headers: { "Content-Type": "text/html" } }),
    ) as unknown as typeof fetch;
    try {
      const page = await webFetch("https://example.com/big", { maxChars: 1000 });
      expect(page.truncated).toBe(true);
      expect(page.text).toMatch(/\[… truncated \d+ chars …\]$/);
    } finally {
      globalThis.fetch = originalFetch;
    }
  });

  it("surfaces non-2xx as a thrown error", async () => {
    const originalFetch = globalThis.fetch;
    globalThis.fetch = vi.fn(
      async () => new Response("nope", { status: 404 }),
    ) as unknown as typeof fetch;
    try {
      await expect(webFetch("https://example.com/missing")).rejects.toThrow(/web_fetch 404/);
    } finally {
      globalThis.fetch = originalFetch;
    }
  });

  it("refuses literal internal addresses before fetching", async () => {
    const originalFetch = globalThis.fetch;
    globalThis.fetch = vi.fn() as unknown as typeof fetch;
    try {
      await expect(webFetch("http://127.0.0.1:9200/")).rejects.toThrow(
        /refuses internal or reserved host: 127\.0\.0\.1/,
      );
      expect(globalThis.fetch).not.toHaveBeenCalled();
    } finally {
      globalThis.fetch = originalFetch;
    }
  });

  it("refuses DNS names that resolve to internal addresses (even after DoH fallback)", async () => {
    mockedLookup.mockResolvedValueOnce([{ address: "10.0.0.5", family: 4 }]);
    const originalFetch = globalThis.fetch;
    // Stub fetch so the DoH fallback also fails — correct rejection must happen
    // without relying on a real Cloudflare round-trip.
    globalThis.fetch = vi.fn(async () => {
      throw new Error("network offline");
    }) as unknown as typeof fetch;
    try {
      await expect(webFetch("https://metadata.example/")).rejects.toThrow(
        /refuses internal or reserved host: metadata\.example/,
      );
      // The DoH fallback attempted a fetch; verify it went to the right endpoint.
      expect(globalThis.fetch).toHaveBeenCalledWith(
        expect.stringMatching(/^https:\/\/1\.1\.1\.1\/dns-query\?name=metadata\.example&type=A$/),
        expect.objectContaining({ headers: { Accept: "application/dns-json" } }),
      );
    } finally {
      globalThis.fetch = originalFetch;
    }
  });

  it("refuses redirects to internal hosts", async () => {
    const originalFetch = globalThis.fetch;
    globalThis.fetch = vi.fn(
      async () =>
        new Response("", { status: 302, headers: { Location: "http://169.254.169.254/" } }),
    ) as unknown as typeof fetch;
    try {
      await expect(webFetch("https://example.com/redirect")).rejects.toThrow(
        /refuses internal or reserved host: 169\.254\.169\.254/,
      );
      expect(globalThis.fetch).toHaveBeenCalledTimes(1);
    } finally {
      globalThis.fetch = originalFetch;
    }
  });

  it("refuses upfront when Content-Length declares a body past the byte cap", async () => {
    const originalFetch = globalThis.fetch;
    // 50MB declared — well past the 10MB cap. Body text doesn't even
    // need to match; the pre-flight check fires before we read it.
    globalThis.fetch = vi.fn(
      async () =>
        new Response("ignored", {
          status: 200,
          headers: { "Content-Type": "text/html", "Content-Length": String(50 * 1024 * 1024) },
        }),
    ) as unknown as typeof fetch;
    try {
      await expect(webFetch("https://example.com/big.iso")).rejects.toThrow(
        /content-length .* exceeds .* cap/,
      );
    } finally {
      globalThis.fetch = originalFetch;
    }
  });

  it("annotates 429 with a wait-and-retry hint", async () => {
    const originalFetch = globalThis.fetch;
    globalThis.fetch = vi.fn(
      async () => new Response("nope", { status: 429 }),
    ) as unknown as typeof fetch;
    try {
      await expect(webFetch("https://example.com/rate")).rejects.toThrow(
        /web_fetch 429.*try:.*wait/,
      );
    } finally {
      globalThis.fetch = originalFetch;
    }
  });

  it("annotates 403 with a hint that the host is blocking", async () => {
    const originalFetch = globalThis.fetch;
    globalThis.fetch = vi.fn(
      async () => new Response("nope", { status: 403 }),
    ) as unknown as typeof fetch;
    try {
      await expect(webFetch("https://example.com/forbidden")).rejects.toThrow(
        /web_fetch 403.*try:.*blocking|web_fetch 403.*try:/,
      );
    } finally {
      globalThis.fetch = originalFetch;
    }
  });

  it("annotates 5xx with a transient-retry hint", async () => {
    const originalFetch = globalThis.fetch;
    globalThis.fetch = vi.fn(
      async () => new Response("upstream broken", { status: 502 }),
    ) as unknown as typeof fetch;
    try {
      await expect(webFetch("https://example.com/gateway")).rejects.toThrow(
        /web_fetch 502.*try:.*retry in 30s/,
      );
    } finally {
      globalThis.fetch = originalFetch;
    }
  });

  it("throws a timeout-with-hint message when the internal timer fires", async () => {
    const originalFetch = globalThis.fetch;
    globalThis.fetch = vi.fn(async (_url: string | URL, init?: RequestInit) => {
      // Hang until the caller (or our timer) aborts, then surface that
      // as an AbortError exactly like real fetch does.
      return await new Promise<Response>((_, reject) => {
        const sig = init?.signal;
        if (sig?.aborted) {
          reject(new DOMException("aborted", "AbortError"));
          return;
        }
        sig?.addEventListener("abort", () => {
          reject(new DOMException("aborted", "AbortError"));
        });
      });
    }) as unknown as typeof fetch;
    try {
      await expect(webFetch("https://example.com/slow", { timeoutMs: 10 })).rejects.toThrow(
        /timed out after 10ms.*try:/,
      );
    } finally {
      globalThis.fetch = originalFetch;
    }
  });

  it("does not conflate caller-cancelled aborts with the timeout hint", async () => {
    const originalFetch = globalThis.fetch;
    globalThis.fetch = vi.fn(async (_url: string | URL, init?: RequestInit) => {
      return await new Promise<Response>((_, reject) => {
        init?.signal?.addEventListener("abort", () => {
          reject(new DOMException("aborted", "AbortError"));
        });
      });
    }) as unknown as typeof fetch;
    try {
      const ctl = new AbortController();
      const p = webFetch("https://example.com/cancelled", {
        timeoutMs: 60_000,
        signal: ctl.signal,
      });
      ctl.abort();
      await expect(p).rejects.toThrow();
      // The thrown error should NOT be the timeout hint.
      await expect(p).rejects.not.toThrow(/timed out after/);
    } finally {
      globalThis.fetch = originalFetch;
    }
  });

  it("aborts mid-stream when an undeclared body crosses the byte cap", async () => {
    // No Content-Length header → pre-flight passes; the streaming
    // reader has to enforce the cap. Stream pushes 1MB chunks past
    // the 10MB cap.
    const originalFetch = globalThis.fetch;
    const chunk = new Uint8Array(1024 * 1024).fill(65); // 1MB of 'A'
    const stream = new ReadableStream<Uint8Array>({
      pull(controller) {
        // 12 chunks → 12MB, past the 10MB cap.
        for (let i = 0; i < 12; i++) controller.enqueue(chunk);
        controller.close();
      },
    });
    globalThis.fetch = vi.fn(
      async () =>
        new Response(stream, {
          status: 200,
          headers: { "Content-Type": "text/html" },
        }),
    ) as unknown as typeof fetch;
    try {
      await expect(webFetch("https://example.com/chunked")).rejects.toThrow(
        /response body exceeded .* cap/,
      );
    } finally {
      globalThis.fetch = originalFetch;
    }
  });
});
