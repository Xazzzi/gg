import { readFileSync, writeFileSync } from "node:fs";

try {
  const report = JSON.parse(
    readFileSync("reports/mutation/mutation.json", "utf8"),
  );
  let md = "";

  for (const [file, info] of Object.entries<any>(report.files)) {
    const sourceLines = info.source.split("\n");

    for (const mutant of info.mutants) {
      if (mutant.status === "Survived" || mutant.status === "NoCoverage") {
        const line = mutant.location.start.line;
        const col = mutant.location.start.column;
        md += `${mutant.mutatorName} ${file}:${line}:${col}\n`;

        const original = sourceLines
          .slice(line - 1, mutant.location.end.line)
          .join("\n");
        const replaced = mutant.replacement;

        md += `- ${original.trim()}\n`;
        md += `+ ${replaced.trim()}\n\n`;
      }
    }
  }

  if (md.trim()) {
    writeFileSync("surviving-mutants.md", `${md.trim()}\n`);
    console.log("Surviving mutants written to surviving-mutants.md");
  } else {
    writeFileSync("surviving-mutants.md", "All mutants killed!\n");
    console.log("All mutants killed! surviving-mutants.md updated.");
  }
} catch (e: any) {
  console.error("Failed to parse Stryker JSON report:", e.message);
}
