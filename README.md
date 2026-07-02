# Document Intelligence Agent

A production-ready AI agent that analyzes documents (contracts, reports, PDFs) and answers questions with citations, generates summaries, and extracts structured data — powered by Claude claude-sonnet-4-6.

## What It Does

| Capability | Description |
|---|---|
| **Multi-Document Upload** | Load several documents into one session and query them together or individually |
| **Multi-Picture Upload** | Load several pictures (PNG/JPEG/WEBP/GIF) into one session and ask questions about what they show |
| **Q&A with Citations** | Ask natural language questions across one, several, or all loaded documents/pictures |
| **Summarization** | Executive, detailed, bullet-point, or TL;DR summaries — single doc or combined |
| **Structured Extraction** | Pull out dates, amounts, clauses, entities as JSON, tagged by source document |
| **Multi-turn Conversation** | Maintains context across follow-up questions |
| **Security** | Prompt injection detection, input size limits, rate limiting |

## Quick Start

```bash
# 1. Install (no dependencies — uses Node.js built-ins)
git clone <repo> && cd doc-intelligence-agent

# 2. Set API key
cp .env.example .env   # then fill in LITELLM_API_KEY
export ANTHROPIC_API_KEY=sk-ant-...

# 3. Load one or more documents/pictures and ask questions across all of them
node cli/index.js load contract.txt appendix.txt
node cli/index.js load photo1.png photo2.jpg
node cli/index.js list
node cli/index.js ask "What are the payment terms?"
node cli/index.js summarize executive
node cli/index.js extract "all dates and deadlines"

# 4. Or use interactive REPL
node cli/index.js interactive

# 5. Or start the REST API
node api/server.js
```

## CLI Reference

```bash
node cli/index.js load <file> [file2 ...]  # Load one or more documents/pictures (adds to session)
                                            # Pictures are detected by extension: .png .jpg .jpeg .webp .gif
node cli/index.js list                     # List all documents/pictures currently loaded
node cli/index.js unload <file|id>         # Remove one loaded document/picture
node cli/index.js ask "question"           # Ask a question across ALL loaded documents/pictures
node cli/index.js summarize [style]        # Styles: executive|detailed|bullets|tldr
node cli/index.js extract "goal"           # Extract structured data as JSON
node cli/index.js interactive              # REPL mode with history
```

## REST API

Start the server: `node api/server.js` (default port 3000)

**Authentication:** `Authorization: Bearer dev-key-123`  
**Session:** Pass `X-Session-Id: <your-session-id>` to maintain state across requests. A session can hold multiple documents and pictures at once (up to 25 items combined — text capped at 1.5M characters, pictures capped at 10 images / 5MB each).

### Add a document (repeat to load more — each call adds, it doesn't replace)
```bash
curl -X POST http://localhost:3000/api/documents \
  -H "Authorization: Bearer dev-key-123" \
  -H "X-Session-Id: user123" \
  -H "Content-Type: application/json" \
  -d '{"content": "Your document text here...", "filename": "contract.txt"}'
```
Response includes `document.id` (needed to reference or remove it later) and the full `documents` list for the session.

### Add a picture (repeat to load more, up to 10 per session)
```bash
curl -X POST http://localhost:3000/api/images \
  -H "Authorization: Bearer dev-key-123" \
  -H "X-Session-Id: user123" \
  -H "Content-Type: application/json" \
  -d '{"data": "<base64-encoded image bytes, or a data: URL>", "mediaType": "image/png", "filename": "photo1.png"}'
```
`mediaType` must be one of `image/png`, `image/jpeg`, `image/webp`, `image/gif`. Each picture is capped at 5MB (raw, before base64 encoding). Response shape matches `/api/documents`.

### List documents/pictures in the session
```bash
curl http://localhost:3000/api/documents \
  -H "Authorization: Bearer dev-key-123" \
  -H "X-Session-Id: user123"
```

### Remove a document or picture
```bash
curl -X DELETE http://localhost:3000/api/documents/<document-id> \
  -H "Authorization: Bearer dev-key-123" \
  -H "X-Session-Id: user123"
```

### Ask a question (across all documents/pictures, or a subset via documentIds)
```bash
curl -X POST http://localhost:3000/api/ask \
  -H "Authorization: Bearer dev-key-123" \
  -H "X-Session-Id: user123" \
  -H "Content-Type: application/json" \
  -d '{"question": "What are the payment terms?"}'

# Or scope to specific documents/pictures:
curl -X POST http://localhost:3000/api/ask \
  -H "Authorization: Bearer dev-key-123" \
  -H "X-Session-Id: user123" \
  -H "Content-Type: application/json" \
  -d '{"question": "What are the payment terms?", "documentIds": ["doc_1_abc123"]}'
```
`documentIds` can mix document and picture IDs freely — the agent answers using whichever text and/or images are in scope.

