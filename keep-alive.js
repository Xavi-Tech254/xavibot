// ============================================================
// keep-alive.js — Prevents Render free tier from sleeping
// Xavi Assistant | Xavi Tech
// ============================================================

const http = require("http");

// Create a simple HTTP server
const server = http.createServer((req, res) => {
  res.writeHead(200, { "Content-Type": "text/plain" });
  res.end("✅ Xavi Assistant is running!");
});

const PORT = process.env.PORT || 3000;

server.listen(PORT, () => {
  console.log(`🌐 Keep-alive server running on port ${PORT}`);
});

// Self-ping every 14 minutes to prevent Render free tier sleep
const SERVICE_URL = process.env.RENDER_EXTERNAL_URL || `http://localhost:${PORT}`;

setInterval(() => {
  http.get(SERVICE_URL, (res) => {
    console.log(`♻️  Keep-alive ping sent — status: ${res.statusCode}`);
  }).on("error", (err) => {
    console.log("⚠️  Keep-alive ping failed:", err.message);
  });
}, 14 * 60 * 1000); // every 14 minutes
