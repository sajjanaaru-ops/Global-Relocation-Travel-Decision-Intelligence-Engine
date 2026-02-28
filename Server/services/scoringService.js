/**
 * scoringService.js
 *
 * Implements all intelligence computation:
 *
 *  1. Normalization   — min-max scaling to 0–100
 *  2. Travel Risk Score (0–100)
 *  3. Health Infrastructure Score (0–100)
 *  4. Environmental Stability Score (0–100)
 *  5. Dynamic weight adjustment (riskTolerance × duration)
 *  6. Final composite score + ranking
 *  7. Explainable reasoning per country
 */

const logger = require("../utils/logger");

// ─────────────────────────────────────────────────────────────────────────────
// NORMALIZATION
// ─────────────────────────────────────────────────────────────────────────────

/**
 * Normalize a raw value to 0–100.
 * @param {number|null} value
 * @param {number} min  — expected minimum of the raw metric
 * @param {number} max  — expected maximum of the raw metric
 * @param {boolean} higherIsBetter — if false, the scale is inverted
 * @param {number} defaultScore   — neutral fallback when data is missing (0–100)
 */
function normalize(value, min, max, higherIsBetter = true, defaultScore = 50) {
  if (value === null || value === undefined || isNaN(value)) return defaultScore;
  const clamped = Math.max(min, Math.min(max, value));
  const ratio   = (clamped - min) / (max - min);      // 0–1
  const scaled  = higherIsBetter ? ratio : (1 - ratio);
  return Math.round(scaled * 100);
}

// ─────────────────────────────────────────────────────────────────────────────
// WEATHER SEVERITY HELPERS
// ─────────────────────────────────────────────────────────────────────────────

/**
 * Convert OpenWeatherMap weather_id → severity penalty (0 = none, 100 = extreme)
 * https://openweathermap.org/weather-conditions
 */
function weatherSeverityPenalty(weatherId) {
  if (!weatherId) return 0;
  if (weatherId >= 200 && weatherId < 300) return 70;  // Thunderstorm
  if (weatherId >= 300 && weatherId < 400) return 20;  // Drizzle
  if (weatherId >= 500 && weatherId < 600) return 40;  // Rain
  if (weatherId >= 600 && weatherId < 700) return 60;  // Snow
  if (weatherId >= 700 && weatherId < 800) return 50;  // Atmosphere (fog, smoke, etc.)
  if (weatherId === 800) return 0;                      // Clear sky
  if (weatherId > 800 && weatherId < 810) return 10;   // Clouds
  return 0;
}

/**
 * Temperature comfort score: ideal range 15–28°C
 * Deviations are penalized
 */
function tempComfortScore(tempCelsius) {
  if (tempCelsius === null) return 50;
  const ideal = 21.5;
  const deviation = Math.abs(tempCelsius - ideal);
  // Every 5 degrees off ideal = 10 point deduction, max penalty at 40+ deg deviation
  return normalize(deviation, 0, 40, false, 50);
}

// ─────────────────────────────────────────────────────────────────────────────
// SCORE 1: TRAVEL RISK SCORE (0–100, higher = SAFER)
// ─────────────────────────────────────────────────────────────────────────────
/**
 * Derived from:
 *  - Temperature extreme penalty
 *  - Air Quality Index (AQI) — lower AQI = safer
 *  - Travel advisory score   — lower advisory = safer
 *  - Weather event severity
 */
