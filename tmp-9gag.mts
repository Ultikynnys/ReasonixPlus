import { mkdtempSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { closeBrowserSearches, renderManagedPage } from "./src/tools/browser-search.js";
import { htmlToText, webFetch } from "./src/tools/web.js";

const rootDir = mkdtempSync(join(tmpdir(), "rx-9gag-"));
const url = "https://9gag.com/tag/rick-roll";

try {
  const plain = await webFetch(url);
  console.log("plain ok", plain.text.length);
} catch (err) {
  console.log("plain:", (err as Error).message.slice(0, 140));
}

const rendered = await renderManagedPage("webkit", (k: string) => k, url, {});
const text = htmlToText(rendered.html);
console.log("rendered html chars", rendered.html.length, "text chars", text.length);
console.log("title:", rendered.title);
console.log("text head:", JSON.stringify(text.slice(0, 500)));
console.log("has png", Boolean(rendered.preview), rootDir.length > 0);
await closeBrowserSearches();
