/**
 * Document Intelligence Agent — HTTP REST API
 * Express-based server with auth, rate limiting, and structured error handling
 *
 * Endpoints:
 *   POST   /api/documents          — Add a text document to the session (multiple allowed)
 *   GET    /api/documents          — List all documents/images loaded in the session
 *   DELETE /api/documents/:id      — Remove a single document or image from the session
 *   POST   /api/images             — Add an image to the session (multiple allowed, up to 10)
 *   POST   /api/ask                — Ask a question (optionally scoped to documentIds, text and/or images)
 *   POST   /api/summarize          — Summarize loaded document(s)
 *   POST   /api/extract            — Extract structured data from loaded document(s)
 *   GET    /api/metadata           — Get metadata for all loaded documents (legacy alias of GET /api/documents)
 *   DELETE /api/session            — Clear session (all documents + history)
 *   GET    /health                 — Health check
 */
const fetch = require("node-fetch");
const http = require("http");
const { DocumentIntelligenceAgent } = require("../src/agent");
require("dotenv").config();
console.log("LiteLLM API KEY =", process.env.LITELLM_API_KEY ? "[set]" : "[not set]");
// ─── Config ────────────────────────────────────────────────────────────────
const PORT = process.env.PORT || 3000;
const API_KEYS = new Set((process.env.API_KEYS || "dev-key-123,test-key-456").split(","));
// Raised from 1MB to accommodate base64-encoded images (agent.js enforces the
// real per-image 5MB cap; this is just the outer request-body ceiling).
const MAX_BODY_SIZE = 8 * 1024 * 1024; // 8MB

// ─── Session store (in-memory; use Redis in production) ────────────────────
const sessions = new Map();

function getOrCreateSession(sessionId) {
  if (!sessions.has(sessionId)) {
    sessions.set(sessionId, new DocumentIntelligenceAgent(process.env.LITELLM_API_KEY || process.env.GROQ_API_KEY));
    // TTL: auto-expire sessions after 30 minutes
    setTimeout(() => sessions.delete(sessionId), 30 * 60 * 1000);
  }
  return sessions.get(sessionId);
}

// ─── Helpers ───────────────────────────────────────────────────────────────
function jsonResponse(res, status, data) {
  const body = JSON.stringify({ ...data, timestamp: new Date().toISOString() });
  res.writeHead(status, {
    "Content-Type": "application/json",
    "X-Content-Type-Options": "nosniff",
    "X-Frame-Options": "DENY"
  });
  res.end(body);
}

function errorResponse(res, status, code, message, details = null) {
  jsonResponse(res, status, { error: { code, message, details } });
}

async function readBody(req) {
  return new Promise((resolve, reject) => {
    let body = "";
    let size = 0;
    req.on("data", chunk => {
      size += chunk.length;
      if (size > MAX_BODY_SIZE) reject(new Error("PAYLOAD_TOO_LARGE"));
      body += chunk;
    });
    req.on("end", () => {
      try { resolve(JSON.parse(body)); }
      catch { reject(new Error("INVALID_JSON")); }
    });
    req.on("error", reject);
  });
}

function authenticate(req) {
  const auth = req.headers["authorization"] || "";
  const key = auth.replace("Bearer ", "").trim();
  return API_KEYS.has(key);
}

