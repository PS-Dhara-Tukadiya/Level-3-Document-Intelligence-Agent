#!/usr/bin/env node
/**
 * Document Intelligence Agent — CLI
 * Usage:
 *   node cli/index.js load <file> [file2 file3 ...]   Load one or more documents (adds to session)
 *   node cli/index.js list                            List all loaded documents
 *   node cli/index.js unload <file|id>                Remove one loaded document
 *   node cli/index.js ask "What are the key terms?"   Ask across ALL loaded documents
 *   node cli/index.js summarize [executive|detailed|bullets|tldr]
 *   node cli/index.js extract "all dates and deadlines"
 *   node cli/index.js interactive   (REPL mode)
 */

const fs = require("fs");
const path = require("path");
const readline = require("readline");
require("dotenv").config();
const { DocumentIntelligenceAgent } = require("../src/agent");

// ─── Colors ───────────────────────────────────────────────────────────────
const c = {
  reset: "\x1b[0m",
  bold: "\x1b[1m",
  dim: "\x1b[2m",
  cyan: "\x1b[36m",
  green: "\x1b[32m",
  yellow: "\x1b[33m",
  red: "\x1b[31m",
  blue: "\x1b[34m",
  gray: "\x1b[90m"
};

const print = {
  info: (msg) => console.log(`${c.cyan}ℹ ${c.reset}${msg}`),
  success: (msg) => console.log(`${c.green}✓ ${c.reset}${msg}`),
  error: (msg) => console.error(`${c.red}✗ ${c.reset}${msg}`),
  warn: (msg) => console.log(`${c.yellow}⚠ ${c.reset}${msg}`),
  answer: (msg) => console.log(`\n${c.blue}${c.bold}Agent:${c.reset}\n${msg}\n`),
  header: (msg) => console.log(`\n${c.bold}${c.cyan}═══ ${msg} ═══${c.reset}\n`)
};

// ─── State file (persists documents between commands) ──────────────────────
// State shape: { documents: [{ id, content, filename, metadata }], savedAt }
const STATE_FILE = path.join(process.cwd(), ".doc-agent-state.json");

function loadState() {
  try {
    if (fs.existsSync(STATE_FILE)) {
      const raw = JSON.parse(fs.readFileSync(STATE_FILE, "utf8"));
      // Backward-compat: migrate old single-document state shape.
      if (raw && raw.content && !raw.documents) {
        return { documents: [{ id: raw.metadata?.id || "doc_1", content: raw.content, filename: raw.filename, metadata: raw.metadata }], savedAt: raw.savedAt };
      }
      return raw;
    }
  } catch {}
  return null;
}

function saveState(documents) {
  fs.writeFileSync(STATE_FILE, JSON.stringify({ documents, savedAt: new Date().toISOString() }));
}

function addDocumentToState(id, content, filename, metadata) {
  const state = loadState() || { documents: [] };
  state.documents.push({ id, content, filename, type: "text", metadata });
  saveState(state.documents);
  return state.documents;
}

function addImageToState(id, data, mediaType, filename, metadata) {
  const state = loadState() || { documents: [] };
  state.documents.push({ id, data, mediaType, filename, type: "image", metadata });
  saveState(state.documents);
  return state.documents;
}

function removeDocumentFromState(idOrFilename) {
  const state = loadState();
  if (!state) return [];
  const before = state.documents.length;
  const remaining = state.documents.filter(d => d.id !== idOrFilename && d.filename !== idOrFilename);
  saveState(remaining);
  return { removed: before !== remaining.length, documents: remaining };
}

// Rebuilds an agent with every document/image from state loaded into it.
async function agentFromState(state) {
  const agent = new DocumentIntelligenceAgent(process.env.LITELLM_API_KEY);
  for (const doc of state.documents) {
    if (doc.type === "image") {
      await agent.addImage(doc.data, doc.mediaType, doc.filename);
    } else {
      await agent.addDocument(doc.content, doc.filename);
    }
  }
  return agent;
}

const IMAGE_EXT_TO_MEDIATYPE = {
  ".png": "image/png",
  ".jpg": "image/jpeg",
  ".jpeg": "image/jpeg",
  ".webp": "image/webp",
  ".gif": "image/gif"
};

