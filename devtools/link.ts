// Points the library imports of the built extension at the built library, because extension pages have no import map.
import { readdirSync, readFileSync, writeFileSync } from "node:fs";

const dir = new URL("build/devtools/src/", import.meta.url);
for (const name of readdirSync(dir).filter(name => name.endsWith(".js"))) {
  const file = new URL(name, dir);
  writeFileSync(
    file,
    readFileSync(file, "utf8")
      .replaceAll('"@xazzzi/gg/jsx-runtime"', '"../../src/jsx.js"')
      .replaceAll('"@xazzzi/gg"', '"../../src/index.js"'),
  );
}
