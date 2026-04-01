import express from "express";
import cors from "cors";
import { createHash } from "crypto";
import fs from "fs";
import path from "path";

const app = express();

app.use(cors());
app.use(express.json({ limit: "50mb" }));

const OPENAI_API_KEY = process.env.OPENAI_API_KEY;
const OPENAI_MODEL = process.env.OPENAI_MODEL || "gpt-4o";
const PORT = process.env.PORT || 8787;

const SEGMENT_CHUNK_SIZE = 16;
const SEGMENT_CHUNK_OVERLAP = 3;

// ── Determinism ──
// Fixed seed ensures identical outputs for identical inputs across runs.
// OpenAI's seed param provides "mostly deterministic" results (same system_fingerprint).
// Combined with temperature=0, this maximizes reproducibility.
const OPENAI_SEED = 42;
const ENABLE_CACHE = true;
const resultCache = new Map(); // key: sha256(prompt pair) → value: parsed JSON

function cacheKey(systemPrompt, userPrompt) {
  const h = createHash("sha256");
  h.update(systemPrompt);
  h.update("\x00");
  h.update(userPrompt);
  return h.digest("hex");
}

if (!OPENAI_API_KEY) {
  throw new Error("OPENAI_API_KEY is missing");
}

process.on("uncaughtException", (err) => console.error("[FATAL]", err));
process.on("unhandledRejection", (err) => console.error("[FATAL]", err));

app.use((req, res, next) => {
  console.log(`[REQ] ${req.method} ${req.url}`);
  next();
});

app.get("/health", (_req, res) => res.json({ ok: true }));

// ── Cache management ──
app.get("/cache/stats", (_req, res) => {
  res.json({ size: resultCache.size, enabled: ENABLE_CACHE, seed: OPENAI_SEED });
});
app.post("/cache/clear", (_req, res) => {
  const prev = resultCache.size;
  resultCache.clear();
  console.log(`[cache] Cleared ${prev} entries`);
  res.json({ cleared: prev });
});

/******************************************************************
 * INTERACTION LOG  (Study Edition)
 *
 * POST /log          — append one event to JSONL file
 * GET  /log/export   — download full log as JSON array
 * POST /log/clear    — wipe the log file
 ******************************************************************/
const LOG_DIR  = path.resolve("logs");
const LOG_FILE = path.join(LOG_DIR, "interaction_log.jsonl");

if (!fs.existsSync(LOG_DIR)) fs.mkdirSync(LOG_DIR, { recursive: true });

app.post("/log", (req, res) => {
  try {
    const entry = req.body;
    if (!entry || typeof entry !== "object") {
      return res.status(400).json({ error: "JSON body required" });
    }
    // server-side receive timestamp for reliability
    entry._server_ts = new Date().toISOString();
    fs.appendFileSync(LOG_FILE, JSON.stringify(entry) + "\n");
    console.log(`[log] ${entry.event || "?"} | ${entry.participant || "?"} | ${entry.session || "?"}`);
    return res.json({ ok: true });
  } catch (err) {
    console.error("[log] write failed:", err.message);
    return res.status(500).json({ error: "Log write failed" });
  }
});

app.get("/log/export", (_req, res) => {
  try {
    if (!fs.existsSync(LOG_FILE)) return res.json([]);
    const lines = fs.readFileSync(LOG_FILE, "utf-8").split("\n").filter(Boolean);
    const entries = lines.map(l => { try { return JSON.parse(l); } catch { return null; } }).filter(Boolean);
    res.setHeader("Content-Disposition", `attachment; filename="interaction_log_${Date.now()}.json"`);
    return res.json(entries);
  } catch (err) {
    return res.status(500).json({ error: "Export failed", detail: err.message });
  }
});

app.post("/log/clear", (_req, res) => {
  try {
    if (fs.existsSync(LOG_FILE)) fs.unlinkSync(LOG_FILE);
    console.log("[log] cleared");
    return res.json({ cleared: true });
  } catch (err) {
    return res.status(500).json({ error: "Clear failed" });
  }
});

/******************************************************************
 * OPENAI CALL
 ******************************************************************/
