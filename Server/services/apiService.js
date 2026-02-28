/**
 * apiService.js
 *
 * All external API integrations:
 *  1. REST Countries v3     — profile data (free, no key)
 *  2. World Bank API        — life expectancy + healthcare expenditure (free, no key)
 *  3. OpenWeatherMap        — current weather (free key required)
 *  4. WAQI                  — Air Quality Index (free key required)
 *  5. travel-advisory.info  — travel advisory score (free, no key)
 *
 * Each fetcher is independent. Failures are caught and returned as null
 * so the rest of the pipeline continues (partial failure resilience).
 */
process.env.NODE_TLS_REJECT_UNAUTHORIZED = '0';
const axios = require("axios");
const logger = require("../utils/logger");

const WEATHER_API_KEY = process.env.WEATHER_API_KEY || "YOUR_OPENWEATHERMAP_KEY";
const AQI_API_KEY     = process.env.AQI_API_KEY     || "YOUR_WAQI_TOKEN";

// Shared axios instance with a reasonable timeout
const http = axios.create({ timeout: 8000 });

/**
 * Utility: timed API call with logging
 */
async function timedCall(apiName, country, fn) {
  const start = Date.now();
  try {
    const result = await fn();
    logger.apiCall(apiName, country, Date.now() - start, true);
    return result;
  } catch (err) {
    logger.apiCall(apiName, country, Date.now() - start, false);
    logger.partialFailure(country, apiName, err.message);
    return null;
  }
}

// ─────────────────────────────────────────────────────────────────────────────
// 1. REST Countries v3
// ─────────────────────────────────────────────────────────────────────────────
async function fetchCountryProfile(countryName) {
  return timedCall("REST_COUNTRIES", countryName, async () => {
    const res = await http.get(
      `https://restcountries.com/v3.1/name/${encodeURIComponent(countryName)}?fullText=true`
    );
    const c = res.data[0];
    if (!c) throw new Error("No country data returned");

    return {
      iso2:       c.cca2,
      iso3:       c.cca3,
      name:       c.name?.common || countryName,
      capital:    c.capital?.[0] || null,
      population: c.population || null,
      region:     c.region || null,
      subregion:  c.subregion || null,
      currencies: Object.values(c.currencies || {})
                    .map((cur) => `${cur.name} (${cur.symbol || "?"})`)
                    .join(", ") || null,
      flag:       c.flags?.png || null,
      languages:  Object.values(c.languages || {}).join(", ") || null,
    };
  });
}

// ─────────────────────────────────────────────────────────────────────────────
// 2. World Bank — Life Expectancy & Healthcare Expenditure
// ─────────────────────────────────────────────────────────────────────────────
async function fetchWorldBankIndicator(iso2, indicator) {
  const url = `https://api.worldbank.org/v2/country/${iso2}/indicator/${indicator}?format=json&mrv=3&per_page=3`;
  const res = await http.get(url);
  const records = res.data?.[1];
  if (!records || records.length === 0) return null;
  // Return the most recent non-null value
  for (const record of records) {
    if (record.value !== null) return record.value;
  }
  return null;
}

async function fetchWorldBankData(iso2, countryName) {
  if (!iso2) return { lifeExpectancy: null, healthcareExpenditure: null };
  return timedCall("WORLD_BANK", countryName, async () => {
    const [lifeExpectancy, healthcareExpenditure] = await Promise.all([
      fetchWorldBankIndicator(iso2, "SP.DYN.LE00.IN"),  // Life expectancy at birth
      fetchWorldBankIndicator(iso2, "SH.XPD.CHEX.GD.ZS"), // Current health expenditure % of GDP
    ]);
    return { lifeExpectancy, healthcareExpenditure };
  });
}

// ─────────────────────────────────────────────────────────────────────────────
// 3. OpenWeatherMap — Current Weather
// ─────────────────────────────────────────────────────────────────────────────
async function fetchWeather(capital, countryName) {
  if (!capital) return null;
  return timedCall("OPENWEATHERMAP", countryName, async () => {
    const res = await http.get(
      `https://api.openweathermap.org/data/2.5/weather?q=${encodeURIComponent(capital)}&appid=${WEATHER_API_KEY}&units=metric`
    );
    const d = res.data;
    return {
      temp_celsius:     d.main.temp,
      feels_like:       d.main.feels_like,
      temp_min:         d.main.temp_min,
      temp_max:         d.main.temp_max,
      humidity_pct:     d.main.humidity,
      description:      d.weather[0].description,
      wind_speed_ms:    d.wind.speed,
      visibility_m:     d.visibility || null,
      weather_id:       d.weather[0].id,    // used for severity classification
    };
  });
}

// ─────────────────────────────────────────────────────────────────────────────
// 4. WAQI — Air Quality Index
// ─────────────────────────────────────────────────────────────────────────────
async function fetchAQI(capital, countryName) {
  if (!capital) return null;
  return timedCall("WAQI_AQI", countryName, async () => {
    const res = await http.get(
      `https://api.waqi.info/feed/${encodeURIComponent(capital)}/?token=${AQI_API_KEY}`
    );
    if (res.data.status !== "ok") throw new Error(`WAQI status: ${res.data.status}`);
    const d = res.data.data;
    return {
      aqi:                d.aqi,
      dominant_pollutant: d.dominentpol || null,
      station_name:       d.city?.name || capital,
    };
  });
}

// ─────────────────────────────────────────────────────────────────────────────
// 5. Travel Advisory — travel-advisory.info
// ─────────────────────────────────────────────────────────────────────────────
async function fetchTravelAdvisory(iso2, countryName) {
  if (!iso2) return null;
  return timedCall("TRAVEL_ADVISORY", countryName, async () => {
    const res = await http.get(`https://www.travel-advisory.info/api?countrycode=${iso2}`);
    const entry = res.data?.data?.[iso2];
    if (!entry) throw new Error("No advisory data");
    return {
      score:          entry.advisory?.score ?? null,   // 1.0 (safe) – 5.0 (do not travel)
      message:        entry.advisory?.message || "No message available",
      sources_active: entry.advisory?.sources_active ?? 0,
    };
  });
}

// ─────────────────────────────────────────────────────────────────────────────
// Master: fetch all data for one country concurrently
// ─────────────────────────────────────────────────────────────────────────────
async function fetchAllDataForCountry(countryName) {
  // Step 1: Get profile (needed for capital & ISO2)
  const profile = await fetchCountryProfile(countryName);

  if (!profile) {
    return {
      found:   false,
      country: countryName,
      error:   `Country "${countryName}" not found or REST Countries API unavailable.`,
    };
  }

  const { iso2, capital } = profile;

  // Step 2: Fetch remaining APIs concurrently
  const [worldBank, weather, aqi, advisory] = await Promise.all([
    fetchWorldBankData(iso2, countryName),
    fetchWeather(capital, countryName),
    fetchAQI(capital, countryName),
    fetchTravelAdvisory(iso2, countryName),
  ]);

  return {
    found:    true,
    country:  countryName,
    profile,
    worldBank:  worldBank  || { lifeExpectancy: null, healthcareExpenditure: null },
    weather:    weather    || null,
    aqi:        aqi        || null,
    advisory:   advisory   || null,
    data_availability: {
      profile:   !!profile,
      worldBank: !!worldBank,
      weather:   !!weather,
      aqi:       !!aqi,
      advisory:  !!advisory,
    },
  };
}

module.exports = { fetchAllDataForCountry };
