import { useState, useMemo, useCallback, useRef, useEffect } from "react";

// ─── localStorage helpers ──────────────────────────────────────────────────
const LS_TRADES  = "wheeldeskv1_trades";
const LS_CAPITAL = "wheeldeskv1_capital";
const LS_APIKEY  = "wheeldeskv1_apikey";
const LS_FILES   = "wheeldeskv1_files";
const lsGet = (key, fallback) => { try { const v = localStorage.getItem(key); return v ? JSON.parse(v) : fallback; } catch { return fallback; } };
const lsSet = (key, val) => { try { localStorage.setItem(key, JSON.stringify(val)); } catch {} };

// ─── AI CSV Parser ─────────────────────────────────────────────────────────
async function parseCSVWithAI(csvText, apiKey) {
  const prompt = `You are a financial data parser. Extract all OPTIONS trades from this brokerage CSV export.

For each options trade found, return a JSON object with these exact fields:

- ticker: string (underlying stock symbol, e.g. "AAPL")
- type: "PUT" or "CALL"
- strike: number (strike price)
- expiry: string (YYYY-MM-DD format)
- contracts: number (number of contracts, always positive)
- premiumPerContract: number (premium received or paid per contract in dollars, always positive)
- premiumCollected: number (total premium = premiumPerContract * contracts * 100, always positive)
- openDate: string (YYYY-MM-DD format, date the position was opened)
- status: "open" (always set to open on import, user will update)
- notes: string (any relevant notes, empty string if none)

Rules:

- Only include OPTIONS trades (puts and calls), skip stock/ETF buys/sells, dividends, interest, etc.
- If a row is selling to open a put or call, include it
- premiumCollected should always be positive (it's the credit received)
- If you see OCC option symbols like AAPL250117P00150000, parse them: ticker=AAPL, expiry=2025-01-17, type=PUT, strike=150.00
- Return ONLY a valid JSON object with two keys:
  1. "trades": array of trade objects as described above
  1. "dateRange": object with "earliest" and "latest" keys (YYYY-MM-DD), representing the full date range of ALL rows in the CSV (not just options), so we can track coverage
- No markdown, no explanation, no backticks

CSV data:
${csvText.slice(0, 8000)}`;

  const response = await fetch("https://api.anthropic.com/v1/messages", {
    method: "POST",
    headers: {
      "Content-Type": "application/json",
      "x-api-key": apiKey,
      "anthropic-version": "2023-06-01",
      "anthropic-dangerous-direct-browser-access": "true",
    },
    body: JSON.stringify({
      model: "claude-sonnet-4-20250514",
      max_tokens: 4000,
      messages: [{ role: "user", content: prompt }],
    }),
  });

  if (!response.ok) {
    const err = await response.json().catch(() => ({}));
    throw new Error(err?.error?.message || `API error ${response.status}`);
  }

  const data = await response.json();
  const text = data.content?.find(b => b.type === "text")?.text || "{}";
  const clean = text.replace(/`json|`/g, "").trim();
  const parsed = JSON.parse(clean);

  const trades = (parsed.trades || []).map(t => ({
    ...t,
    id: Date.now() + Math.random(),
    realizedPnl: null,
    closeDate: null,
    status: "open",
  }));

  return { trades, dateRange: parsed.dateRange || null };
}

// ─── Helpers ───────────────────────────────────────────────────────────────
function formatExpiry(d) {
  if (!d) return "—";
  const [y, m, day] = d.split("-");
  const months = ["Jan","Feb","Mar","Apr","May","Jun","Jul","Aug","Sep","Oct","Nov","Dec"];
  return `${months[parseInt(m)-1]} ${parseInt(day)} '${y.slice(2)}`;
}

function daysUntil(dateStr) {
  if (!dateStr) return null;
  return Math.round((new Date(dateStr) - new Date()) / 86400000);
}

function computeStats(trades, capitalBase) {
  const open   = trades.filter(t => t.status === "open");
  const closed = trades.filter(t => t.status !== "open");
  const totalPremium    = trades.reduce((s, t) => s + (t.premiumCollected || 0), 0);
  const realizedPnl     = closed.reduce((s, t) => s + (t.realizedPnl || 0), 0);
  const capitalDeployed = open.reduce((s, t) => s + t.strike * t.contracts * 100, 0);
  const winRate = closed.length > 0 ? (closed.filter(t => (t.realizedPnl || 0) > 0).length / closed.length) * 100 : 0;
  const rocPct  = capitalBase > 0 ? (realizedPnl / capitalBase) * 100 : 0;
  return { totalPremium, realizedPnl, capitalDeployed, openCount: open.length, winRate, rocPct };
}

// ─── Design tokens ─────────────────────────────────────────────────────────
const G = {
  bg: "#05080c", surface: "#090d12", border: "#131c26",
  text: "#c5d3df", muted: "#3a5068", accent: "#00c896",
  blue: "#4b9ef5", amber: "#f5a623", red: "#f07070", purple: "#b08af5",
};
const mono = "'IBM Plex Mono', monospace";
const sans = "'IBM Plex Sans', sans-serif";