async function callOpenAI(systemPrompt, userPrompt, model) {
  // ── Cache lookup ──
  const ck = cacheKey(systemPrompt, userPrompt);
  if (ENABLE_CACHE && resultCache.has(ck)) {
    console.log("[openai] cache HIT", ck.slice(0, 12));
    return resultCache.get(ck);
  }

  const payload = {
    model: model || OPENAI_MODEL,
    temperature: 0,          // deterministic: no sampling randomness
    seed: OPENAI_SEED,       // deterministic: fixed seed for reproducibility
    max_tokens: 16384,
    response_format: { type: "json_object" },
    messages: [
      { role: "system", content: systemPrompt },
      { role: "user", content: userPrompt }
    ]
  };

  const controller = new AbortController();
  const timeout = setTimeout(() => controller.abort(), 600000);

  try {
    const res = await fetch("https://api.openai.com/v1/chat/completions", {
      method: "POST",
      headers: {
        "Content-Type": "application/json",
        Authorization: `Bearer ${OPENAI_API_KEY}`
      },
      body: JSON.stringify(payload),
      signal: controller.signal
    });

    const text = await res.text();

    if (!res.ok) {
      throw new Error(`OpenAI ${res.status}: ${text.slice(0, 500)}`);
    }

    const parsed = JSON.parse(text);

    // Log system_fingerprint for reproducibility auditing
    const fingerprint = parsed?.system_fingerprint || "unknown";
    console.log("[openai] system_fingerprint:", fingerprint);

    const content = parsed?.choices?.[0]?.message?.content;
    if (!content) throw new Error("Empty OpenAI response content");

    const result = JSON.parse(content);

    // ── Cache store ──
    if (ENABLE_CACHE) {
      resultCache.set(ck, result);
      console.log("[openai] cache STORE", ck.slice(0, 12), "| cache size:", resultCache.size);
    }

    return result;
  } finally {
    clearTimeout(timeout);
  }
}

/******************************************************************
 * PROMPTS — STEP 1: Segment + Intent
 ******************************************************************/
function segmentIntentSystemPrompt() {
  return `
You are analyzing a research chat log between a researcher and an AI assistant.

Your task is to jointly:
1. segment the conversation into minimal contiguous semantic segments
2. assign a research intent label to each segment

Assume this is a research-oriented conversation. The user is engaged in activities such as defining research problems, refining concepts, positioning related work, designing methods, planning evaluations, critiquing ideas, making decisions, revising prior claims, drafting paper text, and planning next steps.

This is NOT a general chat taxonomy task.
This is a research workflow analysis task.

A segment:
- is a small contiguous semantic unit
- usually spans 1–3 turns
- should preserve enough local context to infer the intent correctly
- should be split when the local research function changes

Research Intent Taxonomy:

1. Problem Framing
Define or refine the core research problem, motivation, scope, or significance.

2. Concept Formation
Create, clarify, compare, or refine concepts, constructs, definitions, or terminology.

3. Related Work Positioning
Interpret prior work and position the current idea against it.

4. Method Design
Design the analytical procedure, pipeline, annotation method, or experimental method.

5. Implementation Planning
Discuss system building, engineering choices, code structure, tools, or deployment steps.

6. Evaluation Design
Define tasks, metrics, baselines, study design, or validation strategies.

7. Evidence Gathering
Search for, summarize, or collect supporting papers, examples, datasets, or empirical evidence.

8. Critique
Identify weaknesses, mismatches, risks, confounds, or limitations in the current idea or design.

9. Comparison
Compare alternatives, frameworks, papers, methods, or interface choices.

10. Decision Making
Commit to one option, reject an alternative, or finalize a direction.

11. Revision
Revise or reframe an earlier claim, definition, method, or decision.

12. Writing / Formalization
Draft or polish titles, abstracts, method text, figures, phrasing, or paper-ready claims.

13. Next-step Planning
Plan immediate actions, TODOs, sequencing, or what to do next.

14. Other
Use only if none of the above applies.

Rules:
- Preserve message IDs exactly.
- Segments must be contiguous.
- Prefer smaller segments over larger ones, but keep enough context to infer the intent correctly.
- Label based on the USER'S research action, not the assistant's response style.
- Use one primary_intent for every segment.
- Use secondary_intent only when a second intent is clearly present.
- Do not infer hidden intent beyond visible evidence.
- Do not treat assistant suggestions as final decisions unless the user explicitly accepts or commits.
- Write all human-readable fields in the dominant language of the conversation chunk.
- Keep JSON field names in English.
- Return STRICT JSON only.

Output schema:
{
  "segments": [
    {
      "segment_id": "S1",
      "message_ids": ["m1","m2"],
      "summary": "...",
      "primary_intent": "Problem Framing",
      "secondary_intent": "Critique",
      "intent_confidence": 0.87,
      "evidence": "..."
    }
  ]
}
  `.trim();
}

