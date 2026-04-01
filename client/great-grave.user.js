// ==UserScript==
// @name         Research Work Graph Overlay (Study Edition v8.2 — UIST)
// @namespace    http://tampermonkey.net/
// @version      8.2
// @description  Study-ready overlay with interaction logging, experiment mode toggle, improved graph layout (pan/zoom), bidirectional List↔Graph sync, and participant/session management. UIST-refined visual design.
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
  const LOG_URL   = "http://127.0.0.1:8787/log";
  const OPENAI_MODEL = "gpt-4o";

  const PANEL_ID = "research-work-graph-overlay-panel";
  const ACTIVE_CLASS = "research-work-graph-active-item";
  const HIGHLIGHT_CLASS = "research-work-graph-message-highlight";
  const INIT_DELAY_MS = 2500;

  const MAX_USER_MESSAGE_CHARS = 2200;

  const ASSISTANT_SHORT_THRESHOLD = 1800;
  const ASSISTANT_HEAD_CHARS = 700;
  const ASSISTANT_TAIL_CHARS = 500;
  const ASSISTANT_MAX_MIDDLE_ITEMS = 12;
  const ASSISTANT_MAX_ITEM_CHARS = 220;
  const ASSISTANT_MAX_TOTAL_CHARS = 2400;

  const PROXY_TIMEOUT_MS = 360000;
  const DEBUG = true;

  /* ── 2. Experiment Mode Config ── */
  let STUDY_MODE    = false;
  let CONDITION     = "overlay_on";
  let PARTICIPANT_ID = "";
  let SESSION_ID     = "";

  /* ── Highlight duration ── */
  const HIGHLIGHT_DURATION_MS = 5000;
  const EDGE_DIM_DURATION_MS  = 5000;

  /******************************************************************
   * 0b. INTERACTION LOGGING MODULE
   ******************************************************************/
  const LOG_STORAGE_KEY = "rwg_interaction_log";

  function getLogStore() {
    try {
      return JSON.parse(localStorage.getItem(LOG_STORAGE_KEY) || "[]");
    } catch { return []; }
  }

  function logEvent(eventType, detail = {}) {
    const entry = {
      ts: new Date().toISOString(),
      epoch: Date.now(),
      participant: PARTICIPANT_ID,
      session: SESSION_ID,
      condition: CONDITION,
      event: eventType,
      ...detail
    };

    try {
      const store = getLogStore();
      store.push(entry);
      localStorage.setItem(LOG_STORAGE_KEY, JSON.stringify(store));
    } catch (e) { console.warn("[RWG-LOG] localStorage write failed", e); }

    try {
      GM_xmlhttpRequest({
        method: "POST",
        url: LOG_URL,
        headers: { "Content-Type": "application/json" },
        data: JSON.stringify(entry),
        timeout: 60000,
        onerror: () => {},
        ontimeout: () => {}
      });
    } catch (_) { /* silent */ }

    if (DEBUG) console.log("[RWG-LOG]", eventType, detail);
  }

  function exportLogs() {
    const store = getLogStore();
    const blob = new Blob([JSON.stringify(store, null, 2)], { type: "application/json" });
    const url = URL.createObjectURL(blob);
    const a = document.createElement("a");
    a.href = url;
    a.download = `rwg_log_${PARTICIPANT_ID || "unknown"}_${SESSION_ID || Date.now()}.json`;
    document.body.appendChild(a);
    a.click();
    a.remove();
    URL.revokeObjectURL(url);
  }

  function clearLogs() {
    localStorage.removeItem(LOG_STORAGE_KEY);
    if (DEBUG) console.log("[RWG-LOG] logs cleared");
  }

  /******************************************************************
   * 0c. SESSION BOOTSTRAP
   ******************************************************************/
  function bootstrapSession() {
    const stored = sessionStorage.getItem("rwg_session_meta");
    if (stored) {
      try {
        const meta = JSON.parse(stored);
        PARTICIPANT_ID = meta.participant || "";
        SESSION_ID = meta.session || "";
        STUDY_MODE = meta.studyMode ?? false;
        CONDITION = meta.condition || "overlay_on";
        return;
      } catch (_) {}
    }

    const hash = window.location.hash;
    const rwgMatch = hash.match(/rwg:(.+)/);
    if (rwgMatch) {
      const params = new URLSearchParams(rwgMatch[1]);
      if (params.get("study") === "1") STUDY_MODE = true;
      if (params.get("pid")) PARTICIPANT_ID = params.get("pid");
      if (params.get("sid")) SESSION_ID = params.get("sid");
      if (params.get("cond")) CONDITION = params.get("cond");
    }

    if (STUDY_MODE && !PARTICIPANT_ID) {
      PARTICIPANT_ID = prompt("Enter Participant ID (e.g. P01):") || `P_${Date.now()}`;
    }
    if (!SESSION_ID) {
      SESSION_ID = `S_${Date.now()}_${Math.random().toString(36).slice(2,6)}`;
    }

    sessionStorage.setItem("rwg_session_meta", JSON.stringify({
      participant: PARTICIPANT_ID,
      session: SESSION_ID,
      studyMode: STUDY_MODE,
      condition: CONDITION
    }));

    logEvent("session_start", { studyMode: STUDY_MODE });
  }

  /******************************************************************
   * 1. STYLES — UIST Refined Academic Design
   *
   * Design rationale:
   *  - Frosted-glass header (backdrop-filter) for layered depth
   *  - Muted neutral base with high-contrast accent colors
   *  - Subtle elevation system (shadow + border)
   *  - Typography: IBM Plex Sans for body, IBM Plex Mono for data
   *  - Micro-interactions with cubic-bezier easing
   *  - Dot-grid graph background (academic paper feel)
   ******************************************************************/
  function injectStyles() {
    if (document.getElementById("research-work-graph-overlay-style")) return;

    const style = document.createElement("style");
    style.id = "research-work-graph-overlay-style";
    style.textContent = `
      @import url('https://fonts.googleapis.com/css2?family=IBM+Plex+Sans:wght@400;500;600;700&family=IBM+Plex+Mono:wght@400;500&display=swap');

      /* ═══════════════════════════════════════════════════
       * Design Tokens
       * ═══════════════════════════════════════════════════ */
      :root {
        --rwg-bg:           #F8F9FB;
        --rwg-bg-elevated:  #FFFFFF;
        --rwg-bg-recessed:  #F1F3F6;
        --rwg-border:       #E4E7EC;
        --rwg-border-subtle:#EDF0F4;
        --rwg-text-primary: #111827;
        --rwg-text-secondary:#4B5563;
        --rwg-text-tertiary: #9CA3AF;
        --rwg-text-quaternary:#D1D5DB;
        --rwg-accent:       #3B5BDB;
        --rwg-accent-light: #EBF0FF;
        --rwg-accent-hover: #364FC7;
        --rwg-shadow-sm:    0 1px 2px rgba(0,0,0,0.04);
        --rwg-shadow-md:    0 2px 8px rgba(0,0,0,0.06), 0 0 1px rgba(0,0,0,0.08);
        --rwg-shadow-lg:    0 4px 16px rgba(0,0,0,0.08), 0 0 1px rgba(0,0,0,0.1);
        --rwg-shadow-panel: -2px 0 24px rgba(0,0,0,0.07), 0 0 1px rgba(0,0,0,0.12);
        --rwg-radius-sm:    6px;
        --rwg-radius-md:    10px;
        --rwg-radius-lg:    14px;
        --rwg-ease:         cubic-bezier(0.25, 0.46, 0.45, 0.94);
        --rwg-ease-spring:  cubic-bezier(0.34, 1.56, 0.64, 1);
      }

      /* ─── Panel Shell ─── */
      #${PANEL_ID} {
        position: fixed;
        top: 0; right: 0;
        width: 432px;
        height: 100vh;
        background: var(--rwg-bg);
        color: var(--rwg-text-primary);
        z-index: 999999;
        overflow-y: auto;
        border-left: 1px solid var(--rwg-border);
        box-sizing: border-box;
        padding: 0;
        font-family: 'IBM Plex Sans', -apple-system, BlinkMacSystemFont, sans-serif;
        box-shadow: var(--rwg-shadow-panel);
        scrollbar-width: thin;
        scrollbar-color: #D4D8DF transparent;
        -webkit-font-smoothing: antialiased;
        -moz-osx-font-smoothing: grayscale;
      }
      #${PANEL_ID}::-webkit-scrollbar { width: 4px; }
      #${PANEL_ID}::-webkit-scrollbar-track { background: transparent; }
      #${PANEL_ID}::-webkit-scrollbar-thumb {
        background: #D4D8DF; border-radius: 4px;
      }
      #${PANEL_ID}::-webkit-scrollbar-thumb:hover { background: #B8BEC7; }

      #${PANEL_ID} * { box-sizing: border-box; }

      /* ─── Condition indicator ─── */
      #${PANEL_ID} .rwg-condition-badge {
        font-size: 9px; font-weight: 700;
        padding: 2px 7px; border-radius: 4px;
        text-transform: uppercase; letter-spacing: 0.06em;
        font-family: 'IBM Plex Mono', monospace;
      }
      .rwg-cond-on  { background: #D3F9D8; color: #087f5b; }
      .rwg-cond-off { background: #FFE3E3; color: #C92A2A; }

      /* ─── Tabs ─── */
      #${PANEL_ID} .rwg-tabs {
        display: flex; gap: 2px;
        padding: 8px 20px;
        background: rgba(248, 249, 251, 0.82);
        backdrop-filter: blur(16px) saturate(180%);
        -webkit-backdrop-filter: blur(16px) saturate(180%);
        border-bottom: 1px solid var(--rwg-border);
        position: sticky; top: 0; z-index: 10;
      }
      #${PANEL_ID} .rwg-tab {
        appearance: none; border: none;
        padding: 7px 16px; border-radius: var(--rwg-radius-sm);
        font-size: 12px; font-weight: 600;
        font-family: inherit;
        cursor: pointer; background: transparent;
        color: var(--rwg-text-tertiary);
        transition: all 0.18s var(--rwg-ease);
        letter-spacing: 0.01em;
      }
      #${PANEL_ID} .rwg-tab:hover {
        background: var(--rwg-bg-recessed);
        color: var(--rwg-text-secondary);
      }
      #${PANEL_ID} .rwg-tab.active {
        background: var(--rwg-accent);
        color: #fff;
        box-shadow: 0 1px 4px rgba(59,91,219,0.3), inset 0 1px 0 rgba(255,255,255,0.1);
      }

      /* ─── Content area ─── */
      #${PANEL_ID} .rwg-body { padding: 16px 20px 28px; }

      /* ─── Status bar ─── */
      #${PANEL_ID} .rwg-status-bar {
        display: flex; align-items: center; gap: 10px;
        padding: 11px 16px; margin-bottom: 16px;
        border-radius: var(--rwg-radius-md); font-size: 12px;
        background: var(--rwg-bg-recessed); color: var(--rwg-text-secondary);
        line-height: 1.4; font-weight: 500;
        border: 1px solid var(--rwg-border-subtle);
      }
      #${PANEL_ID} .rwg-status-bar.error {
        background: #FFF5F5; color: #C92A2A;
        border: 1px solid #FFC9C9;
      }
      #${PANEL_ID} .rwg-status-bar.success {
        background: #EBFBEE; color: #2B8A3E;
        border: 1px solid #B2F2BB;
      }
      #${PANEL_ID} .rwg-status-spinner {
        width: 14px; height: 14px; border-radius: 50%;
        border: 2px solid var(--rwg-border);
        border-top-color: var(--rwg-accent);
        animation: rwg-spin 0.8s linear infinite; flex-shrink: 0;
      }
      @keyframes rwg-spin { to { transform: rotate(360deg); } }

      /* ─── Analysis summary card ─── */
      #${PANEL_ID} .rwg-summary-card {
        padding: 16px 18px; margin-bottom: 16px;
        border-radius: var(--rwg-radius-lg);
        background: var(--rwg-bg-elevated);
        border: 1px solid var(--rwg-border);
        box-shadow: var(--rwg-shadow-sm);
      }
      #${PANEL_ID} .rwg-summary-label {
        font-size: 10px; font-weight: 700;
        color: var(--rwg-accent); text-transform: uppercase;
        letter-spacing: 0.08em; margin-bottom: 7px;
        font-family: 'IBM Plex Mono', monospace;
      }
      #${PANEL_ID} .rwg-summary-text {
        font-size: 13px; line-height: 1.6; color: var(--rwg-text-secondary);
      }

      /* ─── Split alert ─── */
      #${PANEL_ID} .rwg-alert-card {
        padding: 14px 16px; margin-bottom: 16px;
        border-radius: var(--rwg-radius-lg);
        background: #FFF9DB; border: 1px solid #FFE066;
      }
      #${PANEL_ID} .rwg-alert-title {
        font-size: 12px; font-weight: 700; color: #E67700;
        display: flex; align-items: center; gap: 7px;
        margin-bottom: 6px;
      }
      #${PANEL_ID} .rwg-alert-text { font-size: 12px; color: #945905; line-height: 1.55; }

      /* ─── Work Unit card ─── */
      #${PANEL_ID} .rwg-wu-card {
        margin-bottom: 10px;
        border-radius: var(--rwg-radius-lg);
        background: var(--rwg-bg-elevated);
        border: 1px solid var(--rwg-border);
        overflow: hidden;
        box-shadow: var(--rwg-shadow-sm);
        transition: border-color 0.2s var(--rwg-ease), box-shadow 0.2s var(--rwg-ease);
      }
      #${PANEL_ID} .rwg-wu-card:hover {
        border-color: #CED4DA;
        box-shadow: var(--rwg-shadow-md);
      }

      #${PANEL_ID} .rwg-wu-header {
        padding: 14px 16px;
        cursor: pointer;
        display: flex; align-items: flex-start; gap: 10px;
        user-select: none;
        transition: background 0.15s;
      }
      #${PANEL_ID} .rwg-wu-header:hover { background: var(--rwg-bg-recessed); }
      #${PANEL_ID} .rwg-wu-chevron {
        flex-shrink: 0; width: 16px; height: 16px;
        color: var(--rwg-text-quaternary);
        transition: transform 0.25s var(--rwg-ease), color 0.15s;
        margin-top: 2px;
      }
      #${PANEL_ID} .rwg-wu-header:hover .rwg-wu-chevron { color: var(--rwg-text-tertiary); }
      #${PANEL_ID} .rwg-wu-card.collapsed .rwg-wu-chevron { transform: rotate(-90deg); }
      #${PANEL_ID} .rwg-wu-card.collapsed .rwg-wu-body { display: none; }

      #${PANEL_ID} .rwg-wu-title-line {
        font-size: 13px; font-weight: 700; color: var(--rwg-text-primary);
        line-height: 1.35; letter-spacing: -0.005em;
      }
      #${PANEL_ID} .rwg-wu-desc {
        font-size: 11.5px; color: var(--rwg-text-tertiary); line-height: 1.5;
        margin-top: 3px;
      }
      #${PANEL_ID} .rwg-wu-badges {
        display: flex; flex-wrap: wrap; gap: 4px;
        margin-top: 7px;
      }
      #${PANEL_ID} .rwg-badge {
        font-size: 10px; font-weight: 600;
        padding: 2px 8px; border-radius: 5px;
        font-family: 'IBM Plex Mono', monospace;
        letter-spacing: 0.01em;
      }
      #${PANEL_ID} .rwg-badge-status { background: var(--rwg-bg-recessed); color: var(--rwg-text-secondary); }
      #${PANEL_ID} .rwg-badge-status[data-status="resolved"] { background: #D3F9D8; color: #087f5b; }
      #${PANEL_ID} .rwg-badge-status[data-status="revised"]  { background: #D0EBFF; color: #1864AB; }
      #${PANEL_ID} .rwg-badge-status[data-status="abandoned"]{ background: #FFE3E3; color: #C92A2A; }
      #${PANEL_ID} .rwg-badge-status[data-status="tentative"]{ background: #FFF3BF; color: #E67700; }
      #${PANEL_ID} .rwg-badge-count { background: var(--rwg-bg-recessed); color: var(--rwg-text-tertiary); }

      /* ─── Segment item ─── */
      #${PANEL_ID} .rwg-wu-body { padding: 2px 16px 12px; }

      #${PANEL_ID} .rwg-seg-item {
        padding: 11px 14px; margin-top: 6px;
        border-radius: var(--rwg-radius-md); cursor: pointer;
        background: var(--rwg-bg-recessed);
        border: 1.5px solid transparent;
        transition: all 0.18s var(--rwg-ease);
      }
      #${PANEL_ID} .rwg-seg-item:hover {
        background: var(--rwg-accent-light);
        border-color: #C5D2F6;
        transform: translateY(-1px);
        box-shadow: 0 2px 8px rgba(59,91,219,0.07);
      }
      #${PANEL_ID} .rwg-seg-item.${ACTIVE_CLASS} {
        background: var(--rwg-accent-light);
        border-color: #91A7E8;
        box-shadow: 0 0 0 3px rgba(59,91,219,0.1);
      }

      #${PANEL_ID} .rwg-seg-top {
        display: flex; align-items: center; gap: 6px;
        flex-wrap: wrap;
      }
      #${PANEL_ID} .rwg-seg-id {
        font-size: 10px; font-weight: 700;
        font-family: 'IBM Plex Mono', monospace;
        color: var(--rwg-accent); background: var(--rwg-accent-light);
        padding: 1px 7px; border-radius: 4px;
      }
      #${PANEL_ID} .rwg-seg-intent {
        font-size: 9.5px; font-weight: 700;
        color: #fff; padding: 2px 8px; border-radius: 4px;
        letter-spacing: 0.02em;
      }
      #${PANEL_ID} .rwg-seg-summary {
        font-size: 12px; color: var(--rwg-text-secondary); line-height: 1.55;
        margin-top: 6px;
      }
      #${PANEL_ID} .rwg-seg-meta {
        font-size: 10px; color: var(--rwg-text-quaternary); margin-top: 5px;
        font-family: 'IBM Plex Mono', monospace;
        line-height: 1.5;
      }
      #${PANEL_ID} .rwg-seg-edges {
        margin-top: 7px; display: flex; flex-wrap: wrap; gap: 4px;
      }
      #${PANEL_ID} .rwg-edge-chip {
        font-size: 10px; font-weight: 500;
        padding: 2px 8px; border-radius: 5px;
        background: var(--rwg-bg-elevated); color: var(--rwg-text-secondary);
        display: flex; align-items: center; gap: 4px;
        font-family: 'IBM Plex Mono', monospace;
        border: 1px solid var(--rwg-border-subtle);
        transition: background 0.15s;
      }
      #${PANEL_ID} .rwg-edge-chip:hover { background: var(--rwg-accent-light); }
      #${PANEL_ID} .rwg-edge-chip .arrow { color: var(--rwg-accent); font-weight: 700; }

      /* ─── Graph View Container ─── */
      #${PANEL_ID} .rwg-graph-container {
        width: 100%; min-height: 500px;
        background: var(--rwg-bg-elevated); border-radius: var(--rwg-radius-lg);
        border: 1px solid var(--rwg-border);
        overflow: hidden; position: relative;
        box-shadow: var(--rwg-shadow-sm);
      }

      /* Filter toolbar */
      #${PANEL_ID} .rwg-graph-filters {
        display: flex; flex-wrap: wrap; gap: 5px;
        padding: 10px 14px;
        background: var(--rwg-bg);
        border-bottom: 1px solid var(--rwg-border-subtle);
        align-items: center;
      }
      #${PANEL_ID} .rwg-filter-label {
        font-size: 9px; font-weight: 700; color: var(--rwg-text-quaternary);
        text-transform: uppercase; letter-spacing: 0.08em;
        margin-right: 2px;
        font-family: 'IBM Plex Mono', monospace;
      }
      #${PANEL_ID} .rwg-filter-chip {
        appearance: none; border: 1px solid var(--rwg-border);
        padding: 4px 10px; border-radius: var(--rwg-radius-sm);
        font-size: 10px; font-weight: 600;
        font-family: 'IBM Plex Sans', sans-serif;
        cursor: pointer; background: var(--rwg-bg-elevated); color: var(--rwg-text-secondary);
        transition: all 0.15s var(--rwg-ease);
        display: flex; align-items: center; gap: 5px;
      }
      #${PANEL_ID} .rwg-filter-chip:hover { background: var(--rwg-bg-recessed); }
      #${PANEL_ID} .rwg-filter-chip.active {
        background: var(--rwg-accent-light); border-color: #91A7E8; color: var(--rwg-accent);
      }
      #${PANEL_ID} .rwg-filter-chip.dimmed { opacity: 0.3; }
      #${PANEL_ID} .rwg-filter-chip .rwg-fc-dot {
        width: 7px; height: 7px; border-radius: 2px; flex-shrink: 0;
      }
      #${PANEL_ID} .rwg-filter-sep {
        width: 1px; height: 16px; background: var(--rwg-border); margin: 0 2px;
      }

      /* Pan/zoom viewport */
      #${PANEL_ID} .rwg-graph-viewport {
        width: 100%; overflow: auto;
        cursor: grab; max-height: 640px;
        background-image:
          radial-gradient(circle, #DDE1E8 0.6px, transparent 0.6px);
        background-size: 18px 18px;
        background-position: 9px 9px;
      }
      #${PANEL_ID} .rwg-graph-viewport:active { cursor: grabbing; }
      #${PANEL_ID} .rwg-graph-svg { display: block; }

      /* Legend */
      #${PANEL_ID} .rwg-graph-legend {
        display: flex; flex-wrap: wrap; gap: 14px;
        padding: 11px 16px;
        border-top: 1px solid var(--rwg-border-subtle);
        background: var(--rwg-bg);
      }
      #${PANEL_ID} .rwg-legend-section {
        display: flex; align-items: center; gap: 6px;
      }
      #${PANEL_ID} .rwg-legend-title {
        font-size: 9px; font-weight: 700; color: var(--rwg-text-quaternary);
        text-transform: uppercase; letter-spacing: 0.06em;
        margin-right: 2px;
        font-family: 'IBM Plex Mono', monospace;
      }
      #${PANEL_ID} .rwg-legend-item {
        display: flex; align-items: center; gap: 4px;
        font-size: 10px; color: var(--rwg-text-tertiary); font-weight: 500;
      }
      #${PANEL_ID} .rwg-legend-line {
        width: 22px; height: 0; border-radius: 1px;
      }
      #${PANEL_ID} .rwg-legend-shape {
        width: 12px; height: 12px; flex-shrink: 0;
      }

      /* Tooltip */
      #${PANEL_ID} .rwg-graph-tooltip {
        position: absolute; padding: 12px 16px;
        background: rgba(17, 24, 39, 0.94);
        backdrop-filter: blur(8px);
        -webkit-backdrop-filter: blur(8px);
        color: #fff;
        border-radius: var(--rwg-radius-md); font-size: 11px;
        max-width: 260px; pointer-events: none;
        opacity: 0; transition: opacity 0.12s var(--rwg-ease);
        z-index: 20; line-height: 1.55;
        box-shadow: 0 8px 24px rgba(0,0,0,0.3), 0 0 1px rgba(255,255,255,0.1);
      }
      #${PANEL_ID} .rwg-graph-tooltip.visible { opacity: 1; }
      #${PANEL_ID} .rwg-graph-tooltip .rwg-tt-header {
        display: flex; align-items: center; gap: 7px;
        margin-bottom: 5px;
      }
      #${PANEL_ID} .rwg-graph-tooltip .rwg-tt-id {
        font-family: 'IBM Plex Mono', monospace;
        font-weight: 700; font-size: 12px;
      }
      #${PANEL_ID} .rwg-graph-tooltip .rwg-tt-intent {
        font-size: 9px; font-weight: 700;
        padding: 2px 7px; border-radius: 4px;
        text-transform: uppercase; letter-spacing: 0.04em;
      }
      #${PANEL_ID} .rwg-graph-tooltip .rwg-tt-summary {
        font-size: 11px; opacity: 0.88; margin-top: 4px;
      }
      #${PANEL_ID} .rwg-graph-tooltip .rwg-tt-wu {
        font-size: 10px; opacity: 0.55; margin-top: 4px;
        font-style: italic;
      }
      #${PANEL_ID} .rwg-graph-tooltip .rwg-tt-edge-label {
        display: flex; align-items: center; gap: 7px;
        font-weight: 600; font-size: 12px; margin-bottom: 3px;
      }
      #${PANEL_ID} .rwg-graph-tooltip .rwg-tt-evidence {
        font-size: 10px; opacity: 0.75; margin-top: 4px;
        font-style: italic;
      }

      /* Node highlight (bidirectional sync) */
      #${PANEL_ID} .rwg-graph-svg [data-node-id].rwg-node-highlight .rwg-node-shape {
        stroke-width: 3.5 !important;
        filter: drop-shadow(0 0 8px rgba(59,91,219,0.5));
      }

      /* Detail panel (pinned on click) — slide-up with frosted glass */
      #${PANEL_ID} .rwg-detail-panel {
        position: absolute; bottom: 0; left: 0; right: 0;
        background: rgba(255,255,255,0.92);
        backdrop-filter: blur(16px) saturate(180%);
        -webkit-backdrop-filter: blur(16px) saturate(180%);
        border-top: 1px solid var(--rwg-border);
        padding: 14px 16px; z-index: 15;
        max-height: 200px; overflow-y: auto;
        transition: transform 0.25s var(--rwg-ease), opacity 0.2s;
        box-shadow: 0 -4px 20px rgba(0,0,0,0.08);
      }
      #${PANEL_ID} .rwg-detail-panel.hidden {
        transform: translateY(100%); opacity: 0; pointer-events: none;
      }
      #${PANEL_ID} .rwg-detail-header {
        display: flex; align-items: center; gap: 8px;
        margin-bottom: 8px;
      }
      #${PANEL_ID} .rwg-detail-id {
        font-family: 'IBM Plex Mono', monospace;
        font-size: 13px; font-weight: 700; color: var(--rwg-text-primary);
      }
      #${PANEL_ID} .rwg-detail-intent {
        font-size: 10px; font-weight: 700; color: #fff;
        padding: 2px 9px; border-radius: 5px;
        letter-spacing: 0.02em;
      }
      #${PANEL_ID} .rwg-detail-close {
        margin-left: auto; appearance: none; border: none;
        background: var(--rwg-bg-recessed); cursor: pointer; color: var(--rwg-text-tertiary);
        font-size: 14px; padding: 2px 7px; line-height: 1;
        border-radius: var(--rwg-radius-sm);
        transition: all 0.15s;
      }
      #${PANEL_ID} .rwg-detail-close:hover {
        color: var(--rwg-text-primary);
        background: var(--rwg-border);
      }
      #${PANEL_ID} .rwg-detail-summary {
        font-size: 12px; color: var(--rwg-text-secondary); line-height: 1.6;
      }
      #${PANEL_ID} .rwg-detail-meta {
        font-size: 10px; color: var(--rwg-text-tertiary); margin-top: 6px;
        font-family: 'IBM Plex Mono', monospace;
      }
      #${PANEL_ID} .rwg-detail-edges {
        display: flex; flex-wrap: wrap; gap: 4px; margin-top: 8px;
      }

      /* SVG node animations */
      #${PANEL_ID} .rwg-graph-svg [data-node-id] {
        transition: opacity 0.25s var(--rwg-ease);
      }
      #${PANEL_ID} .rwg-graph-svg [data-node-id]:hover .rwg-node-shape {
        filter: brightness(1.08) drop-shadow(0 2px 8px rgba(0,0,0,0.18));
      }
      #${PANEL_ID} .rwg-graph-svg [data-node-id]:hover .rwg-node-label {
        opacity: 1 !important;
      }
      #${PANEL_ID} .rwg-graph-svg path[data-edge-type] {
        transition: stroke-opacity 0.25s var(--rwg-ease), stroke-width 0.18s var(--rwg-ease);
      }

      /* ─── Empty state ─── */
      #${PANEL_ID} .rwg-empty {
        text-align: center; padding: 40px 20px;
        color: var(--rwg-text-quaternary); font-size: 13px;
        font-weight: 500;
      }

      /* ─── Message highlight ─── */
      .${HIGHLIGHT_CLASS} {
        outline: 2.5px solid rgba(59,91,219,0.45) !important;
        outline-offset: 8px !important;
        border-radius: var(--rwg-radius-md) !important;
        transition: outline-color 0.4s var(--rwg-ease);
      }

      /* ─── Intent colors (slightly desaturated for academic feel) ─── */
      .rwg-intent-problem        { background: #C92A2A; }
      .rwg-intent-concept        { background: #7048E8; }
      .rwg-intent-related        { background: #0C8599; }
      .rwg-intent-method         { background: #1864AB; }
      .rwg-intent-implementation { background: #364FC7; }
      .rwg-intent-evaluation     { background: #087f5b; }
      .rwg-intent-evidence       { background: #0B7285; }
      .rwg-intent-critique       { background: #C2255C; }
      .rwg-intent-comparison     { background: #E67700; }
      .rwg-intent-decision       { background: #2B8A3E; }
      .rwg-intent-revision       { background: #862E9C; }
      .rwg-intent-writing        { background: #4263EB; }
      .rwg-intent-nextstep       { background: #1971C2; }
      .rwg-intent-other          { background: #5C5F66; }

      /* ─── Pulse animation for loading ─── */
      @keyframes rwg-pulse {
        0%, 100% { opacity: 0.5; }
        50% { opacity: 1; }
      }
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
    supports: "#2B8A3E",
    critiques: "#E03131",
    compares: "#E67700",
    proposes: "#3B82F6",
    revises: "#9775FA",
    elaborates: "#15AABF",
    answers: "#868E96",
    depends_on: "#5C7CFA",
    refines: "#9775FA",
    branches_from: "#E64980",
    resumes: "#20C997",
    supersedes: "#F76707",
    merges_into: "#22B8CF",
    decision_for: "#2B8A3E",
    rationale_for: "#3B5BDB",
    revision_of: "#862E9C"
  };

  function edgeColor(type) {
    return EDGE_COLOR_MAP[type] || "#ADB5BD";
  }

  /* Slightly desaturated intent colors for academic clarity */
  const INTENT_COLOR_MAP = {
    "Problem Framing": "#C92A2A",
    "Concept Formation": "#7048E8",
    "Related Work Positioning": "#0C8599",
    "Method Design": "#1864AB",
    "Implementation Planning": "#364FC7",
    "Evaluation Design": "#087f5b",
    "Evidence Gathering": "#0B7285",
    "Critique": "#C2255C",
    "Comparison": "#E67700",
    "Decision Making": "#2B8A3E",
    "Revision": "#862E9C",
    "Writing / Formalization": "#4263EB",
    "Next-step Planning": "#1971C2",
    "Other": "#5C5F66"
  };

  function intentColorHex(intent) {
    return INTENT_COLOR_MAP[intent] || "#5C5F66";
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
   ******************************************************************/
  const PROXY_BASE = PROXY_URL.replace(/\/analyze$/, "");
  const MSG_BATCH_SIZE = 6;

  function gmFetch(url, body) {
    return new Promise((resolve, reject) => {
      const payloadStr = JSON.stringify(body);
      if (DEBUG) console.log("[RWG] gmFetch →", url, "bytes:", payloadStr.length);

      GM_xmlhttpRequest({
        method: "POST",
        url,
        headers: { "Content-Type": "application/json" },
        data: payloadStr,
        timeout: PROXY_TIMEOUT_MS,
        onload: function (response) {
          if (DEBUG) console.log("[RWG] gmFetch ←", response.status, "bytes:", String(response.responseText || "").length);
          try {
            if (response.status !== 200) {
              reject(`Proxy error (${response.status})\n${String(response.responseText || "").slice(0, 2000)}`);
              return;
            }
            resolve(JSON.parse(response.responseText));
          } catch (e) {
            reject(`JSON parse error: ${e.message}\nRaw: ${String(response.responseText || "").slice(0, 1500)}`);
          }
        },
        ontimeout: function () { reject(`Request timed out (${PROXY_TIMEOUT_MS / 1000}s).`); },
        onerror: function (err) {
          console.error("[RWG] network error:", err);
          reject("Network error. Check local proxy at 127.0.0.1:8787.");
        }
      });
    });
  }

  async function runPipeline(messages) {
    const lightweight = messages.map(m => ({ id: m.id, role: m.role, text: m.text }));

    if (DEBUG) console.log("[RWG] total messages:", lightweight.length);

    setStatus("Creating analysis session...");
    const { session_id } = await gmFetch(`${PROXY_BASE}/session/create`, { model: OPENAI_MODEL });
    if (DEBUG) console.log("[RWG] session created:", session_id);

    const totalBatches = Math.ceil(lightweight.length / MSG_BATCH_SIZE);
    for (let i = 0; i < lightweight.length; i += MSG_BATCH_SIZE) {
      const batch = lightweight.slice(i, i + MSG_BATCH_SIZE);
      const batchNum = Math.floor(i / MSG_BATCH_SIZE) + 1;
      setStatus(`Uploading messages... (${batchNum}/${totalBatches})`);

      const result = await gmFetch(`${PROXY_BASE}/session/${session_id}/messages`, { messages: batch });
      if (DEBUG) console.log(`[RWG] batch ${batchNum}/${totalBatches} uploaded, total on server: ${result.total}`);
    }

    setStatus("All messages uploaded. Running analysis pipeline...");
    const pipelineResult = await gmFetch(`${PROXY_BASE}/session/${session_id}/analyze`, {});

    return pipelineResult;
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
   * 10. UI — PANEL SHELL (UIST-refined)
   ******************************************************************/
  let currentTab = "list";

  function createPanelShell() {
    removeExistingPanel();
    const panel = document.createElement("div");
    panel.id = PANEL_ID;

    panel.innerHTML = `
      <div class="rwg-tabs">
        <button class="rwg-tab active" data-tab="list">List View</button>
        <button class="rwg-tab" data-tab="graph">Graph View</button>
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

    // ── Tab switching ──
    panel.querySelectorAll(".rwg-tab").forEach(tab => {
      tab.addEventListener("click", () => {
        const prevTab = currentTab;
        panel.querySelectorAll(".rwg-tab").forEach(t => t.classList.remove("active"));
        tab.classList.add("active");
        currentTab = tab.dataset.tab;
        document.getElementById("rwg-content-list").style.display = currentTab === "list" ? "" : "none";
        document.getElementById("rwg-content-graph").style.display = currentTab === "graph" ? "" : "none";
        logEvent("tab_switch", { from: prevTab, to: currentTab });
      });
    });

    logEvent("panel_open");
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
        ${graph.analysis.conversation_summary ? `<div class="rwg-summary-label" style="margin-top:12px;">Summary</div><div class="rwg-summary-text">${escapeHtml(graph.analysis.conversation_summary)}</div>` : ""}
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
            ${wu.final_decision_segment_id ? `<span class="rwg-badge" style="background:#D3F9D8;color:#087f5b;">decision: ${wu.final_decision_segment_id}</span>` : ""}
            ${wu.open_issue_segment_ids.length ? `<span class="rwg-badge" style="background:#FFF3BF;color:#E67700;">${wu.open_issue_segment_ids.length} open issue(s)</span>` : ""}
          </div>
        </div>
      `;
      header.addEventListener("click", () => {
        const wasCollapsed = card.classList.contains("collapsed");
        card.classList.toggle("collapsed");
        logEvent("wu_toggle", {
          wuId: wu.work_unit_id,
          action: wasCollapsed ? "expand" : "collapse"
        });
      });
      card.appendChild(header);

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
          logEvent("segment_click", { segmentId, view: "list" });
          highlightGraphNode(segmentId);
        });

        body.appendChild(item);
      }

      card.appendChild(body);
      content.appendChild(card);
    }
  }

  /******************************************************************
   * 10c. UI — GRAPH VIEW (UIST Redesign)
   *
   * Academic Design Rationale:
   *
   *  NODES — Shape encodes intent category (IBIS-inspired):
   *   ◇ Diamond   : Problem Framing, Critique          (questioning)
   *   ▢ RoundRect : Concept, Method, Implementation     (constructive)
   *   ⬡ Hexagon   : Decision Making, Evidence Gathering (resolution)
   *   △ Triangle  : Comparison, Evaluation Design       (analytical)
   *   ○ Circle    : Writing, Revision, Planning, Other  (procedural)
   *
   *   Ref: Kunz & Rittel (1970) IBIS; Conklin & Begeman (1988) gIBIS;
   *        Buckingham Shum et al. (2006) Compendium.
   *   Ref: Munzner (2014) Ch.5 — shape is an effective identity channel.
   *
   *   Color hue  = WU membership (categorical, Munzner Ch.10)
   *   Border ring = specific intent color (redundant encoding, Ware 2004)
   *   Node size   = connectivity degree (higher = more connected)
   *
   *  EDGES — Visual pattern encodes relationship category:
   *   ── Solid   : Argumentation (supports, critiques, rationale_for)
   *   ╌╌ Dashed  : Evolution     (revises, supersedes, refines, revision_of)
   *   ·· Dotted  : Structural    (depends_on, branches_from, resumes, merges_into)
   *   ─·─ DashDot: Functional    (proposes, answers, decision_for, elaborates, compares)
   *
   *  LAYOUT:
   *   Sugiyama hierarchical layout (Sugiyama et al. 1981)
   *   Barycenter crossing minimization (Purchase 2002).
   *   Gestalt proximity grouping for WU clusters (Ware 2004 Ch.6).
   ******************************************************************/

  /* ── Intent → Shape Category ── */
  const INTENT_SHAPE_MAP = {
    "Problem Framing": "diamond",
    "Critique": "diamond",
    "Concept Formation": "roundrect",
    "Method Design": "roundrect",
    "Implementation Planning": "roundrect",
    "Related Work Positioning": "roundrect",
    "Decision Making": "hexagon",
    "Evidence Gathering": "hexagon",
    "Comparison": "triangle",
    "Evaluation Design": "triangle",
    "Writing / Formalization": "circle",
    "Revision": "circle",
    "Next-step Planning": "circle",
    "Other": "circle"
  };

  function intentShape(intent) {
    return INTENT_SHAPE_MAP[intent] || "circle";
  }

  /* ── Edge → Category ── */
  const EDGE_CATEGORY_MAP = {
    supports:      "argumentation",
    critiques:     "argumentation",
    rationale_for: "argumentation",
    revises:       "evolution",
    supersedes:    "evolution",
    refines:       "evolution",
    revision_of:   "evolution",
    depends_on:    "structural",
    branches_from: "structural",
    resumes:       "structural",
    merges_into:   "structural",
    proposes:      "functional",
    answers:       "functional",
    decision_for:  "functional",
    elaborates:    "functional",
    compares:      "functional"
  };

  const EDGE_CATEGORY_STYLE = {
    argumentation: { dash: "",            label: "Argumentation",  color: "#2B8A3E" },
    evolution:     { dash: "6,4",         label: "Evolution",      color: "#862E9C" },
    structural:    { dash: "2,3",         label: "Structural",     color: "#5C7CFA" },
    functional:    { dash: "8,3,2,3",     label: "Functional",     color: "#0C8599" }
  };

  /* ── Shape path generators (centered at 0,0) ── */
  function shapePath(shape, r) {
    switch (shape) {
      case "diamond": {
        const s = r * 1.1;
        return `M0,${-s} L${s},0 L0,${s} L${-s},0 Z`;
      }
      case "roundrect": {
        const w = r * 1.15, h = r * 0.85, cr = 4;
        return `M${-w + cr},${-h} L${w - cr},${-h} Q${w},${-h} ${w},${-h + cr}
                L${w},${h - cr} Q${w},${h} ${w - cr},${h}
                L${-w + cr},${h} Q${-w},${h} ${-w},${h - cr}
                L${-w},${-h + cr} Q${-w},${-h} ${-w + cr},${-h} Z`;
      }
      case "hexagon": {
        const s = r;
        const pts = [];
        for (let i = 0; i < 6; i++) {
          const angle = (Math.PI / 3) * i - Math.PI / 6;
          pts.push(`${(s * Math.cos(angle)).toFixed(1)},${(s * Math.sin(angle)).toFixed(1)}`);
        }
        return `M${pts[0]} L${pts[1]} L${pts[2]} L${pts[3]} L${pts[4]} L${pts[5]} Z`;
      }
      case "triangle": {
        const s = r * 1.1;
        const h = s * Math.sqrt(3) / 2;
        return `M0,${(-h * 0.7).toFixed(1)} L${s.toFixed(1)},${(h * 0.7).toFixed(1)} L${(-s).toFixed(1)},${(h * 0.7).toFixed(1)} Z`;
      }
      default: return "";
    }
  }

  /* ── Shape SVG legend icons ── */
  function shapeLegendSvg(shape, size = 12) {
    const half = size / 2;
    const style = `fill="#EBF0FF" stroke="#5C7CFA" stroke-width="1.5"`;
    switch (shape) {
      case "diamond":
        return `<svg width="${size}" height="${size}" viewBox="0 0 ${size} ${size}"><path d="M${half} 1 L${size - 1} ${half} L${half} ${size - 1} L1 ${half} Z" ${style}/></svg>`;
      case "roundrect":
        return `<svg width="${size}" height="${size}" viewBox="0 0 ${size} ${size}"><rect x="1" y="2" width="${size - 2}" height="${size - 4}" rx="2" ${style}/></svg>`;
      case "hexagon":
        return `<svg width="${size}" height="${size}" viewBox="0 0 ${size} ${size}"><polygon points="${half},1 ${size - 1},${size * 0.3} ${size - 1},${size * 0.7} ${half},${size - 1} 1,${size * 0.7} 1,${size * 0.3}" ${style}/></svg>`;
      case "triangle":
        return `<svg width="${size}" height="${size}" viewBox="0 0 ${size} ${size}"><polygon points="${half},1 ${size - 1},${size - 1} 1,${size - 1}" ${style}/></svg>`;
      case "circle":
        return `<svg width="${size}" height="${size}" viewBox="0 0 ${size} ${size}"><circle cx="${half}" cy="${half}" r="${half - 1}" ${style}/></svg>`;
      default:
        return "";
    }
  }

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

    /* ── Layout parameters ── */
    const nodeR = 19;
    const layerGap = 105;
    const nodeGap = 66;
    const padTop = 48;
    const padLeft = 36;
    const clusterPadX = 20;
    const clusterPadY = 20;
    const clusterLabelH = 22;

    /* ── Compute connectivity ── */
    const degreeMap = new Map();
    segments.forEach(s => degreeMap.set(s.segment_id, 0));
    edges.forEach(e => {
      if (degreeMap.has(e.source)) degreeMap.set(e.source, degreeMap.get(e.source) + 1);
      if (degreeMap.has(e.target)) degreeMap.set(e.target, degreeMap.get(e.target) + 1);
    });
    const maxDegree = Math.max(1, ...degreeMap.values());

    /* ── WU color assignment — refined muted palette ── */
    const wuColorPalette = [
      "#364FC7", "#0C8599", "#087f5b", "#C2255C", "#7048E8",
      "#C92A2A", "#1864AB", "#E67700", "#862E9C", "#0B7285"
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

    /* ═══════════════════════════════════════════════════════
     * Sugiyama Layout
     * ═══════════════════════════════════════════════════════ */

    const segSet = new Set(segments.map(s => s.segment_id));
    const adj = new Map();
    const revAdj = new Map();
    const inDeg = new Map();

    for (const s of segments) {
      adj.set(s.segment_id, []);
      revAdj.set(s.segment_id, []);
      inDeg.set(s.segment_id, 0);
    }
    for (const e of edges) {
      if (!segSet.has(e.source) || !segSet.has(e.target)) continue;
      if (e.source === e.target) continue;
      adj.get(e.source).push(e.target);
      revAdj.get(e.target).push(e.source);
      inDeg.set(e.target, (inDeg.get(e.target) || 0) + 1);
    }

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
    for (const s of segments) {
      if (!topoOrder.includes(s.segment_id)) topoOrder.push(s.segment_id);
    }

    const layerOf = new Map();
    for (const id of topoOrder) {
      let maxParentLayer = -1;
      for (const parent of (revAdj.get(id) || [])) {
        if (layerOf.has(parent)) maxParentLayer = Math.max(maxParentLayer, layerOf.get(parent));
      }
      layerOf.set(id, maxParentLayer + 1);
    }

    const layers = new Map();
    for (const [id, layer] of layerOf) {
      if (!layers.has(layer)) layers.set(layer, []);
      layers.get(layer).push(id);
    }
    const numLayers = layers.size ? Math.max(...layers.keys()) + 1 : 1;

    for (const [, ids] of layers) {
      ids.sort((a, b) => {
        const wuA = segWuMap.get(a) || "zzz";
        const wuB = segWuMap.get(b) || "zzz";
        if (wuA !== wuB) return wuA < wuB ? -1 : 1;
        return segNum(a) - segNum(b);
      });
    }

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
        const barycenters = new Map();
        for (const id of ids) {
          const neighbors = topDown ? (revAdj.get(id) || []) : (adj.get(id) || []);
          const relevant = neighbors.filter(n => {
            const nLayer = layerOf.get(n);
            return topDown ? nLayer < li : nLayer > li;
          });
          barycenters.set(id, relevant.length > 0
            ? relevant.reduce((sum, n) => sum + positionInLayer(n), 0) / relevant.length
            : positionInLayer(id));
        }
        ids.sort((a, b) => {
          const diff = (barycenters.get(a) ?? Infinity) - (barycenters.get(b) ?? Infinity);
          if (Math.abs(diff) > 0.001) return diff;
          const wuA = segWuMap.get(a) || "zzz";
          const wuB = segWuMap.get(b) || "zzz";
          if (wuA !== wuB) return wuA < wuB ? -1 : 1;
          return segNum(a) - segNum(b);
        });
        layers.set(li, ids);
      }
    }

    /* ── Coordinate assignment ── */
    let maxNodesInLayer = 1;
    for (const [, ids] of layers) {
      if (ids.length > maxNodesInLayer) maxNodesInLayer = ids.length;
    }
    const minW = 400;
    const W = Math.max(minW, maxNodesInLayer * nodeGap + padLeft * 2 + nodeGap);

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
        const degree = degreeMap.get(id) || 0;
        const sizeScale = 0.85 + 0.35 * (degree / maxDegree);
        const node = {
          id, x: startX + i * nodeGap, y, layer, seg,
          color: segWuColor.get(id) || "#868E96",
          wuId: segWuMap.get(id) || null,
          shape: intentShape(seg.primary_intent),
          r: nodeR * sizeScale,
          degree
        };
        nodes.push(node);
        nodeMap.set(id, node);
      }
    }

    const svgH = padTop + numLayers * layerGap + 36;

    /* ═══════════════════════════════════════════════════════
     * WU Cluster Backgrounds
     * ═══════════════════════════════════════════════════════ */
    const clusterRects = [];
    for (const wu of workUnits) {
      const wuNodesByLayer = new Map();
      for (const sid of wu.segment_ids) {
        const n = nodeMap.get(sid);
        if (!n) continue;
        if (!wuNodesByLayer.has(n.layer)) wuNodesByLayer.set(n.layer, []);
        wuNodesByLayer.get(n.layer).push(n);
      }

      const color = wuColors.get(wu.work_unit_id) || "#868E96";
      const layerKeys = [...wuNodesByLayer.keys()].sort((a, b) => a - b);

      for (const lk of layerKeys) {
        const layerNodes = wuNodesByLayer.get(lk);
        const maxR = Math.max(...layerNodes.map(n => n.r));
        const minX = Math.min(...layerNodes.map(n => n.x)) - maxR - clusterPadX;
        const maxX = Math.max(...layerNodes.map(n => n.x)) + maxR + clusterPadX;
        const minY = Math.min(...layerNodes.map(n => n.y)) - maxR - clusterPadY - clusterLabelH;
        const maxY = Math.max(...layerNodes.map(n => n.y)) + maxR + clusterPadY;

        clusterRects.push({
          x: minX, y: minY, w: maxX - minX, h: maxY - minY,
          color,
          title: lk === layerKeys[0] ? wu.title : "",
          wuId: wu.work_unit_id
        });
      }

      if (layerKeys.length > 1) {
        const allWuNodes = wu.segment_ids.map(sid => nodeMap.get(sid)).filter(Boolean);
        const cx = (Math.min(...allWuNodes.map(n => n.x)) + Math.max(...allWuNodes.map(n => n.x))) / 2;
        for (let i = 0; i < layerKeys.length - 1; i++) {
          const topNodes = wuNodesByLayer.get(layerKeys[i]);
          const botNodes = wuNodesByLayer.get(layerKeys[i + 1]);
          const topMaxR = Math.max(...topNodes.map(n => n.r));
          const botMaxR = Math.max(...botNodes.map(n => n.r));
          const topMaxY = Math.max(...topNodes.map(n => n.y)) + topMaxR + clusterPadY;
          const botMinY = Math.min(...botNodes.map(n => n.y)) - botMaxR - clusterPadY - clusterLabelH;
          if (botMinY > topMaxY) {
            clusterRects.push({
              x: cx - 3, y: topMaxY, w: 6, h: botMinY - topMaxY,
              color, title: "", wuId: wu.work_unit_id, isConnector: true
            });
          }
        }
      }
    }

    /* ═══════════════════════════════════════════════════════
     * Build DOM
     * ═══════════════════════════════════════════════════════ */
    const wrapper = document.createElement("div");
    wrapper.className = "rwg-graph-container";

    /* ── Filter Toolbar ── */
    const edgeCategoriesPresent = new Set(edges.map(e => EDGE_CATEGORY_MAP[e.type] || "functional"));
    const activeFilters = new Set(edgeCategoriesPresent);

    const filterBar = document.createElement("div");
    filterBar.className = "rwg-graph-filters";
    filterBar.innerHTML = `<span class="rwg-filter-label">Edges</span>`;

    for (const cat of ["argumentation", "evolution", "structural", "functional"]) {
      if (!edgeCategoriesPresent.has(cat)) continue;
      const style = EDGE_CATEGORY_STYLE[cat];
      const chip = document.createElement("button");
      chip.className = "rwg-filter-chip active";
      chip.dataset.category = cat;
      chip.innerHTML = `<span class="rwg-fc-dot" style="background:${style.color}"></span>${style.label}`;
      chip.addEventListener("click", () => {
        if (activeFilters.has(cat)) {
          activeFilters.delete(cat);
          chip.classList.remove("active");
          chip.classList.add("dimmed");
        } else {
          activeFilters.add(cat);
          chip.classList.add("active");
          chip.classList.remove("dimmed");
        }
        updateEdgeVisibility();
        logEvent("graph_filter_toggle", { category: cat, active: activeFilters.has(cat) });
      });
      filterBar.appendChild(chip);
    }
    wrapper.appendChild(filterBar);

    /* ── Tooltip ── */
    const tooltip = document.createElement("div");
    tooltip.className = "rwg-graph-tooltip";
    wrapper.appendChild(tooltip);

    /* ── Detail Panel ── */
    const detailPanel = document.createElement("div");
    detailPanel.className = "rwg-detail-panel hidden";
    detailPanel.innerHTML = `<div class="rwg-detail-header">
      <span class="rwg-detail-id"></span>
      <span class="rwg-detail-intent"></span>
      <button class="rwg-detail-close">✕</button>
    </div>
    <div class="rwg-detail-summary"></div>
    <div class="rwg-detail-meta"></div>
    <div class="rwg-detail-edges"></div>`;
    wrapper.appendChild(detailPanel);

    detailPanel.querySelector(".rwg-detail-close").addEventListener("click", () => {
      detailPanel.classList.add("hidden");
      resetGraphHighlight();
    });

    /* ── Viewport ── */
    const viewport = document.createElement("div");
    viewport.className = "rwg-graph-viewport";
    wrapper.appendChild(viewport);

    /* ═══════════════════════════════════════════════════════
     * Build SVG
     * ═══════════════════════════════════════════════════════ */

    // Arrow markers
    const markerDefs = Object.entries(EDGE_CATEGORY_STYLE).map(([cat, style]) => {
      return `<marker id="arrow-cat-${cat}" viewBox="0 0 10 7" refX="9" refY="3.5"
        markerWidth="8" markerHeight="6" orient="auto-start-reverse">
        <path d="M0,0.5 L9,3.5 L0,6.5 Z" fill="${style.color}" opacity="0.7"/>
      </marker>`;
    }).join("");

    const perTypeMarkers = [...new Set(edges.map(e => e.type))].map(type => {
      const c = edgeColor(type);
      return `<marker id="arrow-${type}" viewBox="0 0 10 7" refX="9" refY="3.5"
        markerWidth="8" markerHeight="6" orient="auto-start-reverse">
        <path d="M0,0.5 L9,3.5 L0,6.5 Z" fill="${c}" opacity="0.8"/>
      </marker>`;
    }).join("");

    // Cluster SVG with refined styling
    let clusterClipId = 0;
    const clusterSvg = clusterRects.map(c => {
      if (c.isConnector) {
        return `<rect x="${c.x}" y="${c.y}" width="${c.w}" height="${c.h}"
          fill="${c.color}" fill-opacity="0.06" rx="3"/>`;
      }

      let titleSvg = "";
      if (c.title) {
        const labelPadX = 10;
        const availableW = c.w - labelPadX * 2;
        const charW = 5.5;
        const maxChars = Math.floor(availableW / charW);

        if (maxChars >= 4) {
          const clipId = `rwg-cl-clip-${clusterClipId++}`;
          const displayTitle = c.title.length > maxChars
            ? c.title.slice(0, maxChars - 1) + "…"
            : c.title;

          titleSvg = `
            <defs><clipPath id="${clipId}">
              <rect x="${c.x}" y="${c.y}" width="${c.w}" height="${clusterLabelH}" rx="14"/>
            </clipPath></defs>
            <rect x="${c.x}" y="${c.y}" width="${c.w}" height="${clusterLabelH}"
              rx="14" ry="0" fill="${c.color}" fill-opacity="0.06"
              style="clip-path: inset(0 0 0 0 round 14px 14px 0 0);"/>
            <text x="${c.x + labelPadX}" y="${c.y + 15}" font-size="9" font-weight="700"
              fill="${c.color}" fill-opacity="0.5"
              font-family="IBM Plex Sans, sans-serif"
              letter-spacing="0.03em"
              clip-path="url(#${clipId})"
              >${escapeHtml(displayTitle)}</text>`;
        }
      }

      return `<g class="rwg-cluster" data-wu-id="${escapeHtml(c.wuId)}">
        <rect x="${c.x}" y="${c.y}" width="${c.w}" height="${c.h}"
          rx="14" ry="14" fill="${c.color}" fill-opacity="0.03"
          stroke="${c.color}" stroke-opacity="0.12" stroke-width="1.2"
          stroke-dasharray="4,3"/>
        ${titleSvg}
      </g>`;
    }).join("");

    // Edge paths
    const edgeCountBetween = new Map();
    const edgePaths = edges.map(edge => {
      const src = nodeMap.get(edge.source);
      const tgt = nodeMap.get(edge.target);
      if (!src || !tgt) return "";

      const c = edgeColor(edge.type);
      const cat = EDGE_CATEGORY_MAP[edge.type] || "functional";
      const catStyle = EDGE_CATEGORY_STYLE[cat] || EDGE_CATEGORY_STYLE.functional;
      const opacity = 0.25 + edge.strength * 0.5;
      const sw = 1.2 + edge.strength * 1.0;

      const pairKey = [edge.source, edge.target].sort().join("|");
      const idx = edgeCountBetween.get(pairKey) || 0;
      edgeCountBetween.set(pairKey, idx + 1);

      const dx = tgt.x - src.x;
      const dy = tgt.y - src.y;
      const dist = Math.sqrt(dx * dx + dy * dy) || 1;

      const shortenS = src.r + 3;
      const shortenT = tgt.r + 6;
      const sx = src.x + (dx / dist) * shortenS;
      const sy = src.y + (dy / dist) * shortenS;
      const tx = tgt.x - (dx / dist) * shortenT;
      const ty = tgt.y - (dy / dist) * shortenT;

      const mx = (sx + tx) / 2;
      const my = (sy + ty) / 2;
      const perpX = -(ty - sy);
      const perpY = tx - sx;
      const pDist = Math.sqrt(perpX * perpX + perpY * perpY) || 1;

      const sameLayer = src.layer === tgt.layer;
      const baseCurve = sameLayer ? Math.max(40, dist * 0.45) : Math.min(dist * 0.12, 24);
      const parallelOffset = idx * 12;
      const curveAmount = baseCurve + parallelOffset;

      const cpx = mx + (perpX / pDist) * curveAmount;
      const cpy = my + (perpY / pDist) * curveAmount;

      const dashAttr = catStyle.dash
        ? `stroke-dasharray="${catStyle.dash}"`
        : (edge.strength < 0.35 ? 'stroke-dasharray="4,3"' : "");

      return `<path
        d="M${sx.toFixed(1)},${sy.toFixed(1)} Q${cpx.toFixed(1)},${cpy.toFixed(1)} ${tx.toFixed(1)},${ty.toFixed(1)}"
        fill="none" stroke="${c}" stroke-width="${sw.toFixed(1)}"
        stroke-opacity="${opacity.toFixed(2)}" ${dashAttr}
        stroke-linecap="round"
        marker-end="url(#arrow-${edge.type})"
        data-edge-type="${escapeHtml(edge.type)}"
        data-edge-category="${cat}"
        data-edge-source="${escapeHtml(edge.source)}"
        data-edge-target="${escapeHtml(edge.target)}"
        data-edge-evidence="${escapeHtml(edge.evidence || "")}"
        data-edge-strength="${edge.strength}"
        style="cursor:pointer;"
      />`;
    }).join("");

    // Node shapes — enhanced with outer glow, better label placement
    const nodeShapes = nodes.map(n => {
      const shape = n.shape;
      const intentCol = intentColorHex(n.seg.primary_intent);
      const wuCol = n.color;
      const r = n.r;
      const num = n.id.replace("S", "");

      // Outer shape (WU color fill, intent color stroke)
      let shapeEl;
      if (shape === "circle") {
        shapeEl = `<circle class="rwg-node-shape" cx="0" cy="0" r="${r}"
          fill="${wuCol}" fill-opacity="0.08" stroke="${intentCol}" stroke-width="2.2"/>`;
      } else {
        const path = shapePath(shape, r);
        shapeEl = `<path class="rwg-node-shape" d="${path}"
          fill="${wuCol}" fill-opacity="0.08" stroke="${intentCol}" stroke-width="2.2"/>`;
      }

      // Inner intent indicator (slightly larger for better visibility)
      const innerR = r * 0.35;
      const innerDot = `<circle cx="0" cy="0" r="${innerR}" fill="${intentCol}" opacity="0.9"/>`;

      // Segment number inside the inner dot
      const idLabel = `<text x="0" y="0.5" text-anchor="middle" dominant-baseline="middle"
        font-size="${r > 17 ? 8.5 : 7.5}" font-weight="700" fill="#fff"
        font-family="IBM Plex Mono, monospace" pointer-events="none"
        letter-spacing="-0.02em">${num}</text>`;

      // External label (intent abbreviation) — shown subtly below node
      const intentAbbr = n.seg.primary_intent.split(" ")[0].slice(0, 4);
      const externalLabel = `<text class="rwg-node-label" x="0" y="${r + 12}"
        text-anchor="middle" font-size="8" font-weight="600"
        fill="${intentCol}" fill-opacity="0.5"
        font-family="IBM Plex Mono, monospace"
        pointer-events="none" letter-spacing="0.02em">${intentAbbr}</text>`;

      return `<g data-node-id="${n.id}" transform="translate(${n.x},${n.y})" style="cursor:pointer;">
        ${shapeEl}
        ${innerDot}
        ${idLabel}
        ${externalLabel}
      </g>`;
    }).join("");

    // Layer labels — more subtle
    const layerLabels = Array.from({ length: numLayers }, (_, i) =>
      `<text x="10" y="${padTop + i * layerGap + nodeR + 3}" font-size="8" fill="#DEE2E6"
        font-family="IBM Plex Mono, monospace" font-weight="500" letter-spacing="0.04em">L${i}</text>`
    ).join("");

    const svgContent = `
      <svg class="rwg-graph-svg" width="${W}" height="${svgH}" viewBox="0 0 ${W} ${svgH}" xmlns="http://www.w3.org/2000/svg">
        <defs>${markerDefs}${perTypeMarkers}</defs>
        <g class="rwg-layer-labels">${layerLabels}</g>
        <g class="rwg-clusters">${clusterSvg}</g>
        <g class="rwg-edges">${edgePaths}</g>
        <g class="rwg-nodes">${nodeShapes}</g>
      </svg>
    `;
    viewport.innerHTML = svgContent;

    /* ═══════════════════════════════════════════════════════
     * Legend — compact, refined
     * ═══════════════════════════════════════════════════════ */
    const legend = document.createElement("div");
    legend.className = "rwg-graph-legend";

    let shapeLegendHtml = `<div class="rwg-legend-section"><span class="rwg-legend-title">Shapes</span>`;
    const shapeLabels = [
      ["diamond", "Question"],
      ["roundrect", "Construct"],
      ["hexagon", "Resolution"],
      ["triangle", "Analysis"],
      ["circle", "Procedural"]
    ];
    for (const [sh, label] of shapeLabels) {
      shapeLegendHtml += `<div class="rwg-legend-item">${shapeLegendSvg(sh, 12)}<span>${label}</span></div>`;
    }
    shapeLegendHtml += `</div>`;

    let edgeLegendHtml = `<div class="rwg-legend-section"><span class="rwg-legend-title">Edges</span>`;
    for (const [cat, sty] of Object.entries(EDGE_CATEGORY_STYLE)) {
      if (!edgeCategoriesPresent.has(cat)) continue;
      const borderStyle = sty.dash
        ? `border-top: 2px ${sty.dash === "2,3" ? "dotted" : "dashed"} ${sty.color}`
        : `border-top: 2px solid ${sty.color}`;
      edgeLegendHtml += `<div class="rwg-legend-item"><div class="rwg-legend-line" style="${borderStyle}"></div><span>${sty.label}</span></div>`;
    }
    edgeLegendHtml += `</div>`;

    let wuLegendHtml = "";
    if (workUnits.length) {
      wuLegendHtml = `<div class="rwg-legend-section"><span class="rwg-legend-title">Work Units</span>`;
      for (const wu of workUnits) {
        const c = wuColors.get(wu.work_unit_id) || "#868E96";
        const label = wu.title.length > 18 ? wu.title.slice(0, 16) + "…" : wu.title;
        wuLegendHtml += `<div class="rwg-legend-item"><div style="width:8px;height:8px;border-radius:3px;background:${c};opacity:0.55;flex-shrink:0;"></div><span>${escapeHtml(label)}</span></div>`;
      }
      wuLegendHtml += `</div>`;
    }

    legend.innerHTML = shapeLegendHtml + edgeLegendHtml + wuLegendHtml;
    wrapper.appendChild(legend);

    container.appendChild(wrapper);

    /* ═══════════════════════════════════════════════════════
     * Interactions
     * ═══════════════════════════════════════════════════════ */
    const svg = viewport.querySelector("svg");
    let scale = 1;
    let isPanning = false;
    let panStartX = 0, panStartY = 0, scrollStartX = 0, scrollStartY = 0;

    viewport.addEventListener("wheel", (e) => {
      e.preventDefault();
      const delta = e.deltaY > 0 ? 0.92 : 1.08;
      scale = Math.max(0.3, Math.min(3, scale * delta));
      svg.style.transform = `scale(${scale})`;
      svg.style.transformOrigin = "0 0";
    }, { passive: false });

    viewport.addEventListener("mousedown", (e) => {
      if (e.target.closest("[data-node-id], path[data-edge-type], .rwg-cluster")) return;
      isPanning = true;
      panStartX = e.clientX;
      panStartY = e.clientY;
      scrollStartX = viewport.scrollLeft;
      scrollStartY = viewport.scrollTop;
    });
    window.addEventListener("mousemove", (e) => {
      if (!isPanning) return;
      viewport.scrollLeft = scrollStartX - (e.clientX - panStartX);
      viewport.scrollTop = scrollStartY - (e.clientY - panStartY);
    });
    window.addEventListener("mouseup", () => { isPanning = false; });

    function updateEdgeVisibility() {
      svg.querySelectorAll("path[data-edge-category]").forEach(p => {
        const cat = p.dataset.edgeCategory;
        p.style.display = activeFilters.has(cat) ? "" : "none";
      });
    }

    function resetGraphHighlight() {
      svg.querySelectorAll("path[data-edge-source]").forEach(p => {
        p.style.strokeOpacity = "";
        p.style.strokeWidth = "";
      });
      svg.querySelectorAll("[data-node-id]").forEach(ng => {
        ng.style.opacity = "";
      });
    }

    function showDetailPanel(node) {
      const seg = node.seg;
      const wu = node.wuId ? workUnits.find(w => w.work_unit_id === node.wuId) : null;
      const outgoing = edges.filter(e => e.source === node.id);
      const incoming = edges.filter(e => e.target === node.id);

      detailPanel.querySelector(".rwg-detail-id").textContent = node.id;
      const intentEl = detailPanel.querySelector(".rwg-detail-intent");
      intentEl.textContent = seg.primary_intent;
      intentEl.style.background = intentColorHex(seg.primary_intent);
      detailPanel.querySelector(".rwg-detail-summary").textContent = seg.summary || "(No summary)";

      const metaParts = [];
      if (wu) metaParts.push(`WU: ${wu.title}`);
      if (seg.secondary_intent) metaParts.push(`2nd: ${seg.secondary_intent}`);
      metaParts.push(`conf: ${(seg.intent_confidence || 0).toFixed(2)}`);
      metaParts.push(`msgs: ${(seg.message_ids || []).join(",")}`);
      detailPanel.querySelector(".rwg-detail-meta").textContent = metaParts.join(" · ");

      const edgesHtml = [...outgoing.map(e =>
        `<span class="rwg-edge-chip"><span class="arrow" style="color:${edgeColor(e.type)}">→</span> ${escapeHtml(e.type)} ${escapeHtml(e.target)}</span>`
      ), ...incoming.map(e =>
        `<span class="rwg-edge-chip"><span class="arrow" style="color:${edgeColor(e.type)}">←</span> ${escapeHtml(e.type)} ${escapeHtml(e.source)}</span>`
      )].join("");
      detailPanel.querySelector(".rwg-detail-edges").innerHTML = edgesHtml;

      detailPanel.classList.remove("hidden");
    }

    // Node interactions
    svg.querySelectorAll("[data-node-id]").forEach(g => {
      const nid = g.dataset.nodeId;
      const node = nodeMap.get(nid);
      if (!node) return;

      g.addEventListener("mouseenter", (e) => {
        const seg = node.seg;
        const wuTitle = node.wuId ? (workUnits.find(w => w.work_unit_id === node.wuId)?.title || "") : "";
        tooltip.innerHTML = `
          <div class="rwg-tt-header">
            <span class="rwg-tt-id">${nid}</span>
            <span class="rwg-tt-intent" style="background:${intentColorHex(seg.primary_intent)}">${escapeHtml(seg.primary_intent)}</span>
          </div>
          ${seg.summary ? `<div class="rwg-tt-summary">${escapeHtml(seg.summary)}</div>` : ""}
          ${wuTitle ? `<div class="rwg-tt-wu">${escapeHtml(wuTitle)}</div>` : ""}
        `;
        tooltip.classList.add("visible");
        const rect = wrapper.getBoundingClientRect();
        const leftPos = e.clientX - rect.left + 14;
        const topPos = e.clientY - rect.top - 10;
        tooltip.style.left = `${Math.min(leftPos, rect.width - 270)}px`;
        tooltip.style.top = `${topPos}px`;
      });
      g.addEventListener("mouseleave", () => tooltip.classList.remove("visible"));

      g.addEventListener("click", () => {
        scrollToSegment(node.seg, messages);
        setActiveSegment(nid);
        logEvent("graph_node_click", { segmentId: nid });
        highlightListSegment(nid);
        showDetailPanel(node);

        resetGraphHighlight();
        svg.querySelectorAll("path[data-edge-source], path[data-edge-target]").forEach(p => {
          p.style.strokeOpacity = "0.05";
        });
        svg.querySelectorAll(`path[data-edge-source="${nid}"], path[data-edge-target="${nid}"]`).forEach(p => {
          p.style.strokeOpacity = "1";
          p.style.strokeWidth = "3";
        });
        const connectedNodes = new Set();
        edges.forEach(e => {
          if (e.source === nid) connectedNodes.add(e.target);
          if (e.target === nid) connectedNodes.add(e.source);
        });
        svg.querySelectorAll("[data-node-id]").forEach(ng => {
          const nnid = ng.dataset.nodeId;
          if (nnid !== nid && !connectedNodes.has(nnid)) ng.style.opacity = "0.15";
        });

        setTimeout(() => { resetGraphHighlight(); }, EDGE_DIM_DURATION_MS);
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
        const cat = path.dataset.edgeCategory;
        const catLabel = EDGE_CATEGORY_STYLE[cat]?.label || cat;

        tooltip.innerHTML = `
          <div class="rwg-tt-edge-label">
            <span style="color:${edgeColor(type)}">${type.replace(/_/g, " ")}</span>
            <span style="font-size:9px;opacity:0.5">${catLabel}</span>
          </div>
          <div style="font-size:10px;opacity:0.8">${src} → ${tgt} · strength ${st}</div>
          ${ev ? `<div class="rwg-tt-evidence">"${escapeHtml(ev)}"</div>` : ""}
        `;
        tooltip.classList.add("visible");
        const rect = wrapper.getBoundingClientRect();
        tooltip.style.left = `${e.clientX - rect.left + 14}px`;
        tooltip.style.top = `${e.clientY - rect.top - 10}px`;
        path.style.strokeOpacity = "1";
        path.style.strokeWidth = "3";
        logEvent("graph_edge_hover", { type, source: src, target: tgt });
      });
      path.addEventListener("mouseleave", () => {
        tooltip.classList.remove("visible");
        path.style.strokeOpacity = "";
        path.style.strokeWidth = "";
      });
    });

    // Cluster hover
    svg.querySelectorAll(".rwg-cluster").forEach(cl => {
      cl.style.cursor = "pointer";
      cl.addEventListener("mouseenter", () => {
        const wuId = cl.dataset.wuId;
        svg.querySelectorAll("[data-node-id]").forEach(ng => {
          const n = nodeMap.get(ng.dataset.nodeId);
          if (n && n.wuId !== wuId) ng.style.opacity = "0.12";
        });
        svg.querySelectorAll("path[data-edge-source]").forEach(p => {
          const srcNode = nodeMap.get(p.dataset.edgeSource);
          const tgtNode = nodeMap.get(p.dataset.edgeTarget);
          if ((!srcNode || srcNode.wuId !== wuId) && (!tgtNode || tgtNode.wuId !== wuId)) {
            p.style.strokeOpacity = "0.03";
          }
        });
      });
      cl.addEventListener("mouseleave", () => { resetGraphHighlight(); });
    });
  }

  function segNum(id) {
    const m = /^S(\d+)$/.exec(id);
    return m ? Number(m[1]) : Infinity;
  }

  /******************************************************************
   * 11. INTERACTION
   ******************************************************************/
  let _highlightTimer = null;

  function scrollToSegment(segment, messages) {
    const firstMessageId = Array.isArray(segment.message_ids) ? segment.message_ids[0] : null;
    if (!firstMessageId) return;
    const msg = messages.find(m => m.id === firstMessageId);
    if (!msg || !msg.element) return;
    clearMessageHighlights();
    msg.element.scrollIntoView({ behavior: "smooth", block: "center" });
    msg.element.classList.add(HIGHLIGHT_CLASS);

    logEvent("scroll_to_message", {
      segmentId: segment.segment_id,
      messageId: firstMessageId,
      view: currentTab
    });

    if (_highlightTimer) clearTimeout(_highlightTimer);
    _highlightTimer = setTimeout(() => {
      msg.element.classList.remove(HIGHLIGHT_CLASS);
      _highlightTimer = null;
    }, HIGHLIGHT_DURATION_MS);
  }

  function clearMessageHighlights() {
    if (_highlightTimer) { clearTimeout(_highlightTimer); _highlightTimer = null; }
    document.querySelectorAll(`.${HIGHLIGHT_CLASS}`).forEach(el => el.classList.remove(HIGHLIGHT_CLASS));
  }

  function setActiveSegment(segmentId) {
    document.querySelectorAll(`#${PANEL_ID} .rwg-seg-item`).forEach(el => el.classList.remove(ACTIVE_CLASS));
    const target = document.querySelector(`#${PANEL_ID} .rwg-seg-item[data-segment-id="${segmentId}"]`);
    if (target) target.classList.add(ACTIVE_CLASS);
  }

  /* ── Bidirectional Sync helpers ── */

  function highlightGraphNode(segmentId) {
    const panel = document.getElementById(PANEL_ID);
    if (!panel) return;
    const svg = panel.querySelector(".rwg-graph-svg");
    if (!svg) return;
    svg.querySelectorAll(".rwg-node-highlight").forEach(n => n.classList.remove("rwg-node-highlight"));
    const nodeG = svg.querySelector(`[data-node-id="${segmentId}"]`);
    if (nodeG) nodeG.classList.add("rwg-node-highlight");
  }

  function highlightListSegment(segmentId) {
    const panel = document.getElementById(PANEL_ID);
    if (!panel) return;
    const item = panel.querySelector(`.rwg-seg-item[data-segment-id="${segmentId}"]`);
    if (!item) return;
    const card = item.closest(".rwg-wu-card");
    if (card && card.classList.contains("collapsed")) {
      card.classList.remove("collapsed");
    }
    setActiveSegment(segmentId);
    item.scrollIntoView({ behavior: "smooth", block: "nearest" });
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
        if (segmentId) {
          setActiveSegment(segmentId);
          highlightGraphNode(segmentId);
        }
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
   * 12b. KEYBOARD SHORTCUTS
   ******************************************************************/
  document.addEventListener("keydown", (e) => {
    if (e.ctrlKey && e.shiftKey && e.key === "R") {
      e.preventDefault();
      if (CONDITION === "overlay_on") {
        CONDITION = "overlay_off";
        const panel = document.getElementById(PANEL_ID);
        if (panel) panel.style.display = "none";
      } else {
        CONDITION = "overlay_on";
        const panel = document.getElementById(PANEL_ID);
        if (panel) {
          panel.style.display = "";
        } else {
          runAnalysis(true);
        }
      }
      sessionStorage.setItem("rwg_session_meta", JSON.stringify({
        participant: PARTICIPANT_ID, session: SESSION_ID,
        studyMode: STUDY_MODE, condition: CONDITION
      }));
      logEvent("condition_toggle", { newCondition: CONDITION });
      if (DEBUG) console.log(`[RWG] Condition toggled → ${CONDITION}`);
    }

    if (e.ctrlKey && e.shiftKey && e.key === "E") {
      e.preventDefault();
      exportLogs();
    }
  });

  /******************************************************************
   * 13. MAIN
   ******************************************************************/
  let isRunning = false;
  let analysisGen = 0;

  const INSTANCE_KEY = "__rwg_instance_id__";
  const myId = Date.now() + "_" + Math.random().toString(36).slice(2, 6);
  window[INSTANCE_KEY] = myId;

  async function runAnalysis(force = false) {
    if (window[INSTANCE_KEY] !== myId) return;
    if (isRunning && !force) return;

    const gen = ++analysisGen;
    isRunning = true;
    injectStyles();

    if (STUDY_MODE && CONDITION === "overlay_off") {
      logEvent("analysis_skipped_overlay_off");
      isRunning = false;
      return;
    }

    createPanelShell();

    if (!validateProxyUrl()) { setStatus("Proxy URL is invalid.", true); isRunning = false; return; }

    const messages = getMessages();
    if (!messages.length) { setStatus("No messages found on this page yet.", true); isRunning = false; return; }

    if (DEBUG) {
      console.log("[RWG] messages found:", messages.length);
      console.log("[RWG] total chars:", messages.reduce((sum, m) => sum + (m.text?.length || 0), 0));
    }

    setStatus(`Found ${messages.length} messages. Running analysis...`);
    logEvent("analysis_start", { messageCount: messages.length });

    try {
      const pipelineResult = await runPipeline(messages);

      if (gen !== analysisGen) { isRunning = false; return; }

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
      logEvent("analysis_complete", { segments: segC, workUnits: wuC, edges: edgeC });
    } catch (error) {
      if (gen !== analysisGen) { isRunning = false; return; }
      if (window[INSTANCE_KEY] !== myId) { isRunning = false; return; }

      console.error("Research work-graph analysis failed:", error);
      setStatus(`Analysis failed. ${String(error)}`, true);
      logEvent("analysis_error", { error: String(error) });
    } finally {
      isRunning = false;
    }
  }

  // ── Bootstrap & Launch ──
  bootstrapSession();
  setTimeout(() => runAnalysis(false), INIT_DELAY_MS);
})();
