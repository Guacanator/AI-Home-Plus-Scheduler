"use strict";

const fs = require("node:fs");
const path = require("node:path");
const { schedule } = require("../server/scheduler");
const { validate } = require("../server/validator");

function resolveSamplePath(sampleDir, fileName) {
  return path.join(sampleDir, fileName);
}

function readSample(sampleDir, fileName) {
  const filePath = resolveSamplePath(sampleDir, fileName);
  const raw = fs.readFileSync(filePath, "utf8");
  return JSON.parse(raw);
}

function readOptionalSample(sampleDir, fileName) {
  const filePath = resolveSamplePath(sampleDir, fileName);
  if (!fs.existsSync(filePath)) {
    return null;
  }
  const raw = fs.readFileSync(filePath, "utf8");
  return JSON.parse(raw);
}

function parseArgs(argv) {
  const args = { sampleDir: path.join(__dirname, "sample") };
  argv.forEach((arg) => {
    if (arg.startsWith("--sampleDir=")) {
      args.sampleDir = path.resolve(arg.split("=")[1]);
    } else if (!arg.startsWith("--") && !args.sampleDirOverride) {
      args.sampleDir = path.resolve(arg);
      args.sampleDirOverride = true;
    }
  });
  return args;
}

function printSection(title, payload) {
  console.log(`\n=== ${title} ===`);
  console.log(JSON.stringify(payload, null, 2));
}

function main() {
  const { sampleDir } = parseArgs(process.argv.slice(2));

  const employees = readSample(sampleDir, "employees.json");
  const availability = readSample(sampleDir, "availability.json");
  const shifts = readSample(sampleDir, "shifts.json");
  const existingAssignments = readOptionalSample(sampleDir, "existing_assignments.json") || [];

  const result = schedule(shifts, employees, availability, existingAssignments);

  printSection("Assignments", result.assignments);
  if (result.issues.length > 0) {
    printSection("Scheduling Issues", result.issues);
  } else {
    console.log("\nNo scheduling issues detected.");
  }
  printSection("Totals By Employee", result.totalsByEmployee);

  const validationErrors = validate(
    result.assignments,
    shifts,
    employees,
    availability
  );

  if (validationErrors.length > 0) {
    printSection("Validation Errors", validationErrors);
  } else {
    console.log("\nNo validation errors detected.");
  }
}

if (require.main === module) {
  try {
    main();
  } catch (error) {
    console.error("Failed to run local scheduler:", error);
    process.exitCode = 1;
  }
}

module.exports = { main };
