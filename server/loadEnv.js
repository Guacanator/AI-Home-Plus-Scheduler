"use strict";

const fs = require("fs");
const path = require("path");

let loaded = false;

function parseValue(raw) {
  const trimmed = raw.trim();
  if (!trimmed) {
    return "";
  }
  if ((trimmed.startsWith("\"") && trimmed.endsWith("\"")) || (trimmed.startsWith("'") && trimmed.endsWith("'"))) {
    return trimmed.slice(1, -1);
  }
  return trimmed;
}

function loadEnv() {
  if (loaded) {
    return;
  }
  loaded = true;

  const envPath = path.resolve(process.cwd(), ".env");
  if (!fs.existsSync(envPath)) {
    return;
  }

  const content = fs.readFileSync(envPath, "utf8");
  for (const line of content.split(/\r?\n/)) {
    if (!line || /^\s*#/.test(line)) {
      continue;
    }
    const match = line.match(/^\s*([A-Za-z0-9_.-]+)\s*=\s*(.*)\s*$/);
    if (!match) {
      continue;
    }
    const [, key, rawValue] = match;
    if (process.env[key] !== undefined) {
      continue;
    }
    const value = parseValue(rawValue);
    process.env[key] = value.replace(/\\n/g, "\n");
  }
}

module.exports = {
  loadEnv,
};
