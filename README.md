# 🌍 GeoIntel — Global Relocation & Travel Decision Intelligence Engine

A full-stack system that aggregates real-time public data from multiple APIs, applies multi-factor decision logic, and produces ranked, explainable country recommendations based on user-defined constraints.

---

## 🚀 Quick Start

### 1. Install dependencies
```bash
cd Server
npm install
```

### 2. Configure API keys
```bash
cp .env.example .env
```
Edit `.env` and add your keys:
```env
WEATHER_API_KEY=your_openweathermap_key
AQI_API_KEY=your_waqi_token
PORT=3001
LOG_LEVEL=INFO
```

### 3. Start the backend
```bash
npm start
```

### 4. Open the frontend
Open `index.html` in your browser or serve it:
```bash
npx serve frontend
```

---

## 📁 Project Structure

```
project/
├── Server/
│   ├── server.js                  # Entry point
│   ├── package.json
│   ├── .env                       # API keys (create from .env.example)
│   ├── routes/
│   │   └── analyze.js             # POST /api/analyze
│   ├── services/
│   │   ├── apiService.js          # All external API integrations
│   │   ├── scoringService.js      # Normalization, scoring, ranking
│   │   └── cacheService.js        # 60-min TTL cache
│   └── utils/
│       └── logger.js              # Structured JSON logging
└── frontend/
    └── index.html                 # Full dashboard UI
```

---

## 🔌 Data Sources (5 Public APIs)

