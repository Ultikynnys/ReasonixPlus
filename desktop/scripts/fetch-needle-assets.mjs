// Vendors the Cactus `needle` browser engine (used for Whistle speech-to-text)
// into desktop/public/needle/ so it ships as a static asset.
//
// Source: https://huggingface.co/Cactus-Compute/needle3/tree/main/wasm
// Run:    node desktop/scripts/fetch-needle-assets.mjs
import { mkdir, writeFile } from "node:fs/promises";
import { fileURLToPath } from "node:url";
import { dirname, join } from "node:path";

const HERE = dirname(fileURLToPath(import.meta.url));
const OUT_DIR = join(HERE, "..", "public", "needle");
const BASE = "https://huggingface.co/Cactus-Compute/needle3/resolve/main/wasm";

// Keep this list in sync with desktop/public/needle/README.md.
const FILES = ["needle.js", "needle.wasm", "needle.h"];

async function main() {
  await mkdir(OUT_DIR, { recursive: true });
  for (const name of FILES) {
    const url = `${BASE}/${name}`;
    process.stdout.write(`fetching ${url}\n`);
    const res = await fetch(url);
    if (!res.ok) {
      throw new Error(`Failed to fetch ${url}: ${res.status} ${res.statusText}`);
    }
    const bytes = Buffer.from(await res.arrayBuffer());
    await writeFile(join(OUT_DIR, name), bytes);
    process.stdout.write(`  wrote desktop/public/needle/${name} (${bytes.length} bytes)\n`);
  }
  process.stdout.write("done.\n");
}

main().catch((err) => {
  console.error(err);
  process.exitCode = 1;
});