function segmentIntentUserPrompt(messages, chunkIdx, chunkCount) {
  const history = messages
    .map((m) => `[${m.id}] ${m.role}\n${m.text}`)
    .join("\n\n-----\n\n");
  return `
Analyze the following research chat log.
Jointly extract minimal contiguous segments and assign research intent labels.
This is chunk ${chunkIdx + 1} of ${chunkCount} from a larger conversation.
Only use the messages provided here.

Conversation:
${history}
  `.trim();
}

/******************************************************************
 * PROMPTS — STEP 2: Work Units
 ******************************************************************/
function workUnitSystemPrompt() {
  return `
You are reconstructing the latent work structure of a research chat log.

Input:
- contiguous segments
- research intent labels for each segment

Your task:
Group segments into higher-level Work Units.

Definition:
A Work Unit is a coherent research line of work pursued by the user.
A Work Unit may include NON-CONTIGUOUS segments if they contribute to the same underlying research task.

Examples of Work Units:
- defining the CU concept
- positioning against conversation trees
- designing the work-graph pipeline
- planning the user study
- writing the method section

Rules:
- Group by shared underlying research task, not by temporal adjacency.
- A segment may belong to multiple Work Units only if strongly justified.
- Use segment summaries and intent labels as evidence.
- Give each Work Unit a specific title, not a vague topic name.
- Write human-readable fields in the dominant language of the input.
- Keep JSON field names in English.
- Return STRICT JSON only.

Output schema:
{
  "work_units": [
    {
      "work_unit_id": "W1",
      "title": "...",
      "description": "...",
      "segment_ids": ["S1","S4","S9"],
      "status": "open",
      "confidence": 0.84
    }
  ]
}

Allowed status values:
- open
- tentative
- resolved
- revised
- abandoned
  `.trim();
}

/******************************************************************
 * PROMPTS — STEP 3: Graph Construction
 ******************************************************************/
