import { execSync, spawn } from "node:child_process";
import * as fs from "node:fs";
import * as path from "node:path";

function getAllTests(dir: string, fileList: string[] = []): string[] {
  const files = fs.readdirSync(dir);
  for (const file of files) {
    const filePath = path.join(dir, file);
    if (fs.statSync(filePath).isDirectory()) {
      getAllTests(filePath, fileList);
    } else if (
      filePath.endsWith(".test.ts") &&
      !filePath.includes("index.test.ts")
    ) {
      fileList.push(filePath);
    }
  }
  return fileList;
}

const tests = getAllTests(path.join(process.cwd(), "tests"));
console.log(`Starting redundancy check for ${tests.length} tests...`);
console.log(
  `WARNING: This will take approximately ${tests.length * 1.5} minutes.\n`,
);

const redundantTests: string[] = [];

for (let i = 0; i < tests.length; i++) {
  const testFile = tests[i];
  const skippedPath = `${testFile}.skip`;

  console.log(`[${i + 1}/${tests.length}] Testing redundancy of: ${testFile}`);

  // Temporarily exclude the test
  fs.renameSync(testFile, skippedPath);

  try {
    // Regenerate the test index so it excludes this file
    execSync("npm run pretest", { stdio: "ignore" });

    // FAST PATH: Check V8 coverage first!
    const coverageOutput = execSync("npm run test:human", {
      encoding: "utf-8",
    });
    if (
      !coverageOutput.includes(
        "all files           | 100.00 |   100.00 |  100.00 |",
      )
    ) {
      console.log(`  ❌ ESSENTIAL (Coverage Dropped). Skipping Stryker.`);
      fs.renameSync(skippedPath, testFile);
      continue;
    }

    console.log(
      `  ⚠️ Coverage is still 100%. Running Stryker to check mutants...`,
    );

    // Run Stryker using spawn so we can kill it early if a mutant survives
    const survived = await new Promise<number>(resolve => {
      const child = spawn("npx", ["stryker", "run"], {
        stdio: ["ignore", "pipe", "pipe"],
      });

      let foundSurvivor = false;
      let _outputBuf = "";

      child.stdout.on("data", (data: Buffer) => {
        const out = data.toString();
        _outputBuf += out;

        // Match things like "1 survived", "15 survived", "Survived: 1"
        // But NOT "0 survived", "Survived: 0", or table headers like "# survived"
        const match = out.match(
          /(?:([1-9]\d*)\s+survived|survived:\s*([1-9]\d*))/i,
        );

        if (!foundSurvivor && match) {
          foundSurvivor = true;
          child.kill("SIGKILL");
          resolve(1);
        }
      });

      child.on("close", () => {
        if (!foundSurvivor) {
          // If we completed without finding a survivor in stdout, check the JSON report
          try {
            const reportPath = path.join(
              process.cwd(),
              "reports",
              "mutation",
              "mutation.json",
            );
            const report = JSON.parse(fs.readFileSync(reportPath, "utf-8"));
            let survivedCount = 0;
            for (const file of Object.values<any>(report.files)) {
              for (const mutant of file.mutants) {
                if (
                  mutant.status === "Survived" ||
                  mutant.status === "NoCoverage"
                ) {
                  survivedCount++;
                }
              }
            }
            resolve(survivedCount);
          } catch {
            resolve(0); // If report failed but no survivor detected, assume 0
          }
        }
      });
    });

    if (survived === 0) {
      console.log(`  ✅ REDUNDANT! Removing test forever: ${testFile}`);
      redundantTests.push(testFile);
      // Delete the skipped file permanently
      fs.unlinkSync(skippedPath);
    } else {
      console.log(`  ❌ ESSENTIAL. Stryker bailed early on a survivor.`);
      // Restore the test
      fs.renameSync(skippedPath, testFile);
    }
  } catch (error: any) {
    console.log(`  ⚠️ ERROR running Stryker for ${testFile}. Restoring file...`);
    if (error.stdout) console.log("STDOUT:", error.stdout.toString());
    if (error.stderr) console.log("STDERR:", error.stderr.toString());
    console.log(error.message);
    fs.renameSync(skippedPath, testFile);
  }
}

// Final cleanup
execSync("npm run pretest", { stdio: "ignore" });
console.log("\n--- REDUNDANCY CHECK COMPLETE ---");
console.log(`Removed ${redundantTests.length} redundant tests:`);
redundantTests.forEach(t => {
  console.log(`- ${t}`);
});
