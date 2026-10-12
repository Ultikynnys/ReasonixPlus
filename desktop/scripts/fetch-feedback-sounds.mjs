// Vendors the CC0 feedback cue sounds into desktop/public/sounds/ so they ship
// as static assets instead of being synthesized in code with WebAudio
// oscillators (which sounded thin and harsh).
//
// Source:  https://cc0-sounds.exi.software/collection/kenney_interfacesounds/
// Pack:    Kenney "Interface Sounds" — https://kenney.nl/assets/interface-sounds
// License: CC0 1.0 Universal (public domain), credit not required.
//          See desktop/public/sounds/README.md.
// Run:     node desktop/scripts/fetch-feedback-sounds.mjs
import { mkdir, writeFile } from "node:fs/promises";
import { fileURLToPath } from "node:url";
import { dirname, join } from "node:path";

const HERE = dirname(fileURLToPath(import.meta.url));
const OUT_DIR = join(HERE, "..", "public", "sounds");
const BASE = "https://cc0-sounds.exi.software/sounds/kenney_interfacesounds/Audio";

// Keep this list in sync with SOURCES in desktop/src/feedback-sounds.ts and
// with desktop/public/sounds/README.md.
const FILES = [
  "confirmation_001.ogg",
  "confirmation_002.ogg",
  "error_001.ogg",
  "question_001.ogg",
];

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
    process.stdout.write(`  wrote desktop/public/sounds/${name} (${bytes.length} bytes)\n`);
  }
  process.stdout.write("done.\n");
}

main().catch((err) => {
  console.error(err);
  process.exitCode = 1;
});
