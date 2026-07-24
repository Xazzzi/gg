import { execSync } from "node:child_process";

let lcovOutput = "";
try {
  lcovOutput = execSync(
    "node --expose-gc --test --test-timeout=250 --experimental-test-coverage --test-reporter=lcov tests/index.test.ts",
    { encoding: "utf-8" },
  );
} catch (error: any) {
  // Node's test runner exits with 1 if tests fail, but it still outputs the LCOV report to stdout.
  if (error.stdout) {
    lcovOutput = error.stdout.toString();
  } else {
    console.error("Failed to run tests:", error.message);
    process.exit(1);
  }
}

const lines = lcovOutput.split("\n");
let currentFile = "";
let currentUncovered: string[] = [];

for (const line of lines) {
  if (line.startsWith("SF:")) {
    if (currentUncovered.length > 0) {
      console.log(`${currentFile}:${currentUncovered.join(",")}`);
    }
    currentFile = line.slice(3).trim();
    currentUncovered = [];
  } else if (line.startsWith("BRDA:")) {
    // Format: BRDA:<line number>,<block number>,<branch number>,<taken>
    const parts = line.slice(5).split(",");
    const lineNum = parts[0];
    const taken = parts[3];

    if (taken === "0" || taken === "-") {
      // Keep a unique list of line numbers with uncovered branches
      if (!currentUncovered.includes(lineNum)) {
        currentUncovered.push(lineNum);
      }
    }
  }
}

// Flush the last file
if (currentUncovered.length > 0) {
  console.log(`${currentFile}:${currentUncovered.join(",")}`);
}