function computeTravelRiskScore(data) {
  const { weather, aqi, advisory } = data;

  // Normalize each sub-component to 0–100 (100 = best/safest)
  const tempScore      = weather?.temp_celsius !== undefined
    ? tempComfortScore(weather.temp_celsius)
    : 50;

  const aqiScore       = normalize(aqi?.aqi, 0, 300, false, 50);
  // Advisory: 1.0 (safe) → 5.0 (danger). Normalize: lower = better
  const advisoryScore  = normalize(advisory?.score, 1, 5, false, 50);
  const weatherEvtScore = 100 - weatherSeverityPenalty(weather?.weather_id);

  // Sub-component weights for Travel Risk Score
  const subWeights = {
    tempScore:        0.20,
    aqiScore:         0.30,
    advisoryScore:    0.35,
    weatherEvtScore:  0.15,
  };

  const raw =
    tempScore       * subWeights.tempScore +
    aqiScore        * subWeights.aqiScore +
    advisoryScore   * subWeights.advisoryScore +
    weatherEvtScore * subWeights.weatherEvtScore;

  const score = Math.round(Math.max(0, Math.min(100, raw)));

  return {
    score,
    components: {
      temperature_comfort:  tempScore,
      air_quality:          aqiScore,
      travel_advisory:      advisoryScore,
      weather_event:        weatherEvtScore,
    },
  };
}

// ─────────────────────────────────────────────────────────────────────────────
// SCORE 2: HEALTH INFRASTRUCTURE SCORE (0–100, higher = better)
// ─────────────────────────────────────────────────────────────────────────────
/**
 * Derived from:
 *  - Healthcare expenditure (% of GDP) — higher = better
 *  - Life expectancy — higher = better
 *  - Population pressure adjustment: very high pop density can strain healthcare
 */
function computeHealthInfrastructureScore(data) {
  const { worldBank, profile } = data;

  const healthExpScore = normalize(worldBank.healthcareExpenditure, 1, 15, true, 50);
  const lifeExpScore   = normalize(worldBank.lifeExpectancy, 45, 90, true, 50);

  // Population pressure: log scale 1M–2B, higher pop = more pressure = lower score
  const popPressureScore = profile?.population
    ? normalize(Math.log10(profile.population), Math.log10(1e5), Math.log10(2e9), false, 50)
    : 50;

  const subWeights = {
    healthExp:      0.40,
    lifeExp:        0.45,
    popPressure:    0.15,
  };

  const raw =
    healthExpScore  * subWeights.healthExp +
    lifeExpScore    * subWeights.lifeExp +
    popPressureScore* subWeights.popPressure;

  const score = Math.round(Math.max(0, Math.min(100, raw)));

  return {
    score,
    components: {
      healthcare_expenditure: healthExpScore,
      life_expectancy:        lifeExpScore,
      population_pressure:    popPressureScore,
    },
  };
}

// ─────────────────────────────────────────────────────────────────────────────
// SCORE 3: ENVIRONMENTAL STABILITY SCORE (0–100, higher = better)
// ─────────────────────────────────────────────────────────────────────────────
/**
 * Derived from:
 *  - AQI level — lower = more stable / livable
 *  - Weather volatility proxy (temp range + wind speed)
 *  - Humidity comfort range
 */
function computeEnvironmentalStabilityScore(data) {
  const { weather, aqi } = data;

  const aqiEnvScore    = normalize(aqi?.aqi, 0, 300, false, 50);

  // Weather volatility: temp_max - temp_min as spread (lower = more stable)
  let volatilityScore = 50;
  if (weather?.temp_max !== undefined && weather?.temp_min !== undefined) {
    const spread = weather.temp_max - weather.temp_min;
    volatilityScore = normalize(spread, 0, 20, false, 50);
  }

  // Wind comfort: calm = 0–5 m/s, moderate = 5–10, harsh = 10+
  const windScore = normalize(weather?.wind_speed_ms, 0, 20, false, 50);

  // Humidity comfort: 30–60% is ideal
  let humidityScore = 50;
  if (weather?.humidity_pct !== undefined) {
    const humDev = Math.abs(weather.humidity_pct - 45); // 45% is center of ideal
    humidityScore = normalize(humDev, 0, 55, false, 50);
  }

  const subWeights = {
    aqiEnv:      0.35,
    volatility:  0.25,
    wind:        0.15,
    humidity:    0.25,
  };

  const raw =
    aqiEnvScore     * subWeights.aqiEnv +
    volatilityScore * subWeights.volatility +
    windScore       * subWeights.wind +
    humidityScore   * subWeights.humidity;

  const score = Math.round(Math.max(0, Math.min(100, raw)));

  return {
    score,
    components: {
      air_quality_stability: aqiEnvScore,
      temperature_volatility: volatilityScore,
      wind_comfort:            windScore,
      humidity_comfort:        humidityScore,
    },
  };
}

