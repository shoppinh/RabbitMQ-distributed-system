"use strict";

const pino = require("pino");
const api = require("@opentelemetry/api");

// Root pino logger — emits compact JSON to stdout
const root = pino({
  base: null, // omit pid/hostname at root level (child adds service)
  timestamp: pino.stdTimeFunctions.isoTime,
  formatters: {
    // keep level as uppercase string (e.g. "INFO") for Promtail label parsing
    level(label) {
      return { level: label.toUpperCase() };
    },
  },
});

/**
 * Read traceId / spanId from the active OpenTelemetry span (if any).
 * Returns an empty object when no span is active so logs are unaffected.
 */
function getTraceContext() {
  const span = api.trace.getSpan(api.context.active());
  if (!span) return {};
  const { traceId, spanId } = span.spanContext();
  // all-zero traceId means the span is invalid
  if (!traceId || traceId === "00000000000000000000000000000000") return {};
  return { traceId, spanId };
}

function createLogger(serviceName) {
  const child = root.child({ service: serviceName });

  function log(pinoLevel, message, meta) {
    const merged = { ...getTraceContext(), ...meta };
    child[pinoLevel](merged, message);
  }

  return {
    info: (message, meta) => log("info", message, meta),
    warn: (message, meta) => log("warn", message, meta),
    error: (message, meta) => log("error", message, meta),
    debug: (message, meta) => log("debug", message, meta),
  };
}

module.exports = { createLogger };