// ─── Router ────────────────────────────────────────────────────────────────
async function router(req, res) {
  const url = new URL(req.url, `http://localhost:${PORT}`);
  const path = url.pathname;
  const method = req.method;

  // CORS headers
  res.setHeader("Access-Control-Allow-Origin", "*");
  res.setHeader("Access-Control-Allow-Headers", "Content-Type, Authorization, X-Session-Id");
  res.setHeader("Access-Control-Allow-Methods", "GET, POST, DELETE, OPTIONS");
  if (method === "OPTIONS") return jsonResponse(res, 204, {});
  // Root route
  if (path === "/" && method === "GET") {
    return jsonResponse(res, 200, {
      service: "Document Intelligence Agent API",
      health: "/health",
      docs: "See README for endpoint list"
    });
  }

  // Health check (no auth required)
  if (path === "/health" && method === "GET") {
    return jsonResponse(res, 200, { status: "ok", sessions: sessions.size });
  }

  // Auth required for all /api/* routes
  if (path.startsWith("/api/") && !authenticate(req)) {
    return errorResponse(res, 401, "UNAUTHORIZED", "Valid API key required. Pass as: Authorization: Bearer <key>");
  }

  const sessionId = req.headers["x-session-id"] || "default";
  const agent = getOrCreateSession(sessionId);

  try {
    // ── POST /api/documents ── add a document (multiple docs may be loaded) ──
    if (path === "/api/documents" && method === "POST") {
      const body = await readBody(req);
      if (!body.content) return errorResponse(res, 400, "MISSING_FIELD", "Required: content (string)");
      const metadata = await agent.addDocument(body.content, body.filename || "document.txt");
      return jsonResponse(res, 200, {
        success: true,
        document: metadata,
        documents: agent.listDocuments(),
        session_id: sessionId
      });
    }

    // ── GET /api/documents ── list every document loaded in this session ────
    if (path === "/api/documents" && method === "GET") {
      return jsonResponse(res, 200, { success: true, documents: agent.listDocuments(), session_id: sessionId });
    }

    // ── DELETE /api/documents/:id ── remove a single document ───────────────
    const docMatch = path.match(/^\/api\/documents\/([^/]+)$/);
    if (docMatch && method === "DELETE") {
      const docId = decodeURIComponent(docMatch[1]);
      try {
        agent.removeDocument(docId);
      } catch (err) {
        return errorResponse(res, 404, "NOT_FOUND", err.message.replace(/^VALIDATION:\s*/, ""));
      }
      return jsonResponse(res, 200, { success: true, documents: agent.listDocuments(), session_id: sessionId });
    }

    // ── POST /api/images ── add an image (multiple images may be loaded) ────
    if (path === "/api/images" && method === "POST") {
      const body = await readBody(req);
      if (!body.data) return errorResponse(res, 400, "MISSING_FIELD", "Required: data (base64 string, optionally a data: URL)");
      if (!body.mediaType) return errorResponse(res, 400, "MISSING_FIELD", "Required: mediaType (e.g. image/png, image/jpeg, image/webp, image/gif)");
      const metadata = await agent.addImage(body.data, body.mediaType, body.filename || "image");
      return jsonResponse(res, 200, {
        success: true,
        document: metadata,
        documents: agent.listDocuments(),
        session_id: sessionId
      });
    }

    // ── POST /api/ask ── optionally scope to specific documents via documentIds ──
    if (path === "/api/ask" && method === "POST") {
      const body = await readBody(req);
      if (!body.question) return errorResponse(res, 400, "MISSING_FIELD", "Required: question (string)");
      if (agent.documents.size === 0) {
        return errorResponse(res, 400, "NO_DOCUMENT", "No documents loaded. POST to /api/documents first.");
      }
      const result = await agent.ask(body.question, body.documentIds || null);
      return jsonResponse(res, 200, { success: true, ...result, session_id: sessionId });
    }

    // ── POST /api/summarize ──────────────────────────────────────────────
    if (path === "/api/summarize" && method === "POST") {
      const body = await readBody(req);
      const style = body.style || "executive";
      if (agent.documents.size === 0) {
        return errorResponse(res, 400, "NO_DOCUMENT", "No documents loaded. POST to /api/documents first.");
      }
      const result = await agent.summarize(style, body.documentIds || null);
      return jsonResponse(res, 200, { success: true, ...result, session_id: sessionId });
    }

    // ── POST /api/extract ────────────────────────────────────────────────
    if (path === "/api/extract" && method === "POST") {
      const body = await readBody(req);
      if (!body.goal) return errorResponse(res, 400, "MISSING_FIELD", "Required: goal (string describing what to extract)");
      if (agent.documents.size === 0) {
        return errorResponse(res, 400, "NO_DOCUMENT", "No documents loaded. POST to /api/documents first.");
      }
      const result = await agent.extract(body.goal, body.documentIds || null);
      return jsonResponse(res, 200, { success: true, ...result, session_id: sessionId });
    }

    // ── GET /api/metadata ── legacy alias, now returns all loaded documents ──
    if (path === "/api/metadata" && method === "GET") {
      if (agent.documents.size === 0) {
        return errorResponse(res, 404, "NO_DOCUMENT", "No document loaded in this session. POST to /api/documents first.");
      }
      return jsonResponse(res, 200, { success: true, metadata: agent.documentMetadata, documents: agent.listDocuments() });
    }

    // ── DELETE /api/session ── clears all documents + history ───────────────
    if (path === "/api/session" && method === "DELETE") {
      agent.clearSession();
      sessions.delete(sessionId);
      return jsonResponse(res, 200, { success: true, message: "Session cleared." });
    }

    errorResponse(res, 404, "NOT_FOUND", `Route ${method} ${path} not found.`);

  } catch (err) {
    const isKnown = err.message.startsWith("VALIDATION:") || err.message.startsWith("SECURITY:") || err.message.startsWith("RATE_LIMIT:");
    const status = err.message.startsWith("RATE_LIMIT:") ? 429 : isKnown ? 400 : 500;
    const code = isKnown ? err.message.split(":")[0] : "INTERNAL_ERROR";
    const message = isKnown ? err.message.split(":").slice(1).join(":").trim() : "An unexpected error occurred.";
    console.error("FULL ERROR:");
    console.error(err);
    console.error(err.stack);
    errorResponse(res, status, code, message, isKnown ? null : "Check server logs for details.");
  }
}

// ─── Start server ─────────────────────────────────────────────────────────
const server = http.createServer(router);
server.listen(PORT, () => {
  console.log(JSON.stringify({ level: "info", event: "server_started", port: PORT, timestamp: new Date().toISOString() }));
  console.log(`\n🚀 Document Intelligence Agent API running on http://localhost:3000/`);
  console.log(`   Health:http://localhost:3000/health`);
  console.log(`   Auth: Authorization: Bearer dev-key-123\n`);
});

module.exports = server;
