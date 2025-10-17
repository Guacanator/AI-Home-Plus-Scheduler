#!/usr/bin/env node
"use strict";

const { loadEnv } = require("../server/loadEnv");

loadEnv();

async function main() {
  const [, , argWeek, argStart, argEnd] = process.argv;
  const weekId = argWeek || process.env.WEEK_ID || "demo-week";
  const startDate = argStart || process.env.START_DATE || new Date().toISOString().slice(0, 10);
  const endDate =
    argEnd ||
    process.env.END_DATE ||
    new Date(Date.now() + 14 * 24 * 60 * 60 * 1000).toISOString().slice(0, 10);

  const body = {
    week_id: weekId,
    start_date: startDate,
    end_date: endDate,
  };

  const response = await fetch("http://localhost:3000/generate-schedule", {
    method: "POST",
    headers: {
      "Content-Type": "application/json",
    },
    body: JSON.stringify(body),
  });

  const data = await response.json();

  const assignments = Array.isArray(data.assignments) ? data.assignments.length : 0;
  const issues = Array.isArray(data.issues) ? data.issues.length : 0;
  const shifts = Array.isArray(data.assignments) ? data.assignments.length : 0;
  const zapierStatus = data.zapier ? `${data.zapier.status} (${data.zapier.ok ? "ok" : "fail"})` : "n/a";

  console.log(JSON.stringify({
    success: data.success,
    status: response.status,
    week_id: data.week_id,
    start_date: data.start_date,
    end_date: data.end_date,
    counts: {
      shifts,
      assignments,
      issues,
    },
    zapier: zapierStatus,
  }, null, 2));
}

main().catch((error) => {
  console.error("hitZapier failed", error);
  process.exit(1);
});