### Summarize (optionally scoped with documentIds, same as /api/ask)
```bash
curl -X POST http://localhost:3000/api/summarize \
  -H "Authorization: Bearer dev-key-123" \
  -H "X-Session-Id: user123" \
  -H "Content-Type: application/json" \
  -d '{"style": "executive"}'
```

### Extract structured data (optionally scoped with documentIds)
```bash
curl -X POST http://localhost:3000/api/extract \
  -H "Authorization: Bearer dev-key-123" \
  -H "X-Session-Id: user123" \
  -H "Content-Type: application/json" \
  -d '{"goal": "all financial terms and amounts"}'
```

### Health check
```bash
curl http://localhost:3000/health
```

## Tool Permissions & Data Handling

| Boundary | Rule |
|---|---|
| Document scope | Agent ONLY references loaded document(s)/picture(s) — never external data |
| PII handling | Agent does not volunteer PII beyond answering the specific question |
| Data retention | Documents/pictures are held in-memory per session; cleared on session end |
| Max document size | 500,000 characters (~80,000 words) per text document |
| Max documents per session | 25 items combined (text + pictures), 1,500,000 characters combined across text |
| Max pictures per session | 10 pictures, 5MB each (PNG/JPEG/WEBP/GIF) |
| Rate limit | 20 requests/minute per agent instance |
| Timeouts | 30 seconds per API call with 3 automatic retries |
| Prompt injection | Regex-based detection on both document content and questions |

## Running Evaluations

```bash
# Run all test suites
node evals/eval_runner.js

# Run specific suite
node evals/eval_runner.js --suite=qa
node evals/eval_runner.js --suite=security

# Set custom pass threshold (default 75%)
node evals/eval_runner.js --threshold=0.8

# Results are saved to evals/results.json
```

### Eval Suites

| Suite | Tests | What it covers |
|---|---|---|
| `qa` | 7 | Accuracy of Q&A responses, citation quality, "not found" handling |
| `summary` | 2 | Completeness and length constraints across summary styles |
| `extraction` | 2 | JSON extraction accuracy for financial and date data |
| `security` | 2 | Prompt injection rejection, oversized input rejection |

### Scoring

- **Rule-based:** Keyword presence/absence, length constraints — binary pass/fail
- **LLM-as-judge:** Claude scores each response 0.0–1.0 against a rubric
- **Gate:** Overall pass rate ≥ 75% required. Change with `--threshold=N`

### Interpreting results.json

```json
{
  "summary": {
    "pass_rate": 0.85,       // 85% of tests passed
    "average_score": 0.87,   // LLM judge average score
    "gate_passed": true      // Quality gate status (use in CI/CD)
  },
  "key_failure_modes": [...]  // What failed and why
}
```

## Architecture

```
doc-intelligence-agent/
├── src/agent.js          # Core agent: prompts, API calls, validation
├── api/server.js         # REST API with auth, rate limiting, error handling
├── cli/index.js          # CLI with REPL mode and state persistence
├── evals/
│   ├── eval_runner.js    # Test runner with LLM-as-judge
│   └── results.json      # Latest eval results artifact
└── README.md
```

## Known Limitations & Future Hardening

- **PDF parsing:** Currently requires pre-extracted text (the web UI extracts it client-side with pdf.js before upload; the CLI/API expect raw text).
- **Picture Q&A:** Requires `VISION_MODEL` to point at a vision-capable model your LiteLLM proxy actually serves — verify the model name/availability before relying on it in production.
- **Large documents:** >500K chars are rejected. Add chunking + semantic search for very large docs.
- **Session persistence:** In-memory only. Replace `sessions` Map with Redis for multi-instance deployments.
- **Auth:** Bearer tokens are static strings. Replace with JWT + user management in production.
- **Prompt injection:** Regex-based detection. Improve with a dedicated classifier model.
- **Observability:** Structured logs to stdout. Add OpenTelemetry spans for distributed tracing.

## Environment Variables

| Variable | Default | Description |
|---|---|---|
| `ANTHROPIC_API_KEY` | (required) | Your Anthropic API key |
| `LITELLM_API_KEY` | (required) | Your LiteLLM proxy key, used for both text and picture Q&A |
| `VISION_MODEL` | `deepinfra/Qwen/Qwen2.5-VL-32B-Instruct` | Model used automatically whenever one or more pictures are in scope for a request. Set this to whatever vision-capable model your LiteLLM proxy exposes — the default text model can't see images. |
| `PORT` | `3000` | API server port |
| `API_KEYS` | `dev-key-123,test-key-456` | Comma-separated valid API keys |