// ─── Onboarding Modal ─────────────────────────────────────────────────────
function OnboardingModal({ onSave }) {
  const [val, setVal] = useState("");
  const [error, setError] = useState("");

  const submit = () => {
    if (!val.startsWith("sk-ant-")) { setError("Key should start with sk-ant-"); return; }
    onSave(val);
  };

  return (
    <div style={{ position: "fixed", inset: 0, background: "#000000ee", display: "flex", alignItems: "center", justifyContent: "center", zIndex: 200, fontFamily: sans }}>
      <div style={{ background: G.surface, border: `1px solid ${G.border}`, borderRadius: 12, width: 480, overflow: "hidden" }}>

        {/* Top accent bar */}
        <div style={{ height: 3, background: `linear-gradient(90deg, ${G.accent}, ${G.blue})` }} />

        <div style={{ padding: "32px 36px" }}>
          {/* Logo */}
          <div style={{ fontFamily: mono, fontSize: 16, fontWeight: 700, letterSpacing: "0.2em", color: G.accent, marginBottom: 4 }}>
            WHEEL<span style={{ color: G.blue }}>.</span>DESK
          </div>
          <div style={{ fontSize: 11, color: G.muted, fontFamily: mono, marginBottom: 28 }}>Options Wheel Tracker</div>

          {/* What it does */}
          <div style={{ marginBottom: 28 }}>
            <div style={{ fontSize: 13, fontWeight: 600, color: G.text, marginBottom: 12 }}>Track your wheel strategy in one place</div>
            <div style={{ display: "flex", flexDirection: "column", gap: 9 }}>
              {[
                ["📂", "Import trades from any broker — Fidelity, Schwab, Tastytrade, IBKR"],
                ["🤖", "AI reads your CSV automatically, no reformatting needed"],
                ["📊", "Track premium collected, P&L, return on capital, win rate"],
                ["💾", "Everything saves locally in your browser — no account needed"],
              ].map(([icon, text]) => (
                <div key={text} style={{ display: "flex", alignItems: "flex-start", gap: 10 }}>
                  <span style={{ fontSize: 14, marginTop: 1 }}>{icon}</span>
                  <span style={{ fontSize: 12, color: G.muted, lineHeight: 1.5 }}>{text}</span>
                </div>
              ))}
            </div>
          </div>

          {/* Divider */}
          <div style={{ borderTop: `1px solid ${G.border}`, marginBottom: 24 }} />

          {/* API Key setup */}
          <div style={{ marginBottom: 8 }}>
            <div style={{ fontSize: 12, fontWeight: 600, color: G.text, marginBottom: 6 }}>Set up AI import (free)</div>
            <div style={{ fontSize: 11, color: G.muted, lineHeight: 1.6, marginBottom: 14 }}>
              The AI parser needs a free Anthropic API key. It costs fractions of a cent per CSV import.
            </div>

            <div style={{ display: "flex", flexDirection: "column", gap: 8, marginBottom: 14, background: G.bg, border: `1px solid ${G.border}`, borderRadius: 8, padding: "14px 16px" }}>
              {[
                ["1", "Go to", "console.anthropic.com", "https://console.anthropic.com"],
                ["2", "Create a free account and click", "API Keys → Create Key", null],
                ["3", "Paste your key below", "", null],
              ].map(([n, before, highlight, href]) => (
                <div key={n} style={{ display: "flex", alignItems: "center", gap: 10 }}>
                  <div style={{ width: 18, height: 18, borderRadius: "50%", background: "#0a1e30", border: `1px solid ${G.blue}`, display: "flex", alignItems: "center", justifyContent: "center", fontSize: 9, fontFamily: mono, color: G.blue, flexShrink: 0 }}>{n}</div>
                  <div style={{ fontSize: 11, color: G.muted }}>
                    {before}{" "}
                    {href
                      ? <a href={href} target="_blank" rel="noreferrer" style={{ color: G.blue, textDecoration: "none" }}>{highlight}</a>
                      : <span style={{ color: G.text, fontFamily: mono, fontSize: 10 }}>{highlight}</span>
                    }
                  </div>
                </div>
              ))}
            </div>

            <input
              type="password"
              placeholder="sk-ant-api03-..."
              value={val}
              onChange={e => { setVal(e.target.value); setError(""); }}
              onKeyDown={e => e.key === "Enter" && submit()}
              style={{ width: "100%", background: G.bg, border: `1px solid ${error ? G.red : G.border}`, color: G.text, padding: "10px 12px", borderRadius: 6, fontSize: 12, fontFamily: mono, outline: "none", marginBottom: 6 }}
            />
            {error && <div style={{ fontSize: 10, color: G.red, fontFamily: mono, marginBottom: 8 }}>{error}</div>}
          </div>

          <div style={{ display: "flex", gap: 10, marginTop: 4 }}>
            <button
              onClick={() => onSave("__skip__")}
              style={{ flex: 1, padding: "10px", border: `1px solid ${G.border}`, background: "none", color: G.muted, borderRadius: 6, fontSize: 11, fontFamily: mono, cursor: "pointer" }}
            >Skip for now</button>
            <button
              onClick={submit}
              style={{ flex: 2, padding: "10px", border: `1px solid ${G.accent}`, background: "#0a2a1a", color: G.accent, borderRadius: 6, fontSize: 11, fontFamily: mono, cursor: "pointer", fontWeight: 600, letterSpacing: "0.06em" }}
            >Save Key &amp; Get Started →</button>
          </div>
          <div style={{ fontSize: 9.5, color: G.muted, fontFamily: mono, marginTop: 10, textAlign: "center", opacity: 0.7 }}>
            Your key is stored only in your browser. We never see it.
          </div>
        </div>
      </div>
    </div>
  );
}

