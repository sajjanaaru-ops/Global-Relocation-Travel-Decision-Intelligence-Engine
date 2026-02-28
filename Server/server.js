/**
 * server.js — Global Relocation & Travel Decision Intelligence Engine
 *
 * Architecture:
 *  routes/analyze.js     — POST /api/analyze handler
 *  services/apiService.js    — External API integrations
 *  services/scoringService.js — Normalization, scoring, ranking
 *  services/cacheService.js  — 60-min TTL cache + in-flight deduplication
 *  utils/logger.js           — Structured JSON logging
 */

require("dotenv").config();
const express = require("express");
const cors    = require("cors");
const logger  = require("./utils/logger");
const cache   = require("./services/cacheService");

const app = express();

// ─── Middleware ───────────────────────────────────────────────────────────────
app.use(cors());
app.use(express.json());

// Request logging middleware
app.use((req, _res, next) => {
  logger.info("HTTP", `${req.method} ${req.path}`, {
    ip: req.ip,
    user_agent: req.headers["user-agent"],
  });
  next();
});

// ─── Routes ───────────────────────────────────────────────────────────────────
app.use("/api/analyze", require("./routes/analyze"));

// Health check + cache stats
app.get("/health", (_req, res) => {
  res.json({
    status: "ok",
    cache: cache.stats(),
    uptime_seconds: Math.floor(process.uptime()),
    timestamp: new Date().toISOString(),
  });
});

// 404 handler
app.use((_req, res) => {
  res.status(404).json({ success: false, message: "Route not found." });
});

// Global error handler
app.use((err, _req, res, _next) => {
  logger.error("SERVER", "Unhandled error", { error: err.message, stack: err.stack });
  res.status(500).json({ success: false, message: "Internal server error." });
});

// ─── Start Server ─────────────────────────────────────────────
const PORT = process.env.PORT || 3001;

app.listen(PORT, () => {
  logger.info("SERVER", `🌍 Decision Engine running on port ${PORT}`);
  logger.info("SERVER", `Environment: ${process.env.NODE_ENV || "development"}`);
});

// Export for Vercel
module.exports = app;