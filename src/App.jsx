import { useState, useMemo, useCallback, useRef, useEffect } from "react";

// ─── localStorage helpers ──────────────────────────────────────────────────
const LS_TRADES = "wheeldeskv1_trades";
const LS_CAPITAL = "wheeldeskv1_capital";
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
    const idx = headers.findIndex(h => h.includes(name));
    return idx >= 0 ? (row[idx] || "").replace(/"/g, "").trim() : "";
  };

  const trades = [];
  const errors = [];

  for (let i = headerIdx + 1; i < lines.length; i++) {
    const raw = lines[i];
    if (!raw || raw.startsWith(",,") || raw.toLowerCase().includes("total")) continue;

    const row = [];
    let cur = "", inQ = false;
    for (const ch of raw + ",") {
      if (ch === '"') { inQ = !inQ; }
      else if (ch === "," && !inQ) { row.push(cur.trim()); cur = ""; }
      else cur += ch;
    }

    const action = col(row, "action").toLowerCase();
    const symbol = col(row, "symbol").toUpperCase();
    const qty = parseFloat(col(row, "quantity")) || 0;
    const amount = parseFloat(col(row, "amount").replace(/[$,]/g, "")) || 0;
    const dateRaw = col(row, "run date") || col(row, "date");
    const date = dateRaw ? new Date(dateRaw).toISOString().split("T")[0] : "";

    if (!symbol || !action) continue;
    if (!action.includes("sold opening transaction")) continue;

    const optMatch = symbol.replace(/^-/, "").match(/^([A-Z]{1,6})(\d{6})([CP])(\d+(?:\.\d+)?)$/);
    if (!optMatch) continue;

    const [, ticker, expRaw, cpFlag, strikeRaw] = optMatch;
    const expiry = `20${expRaw.slice(0,2)}-${expRaw.slice(2,4)}-${expRaw.slice(4,6)}`;
    const strike = parseFloat(strikeRaw);
    const type = cpFlag === "P" ? "PUT" : "CALL";
    const contracts = Math.abs(qty);
    const premiumPerContract = contracts > 0 ? Math.abs(amount) / contracts / 100 : 0;

    trades.push({
      id: Date.now() + Math.random(),
      ticker, type, strike, expiry, contracts, premiumPerContract,
      premiumCollected: Math.abs(amount),
      openDate: date, status: "open", realizedPnl: null, closeDate: null, notes: ""
    });
  }

  if (trades.length === 0) errors.push("No options trades found. Export Account Activity (not Positions) from Fidelity.");
  return { trades, errors };
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