// ─── API Key Banner (header) ───────────────────────────────────────────────
function ApiKeyBanner({ apiKey, onSave }) {
  const [val, setVal] = useState("");
  const [show, setShow] = useState(false);

  if (!show) {
    return (
      <div style={{ display: "flex", alignItems: "center", gap: 8 }}>
        <div style={{ fontSize: 9, fontFamily: mono, color: G.muted, letterSpacing: "0.08em" }}>API KEY</div>
        {apiKey && apiKey !== "__skip__"
          ? <div style={{ fontSize: 9, fontFamily: mono, color: G.accent }}>●●●●●●●●</div>
          : <div style={{ fontSize: 9, fontFamily: mono, color: G.amber }}>not set</div>
        }
        <button onClick={() => { setShow(true); setVal(""); }} style={{ background: "none", border: "none", color: G.muted, fontSize: 9, fontFamily: mono, cursor: "pointer", textDecoration: "underline" }}>
          {apiKey && apiKey !== "__skip__" ? "change" : "add"}
        </button>
      </div>
    );
  }

  return (
    <div style={{ display: "flex", alignItems: "center", gap: 8 }}>
      <div style={{ fontSize: 9, fontFamily: mono, color: G.muted }}>NEW KEY</div>
      <input
        type="password" placeholder="sk-ant-…" value={val}
        onChange={e => setVal(e.target.value)}
        onKeyDown={e => { if (e.key === "Enter") { onSave(val); setShow(false); } if (e.key === "Escape") setShow(false); }}
        style={{ width: 180, background: G.bg, border: `1px solid ${G.border}`, color: G.text, padding: "4px 8px", borderRadius: 4, fontSize: 11, fontFamily: mono, outline: "none" }}
        autoFocus
      />
      <button onClick={() => { onSave(val); setShow(false); }} style={{ background: "#0a1e30", border: `1px solid ${G.blue}`, color: G.blue, padding: "4px 10px", borderRadius: 4, fontSize: 10, fontFamily: mono, cursor: "pointer" }}>Save</button>
      <button onClick={() => setShow(false)} style={{ background: "none", border: "none", color: G.muted, fontSize: 11, fontFamily: mono, cursor: "pointer" }}>✕</button>
    </div>
  );
}

// ─── AI Drop Zone ──────────────────────────────────────────────────────────
function DropZone({ onImport, apiKey }) {
  const [drag, setDrag]     = useState(false);
  const [jobs, setJobs]     = useState([]);
  const ref = useRef();

  const handleFiles = async (files) => {
    if (!files?.length) return;
    if (!apiKey || apiKey === "__skip__") {
      setJobs([{ name: "error", status: "error", msg: "Add your Anthropic API key in the header first." }]);
      return;
    }

    const fileList = Array.from(files);
    setJobs(fileList.map(f => ({ name: f.name, status: "loading", msg: "Analyzing..." })));

    for (let i = 0; i < fileList.length; i++) {
      const file = fileList[i];
      try {
        const text = await file.text();
        const { trades, dateRange } = await parseCSVWithAI(text, apiKey);
        if (trades.length === 0) {
          setJobs(p => p.map((j, idx) => idx === i ? { ...j, status: "error", msg: "No options trades found." } : j));
          continue;
        }
        onImport(trades, { name: file.name, dateRange, count: trades.length, importedAt: new Date().toISOString() });
        setJobs(p => p.map((j, idx) => idx === i ? { ...j, status: "ok", msg: `${trades.length} trade${trades.length !== 1 ? "s" : ""} imported` } : j));
      } catch (e) {
        setJobs(p => p.map((j, idx) => idx === i ? { ...j, status: "error", msg: e.message || "Error — check API key" } : j));
      }
    }
  };

  const colors = { ok: G.accent, error: G.red, loading: G.amber };
  const allDone = jobs.length > 0 && jobs.every(j => j.status !== "loading");
  const anyLoading = jobs.some(j => j.status === "loading");

  return (
    <div style={{ padding: "16px 18px", borderBottom: `1px solid ${G.border}` }}>
      <div
        onClick={() => !anyLoading && ref.current.click()}
        onDragOver={e => { e.preventDefault(); setDrag(true); }}
        onDragLeave={() => setDrag(false)}
        onDrop={e => { e.preventDefault(); setDrag(false); handleFiles(e.dataTransfer.files); }}
        style={{ border: `1.5px dashed ${drag ? G.accent : G.border}`, borderRadius: 7, padding: "18px 12px", textAlign: "center", cursor: anyLoading ? "wait" : "pointer", background: drag ? "#00c89610" : "transparent", transition: "all 0.2s" }}
      >
        <div style={{ fontSize: 20, opacity: 0.4, marginBottom: 6 }}>{anyLoading ? "⏳" : "📂"}</div>
        <div style={{ fontSize: 11, color: G.muted, fontFamily: mono }}>
          {anyLoading ? "Analyzing with AI…" : "Drop one or more broker CSVs"}
        </div>
        <div style={{ fontSize: 9.5, color: G.muted, opacity: 0.5, marginTop: 2, fontFamily: mono }}>
          {anyLoading ? "This takes a few seconds per file" : "Fidelity · Schwab · Tastytrade · IBKR · any broker"}
        </div>
        <input ref={ref} type="file" accept=".csv" multiple style={{ display: "none" }} onChange={e => handleFiles(e.target.files)} />
      </div>

      {jobs.length > 0 && (
        <div style={{ marginTop: 8, display: "flex", flexDirection: "column", gap: 5 }}>
          {jobs.map((j, i) => (
            <div key={i} style={{ fontSize: 10, fontFamily: mono, padding: "5px 10px", borderRadius: 5, display: "flex", justifyContent: "space-between", alignItems: "center", background: j.status === "ok" ? "#0a2a1a" : j.status === "loading" ? "#1a1a0a" : "#2a0808", color: colors[j.status] || G.muted, border: `1px solid ${j.status === "ok" ? "#1a3a2a" : j.status === "loading" ? "#3a3a0a" : "#3a1212"}` }}>
              <span style={{ opacity: 0.7, maxWidth: 160, overflow: "hidden", textOverflow: "ellipsis", whiteSpace: "nowrap" }}>{j.name}</span>
              <span>{j.msg}</span>
            </div>
          ))}
          {allDone && (
            <button onClick={() => setJobs([])} style={{ alignSelf: "flex-end", background: "none", border: "none", color: G.muted, fontSize: 9, fontFamily: mono, cursor: "pointer", textDecoration: "underline", marginTop: 2 }}>clear</button>
          )}
        </div>
      )}

      <div style={{ marginTop: 8, fontSize: 9, color: G.muted, fontFamily: mono, lineHeight: 1.8, opacity: 0.6 }}>
        AI reads any broker format automatically. Upload multiple 90-day exports to cover longer periods.
      </div>
    </div>
  );
}