// ─────────────────────────────────────────────────────────────────────────────
// DYNAMIC WEIGHT PROFILES
// ─────────────────────────────────────────────────────────────────────────────
/**
 * Final composite score = weighted sum of the three intelligence scores.
 * Weights are dynamically adjusted by (riskTolerance, duration).
 *
 * Travel Risk | Health Infrastructure | Environmental Stability
 */
function getDynamicWeights(riskTolerance, duration) {
  const rt = riskTolerance.toLowerCase();
  const d  = duration.toLowerCase();

  // Base weights
  let travelRisk  = 0.40;
  let healthInfra = 0.35;
  let envStab     = 0.25;

  // Risk tolerance adjustments
  if (rt === "low") {
    travelRisk  += 0.10;   // Prioritize safety
    envStab     += 0.05;
    healthInfra -= 0.10;   // Somewhat less weight on health
    // Normalize
    const sum = travelRisk + healthInfra + envStab;
    travelRisk  /= sum;
    healthInfra /= sum;
    envStab     /= sum;
  } else if (rt === "high") {
    travelRisk  -= 0.10;   // Less worried about safety
    healthInfra -= 0.05;
    envStab     += 0.10;   // More interested in environment/adventure
    const sum = travelRisk + healthInfra + envStab;
    travelRisk  /= sum;
    healthInfra /= sum;
    envStab     /= sum;
  }

  // Duration adjustments
  if (d === "long") {
    healthInfra += 0.10;   // Health matters more for long stays
    travelRisk  -= 0.05;
    envStab     -= 0.05;
    const sum = travelRisk + healthInfra + envStab;
    travelRisk  /= sum;
    healthInfra /= sum;
    envStab     /= sum;
  } else {
    // short-term: environmental conditions matter more right now
    envStab     += 0.08;
    healthInfra -= 0.08;
    const sum = travelRisk + healthInfra + envStab;
    travelRisk  /= sum;
    healthInfra /= sum;
    envStab     /= sum;
  }

  return {
    travel_risk_score:              parseFloat(travelRisk.toFixed(3)),
    health_infrastructure_score:    parseFloat(healthInfra.toFixed(3)),
    environmental_stability_score:  parseFloat(envStab.toFixed(3)),
  };
}