function graphSystemPrompt() {
  return `
You are constructing a structured research work graph from a research chat log.

Input:
- research segments with local intents
- higher-level work units

Your tasks:
1. assign a functional role to each (work_unit_id, segment_id) pair
2. identify work-structure edges
3. identify decision/rationale/revision structure
4. summarize the current state of each work unit
5. determine whether the conversation should be split into multiple chats

Functional roles:
- problem_statement
- concept_definition
- related_work_interpretation
- method_proposal
- implementation_detail
- evaluation_proposal
- evidence_report
- critique
- comparison
- decision
- rationale
- revision
- writing_move
- next_step
- open_issue
- other

Edge types:

Segment-level:
- supports
- critiques
- compares
- proposes
- revises
- elaborates
- answers

Work-unit-level:
- depends_on
- refines
- branches_from
- resumes
- supersedes
- merges_into

Special:
- decision_for
- rationale_for
- revision_of

Rules:
- This is a RESEARCH STRUCTURE graph, not a timeline summary.
- Prefer edges that explain intellectual structure: critique, rationale, revision, decision, dependency.
- Avoid default linear chains unless strongly supported.
- Every edge must include short evidence.
- Every edge must include a strength score between 0 and 1.
- Mark whether a segment is selected if it represents a chosen option.
- For each Work Unit, identify:
  - current status
  - final_decision_segment_id if any
  - key_rationale_segment_ids
  - open_issue_segment_ids
- Do not group only by topic.
- Do not treat every segment as equally important.
- Do not infer a decision unless commitment is visible.
- Write human-readable fields in the dominant language of the input.
- Keep JSON field names and edge types in English.
- Return STRICT JSON only.

Output schema:
{
  "analysis": {
    "conversation_summary": "...",
    "main_research_goal": "...",
    "notes": ["..."]
  },
  "segments": [
    {
      "segment_id": "S1",
      "message_ids": ["m1","m2"],
      "summary": "...",
      "primary_intent": "Concept Formation",
      "secondary_intent": "Comparison",
      "intent_confidence": 0.88,
      "evidence": "..."
    }
  ],
  "work_units": [
    {
      "work_unit_id": "W1",
      "title": "...",
      "description": "...",
      "segment_ids": ["S1","S4","S9"],
      "status": "revised",
      "confidence": 0.84,
      "final_decision_segment_id": "S9",
      "key_rationale_segment_ids": ["S4"],
      "open_issue_segment_ids": ["S12"]
    }
  ],
  "segment_roles": [
    {
      "work_unit_id": "W1",
      "segment_id": "S4",
      "role": "rationale",
      "confidence": 0.90,
      "selected": false
    }
  ],
  "edges": [
    {
      "source": "S4",
      "target": "S9",
      "type": "rationale_for",
      "evidence": "...",
      "strength": 0.86
    }
  ],
  "split_decision": {
    "should_split": false,
    "confidence": 0.74,
    "reason": "...",
    "independent_work_units": [],
    "proposed_threads": []
  }
}
  `.trim();
}

/******************************************************************
 * CHUNKING + DEDUPE
 ******************************************************************/
function chunkArray(arr, size, overlap = 0) {
  const chunks = [];
  let i = 0;
  while (i < arr.length) {
    chunks.push(arr.slice(i, i + size));
    if (i + size >= arr.length) break;
    i += Math.max(1, size - overlap);
  }
  return chunks;
}

function firstMsgNum(ids) {
  if (!Array.isArray(ids) || !ids.length) return Infinity;
  const m = /^m(\d+)$/.exec(ids[0]);
  return m ? Number(m[1]) : Infinity;
}

function dedupeSegments(segments) {
  const byKey = new Map();
  for (const seg of segments) {
    const key = (seg.message_ids || []).join("|");
    if (!key) continue;
    const existing = byKey.get(key);
    if (!existing) { byKey.set(key, { ...seg }); continue; }
    const ec = existing.intent_confidence ?? 0;
    const nc = seg.intent_confidence ?? 0;
    if (nc > ec) byKey.set(key, { ...seg });
  }
  const out = Array.from(byKey.values());
  out.sort((a, b) => firstMsgNum(a.message_ids) - firstMsgNum(b.message_ids));
  out.forEach((s, i) => (s.segment_id = `S${i + 1}`));
  return out;
}

/******************************************************************
 * FULL PIPELINE
 ******************************************************************/
async function runPipeline(messages, model, onStatus) {
  // STEP 1: Chunked segment + intent extraction
  const chunks = chunkArray(messages, SEGMENT_CHUNK_SIZE, SEGMENT_CHUNK_OVERLAP);
  const allSegments = [];

  for (let i = 0; i < chunks.length; i++) {
    onStatus(`Step 1/3 — Segment+intent chunk ${i + 1}/${chunks.length}`);
    const result = await callOpenAI(
      segmentIntentSystemPrompt(),
      segmentIntentUserPrompt(chunks[i], i, chunks.length),
      model
    );
    const segs = Array.isArray(result?.segments) ? result.segments : [];
    for (const seg of segs) {
      allSegments.push({
        segment_id: seg?.segment_id || "",
        message_ids: Array.isArray(seg?.message_ids) ? seg.message_ids : [],
        summary: seg?.summary || "",
        primary_intent: seg?.primary_intent || "Other",
        secondary_intent: seg?.secondary_intent || "",
        intent_confidence: typeof seg?.intent_confidence === "number" ? seg.intent_confidence : 0.5,
        evidence: seg?.evidence || ""
      });
    }
  }

  const step1 = { segments: dedupeSegments(allSegments) };

  // STEP 2: Work unit induction
  onStatus("Step 2/3 — Work unit induction");
  const step2 = await callOpenAI(
    workUnitSystemPrompt(),
    `Induce higher-level Work Units from the following research segments.\n\nInput JSON:\n${JSON.stringify(step1)}`,
    model
  );

  // STEP 3: Graph construction
  onStatus("Step 3/3 — Graph construction");
  const step3 = await callOpenAI(
    graphSystemPrompt(),
    `Construct a research work graph from the following segments and work units.\n\nSegments JSON:\n${JSON.stringify(step1)}\n\nWork Units JSON:\n${JSON.stringify(step2)}`,
    model
  );

  return { step1, step2, step3 };
}

