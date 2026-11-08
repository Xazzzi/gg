// Reruns Stryker on the lines of the surviving mutants of the last report, and on the src lines changed since HEAD.
// A survivor line that an edit changed is found again by its text, or else left to the changed lines.
import { execSync, spawnSync } from "node:child_process";
import { readFileSync } from "node:fs";

const report = JSON.parse(
  readFileSync("reports/mutation/mutation.json", "utf8"),
);
const ranges = new Set<string>();

for (const [file, info] of Object.entries<any>(report.files)) {
  const before = info.source.split("\n"),
    now = readFileSync(file, "utf8").split("\n");
  for (const mutant of info.mutants) {
    if (mutant.status !== "Survived" && mutant.status !== "NoCoverage")
      continue;
    const { start, end } = mutant.location,
      size = end.line - start.line + 1,
      text = before.slice(start.line - 1, end.line).join("\n");
    let found = -1;
    for (let i = 0; i + size <= now.length; i++)
      if (
        now.slice(i, i + size).join("\n") === text &&
        (found < 0 || Math.abs(i - start.line) < Math.abs(found - start.line))
      )
        found = i;
    if (found < 0)
      console.log(`Changed since the report: ${file}:${start.line}`);
    else ranges.add(`${file}:${found + 1}-${found + size}`);
  }
}

// Each hunk of a zero-context diff names the new lines as +start,count.
const diff = execSync("git diff -U0 HEAD -- src", { encoding: "utf8" });
let file = "";
for (const line of diff.split("\n")) {
  if (line.startsWith("+++ ")) file = line.slice(6);
  const hunk = /^@@ .* \+(\d+)(?:,(\d+))? @@/.exec(line);
  const count = Number(hunk?.[2] ?? 1);
  if (hunk && count)
    ranges.add(`${file}:${hunk[1]}-${Number(hunk[1]) + count - 1}`);
}

if (!ranges.size) {
  console.log("No surviving mutant and no changed src line to rerun");
  process.exit(0);
}
const mutate = [...ranges].join(",");
console.log(`Mutating ${mutate}`);
if (process.argv.includes("--dry")) process.exit(0);
const run = spawnSync("npx", ["stryker", "run", "--mutate", mutate], {
  stdio: "inherit",
});
process.exit(run.status ?? 1);