// ─── File History Panel ────────────────────────────────────────────────────
function FileHistory({ files, onRemove }) {
  if (files.length === 0) return null;

  const fmt = (d) => {
    if (!d) return "?";
    const [y, m, day] = d.split("-");
    const months = ["Jan","Feb","Mar","Apr","May","Jun","Jul","Aug","Sep","Oct","Nov","Dec"];
    return `${months[parseInt(m)-1]} ${parseInt(day)}, ${y}`;
  };

  const allDates = files.flatMap(f => [f.dateRange?.earliest, f.dateRange?.latest]).filter(Boolean).sort();
  const earliest = allDates[0];
  const latest = allDates[allDates.length - 1];

  return (
    <div style={{ background: G.surface, border: `1px solid ${G.border}`, borderRadius: 8, overflow: "hidden" }}>
      <div style={{ background: G.bg, borderBottom: `1px solid ${G.border}`, padding: "11px 18px", display: "flex", alignItems: "center", justifyContent: "space-between" }}>
        <div style={{ fontSize: 9.5, fontWeight: 600, letterSpacing: "0.14em", textTransform: "uppercase", color: G.muted, fontFamily: mono }}>Imported Files</div>
        <span style={{ fontSize: 9, fontFamily: mono, color: G.muted }}>{files.length} file{files.length !== 1 ? "s" : ""}</span>
      </div>

      {earliest && latest && (
        <div style={{ padding: "10px 18px", borderBottom: `1px solid ${G.border}`, background: "#0a1a10" }}>
          <div style={{ fontSize: 9, fontFamily: mono, color: G.muted, marginBottom: 4, letterSpacing: "0.08em", textTransform: "uppercase" }}>Total Coverage</div>
          <div style={{ fontSize: 11, fontFamily: mono, color: G.accent }}>{fmt(earliest)} → {fmt(latest)}</div>
        </div>
      )}

      {files.map((f, i) => (
        <div key={i} style={{ padding: "9px 18px", borderBottom: `1px solid ${G.border}`, display: "flex", alignItems: "center", justifyContent: "space-between", gap: 10 }}>
          <div style={{ minWidth: 0 }}>
            <div style={{ fontSize: 10, fontFamily: mono, color: G.text, overflow: "hidden", textOverflow: "ellipsis", whiteSpace: "nowrap", maxWidth: 200 }}>{f.name}</div>
            <div style={{ fontSize: 9, fontFamily: mono, color: G.muted, marginTop: 2 }}>
              {f.dateRange ? `${fmt(f.dateRange.earliest)} → ${fmt(f.dateRange.latest)}` : "date range unknown"}
              <span style={{ marginLeft: 8, color: G.accent }}>{f.count} trade{f.count !== 1 ? "s" : ""}</span>
            </div>
          </div>
          <button onClick={() => onRemove(i)} style={{ background: "none", border: `1px solid #2a1414`, color: "#5a3030", padding: "2px 7px", borderRadius: 4, fontSize: 9, fontFamily: mono, cursor: "pointer", flexShrink: 0 }}>×</button>
        </div>
      ))}
    </div>
  );
}

// ─── Manual Add Form ───────────────────────────────────────────────────────
const EMPTY = { ticker: "", type: "PUT", strike: "", expiry: "", contracts: "1", premiumPerContract: "", openDate: new Date().toISOString().split("T")[0], notes: "" };

function AddForm({ onAdd }) {
  const [f, setF] = useState(EMPTY);
  const set = (k, v) => setF(p => ({ ...p, [k]: v }));

  const inp = (k, ph, type = "text") => (
    <input type={type} placeholder={ph} value={f[k]} onChange={e => set(k, e.target.value)}
      style={{ width: "100%", background: G.bg, border: `1px solid ${G.border}`, color: G.text, padding: "8px 10px", borderRadius: 5, fontSize: 12, fontFamily: mono, outline: "none" }} />
  );

  const row = (label, children) => (
    <div style={{ marginBottom: 10 }}>
      <label style={{ display: "block", fontSize: 9, letterSpacing: "0.12em", textTransform: "uppercase", color: G.muted, fontFamily: mono, marginBottom: 4 }}>{label}</label>
      {children}
    </div>
  );

  const submit = () => {
    if (!f.ticker || !f.strike || !f.expiry || !f.premiumPerContract) return;
    const contracts = Math.max(1, parseInt(f.contracts) || 1);
    const ppc = parseFloat(f.premiumPerContract) || 0;
    onAdd({ id: Date.now(), ticker: f.ticker.toUpperCase(), type: f.type, strike: parseFloat(f.strike), expiry: f.expiry, contracts, premiumPerContract: ppc, premiumCollected: ppc * contracts * 100, openDate: f.openDate, status: "open", realizedPnl: null, closeDate: null, notes: f.notes });
    setF(EMPTY);
  };

  return (
    <div style={{ padding: "16px 18px" }}>
      <div style={{ display: "grid", gridTemplateColumns: "1fr 1fr", gap: 10 }}>
        <div>{row("Ticker", inp("ticker", "AAPL"))}</div>
        <div>{row("Type",
          <select value={f.type} onChange={e => set("type", e.target.value)} style={{ width: "100%", background: G.bg, border: `1px solid ${G.border}`, color: G.text, padding: "8px 10px", borderRadius: 5, fontSize: 12, fontFamily: mono, outline: "none" }}>
            <option value="PUT">PUT (CSP)</option>
            <option value="CALL">CALL (CC)</option>
          </select>
        )}</div>
        <div>{row("Strike ($)", inp("strike", "150", "number"))}</div>
        <div>{row("Expiry", inp("expiry", "", "date"))}</div>
        <div>{row("Contracts", inp("contracts", "1", "number"))}</div>
        <div>{row("Premium / Contract ($)", inp("premiumPerContract", "2.50", "number"))}</div>
      </div>
      {row("Open Date", inp("openDate", "", "date"))}
      {row("Notes", inp("notes", "Optional"))}
      <button onClick={submit} style={{ width: "100%", background: "#0a1e30", border: `1px solid ${G.blue}`, color: G.blue, padding: "10px 0", borderRadius: 6, fontSize: 11, fontWeight: 600, letterSpacing: "0.1em", fontFamily: mono, cursor: "pointer", textTransform: "uppercase", marginTop: 4 }}>
        + Add Trade
      </button>
    </div>
  );
}