/******************************************************************
 * ROUTE: /analyze  (new — receives messages, runs full pipeline)
 ******************************************************************/
app.post("/analyze", async (req, res) => {
  try {
    const { messages, model } = req.body || {};

    // Support both old format (systemPrompt/userPrompt) and new format (messages)
    if (!messages && req.body?.systemPrompt) {
      // Legacy single-call mode
      return handleLegacyAnalyze(req, res);
    }

    if (!Array.isArray(messages) || messages.length === 0) {
      return res.status(400).json({ error: "messages array is required" });
    }

    console.log(`[pipeline] Starting | ${messages.length} messages | model=${model || OPENAI_MODEL}`);

    const result = await runPipeline(
      messages,
      model || OPENAI_MODEL,
      (status) => console.log(`[pipeline] ${status}`)
    );

    console.log(`[pipeline] Done | segments=${result.step1.segments.length}`);

    return res.json(result);
  } catch (err) {
    console.error("[pipeline] Failed:", err.message);
    return res.status(500).json({ error: "Pipeline failed", detail: err.message });
  }
});

async function handleLegacyAnalyze(req, res) {
  try {
    const { systemPrompt, userPrompt, model, temperature, response_format } = req.body;

    if (!systemPrompt || !userPrompt) {
      return res.status(400).json({ error: "systemPrompt and userPrompt are required" });
    }

    const payload = {
      model: model || OPENAI_MODEL,
      temperature: 0,
      seed: OPENAI_SEED,
      response_format: response_format || { type: "json_object" },
      messages: [
        { role: "system", content: systemPrompt },
        { role: "user", content: userPrompt }
      ]
    };

    const controller = new AbortController();
    const timeout = setTimeout(() => controller.abort(), 300000);

    try {
      const apiRes = await fetch("https://api.openai.com/v1/chat/completions", {
        method: "POST",
        headers: {
          "Content-Type": "application/json",
          Authorization: `Bearer ${OPENAI_API_KEY}`
        },
        body: JSON.stringify(payload),
        signal: controller.signal
      });

      const text = await apiRes.text();
      if (!apiRes.ok) return res.status(apiRes.status).type("application/json").send(text);
      return res.type("application/json").send(text);
    } finally {
      clearTimeout(timeout);
    }
  } catch (err) {
    console.error("[legacy] Failed:", err.message);
    return res.status(500).json({ error: "Proxy request failed", detail: err.message });
  }
}

/******************************************************************
 * START
 ******************************************************************/
app.listen(PORT, "127.0.0.1", () => {
  console.log(`✅ Research Work Graph proxy at http://127.0.0.1:${PORT}`);
  console.log(`   Pipeline mode: POST /analyze with { messages: [...] }`);
  console.log(`   Legacy mode:   POST /analyze with { systemPrompt, userPrompt }`);
  console.log(`   Interaction log: POST /log | GET /log/export | POST /log/clear`);
  console.log(`   Determinism:   temperature=0, seed=${OPENAI_SEED}, cache=${ENABLE_CACHE ? "ON" : "OFF"}`);
  console.log(`   Cache mgmt:    GET /cache/stats | POST /cache/clear`);
});