// ─────────────────────────────────────────────────────────────────────────────
// REASONING GENERATOR
// ─────────────────────────────────────────────────────────────────────────────
function generateReasoning(country, travelRisk, healthInfra, envStab, rawData, weights) {
  const reasons = [];

  // Travel risk reasoning
  if (travelRisk.score >= 75) {
    reasons.push(`Strong travel safety profile — advisory risk is low and air quality is acceptable.`);
  } else if (travelRisk.score <= 40) {
    const issues = [];
    if (travelRisk.components.travel_advisory < 40)
      issues.push(`elevated advisory risk (score: ${rawData.advisory?.score?.toFixed(1) ?? "N/A"})`);
    if (travelRisk.components.air_quality < 40)
      issues.push(`poor air quality (AQI: ${rawData.aqi?.aqi ?? "N/A"})`);
    if (travelRisk.components.temperature_comfort < 40)
      issues.push(`uncomfortable temperatures (${rawData.weather?.temp_celsius?.toFixed(1) ?? "N/A"}°C)`);
    reasons.push(`Travel risk is high due to: ${issues.join(", ") || "multiple factors"}.`);
  } else {
    reasons.push(`Moderate travel risk — some caution advised for ${
      travelRisk.components.travel_advisory < 50 ? "travel advisories" : "environmental conditions"
    }.`);
  }

  // Health infrastructure reasoning
  if (healthInfra.score >= 70) {
    reasons.push(`Strong health infrastructure — life expectancy of ${
      rawData.worldBank?.lifeExpectancy?.toFixed(1) ?? "N/A"
    } yrs and ${rawData.worldBank?.healthcareExpenditure?.toFixed(1) ?? "N/A"}% of GDP on healthcare.`);
  } else if (healthInfra.score <= 40) {
    reasons.push(`Health infrastructure concerns — lower investment (${
      rawData.worldBank?.healthcareExpenditure?.toFixed(1) ?? "N/A"
    }% GDP) and life expectancy of ${rawData.worldBank?.lifeExpectancy?.toFixed(1) ?? "N/A"} yrs.`);
  } else {
    reasons.push(`Adequate health infrastructure for typical stays.`);
  }

  // Environmental stability reasoning
  if (envStab.score >= 70) {
    reasons.push(`Good environmental stability — clean air and comfortable climate conditions.`);
  } else if (envStab.score <= 40) {
    reasons.push(`Environmental conditions are challenging — ${
      envStab.components.air_quality_stability < 40 ? `AQI of ${rawData.aqi?.aqi ?? "N/A"}` :
      envStab.components.humidity_comfort < 40 ? "high humidity discomfort" :
      "notable weather volatility"
    }.`);
  }

  // Weight context
  const topWeight = Object.entries(weights).sort((a, b) => b[1] - a[1])[0];
  const weightNames = {
    travel_risk_score: "Travel Safety",
    health_infrastructure_score: "Health Infrastructure",
    environmental_stability_score: "Environmental Stability",
  };
  reasons.push(`For your profile (${rawData._riskTolerance}/${rawData._duration}), ${
    weightNames[topWeight[0]]
  } carries the highest weight (${(topWeight[1] * 100).toFixed(0)}%).`);

  return reasons;
}

// ─────────────────────────────────────────────────────────────────────────────
// MASTER SCORING FUNCTION
// ─────────────────────────────────────────────────────────────────────────────
function scoreCountry(countryData, riskTolerance, duration) {
  const travelRisk = computeTravelRiskScore(countryData);
  const healthInfra = computeHealthInfrastructureScore(countryData);
  const envStab = computeEnvironmentalStabilityScore(countryData);
  const weights = getDynamicWeights(riskTolerance, duration);

  const compositeScore =
    travelRisk.score  * weights.travel_risk_score +
    healthInfra.score * weights.health_infrastructure_score +
    envStab.score     * weights.environmental_stability_score;

  const finalScore = Math.round(Math.max(0, Math.min(100, compositeScore)));

  // Attach profile metadata for reasoning
  countryData._riskTolerance = riskTolerance;
  countryData._duration = duration;

  const reasoning = generateReasoning(
    countryData.country,
    travelRisk,
    healthInfra,
    envStab,
    countryData,
    weights
  );

  logger.scoring(countryData.country, {
    travel_risk: travelRisk.score,
    health_infrastructure: healthInfra.score,
    environmental_stability: envStab.score,
    composite: finalScore,
  });

  return {
    travel_risk_score:             travelRisk,
    health_infrastructure_score:   healthInfra,
    environmental_stability_score: envStab,
    composite_score:               finalScore,
    dynamic_weights:               weights,
    reasoning,
  };
}

// ─────────────────────────────────────────────────────────────────────────────
// RANKING
// ─────────────────────────────────────────────────────────────────────────────
const RANK_LABELS = ["🥇 Best Match", "🥈 Strong Option", "🥉 Good Alternative"];

function rankResults(scoredCountries) {
  const sorted = [...scoredCountries].sort(
    (a, b) => b.scores.composite_score - a.scores.composite_score
  );
  return sorted.map((entry, i) => ({
    ...entry,
    rank: i + 1,
    rank_label: RANK_LABELS[i] || `#${i + 1} Option`,
  }));
}

module.exports = { scoreCountry, rankResults, getDynamicWeights };