| # | API | Data Collected | Auth Required |
|---|-----|----------------|---------------|
| 1 | [REST Countries v3](https://restcountries.com/) | Capital, population, currency, flag, region | ❌ None |
| 2 | [World Bank API](https://datahelpdesk.worldbank.org/) | Life expectancy, healthcare expenditure % GDP | ❌ None |
| 3 | [World Bank API](https://datahelpdesk.worldbank.org/) | Political stability index (replaces travel advisory) | ❌ None |
| 4 | [OpenWeatherMap](https://openweathermap.org/api) | Temperature, humidity, wind, weather description | ✅ Free key |
| 5 | [WAQI](https://waqi.info/) | Air Quality Index (AQI), dominant pollutant | ✅ Free key |

### Getting Free API Keys
| Key | Sign up at | Activation Time |
|-----|-----------|-----------------|
| `WEATHER_API_KEY` | https://home.openweathermap.org/users/sign_up | ~10 minutes |
| `AQI_API_KEY` | https://aqicn.org/data-platform/token/ | Instant |

---

## 🧠 Intelligence Computation

All raw metrics are normalized to **0–100** before scoring using min-max scaling:

```
normalized = ((value - min) / (max - min)) × 100
```
For inverse metrics (lower = better, e.g. AQI), the formula is flipped. Missing data defaults to a neutral score of **50**.

---

### Score 1: Travel Risk Score (0–100, higher = safer)

| Component | Weight | Raw Metric | Range |
|-----------|--------|------------|-------|
| Travel Advisory | 35% | Political stability index | -2.5 to +2.5 |
| Air Quality | 30% | AQI value | 0–300 (inverted) |
| Temperature Comfort | 20% | °C deviation from 21.5°C ideal | 0–40°C |
| Weather Event Severity | 15% | OWM weather ID classification | 0–100 penalty |

---

### Score 2: Health Infrastructure Score (0–100, higher = better)

| Component | Weight | Raw Metric | Range |
|-----------|--------|------------|-------|
| Life Expectancy | 45% | Years at birth | 45–90 yrs |
| Healthcare Expenditure | 40% | % of GDP | 1–15% |
| Population Pressure | 15% | Log₁₀(population) | 5–9.3 (inverted) |

---

### Score 3: Environmental Stability Score (0–100, higher = better)

| Component | Weight | Raw Metric | Range |
|-----------|--------|------------|-------|
| AQI Stability | 35% | AQI value | 0–300 (inverted) |
| Humidity Comfort | 25% | Deviation from 45% ideal | 0–55% |
| Temperature Volatility | 25% | Temp max-min spread | 0–20°C (inverted) |
| Wind Comfort | 15% | Wind speed m/s | 0–20 (inverted) |

---

## ⚖️ Dynamic Weight Profiles

The three scores are blended differently based on user inputs:

| Profile | Travel Risk | Health Infra | Env Stability | Rationale |
|---------|-------------|--------------|---------------|-----------|
| Low + Short | ~45% | ~27% | ~28% | Safety-first, current conditions |
| Low + Long | ~38% | ~42% | ~20% | Safety + long-term health |
| Moderate + Short | ~40% | ~27% | ~33% | Balanced, environment-aware |
| Moderate + Long | ~35% | ~42% | ~23% | Balanced, health-focused |
| High + Short | ~30% | ~25% | ~45% | Environment/adventure priority |
| High + Long | ~27% | ~38% | ~35% | Flexible, health + environment |

**Final Score Formula:**
```
composite = (TravelRisk × w1) + (HealthInfra × w2) + (EnvStability × w3)
```

---

## 🔗 API Reference

### `POST /api/analyze`

The single endpoint the frontend calls. All external API calls happen server-side.

**Request Body:**
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
    "performance": { "response_time_ms": 1650 },
    "cache": { "hits": ["Germany"], "misses": ["Japan", "Canada"] }
  },
  "weight_profile": { "travel_risk_score": 0.38, "health_infrastructure_score": 0.42, "environmental_stability_score": 0.20 },
  "ranked_results": [
    {
      "rank": 1,
      "rank_label": "🥇 Best Match",
      "country": "Germany",
      "composite_score": 79,
      "scores": {
        "travel_risk_score": { "score": 82, "components": {} },
        "health_infrastructure_score": { "score": 79, "components": {} },
        "environmental_stability_score": { "score": 71, "components": {} }
      },
      "reasoning": [
        "Strong travel safety profile — advisory risk is low and air quality is acceptable.",
        "Strong health infrastructure — life expectancy of 81.3 yrs and 11.7% of GDP on healthcare.",
        "For your profile (low/long), Health Infrastructure carries the highest weight (42%)."
      ]
    }
  ],
  "failed_countries": []
}
```

### `GET /health`
```json
{ "status": "ok", "cache": { "cached_entries": 3, "in_flight": 0 }, "uptime_seconds": 120 }
```

---

## 💾 Caching

- **TTL:** 60 minutes per country
- **Smart refresh:** Only countries not in cache trigger external API calls
- **In-flight deduplication:** Simultaneous identical requests share one external call — no duplicate API hits
- **Error safety:** Failed API responses are never cached
- **Metadata:** Every response includes `cache.hits` and `cache.misses` arrays

---

## ⚡ Performance

- All external API calls per country are executed **concurrently** using `Promise.all`
- All countries are fetched **concurrently** — 5 countries take roughly the same time as 1
- Average response time: **~1.5–2 seconds** for 5 countries (first request)
- Cached response time: **~5ms**

---

## 🛡️ Resilience

- Any single API failure returns `null` for that metric (defaults to neutral score of 50)
- Invalid country names return a structured error in `failed_countries` array
- Partial data is clearly flagged per country in `data_availability`
- Server never crashes due to third-party API instability
- All API calls have an **8-second timeout**

---

## 📊 Observability & Logging

Every log entry is structured JSON with a `category` tag:

```json
{ "level": "INFO",  "category": "API_CALL",       "message": "OPENWEATHERMAP → Germany", "duration_ms": 234, "success": true }
{ "level": "INFO",  "category": "CACHE",           "message": "HIT for germany",          "cache_hit": true }
{ "level": "INFO",  "category": "SCORING",         "message": "Computed scores for Germany", "scores": { "composite": 79 } }
{ "level": "WARN",  "category": "PARTIAL_FAILURE", "message": "WAQI_AQI failed for Tokyo: timeout" }
```

**Log categories:** `HTTP` · `API_CALL` · `CACHE` · `SCORING` · `PARTIAL_FAILURE` · `ROUTE` · `SERVER`

Set verbosity via `LOG_LEVEL` in `.env`: `DEBUG` | `INFO` | `WARN` | `ERROR`

---

## 🖥️ Frontend Features

- Tag-based country input (press Enter to add, × to remove)
- Toggle buttons for Risk Tolerance and Duration
- Loading state with step-by-step status messages
- Ranked country cards with animated score bars
- Per-country score breakdown with weight percentages
- Raw data chips (temperature, AQI, humidity, wind)
- Explainable reasoning bullets per country
- Cache hit/miss indicators
- Response time and metadata bar
- Partial data warnings when APIs are unavailable

---

## 🛠️ Tech Stack

| Layer | Technology |
|-------|-----------|
| Backend | Node.js + Express |
| HTTP Client | Axios |
| Caching | In-memory (Map) with TTL |
| Frontend | Vanilla HTML/CSS/JS |
| Fonts | IBM Plex Mono + Playfair Display |

---

## 📝 Environment Variables

| Variable | Required | Description |
|----------|----------|-------------|
| `WEATHER_API_KEY` | ✅ Yes | OpenWeatherMap API key |
| `AQI_API_KEY` | ✅ Yes | WAQI token |
| `PORT` | ❌ No | Server port (default: 3001) |
| `LOG_LEVEL` | ❌ No | Logging verbosity (default: INFO) |