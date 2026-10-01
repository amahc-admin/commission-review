// Commission review board. Backed by
// supabase/migrations/0001_commission_review.sql -- see that file for the
// security model. Short version: every person has their own passcode,
// re-checked server-side on every call; a rep only ever receives their
// own flags; only a reviewer can import, decide, ask or escalate.

const pageBody = document.getElementById("page-body");

function escapeHtml(str) {
  const div = document.createElement("div");
  div.textContent = str == null ? "" : String(str);
  return div.innerHTML;
}
function escapeAttr(str) {
  return escapeHtml(str || "").replace(/"/g, "&quot;");
}
function initialsFrom(name) {
  return (name || "").split(/\s+/).filter(Boolean).map((w) => w[0]).join("").toUpperCase().slice(0, 3) || "NA";
}
// "dropbox.com/s/..." -> "https://dropbox.com/s/..."
function normalizeUrl(value) {
  if (!value) return "";
  return /^[a-z][a-z0-9+.-]*:/i.test(value) ? value : "https://" + value;
}

(function initTheme() {
  const btn = document.getElementById("theme-toggle");
  let saved = null;
  try { saved = localStorage.getItem("commission-review-theme"); } catch (e) {}
  if (saved) document.documentElement.setAttribute("data-theme", saved);
  const isDark = () => {
    const t = document.documentElement.getAttribute("data-theme");
    return t ? t === "dark" : window.matchMedia("(prefers-color-scheme: dark)").matches;
  };
  const paint = () => { btn.innerHTML = isDark() ? "&#9788;" : "&#9789;"; };
  paint();
  btn.addEventListener("click", () => {
    const next = isDark() ? "light" : "dark";
    document.documentElement.setAttribute("data-theme", next);
    try { localStorage.setItem("commission-review-theme", next); } catch (e) {}
    paint();
  });
})();

const COMM = {
  session: null,   // { id, name, role, passcode }
  board: null,     // last commission_board() result
  period: null,
  week: null,      // 1..5, or "all"
  filter: "open",  // reviewer queue filter
  range: null,     // { from, to, preset } -- what dates the board shows
  selectedId: null,
  people: null,    // login picker list
  loginPick: null,
};

(function loadCommissionSession() {
  try {
    const raw = localStorage.getItem("commission-review-session");
    if (raw) COMM.session = JSON.parse(raw);
  } catch (e) {}
})();
// ---- date range ----
const PRESETS = [
  ["thisWeek", "This Week"], ["lastWeek", "Last Week"], ["thisMonth", "This Month"], ["lastMonth", "Last Month"],
];
function isoDate(d) {
  return d.getFullYear() + "-" + String(d.getMonth() + 1).padStart(2, "0") + "-" + String(d.getDate()).padStart(2, "0");
}
// Weeks run Monday to Sunday, like the Monday ping.
function presetRange(name) {
  const t = new Date(); t.setHours(12, 0, 0, 0);
  const monday = new Date(t); monday.setDate(t.getDate() - ((t.getDay() + 6) % 7));
  const addDays = (d, n) => { const x = new Date(d); x.setDate(x.getDate() + n); return x; };
  if (name === "thisWeek") return { from: isoDate(monday), to: isoDate(addDays(monday, 6)) };
  if (name === "lastWeek") return { from: isoDate(addDays(monday, -7)), to: isoDate(addDays(monday, -1)) };
  if (name === "lastMonth") return { from: isoDate(new Date(t.getFullYear(), t.getMonth() - 1, 1)), to: isoDate(new Date(t.getFullYear(), t.getMonth(), 0)) };
  return { from: isoDate(new Date(t.getFullYear(), t.getMonth(), 1)), to: isoDate(new Date(t.getFullYear(), t.getMonth() + 1, 0)) };
}
function rangeLabel(r) {
  const [fy, fm, fd] = r.from.split("-").map(Number), [ty, tm, td] = r.to.split("-").map(Number);
  const a = fd + " " + MON3[fm - 1] + (fy !== ty ? " " + fy : ""), b = td + " " + MON3[tm - 1] + " " + ty;
  return r.from === r.to ? b : a + " – " + b;
}
function presetName(r) {
  const p = PRESETS.find(([k]) => k === r.preset);
  return p ? p[1] : rangeLabel(r);
}
// Remembers the last choice in this browser. A preset ("Last Week") is
// worked out fresh each visit; a custom range stays as picked.
function loadRange() {
  let saved = null;
  try { saved = JSON.parse(localStorage.getItem("commission-review-range") || "null"); } catch (e) {}
  if (saved && saved.preset) return { ...presetRange(saved.preset), preset: saved.preset };
  if (saved && saved.from && saved.to) return { from: saved.from, to: saved.to, preset: null };
  return { ...presetRange("thisMonth"), preset: "thisMonth" };
}
function setRange(r) {
  COMM.range = r;
  try { localStorage.setItem("commission-review-range", JSON.stringify(r.preset ? { preset: r.preset } : { from: r.from, to: r.to })); } catch (e) {}
}

// ---- range calendar ----
// One button opens a calendar: click a start day, then an end day. Two
// months side by side (one on narrow screens), weeks starting Monday.
function wireRangeCalendar(onPick) {
  const btn = document.getElementById("c-range-btn");
  const cal = document.getElementById("c-cal");
  if (!btn || !cal) return;
  const st = { start: null, hover: null, view: null };
  const today = isoDate(new Date());
  const dayIso = (y, m, d) => isoDate(new Date(y, m, d, 12));

  const monthHtml = (y, m) => {
    const first = new Date(y, m, 1, 12);
    const lead = (first.getDay() + 6) % 7; // Monday first
    const days = new Date(y, m + 1, 0).getDate();
    const r = COMM.range;
    const lo = st.start ? (st.hover && st.hover < st.start ? st.hover : st.start) : r.from;
    const hi = st.start ? (st.hover && st.hover > st.start ? st.hover : st.start) : r.to;
    let cells = "";
    for (let i = 0; i < lead; i++) cells += `<span></span>`;
    for (let d = 1; d <= days; d++) {
      const iso = dayIso(y, m, d);
      const cls = [
        iso >= lo && iso <= hi ? "in" : "",
        iso === lo ? "start" : "", iso === hi ? "end" : "",
        iso === today ? "today" : "",
      ].join(" ");
      cells += `<button type="button" class="c-day ${cls}" data-day="${iso}">${d}</button>`;
    }
    return `<div class="c-cal-month"><div class="c-cal-title">${MONTHS[m]} ${y}</div>
      <div class="c-cal-grid"><span>Mo</span><span>Tu</span><span>We</span><span>Th</span><span>Fr</span><span>Sa</span><span>Su</span>${cells}</div></div>`;
  };

  const draw = () => {
    const two = window.innerWidth > 720;
    const [y, m] = st.view;
    const next = new Date(y, m + 1, 1);
    cal.innerHTML = `
      <div class="c-cal-head">
        <button type="button" class="c-cal-nav" data-nav="-1" aria-label="Previous month">&#8249;</button>
        <span class="small muted">${st.start ? "Now click the end date" : "Click a start date, then an end date"}</span>
        <button type="button" class="c-cal-nav" data-nav="1" aria-label="Next month">&#8250;</button>
      </div>
      <div class="c-cal-months">${monthHtml(y, m)}${two ? monthHtml(next.getFullYear(), next.getMonth()) : ""}</div>`;
  };

  const open = () => {
    const [fy, fm] = COMM.range.from.split("-").map(Number);
    st.start = null; st.hover = null;
    // show the range's start month, keeping its end in view on wide screens
    st.view = [fy, fm - 1];
    cal.hidden = false; btn.setAttribute("aria-expanded", "true");
    draw();
  };
  const close = () => { cal.hidden = true; btn.setAttribute("aria-expanded", "false"); st.start = null; };

  btn.addEventListener("click", (e) => { e.stopPropagation(); cal.hidden ? open() : close(); });
  cal.addEventListener("click", (e) => {
    e.stopPropagation();
    const nav = e.target.closest("[data-nav]");
    if (nav) { const d = new Date(st.view[0], st.view[1] + Number(nav.dataset.nav), 1); st.view = [d.getFullYear(), d.getMonth()]; return draw(); }
    const day = e.target.closest("[data-day]");
    if (!day) return;
    if (!st.start) { st.start = day.dataset.day; st.hover = null; return draw(); }
    let from = st.start, to = day.dataset.day;
    if (to < from) [from, to] = [to, from];
    close();
    onPick(from, to);
  });
  cal.addEventListener("mouseover", (e) => {
    const day = e.target.closest("[data-day]");
    if (st.start && day && day.dataset.day !== st.hover) { st.hover = day.dataset.day; draw(); }
  });
  // close on an outside click or Escape (listeners replaced on each render)
  document.onclick = (e) => { if (!cal.hidden && !cal.contains(e.target) && e.target !== btn) close(); };
  document.onkeydown = (e) => { if (e.key === "Escape" && !cal.hidden) close(); };
}

function setCommissionSession(s) {
  COMM.session = s;
  COMM.board = null;
  try {
    s ? localStorage.setItem("commission-review-session", JSON.stringify(s)) : localStorage.removeItem("commission-review-session");
  } catch (e) {}
}

const COMM_REASONS = [
  { id: "Website promo", hint: "Name the promo -- the system checks what was live that day." },
  { id: "Customer code", hint: "Which code? Was it the customer who brought it up?" },
  { id: "Approved by Jaya or Ross", hint: "Screenshot the approval and attach it.", proof: true },
  { id: "Osama run", hint: "Screenshot the booking or the cost and attach it.", proof: true },
  { id: "Private courier", hint: "Screenshot the booking or the cost and attach it.", proof: true },
  { id: "Customer pickup / installer run", hint: "Say which -- the AI checks the order notes." },
  { id: "Warranty / replacement", hint: "Which earlier order was it replacing?" },
  { id: "My own call", hint: "Fine -- it counts, but say why so it's on record." },
  { id: "Other", hint: "Explain in a line or two." },
];

const MONTHS = ["January", "February", "March", "April", "May", "June", "July", "August", "September", "October", "November", "December"];
const MON3 = MONTHS.map((m) => m.slice(0, 3));

function cMoney(n, opts) {
  const v = Number(n || 0);
  const s = "$" + Math.abs(Math.round(v)).toLocaleString("en-AU");
  return v < 0 && !(opts && opts.abs) ? "-" + s : s;
}
function cDate(d) {
  if (!d) return "";
  const [, m, day] = d.slice(0, 10).split("-");
  return day + " " + MON3[Number(m) - 1];
}
function cWhen(ts) {
  if (!ts) return "";
  const d = new Date(ts);
  return d.getDate() + " " + MON3[d.getMonth()] + ", " + d.toLocaleTimeString("en-AU", { hour: "numeric", minute: "2-digit" });
}
function periodLabel(p) {
  if (!p) return "";
  const [y, m] = p.split("-");
  return MONTHS[Number(m) - 1] + " " + y;
}
function weekRange(period, w) {
  const [y, m] = period.split("-").map(Number);
  const last = new Date(y, m, 0).getDate();
  const start = (w - 1) * 7 + 1;
  const end = w === 5 ? last : Math.min(w * 7, last);
  return start + "–" + end + " " + MON3[m - 1];
}
function tSec(t) {
  t = Math.max(0, Math.round(Number(t) || 0));
  return Math.floor(t / 60) + ":" + String(t % 60).padStart(2, "0");
}
function isReviewer() { return COMM.session && COMM.session.role === "reviewer"; }
function personNameById(id) {
  const p = ((COMM.board && COMM.board.people) || []).find((x) => x.id === id);
  return p ? p.name : id;
}
function approverName() {
  const p = ((COMM.board && COMM.board.people) || []).find((x) => x.is_approver);
  return p ? p.name : "Jaya";
}

// ---- flag state ----
function hasStake(f) { return Number(f.amount) > 0; }
function needsCase(f) {
  return !f.decision && hasStake(f) && !f.rep_case && !["waive", "related"].includes((f.ai || {}).verdict);
}
function questionOpen(f) { return !f.decision && !!f.question && !f.rep_case; }
// What still counts against the rep: decided = amount minus the waived
// part; undecided = the whole amount ("counts as-is at month-end").
function countsAmount(f) {
  if (f.kind === "claim" || !hasStake(f)) return 0;
  if (f.decision) return Number(f.amount) - Number(f.waived_amount || 0);
  return Number(f.amount);
}

// "rules" = the overnight read's no-AI mode: a suggestion worked out from
// the Shopify order alone (codes live that day, manual vs automatic), with
// no AI read or call evidence. Labelled differently so nobody mistakes it.
function isRulesRead(f) { return (f.ai || {}).source === "rules"; }
function readerLabel(f) { return isRulesRead(f) ? "Rules" : "AI"; }

function aiChip(f) {
  const ai = f.ai || {};
  const who = readerLabel(f);
  const conf = ai.confidence != null ? " · " + ai.confidence + "%" : "";
  if (!ai.verdict && isRulesRead(f)) return `<span class="c-chip c-grey">Rules: check it</span>`;
  switch (ai.verdict) {
    case "partial": return `<span class="c-chip c-amber">${who}: waive ${cMoney(ai.waive_amount)}, rest counts</span>`;
    case "waive": return `<span class="c-chip c-green">${who}: waive ${cMoney(ai.waive_amount != null ? ai.waive_amount : f.amount)}</span>`;
    case "counts": return `<span class="c-chip c-red">${who}: counts</span>`;
    case "unrelated": return `<span class="c-chip c-red">AI: unrelated${conf}</span>`;
    case "related": return `<span class="c-chip c-green">AI: related${conf}</span>`;
    case "for_rep": return `<span class="c-chip c-green">Counts for you</span>`;
    default: return `<span class="c-chip c-grey">No AI read yet</span>`;
  }
}
function decisionText(f) {
  if (!f.decision) return "";
  if (f.decision === "push") return "Pushed to commission";
  if (f.decision === "reject") return "Claim rejected";
  const w = Number(f.waived_amount || 0), c = Number(f.amount) - w;
  if (f.decision === "waive") return "Waived " + cMoney(w);
  if (f.decision === "counts") return "Counts " + cMoney(c);
  return "Waived " + cMoney(w) + " · counts " + cMoney(c);
}
function statusText(f) {
  if (!hasStake(f)) return `<span class="c-ok">counts for you</span>`;
  if (f.decision) return `<span class="c-ok">${escapeHtml(decisionText(f))}</span>`;
  const mine = !isReviewer();
  if (f.escalated_at) return mine ? "with " + escapeHtml(approverName()) : `<span class="c-warn">escalated</span>`;
  if (questionOpen(f)) return mine ? `<span class="c-bad">question for you</span>` : "asked " + escapeHtml(personNameById(f.rep_id));
  if (f.rep_case) return mine ? "answered · with reviewer" : `<span class="c-strong">rep answered</span>`;
  if (mine) return needsCase(f) ? `<span class="c-bad">needs your case</span>` : "nothing to do";
  return "awaiting you";
}
const KIND_LABEL = { discount: "Discount", freight: "Freight", refund: "Refund", claim: "Claim" };

// ============================== entry ==============================

async function renderCommission() {
  if (!API.configured()) {
    pageBody.innerHTML = `<div class="empty-state"><p><strong>Not set up yet.</strong></p>
      <p class="muted small">Fill in this app's Supabase URL and anon key in web/js/config.js, then reload. See SETUP.md.</p></div>`;
    return;
  }
  if (!COMM.session) return renderCommissionLogin();
  if (!COMM.board) {
    pageBody.innerHTML = `<div class="empty-state"><p class="muted">Loading the board...</p></div>`;
    try {
      await loadCommissionBoard();
    } catch (err) {
      if (/passcode/i.test(err.message)) { setCommissionSession(null); return renderCommissionLogin("Your passcode has changed -- log in again."); }
      pageBody.innerHTML = `<div class="empty-state"><p><strong>Couldn't load the board.</strong></p>
        <p class="muted small">${escapeHtml(err.message)}</p>
        <p class="muted small">If this is a fresh setup, run supabase/migrations/0001_commission_review.sql (see SETUP.md).</p>
        <button class="btn btn-secondary" id="c-retry">Try Again</button></div>`;
      document.getElementById("c-retry").addEventListener("click", renderCommission);
      return;
    }
  }
  renderCommissionBoard();
}

async function loadCommissionBoard() {
  const s = COMM.session;
  if (!COMM.range) COMM.range = loadRange();
  const board = await API.commissionBoardRange(s.id, s.passcode, COMM.range.from, COMM.range.to);
  COMM.board = board;
  // Reviewers see when the overnight read last ran and anything it
  // couldn't put on a rep's board. Older databases without 0002 just skip it.
  COMM.lastRun = null;
  if (s.role === "reviewer") {
    try { COMM.lastRun = await API.commissionLastRun(s.id, s.passcode); } catch (e) {}
  }
}
async function refreshCommission() {
  await loadCommissionBoard();
  renderCommissionBoard();
}
function commissionError(el, err) {
  if (el) el.textContent = err.message || String(err);
  else alert(err.message || String(err));
}

// ============================== login ==============================

async function renderCommissionLogin(message) {
  pageBody.innerHTML = `<div class="empty-state"><p class="muted">Loading...</p></div>`;
  if (!COMM.people) {
    try { COMM.people = await API.listCommissionPeople(); }
    catch (err) {
      pageBody.innerHTML = `<div class="empty-state"><p><strong>Commission review isn't set up yet.</strong></p>
        <p class="muted small">Run supabase/migrations/0001_commission_review.sql in Supabase (see SETUP.md). ${escapeHtml(err.message)}</p></div>`;
      return;
    }
  }
  const items = COMM.people.map((p) => {
    const tag = p.role === "reviewer" ? "Reviewer" : "Sales";
    if (COMM.loginPick === p.id) {
      return `<div class="vm-item-login">
        <div class="vm-item selected"><span class="vm-dot">${escapeHtml(initialsFrom(p.name))}</span><span>${escapeHtml(p.name)}</span><span class="muted small" style="margin-left:auto">${tag}</span></div>
        <input type="password" class="vm-passcode-input" id="c-pass" placeholder="Your passcode" autocomplete="off">
        <div class="row" style="gap:8px;margin-top:8px">
          <button class="btn btn-primary" id="c-login" style="flex:1">Open My Board</button>
          <button class="btn btn-secondary" id="c-cancel">Cancel</button>
        </div>
        <p class="muted small" id="c-login-err" style="min-height:16px;margin-top:6px"></p>
      </div>`;
    }
    return `<div class="vm-item" data-person="${escapeAttr(p.id)}"><span class="vm-dot">${escapeHtml(initialsFrom(p.name))}</span><span>${escapeHtml(p.name)}</span><span class="muted small" style="margin-left:auto">${tag}</span></div>`;
  }).join("");

  pageBody.innerHTML = `
    <div class="login-gate-wrap">
      <div class="brand-mark">&#128176;</div>
      <h1>Commission review</h1>
      <p class="muted">Your own login -- you only ever see your own orders. ${message ? `<br><strong>${escapeHtml(message)}</strong>` : ""}</p>
      <div class="login-gate">${items || `<p class="muted small">No people set up yet -- see SETUP.md.</p>`}</div>
    </div>`;

  pageBody.querySelectorAll("[data-person]").forEach((el) => el.addEventListener("click", (e) => {
    e.stopPropagation();
    COMM.loginPick = el.dataset.person;
    renderCommissionLogin();
    setTimeout(() => { const i = document.getElementById("c-pass"); if (i) i.focus(); }, 0);
  }));
  const btn = document.getElementById("c-login");
  if (btn) {
    const input = document.getElementById("c-pass");
    const err = document.getElementById("c-login-err");
    const doLogin = async () => {
      if (!input.value) { err.textContent = "Enter your passcode."; return; }
      btn.disabled = true; btn.textContent = "Checking...";
      try {
        const who = await API.commissionLogin(COMM.loginPick, input.value);
        setCommissionSession({ id: who.id, name: who.name, role: who.role, passcode: input.value });
        COMM.loginPick = null; COMM.selectedId = null;
        renderCommission();
      } catch (e) {
        btn.disabled = false; btn.textContent = "Open My Board";
        err.textContent = "Wrong passcode.";
      }
    };
    btn.addEventListener("click", (e) => { e.stopPropagation(); doLogin(); });
    input.addEventListener("click", (e) => e.stopPropagation());
    input.addEventListener("keydown", (e) => { if (e.key === "Enter") doLogin(); });
    document.getElementById("c-cancel").addEventListener("click", (e) => { e.stopPropagation(); COMM.loginPick = null; renderCommissionLogin(); });
  }
}

// ============================== board ==============================

function visibleFlags() {
  const b = COMM.board;
  let flags = b.flags.slice();
  if (isReviewer()) {
    const fl = COMM.filter;
    if (fl === "open") flags = flags.filter((f) => !f.decision && hasStake(f));
    else if (fl === "answered") flags = flags.filter((f) => !f.decision && f.rep_case);
    else if (fl === "escalated") flags = flags.filter((f) => !f.decision && f.escalated_at);
    else if (fl === "decided") flags = flags.filter((f) => f.decision);
    // escalations first for the approver, then oldest first
    const me = b.me || {};
    flags.sort((a, c) => (me.is_approver ? (!!c.escalated_at - !!a.escalated_at) : 0) || a.order_date.localeCompare(c.order_date) || a.order_no.localeCompare(c.order_no));
  }
  return flags;
}

function renderCommissionBoard() {
  const b = COMM.board;
  const s = COMM.session;
  const r = COMM.range;
  const weekFlags = b.flags.filter(hasStake);
  const decided = weekFlags.filter((f) => f.decision).length;
  const signed = b.signoff;

  const rangeBar = `<div class="c-range">
      <div class="c-tabs">${PRESETS.map(([k, label]) => `<button class="c-tab ${r.preset === k ? "active" : ""}" data-preset="${k}">${label}</button>`).join("")}</div>
      <div class="c-range-pick">
        <button class="c-range-btn ${r.preset ? "" : "active"}" id="c-range-btn" aria-haspopup="dialog" aria-expanded="false">&#128197; ${escapeHtml(rangeLabel(r))} <span class="c-caret">&#9662;</span></button>
        <div class="c-cal" id="c-cal" role="dialog" aria-label="Pick a date range" hidden></div>
      </div>
      <span class="small muted">Showing <strong>${escapeHtml(rangeLabel(r))}</strong> · ${b.flags.length} order(s)${signed ? ` · <span class="c-ok">&#10003; signed off by ${escapeHtml(signed.signed_by)}</span>` : ""}</span>
    </div>`;

  const run = COMM.lastRun;
  const sum = (run && run.summary) || {};
  const unattributed = sum.unattributed || [];
  const runLine = !isReviewer() ? "" : !run ? `<span class="faint small">Overnight read: not run yet</span>` : `
      <span class="small ${run.status === "error" ? "c-bad" : "muted"}" title="${escapeAttr(sum.error || "")}">
        Overnight read ${run.status === "error" ? "failed" : "ran"} ${cWhen(run.finished_at || run.started_at)}${run.status === "ok" ? ` · ${sum.flags_written || 0} flag(s) updated` : ""}${sum.deferred ? ` · ${sum.deferred} left for next run` : ""}
      </span>
      ${unattributed.length ? `<button class="c-link small" id="c-unattr">${unattributed.length} order(s) not matched to a rep</button>` : ""}`;

  const reviewerTools = isReviewer() ? `
      <button class="btn btn-secondary c-btn-sm" id="c-import">Sync from Shopify</button>
      <button class="btn btn-secondary c-btn-sm" id="c-ping">Monday Ping</button>
      <button class="btn btn-secondary c-btn-sm" id="c-totals">Payout Totals</button>
      <button class="btn btn-secondary c-btn-sm" id="c-export">Export CSV</button>
      <span class="c-runline">${runLine}</span>` : "";

  pageBody.innerHTML = `
    <div class="c-head">
      <div>
        <h1 class="c-title">${isReviewer() ? "Commission review" : "Your commission review"}</h1>
        <div class="muted small">Discounts over 5%, freight under cost, refunds, claims</div>
      </div>
      <div class="c-head-right">
        <div class="c-progress">
          <div class="muted small">${decided} of ${weekFlags.length} decided ${r.preset ? escapeHtml(presetName(r).toLowerCase()) : "in this range"}</div>
          <div class="c-progress-track"><span style="width:${weekFlags.length ? (100 * decided / weekFlags.length) : 0}%"></span></div>
        </div>
        <button class="c-who" id="c-who" title="Switch person / log out"><span class="pill-avatar">${escapeHtml(initialsFrom(s.name))}</span>${isReviewer() ? "Reviewing as " : ""}${escapeHtml(s.name)}</button>
      </div>
    </div>
    ${rangeBar}
    ${isReviewer() ? `<div class="c-tools">${reviewerTools}</div>` : repSummaryHtml()}
    <div class="c-split">
      <div class="c-queue" id="c-queue">${isReviewer() ? reviewerQueueHtml() : repQueueHtml()}</div>
      <div class="c-detail" id="c-detail"></div>
    </div>`;

  wireBoardChrome();
  wireQueue();
  renderDetail();
}

function wireBoardChrome() {
  const reload = async (range) => {
    setRange(range);
    COMM.selectedId = null;
    try { await loadCommissionBoard(); renderCommissionBoard(); } catch (err) { commissionError(null, err); }
  };
  pageBody.querySelectorAll(".c-tab[data-preset]").forEach((t) => t.addEventListener("click", () => {
    reload({ ...presetRange(t.dataset.preset), preset: t.dataset.preset });
  }));
  wireRangeCalendar((from, to) => reload({ from, to, preset: null }));
  document.getElementById("c-who").addEventListener("click", () => {
    if (confirm("Log out of the commission board" + (COMM.session ? " (" + COMM.session.name + ")" : "") + "?")) {
      setCommissionSession(null);
      COMM.selectedId = null;
      renderCommission();
    }
  });
  if (isReviewer()) {
    document.getElementById("c-import").addEventListener("click", showImportModal);
    document.getElementById("c-ping").addEventListener("click", showPingModal);
    document.getElementById("c-totals").addEventListener("click", showTotalsModal);
    document.getElementById("c-export").addEventListener("click", exportCsv);
    const ua = document.getElementById("c-unattr");
    if (ua) ua.addEventListener("click", showUnattributedModal);
    const filter = document.getElementById("c-filter");
    if (filter) filter.addEventListener("change", (e) => { COMM.filter = e.target.value; COMM.selectedId = null; renderCommissionBoard(); });
    const so = document.getElementById("c-signoff");
    if (so) so.addEventListener("click", async () => {
      so.disabled = true;
      try {
        await API.commissionSignOffRange(COMM.session.id, COMM.session.passcode, COMM.range.from, COMM.range.to);
        await refreshCommission();
      } catch (err) { so.disabled = false; commissionError(null, err); }
    });
  }
}

function queueRowHtml(f, num) {
  const sel = COMM.selectedId === f.id ? "selected" : "";
  const who = isReviewer() ? escapeHtml(personNameById(f.rep_id)) : escapeHtml(KIND_LABEL[f.kind]);
  const pct = f.pct != null && f.kind === "discount" ? f.pct + "% · " : "";
  const amtClass = hasStake(f) ? "c-bad" : "c-ok";
  return `<button class="c-row ${sel}" data-flag="${escapeAttr(f.id)}">
    ${num ? `<span class="c-num">${num}</span>` : ""}
    <span class="c-row-main">
      <span class="c-row-top"><strong>#${escapeHtml(f.order_no)}</strong><span class="faint small">${cDate(f.order_date)}</span>
        <span class="c-amt ${amtClass}">${hasStake(f) ? "" : "+"}${cMoney(f.amount, { abs: true })}</span></span>
      <span class="c-row-mid"><span>${escapeHtml(f.customer || "—")}</span><span class="faint small">${pct}${who}</span></span>
      <span class="c-row-bot">${f.escalated_at && !f.decision ? `<span class="c-chip c-violet">escalated</span>` : ""}${aiChip(f)}<span class="small c-status">${statusText(f)}</span></span>
    </span>
  </button>`;
}

function reviewerQueueHtml() {
  const flags = visibleFlags();
  const allWeek = COMM.board.flags.filter(hasStake);
  const canSign = allWeek.length && allWeek.every((f) => f.decision) && !COMM.board.signoff;
  const opts = [["open", "Needs a decision"], ["answered", "Rep answered"], ["escalated", "Escalated"], ["decided", "Decided"], ["all", "Everything"]]
    .map(([v, l]) => `<option value="${v}" ${COMM.filter === v ? "selected" : ""}>${l}</option>`).join("");
  return `
    <div class="c-queue-head"><span>Queue — pre-read overnight</span>
      <select id="c-filter" class="c-select">${opts}</select></div>
    <div class="c-rows">${flags.map((f) => queueRowHtml(f)).join("") || `<p class="muted small c-empty">Nothing here.</p>`}</div>
    <div class="c-queue-foot">
      ${allWeek.length && !COMM.board.signoff ? `<button class="btn btn-primary c-btn-sm" id="c-signoff" ${canSign ? "" : "disabled"} title="${canSign ? "" : "Every flag with money at stake needs a decision first"}">Sign Off ${escapeHtml(presetName(COMM.range))}</button>` : ""}
      <span class="faint small">Anything undecided at month-end counts against the rep as-is.</span>
    </div>`;
}

// The rep's own screen: the numbered "needs an answer" list first, then
// the three lanes.
function repQueueHtml() {
  const flags = COMM.board.flags;
  const todo = flags.filter((f) => needsCase(f) || questionOpen(f));
  const lane = (kinds, title) => {
    const rows = flags.filter((f) => kinds.includes(f.kind) && !todo.includes(f));
    if (!rows.length) return "";
    return `<div class="c-queue-head"><span>${title}</span></div><div class="c-rows">${rows.map((f) => queueRowHtml(f)).join("")}</div>`;
  };
  return `
    <div class="c-queue-head"><span>Needs your answer${todo.length ? " — " + todo.length : ""}</span></div>
    <div class="c-rows">${todo.map((f, i) => queueRowHtml(f, i + 1)).join("") || `<p class="muted small c-empty">Nothing needs you right now. &#10003;</p>`}</div>
    ${lane(["discount"], "Discounts")}
    ${lane(["freight"], "Freight")}
    ${lane(["refund", "claim"], "Refunds &amp; claims")}
    <div class="c-queue-foot"><span class="faint small">No answer means it counts as-is. Answer by Wednesday, while the calls are fresh.</span></div>`;
}

function repSummaryHtml() {
  const flags = COMM.board.flags;
  const disc = flags.filter((f) => f.kind === "discount" && hasStake(f));
  const fr = flags.filter((f) => f.kind === "freight");
  const under = fr.filter(hasStake);
  const over = fr.filter((f) => !hasStake(f));
  const atStake = flags.filter(needsCase).reduce((a, f) => a + Number(f.amount), 0);
  const counts = flags.reduce((a, f) => a + countsAmount(f), 0);
  return `<div class="c-stats">
    <div class="c-stat"><div class="c-stat-label">Discounts flagged</div><div class="c-stat-num c-bad">${cMoney(disc.reduce((a, f) => a + Number(f.amount), 0))}</div>
      <div class="small muted">${disc.length} order(s) over 5% — ${disc.filter(needsCase).length} without your case yet</div></div>
    <div class="c-stat"><div class="c-stat-label">Freight under cost</div><div class="c-stat-num c-bad">${cMoney(under.reduce((a, f) => a + Number(f.amount), 0))}</div>
      <div class="small muted">${under.length} order(s)${over.length ? ` · <span class="c-ok">${cMoney(-over.reduce((a, f) => a + Number(f.amount), 0))} over-recovered counts FOR you</span>` : ""}</div></div>
    <div class="c-stat c-stat-dark"><div class="c-stat-label">Your cases are worth</div><div class="c-stat-num">${cMoney(atStake)}</div>
      <div class="small">that counts against you today with no case stated. ${cMoney(counts)} counts as it stands.</div></div>
  </div>`;
}

function wireQueue() {
  pageBody.querySelectorAll(".c-row").forEach((r) => r.addEventListener("click", () => {
    COMM.selectedId = r.dataset.flag;
    pageBody.querySelectorAll(".c-row").forEach((x) => x.classList.toggle("selected", x === r));
    renderDetail();
    if (window.innerWidth < 900) document.getElementById("c-detail").scrollIntoView({ behavior: "smooth", block: "start" });
  }));
}

// ============================== detail pane ==============================

function selectedFlag() {
  const flags = COMM.board.flags;
  let f = flags.find((x) => x.id === COMM.selectedId);
  if (!f) {
    const first = pageBody.querySelector(".c-row");
    f = first ? flags.find((x) => x.id === first.dataset.flag) : null;
    if (f) { COMM.selectedId = f.id; first.classList.add("selected"); }
  }
  return f;
}

function renderDetail() {
  const el = document.getElementById("c-detail");
  const f = selectedFlag();
  if (!f) { el.innerHTML = `<div class="empty-state"><p class="muted">Pick an order on the left.</p></div>`; return; }
  const ai = f.ai || {};
  const repName = personNameById(f.rep_id);

  const header = `
    <div class="c-d-head">
      <div><span class="c-d-order">#${escapeHtml(f.order_no)}</span>
        <strong>${escapeHtml(f.customer || "—")}</strong>
        <span class="muted small">${escapeHtml(KIND_LABEL[f.kind])} · ${escapeHtml(repName)} · ${cDate(f.order_date)}</span></div>
      <div class="small muted c-d-figs">
        ${f.gross != null ? `gross <strong>${cMoney(f.gross)}</strong>` : ""}
        ${f.kind === "discount" ? ` · discount <strong class="c-bad">${cMoney(f.amount)}</strong>${f.pct != null ? ` · <strong class="c-bad">${f.pct}%</strong>` : ""}` : ""}
        ${f.order_url ? ` · <a href="${escapeAttr(f.order_url)}" target="_blank" rel="noopener">open order &#8599;</a>` : ""}
      </div>
    </div>`;

  el.innerHTML = header
    + breakdownHtml(f)
    + aiCardHtml(f)
    + contactTrailHtml(f)
    + repSideHtml(f)
    + (isReviewer() ? reviewerActionsHtml(f) : repAnswerHtml(f))
    + historyHtml(f);

  wireDetail(f);
}

function breakdownHtml(f) {
  const d = f.details || {};
  if (f.kind === "discount") {
    const slices = f.slices || [];
    if (!slices.length) return `<div class="c-card"><div class="c-card-h">Where the discount came from</div><p class="muted small">No breakdown imported for this order.</p></div>`;
    return `<div class="c-card"><div class="c-card-h">Where the discount came from</div>
      ${slices.map((sl) => `<div class="c-slice">
        <span class="c-chip ${sliceClass(sl)}">${escapeHtml(sl.type || "discount")}</span>
        <span class="c-slice-label">${escapeHtml(sl.label || "")}${sl.note ? `<span class="faint small c-slice-note">${escapeHtml(sl.note)}</span>` : ""}</span>
        <strong class="c-slice-amt">${cMoney(sl.amount)}</strong></div>`).join("")}
    </div>`;
  }
  if (f.kind === "freight") {
    const over = !hasStake(f);
    const recovery = d.cost ? Math.round(100 * Number(d.charged || 0) / Number(d.cost)) : null;
    return `<div class="c-card"><div class="c-card-h">Freight: charged vs what it cost us</div>
      <div class="c-figs">
        <div><div class="faint small">Service taken</div><strong>${escapeHtml(d.service || "—")}</strong></div>
        <div><div class="faint small">Charged</div><strong>${cMoney(d.charged)}</strong></div>
        <div><div class="faint small">Shopify rate</div><strong>${cMoney(d.cost)}</strong></div>
        <div><div class="faint small">${over ? "Over-recovered" : "Under cost"}</div><strong class="${over ? "c-ok" : "c-bad"}">${cMoney(Math.abs(f.amount))}</strong></div>
        ${recovery != null ? `<div><div class="faint small">Recovery</div><strong>${recovery}%</strong></div>` : ""}
      </div>
      ${over ? `<p class="small c-ok" style="margin-top:10px">Charged more than it cost — this counts FOR the rep.</p>` : `<p class="small muted" style="margin-top:10px">Freight is one-to-one: under the Shopify rate counts like a discount, unless it's proven (Osama run, private courier, sign-off).</p>`}
    </div>`;
  }
  if (f.kind === "refund") {
    return `<div class="c-card"><div class="c-card-h">Refund</div>
      <div class="c-figs"><div><div class="faint small">Refunded</div><strong class="c-bad">${cMoney(f.amount)}</strong></div>
      <div><div class="faint small">Reason on the order</div><strong>${escapeHtml(d.reason || "—")}</strong></div></div></div>`;
  }
  return `<div class="c-card"><div class="c-card-h">Sales claim</div>
    <div class="c-figs"><div><div class="faint small">Order value</div><strong>${cMoney(f.amount)}</strong></div>
    <div><div class="faint small">Claimed by</div><strong>${escapeHtml(d.claimed_by || personNameById(f.rep_id))}</strong></div>
    ${d.item ? `<div><div class="faint small">Item</div><strong>${escapeHtml(d.item)}</strong></div>` : ""}</div></div>`;
}
function sliceClass(sl) {
  const t = (sl.type || "").toLowerCase();
  if (t.includes("code")) return "c-blue";
  if (t.includes("free")) return "c-green";
  if (t.includes("custom")) return "c-red";
  if (t.includes("promo")) return sl.side === "company" ? "c-green" : "c-amber";
  return sl.side === "company" ? "c-blue" : "c-amber";
}

function aiCardHtml(f) {
  const ai = f.ai || {};
  if (!ai.verdict && !isRulesRead(f)) return `<div class="c-card"><div class="c-card-h">AI review</div><p class="muted small">No AI read on this one yet — it'll show here after the next overnight run.</p></div>`;
  const quotes = (ai.quotes || []).map((q, i) => `<div class="c-quote">
      <span class="c-quote-who ${q.speaker === "rep" ? "c-rep" : "c-cust"}">${q.speaker === "rep" ? "REP" : "CUSTOMER"}</span>
      <span class="c-quote-text">&ldquo;${escapeHtml(q.text)}&rdquo;</span>
      ${q.call_id ? `<button class="c-link" data-hear="${i}">&#9654; hear it</button>` : ""}</div>`).join("");
  return `<div class="c-card">
    <div class="c-card-h">${isRulesRead(f) ? "Rule check" : "AI review"} ${aiChip(f)}
      ${ai.confidence != null ? `<span class="faint small">${ai.confidence}% confidence</span>` : ""}
      ${ai.discussed_on_call ? `<span class="c-chip c-blue">discussed on call</span>` : ""}
      <span class="faint small" style="margin-left:auto">${ai.reviewed_at ? "reviewed " + cWhen(ai.reviewed_at) : ""}</span></div>
    ${ai.summary && !(ai.points || []).length ? `<p class="small">${escapeHtml(ai.summary)}</p>` : ""}
    ${(ai.points || []).length ? `<ul class="c-points">${ai.points.map((p) => `<li>${escapeHtml(p)}</li>`).join("")}</ul>` : ""}
    ${quotes ? `<div class="c-quotes">${quotes}</div>` : ""}
    <p class="faint small" style="margin-top:8px">${isRulesRead(f)
      ? "Worked out from the Shopify order alone — no AI read or call evidence yet. A named person decides every dollar."
      : "The AI only suggests, with its evidence attached. A named person decides every dollar."}</p>
  </div>`;
}

function contactTrailHtml(f) {
  const calls = f.calls || [];
  if (!calls.length) return "";
  return `<div class="c-card"><div class="c-card-h">Contact trail — ${calls.length} item(s)</div>
    ${calls.map((c, i) => `<button class="c-trail" data-call="${i}">
      <span>&#128222;</span><span><strong>${escapeHtml(c.source || "Call")} · ${cDate(c.date)} · ${escapeHtml(c.rep || "")}</strong>
      <span class="faint small"> ${c.answered === false ? "missed · " : c.minutes ? c.minutes + " min · " : ""}${escapeHtml(c.direction || "")}${(c.lines || []).length ? ` · ${c.lines.length} lines` : c.has_recording ? " · recording" : ""}</span></span>
      <span class="c-link" style="margin-left:auto">open &#8599;</span></button>`).join("")}
  </div>`;
}

function proofListHtml(proof) {
  if (!proof || !proof.length) return "";
  // Only our own uploads render as thumbnails -- a pasted Dropbox/Drive
  // link ending in .png is usually a share page, not the raw image.
  return `<div class="c-proofs">${proof.map((u) => /\/storage\/v1\/object\/public\/commission-proof\/[^/]+\.(png|jpe?g|webp|gif)$/i.test(u)
    ? `<a href="${escapeAttr(u)}" target="_blank" rel="noopener"><img src="${escapeAttr(u)}" alt="proof"></a>`
    : `<a class="c-proof-link" href="${escapeAttr(u)}" target="_blank" rel="noopener">&#128206; ${escapeHtml(u.replace(/^https?:\/\//, "").slice(0, 48))}</a>`).join("")}</div>`;
}

function repSideHtml(f) {
  const bits = [];
  if (f.question) {
    bits.push(`<div class="c-callout c-callout-ask"><strong>${escapeHtml(f.question_by || "Reviewer")} asked</strong> <span class="faint small">${cWhen(f.question_at)}</span>${isReviewer() ? `<button class="c-callout-del" data-act="unask" title="Delete this question">Delete</button>` : ""}<p>${escapeHtml(f.question)}</p></div>`);
  }
  if (f.rep_case) {
    bits.push(`<div class="c-callout"><strong>${escapeHtml(personNameById(f.rep_id))}'s case</strong> <span class="faint small">${cWhen(f.rep_answered_at)}</span>
      <p><span class="c-chip c-grey">${escapeHtml(f.rep_reason || "")}</span> ${f.rep_case !== f.rep_reason ? escapeHtml(f.rep_case) : ""}</p>
      ${proofListHtml(f.rep_proof)}</div>`);
  }
  if (f.escalated_at && !f.decision) {
    bits.push(`<div class="c-callout c-callout-esc"><strong>Escalated to ${escapeHtml(approverName())}</strong> by ${escapeHtml(f.escalated_by || "")} <span class="faint small">${cWhen(f.escalated_at)}</span>${isReviewer() ? `<button class="c-callout-del" data-act="unesc" title="Delete this escalation">Delete</button>` : ""}<p>${escapeHtml(f.escalated_note || "")}</p></div>`);
  }
  if (f.decision) {
    bits.push(`<div class="c-callout c-callout-done"><strong>${escapeHtml(decisionText(f))}</strong> — ${escapeHtml(f.decided_by || "")} <span class="faint small">${cWhen(f.decided_at)}</span>${f.decision_note ? `<p>${escapeHtml(f.decision_note)}</p>` : ""}</div>`);
  }
  return bits.join("");
}

function reviewerActionsHtml(f) {
  const ai = f.ai || {};
  const rep = escapeHtml(personNameById(f.rep_id));
  if (f.decision) {
    return `<div class="c-actions"><button class="btn btn-secondary" data-act="reopen">Reopen / Change Decision</button></div>`;
  }
  if (!hasStake(f)) {
    return `<div class="c-actions"><p class="small muted">Nothing to decide — this one counts for the rep.</p></div>`;
  }
  let main;
  if (f.kind === "claim") {
    main = `<button class="btn c-btn-go" data-act="push">Push to Commission</button>
            <button class="btn c-btn-stop" data-act="reject">Reject Claim</button>`;
  } else {
    let acceptLabel = null;
    const accept = isRulesRead(f) ? "Accept Suggestion" : "Accept AI";
    if (ai.verdict === "partial") acceptLabel = `${accept} — Waive ${cMoney(ai.waive_amount)}, Rest Counts`;
    else if (ai.verdict === "waive") acceptLabel = `${accept} — Waive It All`;
    else if (ai.verdict === "counts") acceptLabel = `${accept} — It Counts`;
    main = `${acceptLabel ? `<button class="btn c-btn-go" data-act="accept">${acceptLabel}</button>` : ""}
      <button class="btn btn-secondary" data-act="waive">Waive It All</button>
      <button class="btn c-btn-stop" data-act="counts">Count It All</button>
      <span class="c-partial">Waive $<input type="number" min="0" step="1" max="${Number(f.amount)}" id="c-partial-amt" placeholder="0"><button class="btn btn-secondary c-btn-sm" data-act="partial">Go</button></span>`;
  }
  const canEscalate = !(COMM.board.me || {}).is_approver;
  return `<div class="c-actions">
    <div class="c-actions-main">${main}</div>
    <input type="text" id="c-note" class="c-input" placeholder="Note on the decision (optional — logged with your name)">
    <div class="c-actions-side">
      <span class="small muted">Not sure?</span>
      <button class="c-link" data-act="ask-open">Ask ${rep} for Their Case</button>
      ${canEscalate ? `<span class="faint">·</span><button class="c-link" data-act="esc-open">${f.escalated_at ? "Update Escalation" : "Escalate to " + escapeHtml(approverName())}</button>` : ""}

    </div>
    <div id="c-inline" class="c-inline"></div>
    <p class="small c-err" id="c-act-err"></p>
  </div>`;
}

function repAnswerHtml(f) {
  if (f.decision) return "";
  const ai = f.ai || {};
  if (!hasStake(f)) return `<div class="c-actions"><p class="small c-ok">Nothing to do — this counts for you.</p></div>`;
  const nothing = ["waive", "related"].includes(ai.verdict) && !f.question;
  const cur = COMM_REASONS.find((r) => r.id === f.rep_reason);
  return `<div class="c-actions">
    <div class="c-card-h">${f.rep_case ? "Update your case" : nothing ? "Nothing to do — the AI already sides with you" : "State your case"}</div>
    ${nothing && !f.rep_case ? `<p class="small muted">You can still add something if there's more to it.</p>` : ""}
    <label class="small muted">Reason</label>
    <select id="c-reason" class="c-input">
      <option value="">Pick one...</option>
      ${COMM_REASONS.map((r) => `<option ${f.rep_reason === r.id ? "selected" : ""}>${escapeHtml(r.id)}</option>`).join("")}
    </select>
    <p class="small faint" id="c-reason-hint">${cur ? escapeHtml(cur.hint) : ""}</p>
    <label class="small muted">Your case, in a line or two</label>
    <textarea id="c-case" class="c-input" rows="3" placeholder="e.g. Jaya OK'd 10% off on the 4 Sep team call — screenshot attached">${f.rep_case && f.rep_case !== f.rep_reason ? escapeHtml(f.rep_case) : ""}</textarea>
    <label class="small muted">Proof — screenshots of the booking, the cost or the approval</label>
    <div class="c-drop" id="c-drop" tabindex="0">
      <input type="file" id="c-file" accept="image/*,application/pdf" multiple hidden>
      <span>Drop screenshots here, paste one (Ctrl/Cmd+V), or <button class="c-link" id="c-pick">choose files</button></span>
    </div>
    <div class="row" style="gap:8px;margin-top:8px"><input type="url" id="c-link-in" class="c-input" placeholder="...or paste a link (Dropbox, Drive, Slack message)" style="margin:0">
      <button class="btn btn-secondary c-btn-sm" id="c-link-add">Add Link</button></div>
    <div id="c-proof-list"></div>
    <div class="row" style="gap:10px;margin-top:14px"><button class="btn btn-primary" id="c-submit">${f.rep_case ? "Update My Case" : "Send My Case"}</button>
      <span class="small c-err" id="c-ans-err"></span></div>
  </div>`;
}

function historyHtml(f) {
  const log = (COMM.board.log || []).filter((l) => l.flag_id === f.id);
  if (!log.length) return "";
  const label = (l) => {
    const d = l.detail || {};
    if (l.action === "answered") return "stated a case: " + (d.reason || "");
    if (l.action === "asked") return "asked: “" + (d.question || "") + "”";
    if (l.action === "escalated") return "escalated: “" + (d.note || "") + "”";
    if (l.action === "unescalated") return "cleared the escalation";
    if (l.action === "question cleared") return "cleared the question";
    if (l.action === "reopened") return "reopened it";
    if (l.action.indexOf("decided:") === 0) {
      const dec = l.action.slice(8);
      return "decided: " + dec + (d.waived != null && dec !== "push" && dec !== "reject" ? " (waived " + cMoney(d.waived) + " of " + cMoney(d.amount) + ")" : "") + (d.note ? " — " + d.note : "");
    }
    return l.action;
  };
  return `<details class="c-history"><summary class="small muted">History — ${log.length} entr${log.length === 1 ? "y" : "ies"}</summary>
    ${log.map((l) => `<div class="small"><strong>${escapeHtml(l.actor_name)}</strong> ${escapeHtml(label(l))} <span class="faint">${cWhen(l.at)}</span></div>`).join("")}
  </details>`;
}

function wireDetail(f) {
  const el = document.getElementById("c-detail");
  const s = COMM.session;
  el.querySelectorAll("[data-call]").forEach((b) => b.addEventListener("click", () => showCallModal(f, Number(b.dataset.call))));
  el.querySelectorAll("[data-hear]").forEach((b) => b.addEventListener("click", () => {
    const q = f.ai.quotes[Number(b.dataset.hear)];
    const idx = Math.max(0, (f.calls || []).findIndex((c) => c.id === q.call_id));
    showCallModal(f, idx, q.t);
  }));

  if (isReviewer()) {
    const err = document.getElementById("c-act-err");
    const note = () => (document.getElementById("c-note") || {}).value || null;
    const decide = async (decision, waived, btn) => {
      if (btn) btn.disabled = true;
      try {
        await API.commissionDecide(s.id, s.passcode, f.id, decision, waived, decision ? note() : null);
        advanceSelection(f);
        await refreshCommission();
      } catch (e) { if (btn) btn.disabled = false; commissionError(err, e); }
    };
    el.querySelectorAll("[data-act]").forEach((b) => b.addEventListener("click", () => {
      const act = b.dataset.act;
      const ai = f.ai || {};
      if (act === "accept") {
        if (ai.verdict === "partial") decide("partial", Number(ai.waive_amount || 0), b);
        else decide(ai.verdict === "waive" ? "waive" : "counts", null, b);
      } else if (act === "waive" || act === "counts" || act === "push" || act === "reject") decide(act, null, b);
      else if (act === "partial") {
        const v = Number(document.getElementById("c-partial-amt").value);
        if (!(v >= 0 && v <= Number(f.amount))) { err.textContent = "Enter an amount between $0 and " + cMoney(f.amount) + "."; return; }
        decide("partial", v, b);
      } else if (act === "reopen") {
        if (confirm("Reopen #" + f.order_no + "? The current decision is cleared (it stays in the history).")) { COMM.selectedId = f.id; decide(null, null, b); }
      } else if (act === "ask-open" || act === "esc-open") {
        const ask = act === "ask-open";
        document.getElementById("c-inline").innerHTML = `
          <textarea id="c-inline-text" class="c-input" rows="2" placeholder="${ask ? "What do you need from " + escapeAttr(personNameById(f.rep_id)) + "? It lands on their board and pings them." : "What's unclear? " + escapeAttr(approverName()) + " gets pinged with this."}">${!ask && f.escalated_note ? escapeHtml(f.escalated_note) : ""}</textarea>
          <button class="btn btn-secondary c-btn-sm" id="c-inline-send">${ask ? "Send Question" : "Escalate"}</button>`;
        document.getElementById("c-inline-text").focus();
        document.getElementById("c-inline-send").addEventListener("click", async (e) => {
          const text = document.getElementById("c-inline-text").value.trim();
          if (!text) return;
          e.target.disabled = true;
          try {
            COMM.selectedId = f.id;
            if (ask) await API.commissionAsk(s.id, s.passcode, f.id, text);
            else await API.commissionEscalate(s.id, s.passcode, f.id, text);
            await refreshCommission();
          } catch (x) { e.target.disabled = false; commissionError(err, x); }
        });
      } else if (act === "unask") {
        if (!confirm("Delete this question? " + personNameById(f.rep_id) + " won't see it any more (it stays in the order's history).")) return;
        COMM.selectedId = f.id;
        API.commissionAsk(s.id, s.passcode, f.id, "").then(refreshCommission).catch((x) => commissionError(err, x));
      } else if (act === "unesc") {
        if (!confirm("Delete this escalation? It stays in the order's history.")) return;
        COMM.selectedId = f.id;
        API.commissionEscalate(s.id, s.passcode, f.id, null).then(refreshCommission).catch((x) => commissionError(err, x));
      }
    }));
    return;
  }

  // ---- rep answer form ----
  const submit = document.getElementById("c-submit");
  if (!submit) return;
  const proof = (f.rep_proof || []).slice();
  const err = document.getElementById("c-ans-err");
  const list = document.getElementById("c-proof-list");
  const drawProof = () => {
    list.innerHTML = proof.length ? proofListHtml(proof) + `<button class="c-link small" id="c-proof-clear">remove all</button>` : "";
    const clr = document.getElementById("c-proof-clear");
    if (clr) clr.addEventListener("click", () => { proof.length = 0; drawProof(); });
  };
  drawProof();
  const reason = document.getElementById("c-reason");
  reason.addEventListener("change", () => {
    const r = COMM_REASONS.find((x) => x.id === reason.value);
    document.getElementById("c-reason-hint").textContent = r ? r.hint : "";
  });
  const upload = async (files) => {
    for (const file of files) {
      if (!file) continue;
      err.textContent = "Uploading " + (file.name || "screenshot") + "...";
      try { proof.push(await API.uploadCommissionProof(file)); err.textContent = ""; }
      catch (e) { err.textContent = "Upload failed: " + e.message; }
      drawProof();
    }
  };
  const drop = document.getElementById("c-drop");
  const fileIn = document.getElementById("c-file");
  document.getElementById("c-pick").addEventListener("click", (e) => { e.preventDefault(); fileIn.click(); });
  fileIn.addEventListener("change", () => upload([...fileIn.files]));
  drop.addEventListener("dragover", (e) => { e.preventDefault(); drop.classList.add("over"); });
  drop.addEventListener("dragleave", () => drop.classList.remove("over"));
  drop.addEventListener("drop", (e) => { e.preventDefault(); drop.classList.remove("over"); upload([...e.dataTransfer.files]); });
  // paste a screenshot straight from the clipboard anywhere on the form
  el.addEventListener("paste", (e) => {
    const files = [...(e.clipboardData || {}).items || []].filter((i) => i.kind === "file").map((i) => i.getAsFile());
    if (files.length) { e.preventDefault(); upload(files); }
  });
  document.getElementById("c-link-add").addEventListener("click", () => {
    const inp = document.getElementById("c-link-in");
    const v = normalizeUrl(inp.value.trim());
    if (!v) return;
    proof.push(v); inp.value = ""; drawProof();
  });
  submit.addEventListener("click", async () => {
    const r = COMM_REASONS.find((x) => x.id === reason.value);
    if (!r) { err.textContent = "Pick a reason."; return; }
    if (r.proof && !proof.length) { err.textContent = "\"" + r.id + "\" needs a screenshot attached."; return; }
    submit.disabled = true;
    try {
      await API.commissionAnswer(s.id, s.passcode, f.id, r.id, document.getElementById("c-case").value.trim(), proof);
      advanceSelection(f);
      await refreshCommission();
    } catch (e) { submit.disabled = false; commissionError(err, e); }
  });
}

// After deciding/answering, jump to the next row in the queue rather than
// leaving the person on a finished one.
function advanceSelection(f) {
  const rows = [...pageBody.querySelectorAll(".c-row")].map((r) => r.dataset.flag);
  const i = rows.indexOf(f.id);
  COMM.selectedId = rows[i + 1] || rows[i - 1] || null;
}

// ============================== modals ==============================

function commissionModal(id, inner, wide) {
  let m = document.getElementById(id);
  if (m) m.remove();
  m = document.createElement("div");
  m.className = "modal-overlay show";
  m.id = id;
  m.innerHTML = `<div class="modal-box c-modal ${wide ? "c-modal-wide" : ""}">${inner}</div>`;
  document.body.appendChild(m);
  m.addEventListener("click", (e) => { if (e.target === m) m.remove(); });
  m.querySelectorAll("[data-close]").forEach((b) => b.addEventListener("click", () => m.remove()));
  return m;
}

function showCallModal(f, callIdx, atT) {
  const c = (f.calls || [])[callIdx];
  if (!c) return;
  const ai = f.ai || {};
  const quoteTs = (ai.quotes || []).filter((q) => q.call_id === c.id).map((q) => Number(q.t));
  const lines = (c.lines || []).map((l) => {
    const hot = quoteTs.some((t) => Math.abs(t - Number(l.t)) < 3);
    return `<div class="c-bubble ${l.speaker === "rep" ? "c-bubble-rep" : "c-bubble-cust"} ${hot ? "hot" : ""}" data-t="${Number(l.t) || 0}">
      <div class="c-bubble-who">${escapeHtml((l.name || l.speaker || "").toUpperCase())} · ${tSec(l.t)}</div>${escapeHtml(l.text)}</div>`;
  }).join("");
  const isClaim = f.kind === "claim";
  const showButtons = isReviewer() && isClaim && !f.decision;
  const m = commissionModal("c-call-modal", `
    <div class="c-modal-head"><div><strong>#${escapeHtml(f.order_no)}</strong> ${escapeHtml(f.customer || "")} <strong>${cMoney(f.amount)}</strong>
      <span class="muted small">${isClaim ? "claimed by " : ""}${escapeHtml(personNameById(f.rep_id))}</span> ${aiChip(f)}</div>
      <button class="c-x" data-close aria-label="Close">&times;</button></div>
    ${ai.summary ? `<div class="c-modal-why"><div class="c-card-h">Why the ${isRulesRead(f) ? "rule check" : "AI"} says ${ai.verdict === "unrelated" || ai.verdict === "counts" ? "no" : "so"}</div><p class="small">${escapeHtml(ai.summary)}</p></div>` : ""}
    <div class="c-modal-call"><strong class="small">${escapeHtml(c.source || "Call")} · ${cDate(c.date)} · ${escapeHtml(c.rep || "")} · ${c.minutes ? c.minutes + " min · " : ""}${escapeHtml(c.direction || "")}</strong>
      ${c.audio_url ? `<audio controls preload="metadata" src="${escapeAttr(c.audio_url)}" id="c-audio" style="width:100%;margin-top:8px"></audio>`
        : c.aircall_id && c.has_recording ? `<audio controls preload="none" id="c-audio" style="width:100%;margin-top:8px;display:none"></audio>
            <button class="btn btn-secondary c-btn-sm" id="c-play" style="margin-top:8px">&#9654; Play Recording</button> <span class="small c-err" id="c-play-err"></span>`
        : `<p class="faint small">${c.answered === false ? "Missed call — no recording." : "No recording for this call."}</p>`}
      ${c.url ? `<a class="small" href="${escapeAttr(c.url)}" target="_blank" rel="noopener">open the recording &#8599;</a>` : ""}</div>
    <div class="c-transcript" id="c-transcript">${lines || `<p class="muted small">${c.source === "Aircall" ? "No transcript from Aircall for this call — play the recording instead." : "No transcript."}</p>`}
      <p class="faint small" style="text-align:center">${(c.lines || []).length} lines, nothing hidden</p></div>
    <div class="c-modal-foot">
      ${showButtons ? `<button class="btn c-btn-go-outline" data-claim="push">Push to Commission</button><button class="btn c-btn-stop" data-claim="reject">Reject Claim</button>` : ""}
      <span class="faint small" style="margin-left:auto">Whatever's decided, the transcript stays attached to the order.</span>
    </div>`, true);

  const audio = m.querySelector("#c-audio");
  // Aircall recording links expire within minutes, so fetch a fresh one on
  // demand (passcode-checked server-side; see supabase/functions/call-recording).
  const play = m.querySelector("#c-play");
  let loading = null;
  const ensureAudio = () => {
    if (!play || audio.src) return Promise.resolve();
    if (loading) return loading;
    play.disabled = true; play.textContent = "Loading...";
    loading = API.callRecording(COMM.session.id, COMM.session.passcode, f.id, c.aircall_id).then((r) => {
      audio.src = r.url; audio.style.display = "block"; play.remove();
    }).catch((e) => {
      play.disabled = false; play.innerHTML = "&#9654; Play Recording"; loading = null;
      m.querySelector("#c-play-err").textContent = e.message;
      throw e;
    });
    return loading;
  };
  if (play) play.addEventListener("click", () => ensureAudio().then(() => audio.play()).catch(() => {}));
  m.querySelectorAll(".c-bubble").forEach((b) => b.addEventListener("click", () => {
    if (!audio) return;
    ensureAudio().then(() => { audio.currentTime = Number(b.dataset.t); audio.play(); }).catch(() => {});
  }));
  if (atT != null) {
    const target = [...m.querySelectorAll(".c-bubble")].find((b) => Math.abs(Number(b.dataset.t) - atT) < 3);
    if (target) setTimeout(() => target.scrollIntoView({ block: "center" }), 0);
    if (audio) audio.addEventListener("loadedmetadata", () => { audio.currentTime = atT; }, { once: true });
  }
  m.querySelectorAll("[data-claim]").forEach((b) => b.addEventListener("click", async () => {
    b.disabled = true;
    try {
      await API.commissionDecide(COMM.session.id, COMM.session.passcode, f.id, b.dataset.claim, null, null);
      m.remove(); advanceSelection(f); await refreshCommission();
    } catch (e) { b.disabled = false; alert(e.message); }
  }));
}

// Minimal CSV: header row + comma-separated values, quotes allowed.
function parseCsv(text) {
  const rows = [];
  let row = [], cell = "", q = false;
  for (let i = 0; i < text.length; i++) {
    const ch = text[i];
    if (q) {
      if (ch === '"' && text[i + 1] === '"') { cell += '"'; i++; }
      else if (ch === '"') q = false;
      else cell += ch;
    } else if (ch === '"') q = true;
    else if (ch === ",") { row.push(cell); cell = ""; }
    else if (ch === "\n" || ch === "\r") {
      if (ch === "\r" && text[i + 1] === "\n") i++;
      row.push(cell); cell = "";
      if (row.some((c) => c.trim() !== "")) rows.push(row);
      row = [];
    } else cell += ch;
  }
  row.push(cell);
  if (row.some((c) => c.trim() !== "")) rows.push(row);
  if (rows.length < 2) return [];
  const head = rows[0].map((h) => h.trim().toLowerCase().replace(/\s+/g, "_"));
  return rows.slice(1).map((r) => {
    const o = {};
    head.forEach((h, i) => { if (r[i] != null && r[i].trim() !== "") o[h] = r[i].trim(); });
    // freight columns can come flat in a CSV
    if (o.charged || o.cost || o.service) {
      o.details = { service: o.service, charged: Number(o.charged), cost: Number(o.cost) };
      if (o.amount == null && o.cost != null) o.amount = String(Number(o.cost) - Number(o.charged || 0));
    }
    return o;
  });
}

function showImportModal() {
  const month = rangeLabel(COMM.range);
  const m = commissionModal("c-import-modal", `
    <div class="c-modal-head"><strong>Sync from Shopify</strong><button class="c-x" data-close aria-label="Close">&times;</button></div>
    <p class="small" style="text-align:left">Pulls rep orders from ${escapeHtml(month)} from Shopify, and their Aircall calls, right now
      instead of waiting for tonight's run. Takes a minute or two. Reps' answers and your decisions are never changed.</p>
    <div class="c-sync-status small" id="c-sync-status"></div>
    <div class="c-modal-foot"><button class="btn btn-primary" id="c-sync-go">Sync Now</button><button class="btn btn-secondary" data-close>Close</button></div>
    <details class="c-manual">
      <summary class="small muted">Or import a CSV file instead</summary>
      <p class="small" style="text-align:left">For orders that aren't in Shopify. One row per order, with a header row:
        <code>order_no, order_date, rep, amount</code>. Optional columns: <code>kind</code> (discount, freight, refund or claim),
        <code>customer</code>, <code>gross</code>, <code>pct</code>.</p>
      <div class="row" style="gap:10px"><input type="file" id="c-import-file" accept=".csv,.json,text/csv,application/json"><span class="small muted" id="c-import-info"></span></div>
      <textarea id="c-import-text" class="c-input" rows="5" placeholder="...or paste the CSV here" style="margin-top:8px"></textarea>
      <div class="row" style="gap:10px;margin-top:6px"><button class="btn btn-secondary c-btn-sm" id="c-import-go">Import File</button><span class="small c-err" id="c-import-err"></span></div>
    </details>`, true);

  // ---- sync ----
  const status = m.querySelector("#c-sync-status");
  const go = m.querySelector("#c-sync-go");
  go.addEventListener("click", async () => {
    go.disabled = true;
    const s = COMM.session;
    let round = 0, total = 0, calls = 0;
    // (round stays at 15 only if every round still had orders left)
    try {
      // Aircall's rate limit means a full month can take a few rounds;
      // keep going until nothing is left (with a safety cap).
      for (; round < 15; round++) {
        status.textContent = round === 0 ? "Syncing... this takes a minute or two." : `Still going — round ${round + 1} (Aircall allows one request a second)...`;
        const r = await API.syncShopify(s.id, s.passcode, COMM.range.from);
        if (r.busy) { status.textContent = "A sync is already running (maybe tonight's). Try again in a couple of minutes."; break; }
        if (!r.ok) throw new Error(r.error || "the sync failed");
        total += r.flags_written || 0;
        calls += r.calls_attached || 0;
        if (!r.deferred) {
          status.innerHTML = total
            ? `<span class="c-ok">Done.</span> ${r.orders_scanned} orders checked, ${total} flag(s) updated${calls ? `, ${calls} call(s) attached` : ""}.`
            : `<span class="c-ok">Done — everything was already up to date.</span> ${r.orders_scanned} orders checked, nothing new since the last sync.`;
          break;
        }
      }
      if (round === 15) status.textContent = "Lots of orders this month — click Sync again to finish the rest.";
      await refreshCommission();
    } catch (e) {
      const msg = /failed to fetch|networkerror|load failed/i.test(e.message)
        ? "Lost the connection while syncing. The sync may still have finished — close this, reload the board, and click Sync again to carry on."
        : e.message;
      status.innerHTML = `<span class="c-err">${escapeHtml(msg)}</span>`;
    } finally {
      go.disabled = false;
    }
  });

  // ---- manual CSV / JSON import ----
  const ta = m.querySelector("#c-import-text");
  const info = m.querySelector("#c-import-info");
  const parse = () => {
    const t = ta.value.trim();
    if (!t) return [];
    if (t[0] === "[" || t[0] === "{") { const j = JSON.parse(t); return Array.isArray(j) ? j : [j]; }
    return parseCsv(t);
  };
  const preview = () => { try { const r = parse(); info.textContent = r.length ? r.length + " row(s) ready" : ""; } catch (e) { info.textContent = "That doesn't look like a CSV"; } };
  ta.addEventListener("input", preview);
  m.querySelector("#c-import-file").addEventListener("change", async (e) => { const f = e.target.files[0]; if (f) { ta.value = await f.text(); preview(); } });
  m.querySelector("#c-import-go").addEventListener("click", async (e) => {
    const err = m.querySelector("#c-import-err");
    let rows;
    try { rows = parse(); } catch (x) { err.textContent = "Couldn't read that: " + x.message; return; }
    if (!rows.length) { err.textContent = "Choose a file or paste the rows first."; return; }
    e.target.disabled = true; err.textContent = "Importing...";
    try {
      const n = await API.commissionImport(COMM.session.id, COMM.session.passcode, rows);
      m.remove();
      COMM.selectedId = null;
      await refreshCommission();
      alert(n + " row(s) imported.");
    } catch (x) { e.target.disabled = false; err.textContent = x.message; }
  });
}

async function showPingModal() {
  const m = commissionModal("c-ping-modal", `
    <div class="c-modal-head"><strong>Monday Ping</strong><button class="c-x" data-close aria-label="Close">&times;</button></div>
    <p class="small muted" style="text-align:left">Posts by itself every Monday 8am once the schedule is set up (SETUP.md). This is exactly what it would say right now:</p>
    <pre class="c-ping-pre" id="c-ping-text">Loading...</pre>
    <div class="c-modal-foot"><button class="btn btn-primary" id="c-ping-send">Post It to Slack Now</button><button class="btn btn-secondary" data-close>Close</button>
      <span class="small c-err" id="c-ping-err"></span></div>`, true);
  const s = COMM.session;
  try { m.querySelector("#c-ping-text").textContent = await API.commissionWeeklyPing(s.id, s.passcode, false); }
  catch (e) { m.querySelector("#c-ping-text").textContent = e.message; }
  m.querySelector("#c-ping-send").addEventListener("click", async (e) => {
    e.target.disabled = true;
    try { await API.commissionWeeklyPing(s.id, s.passcode, true); m.querySelector("#c-ping-err").textContent = "Posted (if the commission Slack webhook is set up — see SETUP.md)."; }
    catch (x) { e.target.disabled = false; m.querySelector("#c-ping-err").textContent = x.message; }
  });
}

// For accounts: what's going to be paid out, decided so far vs still open.
function repTotals() {
  const by = {};
  COMM.board.flags.forEach((f) => {
    const t = by[f.rep_id] = by[f.rep_id] || { flagged: 0, waived: 0, counted: 0, open: 0, openN: 0, over: 0, claimsPushed: 0, claimsOpen: 0 };
    if (f.kind === "claim") {
      if (f.decision === "push") t.claimsPushed += Number(f.amount);
      else if (!f.decision) t.claimsOpen += Number(f.amount);
      return;
    }
    if (!hasStake(f)) { t.over += -Number(f.amount); return; }
    t.flagged += Number(f.amount);
    if (f.decision) { t.waived += Number(f.waived_amount || 0); t.counted += countsAmount(f); }
    else { t.open += Number(f.amount); t.openN++; }
  });
  return by;
}
function showTotalsModal() {
  const by = repTotals();
  const rows = Object.keys(by).sort((a, b) => personNameById(a).localeCompare(personNameById(b))).map((id) => {
    const t = by[id];
    return `<tr><td>${escapeHtml(personNameById(id))}</td><td>${cMoney(t.flagged)}</td><td class="c-ok">${cMoney(t.waived)}</td>
      <td class="c-bad">${cMoney(t.counted)}</td><td>${cMoney(t.open)} <span class="faint">(${t.openN})</span></td>
      <td class="c-ok">${cMoney(t.over)}</td><td>${cMoney(t.claimsPushed)}${t.claimsOpen ? ` <span class="faint">+${cMoney(t.claimsOpen)} open</span>` : ""}</td></tr>`;
  }).join("");
  commissionModal("c-totals-modal", `
    <div class="c-modal-head"><strong>Payout totals — ${escapeHtml(rangeLabel(COMM.range))}</strong><button class="c-x" data-close aria-label="Close">&times;</button></div>
    <p class="small muted" style="text-align:left">Dollars that count against each rep's commission base. "Still open" counts as-is if it isn't decided by month-end. Feed the decided numbers into the cash-flow forecast weekly.</p>
    <div style="overflow-x:auto"><table class="c-table"><thead><tr><th>Rep</th><th>Flagged</th><th>Waived</th><th>Counts (decided)</th><th>Still open</th><th>Freight over-recovered</th><th>Claims pushed</th></tr></thead>
    <tbody>${rows || `<tr><td colspan="7" class="muted">No flags this month.</td></tr>`}</tbody></table></div>
    <div class="c-modal-foot"><button class="btn btn-secondary" data-close>Close</button></div>`, true);
}

function showUnattributedModal() {
  const list = ((COMM.lastRun || {}).summary || {}).unattributed || [];
  commissionModal("c-unattr-modal", `
    <div class="c-modal-head"><strong>Orders the overnight read couldn't match to a rep</strong><button class="c-x" data-close aria-label="Close">&times;</button></div>
    <p class="small muted" style="text-align:left">These raised a flag but their Shopify staff member or tags don't match anyone on the board, so they were left off. Add the missing name to that rep's <code>shopify_match</code> (SETUP.md) and the next run picks them up.</p>
    <div style="overflow-x:auto"><table class="c-table"><thead><tr><th>Order</th><th>Staff member</th><th>Tags</th><th>At stake</th></tr></thead>
    <tbody>${list.map((u) => `<tr><td>${escapeHtml(u.order_no)}</td><td>${escapeHtml(u.staff || "—")}</td><td>${escapeHtml((u.tags || []).join(", ") || "—")}</td><td>${cMoney(u.amount)}</td></tr>`).join("")}</tbody></table></div>
    <div class="c-modal-foot"><button class="btn btn-secondary" data-close>Close</button></div>`, true);
}

function exportCsv() {
  const cols = ["order_no", "kind", "order_date", "week", "rep", "customer", "gross", "amount", "pct", "ai_verdict", "ai_waive", "rep_reason", "rep_case", "decision", "waived", "counts", "decided_by", "decided_at", "escalated_note"];
  const esc = (v) => { v = v == null ? "" : String(v); return /[",\n]/.test(v) ? '"' + v.replace(/"/g, '""') + '"' : v; };
  const lines = [cols.join(",")].concat(COMM.board.flags.map((f) => [
    f.order_no, f.kind, f.order_date, f.week, personNameById(f.rep_id), f.customer, f.gross, f.amount, f.pct,
    (f.ai || {}).verdict, (f.ai || {}).waive_amount, f.rep_reason, f.rep_case, f.decision, f.waived_amount,
    f.kind === "claim" ? "" : countsAmount(f), f.decided_by, f.decided_at, f.escalated_note,
  ].map(esc).join(",")));
  const blob = new Blob([lines.join("\n")], { type: "text/csv" });
  const a = document.createElement("a");
  a.href = URL.createObjectURL(blob);
  a.download = "commission-review-" + COMM.range.from + "-to-" + COMM.range.to + ".csv";
  a.click();
  setTimeout(() => URL.revokeObjectURL(a.href), 1000);
}

renderCommission();
