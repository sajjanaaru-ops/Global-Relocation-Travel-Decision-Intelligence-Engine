# 🌍 Global Relocation & Travel Decision Intelligence Engine

A full-stack backend that aggregates real-time public data, applies multi-factor decision logic, and produces ranked, explainable country recommendations.

---

## Architecture

```
relocation-engine/
├── server.js                  # Entry point, middleware, error handling
├── routes/
│   └── analyze.js             # POST /api/analyze — orchestration layer
├── services/
│   ├── apiService.js          # All external API integrations
│   ├── scoringService.js      # Normalization, 3 scores, ranking, reasoning
│   └── cacheService.js        # 60-min TTL cache + in-flight deduplication
├── utils/
│   └── logger.js              # Structured JSON logging
├── .env.example
└── package.json
```

---

## Quick Start

```bash
# 1. Install
npm install

# 2. Configure API keys
cp .env.example .env
# Edit .env with your keys (see below)

# 3. Run
npm start          # production
npm run dev        # development (auto-reload)
```

### Free API Keys (2 min to get)
| Key | Sign up at |
|-----|-----------|
| `WEATHER_API_KEY` | https://home.openweathermap.org/users/sign_up |
| `AQI_API_KEY` | https://aqicn.org/data-platform/token/ |

---

## API Reference

### `POST /api/analyze`

The **single endpoint** the frontend calls. Never calls public APIs directly.

**Request:**
```json
{
  "countries": ["Germany", "Japan", "Canada"],
  "riskTolerance": "low",
  "duration": "long"
}
```

| Field | Type | Values |
|-------|------|--------|
| `countries` | `string[]` | 3–10 country names |
| `riskTolerance` | `string` | `"low"` / `"moderate"` / `"high"` |
| `duration` | `string` | `"short"` / `"long"` |

**Response:**
```json
{
  "success": true,
  "meta": {
    "query": { "countries": [...], "riskTolerance": "low", "duration": "long" },
    "performance": { "response_time_ms": 843, "countries_analyzed": 3, "countries_failed": 0 },
    "cache": {
      "hits": ["Germany"],
      "misses": ["Japan", "Canada"],
      "ttl_minutes": 60
    },
    "generated_at": "2025-01-01T12:00:00.000Z"
  },
  "weight_profile": {
    "travel_risk_score": 0.382,
    "health_infrastructure_score": 0.421,
    "environmental_stability_score": 0.197
  },
  "ranked_results": [
    {
      "rank": 1,
      "rank_label": "🥇 Best Match",
      "country": "Germany",
      "profile": {
        "capital": "Berlin",
        "population": 83240000,
        "currencies": "Euro (€)",
        "region": "Europe",
        "flag_url": "https://..."
      },
      "raw_data": {
        "life_expectancy_years": 81.3,
        "healthcare_expenditure_gdp_pct": 11.7,
        "weather": { "temp_celsius": 12, "humidity_pct": 68, "description": "light rain" },
        "aqi": { "aqi": 38, "dominant_pollutant": "pm25" },
        "travel_advisory": { "score": 1.5, "message": "Exercise normal safety precautions" }
      },
      "data_availability": {
        "profile": true, "worldBank": true, "weather": true, "aqi": true, "advisory": true
      },
      "cache_hit": true,
      "scores": {
        "travel_risk_score": { "score": 82, "components": { ... } },
        "health_infrastructure_score": { "score": 79, "components": { ... } },
        "environmental_stability_score": { "score": 71, "components": { ... } },
        "composite_score": 79,
        "dynamic_weights": { ... },
        "reasoning": [
          "Strong travel safety profile — advisory risk is low and air quality is acceptable.",
          "Strong health infrastructure — life expectancy of 81.3 yrs and 11.7% of GDP on healthcare.",
          "Good environmental stability — clean air and comfortable climate conditions.",
          "For your profile (low/long), Health Infrastructure carries the highest weight (42%)."
        ]
      }
    }
  ],
  "failed_countries": []
}
```

### `GET /health`
Returns server status and cache stats.

---

## Data Sources (5 Public APIs)