function computeStats(trades, capitalBase) {
  const open = trades.filter(t => t.status === "open");
  const closed = trades.filter(t => t.status !== "open");
  const totalPremium = trades.reduce((s, t) => s + (t.premiumCollected || 0), 0);
  const realizedPnl = closed.reduce((s, t) => s + (t.realizedPnl || 0), 0);
  const capitalDeployed = open.reduce((s, t) => s + t.strike * t.contracts * 100, 0);
  const winRate = closed.length > 0 ? (closed.filter(t => (t.realizedPnl || 0) > 0).length / closed.length) * 100 : 0;
  const rocPct = capitalBase > 0 ? (realizedPnl / capitalBase) * 100 : 0;
  return { totalPremium, realizedPnl, capitalDeployed, openCount: open.length, winRate, rocPct };
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
      const { trades, errors } = parseFidelityCSV(e.target.result);
      if (errors.length && !trades.length) { setMsg({ ok: false, text: errors[0] }); return; }
      onImport(trades);
      setMsg({ ok: true, text: `Imported ${trades.length} option trade${trades.length !== 1 ? "s" : ""}` });
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

// ─── Sample data ───────────────────────────────────────────────────────────
const SEED = [
  { id:1, ticker:"AAPL", type:"PUT",  strike:175, expiry:"2025-08-15", contracts:2, premiumPerContract:3.20, premiumCollected:640,  openDate:"2025-07-10", status:"open",     realizedPnl:null, notes:"Support level" },
  { id:2, ticker:"AAPL", type:"PUT",  strike:170, expiry:"2025-07-18", contracts:2, premiumPerContract:2.10, premiumCollected:420,  openDate:"2025-06-20", status:"expired",  realizedPnl:420,  closeDate:"2025-07-18" },
  { id:3, ticker:"SPY",  type:"PUT",  strike:530, expiry:"2025-08-01", contracts:1, premiumPerContract:5.80, premiumCollected:580,  openDate:"2025-07-05", status:"open",     realizedPnl:null },
  { id:4, ticker:"MSFT", type:"PUT",  strike:420, expiry:"2025-07-25", contracts:1, premiumPerContract:4.50, premiumCollected:450,  openDate:"2025-07-01", status:"closed",   realizedPnl:330,  closeDate:"2025-07-14", buybackPremium:1.20, notes:"BTC 73% profit" },
  { id:5, ticker:"MSFT", type:"CALL", strike:435, expiry:"2025-08-15", contracts:1, premiumPerContract:3.90, premiumCollected:390,  openDate:"2025-07-16", status:"open",     realizedPnl:null, notes:"CC after assignment" },
  { id:6, ticker:"NVDA", type:"PUT",  strike:115, expiry:"2025-07-18", contracts:3, premiumPerContract:2.75, premiumCollected:825,  openDate:"2025-07-02", status:"assigned", realizedPnl:825,  closeDate:"2025-07-18", notes:"Shares acquired" },
];

// ─── App ───────────────────────────────────────────────────────────────────
export default function App() {
  const [trades, setTrades] = useState(() => lsGet(LS_TRADES, SEED));
  const [tab, setTab] = useState("open");
  const [closing, setClosing] = useState(null);
  const [capital, setCapital] = useState(() => lsGet(LS_CAPITAL, 50000));

  useEffect(() => { lsSet(LS_TRADES, trades); }, [trades]);
  useEffect(() => { lsSet(LS_CAPITAL, capital); }, [capital]);

  const addTrade = useCallback(t => setTrades(p => [t, ...p]), []);
  const importTrades = useCallback(imported => setTrades(p => [...imported, ...p]), []);
  const closeTrade = useCallback(u => { setTrades(p => p.map(t => t.id === u.id ? u : t)); setClosing(null); }, []);
  const deleteTrade = useCallback(id => setTrades(p => p.filter(t => t.id !== id)), []);

  const stats = useMemo(() => computeStats(trades, capital), [trades, capital]);
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
        body { background: ${G.bg}; }
        ::-webkit-scrollbar { width: 5px; height: 5px; }
        ::-webkit-scrollbar-track { background: ${G.bg}; }
        ::-webkit-scrollbar-thumb { background: ${G.border}; border-radius: 3px; }
        select option { background: ${G.surface}; color: ${G.text}; }
        .trow:hover td { background: #0c1520 !important; }
        input[type=number]::-webkit-inner-spin-button { opacity: 0.3; }
      `}</style>
      <div style={{ minHeight: "100vh", background: G.bg, fontFamily: sans, color: G.text }}>

        {/* Header */}
        <div style={{ background: G.surface, borderBottom: `1px solid ${G.border}`, padding: "0 30px", height: 50, display: "flex", alignItems: "center", justifyContent: "space-between" }}>
          <div style={{ display: "flex", alignItems: "center", gap: 14 }}>
            <div style={{ fontFamily: mono, fontSize: 13, fontWeight: 700, letterSpacing: "0.2em", color: G.accent }}>
              WHEEL<span style={{ color: G.blue }}>.</span>DESK
            </div>
            <div style={{ width: 1, height: 14, background: G.border }} />
            <div style={{ fontSize: 10, color: G.muted, fontFamily: mono, letterSpacing: "0.06em" }}>Options Wheel Tracker</div>
          </div>
          <div style={{ display: "flex", alignItems: "center", gap: 14 }}>
            <div style={{ display: "flex", alignItems: "center", gap: 8 }}>
              <div style={{ fontSize: 9.5, color: G.muted, fontFamily: mono }}>CAPITAL BASE</div>
              <input type="number" value={capital} onChange={e => setCapital(parseFloat(e.target.value) || 0)}
                style={{ width: 100, background: G.bg, border: `1px solid ${G.border}`, color: G.text, padding: "5px 9px", borderRadius: 5, fontSize: 11, fontFamily: mono, outline: "none" }} />
            </div>
            <button
              onClick={() => { if (window.confirm("Clear all trades and reset? This cannot be undone.")) { setTrades([]); lsSet(LS_TRADES, []); } }}
              style={{ background: "none", border: `1px solid #2a1414`, color: "#5a3030", padding: "5px 10px", borderRadius: 5, fontSize: 9.5, fontFamily: mono, cursor: "pointer", letterSpacing: "0.06em" }}
            >CLEAR ALL</button>
          </div>
        </div>

        <div style={{ maxWidth: 1360, margin: "0 auto", padding: "26px 30px" }}>

          {/* Stats row */}
          <div style={{ display: "grid", gridTemplateColumns: "repeat(6, 1fr)", gap: 12, marginBottom: 26 }}>
            <StatCard label="Premium Collected" value={`$${stats.totalPremium.toLocaleString("en-US",{minimumFractionDigits:2,maximumFractionDigits:2})}`} sub={`${trades.length} legs total`} color={G.accent} top={G.accent} />
            <StatCard label="Realized P&L" value={`${stats.realizedPnl >= 0 ? "+" : ""}$${stats.realizedPnl.toLocaleString("en-US",{minimumFractionDigits:2,maximumFractionDigits:2})}`} sub="closed trades" color={stats.realizedPnl >= 0 ? G.accent : G.red} top={G.accent} />
            <StatCard label="Return on Capital" value={`${stats.rocPct >= 0 ? "+" : ""}${stats.rocPct.toFixed(2)}%`} sub={`on $${capital.toLocaleString()} base`} color={stats.rocPct >= 0 ? G.accent : G.red} top={G.blue} />
            <StatCard label="Capital Deployed" value={`$${(stats.capitalDeployed/1000).toFixed(1)}k`} sub={`${stats.openCount} open legs`} color={G.amber} top={G.amber} />
            <StatCard label="Win Rate" value={`${stats.winRate.toFixed(0)}%`} sub="of closed trades" color={stats.winRate >= 70 ? G.accent : G.amber} top={G.purple} />
            <StatCard label="Open Positions" value={stats.openCount} sub={`${trades.filter(t=>t.type==="PUT"&&t.status==="open").length}P · ${trades.filter(t=>t.type==="CALL"&&t.status==="open").length}C`} color={G.blue} top={G.blue} />
          </div>

          {/* Body grid */}
          <div style={{ display: "grid", gridTemplateColumns: "1fr 350px", gap: 18 }}>

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

            {/* Right sidebar */}
            <div style={{ display: "flex", flexDirection: "column", gap: 16 }}>
              {/* Import */}
              <div style={{ background: G.surface, border: `1px solid ${G.border}`, borderRadius: 8, overflow: "hidden" }}>
                <div style={{ background: G.bg, borderBottom: `1px solid ${G.border}`, padding: "11px 18px" }}>
                  <div style={{ fontSize: 9.5, fontWeight: 600, letterSpacing: "0.14em", textTransform: "uppercase", color: G.muted, fontFamily: mono }}>Import Fidelity CSV</div>
                </div>
                <DropZone onImport={importTrades} />
              </div>

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

      {closing && <CloseModal trade={closing} onClose={() => setClosing(null)} onSave={closeTrade} />}
    </>
  );
}
