// Vendors the CC0 audio for the default sound pack into
// desktop/public/sound-packs/default/ so it ships as static assets instead of
// being synthesized in code with WebAudio oscillators (which sounded thin and
// harsh).
//
// Source:  https://cc0-sounds.exi.software/collection/kenney_interfacesounds/
// Pack:    Kenney "Interface Sounds" - https://kenney.nl/assets/interface-sounds
// License: CC0 1.0 Universal (public domain), credit not required.
//          See desktop/public/sound-packs/README.md.
// Run:     node desktop/scripts/fetch-feedback-sounds.mjs
import { mkdir, readFile, writeFile } from "node:fs/promises";
import { fileURLToPath } from "node:url";
import { dirname, join } from "node:path";

const HERE = dirname(fileURLToPath(import.meta.url));
const OUT_DIR = join(HERE, "..", "public", "sound-packs", "default");
const MANIFEST = join(OUT_DIR, "pack.json");
const BASE = "https://cc0-sounds.exi.software/sounds/kenney_interfacesounds/Audio";

async function main() {
  // The pack manifest decides which files this pack holds, so re-fetching can never leave
  // the folder disagreeing with it.
  const manifest = JSON.parse(await readFile(MANIFEST, "utf8"));
  const files = [...new Set(Object.values(manifest.sounds ?? {}))];
  await mkdir(OUT_DIR, { recursive: true });
  for (const name of files) {
    const url = `${BASE}/${name}`;
    process.stdout.write(`fetching ${url}\n`);
    const res = await fetch(url);
    if (!res.ok) {
      throw new Error(`Failed to fetch ${url}: ${res.status} ${res.statusText}`);
    }
    const bytes = Buffer.from(await res.arrayBuffer());
    await writeFile(join(OUT_DIR, name), bytes);
    process.stdout.write(
      `  wrote desktop/public/sound-packs/default/${name} (${bytes.length} bytes)\n`,
    );
  }
  process.stdout.write("done.\n");
}

main().catch((err) => {
  console.error(err);
  process.exitCode = 1;
});
