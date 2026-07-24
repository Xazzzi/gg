import { readdirSync, writeFileSync } from "node:fs";

const files = (readdirSync("tests", { recursive: true }) as string[])
  .filter(f => f.endsWith(".test.ts") && f !== "index.test.ts")
  .map(f => `import "./${f.replace(/\\/g, "/")}";`)
  .join("\n");

// biome-ignore lint/style/useTemplate: who cares
writeFileSync("tests/index.test.ts", files + "\n");
