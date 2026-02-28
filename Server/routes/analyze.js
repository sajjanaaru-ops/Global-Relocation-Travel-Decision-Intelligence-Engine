/**
 * routes/analyze.js
 *
 * Handles POST /api/analyze
 *
 * Responsibilities:
 *  - Input validation
 *  - Concurrent per-country data fetching (with cache check first)
 *  - Scoring orchestration
 *  - Ranked JSON response construction
 */

const express  = require("express");
const router   = express.Router();
const cache    = require("../services/cacheService");
const api      = require("../services/apiService");
const scoring  = require("../services/scoringService");
const logger   = require("../utils/logger");

const VALID_RISK      = ["low", "moderate", "high"];
const VALID_DURATION  = ["short", "long"];
const MAX_COUNTRIES   = 10;
const MIN_COUNTRIES   = 3;

// ─── Input Validator ──────────────────────────────────────────────────────────
function validateInput(body) {
  const errors = [];
  const { countries, riskTolerance, duration } = body;

  if (!Array.isArray(countries) || countries.length < MIN_COUNTRIES) {
    errors.push(`"countries" must be an array of at least ${MIN_COUNTRIES} country names.`);
  } else if (countries.length > MAX_COUNTRIES) {
    errors.push(`Maximum ${MAX_COUNTRIES} countries per request.`);
  } else if (countries.some((c) => typeof c !== "string" || !c.trim())) {
    errors.push(`All entries in "countries" must be non-empty strings.`);
  }

  if (!VALID_RISK.includes(riskTolerance?.toLowerCase?.())) {
    errors.push(`"riskTolerance" must be one of: ${VALID_RISK.join(", ")}.`);
  }

  if (!VALID_DURATION.includes(duration?.toLowerCase?.())) {
    errors.push(`"duration" must be one of: ${VALID_DURATION.join(", ")}.`);
  }

  return errors;
}

// ─── Route Handler ────────────────────────────────────────────────────────────
router.post("/", async (req, res) => {
  const requestStart = Date.now();

  const { countries, riskTolerance, duration } = req.body;

  // 1. Validate input
  const validationErrors = validateInput(req.body);
  if (validationErrors.length > 0) {
    return res.status(400).json({
      success: false,
      errors: validationErrors,
    });
  }

  const rt = riskTolerance.toLowerCase();
  const dur = duration.toLowerCase();

  // 2. Deduplicate country list (case-insensitive)
  const uniqueCountries = [...new Set(countries.map((c) => c.trim()))];

  logger.info("ROUTE", `Analyzing ${uniqueCountries.length} countries`, {
    countries: uniqueCountries,
    riskTolerance: rt,
    duration: dur,
  });

  // 3. For each country: check cache, fetch if missing — ALL CONCURRENT
  const cacheHitMap  = {};
  const cacheMissMap = {};

  const dataPromises = uniqueCountries.map(async (countryName) => {
    const cacheKey = `country:${countryName.toLowerCase()}`;

    try {
      const { result, cacheHit } = await cache.getOrFetch(cacheKey, () =>
        api.fetchAllDataForCountry(countryName)
      );

      cacheHitMap[countryName]  = cacheHit;
      if (!cacheHit) cacheMissMap[countryName] = true;
      return result;
    } catch (err) {
      logger.error("ROUTE", `Failed to fetch data for ${countryName}`, { error: err.message });
      cacheHitMap[countryName] = false;
      return {
        found:   false,
        country: countryName,
        error:   `Failed to retrieve data: ${err.message}`,
      };
    }
  });

  // Await all country fetches concurrently
  const allData = await Promise.all(dataPromises);

  // 4. Separate valid vs invalid countries
  const validData  = allData.filter((d) => d.found);
  const errorData  = allData.filter((d) => !d.found);

  // Check if we still have at least 1 valid country to score
  if (validData.length === 0) {
    return res.status(404).json({
      success: false,
      message: "None of the provided countries could be found or processed.",
      errors: errorData.map((d) => ({ country: d.country, reason: d.error })),
    });
  }

  // 5. Score all valid countries
  const scoredCountries = validData.map((countryData) => {
    const scores = scoring.scoreCountry(countryData, rt, dur);
    return {
      country: countryData.country,
      profile: {
        official_name: countryData.profile.name,
        capital:       countryData.profile.capital,
        population:    countryData.profile.population,
        currencies:    countryData.profile.currencies,
        region:        countryData.profile.region,
        subregion:     countryData.profile.subregion,
        languages:     countryData.profile.languages,
        flag_url:      countryData.profile.flag,
      },
      raw_data: {
        life_expectancy_years:          countryData.worldBank.lifeExpectancy,
        healthcare_expenditure_gdp_pct: countryData.worldBank.healthcareExpenditure,
        weather:                        countryData.weather,
        aqi:                            countryData.aqi,
        travel_advisory:                countryData.advisory,
      },
      data_availability:  countryData.data_availability,
      cache_hit:          cacheHitMap[countryData.country] ?? false,
      scores,
    };
  });

  // 6. Rank
  const rankedResults = scoring.rankResults(scoredCountries);

  // 7. Build response
  const responseTimeMs = Date.now() - requestStart;

  logger.info("ROUTE", `Analysis complete in ${responseTimeMs}ms`, {
    countries_analyzed: validData.length,
    countries_failed: errorData.length,
    cache_hits: Object.values(cacheHitMap).filter(Boolean).length,
    cache_misses: Object.keys(cacheMissMap).length,
    response_time_ms: responseTimeMs,
  });

  return res.json({
    success: true,
    meta: {
      query: {
        countries:     uniqueCountries,
        riskTolerance: rt,
        duration:      dur,
      },
      performance: {
        response_time_ms:    responseTimeMs,
        countries_analyzed:  validData.length,
        countries_failed:    errorData.length,
      },
      cache: {
        hits:   Object.entries(cacheHitMap).filter(([, v]) => v).map(([k]) => k),
        misses: Object.entries(cacheHitMap).filter(([, v]) => !v).map(([k]) => k),
        ttl_minutes: 60,
      },
      generated_at: new Date().toISOString(),
    },
    weight_profile: scoring.getDynamicWeights(rt, dur),
    ranked_results: rankedResults,
    failed_countries: errorData.map((d) => ({
      country: d.country,
      reason:  d.error,
    })),
  });
});

module.exports = router;
