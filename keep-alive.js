// ============================================================
// keep-alive.js — Prevents Render free tier from sleeping
// Xavi Assistant | Xavi Tech
// ============================================================

const http = require("http");

// Create a simple HTTP server
// Render needs a web server to keep the service alive
const server = http.createServer((req, res) => {
  res.writeHead(200, { "Content-Type": "text/plain" });
  res.end("✅ Xavi Assistant is running!");
});

// Use Render's PORT or default to 3000
const PORT = process.env.PORT || 3000;

server.listen(PORT, () => {
  console.log(`🌐 Keep-alive server running on port ${PORT}`);
});
