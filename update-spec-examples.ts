import { spawnSync } from "node:child_process";
import { mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join, resolve } from "node:path";
import { pathToFileURL } from "node:url";

// Runs each spec block that has a `// =>` comment, and writes the real result into that comment.
// A marked line is one statement. A trailing rule reference, such as (CH-012), stays.
const SPECS = ["channel", "feed", "helpers", "select"];
const MARK =
  /^(\s*)(.*?);?\s*\/\/ =>.*?((?: \((?:(?:CH|FE|HE|SE)-\w+(?:, )?)+\))?)$/;
const library = pathToFileURL(resolve("src/index.ts")).href;

const HARNESS = `
import { inspect } from "node:util";
import { abortable, applyOps, Channel, catching, changes, feed, isVal, select, spread, StopError } from "${library}";
const show = v => inspect(v, { breakLength: Infinity, depth: null });
const results = {}, logs = [];
console.log = (...args) => logs.push(args.map(a => (typeof a === "string" ? a : show(a))).join(" "));
const record = (line, text) => { results[line] = logs.length ? logs.splice(0).join(", ") : text; };
const threw = e => "throws " + (e instanceof Error ? e.name + ": " + e.message : show(e));
process.on("exit", () => process.stdout.write(JSON.stringify(results)));
`;

const instrument = (lines: string[]) =>
  lines.map((line, index) => {
    const match = line.match(MARK);
    if (!match) return line;
    const code = match[2];
    const run = /^for\b/.test(code)
      ? `${code}; record(${index}, "");`
      : `record(${index}, show(await (${code})));`;
    return `try { ${run} } catch (e) { record(${index}, threw(e)); }`;
  });

const evaluate = (lines: string[], label: string) => {
  const dir = mkdtempSync(join(tmpdir(), "gg-examples-"));
  const file = join(dir, "example.ts");
  writeFileSync(file, HARNESS + instrument(lines).join("\n"));
  const { status, stdout, stderr } = spawnSync(process.execPath, [file], {
    encoding: "utf8",
    timeout: 5000,
  });
  rmSync(dir, { recursive: true });
  if (status !== 0) throw new Error(`${label} failed (${status})\n${stderr}`);
  return JSON.parse(stdout) as Record<string, string>;
};

const update = (text: string, name: string) =>
  text.replace(/^```ts\n([\s\S]*?)^```$/gm, (block, body: string) => {
    if (!body.includes("// =>")) return block;
    const lines = body.split("\n");
    const results = evaluate(lines, `${name}: ${lines[0]}`);
    const written = lines.map((line, index) => {
      const match = line.match(MARK);
      if (!match) return line;
      if (!(index in results))
        throw new Error(`${name}: no result for ${line}`);
      const [, indent, code, reference] = match;
      return `${indent}${code}; // => ${results[index]}${reference}`;
    });
    return `\`\`\`ts\n${written.join("\n")}\`\`\``;
  });

const stale: string[] = [];
for (const name of SPECS) {
  const path = `spec/${name}.md`;
  const before = readFileSync(path, "utf8");
  const after = update(before, name);
  if (after === before) continue;
  stale.push(path);
  if (!process.argv.includes("--check")) writeFileSync(path, after);
}
if (stale.length) console.log(`Stale examples: ${stale.join(", ")}`);
if (stale.length && process.argv.includes("--check")) process.exit(1);
