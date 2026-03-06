import { useState, useMemo, useCallback, useRef, useEffect } from "react";

// ─── localStorage helpers ──────────────────────────────────────────────────
const LS_TRADES = "wheeldeskv1_trades";
const LS_CAPITAL = "wheeldeskv1_capital";
const LS_TAX_RATE = "wheeldeskv1_taxrate";
const LS_IMPORTS = "wheeldeskv1_imports";
const lsGet = (key, fallback) => { try { const v = localStorage.getItem(key); return v ? JSON.parse(v) : fallback; } catch { return fallback; } };
const lsSet = (key, val) => { try { localStorage.setItem(key, JSON.stringify(val)); } catch {} };

// ─── Fidelity CSV Parser ───────────────────────────────────────────────────
function parseFidelityCSV(text) {
  const lines = text.split("\n").map(l => l.trim()).filter(Boolean);
  const headerIdx = lines.findIndex(l =>
    l.toLowerCase().includes("action") && l.toLowerCase().includes("symbol")
  );
  if (headerIdx === -1) return { trades: [], errors: ["Could not find header row. Make sure this is a Fidelity Activity CSV export."] };

  const headers = lines[headerIdx].split(",").map(h => h.replace(/"/g, "").trim().toLowerCase());
  const col = (row, name) => {
    let idx = headers.findIndex(h => h === name);
    if (idx < 0) idx = headers.findIndex(h => h.includes(name));
    return idx >= 0 ? (row[idx] || "").replace(/"/g, "").trim() : "";
  };

  const parseDate = (raw) => {
    if (!raw) return "";
    const d = new Date(raw);
    return !isNaN(d.getTime()) ? d.toISOString().split("T")[0] : "";
  };

  const parseRow = (raw) => {
    const row = [];
    let cur = "", inQ = false;
    for (const ch of raw + ",") {
      if (ch === '"') { inQ = !inQ; }
      else if (ch === "," && !inQ) { row.push(cur.trim()); cur = ""; }
      else cur += ch;
    }
    return row;
  };

  const parseOptSymbol = (symbol) => {
    const m = symbol.replace(/^-/, "").match(/^([A-Z]{1,6})(\d{6})([CP])(\d+(?:\.\d+)?)$/);
    if (!m) return null;
    const [, ticker, expRaw, cpFlag, strikeRaw] = m;
    return {
      ticker,
      expiry: `20${expRaw.slice(0,2)}-${expRaw.slice(2,4)}-${expRaw.slice(4,6)}`,
      type: cpFlag === "P" ? "PUT" : "CALL",
      strike: parseFloat(strikeRaw),
      key: symbol.replace(/^-/, ""),
    };
  };

  // First pass: collect all option rows
  const opens = new Map();   // key -> trade object
  const closers = [];        // closing/expired/assigned rows

  for (let i = headerIdx + 1; i < lines.length; i++) {
    const raw = lines[i];
    if (!raw || raw.startsWith(",,") || raw.toLowerCase().includes("total")) continue;

    const row = parseRow(raw);
    const action = col(row, "action").toLowerCase();
    const symbol = col(row, "symbol").toUpperCase();
    const amount = parseFloat(col(row, "amount").replace(/[$,]/g, "")) || 0;
    const date = parseDate(col(row, "run date") || col(row, "date"));
    const qty = parseFloat(col(row, "quantity")) || 0;

    if (!symbol || !action) continue;
    const opt = parseOptSymbol(symbol);
    if (!opt) continue;

    if (action.includes("sold opening transaction")) {
      const contracts = Math.abs(qty);
      const premiumPerContract = contracts > 0 ? Math.abs(amount) / contracts / 100 : 0;
      opens.set(opt.key, {
        id: Date.now() + Math.random(),
        ticker: opt.ticker, type: opt.type, strike: opt.strike, expiry: opt.expiry,
        contracts, premiumPerContract,
        premiumCollected: Math.abs(amount),
        openDate: date, status: "open", realizedPnl: null, closeDate: null, notes: ""
      });
    } else if (
      action.includes("bought closing transaction") ||
      action.startsWith("expired") ||
      action.startsWith("assigned")
    ) {
      let status = "closed";
      if (action.startsWith("expired")) status = "expired";
      if (action.startsWith("assigned")) status = "assigned";
      closers.push({ key: opt.key, status, amount: Math.abs(amount), date });
    }
  }

  // Second pass: apply closers to matching opens
  for (const { key, status, amount, date } of closers) {
    const trade = opens.get(key);
    if (!trade) continue;
    const buyback = status === "closed" ? amount : 0;
    trade.status = status;
    trade.closeDate = date;
    trade.realizedPnl = trade.premiumCollected - buyback;
    if (status === "closed") trade.buybackPremium = trade.contracts > 0 ? buyback / trade.contracts / 100 : 0;
  }

  // Third pass: auto-expire any still-open trades whose expiry date has passed
  const today = new Date();
  today.setHours(0, 0, 0, 0);
  for (const trade of opens.values()) {
    if (trade.status === "open" && trade.expiry) {
      const expDate = new Date(trade.expiry);
      if (expDate < today) {
        trade.status = "expired";
        trade.closeDate = trade.expiry;
        trade.realizedPnl = trade.premiumCollected;
      }
    }
  }

  const trades = [...opens.values()];
  const errors = [];
  if (trades.length === 0 && closers.length === 0) errors.push("No options trades found. Export Account Activity (not Positions) from Fidelity.");
  return { trades, closers, errors };
}

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

function computeStats(trades, capitalBase, taxRate) {
  const open = trades.filter(t => t.status === "open");
  const closed = trades.filter(t => t.status !== "open");
  const totalPremium = trades.reduce((s, t) => s + (t.premiumCollected || 0), 0);
  const realizedPnl = closed.reduce((s, t) => s + (t.realizedPnl || 0), 0);

  // Open PUTs: cash reserved (cash-secured puts)
  const openPutDeployed = open.filter(t => t.type === "PUT").reduce((s, t) => s + t.strike * t.contracts * 100, 0);

  // Assigned PUTs: stock held at cost basis
  // A: Auto-net against assigned CALLs (stock called away via CC assignment), oldest PUT first
  // B: Manual stockSold flag — user explicitly marked stock as sold, skip entirely
  const assignedCallContractsByTicker = {};
  for (const t of trades.filter(t => t.type === "CALL" && t.status === "assigned")) {
    assignedCallContractsByTicker[t.ticker] = (assignedCallContractsByTicker[t.ticker] || 0) + t.contracts;
  }
  const remainingCallContracts = { ...assignedCallContractsByTicker };
  const assignedPuts = trades
    .filter(t => t.type === "PUT" && t.status === "assigned" && !t.stockSold)
    .sort((a, b) => new Date(a.closeDate || a.openDate) - new Date(b.closeDate || b.openDate));
  let assignedDeployed = 0;
  let assignedCount = 0;
  const assignedTrades = [];
  for (const t of assignedPuts) {
    const calledAway = Math.min(t.contracts, remainingCallContracts[t.ticker] || 0);
    remainingCallContracts[t.ticker] = (remainingCallContracts[t.ticker] || 0) - calledAway;
    const stillHeld = t.contracts - calledAway;
    if (stillHeld > 0) {
      assignedDeployed += t.strike * stillHeld * 100;
      assignedCount++;
      assignedTrades.push({ ...t, heldContracts: stillHeld });
    }
  }

  const capitalDeployed = openPutDeployed + assignedDeployed;
  const rocPct = capitalBase > 0 ? (realizedPnl / capitalBase) * 100 : 0;
  const taxLiability = realizedPnl > 0 ? realizedPnl * (taxRate / 100) : 0;
  const afterTaxPnl = realizedPnl - taxLiability;

  // Annualized ROC: scale realized ROC to a full year based on days since first trade
  let annualizedRoc = 0;
  if (capitalBase > 0 && trades.length > 0) {
    const dates = trades.map(t => t.openDate).filter(Boolean).map(d => new Date(d)).filter(d => !isNaN(d));
    if (dates.length > 0) {
      const earliest = new Date(Math.min(...dates));
      const daysElapsed = Math.max(1, (Date.now() - earliest) / 86400000);
      annualizedRoc = (realizedPnl / capitalBase) * (365 / daysElapsed) * 100;
    }
  }

  return { totalPremium, realizedPnl, capitalDeployed, openCount: open.length, assignedCount, assignedTrades, rocPct, annualizedRoc, taxLiability, afterTaxPnl };
}

// ─── Design tokens ─────────────────────────────────────────────────────────
const G = {
  bg: "#05080c", surface: "#090d12", border: "#131c26", borderHover: "#1e2d3d",
  text: "#c5d3df", muted: "#3a5068", accent: "#00c896", blue: "#4b9ef5",
  amber: "#f5a623", red: "#f07070", purple: "#b08af5",
};

const mono = "'IBM Plex Mono', monospace";
const sans = "'IBM Plex Sans', sans-serif";

// ─── Sub-components ─────────────────────────────────────────────────────────
function DropZone({ onImport }) {
  const [drag, setDrag] = useState(false);
  const [msg, setMsg] = useState(null);
  const ref = useRef();

  const handle = (file) => {
    if (!file) return;
    const reader = new FileReader();
    reader.onload = (e) => {
      try {
        const { trades, closers, errors } = parseFidelityCSV(e.target.result);
        if (errors.length && !trades.length && !closers.length) { setMsg({ ok: false, text: errors[0] }); return; }
        onImport(trades, closers);
        setMsg({ ok: true, text: `Imported ${trades.length} trade${trades.length !== 1 ? "s" : ""}${closers.length ? `, updated ${closers.length} existing` : ""}` });
      } catch (err) {
        setMsg({ ok: false, text: `Parse error: ${err.message}` });
      }
    };
    reader.readAsText(file);
  };

  return (
    <div style={{ padding: "16px 18px", borderBottom: `1px solid ${G.border}` }}>
      <div
        onClick={() => ref.current.click()}
        onDragOver={e => { e.preventDefault(); setDrag(true); }}
        onDragLeave={() => setDrag(false)}
        onDrop={e => { e.preventDefault(); setDrag(false); handle(e.dataTransfer.files[0]); }}
        style={{ border: `1.5px dashed ${drag ? G.accent : G.border}`, borderRadius: 7, padding: "18px 12px", textAlign: "center", cursor: "pointer", background: drag ? "#00c89610" : "transparent", transition: "all 0.2s" }}
      >
        <div style={{ fontSize: 20, opacity: 0.4, marginBottom: 6 }}>📂</div>
        <div style={{ fontSize: 11, color: G.muted, fontFamily: mono }}>Drop Fidelity Activity CSV</div>
        <div style={{ fontSize: 9.5, color: G.muted, opacity: 0.5, marginTop: 2, fontFamily: mono }}>or click to browse</div>
        <input ref={ref} type="file" accept=".csv" style={{ display: "none" }} onChange={e => handle(e.target.files[0])} />
      </div>
      {msg && (
        <div style={{ marginTop: 8, fontSize: 10, fontFamily: mono, padding: "6px 10px", borderRadius: 5, background: msg.ok ? "#0a2a1a" : "#2a0808", color: msg.ok ? G.accent : G.red, border: `1px solid ${msg.ok ? "#1a3a2a" : "#3a1212"}` }}>
          {msg.text}
        </div>
      )}
      <div style={{ marginTop: 8, fontSize: 9, color: G.muted, fontFamily: mono, lineHeight: 1.8, opacity: 0.7 }}>
        Fidelity → Accounts &amp; Trade → Activity &amp; Orders → Download CSV
      </div>
    </div>
  );
}

const EMPTY = { ticker: "", type: "PUT", strike: "", expiry: "", contracts: "1", premiumPerContract: "", openDate: new Date().toISOString().split("T")[0], notes: "" };

function AddForm({ onAdd }) {
  const [f, setF] = useState(EMPTY);
  const set = (k, v) => setF(p => ({ ...p, [k]: v }));

  const inp = (k, ph, type = "text") => (
    <input
      type={type} placeholder={ph} value={f[k]} onChange={e => set(k, e.target.value)}
      style={{ width: "100%", background: G.bg, border: `1px solid ${G.border}`, color: G.text, padding: "8px 10px", borderRadius: 5, fontSize: 12, fontFamily: mono, outline: "none" }}
    />
  );

  const submit = () => {
    if (!f.ticker || !f.strike || !f.expiry || !f.premiumPerContract) return;
    const contracts = Math.max(1, parseInt(f.contracts) || 1);
    const ppc = parseFloat(f.premiumPerContract) || 0;
    onAdd({ id: Date.now(), ticker: f.ticker.toUpperCase(), type: f.type, strike: parseFloat(f.strike), expiry: f.expiry, contracts, premiumPerContract: ppc, premiumCollected: ppc * contracts * 100, openDate: f.openDate, status: "open", realizedPnl: null, closeDate: null, notes: f.notes });
    setF(EMPTY);
  };

  const row = (label, children) => (
    <div style={{ marginBottom: 10 }}>
      <label style={{ display: "block", fontSize: 9, letterSpacing: "0.12em", textTransform: "uppercase", color: G.muted, fontFamily: mono, marginBottom: 4 }}>{label}</label>
      {children}
    </div>
  );

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

function CloseModal({ trade, onClose, onSave }) {
  const [type, setType] = useState("EXPIRED");
  const [date, setDate] = useState(new Date().toISOString().split("T")[0]);
  const [buyback, setBuyback] = useState("");

  const save = () => {
    const bb = parseFloat(buyback) || 0;
    const realizedPnl = type === "CLOSED"
      ? trade.premiumCollected - bb * trade.contracts * 100
      : trade.premiumCollected;
    onSave({ ...trade, status: type.toLowerCase(), closeDate: date, buybackPremium: bb, realizedPnl });
  };

  const sel = (v, label) => (
    <button onClick={() => setType(v)} style={{ flex: 1, padding: "8px 6px", borderRadius: 5, border: `1px solid ${type === v ? G.blue : G.border}`, background: type === v ? "#0a1e30" : "transparent", color: type === v ? G.blue : G.muted, fontSize: 10, fontFamily: mono, cursor: "pointer", letterSpacing: "0.06em" }}>
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
          <div style={{ display: "flex", gap: 8 }}>
            {sel("EXPIRED", "Expired ✓")}
            {sel("CLOSED", "BTC")}
            {sel("ASSIGNED", "Assigned")}
          </div>
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


function ImportHistoryModal({ imports, onClose }) {
  return (
    <div style={{ position: "fixed", inset: 0, background: "#000000cc", display: "flex", alignItems: "center", justifyContent: "center", zIndex: 100 }} onClick={onClose}>
      <div style={{ background: G.surface, border: `1px solid ${G.border}`, borderRadius: 10, width: 520, maxHeight: "70vh", display: "flex", flexDirection: "column", overflow: "hidden" }} onClick={e => e.stopPropagation()}>
        {/* Header */}
        <div style={{ background: G.bg, borderBottom: `1px solid ${G.border}`, padding: "14px 20px", display: "flex", alignItems: "center", justifyContent: "space-between" }}>
          <div style={{ fontFamily: mono, fontSize: 11, fontWeight: 600, letterSpacing: "0.14em", textTransform: "uppercase", color: G.text }}>Imported Files</div>
          <button onClick={onClose} style={{ background: "none", border: "none", color: G.muted, fontSize: 16, cursor: "pointer", lineHeight: 1, padding: "0 2px" }}>✕</button>
        </div>
        {/* List */}
        <div style={{ overflowY: "auto", flex: 1 }}>
          {imports.length === 0 ? (
            <div style={{ padding: "40px 20px", textAlign: "center", color: G.muted, fontFamily: mono, fontSize: 11 }}>No files imported yet</div>
          ) : (
            [...imports].reverse().map((imp, i) => (
              <div key={imp.id} style={{ display: "flex", alignItems: "center", justifyContent: "space-between", padding: "13px 20px", borderBottom: `1px solid ${G.border}` }}>
                <div style={{ display: "flex", alignItems: "center", gap: 12 }}>
                  <div style={{ fontSize: 16, opacity: 0.5 }}>📄</div>
                  <div>
                    <div style={{ fontFamily: mono, fontSize: 12, color: G.text, fontWeight: 500 }}>{imp.filename}</div>
                    <div style={{ fontFamily: mono, fontSize: 10, color: G.muted, marginTop: 2 }}>{imp.date}</div>
                  </div>
                </div>
                <div style={{ textAlign: "right" }}>
                  <div style={{ fontFamily: mono, fontSize: 11, color: G.accent }}>{imp.tradeCount} trade{imp.tradeCount !== 1 ? "s" : ""}</div>
                  {imp.closerCount > 0 && <div style={{ fontFamily: mono, fontSize: 10, color: G.muted, marginTop: 1 }}>{imp.closerCount} updated</div>}
                </div>
              </div>
            ))
          )}
        </div>
      </div>
    </div>
  );
}

// ─── Assigned Stock Modal ───────────────────────────────────────────────────
function AssignedStockModal({ trades, onMarkSold, onClose }) {
  const [prices, setPrices] = useState({});
  const [loading, setLoading] = useState(true);

  useEffect(() => {
    const tickers = [...new Set(trades.map(t => t.ticker))];
    if (tickers.length === 0) { setLoading(false); return; }
    Promise.all(
      tickers.map(ticker =>
        fetch(`https://query1.finance.yahoo.com/v8/finance/chart/${ticker}?interval=1d&range=1d`)
          .then(r => r.json())
          .then(d => [ticker, d?.chart?.result?.[0]?.meta?.regularMarketPrice ?? null])
          .catch(() => [ticker, null])
      )
    ).then(results => {
      setPrices(Object.fromEntries(results));
      setLoading(false);
    });
  }, []);

  const totalCostBasis = trades.reduce((s, t) => s + t.strike * t.heldContracts * 100, 0);
  const priceLoadedTickers = Object.keys(prices).filter(k => prices[k] != null);
  const totalCurrentValue = trades
    .filter(t => priceLoadedTickers.includes(t.ticker))
    .reduce((s, t) => s + prices[t.ticker] * t.heldContracts * 100, 0);
  const allPricesLoaded = !loading && trades.every(t => prices[t.ticker] != null);

  const fmtDate = (d) => {
    if (!d) return "—";
    const dt = new Date(d);
    return isNaN(dt) ? d : dt.toLocaleDateString("en-US", { month: "short", day: "numeric", year: "2-digit" });
  };

  return (
    <div style={{ position: "fixed", inset: 0, background: "rgba(0,0,0,0.7)", zIndex: 200, display: "flex", alignItems: "center", justifyContent: "center" }} onClick={onClose}>
      <div style={{ background: G.surface, border: `1px solid ${G.border}`, borderRadius: 10, width: 780, maxHeight: "80vh", overflow: "hidden", display: "flex", flexDirection: "column" }} onClick={e => e.stopPropagation()}>

        {/* Header */}
        <div style={{ background: G.bg, borderBottom: `1px solid ${G.border}`, padding: "14px 20px", display: "flex", justifyContent: "space-between", alignItems: "center" }}>
          <div>
            <div style={{ fontFamily: mono, fontSize: 11, fontWeight: 700, letterSpacing: "0.12em", color: G.amber }}>ASSIGNED STOCK POSITIONS</div>
            <div style={{ fontFamily: mono, fontSize: 9.5, color: G.muted, marginTop: 2 }}>currently counting toward capital deployed · mark as sold to remove</div>
          </div>
          <button onClick={onClose} style={{ background: "none", border: "none", color: G.muted, fontSize: 20, cursor: "pointer", padding: "0 4px", lineHeight: 1 }}>×</button>
        </div>

        {/* Table */}
        <div style={{ overflowY: "auto", flex: 1 }}>
          {trades.length === 0
            ? <div style={{ padding: "40px 20px", textAlign: "center", color: G.muted, fontFamily: mono, fontSize: 11 }}>No assigned positions currently counted</div>
            : (
            <table style={{ width: "100%", borderCollapse: "collapse" }}>
              <thead>
                <tr>
                  {["Ticker", "Assigned On", "Shares", "Cost / Share", "Cost Basis", "Current Price", "Mkt Value", "Unrealized", ""].map(h => (
                    <th key={h} style={{ padding: "8px 14px", textAlign: "left", fontSize: 9, letterSpacing: "0.1em", textTransform: "uppercase", color: G.muted, fontFamily: mono, fontWeight: 500, borderBottom: `1px solid ${G.border}`, background: G.bg, whiteSpace: "nowrap" }}>{h}</th>
                  ))}
                </tr>
              </thead>
              <tbody>
                {trades.map(t => {
                  const shares = t.heldContracts * 100;
                  const costBasis = t.strike * shares;
                  const currentPrice = prices[t.ticker] ?? null;
                  const mktValue = currentPrice != null ? currentPrice * shares : null;
                  const unrealized = mktValue != null ? mktValue - costBasis : null;
                  const td = (children, extra = {}) => (
                    <td style={{ padding: "11px 14px", borderBottom: `1px solid ${G.border}`, fontFamily: mono, fontSize: 12, whiteSpace: "nowrap", ...extra }}>{children}</td>
                  );
                  return (
                    <tr key={t.id} className="trow">
                      {td(<span style={{ fontWeight: 700, color: G.text }}>{t.ticker}</span>)}
                      {td(fmtDate(t.closeDate), { color: G.muted, fontSize: 11 })}
                      {td(shares.toLocaleString(), { color: G.muted })}
                      {td(`$${t.strike.toFixed(2)}`, { color: G.text })}
                      {td(`$${costBasis.toLocaleString("en-US", { minimumFractionDigits: 0, maximumFractionDigits: 0 })}`, { color: G.amber })}
                      {td(
                        loading
                          ? <span style={{ color: G.muted, opacity: 0.5 }}>…</span>
                          : currentPrice != null ? `$${currentPrice.toFixed(2)}` : <span style={{ color: G.muted }}>—</span>,
                        { color: G.text }
                      )}
                      {td(mktValue != null ? `$${mktValue.toLocaleString("en-US", { minimumFractionDigits: 0, maximumFractionDigits: 0 })}` : <span style={{ color: G.muted }}>—</span>, { color: G.text })}
                      {td(
                        unrealized != null
                          ? `${unrealized >= 0 ? "+" : ""}$${unrealized.toLocaleString("en-US", { minimumFractionDigits: 0, maximumFractionDigits: 0 })}`
                          : <span style={{ color: G.muted }}>—</span>,
                        { color: unrealized == null ? G.muted : unrealized >= 0 ? G.accent : G.red }
                      )}
                      <td style={{ padding: "11px 14px", borderBottom: `1px solid ${G.border}`, whiteSpace: "nowrap" }}>
                        <button
                          onClick={() => onMarkSold(t.id, true)}
                          style={{ background: "none", border: `1px solid #2a1a00`, color: G.amber, padding: "3px 9px", borderRadius: 4, fontSize: 10, fontFamily: mono, cursor: "pointer" }}
                        >sold</button>
                      </td>
                    </tr>
                  );
                })}
              </tbody>
            </table>
          )}
        </div>

        {/* Footer totals */}
        <div style={{ background: G.bg, borderTop: `1px solid ${G.border}`, padding: "12px 20px", display: "flex", justifyContent: "space-between", alignItems: "center" }}>
          <div style={{ fontFamily: mono, fontSize: 10, color: G.muted }}>
            {trades.length} position{trades.length !== 1 ? "s" : ""} · {trades.reduce((s, t) => s + t.heldContracts * 100, 0).toLocaleString()} shares total
          </div>
          <div style={{ display: "flex", gap: 24 }}>
            <div style={{ textAlign: "right" }}>
              <div style={{ fontFamily: mono, fontSize: 9, color: G.muted, letterSpacing: "0.08em", marginBottom: 2 }}>COST BASIS</div>
              <div style={{ fontFamily: mono, fontSize: 13, color: G.amber, fontWeight: 600 }}>${totalCostBasis.toLocaleString("en-US", { minimumFractionDigits: 0, maximumFractionDigits: 0 })}</div>
            </div>
            {allPricesLoaded && (
              <div style={{ textAlign: "right" }}>
                <div style={{ fontFamily: mono, fontSize: 9, color: G.muted, letterSpacing: "0.08em", marginBottom: 2 }}>MKT VALUE</div>
                <div style={{ fontFamily: mono, fontSize: 13, color: G.text, fontWeight: 600 }}>${totalCurrentValue.toLocaleString("en-US", { minimumFractionDigits: 0, maximumFractionDigits: 0 })}</div>
              </div>
            )}
          </div>
        </div>
      </div>
    </div>
  );
}

// ─── App ───────────────────────────────────────────────────────────────────
export default function App() {
  const [trades, setTrades] = useState(() => lsGet(LS_TRADES, []));
  const [tab, setTab] = useState("open");
  const [closing, setClosing] = useState(null);
  const [capital, setCapital] = useState(() => lsGet(LS_CAPITAL, 50000));
  const [taxRate, setTaxRate] = useState(() => lsGet(LS_TAX_RATE, 30));
  const [imports, setImports] = useState(() => lsGet(LS_IMPORTS, []));
  const [viewImports, setViewImports] = useState(false);
  const [showAssignedModal, setShowAssignedModal] = useState(false);
  const [toast, setToast] = useState(null);
  const csvInputRef = useRef();

  useEffect(() => { lsSet(LS_TRADES, trades); }, [trades]);
  useEffect(() => { lsSet(LS_CAPITAL, capital); }, [capital]);
  useEffect(() => { lsSet(LS_TAX_RATE, taxRate); }, [taxRate]);
  useEffect(() => { lsSet(LS_IMPORTS, imports); }, [imports]);

  const showToast = useCallback((msg, ok = true) => {
    setToast({ msg, ok });
    setTimeout(() => setToast(null), 3500);
  }, []);

  const tradeKey = (t) => {
    const yy = t.expiry?.slice(2,4) ?? "";
    const mm = t.expiry?.slice(5,7) ?? "";
    const dd = t.expiry?.slice(8,10) ?? "";
    const cp = t.type === "PUT" ? "P" : "C";
    return `${t.ticker}${yy}${mm}${dd}${cp}${t.strike}`;
  };

  const addTrade = useCallback(t => setTrades(p => [t, ...p]), []);
  const importTrades = useCallback((imported, closers = []) => setTrades(prev => {
    // Build a map of existing open trades by symbol key
    const existingByKey = new Map(prev.filter(t => t.status === "open").map(t => [tradeKey(t), t]));
    // Apply closers to existing trades
    const updatedIds = new Set();
    const updates = {};
    for (const { key, status, amount, date } of closers) {
      const existing = existingByKey.get(key);
      if (existing) {
        const buyback = status === "closed" ? amount : 0;
        updates[existing.id] = {
          ...existing,
          status,
          closeDate: date,
          realizedPnl: existing.premiumCollected - buyback,
          ...(status === "closed" ? { buybackPremium: existing.contracts > 0 ? buyback / existing.contracts / 100 : 0 } : {}),
        };
        updatedIds.add(existing.id);
      }
    }
    const merged = prev.map(t => updates[t.id] ?? t);
    return [...imported, ...merged];
  }), []);
  const closeTrade = useCallback(u => { setTrades(p => p.map(t => t.id === u.id ? u : t)); setClosing(null); }, []);
  const deleteTrade = useCallback(id => setTrades(p => p.filter(t => t.id !== id)), []);
  const markStockSold = useCallback((id, sold) => setTrades(p => p.map(t => t.id === id ? { ...t, stockSold: sold } : t)), []);

  const handleCSVFile = useCallback((file) => {
    if (!file) return;
    const reader = new FileReader();
    reader.onload = (e) => {
      try {
        const { trades: imported, closers, errors } = parseFidelityCSV(e.target.result);
        if (errors.length && !imported.length && !closers.length) { showToast(errors[0], false); return; }
        importTrades(imported, closers);
        setImports(prev => [...prev, {
          id: Date.now(),
          filename: file.name,
          date: new Date().toLocaleString("en-US", { month: "short", day: "numeric", year: "numeric", hour: "numeric", minute: "2-digit" }),
          tradeCount: imported.length,
          closerCount: closers.length,
        }]);
        showToast(`✓ Upload successful · ${imported.length} trade${imported.length !== 1 ? "s" : ""} imported${closers.length ? `, ${closers.length} updated` : ""}`);
      } catch (err) {
        showToast(`Parse error: ${err.message}`, false);
      }
    };
    reader.readAsText(file);
  }, [importTrades, showToast]);

  const stats = useMemo(() => computeStats(trades, capital, taxRate), [trades, capital, taxRate]);
  const filtered = useMemo(() => {
    if (tab === "open") return trades.filter(t => t.status === "open");
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
    <div style={{ background: G.surface, border: `1px solid ${G.border}`, borderRadius: 8, padding: "15px 17px", borderTop: `2px solid ${top || color}`, position: "relative" }}>
      <div style={{ fontSize: 9, letterSpacing: "0.14em", textTransform: "uppercase", color: G.muted, fontFamily: mono, marginBottom: 7 }}>{label}</div>
      <div style={{ fontFamily: mono, fontWeight: 600, fontSize: 21, color }}>{value}</div>
      {sub && <div style={{ fontSize: 10, color: G.muted, marginTop: 3, fontFamily: mono }}>{sub}</div>}
    </div>
  );

  return (
    <>
      <style>{`
        @import url('https://fonts.googleapis.com/css2?family=IBM+Plex+Mono:wght@400;500;600;700&family=IBM+Plex+Sans:wght@300;400;500;600&display=swap');
        * { box-sizing: border-box; margin: 0; padding: 0; }
        html, body, #root { width: 100%; min-height: 100vh; }
        body { background: ${G.bg}; }
        ::-webkit-scrollbar { width: 5px; height: 5px; }
        ::-webkit-scrollbar-track { background: ${G.bg}; }
        ::-webkit-scrollbar-thumb { background: ${G.border}; border-radius: 3px; }
        select option { background: ${G.surface}; color: ${G.text}; }
        .trow:hover td { background: #0c1520 !important; }
        input[type=number]::-webkit-inner-spin-button { opacity: 0.3; }
        .stats-grid { display: grid; grid-template-columns: repeat(8, 1fr); gap: 12px; margin-bottom: 26px; }
        .body-grid { display: grid; grid-template-columns: 1fr 220px 280px; gap: 18px; }
        @media (max-width: 1400px) { .stats-grid { grid-template-columns: repeat(4, 1fr); } }
        @media (max-width: 900px) { .stats-grid { grid-template-columns: repeat(3, 1fr); } }
        @media (max-width: 1100px) { .body-grid { grid-template-columns: 1fr 220px; } }
        @media (max-width: 768px) { .stats-grid { grid-template-columns: repeat(2, 1fr); } .body-grid { grid-template-columns: 1fr; } }
      `}</style>
      <div style={{ width: "100%", minHeight: "100vh", background: G.bg, fontFamily: sans, color: G.text }}>

        {/* Header */}
        <div style={{ background: G.surface, borderBottom: `1px solid ${G.border}`, padding: "0 20px", height: 50, display: "flex", alignItems: "center", justifyContent: "space-between" }}>
          <div style={{ display: "flex", alignItems: "center", gap: 14 }}>
            <div style={{ fontFamily: mono, fontSize: 13, fontWeight: 700, letterSpacing: "0.2em", color: G.accent }}>
              WHEEL<span style={{ color: G.blue }}>.</span>DESK
            </div>
            <div style={{ width: 1, height: 14, background: G.border }} />
            <div style={{ fontSize: 10, color: G.muted, fontFamily: mono, letterSpacing: "0.06em" }}>Options Wheel Tracker</div>
            <div style={{ fontSize: 9, color: G.muted, fontFamily: mono }}>v{__APP_VERSION__}</div>
          </div>
          <div style={{ display: "flex", alignItems: "center", gap: 14 }}>
            <div style={{ display: "flex", alignItems: "center", gap: 8 }}>
              <div style={{ fontSize: 9.5, color: G.muted, fontFamily: mono }}>CAPITAL BASE</div>
              <input type="number" value={capital} onChange={e => setCapital(parseFloat(e.target.value) || 0)}
                style={{ width: 100, background: G.bg, border: `1px solid ${G.border}`, color: G.text, padding: "5px 9px", borderRadius: 5, fontSize: 11, fontFamily: mono, outline: "none" }} />
            </div>
            <div style={{ width: 1, height: 16, background: G.border }} />
            <div style={{ display: "flex", alignItems: "center", gap: 8 }}>
              <div style={{ fontSize: 9.5, color: G.muted, fontFamily: mono }}>TAX RATE</div>
              <div style={{ display: "flex", alignItems: "center", gap: 4 }}>
                <input type="number" min="0" max="100" value={taxRate} onChange={e => setTaxRate(parseFloat(e.target.value) || 0)}
                  style={{ width: 60, background: G.bg, border: `1px solid ${G.border}`, color: G.text, padding: "5px 9px", borderRadius: 5, fontSize: 11, fontFamily: mono, outline: "none" }} />
                <div style={{ fontSize: 11, color: G.muted, fontFamily: mono }}>%</div>
              </div>
            </div>
            <div style={{ width: 1, height: 16, background: G.border }} />
            {imports.length > 0 && (
              <button onClick={() => setViewImports(true)}
                style={{ background: "#0a1a2a", border: `1px solid ${G.border}`, color: G.muted, padding: "5px 12px", borderRadius: 5, fontSize: 9.5, fontFamily: mono, cursor: "pointer", letterSpacing: "0.06em" }}
              >VIEW IMPORTED <span style={{ background: G.border, color: G.text, borderRadius: 3, padding: "1px 5px", marginLeft: 4, fontSize: 9 }}>{imports.length}</span></button>
            )}
            <input ref={csvInputRef} type="file" accept=".csv" multiple style={{ display: "none" }} onChange={e => { Array.from(e.target.files).forEach(f => handleCSVFile(f)); e.target.value = ""; }} />
            <button onClick={() => csvInputRef.current.click()}
              style={{ background: "#0a1a2a", border: `1px solid ${G.blue}50`, color: G.blue, padding: "5px 12px", borderRadius: 5, fontSize: 9.5, fontFamily: mono, cursor: "pointer", letterSpacing: "0.06em" }}
            >↑ IMPORT CSV</button>
            <button
              onClick={() => { if (window.confirm("Clear all trades and reset? This cannot be undone.")) { setTrades([]); lsSet(LS_TRADES, []); } }}
              style={{ background: "none", border: `1px solid #2a1414`, color: "#5a3030", padding: "5px 10px", borderRadius: 5, fontSize: 9.5, fontFamily: mono, cursor: "pointer", letterSpacing: "0.06em" }}
            >CLEAR ALL</button>
          </div>
        </div>

        {/* Toast */}
        {toast && (
          <div style={{ position: "fixed", bottom: 24, right: 24, zIndex: 1000, background: toast.ok ? "#0a2a1a" : "#2a0808", border: `1px solid ${toast.ok ? "#1a3a2a" : "#3a1212"}`, color: toast.ok ? G.accent : G.red, padding: "10px 16px", borderRadius: 7, fontFamily: mono, fontSize: 11, boxShadow: "0 4px 20px rgba(0,0,0,0.4)" }}>
            {toast.msg}
          </div>
        )}

        <div style={{ padding: "20px" }}>

          {/* Empty state banner */}
          {trades.length === 0 && (
            <div style={{ display: "flex", alignItems: "center", gap: 12, background: "#0a1a2a", border: `1px solid ${G.blue}30`, borderLeft: `3px solid ${G.blue}`, borderRadius: 7, padding: "12px 18px", marginBottom: 20, fontFamily: mono }}>
              <div style={{ fontSize: 16 }}>📂</div>
              <div>
                <div style={{ fontSize: 11, color: G.text, fontWeight: 500 }}>No trades yet</div>
                <div style={{ fontSize: 10, color: G.muted, marginTop: 2 }}>Click <strong style={{ color: G.blue }}>↑ IMPORT CSV</strong> in the header to import a Fidelity Activity CSV, or add a trade manually using the panel on the right.</div>
              </div>
            </div>
          )}

          {/* Stats row */}
          <div className="stats-grid">
            <StatCard label="Premium Collected" value={`$${stats.totalPremium.toLocaleString("en-US",{minimumFractionDigits:2,maximumFractionDigits:2})}`} sub={`${trades.length} legs total`} color={G.accent} top={G.accent} />
            <StatCard label="Realized P&L" value={`${stats.realizedPnl >= 0 ? "+" : ""}$${stats.realizedPnl.toLocaleString("en-US",{minimumFractionDigits:2,maximumFractionDigits:2})}`} sub="closed trades" color={stats.realizedPnl >= 0 ? G.accent : G.red} top={G.accent} />
            <StatCard label="Est. Tax Liability" value={`-$${stats.taxLiability.toLocaleString("en-US",{minimumFractionDigits:2,maximumFractionDigits:2})}`} sub={`at ${taxRate}% rate`} color={G.red} top={G.red} />
            <StatCard label="After-Tax P&L" value={`${stats.afterTaxPnl >= 0 ? "+" : ""}$${stats.afterTaxPnl.toLocaleString("en-US",{minimumFractionDigits:2,maximumFractionDigits:2})}`} sub="net profit" color={stats.afterTaxPnl >= 0 ? G.accent : G.red} top={G.accent} />
            <StatCard label="Return on Capital" value={`${stats.rocPct >= 0 ? "+" : ""}${stats.rocPct.toFixed(2)}%`} sub={`on $${capital.toLocaleString()} base`} color={stats.rocPct >= 0 ? G.accent : G.red} top={G.blue} />
            <StatCard label="Annualized ROC" value={`${stats.annualizedRoc >= 0 ? "+" : ""}${stats.annualizedRoc.toFixed(1)}%`} sub="projected / yr" color={stats.annualizedRoc >= 0 ? G.accent : G.red} top={G.blue} />
            <StatCard label="Capital Deployed" value={`$${(stats.capitalDeployed/1000).toFixed(1)}k`} sub={<span>{trades.filter(t=>t.type==="PUT"&&t.status==="open").length} puts · {stats.assignedCount > 0 ? <span onClick={() => setShowAssignedModal(true)} style={{ cursor: "pointer", borderBottom: `1px dotted ${G.amber}80`, color: G.amber }}>{stats.assignedCount} assigned ↗</span> : "0 assigned"}</span>} color={G.amber} top={G.amber} />
            <StatCard label="Open Positions" value={stats.openCount} sub={`${trades.filter(t=>t.type==="PUT"&&t.status==="open").length}P · ${trades.filter(t=>t.type==="CALL"&&t.status==="open").length}C`} color={G.blue} top={G.blue} />
          </div>

          {/* Body grid */}
          <div className="body-grid">

            {/* Table panel */}
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
                <table style={{ width: "100%", borderCollapse: "collapse", fontSize: 12 }}>
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
                            <div style={{ display: "flex", gap: 6, alignItems: "center" }}>
                              {t.status === "open" && (
                                <button onClick={() => setClosing(t)} style={{ background: "none", border: `1px solid #1a2a3a`, color: G.blue, padding: "3px 8px", borderRadius: 4, fontSize: 10, fontFamily: mono, cursor: "pointer" }}>close</button>
                              )}
                              {t.status === "assigned" && t.type === "PUT" && (
                                t.stockSold
                                  ? <button onClick={() => markStockSold(t.id, false)} style={{ background: "none", border: `1px solid #1a2a1a`, color: G.muted, padding: "3px 8px", borderRadius: 4, fontSize: 10, fontFamily: mono, cursor: "pointer" }}>undo</button>
                                  : <button onClick={() => markStockSold(t.id, true)} style={{ background: "none", border: `1px solid #2a1a00`, color: G.amber, padding: "3px 8px", borderRadius: 4, fontSize: 10, fontFamily: mono, cursor: "pointer" }}>sold</button>
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

            {/* By Ticker */}
            <div style={{ background: G.surface, border: `1px solid ${G.border}`, borderRadius: 8, overflow: "hidden", alignSelf: "start" }}>
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

            {/* Manual Entry */}
            <div style={{ background: G.surface, border: `1px solid ${G.border}`, borderRadius: 8, overflow: "hidden", alignSelf: "start" }}>
              <div style={{ background: G.bg, borderBottom: `1px solid ${G.border}`, padding: "11px 18px" }}>
                <div style={{ fontSize: 9.5, fontWeight: 600, letterSpacing: "0.14em", textTransform: "uppercase", color: G.muted, fontFamily: mono }}>Manual Entry</div>
              </div>
              <AddForm onAdd={addTrade} />
            </div>
          </div>
        </div>
      </div>

      {closing && <CloseModal trade={closing} onClose={() => setClosing(null)} onSave={closeTrade} />}
      {viewImports && <ImportHistoryModal imports={imports} onClose={() => setViewImports(false)} />}
      {showAssignedModal && <AssignedStockModal trades={stats.assignedTrades} onMarkSold={markStockSold} onClose={() => setShowAssignedModal(false)} />}
    </>
  );
}
