/**
 * logger.js — Structured console logger
 * Logs: API call durations, cache hits/misses, scoring events, partial failures
 */

const LOG_LEVELS = { DEBUG: 0, INFO: 1, WARN: 2, ERROR: 3 };
const CURRENT_LEVEL = LOG_LEVELS[process.env.LOG_LEVEL?.toUpperCase()] ?? LOG_LEVELS.INFO;

function format(level, category, message, meta = {}) {
  const entry = {
    timestamp: new Date().toISOString(),
    level,
    category,
    message,
    ...meta,
  };
  const line = JSON.stringify(entry);
  if (level === "ERROR" || level === "WARN") {
    console.error(line);
  } else {
    console.log(line);
  }
}

const logger = {
  debug: (category, message, meta) =>
    CURRENT_LEVEL <= LOG_LEVELS.DEBUG && format("DEBUG", category, message, meta),

  info: (category, message, meta) =>
    CURRENT_LEVEL <= LOG_LEVELS.INFO && format("INFO", category, message, meta),

  warn: (category, message, meta) =>
    CURRENT_LEVEL <= LOG_LEVELS.WARN && format("WARN", category, message, meta),

  error: (category, message, meta) =>
    CURRENT_LEVEL <= LOG_LEVELS.ERROR && format("ERROR", category, message, meta),

  /** Log an external API call with its duration */
  apiCall: (api, country, durationMs, success) =>
    format(success ? "INFO" : "WARN", "API_CALL", `${api} → ${country}`, {
      api,
      country,
      duration_ms: durationMs,
      success,
    }),

  /** Log a cache event */
  cache: (country, hit) =>
    format("INFO", "CACHE", `${hit ? "HIT" : "MISS"} for ${country}`, {
      country,
      cache_hit: hit,
    }),

  /** Log a scoring computation */
  scoring: (country, scores) =>
    format("INFO", "SCORING", `Computed scores for ${country}`, {
      country,
      scores,
    }),

  /** Log a partial failure */
  partialFailure: (country, api, error) =>
    format("WARN", "PARTIAL_FAILURE", `${api} failed for ${country}: ${error}`, {
      country,
      api,
      error,
    }),
};

module.exports = logger;