// ─── Close Modal ───────────────────────────────────────────────────────────
function CloseModal({ trade, onClose, onSave }) {
  const [type, setType]       = useState("EXPIRED");
  const [date, setDate]       = useState(new Date().toISOString().split("T")[0]);
  const [buyback, setBuyback] = useState("");

  const save = () => {
    const bb = parseFloat(buyback) || 0;
    const realizedPnl = type === "CLOSED"
      ? trade.premiumCollected - bb * trade.contracts * 100
      : trade.premiumCollected;
    onSave({ ...trade, status: type.toLowerCase(), closeDate: date, buybackPremium: bb, realizedPnl });
  };

  const sel = (v, label) => (
    <button onClick={() => setType(v)} style={{ flex: 1, padding: "8px 6px", borderRadius: 5, border: `1px solid ${type === v ? G.blue : G.border}`, background: type === v ? "#0a1e30" : "transparent", color: type === v ? G.blue : G.muted, fontSize: 10, fontFamily: mono, cursor: "pointer" }}>
      {label}
    </button>
  );

  return (
    <div style={{ position: "fixed", inset: 0, background: "#000000cc", display: "flex", alignItems: "center", justifyContent: "center", zIndex: 100 }} onClick={onClose}>
      <div style={{ background: G.surface, border: `1px solid ${G.border}`, borderRadius: 10, padding: 26, width: 340 }} onClick={e => e.stopPropagation()}>
        <div style={{ fontFamily: mono, fontSize: 13, fontWeight: 600, marginBottom: 18, color: G.text }}>
          Close {trade.ticker} {trade.type} ${trade.strike}
        </div>
        <div style={{ marginBottom: 14 }}>
          <label style={{ display: "block", fontSize: 9, letterSpacing: "0.12em", textTransform: "uppercase", color: G.muted, fontFamily: mono, marginBottom: 6 }}>Outcome</label>
          <div style={{ display: "flex", gap: 8 }}>{sel("EXPIRED","Expired ✓")}{sel("CLOSED","BTC")}{sel("ASSIGNED","Assigned")}</div>
        </div>
        {type === "CLOSED" && (
          <div style={{ marginBottom: 14 }}>
            <label style={{ display: "block", fontSize: 9, letterSpacing: "0.12em", textTransform: "uppercase", color: G.muted, fontFamily: mono, marginBottom: 6 }}>Buyback Premium / Contract ($)</label>
            <input type="number" placeholder="0.25" value={buyback} onChange={e => setBuyback(e.target.value)} style={{ width: "100%", background: G.bg, border: `1px solid ${G.border}`, color: G.text, padding: "8px 10px", borderRadius: 5, fontSize: 12, fontFamily: mono, outline: "none" }} />
          </div>
        )}
        <div style={{ marginBottom: 18 }}>
          <label style={{ display: "block", fontSize: 9, letterSpacing: "0.12em", textTransform: "uppercase", color: G.muted, fontFamily: mono, marginBottom: 6 }}>Close Date</label>
          <input type="date" value={date} onChange={e => setDate(e.target.value)} style={{ width: "100%", background: G.bg, border: `1px solid ${G.border}`, color: G.text, padding: "8px 10px", borderRadius: 5, fontSize: 12, fontFamily: mono, outline: "none" }} />
        </div>
        <div style={{ display: "flex", gap: 10 }}>
          <button onClick={onClose} style={{ flex: 1, padding: "10px", border: `1px solid ${G.border}`, background: "none", color: G.muted, borderRadius: 6, fontSize: 11, fontFamily: mono, cursor: "pointer" }}>Cancel</button>
          <button onClick={save} style={{ flex: 1, padding: "10px", border: `1px solid ${G.blue}`, background: "#0a1e30", color: G.blue, borderRadius: 6, fontSize: 11, fontFamily: mono, cursor: "pointer", fontWeight: 600 }}>Save</button>
        </div>
      </div>
    </div>
  );
}

// ─── Seed data ─────────────────────────────────────────────────────────────
const SEED = [
  { id:1, ticker:"AAPL", type:"PUT",  strike:175, expiry:"2025-08-15", contracts:2, premiumPerContract:3.20, premiumCollected:640,  openDate:"2025-07-10", status:"open",     realizedPnl:null, notes:"Support level" },
  { id:2, ticker:"AAPL", type:"PUT",  strike:170, expiry:"2025-07-18", contracts:2, premiumPerContract:2.10, premiumCollected:420,  openDate:"2025-06-20", status:"expired",  realizedPnl:420,  closeDate:"2025-07-18" },
  { id:3, ticker:"SPY",  type:"PUT",  strike:530, expiry:"2025-08-01", contracts:1, premiumPerContract:5.80, premiumCollected:580,  openDate:"2025-07-05", status:"open",     realizedPnl:null },
  { id:4, ticker:"MSFT", type:"PUT",  strike:420, expiry:"2025-07-25", contracts:1, premiumPerContract:4.50, premiumCollected:450,  openDate:"2025-07-01", status:"closed",   realizedPnl:330,  closeDate:"2025-07-14", buybackPremium:1.20, notes:"BTC 73%" },
  { id:5, ticker:"MSFT", type:"CALL", strike:435, expiry:"2025-08-15", contracts:1, premiumPerContract:3.90, premiumCollected:390,  openDate:"2025-07-16", status:"open",     realizedPnl:null, notes:"CC after assignment" },
  { id:6, ticker:"NVDA", type:"PUT",  strike:115, expiry:"2025-07-18", contracts:3, premiumPerContract:2.75, premiumCollected:825,  openDate:"2025-07-02", status:"assigned", realizedPnl:825,  closeDate:"2025-07-18" },
];