| # | API | Data | Auth |
|---|-----|------|------|
| 1 | [REST Countries v3](https://restcountries.com/) | Capital, population, currency, flag | None |
| 2 | [World Bank API](https://datahelpdesk.worldbank.org/) | Life expectancy, healthcare % GDP | None |
| 3 | [OpenWeatherMap](https://openweathermap.org/api) | Current weather, temp, humidity | Free key |
| 4 | [WAQI](https://waqi.info/) | Air Quality Index, pollutants | Free key |
| 5 | [travel-advisory.info](https://www.travel-advisory.info/) | Advisory score (1–5 scale) | None |

---

## Intelligence Scores

All metrics are normalized to **0–100** using min-max scaling before aggregation:
```
normalized = ((value - min) / (max - min)) × 100
```
For inverse metrics (lower raw = better), the formula is inverted.
Missing data defaults to a neutral score of **50**.

---

### 1. Travel Risk Score (0–100, higher = safer)

| Component | Weight | Raw Metric | Range |
|-----------|--------|------------|-------|
| Air Quality | 30% | AQI | 0–300 (inverted) |
| Travel Advisory | 35% | Advisory score | 1–5 (inverted) |
| Temperature Comfort | 20% | °C deviation from 21.5°C ideal | 0–40°C |
| Weather Event Severity | 15% | OWM weather_id classification | 0–100 penalty |

---

### 2. Health Infrastructure Score (0–100, higher = better)

| Component | Weight | Raw Metric | Range |
|-----------|--------|------------|-------|
| Life Expectancy | 45% | Years | 45–90 |
| Healthcare Expenditure | 40% | % of GDP | 1–15% |
| Population Pressure | 15% | Log₁₀(population) | 5–9.3 (inverted) |

---

### 3. Environmental Stability Score (0–100, higher = better)

| Component | Weight | Raw Metric | Range |
|-----------|--------|------------|-------|
| AQI Stability | 35% | AQI | 0–300 (inverted) |
| Humidity Comfort | 25% | Deviation from 45% ideal | 0–55% |
| Temperature Volatility | 25% | Temp max-min spread | 0–20°C (inverted) |
| Wind Comfort | 15% | Wind speed m/s | 0–20 (inverted) |

---

## Dynamic Weight Profiles

Final score = weighted sum of three intelligence scores.
Weights shift based on `riskTolerance × duration`:

| Profile | Travel Risk | Health Infra | Env Stability | Rationale |
|---------|-------------|--------------|---------------|-----------|
| low + short | ~45% | ~27% | ~28% | Safety-first, current conditions |
| low + long | ~38% | ~42% | ~20% | Safety + long-term health |
| moderate + short | ~40% | ~27% | ~33% | Balanced, environment-aware |
| moderate + long | ~35% | ~42% | ~23% | Balanced, health-focused |
| high + short | ~30% | ~25% | ~45% | Environment/adventure priority |
| high + long | ~27% | ~38% | ~35% | Flexible, health + environment |

---

## Caching

- **TTL**: 60 minutes per country
- **In-flight deduplication**: Simultaneous identical requests share a single external call
- **Selective refresh**: Only countries not in cache trigger external API calls
- **Error safety**: Failed responses are never cached
- **Metadata**: Every response includes `cache.hits` and `cache.misses` arrays

---

## Observability Logging

Every log entry is structured JSON:

```json
{ "timestamp": "...", "level": "INFO", "category": "API_CALL", "message": "OPENWEATHERMAP → Germany", "duration_ms": 234, "success": true }
{ "timestamp": "...", "level": "INFO", "category": "CACHE", "message": "HIT for germany", "cache_hit": true }
{ "timestamp": "...", "level": "INFO", "category": "SCORING", "message": "Computed scores for Germany", "scores": { ... } }
{ "timestamp": "...", "level": "WARN", "category": "PARTIAL_FAILURE", "message": "WAQI_AQI failed for SomeCity: timeout" }
```

Categories: `HTTP`, `API_CALL`, `CACHE`, `SCORING`, `PARTIAL_FAILURE`, `ROUTE`, `SERVER`

---

## Resilience

- Any single API failure returns `null` for that metric (defaults to neutral score)
- Invalid country names return a `404`-style entry in `failed_countries`
- Partial data is clearly flagged in `data_availability` per country
- Server never crashes due to third-party API instability
