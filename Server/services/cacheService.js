/**
 * cacheService.js
 *
 * In-memory cache with:
 *  - 60-minute TTL per entry
 *  - In-flight deduplication (simultaneous identical requests share one external call)
 *  - Error responses are never cached
 *  - Exposes cache hit/miss metadata
 */

const logger = require("../utils/logger");

const TTL_MS = 60 * 60 * 1000; // 60 minutes

// Main cache store: key → { data, expiresAt }
const store = new Map();

// In-flight promises: key → Promise
// Prevents duplicate concurrent external calls for the same country
const inFlight = new Map();

/**
 * Retrieve a cached entry.
 * Returns { data, hit: true } or { data: null, hit: false }
 */
function get(key) {
  const entry = store.get(key);
  if (!entry) {
    logger.cache(key, false);
    return { data: null, hit: false };
  }
  if (Date.now() > entry.expiresAt) {
    store.delete(key);
    logger.cache(key, false);
    return { data: null, hit: false };
  }
  logger.cache(key, true);
  return { data: entry.data, hit: true };
}

/**
 * Store a value. Never called with error objects.
 */
function set(key, data) {
  store.set(key, { data, expiresAt: Date.now() + TTL_MS });
}

/**
 * Fetch-or-cache pattern with in-flight deduplication.
 * fetchFn must return a Promise. If it rejects, result is NOT cached.
 *
 * Returns: { result, cacheHit }
 */
async function getOrFetch(key, fetchFn) {
  // Check cache first
  const cached = get(key);
  if (cached.hit) {
    return { result: cached.data, cacheHit: true };
  }

  // If an identical request is already in flight, await it
  if (inFlight.has(key)) {
    logger.debug("CACHE", `Reusing in-flight request for ${key}`);
    const result = await inFlight.get(key);
    return { result, cacheHit: false };
  }

  // Create a new fetch promise and register it
  const fetchPromise = fetchFn().then((data) => {
    set(key, data);        // only cache on success
    inFlight.delete(key);
    return data;
  }).catch((err) => {
    inFlight.delete(key);  // do not cache errors
    throw err;
  });

  inFlight.set(key, fetchPromise);

  const result = await fetchPromise;
  return { result, cacheHit: false };
}

/** Return cache stats (useful for debugging) */
function stats() {
  return {
    cached_entries: store.size,
    in_flight: inFlight.size,
  };
}

module.exports = { get, set, getOrFetch, stats };
