"use strict";

let pino;
try {
  pino = require("pino");
} catch (error) {
  pino = null;
}

const level = process.env.LOG_LEVEL || "info";

if (pino) {
  module.exports = pino({ level });
} else {
  const createFallbackLogger = () => ({
    level,
    fatal: console.error.bind(console, "[fatal]"),
    error: console.error.bind(console, "[error]"),
    warn: console.warn.bind(console, "[warn]"),
    info: console.log.bind(console, "[info]"),
    debug: console.debug ? console.debug.bind(console, "[debug]") : console.log.bind(console, "[debug]"),
    trace: console.trace.bind(console, "[trace]"),
    child() {
      return createFallbackLogger();
    },
  });

  module.exports = createFallbackLogger();
}