// ─── App ───────────────────────────────────────────────────────────────────
export default function App() {
  const [trades,  setTrades]       = useState(() => lsGet(LS_TRADES, SEED));
  const [capital, setCapital]       = useState(() => lsGet(LS_CAPITAL, 50000));
  const [apiKey,  setApiKey]        = useState(() => lsGet(LS_APIKEY, ""));
  const [importedFiles, setImportedFiles] = useState(() => lsGet(LS_FILES, []));
  const [tab,     setTab]           = useState("open");
  const [closing, setClosing]       = useState(null);
  const [showOnboarding, setShowOnboarding] = useState(() => !lsGet(LS_APIKEY, ""));

  useEffect(() => { lsSet(LS_TRADES,  trades);  }, [trades]);
  useEffect(() => { lsSet(LS_CAPITAL, capital); }, [capital]);
  useEffect(() => { lsSet(LS_APIKEY,  apiKey);  }, [apiKey]);
  useEffect(() => { lsSet(LS_FILES,   importedFiles); }, [importedFiles]);

  const handleApiKeySave = (key) => {
    setApiKey(key);
    setShowOnboarding(false);
  };

  const addTrade     = useCallback(t  => setTrades(p => [t, ...p]), []);
  const importTrades = useCallback((ts, fileMeta) => {
    setTrades(p => [...ts, ...p]);
    if (fileMeta) setImportedFiles(p => [...p, fileMeta]);
  }, []);
  const removeFile   = useCallback(idx => setImportedFiles(p => p.filter((_, i) => i !== idx)), []);
  const closeTrade   = useCallback(u  => { setTrades(p => p.map(t => t.id === u.id ? u : t)); setClosing(null); }, []);
  const deleteTrade  = useCallback(id => setTrades(p => p.filter(t => t.id !== id)), []);

  const stats    = useMemo(() => computeStats(trades, capital), [trades, capital]);
  const filtered = useMemo(() => {
    if (tab === "open")   return trades.filter(t => t.status === "open");
    if (tab === "closed") return trades.filter(t => t.status !== "open");
    return trades;
  }, [trades, tab]);

  const byTicker = useMemo(() => {
    const map = {};
    for (const t of trades) {
      if (!map[t.ticker]) map[t.ticker] = { premium: 0, pnl: 0, open: 0, count: 0 };
      map[t.ticker].premium += t.premiumCollected || 0;
      if (t.realizedPnl != null) map[t.ticker].pnl += t.realizedPnl;
      if (t.status === "open") map[t.ticker].open++;
      map[t.ticker].count++;
    }
    return Object.entries(map).sort((a, b) => b[1].premium - a[1].premium);
  }, [trades]);

  const badge = (txt, bg, color) => (
    <span style={{ display: "inline-flex", alignItems: "center", padding: "2px 7px", borderRadius: 4, fontSize: 9.5, fontWeight: 700, letterSpacing: "0.07em", fontFamily: mono, background: bg, color }}>{txt}</span>
  );

  const statusBadge = (s) => {
    const map = { open: [G.accent,"#0a2418"], expired: [G.blue,"#0a1422"], closed: [G.amber,"#261a06"], assigned: [G.purple,"#1a1026"] };
    const [c, bg] = map[s] || [G.muted, G.border];
    return badge(s.toUpperCase(), bg, c);
  };

  const StatCard = ({ label, value, sub, color, top }) => (
    <div style={{ background: G.surface, border: `1px solid ${G.border}`, borderRadius: 8, padding: "15px 17px", borderTop: `2px solid ${top || color}` }}>
      <div style={{ fontSize: 9, letterSpacing: "0.14em", textTransform: "uppercase", color: G.muted, fontFamily: mono, marginBottom: 7 }}>{label}</div>
      <div style={{ fontFamily: mono, fontWeight: 600, fontSize: 20, color }}>{value}</div>
      {sub && <div style={{ fontSize: 10, color: G.muted, marginTop: 3, fontFamily: mono }}>{sub}</div>}
    </div>
  );

  return (
    <>
      <style>{`@import url('https://fonts.googleapis.com/css2?family=IBM+Plex+Mono:wght@400;500;600;700&family=IBM+Plex+Sans:wght@300;400;500;600&display=swap'); * { box-sizing: border-box; margin: 0; padding: 0; } body { background: ${G.bg}; } ::-webkit-scrollbar { width: 5px; height: 5px; } ::-webkit-scrollbar-track { background: ${G.bg}; } ::-webkit-scrollbar-thumb { background: ${G.border}; border-radius: 3px; } select option { background: ${G.surface}; color: ${G.text}; } .trow:hover td { background: #0c1520 !important; }`}</style>

      <div style={{ minHeight: "100vh", background: G.bg, fontFamily: sans, color: G.text }}>

        {/* Header */}
        <div style={{ background: G.surface, borderBottom: `1px solid ${G.border}`, padding: "0 30px", height: 52, display: "flex", alignItems: "center", justifyContent: "space-between" }}>
          <div style={{ display: "flex", alignItems: "center", gap: 14 }}>
            <div style={{ fontFamily: mono, fontSize: 13, fontWeight: 700, letterSpacing: "0.2em", color: G.accent }}>
              WHEEL<span style={{ color: G.blue }}>.</span>DESK
            </div>
            <div style={{ width: 1, height: 14, background: G.border }} />
            <div style={{ fontSize: 10, color: G.muted, fontFamily: mono, letterSpacing: "0.06em" }}>Options Wheel Tracker</div>
          </div>
          <div style={{ display: "flex", alignItems: "center", gap: 18 }}>
            <ApiKeyBanner apiKey={apiKey} onSave={handleApiKeySave} />
            <div style={{ width: 1, height: 14, background: G.border }} />
            <div style={{ display: "flex", alignItems: "center", gap: 8 }}>
              <div style={{ fontSize: 9.5, color: G.muted, fontFamily: mono }}>CAPITAL BASE</div>
              <input type="number" value={capital} onChange={e => setCapital(parseFloat(e.target.value) || 0)}
                style={{ width: 100, background: G.bg, border: `1px solid ${G.border}`, color: G.text, padding: "5px 9px", borderRadius: 5, fontSize: 11, fontFamily: mono, outline: "none" }} />
            </div>
            <button
              onClick={() => { if (window.confirm("Clear all trades? This cannot be undone.")) { setTrades([]); setImportedFiles([]); lsSet(LS_TRADES, []); lsSet(LS_FILES, []); } }}
              style={{ background: "none", border: `1px solid #2a1414`, color: "#5a3030", padding: "5px 10px", borderRadius: 5, fontSize: 9.5, fontFamily: mono, cursor: "pointer" }}
            >CLEAR ALL</button>
          </div>
        </div>

        <div style={{ maxWidth: 1360, margin: "0 auto", padding: "26px 30px" }}>

          {/* Stats */}
          <div style={{ display: "grid", gridTemplateColumns: "repeat(6, 1fr)", gap: 12, marginBottom: 26 }}>
            <StatCard label="Premium Collected" value={`$${stats.totalPremium.toLocaleString("en-US",{minimumFractionDigits:2,maximumFractionDigits:2})}`} sub={`${trades.length} legs total`} color={G.accent} top={G.accent} />
            <StatCard label="Realized P&L" value={`${stats.realizedPnl >= 0 ? "+" : ""}$${stats.realizedPnl.toLocaleString("en-US",{minimumFractionDigits:2,maximumFractionDigits:2})}`} sub="closed trades" color={stats.realizedPnl >= 0 ? G.accent : G.red} top={G.accent} />
            <StatCard label="Return on Capital" value={`${stats.rocPct >= 0 ? "+" : ""}${stats.rocPct.toFixed(2)}%`} sub={`on $${capital.toLocaleString()} base`} color={stats.rocPct >= 0 ? G.accent : G.red} top={G.blue} />
            <StatCard label="Capital Deployed" value={`$${(stats.capitalDeployed/1000).toFixed(1)}k`} sub={`${stats.openCount} open legs`} color={G.amber} top={G.amber} />
            <StatCard label="Win Rate" value={`${stats.winRate.toFixed(0)}%`} sub="of closed trades" color={stats.winRate >= 70 ? G.accent : G.amber} top={G.purple} />
            <StatCard label="Open Positions" value={stats.openCount} sub={`${trades.filter(t=>t.type==="PUT"&&t.status==="open").length}P · ${trades.filter(t=>t.type==="CALL"&&t.status==="open").length}C`} color={G.blue} top={G.blue} />
          </div>

          {/* Body */}
          <div style={{ display: "grid", gridTemplateColumns: "1fr 350px", gap: 18 }}>

            {/* Table */}
            <div style={{ background: G.surface, border: `1px solid ${G.border}`, borderRadius: 8, overflow: "hidden" }}>
              <div style={{ background: G.bg, borderBottom: `1px solid ${G.border}`, display: "flex", alignItems: "center", justifyContent: "space-between", paddingRight: 18 }}>
                <div style={{ display: "flex" }}>
                  {["open","closed","all"].map(t => (
                    <div key={t} onClick={() => setTab(t)} style={{ padding: "0 16px", height: 42, display: "flex", alignItems: "center", fontSize: 10, fontFamily: mono, letterSpacing: "0.1em", textTransform: "uppercase", cursor: "pointer", color: tab === t ? G.accent : G.muted, borderBottom: `2px solid ${tab === t ? G.accent : "transparent"}`, transition: "all 0.15s" }}>
                      {t}
                    </div>
                  ))}
                </div>
                <div style={{ fontSize: 10, color: G.muted, fontFamily: mono }}>{filtered.length} leg{filtered.length !== 1 ? "s" : ""}</div>
              </div>

              <div style={{ overflowX: "auto" }}>
                <table style={{ width: "100%", borderCollapse: "collapse" }}>
                  <thead>
                    <tr>
                      {["Ticker","Type","Strike","Expiry","DTE","Contracts","Premium/C","Collected","Open Date","P&L","Status",""].map(h => (
                        <th key={h} style={{ padding: "9px 14px", textAlign: "left", fontSize: 9, letterSpacing: "0.1em", textTransform: "uppercase", color: G.muted, fontFamily: mono, fontWeight: 500, borderBottom: `1px solid ${G.border}`, background: G.bg, whiteSpace: "nowrap" }}>{h}</th>
                      ))}
                    </tr>
                  </thead>
                  <tbody>
                    {filtered.length === 0 && (
                      <tr><td colSpan={12} style={{ padding: "48px 0", textAlign: "center", color: G.muted, fontFamily: mono, fontSize: 11 }}>No trades — add one or import a CSV →</td></tr>
                    )}
                    {filtered.map(t => {
                      const dte = daysUntil(t.expiry);
                      const pnl = t.realizedPnl;
                      const td = (children, extra = {}) => <td style={{ padding: "10px 14px", borderBottom: `1px solid #0c1520`, fontFamily: mono, fontSize: 12, whiteSpace: "nowrap", ...extra }}>{children}</td>;
                      return (
                        <tr key={t.id} className="trow">
                          {td(<span style={{ fontWeight: 600, color: G.text }}>{t.ticker}</span>)}
                          {td(badge(t.type, t.type === "PUT" ? "#0a1828" : "#1a0a0a", t.type === "PUT" ? G.blue : G.red))}
                          {td(`$${t.strike}`, { color: G.text })}
                          {td(formatExpiry(t.expiry), { color: G.muted })}
                          {td(t.status === "open" && dte !== null ? (dte < 0 ? <span style={{ color: G.red }}>EXP</span> : `${dte}d`) : "—", { color: dte !== null && dte <= 7 && t.status === "open" ? G.amber : G.muted })}
                          {td(t.contracts, { color: G.muted })}
                          {td(`$${(t.premiumPerContract || 0).toFixed(2)}`, { color: G.text })}
                          {td(`$${(t.premiumCollected || 0).toFixed(2)}`, { color: G.accent })}
                          {td(t.openDate || "—", { color: G.muted })}
                          {td(pnl == null ? "—" : `${pnl >= 0 ? "+" : ""}$${pnl.toFixed(2)}`, { color: pnl == null ? G.muted : pnl >= 0 ? G.accent : G.red })}
                          {td(statusBadge(t.status))}
                          <td style={{ padding: "10px 14px", borderBottom: `1px solid #0c1520`, whiteSpace: "nowrap" }}>
                            <div style={{ display: "flex", gap: 6 }}>
                              {t.status === "open" && (
                                <button onClick={() => setClosing(t)} style={{ background: "none", border: `1px solid #1a2a3a`, color: G.blue, padding: "3px 8px", borderRadius: 4, fontSize: 10, fontFamily: mono, cursor: "pointer" }}>close</button>
                              )}
                              <button onClick={() => deleteTrade(t.id)} style={{ background: "none", border: `1px solid #2a1414`, color: G.red, padding: "3px 7px", borderRadius: 4, fontSize: 10, fontFamily: mono, cursor: "pointer" }}>×</button>
                            </div>
                          </td>
                        </tr>
                      );
                    })}
                  </tbody>
                </table>
              </div>
            </div>

            {/* Sidebar */}
            <div style={{ display: "flex", flexDirection: "column", gap: 16 }}>

              {/* AI Import */}
              <div style={{ background: G.surface, border: `1px solid ${G.border}`, borderRadius: 8, overflow: "hidden" }}>
                <div style={{ background: G.bg, borderBottom: `1px solid ${G.border}`, padding: "11px 18px", display: "flex", alignItems: "center", justifyContent: "space-between" }}>
                  <div style={{ fontSize: 9.5, fontWeight: 600, letterSpacing: "0.14em", textTransform: "uppercase", color: G.muted, fontFamily: mono }}>AI Import — Any Broker</div>
                  <span style={{ fontSize: 9, fontFamily: mono, background: "#0a1e10", color: G.accent, padding: "2px 7px", borderRadius: 10, letterSpacing: "0.06em" }}>AI</span>
                </div>
                <DropZone onImport={importTrades} apiKey={apiKey} />
              </div>

              {/* File history */}
              <FileHistory files={importedFiles} onRemove={removeFile} />

              {/* Manual add */}
              <div style={{ background: G.surface, border: `1px solid ${G.border}`, borderRadius: 8, overflow: "hidden" }}>
                <div style={{ background: G.bg, borderBottom: `1px solid ${G.border}`, padding: "11px 18px" }}>
                  <div style={{ fontSize: 9.5, fontWeight: 600, letterSpacing: "0.14em", textTransform: "uppercase", color: G.muted, fontFamily: mono }}>Manual Entry</div>
                </div>
                <AddForm onAdd={addTrade} />
              </div>

              {/* Ticker breakdown */}
              <div style={{ background: G.surface, border: `1px solid ${G.border}`, borderRadius: 8, overflow: "hidden" }}>
                <div style={{ background: G.bg, borderBottom: `1px solid ${G.border}`, padding: "11px 18px" }}>
                  <div style={{ fontSize: 9.5, fontWeight: 600, letterSpacing: "0.14em", textTransform: "uppercase", color: G.muted, fontFamily: mono }}>By Ticker</div>
                </div>
                {byTicker.length === 0
                  ? <div style={{ padding: 24, textAlign: "center", color: G.muted, fontSize: 11, fontFamily: mono }}>No trades yet</div>
                  : byTicker.map(([ticker, d]) => (
                    <div key={ticker} style={{ display: "flex", alignItems: "center", justifyContent: "space-between", padding: "10px 18px", borderBottom: `1px solid ${G.border}` }}>
                      <div style={{ display: "flex", alignItems: "center", gap: 10 }}>
                        <div style={{ fontFamily: mono, fontWeight: 600, fontSize: 13, color: G.text }}>{ticker}</div>
                        {d.open > 0 && <span style={{ fontSize: 9, fontFamily: mono, background: "#0a2018", color: G.accent, padding: "1px 6px", borderRadius: 10 }}>{d.open} open</span>}
                      </div>
                      <div style={{ textAlign: "right" }}>
                        <div style={{ fontSize: 12, fontFamily: mono, color: G.accent }}>${d.premium.toFixed(2)}</div>
                        <div style={{ fontSize: 9, fontFamily: mono, color: G.muted }}>collected · {d.count} leg{d.count !== 1 ? "s" : ""}</div>
                      </div>
                    </div>
                  ))
                }
              </div>
            </div>
          </div>
        </div>
      </div>

      {showOnboarding && <OnboardingModal onSave={handleApiKeySave} />}
      {closing && <CloseModal trade={closing} onClose={() => setClosing(null)} onSave={closeTrade} />}
    </>
  );
}