// ─── Command handlers ─────────────────────────────────────────────────────
// Loads one or more files, adding each as a new document/image alongside any already loaded.
async function cmdLoad(filePaths) {
  const files = Array.isArray(filePaths) ? filePaths : [filePaths];
  if (files.length === 0 || !files[0]) {
    print.error("Usage: node cli/index.js load <file.txt|file.pdf-text|photo.png> [file2 ...]");
    process.exit(1);
  }

  for (const filePath of files) {
    const resolved = path.resolve(filePath);
    if (!fs.existsSync(resolved)) { print.error(`File not found: ${resolved}`); continue; }

    const ext = path.extname(resolved).toLowerCase();
    const agent = new DocumentIntelligenceAgent(process.env.LITELLM_API_KEY);

    if (IMAGE_EXT_TO_MEDIATYPE[ext]) {
      print.info(`Loading image: ${resolved}`);
      const mediaType = IMAGE_EXT_TO_MEDIATYPE[ext];
      const base64 = fs.readFileSync(resolved).toString("base64");

      try {
        const metadata = await agent.addImage(base64, mediaType, path.basename(resolved));
        addImageToState(metadata.id, base64, mediaType, metadata.filename, metadata);

        print.header("Image Loaded");
        console.log(`  ${c.bold}ID:${c.reset}       ${metadata.id}`);
        console.log(`  ${c.bold}Filename:${c.reset} ${metadata.filename}`);
        console.log(`  ${c.bold}Size:${c.reset}     ${(metadata.sizeBytes / 1024).toFixed(1)} KB`);
        print.success(`Image ready. Run 'list' to see all loaded items, or 'ask "your question"' to query them.`);
      } catch (err) {
        print.error(`${filePath}: ${err.message}`);
      }
      continue;
    }

    print.info(`Loading: ${resolved}`);
    const content = fs.readFileSync(resolved, "utf8");

    try {
      const metadata = await agent.addDocument(content, path.basename(resolved));
      addDocumentToState(metadata.id, content, metadata.filename, metadata);

      print.header("Document Loaded");
      console.log(`  ${c.bold}ID:${c.reset}       ${metadata.id}`);
      console.log(`  ${c.bold}Filename:${c.reset} ${metadata.filename}`);
      console.log(`  ${c.bold}Chars:${c.reset}    ${metadata.charCount}`);
      print.success(`Document ready. Run 'list' to see all loaded documents, or 'ask "your question"' to query them.`);
    } catch (err) {
      print.error(`${filePath}: ${err.message}`);
    }
  }
}

function cmdList() {
  const state = loadState();
  if (!state || state.documents.length === 0) {
    print.warn("No documents loaded. Run: node cli/index.js load <file>");
    return;
  }
  print.header(`Loaded Items (${state.documents.length})`);
  state.documents.forEach((d, i) => {
    if (d.type === "image") {
      const kb = ((d.data || "").length * 0.75 / 1024).toFixed(1);
      console.log(`  ${i + 1}. ${c.bold}${d.filename}${c.reset}  ${c.gray}(id: ${d.id}, image, ~${kb} KB)${c.reset}`);
    } else {
      console.log(`  ${i + 1}. ${c.bold}${d.filename}${c.reset}  ${c.gray}(id: ${d.id}, ${(d.content || "").length} chars)${c.reset}`);
    }
  });
}

function cmdUnload(idOrFilename) {
  if (!idOrFilename) { print.error("Usage: node cli/index.js unload <file|id>"); process.exit(1); }
  const { removed, documents } = removeDocumentFromState(idOrFilename);
  if (removed) {
    print.success(`Removed "${idOrFilename}". ${documents.length} document(s) remain loaded.`);
  } else {
    print.error(`No loaded document matches "${idOrFilename}". Run 'list' to see loaded documents.`);
  }
}

async function cmdAsk(question) {
  if (!question) { print.error('Usage: node cli/index.js ask "your question here"'); process.exit(1); }

  const state = loadState();
  if (!state || state.documents.length === 0) { print.error("No document loaded. Run: node cli/index.js load <file>"); process.exit(1); }

  const agent = await agentFromState(state);

  print.info(`Documents: ${state.documents.map(d => d.filename).join(", ")} | Question: "${question}"`);

  const { answer, usage } = await agent.ask(question);
  print.answer(answer);

  if (usage) {
    console.log(`${c.gray}  Tokens: ${usage.input_tokens} in / ${usage.output_tokens} out${c.reset}\n`);
  }
}

async function cmdSummarize(style = "executive") {
  const valid = ["executive", "detailed", "bullets", "tldr"];
  if (!valid.includes(style)) {
    print.error(`Invalid style. Choose from: ${valid.join(", ")}`);
    process.exit(1);
  }

  const state = loadState();
  if (!state || state.documents.length === 0) { print.error("No document loaded. Run: node cli/index.js load <file>"); process.exit(1); }

  const agent = await agentFromState(state);

  print.info(`Summarizing (${style}) across ${state.documents.length} document(s)...`);
  const { summary, usage } = await agent.summarize(style);

  print.header(`${style.toUpperCase()} SUMMARY`);
  console.log(summary);

  if (usage) {
    console.log(`\n${c.gray}Tokens: ${usage.input_tokens} in / ${usage.output_tokens} out${c.reset}`);
  }
}

async function cmdExtract(goal) {
  if (!goal) { print.error('Usage: node cli/index.js extract "all payment terms and amounts"'); process.exit(1); }

  const state = loadState();
  if (!state || state.documents.length === 0) { print.error("No document loaded. Run: node cli/index.js load <file>"); process.exit(1); }

  const agent = await agentFromState(state);

  print.info(`Extracting: "${goal}"`);
  const { data } = await agent.extract(goal);

  print.header("EXTRACTED DATA");
  console.log(JSON.stringify(data, null, 2));
}

