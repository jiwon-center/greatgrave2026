// ==UserScript==
// @name         Research Work Graph Overlay (taxonomy-aware, compressed, via Local Proxy)
// @namespace    http://tampermonkey.net/
// @version      7.2
// @description  Overlay a research-work-graph navigator on top of ChatGPT using compressed message extraction, chunked segment+intent extraction, and non-linear work-graph induction. Now with interactive graph visualization.
// @match        https://chat.openai.com/*
// @match        https://chatgpt.com/*
// @grant        GM_xmlhttpRequest
// @connect      localhost
// @connect      127.0.0.1
// ==/UserScript==

(function () {
  'use strict';

  /******************************************************************
   * 0. CONFIG
   ******************************************************************/
  const PROXY_URL = "http://127.0.0.1:8787/analyze";
  const OPENAI_MODEL = "gpt-4o-mini";

  const PANEL_ID = "research-work-graph-overlay-panel";
  const ACTIVE_CLASS = "research-work-graph-active-item";
  const HIGHLIGHT_CLASS = "research-work-graph-message-highlight";
  const INIT_DELAY_MS = 2500;

  // Chunking now handled server-side in proxy

  const MAX_USER_MESSAGE_CHARS = 2200;

  const ASSISTANT_SHORT_THRESHOLD = 1800;
  const ASSISTANT_HEAD_CHARS = 700;
  const ASSISTANT_TAIL_CHARS = 500;
  const ASSISTANT_MAX_MIDDLE_ITEMS = 12;
  const ASSISTANT_MAX_ITEM_CHARS = 220;
  const ASSISTANT_MAX_TOTAL_CHARS = 2400;

  const PROXY_TIMEOUT_MS = 360000;
  const DEBUG = true;

  /******************************************************************
   * 1. STYLES — Light theme, ChatGPT-adjacent
   ******************************************************************/
  function injectStyles() {
    if (document.getElementById("research-work-graph-overlay-style")) return;

    const style = document.createElement("style");
    style.id = "research-work-graph-overlay-style";
    style.textContent = `
      @import url('https://fonts.googleapis.com/css2?family=IBM+Plex+Sans:wght@400;500;600;700&family=IBM+Plex+Mono:wght@400;500&display=swap');

      /* ─── Panel Shell ─── */
      #${PANEL_ID} {
        position: fixed;
        top: 0;
        right: 0;
        width: 420px;
        height: 100vh;
        background: #FAFBFC;
        color: #1a1a2e;
        z-index: 999999;
        overflow-y: auto;
        border-left: 1.5px solid #E2E6EB;
        box-sizing: border-box;
        padding: 0;
        font-family: 'IBM Plex Sans', -apple-system, BlinkMacSystemFont, sans-serif;
        box-shadow: -4px 0 20px rgba(0,0,0,0.06);
        scrollbar-width: thin;
        scrollbar-color: #C4CAD3 transparent;
      }
      #${PANEL_ID}::-webkit-scrollbar { width: 5px; }
      #${PANEL_ID}::-webkit-scrollbar-track { background: transparent; }
      #${PANEL_ID}::-webkit-scrollbar-thumb { background: #C4CAD3; border-radius: 6px; }

      #${PANEL_ID} * { box-sizing: border-box; }

      /* ─── Header ─── */
      #${PANEL_ID} .rwg-header {
        position: sticky;
        top: 0;
        z-index: 10;
        display: flex;
        align-items: center;
        justify-content: space-between;
        padding: 14px 18px 12px;
        background: #FAFBFC;
        border-bottom: 1.5px solid #E2E6EB;
      }
      #${PANEL_ID} .rwg-logo-group { display: flex; align-items: center; gap: 10px; }
      #${PANEL_ID} .rwg-logo {
        width: 28px; height: 28px;
        border-radius: 8px;
        background: linear-gradient(135deg, #2563EB 0%, #7C3AED 100%);
        display: flex; align-items: center; justify-content: center;
        flex-shrink: 0;
      }
      #${PANEL_ID} .rwg-logo svg { width: 16px; height: 16px; }
      #${PANEL_ID} .rwg-title-text {
        font-size: 14px; font-weight: 700; color: #1a1a2e;
        line-height: 1.15;
      }
      #${PANEL_ID} .rwg-subtitle-text {
        font-size: 10px; color: #8B95A5; font-weight: 500;
        letter-spacing: 0.02em; margin-top: 1px;
      }

      #${PANEL_ID} .rwg-header-actions { display: flex; gap: 4px; }
      #${PANEL_ID} .rwg-icon-btn {
        appearance: none; border: none;
        width: 30px; height: 30px; border-radius: 8px;
        background: transparent; cursor: pointer;
        display: flex; align-items: center; justify-content: center;
        color: #8B95A5; transition: all 0.15s;
      }
      #${PANEL_ID} .rwg-icon-btn:hover { background: #EDF0F4; color: #1a1a2e; }
      #${PANEL_ID} .rwg-icon-btn svg { width: 16px; height: 16px; }

      /* ─── Tabs ─── */
      #${PANEL_ID} .rwg-tabs {
        display: flex; gap: 2px;
        padding: 6px 18px;
        background: #FAFBFC;
        border-bottom: 1.5px solid #E2E6EB;
        position: sticky; top: 54px; z-index: 10;
      }
      #${PANEL_ID} .rwg-tab {
        appearance: none; border: none;
        padding: 7px 14px; border-radius: 8px;
        font-size: 12px; font-weight: 600;
        font-family: inherit;
        cursor: pointer; background: transparent;
        color: #8B95A5; transition: all 0.15s;
      }
      #${PANEL_ID} .rwg-tab:hover { background: #EDF0F4; color: #505A6B; }
      #${PANEL_ID} .rwg-tab.active {
        background: #2563EB; color: #fff;
        box-shadow: 0 1px 4px rgba(37,99,235,0.25);
      }

      /* ─── Content area ─── */
      #${PANEL_ID} .rwg-body { padding: 14px 18px 24px; }

      /* ─── Status bar ─── */
      #${PANEL_ID} .rwg-status-bar {
        display: flex; align-items: center; gap: 8px;
        padding: 10px 14px; margin-bottom: 14px;
        border-radius: 10px; font-size: 12px;
        background: #EDF0F4; color: #505A6B;
        line-height: 1.4;
      }
      #${PANEL_ID} .rwg-status-bar.error {
        background: #FEF2F2; color: #B91C1C;
        border: 1px solid #FECACA;
      }
      #${PANEL_ID} .rwg-status-bar.success {
        background: #F0FDF4; color: #166534;
        border: 1px solid #BBF7D0;
      }
      #${PANEL_ID} .rwg-status-spinner {
        width: 14px; height: 14px; border-radius: 50%;
        border: 2px solid #C4CAD3; border-top-color: #2563EB;
        animation: rwg-spin 0.7s linear infinite; flex-shrink: 0;
      }
      @keyframes rwg-spin { to { transform: rotate(360deg); } }

      /* ─── Analysis summary card ─── */
      #${PANEL_ID} .rwg-summary-card {
        padding: 14px 16px; margin-bottom: 16px;
        border-radius: 12px;
        background: #fff;
        border: 1.5px solid #E2E6EB;
      }
      #${PANEL_ID} .rwg-summary-label {
        font-size: 10px; font-weight: 700;
        color: #2563EB; text-transform: uppercase;
        letter-spacing: 0.06em; margin-bottom: 6px;
      }
      #${PANEL_ID} .rwg-summary-text {
        font-size: 13px; line-height: 1.55; color: #374151;
      }

      /* ─── Split alert ─── */
      #${PANEL_ID} .rwg-alert-card {
        padding: 12px 14px; margin-bottom: 16px;
        border-radius: 12px;
        background: #FFFBEB; border: 1.5px solid #FDE68A;
      }
      #${PANEL_ID} .rwg-alert-title {
        font-size: 12px; font-weight: 700; color: #92400E;
        display: flex; align-items: center; gap: 6px;
        margin-bottom: 6px;
      }
      #${PANEL_ID} .rwg-alert-text { font-size: 12px; color: #78350F; line-height: 1.5; }

      /* ─── Work Unit card ─── */
      #${PANEL_ID} .rwg-wu-card {
        margin-bottom: 12px;
        border-radius: 12px;
        background: #fff;
        border: 1.5px solid #E2E6EB;
        overflow: hidden;
        transition: border-color 0.2s;
      }
      #${PANEL_ID} .rwg-wu-card:hover { border-color: #C4CAD3; }

      #${PANEL_ID} .rwg-wu-header {
        padding: 12px 14px;
        cursor: pointer;
        display: flex; align-items: flex-start; gap: 10px;
        user-select: none;
      }
      #${PANEL_ID} .rwg-wu-chevron {
        flex-shrink: 0; width: 18px; height: 18px;
        color: #8B95A5; transition: transform 0.2s;
        margin-top: 1px;
      }
      #${PANEL_ID} .rwg-wu-card.collapsed .rwg-wu-chevron { transform: rotate(-90deg); }
      #${PANEL_ID} .rwg-wu-card.collapsed .rwg-wu-body { display: none; }

      #${PANEL_ID} .rwg-wu-title-line {
        font-size: 13px; font-weight: 700; color: #1a1a2e;
        line-height: 1.35;
      }
      #${PANEL_ID} .rwg-wu-desc {
        font-size: 11.5px; color: #6B7280; line-height: 1.45;
        margin-top: 3px;
      }
      #${PANEL_ID} .rwg-wu-badges {
        display: flex; flex-wrap: wrap; gap: 4px;
        margin-top: 6px;
      }
      #${PANEL_ID} .rwg-badge {
        font-size: 10px; font-weight: 600;
        padding: 2px 8px; border-radius: 6px;
        font-family: 'IBM Plex Mono', monospace;
        letter-spacing: 0.01em;
      }
      #${PANEL_ID} .rwg-badge-status { background: #EDF0F4; color: #505A6B; }
      #${PANEL_ID} .rwg-badge-status[data-status="resolved"] { background: #D1FAE5; color: #065F46; }
      #${PANEL_ID} .rwg-badge-status[data-status="revised"] { background: #DBEAFE; color: #1E40AF; }
      #${PANEL_ID} .rwg-badge-status[data-status="abandoned"] { background: #FEE2E2; color: #991B1B; }
      #${PANEL_ID} .rwg-badge-status[data-status="tentative"] { background: #FEF3C7; color: #92400E; }
      #${PANEL_ID} .rwg-badge-count { background: #F3F4F6; color: #6B7280; }

      /* ─── Segment item ─── */
      #${PANEL_ID} .rwg-wu-body { padding: 0 14px 10px; }

      #${PANEL_ID} .rwg-seg-item {
        padding: 10px 12px; margin-top: 6px;
        border-radius: 10px; cursor: pointer;
        background: #F7F8FA;
        border: 1.5px solid transparent;
        transition: all 0.15s;
      }
      #${PANEL_ID} .rwg-seg-item:hover {
        background: #EEF2FF;
        border-color: #C7D2FE;
        transform: translateY(-1px);
        box-shadow: 0 2px 6px rgba(37,99,235,0.06);
      }
      #${PANEL_ID} .rwg-seg-item.${ACTIVE_CLASS} {
        background: #EEF2FF;
        border-color: #818CF8;
        box-shadow: 0 0 0 2px rgba(129,140,248,0.15);
      }

      #${PANEL_ID} .rwg-seg-top {
        display: flex; align-items: center; gap: 6px;
      }
      #${PANEL_ID} .rwg-seg-id {
        font-size: 10px; font-weight: 700;
        font-family: 'IBM Plex Mono', monospace;
        color: #6366F1; background: #EEF2FF;
        padding: 1px 6px; border-radius: 4px;
      }
      #${PANEL_ID} .rwg-seg-intent {
        font-size: 10px; font-weight: 600;
        color: #fff; padding: 1px 7px; border-radius: 4px;
      }
      #${PANEL_ID} .rwg-seg-summary {
        font-size: 12px; color: #374151; line-height: 1.5;
        margin-top: 5px;
      }
      #${PANEL_ID} .rwg-seg-meta {
        font-size: 10px; color: #9CA3AF; margin-top: 5px;
        font-family: 'IBM Plex Mono', monospace;
        line-height: 1.5;
      }
      #${PANEL_ID} .rwg-seg-edges {
        margin-top: 6px; display: flex; flex-wrap: wrap; gap: 4px;
      }
      #${PANEL_ID} .rwg-edge-chip {
        font-size: 10px; font-weight: 500;
        padding: 2px 8px; border-radius: 6px;
        background: #F3F4F6; color: #6B7280;
        display: flex; align-items: center; gap: 3px;
        font-family: 'IBM Plex Mono', monospace;
      }
      #${PANEL_ID} .rwg-edge-chip .arrow { color: #2563EB; font-weight: 700; }

      /* ─── Graph View ─── */
      #${PANEL_ID} .rwg-graph-container {
        width: 100%; min-height: 500px;
        background: #fff; border-radius: 12px;
        border: 1.5px solid #E2E6EB;
        overflow: hidden; position: relative;
      }
      #${PANEL_ID} .rwg-graph-svg { width: 100%; display: block; }

      #${PANEL_ID} .rwg-graph-legend {
        display: flex; flex-wrap: wrap; gap: 8px;
        padding: 10px 14px;
        border-top: 1px solid #E2E6EB;
        background: #F7F8FA;
      }
      #${PANEL_ID} .rwg-legend-item {
        display: flex; align-items: center; gap: 4px;
        font-size: 10px; color: #6B7280; font-weight: 500;
      }
      #${PANEL_ID} .rwg-legend-line {
        width: 20px; height: 2px; border-radius: 1px;
      }

      #${PANEL_ID} .rwg-graph-tooltip {
        position: absolute; padding: 8px 12px;
        background: #1a1a2e; color: #fff;
        border-radius: 8px; font-size: 11px;
        max-width: 220px; pointer-events: none;
        opacity: 0; transition: opacity 0.15s;
        z-index: 20; line-height: 1.45;
        box-shadow: 0 4px 12px rgba(0,0,0,0.2);
      }
      #${PANEL_ID} .rwg-graph-tooltip.visible { opacity: 1; }

      /* ─── Empty state ─── */
      #${PANEL_ID} .rwg-empty {
        text-align: center; padding: 32px 16px;
        color: #9CA3AF; font-size: 13px;
      }

      /* ─── Message highlight ─── */
      .${HIGHLIGHT_CLASS} {
        outline: 2.5px solid rgba(99,102,241,0.55) !important;
        outline-offset: 6px !important;
        border-radius: 10px !important;
        transition: outline-color 0.4s ease;
      }

      /* ─── Intent colors ─── */
      .rwg-intent-problem { background: #DC2626; }
      .rwg-intent-concept { background: #7C3AED; }
      .rwg-intent-related { background: #0891B2; }
      .rwg-intent-method { background: #2563EB; }
      .rwg-intent-implementation { background: #4F46E5; }
      .rwg-intent-evaluation { background: #059669; }
      .rwg-intent-evidence { background: #0D9488; }
      .rwg-intent-critique { background: #E11D48; }
      .rwg-intent-comparison { background: #D97706; }
      .rwg-intent-decision { background: #16A34A; }
      .rwg-intent-revision { background: #9333EA; }
      .rwg-intent-writing { background: #6366F1; }
      .rwg-intent-nextstep { background: #0284C7; }
      .rwg-intent-other { background: #6B7280; }

      /* ─── Edge type colors ─── */
      .rwg-etype-supports { stroke: #22C55E; }
      .rwg-etype-critiques { stroke: #EF4444; }
      .rwg-etype-compares { stroke: #F59E0B; }
      .rwg-etype-proposes { stroke: #3B82F6; }
      .rwg-etype-revises { stroke: #A855F7; }
      .rwg-etype-elaborates { stroke: #06B6D4; }
      .rwg-etype-answers { stroke: #64748B; }
      .rwg-etype-depends_on { stroke: #6366F1; }
      .rwg-etype-refines { stroke: #8B5CF6; }
      .rwg-etype-branches_from { stroke: #EC4899; }
      .rwg-etype-resumes { stroke: #14B8A6; }
      .rwg-etype-supersedes { stroke: #F97316; }
      .rwg-etype-merges_into { stroke: #0EA5E9; }
      .rwg-etype-decision_for { stroke: #16A34A; }
      .rwg-etype-rationale_for { stroke: #2563EB; }
      .rwg-etype-revision_of { stroke: #9333EA; }
    `;
    document.head.appendChild(style);
  }

  /******************************************************************
   * 1b. INTENT → CSS CLASS MAPPING
   ******************************************************************/
  const INTENT_CLASS_MAP = {
    "Problem Framing": "rwg-intent-problem",
    "Concept Formation": "rwg-intent-concept",
    "Related Work Positioning": "rwg-intent-related",
    "Method Design": "rwg-intent-method",
    "Implementation Planning": "rwg-intent-implementation",
    "Evaluation Design": "rwg-intent-evaluation",
    "Evidence Gathering": "rwg-intent-evidence",
    "Critique": "rwg-intent-critique",
    "Comparison": "rwg-intent-comparison",
    "Decision Making": "rwg-intent-decision",
    "Revision": "rwg-intent-revision",
    "Writing / Formalization": "rwg-intent-writing",
    "Next-step Planning": "rwg-intent-nextstep",
    "Other": "rwg-intent-other"
  };

  function intentClass(intent) {
    return INTENT_CLASS_MAP[intent] || "rwg-intent-other";
  }

  const EDGE_COLOR_MAP = {
    supports: "#22C55E",
    critiques: "#EF4444",
    compares: "#F59E0B",
    proposes: "#3B82F6",
    revises: "#A855F7",
    elaborates: "#06B6D4",
    answers: "#64748B",
    depends_on: "#6366F1",
    refines: "#8B5CF6",
    branches_from: "#EC4899",
    resumes: "#14B8A6",
    supersedes: "#F97316",
    merges_into: "#0EA5E9",
    decision_for: "#16A34A",
    rationale_for: "#2563EB",
    revision_of: "#9333EA"
  };

  function edgeColor(type) {
    return EDGE_COLOR_MAP[type] || "#9CA3AF";
  }

  const INTENT_COLOR_MAP = {
    "Problem Framing": "#DC2626",
    "Concept Formation": "#7C3AED",
    "Related Work Positioning": "#0891B2",
    "Method Design": "#2563EB",
    "Implementation Planning": "#4F46E5",
    "Evaluation Design": "#059669",
    "Evidence Gathering": "#0D9488",
    "Critique": "#E11D48",
    "Comparison": "#D97706",
    "Decision Making": "#16A34A",
    "Revision": "#9333EA",
    "Writing / Formalization": "#6366F1",
    "Next-step Planning": "#0284C7",
    "Other": "#6B7280"
  };

  function intentColorHex(intent) {
    return INTENT_COLOR_MAP[intent] || "#6B7280";
  }

  /******************************************************************
   * 2. MESSAGE EXTRACTION (unchanged logic)
   ******************************************************************/
  function getMessages() {
    const nodes = Array.from(document.querySelectorAll('[data-message-author-role]'));
    const messages = [];
    let i = 1;
    for (const node of nodes) {
      const role = node.getAttribute('data-message-author-role') || 'unknown';
      let text = "";
      if (role === "assistant") {
        text = compressAssistantMessage(node);
      } else {
        text = cleanText(node.innerText || '');
        text = truncateText(text, MAX_USER_MESSAGE_CHARS);
      }
      if (!text) continue;
      messages.push({ id: `m${i}`, role, text, element: node });
      i += 1;
    }
    return messages;
  }

  function compressAssistantMessage(node) {
    const fullText = cleanText(node.innerText || "");
    if (!fullText) return "";
    if (fullText.length <= ASSISTANT_SHORT_THRESHOLD) return fullText;
    const head = cleanText(fullText.slice(0, ASSISTANT_HEAD_CHARS));
    const tail = cleanText(fullText.slice(-ASSISTANT_TAIL_CHARS));
    let middleItems = extractStructuralKeyPoints(node);
    middleItems = dedupeLines(middleItems)
      .filter(line => line && line.length >= 6)
      .slice(0, ASSISTANT_MAX_MIDDLE_ITEMS)
      .map(line => truncateText(line, ASSISTANT_MAX_ITEM_CHARS));
    if (middleItems.length < 3) {
      const fallbackItems = extractParagraphLeadSentences(node, 5).map(line => `[lead] ${line}`);
      middleItems = dedupeLines(middleItems.concat(fallbackItems))
        .filter(line => line && line.length >= 6)
        .slice(0, ASSISTANT_MAX_MIDDLE_ITEMS)
        .map(line => truncateText(line, ASSISTANT_MAX_ITEM_CHARS));
    }
    let compressed = `[HEAD]\n${head}`;
    if (middleItems.length) compressed += `\n\n[MIDDLE KEY POINTS]\n- ${middleItems.join("\n- ")}`;
    compressed += `\n\n[TAIL]\n${tail}`;
    compressed = cleanText(compressed);
    return truncateText(compressed, ASSISTANT_MAX_TOTAL_CHARS);
  }

  function extractStructuralKeyPoints(root) {
    const results = [];
    const push = (prefix, text) => { const t = cleanText(text || ""); if (t) results.push(`${prefix} ${t}`); };
    root.querySelectorAll("h1, h2, h3, h4, h5, h6").forEach(el => push("[heading]", el.innerText));
    root.querySelectorAll("strong, b").forEach(el => push("[bold]", el.innerText));
    root.querySelectorAll("li").forEach(el => push("[list]", el.innerText));
    root.querySelectorAll("pre, code").forEach(el => {
      const prev = findPreviousMeaningfulTextElement(el, root);
      if (prev) push("[before_code]", prev.innerText);
    });
    return results;
  }

  function extractParagraphLeadSentences(root, maxCount = 5) {
    const out = [];
    const blocks = root.querySelectorAll("p, div, li");
    for (const el of blocks) {
      const text = cleanText(el.innerText || "");
      if (!text || text.length < 30 || looksLikeCodeBlockText(text)) continue;
      const sentence = extractFirstSentence(text);
      if (sentence) out.push(sentence);
      if (out.length >= maxCount) break;
    }
    return out;
  }

  function findPreviousMeaningfulTextElement(startEl, boundaryRoot) {
    let el = startEl.previousElementSibling;
    while (el) { const text = cleanText(el.innerText || ""); if (text && !looksLikeCodeBlockText(text)) return el; el = el.previousElementSibling; }
    let parent = startEl.parentElement;
    while (parent && parent !== boundaryRoot) {
      let sibling = parent.previousElementSibling;
      while (sibling) { const text = cleanText(sibling.innerText || ""); if (text && !looksLikeCodeBlockText(text)) return sibling; sibling = sibling.previousElementSibling; }
      parent = parent.parentElement;
    }
    return null;
  }

  function looksLikeCodeBlockText(text) {
    if (!text) return false;
    const lineCount = text.split("\n").length;
    const symbolHits = (text.match(/[{}()[\];=<>\-_/$]/g) || []).length;
    return lineCount >= 4 && symbolHits >= 10;
  }

  function extractFirstSentence(text) {
    if (!text) return "";
    const normalized = cleanText(text);
    const match = normalized.match(/^(.{20,220}?[.!?]|.{20,220}?다[.]?)/);
    if (match) return cleanText(match[1]);
    return cleanText(normalized.slice(0, 140));
  }

  function cleanText(text) {
    return String(text || "").replace(/\u00A0/g, " ").replace(/\n{3,}/g, "\n\n").replace(/[ \t]+\n/g, "\n").replace(/\n[ \t]+/g, "\n").replace(/[ \t]{2,}/g, " ").trim();
  }

  function truncateText(text, maxChars) {
    if (!text || text.length <= maxChars) return text;
    return text.slice(0, maxChars) + "\n...[truncated]";
  }

  function dedupeLines(lines) {
    const seen = new Set();
    const out = [];
    for (const raw of lines || []) {
      const line = cleanText(raw);
      if (!line) continue;
      const key = line.toLowerCase();
      if (seen.has(key)) continue;
      seen.add(key);
      out.push(line);
    }
    return out;
  }

  /******************************************************************
   * 3–8. PROXY CALL + PIPELINE
   *
   * All prompt construction, chunking, and 3-step OpenAI calls
   * now happen SERVER-SIDE in the proxy.
   * The userscript only sends compressed messages (lightweight).
   ******************************************************************/
  function runPipeline(messages) {
    return new Promise((resolve, reject) => {
      // Send only id/role/text — strip DOM element references
      const lightweight = messages.map(m => ({ id: m.id, role: m.role, text: m.text }));
      const payloadStr = JSON.stringify({ messages: lightweight, model: OPENAI_MODEL });

      if (DEBUG) {
        console.log("[RWG] sending to proxy:", PROXY_URL);
        console.log("[RWG] payload bytes:", payloadStr.length);
        console.log("[RWG] message count:", lightweight.length);
      }

      setStatus(`Sending ${lightweight.length} messages to proxy for analysis...`);

      GM_xmlhttpRequest({
        method: "POST",
        url: PROXY_URL,
        headers: { "Content-Type": "application/json" },
        data: payloadStr,
        timeout: PROXY_TIMEOUT_MS,

        onprogress: function (evt) {
          if (DEBUG && evt.loaded) {
            console.log("[RWG] onprogress — received bytes:", evt.loaded);
          }
        },

        onload: function (response) {
          if (DEBUG) {
            console.log("[RWG] onload status:", response.status);
            console.log("[RWG] response bytes:", String(response.responseText || "").length);
          }
          try {
            if (response.status !== 200) {
              reject(`Proxy error (${response.status})\n${String(response.responseText || "").slice(0, 2000)}`);
              return;
            }
            const result = JSON.parse(response.responseText);
            resolve(result);
          } catch (e) {
            reject(`JSON parse error: ${e.message}\nRaw: ${String(response.responseText || "").slice(0, 1500)}`);
          }
        },

        ontimeout: function () {
          reject(`Request timed out (${PROXY_TIMEOUT_MS / 1000}s). Try a shorter conversation or increase timeout.`);
        },

        onerror: function (err) {
          console.error("[RWG] network error detail:", err);
          reject("Network error. Check local proxy at 127.0.0.1:8787.");
        }
      });
    });
  }

  /******************************************************************
   * 9. NORMALIZATION (unchanged)
   ******************************************************************/
  function normalizePipelineResult(result) {
    const graph = result?.step3 && typeof result.step3 === "object" ? result.step3 : {};
    const baseSegments = Array.isArray(result?.step1?.segments) ? result.step1.segments : [];
    if (!graph.analysis || typeof graph.analysis !== "object") graph.analysis = {};
    if (!Array.isArray(graph.analysis.notes)) graph.analysis.notes = [];
    if (!Array.isArray(graph.segments)) graph.segments = [];
    if (!Array.isArray(graph.work_units)) graph.work_units = [];
    if (!Array.isArray(graph.segment_roles)) graph.segment_roles = [];
    if (!Array.isArray(graph.edges)) graph.edges = [];
    graph.analysis.conversation_summary = graph.analysis.conversation_summary || "";
    graph.analysis.main_research_goal = graph.analysis.main_research_goal || "";
    const graphSegmentMap = new Map(graph.segments.map(seg => [seg.segment_id, seg]));
    graph.segments = baseSegments.map((seg, i) => {
      const merged = graphSegmentMap.get(seg.segment_id) || {};
      return {
        segment_id: seg?.segment_id || merged?.segment_id || `S${i + 1}`,
        message_ids: Array.isArray(seg?.message_ids) ? seg.message_ids : [],
        summary: seg?.summary || merged?.summary || "",
        primary_intent: seg?.primary_intent || merged?.primary_intent || "Other",
        secondary_intent: seg?.secondary_intent || merged?.secondary_intent || "",
        intent_confidence: typeof seg?.intent_confidence === "number" ? seg.intent_confidence : (typeof merged?.intent_confidence === "number" ? merged.intent_confidence : 0.5),
        evidence: seg?.evidence || merged?.evidence || ""
      };
    });
    graph.work_units = graph.work_units.map((wu, i) => ({
      work_unit_id: wu?.work_unit_id || `W${i + 1}`, title: wu?.title || `Work Unit ${i + 1}`,
      description: wu?.description || "", segment_ids: Array.isArray(wu?.segment_ids) ? wu.segment_ids : [],
      status: wu?.status || "open", confidence: typeof wu?.confidence === "number" ? wu.confidence : 0.5,
      final_decision_segment_id: wu?.final_decision_segment_id || "",
      key_rationale_segment_ids: Array.isArray(wu?.key_rationale_segment_ids) ? wu.key_rationale_segment_ids : [],
      open_issue_segment_ids: Array.isArray(wu?.open_issue_segment_ids) ? wu.open_issue_segment_ids : []
    }));
    graph.segment_roles = graph.segment_roles.map(role => ({
      work_unit_id: role?.work_unit_id || "", segment_id: role?.segment_id || "",
      role: role?.role || "other", confidence: typeof role?.confidence === "number" ? role.confidence : 0.5,
      selected: Boolean(role?.selected)
    }));
    graph.edges = graph.edges.map(edge => ({
      source: edge?.source || "", target: edge?.target || "",
      type: edge?.type || "supports", evidence: edge?.evidence || "",
      strength: typeof edge?.strength === "number" ? edge.strength : 0.5
    }));
    const split = graph?.split_decision && typeof graph.split_decision === "object" ? graph.split_decision : {};
    graph.split_decision = {
      should_split: Boolean(split?.should_split), confidence: typeof split?.confidence === "number" ? split.confidence : 0,
      reason: split?.reason || "", independent_work_units: Array.isArray(split?.independent_work_units) ? split.independent_work_units : [],
      proposed_threads: Array.isArray(split?.proposed_threads)
        ? split.proposed_threads.map((thread, i) => ({ thread_id: thread?.thread_id || `T${i + 1}`, title: thread?.title || `Thread ${i + 1}`, work_unit_ids: Array.isArray(thread?.work_unit_ids) ? thread.work_unit_ids : [] }))
        : []
    };
    return graph;
  }

  /******************************************************************
   * 10. UI — PANEL SHELL
   ******************************************************************/
  let currentTab = "list"; // "list" | "graph"

  function createPanelShell() {
    removeExistingPanel();
    const panel = document.createElement("div");
    panel.id = PANEL_ID;
    panel.innerHTML = `
      <div class="rwg-header">
        <div class="rwg-logo-group">
          <div class="rwg-logo">
            <svg viewBox="0 0 24 24" fill="none" stroke="#fff" stroke-width="2.2" stroke-linecap="round" stroke-linejoin="round">
              <circle cx="6" cy="6" r="2.5"/><circle cx="18" cy="6" r="2.5"/><circle cx="12" cy="18" r="2.5"/>
              <line x1="8" y1="7.2" x2="10.5" y2="16.2"/><line x1="16" y1="7.2" x2="13.5" y2="16.2"/>
              <line x1="8.2" y1="5.5" x2="15.8" y2="5.5"/>
            </svg>
          </div>
          <div>
            <div class="rwg-title-text">Research Work Graph</div>
            <div class="rwg-subtitle-text">segment → intent → work unit → graph</div>
          </div>
        </div>
        <div class="rwg-header-actions">
          <button class="rwg-icon-btn" id="rwg-refresh-btn" title="Re-run analysis">
            <svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round">
              <polyline points="23 4 23 10 17 10"/><path d="M20.49 15a9 9 0 1 1-2.12-9.36L23 10"/>
            </svg>
          </button>
          <button class="rwg-icon-btn" id="rwg-close-btn" title="Close panel">
            <svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round">
              <line x1="18" y1="6" x2="6" y2="18"/><line x1="6" y1="6" x2="18" y2="18"/>
            </svg>
          </button>
        </div>
      </div>

      <div class="rwg-tabs">
        <button class="rwg-tab active" data-tab="list">List</button>
        <button class="rwg-tab" data-tab="graph">Graph</button>
      </div>

      <div class="rwg-body">
        <div id="rwg-status-bar" class="rwg-status-bar">
          <div class="rwg-status-spinner"></div>
          <span>Analyzing research work structure...</span>
        </div>
        <div id="rwg-analysis-container"></div>
        <div id="rwg-content-list"></div>
        <div id="rwg-content-graph" style="display:none;"></div>
      </div>
    `;
    document.body.appendChild(panel);

    panel.querySelector("#rwg-refresh-btn").addEventListener("click", () => runAnalysis(true));
    panel.querySelector("#rwg-close-btn").addEventListener("click", () => { panel.style.display = "none"; });

    panel.querySelectorAll(".rwg-tab").forEach(tab => {
      tab.addEventListener("click", () => {
        panel.querySelectorAll(".rwg-tab").forEach(t => t.classList.remove("active"));
        tab.classList.add("active");
        currentTab = tab.dataset.tab;
        document.getElementById("rwg-content-list").style.display = currentTab === "list" ? "" : "none";
        document.getElementById("rwg-content-graph").style.display = currentTab === "graph" ? "" : "none";
      });
    });

    return panel;
  }

  function removeExistingPanel() {
    const existing = document.getElementById(PANEL_ID);
    if (existing) existing.remove();
  }

  function setStatus(message, isError = false, isDone = false) {
    const bar = document.getElementById("rwg-status-bar");
    if (!bar) return;
    bar.className = `rwg-status-bar${isError ? " error" : ""}${isDone ? " success" : ""}`;
    if (isError || isDone) {
      bar.innerHTML = `<span>${escapeHtml(message)}</span>`;
    } else {
      bar.innerHTML = `<div class="rwg-status-spinner"></div><span>${escapeHtml(message)}</span>`;
    }
  }

  /******************************************************************
   * 10b. UI — LIST VIEW RENDERING
   ******************************************************************/
  function renderSplitSuggestion(graph) {
    const container = document.getElementById("rwg-analysis-container");
    if (!container) return;
    const split = graph.split_decision || {};
    if (!split.should_split) return;

    const threadHtml = split.proposed_threads.length
      ? split.proposed_threads.map(t => `${escapeHtml(t.title)} (${escapeHtml((t.work_unit_ids || []).join(", "))})`).join("<br>")
      : "";

    const div = document.createElement("div");
    div.className = "rwg-alert-card";
    div.innerHTML = `
      <div class="rwg-alert-title">
        <svg width="14" height="14" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round"><path d="M10.29 3.86L1.82 18a2 2 0 0 0 1.71 3h16.94a2 2 0 0 0 1.71-3L13.71 3.86a2 2 0 0 0-3.42 0z"/><line x1="12" y1="9" x2="12" y2="13"/><line x1="12" y1="17" x2="12.01" y2="17"/></svg>
        New chat suggested
      </div>
      <div class="rwg-alert-text">${escapeHtml(split.reason || "This conversation contains multiple independent work units.")}</div>
      ${threadHtml ? `<div style="margin-top:6px;" class="rwg-alert-text">${threadHtml}</div>` : ""}
    `;
    container.appendChild(div);
  }

  function renderAnalysisBlock(graph) {
    const container = document.getElementById("rwg-analysis-container");
    if (!container) return;

    if (graph.analysis.main_research_goal || graph.analysis.conversation_summary) {
      const div = document.createElement("div");
      div.className = "rwg-summary-card";
      div.innerHTML = `
        ${graph.analysis.main_research_goal ? `<div class="rwg-summary-label">Research Goal</div><div class="rwg-summary-text">${escapeHtml(graph.analysis.main_research_goal)}</div>` : ""}
        ${graph.analysis.conversation_summary ? `<div class="rwg-summary-label" style="margin-top:10px;">Summary</div><div class="rwg-summary-text">${escapeHtml(graph.analysis.conversation_summary)}</div>` : ""}
      `;
      container.appendChild(div);
    }
  }

  function renderWorkUnits(graph, messages) {
    const content = document.getElementById("rwg-content-list");
    if (!content) return;
    content.innerHTML = "";

    if (!graph.work_units.length) {
      content.innerHTML = `<div class="rwg-empty">No Work Units were returned.</div>`;
      return;
    }

    const segmentMap = new Map(graph.segments.map(s => [s.segment_id, s]));
    const rolesByKey = new Map();
    for (const role of graph.segment_roles) rolesByKey.set(`${role.work_unit_id}::${role.segment_id}`, role);
    const outgoingEdgesBySource = new Map();
    for (const edge of graph.edges) {
      if (!outgoingEdgesBySource.has(edge.source)) outgoingEdgesBySource.set(edge.source, []);
      outgoingEdgesBySource.get(edge.source).push(edge);
    }

    for (const wu of graph.work_units) {
      const card = document.createElement("div");
      card.className = "rwg-wu-card";

      // Header
      const header = document.createElement("div");
      header.className = "rwg-wu-header";
      header.innerHTML = `
        <svg class="rwg-wu-chevron" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2.5" stroke-linecap="round" stroke-linejoin="round"><polyline points="6 9 12 15 18 9"/></svg>
        <div style="flex:1;min-width:0;">
          <div class="rwg-wu-title-line">${escapeHtml(wu.title)}</div>
          ${wu.description ? `<div class="rwg-wu-desc">${escapeHtml(wu.description)}</div>` : ""}
          <div class="rwg-wu-badges">
            <span class="rwg-badge rwg-badge-status" data-status="${wu.status}">${wu.status}</span>
            <span class="rwg-badge rwg-badge-count">${wu.segment_ids.length} segments</span>
            ${wu.final_decision_segment_id ? `<span class="rwg-badge" style="background:#D1FAE5;color:#065F46;">decision: ${wu.final_decision_segment_id}</span>` : ""}
            ${wu.open_issue_segment_ids.length ? `<span class="rwg-badge" style="background:#FEF3C7;color:#92400E;">${wu.open_issue_segment_ids.length} open issue(s)</span>` : ""}
          </div>
        </div>
      `;
      header.addEventListener("click", () => card.classList.toggle("collapsed"));
      card.appendChild(header);

      // Body (segments)
      const body = document.createElement("div");
      body.className = "rwg-wu-body";

      for (const segmentId of wu.segment_ids) {
        const seg = segmentMap.get(segmentId);
        if (!seg) continue;
        const role = rolesByKey.get(`${wu.work_unit_id}::${segmentId}`);
        const outgoing = outgoingEdgesBySource.get(segmentId) || [];

        const item = document.createElement("div");
        item.className = "rwg-seg-item";
        item.dataset.segmentId = segmentId;
        item.dataset.messageIds = JSON.stringify(seg.message_ids || []);

        const metaParts = [];
        if (role?.role) metaParts.push(`role: ${role.role}`);
        if (role?.selected) metaParts.push("✓ selected");
        if (typeof seg.intent_confidence === "number") metaParts.push(`conf: ${seg.intent_confidence.toFixed(2)}`);

        item.innerHTML = `
          <div class="rwg-seg-top">
            <span class="rwg-seg-id">${escapeHtml(segmentId)}</span>
            <span class="rwg-seg-intent ${intentClass(seg.primary_intent)}">${escapeHtml(seg.primary_intent)}</span>
            ${seg.secondary_intent ? `<span class="rwg-seg-intent ${intentClass(seg.secondary_intent)}" style="opacity:0.7;">${escapeHtml(seg.secondary_intent)}</span>` : ""}
          </div>
          ${seg.summary ? `<div class="rwg-seg-summary">${escapeHtml(seg.summary)}</div>` : ""}
          ${metaParts.length ? `<div class="rwg-seg-meta">${escapeHtml(metaParts.join(" · "))}</div>` : ""}
          ${outgoing.length ? `<div class="rwg-seg-edges">${outgoing.map(e =>
            `<span class="rwg-edge-chip"><span class="arrow">→</span> ${escapeHtml(e.type)} ${escapeHtml(e.target)}</span>`
          ).join("")}</div>` : ""}
        `;

        item.addEventListener("click", () => {
          scrollToSegment(seg, messages);
          setActiveSegment(segmentId);
        });

        body.appendChild(item);
      }

      card.appendChild(body);
      content.appendChild(card);
    }
  }

  /******************************************************************
   * 10c. UI — GRAPH VIEW (Sugiyama hierarchical + WU clusters + crossing minimization)
   ******************************************************************/
  function renderGraphView(graph, messages) {
    const container = document.getElementById("rwg-content-graph");
    if (!container) return;
    container.innerHTML = "";

    const segments = graph.segments || [];
    const edges = graph.edges || [];
    const workUnits = graph.work_units || [];

    if (!segments.length) {
      container.innerHTML = `<div class="rwg-empty">No segments to visualize.</div>`;
      return;
    }

    const W = 384;
    const nodeR = 16;
    const layerGap = 82;
    const nodeGap = 52;
    const padTop = 38;
    const padLeft = 24;
    const clusterPadX = 14;
    const clusterPadY = 14;
    const clusterLabelH = 14;

    // ── WU color assignment ──
    const wuColorPalette = [
      "#2563EB", "#7C3AED", "#059669", "#DC2626", "#D97706",
      "#0891B2", "#EC4899", "#6366F1", "#14B8A6", "#F97316"
    ];
    const segWuMap = new Map();
    const segWuColor = new Map();
    const wuColors = new Map();
    workUnits.forEach((wu, wi) => {
      const color = wuColorPalette[wi % wuColorPalette.length];
      wuColors.set(wu.work_unit_id, color);
      wu.segment_ids.forEach(sid => {
        if (!segWuMap.has(sid)) segWuMap.set(sid, wu.work_unit_id);
        if (!segWuColor.has(sid)) segWuColor.set(sid, color);
      });
    });

    // ── Sugiyama Step 1: Build adjacency & layer assignment via longest-path ──
    const segSet = new Set(segments.map(s => s.segment_id));
    const adj = new Map();
    const revAdj = new Map();   // reverse adjacency for barycenter
    const inDeg = new Map();

    for (const s of segments) {
      adj.set(s.segment_id, []);
      revAdj.set(s.segment_id, []);
      inDeg.set(s.segment_id, 0);
    }
    for (const e of edges) {
      if (!segSet.has(e.source) || !segSet.has(e.target)) continue;
      if (e.source === e.target) continue; // skip self-loops
      adj.get(e.source).push(e.target);
      revAdj.get(e.target).push(e.source);
      inDeg.set(e.target, (inDeg.get(e.target) || 0) + 1);
    }

    // Kahn's topological sort with stable tie-breaking
    const topoOrder = [];
    const queue = [];
    const tempInDeg = new Map(inDeg);
    for (const [id, deg] of tempInDeg) { if (deg === 0) queue.push(id); }
    queue.sort((a, b) => segNum(a) - segNum(b));

    while (queue.length) {
      const node = queue.shift();
      topoOrder.push(node);
      for (const next of (adj.get(node) || [])) {
        tempInDeg.set(next, tempInDeg.get(next) - 1);
        if (tempInDeg.get(next) === 0) queue.push(next);
      }
      queue.sort((a, b) => segNum(a) - segNum(b));
    }
    // Append cycle nodes
    for (const s of segments) {
      if (!topoOrder.includes(s.segment_id)) topoOrder.push(s.segment_id);
    }

    // Longest-path layer assignment
    const layerOf = new Map();
    for (const id of topoOrder) {
      let maxParentLayer = -1;
      for (const parent of (revAdj.get(id) || [])) {
        if (layerOf.has(parent)) {
          maxParentLayer = Math.max(maxParentLayer, layerOf.get(parent));
        }
      }
      layerOf.set(id, maxParentLayer + 1);
    }

    // ── Sugiyama Step 2: Group by layer ──
    const layers = new Map();
    for (const [id, layer] of layerOf) {
      if (!layers.has(layer)) layers.set(layer, []);
      layers.get(layer).push(id);
    }
    const numLayers = layers.size ? Math.max(...layers.keys()) + 1 : 1;

    // Initial ordering: group by WU within each layer
    for (const [, ids] of layers) {
      ids.sort((a, b) => {
        const wuA = segWuMap.get(a) || "zzz";
        const wuB = segWuMap.get(b) || "zzz";
        if (wuA !== wuB) return wuA < wuB ? -1 : 1;
        return segNum(a) - segNum(b);
      });
    }

    // ── Sugiyama Step 3: Barycenter crossing minimization ──
    // Multiple passes: alternating top-down and bottom-up
    const BARY_PASSES = 6;

    function positionInLayer(id) {
      const layer = layerOf.get(id);
      const ids = layers.get(layer) || [];
      return ids.indexOf(id);
    }

    for (let pass = 0; pass < BARY_PASSES; pass++) {
      const topDown = pass % 2 === 0;
      const layerIndices = topDown
        ? Array.from({ length: numLayers }, (_, i) => i)
        : Array.from({ length: numLayers }, (_, i) => numLayers - 1 - i);

      for (const li of layerIndices) {
        const ids = layers.get(li);
        if (!ids || ids.length <= 1) continue;

        // Compute barycenter for each node based on connected nodes in adjacent layer
        const barycenters = new Map();
        for (const id of ids) {
          const neighbors = topDown
            ? (revAdj.get(id) || [])   // parents in layer above
            : (adj.get(id) || []);      // children in layer below

          const relevantNeighbors = neighbors.filter(n => {
            const nLayer = layerOf.get(n);
            return topDown ? nLayer < li : nLayer > li;
          });

          if (relevantNeighbors.length > 0) {
            const avg = relevantNeighbors.reduce((sum, n) => sum + positionInLayer(n), 0)
                        / relevantNeighbors.length;
            barycenters.set(id, avg);
          } else {
            // Keep current position as fallback
            barycenters.set(id, positionInLayer(id));
          }
        }

        // Sort by barycenter, with WU grouping as secondary sort
        ids.sort((a, b) => {
          const ba = barycenters.get(a) ?? Infinity;
          const bb = barycenters.get(b) ?? Infinity;
          const diff = ba - bb;
          if (Math.abs(diff) > 0.001) return diff;
          // Tie-break: keep WU members together
          const wuA = segWuMap.get(a) || "zzz";
          const wuB = segWuMap.get(b) || "zzz";
          if (wuA !== wuB) return wuA < wuB ? -1 : 1;
          return segNum(a) - segNum(b);
        });

        layers.set(li, ids);
      }
    }

    // ── Sugiyama Step 4: Coordinate assignment ──
    const nodes = [];
    const nodeMap = new Map();

    for (let layer = 0; layer < numLayers; layer++) {
      const ids = layers.get(layer) || [];
      const layerWidth = ids.length * nodeGap;
      const startX = Math.max(padLeft, (W - layerWidth) / 2) + nodeGap / 2;
      const y = padTop + layer * layerGap + nodeR;

      for (let i = 0; i < ids.length; i++) {
        const id = ids[i];
        const seg = segments.find(s => s.segment_id === id);
        const node = {
          id,
          x: startX + i * nodeGap,
          y,
          layer,
          seg,
          color: segWuColor.get(id) || "#6B7280",
          wuId: segWuMap.get(id) || null
        };
        nodes.push(node);
        nodeMap.set(id, node);
      }
    }

    const svgH = padTop + numLayers * layerGap + 24;

    // ── WU Cluster backgrounds (per-layer sub-clusters for cleaner visuals) ──
    const clusterRects = [];
    for (const wu of workUnits) {
      // Group WU nodes by layer to draw per-layer sub-cluster rects
      const wuNodesByLayer = new Map();
      for (const sid of wu.segment_ids) {
        const n = nodeMap.get(sid);
        if (!n) continue;
        if (!wuNodesByLayer.has(n.layer)) wuNodesByLayer.set(n.layer, []);
        wuNodesByLayer.get(n.layer).push(n);
      }

      const color = wuColors.get(wu.work_unit_id) || "#6B7280";
      const layerKeys = [...wuNodesByLayer.keys()].sort((a, b) => a - b);

      // If only one layer, simple rect; if multiple layers, draw per-layer sub-rects + connecting strip
      for (const lk of layerKeys) {
        const layerNodes = wuNodesByLayer.get(lk);
        const minX = Math.min(...layerNodes.map(n => n.x)) - nodeR - clusterPadX;
        const maxX = Math.max(...layerNodes.map(n => n.x)) + nodeR + clusterPadX;
        const minY = Math.min(...layerNodes.map(n => n.y)) - nodeR - clusterPadY - clusterLabelH;
        const maxY = Math.max(...layerNodes.map(n => n.y)) + nodeR + clusterPadY;

        clusterRects.push({
          x: minX, y: minY,
          w: maxX - minX, h: maxY - minY,
          color,
          title: lk === layerKeys[0] ? wu.title : "",  // label only on first layer occurrence
          wuId: wu.work_unit_id
        });
      }

      // Connecting strip between layers for same WU
      if (layerKeys.length > 1) {
        const allWuNodes = wu.segment_ids.map(sid => nodeMap.get(sid)).filter(Boolean);
        const cx = (Math.min(...allWuNodes.map(n => n.x)) + Math.max(...allWuNodes.map(n => n.x))) / 2;

        for (let i = 0; i < layerKeys.length - 1; i++) {
          const topNodes = wuNodesByLayer.get(layerKeys[i]);
          const botNodes = wuNodesByLayer.get(layerKeys[i + 1]);
          const topMaxY = Math.max(...topNodes.map(n => n.y)) + nodeR + clusterPadY;
          const botMinY = Math.min(...botNodes.map(n => n.y)) - nodeR - clusterPadY - clusterLabelH;

          if (botMinY > topMaxY) {
            clusterRects.push({
              x: cx - 2, y: topMaxY,
              w: 4, h: botMinY - topMaxY,
              color,
              title: "",
              wuId: wu.work_unit_id,
              isConnector: true
            });
          }
        }
      }
    }

    // ── Build SVG ──
    const wrapper = document.createElement("div");
    wrapper.className = "rwg-graph-container";

    const tooltip = document.createElement("div");
    tooltip.className = "rwg-graph-tooltip";
    wrapper.appendChild(tooltip);

    // Marker defs
    const edgeTypesUsed = [...new Set(edges.map(e => e.type))];
    const markerDefs = edgeTypesUsed.map(type => {
      const c = edgeColor(type);
      return `<marker id="arrow-${type}" viewBox="0 0 10 6" refX="10" refY="3" markerWidth="7" markerHeight="5" orient="auto-start-reverse">
        <path d="M0,0 L10,3 L0,6 Z" fill="${c}"/>
      </marker>`;
    }).join("");

    // Cluster rects SVG
    const clusterSvg = clusterRects.map(c => {
      if (c.isConnector) {
        return `<rect x="${c.x}" y="${c.y}" width="${c.w}" height="${c.h}"
          fill="${c.color}" fill-opacity="0.1" rx="2"/>`;
      }
      return `<g class="rwg-cluster" data-wu-id="${escapeHtml(c.wuId)}">
        <rect x="${c.x}" y="${c.y}" width="${c.w}" height="${c.h}"
          rx="10" ry="10" fill="${c.color}" fill-opacity="0.05"
          stroke="${c.color}" stroke-opacity="0.18" stroke-width="1.5"/>
        ${c.title ? `<text x="${c.x + 8}" y="${c.y + 11}" font-size="8" font-weight="600"
          fill="${c.color}" fill-opacity="0.5"
          font-family="IBM Plex Sans, sans-serif">${escapeHtml(c.title.length > 30 ? c.title.slice(0, 28) + "…" : c.title)}</text>` : ""}
      </g>`;
    }).join("");

    // Edge paths — curved, with parallel edge offset
    const edgeCountBetween = new Map();
    const edgePaths = edges.map(edge => {
      const src = nodeMap.get(edge.source);
      const tgt = nodeMap.get(edge.target);
      if (!src || !tgt) return "";

      const c = edgeColor(edge.type);
      const opacity = 0.35 + edge.strength * 0.55;
      const sw = 1 + edge.strength * 1.2;

      // Parallel edge offset
      const pairKey = [edge.source, edge.target].sort().join("|");
      const idx = edgeCountBetween.get(pairKey) || 0;
      edgeCountBetween.set(pairKey, idx + 1);

      const dx = tgt.x - src.x;
      const dy = tgt.y - src.y;
      const dist = Math.sqrt(dx * dx + dy * dy) || 1;

      const shortenS = nodeR + 2;
      const shortenT = nodeR + 5;
      const sx = src.x + (dx / dist) * shortenS;
      const sy = src.y + (dy / dist) * shortenS;
      const tx = tgt.x - (dx / dist) * shortenT;
      const ty = tgt.y - (dy / dist) * shortenT;

      // Control point
      const mx = (sx + tx) / 2;
      const my = (sy + ty) / 2;
      const perpX = -(ty - sy);
      const perpY = tx - sx;
      const pDist = Math.sqrt(perpX * perpX + perpY * perpY) || 1;

      const sameLayer = src.layer === tgt.layer;
      const baseCurve = sameLayer ? Math.max(35, dist * 0.45) : Math.min(dist * 0.13, 22);
      const parallelOffset = idx * 10;
      const curveAmount = baseCurve + parallelOffset;

      const cpx = mx + (perpX / pDist) * curveAmount;
      const cpy = my + (perpY / pDist) * curveAmount;

      // Dash style for weak edges
      const dashAttr = edge.strength < 0.4 ? 'stroke-dasharray="4,3"' : "";

      return `<path
        d="M${sx.toFixed(1)},${sy.toFixed(1)} Q${cpx.toFixed(1)},${cpy.toFixed(1)} ${tx.toFixed(1)},${ty.toFixed(1)}"
        fill="none" stroke="${c}" stroke-width="${sw}"
        stroke-opacity="${opacity}" ${dashAttr}
        marker-end="url(#arrow-${edge.type})"
        data-edge-type="${escapeHtml(edge.type)}"
        data-edge-source="${escapeHtml(edge.source)}"
        data-edge-target="${escapeHtml(edge.target)}"
        data-edge-evidence="${escapeHtml(edge.evidence || "")}"
        data-edge-strength="${edge.strength}"
        style="cursor:pointer;"
      />`;
    }).join("");

    // Node circles with intent ring
    const nodeCircles = nodes.map(n => {
      const intentColor = intentColorHex(n.seg.primary_intent);
      return `<g data-node-id="${n.id}" style="cursor:pointer;">
        <circle cx="${n.x}" cy="${n.y}" r="${nodeR}" fill="${n.color}" fill-opacity="0.1" stroke="${n.color}" stroke-width="2"/>
        <circle cx="${n.x}" cy="${n.y}" r="${nodeR * 0.45}" fill="${intentColor}"/>
        <text x="${n.x}" y="${n.y + 1}" text-anchor="middle" dominant-baseline="middle"
          font-size="8" font-weight="700" fill="#fff" font-family="IBM Plex Mono, monospace"
          pointer-events="none">${n.id.replace("S","")}</text>
      </g>`;
    }).join("");

    // Layer labels
    const layerLabels = Array.from({ length: numLayers }, (_, i) =>
      `<text x="5" y="${padTop + i * layerGap + nodeR + 3}" font-size="7" fill="#C4CAD3"
        font-family="IBM Plex Mono, monospace" font-weight="500" opacity="0.6">L${i}</text>`
    ).join("");

    const svgContent = `
      <svg class="rwg-graph-svg" viewBox="0 0 ${W} ${svgH}" xmlns="http://www.w3.org/2000/svg">
        <defs>${markerDefs}</defs>
        <g class="rwg-layer-labels">${layerLabels}</g>
        <g class="rwg-clusters">${clusterSvg}</g>
        <g class="rwg-edges">${edgePaths}</g>
        <g class="rwg-nodes">${nodeCircles}</g>
      </svg>
    `;
    wrapper.insertAdjacentHTML("afterbegin", svgContent);

    // Edge type legend
    const legendTypes = [...new Set(edges.map(e => e.type))].slice(0, 8);
    if (legendTypes.length) {
      const legend = document.createElement("div");
      legend.className = "rwg-graph-legend";
      legend.innerHTML = legendTypes.map(type =>
        `<div class="rwg-legend-item"><div class="rwg-legend-line" style="background:${edgeColor(type)}"></div>${type.replace(/_/g, " ")}</div>`
      ).join("");
      wrapper.appendChild(legend);
    }

    // WU color legend
    if (workUnits.length) {
      const wuLegend = document.createElement("div");
      wuLegend.className = "rwg-graph-legend";
      wuLegend.style.borderTop = "none";
      wuLegend.style.paddingTop = "2px";
      wuLegend.innerHTML = workUnits.map(wu => {
        const c = wuColors.get(wu.work_unit_id) || "#6B7280";
        const label = wu.title.length > 20 ? wu.title.slice(0, 18) + "…" : wu.title;
        return `<div class="rwg-legend-item"><div style="width:8px;height:8px;border-radius:3px;background:${c};opacity:0.6;"></div>${escapeHtml(label)}</div>`;
      }).join("");
      wrapper.appendChild(wuLegend);
    }

    container.appendChild(wrapper);

    // ── Interactions ──
    const svg = wrapper.querySelector("svg");

    // Node hover/click
    svg.querySelectorAll("[data-node-id]").forEach(g => {
      const nid = g.dataset.nodeId;
      const node = nodeMap.get(nid);
      if (!node) return;

      g.addEventListener("mouseenter", (e) => {
        const seg = node.seg;
        const wuTitle = node.wuId ? (workUnits.find(w => w.work_unit_id === node.wuId)?.title || "") : "";
        tooltip.innerHTML = `<strong>${nid}</strong> · ${escapeHtml(seg.primary_intent)}${wuTitle ? `<br><span style="opacity:0.7">${escapeHtml(wuTitle)}</span>` : ""}<br>${escapeHtml(seg.summary || "")}`;
        tooltip.classList.add("visible");
        const rect = wrapper.getBoundingClientRect();
        tooltip.style.left = `${e.clientX - rect.left + 12}px`;
        tooltip.style.top = `${e.clientY - rect.top - 10}px`;
      });
      g.addEventListener("mouseleave", () => tooltip.classList.remove("visible"));

      g.addEventListener("click", () => {
        scrollToSegment(node.seg, messages);
        setActiveSegment(nid);
        // Highlight connected edges, dim others
        svg.querySelectorAll("path[data-edge-source], path[data-edge-target]").forEach(p => {
          p.style.strokeOpacity = "0.06";
        });
        svg.querySelectorAll(`path[data-edge-source="${nid}"], path[data-edge-target="${nid}"]`).forEach(p => {
          p.style.strokeOpacity = "1";
          p.style.strokeWidth = "3";
        });
        // Also highlight connected nodes
        const connectedNodes = new Set();
        edges.forEach(e => {
          if (e.source === nid) connectedNodes.add(e.target);
          if (e.target === nid) connectedNodes.add(e.source);
        });
        svg.querySelectorAll("[data-node-id]").forEach(ng => {
          const nnid = ng.dataset.nodeId;
          if (nnid !== nid && !connectedNodes.has(nnid)) {
            ng.style.opacity = "0.25";
          }
        });

        setTimeout(() => {
          svg.querySelectorAll("path[data-edge-source], path[data-edge-target]").forEach(p => {
            p.style.strokeOpacity = "";
            p.style.strokeWidth = "";
          });
          svg.querySelectorAll("[data-node-id]").forEach(ng => {
            ng.style.opacity = "";
          });
        }, 2800);
      });
    });

    // Edge hover
    svg.querySelectorAll("path[data-edge-type]").forEach(path => {
      path.addEventListener("mouseenter", (e) => {
        const type = path.dataset.edgeType;
        const src = path.dataset.edgeSource;
        const tgt = path.dataset.edgeTarget;
        const ev = path.dataset.edgeEvidence;
        const st = path.dataset.edgeStrength;
        tooltip.innerHTML = `<strong>${type.replace(/_/g," ")}</strong> ${src} → ${tgt}<br>strength: ${st}${ev ? `<br>${escapeHtml(ev)}` : ""}`;
        tooltip.classList.add("visible");
        const rect = wrapper.getBoundingClientRect();
        tooltip.style.left = `${e.clientX - rect.left + 12}px`;
        tooltip.style.top = `${e.clientY - rect.top - 10}px`;
        path.style.strokeOpacity = "1";
        path.style.strokeWidth = "3";
      });
      path.addEventListener("mouseleave", () => {
        tooltip.classList.remove("visible");
        path.style.strokeOpacity = "";
        path.style.strokeWidth = "";
      });
    });

    // Cluster hover — highlight all segments in WU
    svg.querySelectorAll(".rwg-cluster").forEach(cl => {
      cl.style.cursor = "pointer";
      cl.addEventListener("mouseenter", () => {
        const wuId = cl.dataset.wuId;
        svg.querySelectorAll("[data-node-id]").forEach(ng => {
          const n = nodeMap.get(ng.dataset.nodeId);
          if (n && n.wuId !== wuId) ng.style.opacity = "0.2";
        });
        svg.querySelectorAll("path[data-edge-source]").forEach(p => {
          const srcNode = nodeMap.get(p.dataset.edgeSource);
          const tgtNode = nodeMap.get(p.dataset.edgeTarget);
          if ((!srcNode || srcNode.wuId !== wuId) && (!tgtNode || tgtNode.wuId !== wuId)) {
            p.style.strokeOpacity = "0.05";
          }
        });
      });
      cl.addEventListener("mouseleave", () => {
        svg.querySelectorAll("[data-node-id]").forEach(ng => { ng.style.opacity = ""; });
        svg.querySelectorAll("path[data-edge-source]").forEach(p => { p.style.strokeOpacity = ""; });
      });
    });
  }

  // Helper: extract segment number from "S3" → 3
  function segNum(id) {
    const m = /^S(\d+)$/.exec(id);
    return m ? Number(m[1]) : Infinity;
  }

  /******************************************************************
   * 11. INTERACTION (unchanged logic)
   ******************************************************************/
  function scrollToSegment(segment, messages) {
    const firstMessageId = Array.isArray(segment.message_ids) ? segment.message_ids[0] : null;
    if (!firstMessageId) return;
    const msg = messages.find(m => m.id === firstMessageId);
    if (!msg || !msg.element) return;
    clearMessageHighlights();
    msg.element.scrollIntoView({ behavior: "smooth", block: "center" });
    msg.element.classList.add(HIGHLIGHT_CLASS);
    setTimeout(() => msg.element.classList.remove(HIGHLIGHT_CLASS), 1800);
  }

  function clearMessageHighlights() {
    document.querySelectorAll(`.${HIGHLIGHT_CLASS}`).forEach(el => el.classList.remove(HIGHLIGHT_CLASS));
  }

  function setActiveSegment(segmentId) {
    document.querySelectorAll(`#${PANEL_ID} .rwg-seg-item`).forEach(el => el.classList.remove(ACTIVE_CLASS));
    const target = document.querySelector(`#${PANEL_ID} .rwg-seg-item[data-segment-id="${segmentId}"]`);
    if (target) target.classList.add(ACTIVE_CLASS);
  }

  function installScrollSync(messages, graph) {
    const segmentRecords = [];
    for (const seg of graph.segments) {
      if (!Array.isArray(seg.message_ids) || !seg.message_ids.length) continue;
      const firstMessage = messages.find(m => m.id === seg.message_ids[0]);
      if (!firstMessage?.element) continue;
      segmentRecords.push({ segmentId: seg.segment_id, element: firstMessage.element });
    }
    if (!segmentRecords.length) return;

    const observer = new IntersectionObserver((entries) => {
      const visible = entries.filter(entry => entry.isIntersecting).sort((a, b) => b.intersectionRatio - a.intersectionRatio);
      if (visible.length > 0) {
        const segmentId = visible[0].target.dataset.rwgSegmentId;
        if (segmentId) setActiveSegment(segmentId);
      }
    }, { root: null, threshold: [0.15, 0.35, 0.6] });

    for (const record of segmentRecords) {
      record.element.dataset.rwgSegmentId = record.segmentId;
      observer.observe(record.element);
    }
  }

  /******************************************************************
   * 12. HELPERS
   ******************************************************************/
  function escapeHtml(str) {
    return String(str).replaceAll("&", "&amp;").replaceAll("<", "&lt;").replaceAll(">", "&gt;").replaceAll('"', "&quot;").replaceAll("'", "&#039;");
  }

  function validateProxyUrl() {
    return typeof PROXY_URL === "string" && PROXY_URL.startsWith("http");
  }

  /******************************************************************
   * 13. MAIN
   ******************************************************************/
  let isRunning = false;

  async function runAnalysis(force = false) {
    if (isRunning && !force) return;
    isRunning = true;
    injectStyles();
    createPanelShell();

    if (!validateProxyUrl()) { setStatus("Proxy URL is invalid.", true); isRunning = false; return; }

    const messages = getMessages();
    if (!messages.length) { setStatus("No messages found on this page yet.", true); isRunning = false; return; }

    if (DEBUG) {
      console.log("[RWG] messages found:", messages.length);
      console.log("[RWG] total chars:", messages.reduce((sum, m) => sum + (m.text?.length || 0), 0));
    }

    setStatus(`Found ${messages.length} messages. Running analysis...`);

    try {
      const pipelineResult = await runPipeline(messages);
      const graph = normalizePipelineResult(pipelineResult);

      renderSplitSuggestion(graph);
      renderAnalysisBlock(graph);
      renderWorkUnits(graph, messages);
      renderGraphView(graph, messages);
      installScrollSync(messages, graph);

      const segC = graph.segments.length;
      const wuC = graph.work_units.length;
      const edgeC = graph.edges.length;
      const splitText = graph.split_decision.should_split ? " · Split suggested" : "";

      setStatus(`${segC} segments · ${wuC} work units · ${edgeC} edges${splitText}`, false, true);
    } catch (error) {
      console.error("Research work-graph analysis failed:", error);
      setStatus(`Analysis failed. ${String(error)}`, true);
    } finally {
      isRunning = false;
    }
  }

  setTimeout(() => runAnalysis(false), INIT_DELAY_MS);
})();
