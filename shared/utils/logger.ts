// shared/utils/logger.ts
import pino from "pino";
import * as api from "@opentelemetry/api";

export interface Logger {
  info(message: string, meta?: Record<string, unknown>): void;
  warn(message: string, meta?: Record<string, unknown>): void;
  error(message: string, meta?: Record<string, unknown>): void;
  debug(message: string, meta?: Record<string, unknown>): void;
}

// Root pino logger — emits compact JSON to stdout
const root = pino({
  base: null, // omit pid/hostname at root level
  timestamp: pino.stdTimeFunctions.isoTime,
  formatters: {
    // keep level as uppercase string for Promtail label parsing
    level(label: string) {
      return { level: label.toUpperCase() };
    },
  },
});

/**
 * Read traceId / spanId from the active OpenTelemetry span (if any).
 */
function getTraceContext(): Record<string, string> {
  const span = api.trace.getSpan(api.context.active());
  if (!span) return {};
  const { traceId, spanId } = span.spanContext();
  if (!traceId || traceId === "00000000000000000000000000000000") return {};
  return { traceId, spanId };
}

export function createLogger(serviceName: string): Logger {
  const child = root.child({ service: serviceName });

  function log(
    pinoLevel: "info" | "warn" | "error" | "debug",
    message: string,
    meta?: Record<string, unknown>
  ) {
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