// ─── Interactive REPL mode ────────────────────────────────────────────────
async function cmdInteractive() {
  let state = loadState();
  let agent = state ? await agentFromState(state) : new DocumentIntelligenceAgent(process.env.LITELLM_API_KEY);

  if (state && state.documents.length > 0) {
    print.success(`Resumed session with ${state.documents.length} document(s): ${state.documents.map(d => d.filename).join(", ")}`);
  } else {
    print.warn("No documents loaded. Type: load <filepath> to begin.");
  }

  print.header("Document Intelligence Agent — Interactive Mode");
  console.log(`${c.gray}Commands: ask <question>, summarize [style], extract <goal>, load <file>, list, unload <file|id>, clear, quit${c.reset}\n`);

  const rl = readline.createInterface({ input: process.stdin, output: process.stdout, prompt: `${c.cyan}> ${c.reset}` });
  rl.prompt();

  rl.on("line", async (line) => {
    const input = line.trim();
    if (!input) { rl.prompt(); return; }

    const [cmd, ...rest] = input.split(" ");
    const arg = rest.join(" ");

    try {
      if (cmd === "quit" || cmd === "exit") { console.log("Goodbye!"); process.exit(0); }

      if (cmd === "load") {
        await cmdLoad(arg);
        state = loadState();
        agent = state ? await agentFromState(state) : agent;
      }
      else if (cmd === "list") {
        cmdList();
      }
      else if (cmd === "unload") {
        cmdUnload(arg);
        state = loadState();
        agent = state ? await agentFromState(state) : new DocumentIntelligenceAgent(process.env.LITELLM_API_KEY);
      }
      else if (cmd === "ask") {
        if (!arg) { print.error('Usage: ask "your question"'); }
        else if (agent.documents.size === 0) { print.error('No documents loaded. Type: load <filepath> first.'); }
        else {
          print.info(`Thinking...`);
          const { answer } = await agent.ask(arg);
          print.answer(answer);
        }
      }
      else if (cmd === "summarize") {
        if (agent.documents.size === 0) { print.error('No documents loaded. Type: load <filepath> first.'); }
        else {
          print.info(`Summarizing...`);
          const { summary } = await agent.summarize(arg || "executive");
          console.log(summary);
        }
      }
      else if (cmd === "extract") {
        if (agent.documents.size === 0) { print.error('No documents loaded. Type: load <filepath> first.'); }
        else {
          print.info(`Extracting...`);
          const { data } = await agent.extract(arg);
          console.log(JSON.stringify(data, null, 2));
        }
      }
      else if (cmd === "clear") {
        agent.clearSession();
        if (fs.existsSync(STATE_FILE)) fs.unlinkSync(STATE_FILE);
        print.success("Session cleared.");
      }
      else if (cmd === "metadata") {
        console.log(JSON.stringify(agent.listDocuments(), null, 2));
      }
      else {
        print.error(`Unknown command: ${cmd}. Available: ask, summarize, extract, load, list, unload, clear, metadata, quit`);
      }
    } catch (err) {
      print.error(err.message);
    }

    rl.prompt();
  });

  rl.on("close", () => { console.log("\nGoodbye!"); process.exit(0); });
}

// ─── Entry point ──────────────────────────────────────────────────────────
async function main() {
  const [,, command, ...args] = process.argv;
  
  if (!command) {
    console.log(`
${c.bold}${c.cyan}Document Intelligence Agent CLI${c.reset}

${c.bold}Usage:${c.reset}
  node cli/index.js load <file> [file2 ...]    Load one or more documents (adds to session)
  node cli/index.js list                       List all loaded documents
  node cli/index.js unload <file|id>           Remove one loaded document
  node cli/index.js ask "question"             Ask across ALL loaded documents
  node cli/index.js summarize [style]          Summarize (executive|detailed|bullets|tldr)
  node cli/index.js extract "goal"             Extract structured data
  node cli/index.js interactive                REPL mode

${c.bold}Environment:${c.reset}
  LITELLM_API_KEY=<your key>   Set in .env (see .env.example)
`);
    process.exit(0);
  }

  try {
    if (command === "load") await cmdLoad(args);
    else if (command === "list") cmdList();
    else if (command === "unload") cmdUnload(args[0]);
    else if (command === "ask") await cmdAsk(args.join(" "));
    else if (command === "summarize") await cmdSummarize(args[0]);
    else if (command === "extract") await cmdExtract(args.join(" "));
    else if (command === "interactive") await cmdInteractive();
    else { print.error(`Unknown command: ${command}`); process.exit(1); }
  } catch (err) {
    print.error(err.message);
    process.exit(1);
  }
}

main();
