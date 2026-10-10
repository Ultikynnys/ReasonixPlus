import { cpSync, mkdirSync } from "node:fs";
import { fileURLToPath } from "node:url";

const root = new URL("../", import.meta.url);
for (const directory of ["cmaps", "standard_fonts", "wasm"]) {
  const destination = fileURLToPath(new URL(`public/pdfjs/${directory}/`, root));
  mkdirSync(destination, { recursive: true });
  cpSync(fileURLToPath(new URL(`node_modules/pdfjs-dist/${directory}/`, root)), destination, { recursive: true });
}
