/* Contrail — a free, open flight tracker. All data stays on your device unless you sign in to sync. */
(() => {
'use strict';

// ---------- Data ----------
const AP = {};
AIRPORT_DATA.split('\n').forEach(l => {
  const [iata, name, city, cc, lat, lon, tz] = l.split('|');
  AP[iata] = { iata, name, city, cc, lat: +lat, lon: +lon, tz };
});
const LEGACY_KEY = 'contrail.v1', USERS_KEY = 'contrail.users', SESSION_KEY = 'contrail.session', CFG_KEY = 'contrail.cfg';
const DEVICE_TZ = Intl.DateTimeFormat().resolvedOptions().timeZone;
const DEFAULTS = { units: 'mi', apiKey: '', name: '', notify: false };
const S = { flights: [], friends: [], settings: { ...DEFAULTS } };
let tab = 'flights', sub = 'upcoming';
let fb = null, user = null, pushTimer = null, account = null, pendingShare = null;
const H = 3600e3, M = 60e3;
const readJSON = (k, d) => { try { return JSON.parse(localStorage.getItem(k)) ?? d; } catch (e) { return d; } };
const CFG = readJSON(CFG_KEY, {});
(() => { const old = readJSON(LEGACY_KEY, null); if (old?.settings?.fbConfig && !CFG.fbConfig) { CFG.fbConfig = old.settings.fbConfig; localStorage.setItem(CFG_KEY, JSON.stringify(CFG)); } })();
const saveCfg = () => localStorage.setItem(CFG_KEY, JSON.stringify(CFG));
const dataKey = () => 'contrail.data.' + account.username.toLowerCase();

function loadUser() {
  const d = readJSON(dataKey(), {});
  S.flights = d.flights || []; S.friends = d.friends || [];
  S.settings = Object.assign({}, DEFAULTS, { name: account.username }, d.settings || {});
}
function save(sync = true) {
  if (!account) return;
  try { localStorage.setItem(dataKey(), JSON.stringify(S)); } catch (e) {}
  if (sync) schedulePush();
  scheduleReminders();
}
const live = arr => arr.filter(f => !f.deleted);
const uid = () => Date.now().toString(36) + Math.random().toString(36).slice(2, 8);

// ---------- Utils ----------
const $ = s => document.querySelector(s);
const esc = s => String(s ?? '').replace(/[&<>"']/g, c => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' }[c]));
function toast(msg, ms = 2400) {
  const t = document.createElement('div'); t.className = 'toast'; t.textContent = msg;
  document.body.appendChild(t); setTimeout(() => t.remove(), ms);
}
function tzOffset(ts, tz) {
  const p = {};
  new Intl.DateTimeFormat('en-US', { timeZone: tz, hourCycle: 'h23', year: 'numeric', month: '2-digit', day: '2-digit', hour: '2-digit', minute: '2-digit', second: '2-digit' })
    .formatToParts(new Date(ts)).forEach(x => p[x.type] = x.value);
  return Date.UTC(+p.year, p.month - 1, +p.day, +p.hour % 24, +p.minute, +p.second) - Math.floor(ts / 1000) * 1000;
}
function zonedToUtc(date, time, tz) {
  const [y, m, d] = date.split('-').map(Number), [h, mi] = time.split(':').map(Number);
  const naive = Date.UTC(y, m - 1, d, h, mi);
  let ts = naive;
  for (let i = 0; i < 3; i++) ts = naive - tzOffset(ts, tz || DEVICE_TZ);
  return ts;
}
const safeTz = tz => { try { new Intl.DateTimeFormat('en', { timeZone: tz }); return tz; } catch (e) { return DEVICE_TZ; } };
const fmtTime = (ts, tz) => ts ? new Intl.DateTimeFormat(undefined, { hour: 'numeric', minute: '2-digit', timeZone: safeTz(tz) }).format(ts) : '—';
const fmtDate = (ts, tz, o = { weekday: 'short', month: 'short', day: 'numeric' }) => ts ? new Intl.DateTimeFormat(undefined, Object.assign({ timeZone: safeTz(tz) }, o)).format(ts) : '';
const localDate = (ts, tz) => new Intl.DateTimeFormat('en-CA', { timeZone: safeTz(tz), year: 'numeric', month: '2-digit', day: '2-digit' }).format(ts);
const localHM = (ts, tz) => new Intl.DateTimeFormat('en-GB', { timeZone: safeTz(tz), hour: '2-digit', minute: '2-digit', hourCycle: 'h23' }).format(ts);
function dur(ms) {
  ms = Math.abs(ms); const d = Math.floor(ms / 864e5), h = Math.floor(ms % 864e5 / H), m = Math.round(ms % H / M);
  return d ? `${d}d ${h}h` : h ? `${h}h ${m}m` : `${m}m`;
}
const rad = x => x * Math.PI / 180, deg = x => x * 180 / Math.PI;
function distKm(a, b) {
  if (!a || !b || a.lat == null || b.lat == null) return 0;
  const dLat = rad(b.lat - a.lat), dLon = rad(b.lon - a.lon);
  const h = Math.sin(dLat / 2) ** 2 + Math.cos(rad(a.lat)) * Math.cos(rad(b.lat)) * Math.sin(dLon / 2) ** 2;
  return 2 * 6371 * Math.asin(Math.sqrt(h));
}
const fmtDist = km => S.settings.units === 'km' ? `${Math.round(km).toLocaleString()} km` : `${Math.round(km * 0.621371).toLocaleString()} mi`;
function gcPoint(a, b, t) {
  const φ1 = rad(a.lat), λ1 = rad(a.lon), φ2 = rad(b.lat), λ2 = rad(b.lon);
  const d = 2 * Math.asin(Math.sqrt(Math.sin((φ2 - φ1) / 2) ** 2 + Math.cos(φ1) * Math.cos(φ2) * Math.sin((λ2 - λ1) / 2) ** 2));
  if (d === 0) return [a.lat, a.lon];
  const A = Math.sin((1 - t) * d) / Math.sin(d), B = Math.sin(t * d) / Math.sin(d);
  const x = A * Math.cos(φ1) * Math.cos(λ1) + B * Math.cos(φ2) * Math.cos(λ2);
  const y = A * Math.cos(φ1) * Math.sin(λ1) + B * Math.cos(φ2) * Math.sin(λ2);
  const z = A * Math.sin(φ1) + B * Math.sin(φ2);
  return [deg(Math.atan2(z, Math.sqrt(x * x + y * y))), deg(Math.atan2(y, x))];
}
function gcLine(a, b, n = 64) {
  const pts = []; let prev = null;
  for (let i = 0; i <= n; i++) {
    let [la, lo] = gcPoint(a, b, i / n);
    if (prev != null) { while (lo - prev > 180) lo -= 360; while (lo - prev < -180) lo += 360; }
    prev = lo; pts.push([la, lo]);
  }
  return pts;
}
function bearing(a, b) {
  const φ1 = rad(a[0]), φ2 = rad(b[0]), Δ = rad(b[1] - a[1]);
  return (deg(Math.atan2(Math.sin(Δ) * Math.cos(φ2), Math.cos(φ1) * Math.sin(φ2) - Math.sin(φ1) * Math.cos(φ2) * Math.cos(Δ))) + 360) % 360;
}
const airlineOf = num => { const c = (num || '').slice(0, 2).toUpperCase(); return AIRLINES[c] || ''; };
const normNum = s => (s || '').toUpperCase().replace(/\s+/g, '');
const apLabel = a => a ? (a.city || a.name || a.iata) : '';
function getAirport(code) {
  code = (code || '').trim().toUpperCase();
  return AP[code] ? { ...AP[code] } : (code ? { iata: code, name: code, city: '', tz: DEVICE_TZ } : null);
}

// ---------- Airline & flight-number detection ----------
const hue = s => { let h = 0; for (const c of String(s)) h = (h * 31 + c.charCodeAt(0)) % 360; return h; };
const badge = (code, lg) => `<span class="badge${lg ? ' lg' : ''}" style="background:linear-gradient(145deg,hsl(${hue(code)} 70% 58%),hsl(${(hue(code) + 40) % 360} 65% 38%))">${esc(code || '?')}</span>`;
const ALIASES = (() => {
  const m = new Map(Object.entries(AIRLINE_ALIASES));
  Object.entries(AIRLINES).forEach(([c, n]) => {
    const l = n.toLowerCase(); m.set(l, c);
    const short = l.replace(/\s+(air ?lines|airways|airline|air)$/, ''); if (short.length >= 3) m.set(short, c);
  });
  return [...m.entries()].sort((a, b) => b[0].length - a[0].length);
})();
const mkNum = (c, n) => ({ num: c + String(n).replace(/^0+(?=\d)/, ''), iata: c, airline: AIRLINES[c] || '' });
function parseFlight(raw) {
  const s = (raw || '').trim(); if (!s) return null;
  const up = s.toUpperCase().replace(/[\s\-–]+/g, ' ').trim();
  let m = up.match(/^([A-Z]{3}) ?(\d{1,4})[A-Z]?$/); if (m && AIRLINE_ICAO[m[1]]) return { ...mkNum(AIRLINE_ICAO[m[1]], m[2]), via: 'ICAO ' + m[1] };
  m = up.match(/^([A-Z0-9]{2}) ?(\d{1,4})[A-Z]?$/); if (m && AIRLINES[m[1]]) return mkNum(m[1], m[2]);
  const low = s.toLowerCase().replace(/\s+/g, ' ');
  for (const [alias, code] of ALIASES) {
    if (low === alias || low.startsWith(alias + ' ') || (low.startsWith(alias) && /\d/.test(low[alias.length] || ''))) {
      const n = low.slice(alias.length).trim().replace(/^(flight|flt|#)\s*/, '').match(/^(\d{1,4})$/);
      return n ? mkNum(code, n[1]) : { partial: true, iata: code, airline: AIRLINES[code] };
    }
  }
  if (AIRLINES[up]) return { partial: true, iata: up, airline: AIRLINES[up] };
  if (AIRLINE_ICAO[up]) return { partial: true, iata: AIRLINE_ICAO[up], airline: AIRLINES[AIRLINE_ICAO[up]] };
  m = up.match(/^([A-Z][A-Z0-9]|[0-9][A-Z]) ?(\d{1,4})$/); if (m) return { num: m[1] + m[2], iata: m[1], airline: '', unknown: true };
  return null;
}
function detectChip(p) {
  if (!p) return '';
  if (p.partial) return `<div class="chip">${badge(p.iata)}<div class="sp"><b>${esc(p.airline)}</b><span class="muted small">Now add the flight number</span></div></div>`;
  if (p.unknown) return `<div class="chip">${badge(p.iata)}<div class="sp"><b>Flight ${esc(p.num)}</b><span class="muted small">Airline “${esc(p.iata)}” not in the list — that’s OK, it still works</span></div></div>`;
  return `<div class="chip">${badge(p.iata)}<div class="sp"><b>${esc(p.airline)}</b><span class="muted small">Flight ${esc(p.num)}${p.via ? ' · from ' + esc(p.via) : ''}</span></div><span class="pill ok">✓</span></div>`;
}
const MONTHS = ['jan', 'feb', 'mar', 'apr', 'may', 'jun', 'jul', 'aug', 'sep', 'oct', 'nov', 'dec'];
function guessYear(mo, d) { const now = new Date(), y = now.getFullYear(); return new Date(y, mo, d) < new Date(now - 60 * 864e5) ? y + 1 : y; }
const ymd = (y, mo, d) => `${y}-${String(mo + 1).padStart(2, '0')}-${String(d).padStart(2, '0')}`;
// Pull a flight out of any pasted text: confirmation emails, messages, itineraries
function extractFromText(text) {
  const out = {}; const T = text.replace(/ /g, ' ');
  // flight number
  const re = /\b([A-Z]{3}|[A-Z][A-Z0-9]|[0-9][A-Z]) ?(\d{1,4})\b/g; let m;
  while ((m = re.exec(T.toUpperCase()))) {
    if (m[1].length === 3 && AIRLINE_ICAO[m[1]]) { Object.assign(out, mkNum(AIRLINE_ICAO[m[1]], m[2])); break; }
    if (m[1].length === 2 && AIRLINES[m[1]] && !/^\d+$/.test(m[1])) { Object.assign(out, mkNum(m[1], m[2])); break; }
  }
  if (!out.num) {
    const low = T.toLowerCase();
    for (const [alias, code] of ALIASES) { const r = new RegExp('\\b' + alias.replace(/[.*+?^${}()|[\]\\]/g, '\\$&') + '\\s*(?:flight|flt|#)?\\s*(\\d{1,4})\\b'); const x = low.match(r); if (x) { Object.assign(out, mkNum(code, x[1])); break; } }
  }
  // airports — prefer explicit "AAA → BBB" pairs
  const pair = T.match(/\b([A-Z]{3})\b\s*(?:→|->|–|-|—|to|✈︎?|>)\s*\b([A-Z]{3})\b/);
  if (pair && AP[pair[1]] && AP[pair[2]]) { out.from = pair[1]; out.to = pair[2]; }
  else { const codes = [...new Set((T.match(/\b[A-Z]{3}\b/g) || []).filter(c => AP[c]))]; if (codes[0]) out.from = codes[0]; if (codes[1]) out.to = codes[1]; }
  // date
  let d = T.match(/\b(20\d\d)-(\d{2})-(\d{2})\b/);
  if (d) out.date = `${d[1]}-${d[2]}-${d[3]}`;
  else if ((d = T.match(/\b(\d{1,2})(?:st|nd|rd|th)?\s+(jan|feb|mar|apr|may|jun|jul|aug|sep|oct|nov|dec)[a-z]*\.?,?\s*(20\d\d)?/i))) { const mo = MONTHS.indexOf(d[2].toLowerCase()); out.date = ymd(d[3] ? +d[3] : guessYear(mo, +d[1]), mo, +d[1]); }
  else if ((d = T.match(/\b(jan|feb|mar|apr|may|jun|jul|aug|sep|oct|nov|dec)[a-z]*\.?\s+(\d{1,2})(?:st|nd|rd|th)?,?\s*(20\d\d)?/i))) { const mo = MONTHS.indexOf(d[1].toLowerCase()); out.date = ymd(d[3] ? +d[3] : guessYear(mo, +d[2]), mo, +d[2]); }
  else if ((d = T.match(/\b(\d{1,2})\/(\d{1,2})\/(20\d\d)\b/))) out.date = ymd(+d[3], +d[1] - 1, +d[2]);
  // times
  const times = [...T.matchAll(/\b(\d{1,2})[:.](\d{2})\s*([AaPp]\.?[Mm]\.?)?/g)].map(x => { let h = +x[1]; const ap = (x[3] || '').toLowerCase(); if (ap.startsWith('p') && h < 12) h += 12; if (ap.startsWith('a') && h === 12) h = 0; return h < 24 && +x[2] < 60 ? `${String(h).padStart(2, '0')}:${x[2]}` : null; }).filter(Boolean);
  if (times[0]) out.dep = times[0]; if (times[1]) out.arr = times[1];
  const seat = T.match(/\bseat:?\s*(\d{1,2}[A-K])\b/i); if (seat) out.seat = seat[1].toUpperCase();
  const conf = T.match(/(?:confirmation|booking|record locator|PNR|reservation)(?:\s*(?:code|number|#|no\.?))?\s*:?\s*([A-Z0-9]{6})\b/i); if (conf) out.conf = conf[1].toUpperCase();
  return out;
}

// ---------- Flight logic ----------
const depT = f => f.depEst || f.depSched;
const arrT = f => f.arrEst || f.arrSched;
function phase(f, now = Date.now()) {
  if (f.status && /cancel/i.test(f.status)) return { key: 'cancel', label: 'Canceled', cls: 'bad', p: 0 };
  if (f.status && /divert/i.test(f.status)) return { key: 'divert', label: 'Diverted', cls: 'bad', p: 0 };
  const d = depT(f), a = arrT(f);
  if (now < d - 45 * M) return { key: 'sched', label: delayMin(f) >= 15 ? `Delayed ${dur(delayMin(f) * M)}` : 'On time', cls: delayMin(f) >= 15 ? 'warn' : 'ok', p: 0 };
  if (now < d) return { key: 'board', label: 'Boarding', cls: 'warn', p: 0 };
  if (now < a) return { key: 'air', label: 'In the air', cls: 'air', p: (now - d) / (a - d) };
  return { key: 'landed', label: 'Landed', cls: 'ok', p: 1 };
}
const delayMin = f => f.depEst && f.depSched ? Math.round((f.depEst - f.depSched) / M) : 0;
function countdown(f, now = Date.now()) {
  const ph = phase(f, now), d = depT(f), a = arrT(f);
  if (ph.key === 'sched' || ph.key === 'board') return `Departs in ${dur(d - now)}`;
  if (ph.key === 'air') return `Lands in ${dur(a - now)}`;
  if (ph.key === 'landed' && now - a < 12 * H) return `Landed ${dur(now - a)} ago`;
  return '';
}

function flightCard(f, opts = {}) {
  const ph = phase(f), cd = countdown(f);
  const pct = Math.max(0, Math.min(1, ph.p)) * 100;
  return `<div class="card fcard" data-open="${esc(f.id)}" data-src="${opts.friend ? 'friends' : 'flights'}">
    <div class="top">${badge(f.num.slice(0, 2))}<span class="sp"><b style="color:var(--text)">${esc(f.num)}</b> · ${esc(f.airline || airlineOf(f.num))}</span><span>${fmtDate(depT(f), f.from?.tz)}</span></div>
    ${opts.friend ? `<div class="small muted" style="margin:-4px 0 6px">✈︎ ${esc(f.sharedBy || 'Friend')}</div>` : ''}
    <div class="route">
      <div class="ap"><div class="code">${esc(f.from?.iata || '???')}</div><div class="t">${fmtTime(depT(f), f.from?.tz)}</div><div class="city">${esc(apLabel(f.from))}</div></div>
      <div class="mid"><div>${dur(arrT(f) - depT(f))}</div>
        <div class="bar"><i style="width:${pct}%"></i>${ph.key === 'air' ? `<b style="left:${pct}%">${planeSvg(90)}</b>` : ''}</div>
        <span class="pill ${ph.cls}">${esc(f.status && !/sched|expect|unknown/i.test(f.status) && ph.key !== 'air' ? f.status : ph.label)}</span></div>
      <div class="ap right"><div class="code">${esc(f.to?.iata || '???')}</div><div class="t">${fmtTime(arrT(f), f.to?.tz)}</div><div class="city" style="margin-left:auto">${esc(apLabel(f.to))}</div></div>
    </div>
    ${cd && !opts.past ? `<div class="countdown">${cd}${f.gateDep ? ` · Gate ${esc(f.gateDep)}` : ''}</div>` : ''}
  </div>`;
}
const planeSvg = (rot = 0, size = 14) => `<svg width="${size}" height="${size}" viewBox="0 0 24 24" style="transform:rotate(${rot - 90}deg)" fill="currentColor"><path d="M21 16v-2l-8-5V3.5a1.5 1.5 0 0 0-3 0V9l-8 5v2l8-2.5V19l-2 1.5V22l3.5-1 3.5 1v-1.5L13 19v-5.5z"/></svg>`;

// ---------- Rendering ----------
const TABS = [
  ['flights', 'Flights', '<path d="M21 16v-2l-8-5V3.5a1.5 1.5 0 0 0-3 0V9l-8 5v2l8-2.5V19l-2 1.5V22l3.5-1 3.5 1v-1.5L13 19v-5.5z" fill="currentColor"/>'],
  ['friends', 'Friends', '<circle cx="9" cy="8" r="3.5"/><path d="M2.5 20c.8-3.5 3.4-5.5 6.5-5.5s5.7 2 6.5 5.5"/><circle cx="17" cy="9" r="2.6"/><path d="M16 14.6c2.8-.2 4.8 1.6 5.5 4.6"/>'],
  ['stats', 'Passport', '<path d="M4 20V10M10 20V4M16 20v-7M22 20H2"/>'],
  ['settings', 'Settings', '<circle cx="12" cy="12" r="3"/><path d="M19.4 15a1.7 1.7 0 0 0 .3 1.8l.1.1a2 2 0 1 1-2.8 2.8l-.1-.1a1.7 1.7 0 0 0-1.8-.3 1.7 1.7 0 0 0-1 1.5V21a2 2 0 1 1-4 0v-.1a1.7 1.7 0 0 0-1.1-1.5 1.7 1.7 0 0 0-1.8.3l-.1.1a2 2 0 1 1-2.8-2.8l.1-.1a1.7 1.7 0 0 0 .3-1.8 1.7 1.7 0 0 0-1.5-1H3a2 2 0 1 1 0-4h.1a1.7 1.7 0 0 0 1.5-1.1 1.7 1.7 0 0 0-.3-1.8l-.1-.1a2 2 0 1 1 2.8-2.8l.1.1a1.7 1.7 0 0 0 1.8.3H9a1.7 1.7 0 0 0 1-1.5V3a2 2 0 1 1 4 0v.1a1.7 1.7 0 0 0 1 1.5 1.7 1.7 0 0 0 1.8-.3l.1-.1a2 2 0 1 1 2.8 2.8l-.1.1a1.7 1.7 0 0 0-.3 1.8V9a1.7 1.7 0 0 0 1.5 1H21a2 2 0 1 1 0 4h-.1a1.7 1.7 0 0 0-1.5 1z"/>']
];
function renderTabs() {
  $('#tabs').innerHTML = TABS.map(([k, l, ic]) => `<button data-tab="${k}" class="${tab === k ? 'on' : ''}"><svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="1.8" stroke-linecap="round" stroke-linejoin="round">${ic}</svg>${l}</button>`).join('');
}
const TITLES = { flights: 'Flights', friends: 'Friends', stats: 'Passport', settings: 'Settings' };
const initials = n => (n || '?').trim().split(/[\s._-]+/).map(w => w[0]).join('').slice(0, 2).toUpperCase();
const avatarStyle = n => `background:linear-gradient(145deg,hsl(${hue(n)} 70% 60%),hsl(${(hue(n) + 60) % 360} 70% 40%))`;
function render() {
  if (!account) return renderAuth();
  renderTabs();
  $('#title').textContent = TITLES[tab];
  const av = $('#hdrAvatar'); av.textContent = initials(account.username); av.setAttribute('style', avatarStyle(account.username));
  const m = $('#main');
  if (tab === 'flights') m.innerHTML = viewFlights();
  else if (tab === 'friends') m.innerHTML = viewFriends();
  else if (tab === 'stats') { m.innerHTML = viewStats(); drawWorldMap(); }
  else m.innerHTML = viewSettings();
}
function viewFlights() {
  const now = Date.now(), all = live(S.flights);
  const up = all.filter(f => arrT(f) > now - 6 * H).sort((a, b) => depT(a) - depT(b));
  const past = all.filter(f => arrT(f) <= now - 6 * H).sort((a, b) => depT(b) - depT(a));
  const list = sub === 'upcoming' ? up : past;
  let html = `<div class="quick"><svg width="18" height="18" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2.2" stroke-linecap="round" style="opacity:.6;flex:none"><circle cx="11" cy="11" r="7"/><path d="m20 20-3.5-3.5"/></svg>
      <input id="quickNum" placeholder="Flight number — LY8, ELY8, Delta 100…" autocomplete="off" autocapitalize="characters" enterkeyhint="go">
      <button class="icon-btn" data-act="smart-paste" title="Paste from email or message" aria-label="Paste"><svg width="18" height="18" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round"><rect x="8" y="3" width="8" height="4" rx="1"/><path d="M16 5h2a2 2 0 0 1 2 2v12a2 2 0 0 1-2 2H6a2 2 0 0 1-2-2V7a2 2 0 0 1 2-2h2"/></svg></button></div>
    <div class="detect-slot" id="quickChip"></div>
    <div class="seg"><button data-sub="upcoming" class="${sub === 'upcoming' ? 'on' : ''}">Upcoming (${up.length})</button><button data-sub="past" class="${sub === 'past' ? 'on' : ''}">Past (${past.length})</button></div>`;
  if (!list.length) {
    html += `<div class="empty"><svg viewBox="0 0 24 24" fill="currentColor"><path d="M21 16v-2l-8-5V3.5a1.5 1.5 0 0 0-3 0V9l-8 5v2l8-2.5V19l-2 1.5V22l3.5-1 3.5 1v-1.5L13 19v-5.5z"/></svg>
      <p>${sub === 'upcoming' ? 'No upcoming flights.' : 'No past flights yet.'}</p>
      <div class="actions" style="justify-content:center"><button class="btn pri" data-act="add">Add a flight</button><button class="btn" data-act="import-ics">Import from calendar</button></div></div>`;
  } else {
    let lastYear = null;
    list.forEach(f => {
      if (sub === 'past') { const y = fmtDate(depT(f), f.from?.tz, { year: 'numeric' }); if (y !== lastYear) { html += `<h2>${y}</h2>`; lastYear = y; } }
      html += flightCard(f, { past: sub === 'past' });
    });
    if (sub === 'upcoming') html += `<div class="actions"><button class="btn sm" data-act="import-ics">📅 Import from calendar</button>${S.settings.apiKey ? '<button class="btn sm" data-act="refresh-all">↻ Refresh live data</button>' : ''}</div>`;
  }
  return html;
}
function viewFriends() {
  const now = Date.now(), fr = live(S.friends).sort((a, b) => {
    const A = arrT(a) > now - 6 * H, B = arrT(b) > now - 6 * H;
    return A !== B ? (A ? -1 : 1) : A ? depT(a) - depT(b) : depT(b) - depT(a);
  });
  let html = `<div class="card"><b>Track friends' flights</b><p class="muted small" style="margin:6px 0 10px">Share your flights with a link. When a friend opens it, your flight shows up here for them — and theirs for you. Live progress works the same way.</p>
    <div class="actions" style="margin:0"><button class="btn pri sm" data-act="share-all">Share my upcoming flights</button><button class="btn sm" data-act="paste-link">Paste a friend's link</button></div></div>`;
  if (!fr.length) html += `<div class="empty"><p>No friends' flights yet.</p></div>`;
  else {
    const groups = {};
    fr.forEach(f => (groups[f.sharedBy || 'Friend'] ||= []).push(f));
    Object.entries(groups).forEach(([name, fl]) => { html += `<h2>${esc(name)}</h2>` + fl.map(f => flightCard(f, { friend: true, past: arrT(f) < now - 6 * H })).join(''); });
  }
  return html;
}
function computeStats(year) {
  const now = Date.now();
  let fl = live(S.flights).filter(f => depT(f) < now && phase(f).key !== 'cancel');
  if (year !== 'all') fl = fl.filter(f => fmtDate(depT(f), f.from?.tz, { year: 'numeric' }) === year);
  const airports = new Set(), countries = new Set(), airlines = {}, routes = {}, aircraft = {};
  let km = 0, ms = 0, longest = null;
  fl.forEach(f => {
    const d = distKm(f.from, f.to); km += d; ms += Math.max(0, Math.min(arrT(f), now) - depT(f));
    [f.from, f.to].forEach(a => { if (a?.iata) airports.add(a.iata); if (a?.cc) countries.add(a.cc); });
    const al = f.airline || airlineOf(f.num) || f.num.slice(0, 2); airlines[al] = (airlines[al] || 0) + 1;
    const r = `${f.from?.iata}–${f.to?.iata}`; routes[r] = (routes[r] || 0) + 1;
    if (f.aircraft) aircraft[f.aircraft] = (aircraft[f.aircraft] || 0) + 1;
    if (!longest || d > longest.d) longest = { f, d };
  });
  const top = o => Object.entries(o).sort((a, b) => b[1] - a[1]).slice(0, 5);
  return { fl, km, ms, airports, countries, airlines: top(airlines), routes: top(routes), aircraft: top(aircraft), longest };
}
let statYear = 'all';
function viewStats() {
  const years = [...new Set(live(S.flights).filter(f => depT(f) < Date.now()).map(f => fmtDate(depT(f), f.from?.tz, { year: 'numeric' })))].sort().reverse();
  const s = computeStats(statYear);
  const around = s.km / 40075;
  const list = (arr, empty) => arr.length ? arr.map(([k, v]) => `<div class="list-row"><span>${esc(k)}</span><span class="muted">${v}</span></div>`).join('') : `<div class="muted small">${empty}</div>`;
  return `<div class="seg">${['all', ...years].slice(0, 5).map(y => `<button data-year="${y}" class="${statYear === y ? 'on' : ''}">${y === 'all' ? 'All time' : y}</button>`).join('')}</div>
    <div class="map big" id="worldMap"></div>
    <div class="grid">
      <div class="stat"><div class="v">${s.fl.length}</div><div class="l">Flights</div></div>
      <div class="stat"><div class="v">${fmtDist(s.km)}</div><div class="l">Distance · ${around.toFixed(2)}× around Earth</div></div>
      <div class="stat"><div class="v">${Math.round(s.ms / H).toLocaleString()}h</div><div class="l">Time in the air · ${(s.ms / 864e5).toFixed(1)} days</div></div>
      <div class="stat"><div class="v">${s.airports.size}</div><div class="l">Airports · ${s.countries.size} countries</div></div>
    </div>
    ${s.longest ? `<div class="card" style="margin-top:12px"><div class="muted small">Longest flight</div><b>${esc(s.longest.f.from?.iata)} → ${esc(s.longest.f.to?.iata)}</b> · ${fmtDist(s.longest.d)} · ${esc(s.longest.f.num)}</div>` : ''}
    <h2>Top airlines</h2><div class="card">${list(s.airlines, 'No flights yet')}</div>
    <h2>Top routes</h2><div class="card">${list(s.routes, 'No flights yet')}</div>
    <h2>Aircraft</h2><div class="card">${list(s.aircraft, 'Add aircraft type to your flights (or use live lookup) to see this.')}</div>`;
}
function viewSettings() {
  const st = S.settings;
  const acct = `<div style="display:flex;gap:14px;align-items:center"><div class="avatar lg" style="${avatarStyle(account.username)}">${esc(initials(account.username))}</div>
      <div style="flex:1;min-width:0"><b style="font-size:18px">${esc(account.username)}</b><div class="muted small">${account.mode === 'cloud' ? '☁︎ Synced account' : 'Account on this device'}</div></div></div>
    <div class="actions" style="margin-bottom:0"><button class="btn sm" data-act="change-pw">Change password</button><button class="btn sm" data-act="signout">Sign out</button><button class="btn sm danger" data-act="delete-account">Delete account</button></div>`;
  return `<h2>Account</h2><div class="card">${acct}</div>
    <h2>Profile</h2><div class="card"><label class="f"><span>Your name (shown when you share flights)</span><input id="setName" value="${esc(st.name)}" placeholder="e.g. Omri"></label>
      <label class="f" style="margin:0"><span>Distance units</span><select id="setUnits"><option value="mi" ${st.units === 'mi' ? 'selected' : ''}>Miles</option><option value="km" ${st.units === 'km' ? 'selected' : ''}>Kilometers</option></select></label></div>
    <h2>Calendar</h2><div class="card"><div class="actions" style="margin:0"><button class="btn" data-act="import-ics">Import .ics file</button><button class="btn" data-act="export-ics">Export all to calendar</button></div>
      <p class="muted small" style="margin-bottom:0">Export a calendar file from Google Calendar, Apple Calendar, Outlook or TripIt and import it — Contrail finds the flights automatically.</p></div>
    <h2>Notifications</h2><div class="card"><button class="btn" data-act="notify">${st.notify && 'Notification' in window && Notification.permission === 'granted' ? '✓ Reminders on' : 'Turn on departure reminders'}</button>
      <p class="muted small" style="margin-bottom:0">Reminders 3 hours and 45 minutes before departure, and when you land, while Contrail is open or installed.</p></div>
    <h2>Live flight data</h2><div class="card"><label class="f"><span>AeroDataBox API key (free tier on RapidAPI)</span><input id="setKey" value="${esc(st.apiKey)}" placeholder="Paste key to enable lookup & live updates" autocomplete="off"></label>
      <p class="muted small" style="margin:0">With a key, type a flight number and date to auto-fill airports, times, gates, terminals, delays and aircraft. Without one, add flights manually — everything else still works.</p></div>
    <h2>Sync server</h2><div class="card">${syncServerHtml()}</div>
    <h2>Data</h2><div class="card"><div class="actions" style="margin:0"><button class="btn sm" data-act="backup">Download backup</button><button class="btn sm" data-act="restore">Restore backup</button><button class="btn sm danger" data-act="wipe">Delete all data</button></div></div>
    <p class="muted small" style="text-align:center">Contrail · free & open · your data stays on your device</p>`;
}

// ---------- Sheets ----------
function sheet(html, onMount) {
  closeSheet();
  const el = document.createElement('div'); el.className = 'sheet'; el.id = 'sheet';
  el.innerHTML = `<div>${html}</div>`;
  el.addEventListener('click', e => { if (e.target === el) closeSheet(); });
  document.body.appendChild(el); document.body.style.overflow = 'hidden';
  onMount && onMount(el);
  return el;
}
function closeSheet() { const s = $('#sheet'); if (s) { s._map && s._map.remove(); s.remove(); } document.body.style.overflow = ''; }
const sheetHd = title => `<div class="hd"><h3>${title}</h3><button class="icon-btn" data-act="close" aria-label="Close">✕</button></div>`;

function openFlight(id, src = 'flights') {
  const f = S[src].find(x => x.id === id); if (!f) return;
  const ph = phase(f), now = Date.now(), friend = src === 'friends';
  const step = (label, ts, tz, done) => `<div class="${done ? 'done' : ''}"><b>${label}</b> <span class="muted">${ts ? fmtTime(ts, tz) + ' · ' + fmtDate(ts, tz) : ''}</span></div>`;
  const d = depT(f), a = arrT(f);
  const kv = (k, v) => `<div><div class="k">${k}</div><div class="v">${esc(v || '—')}</div></div>`;
  sheet(`${sheetHd(`${esc(f.num)} <span class="muted small">${esc(f.airline || airlineOf(f.num))}</span>`)}
    ${friend ? `<p class="muted small" style="margin-top:-6px">Shared by ${esc(f.sharedBy || 'a friend')}</p>` : ''}
    <div class="map" id="fmap"></div>
    ${flightCard(f, { friend })}
    <div class="kv">
      ${kv('Dep terminal', f.terminalDep)}${kv('Dep gate', f.gateDep)}${kv('Seat', f.seat)}
      ${kv('Arr terminal', f.terminalArr)}${kv('Arr gate', f.gateArr)}${kv('Baggage', f.baggage)}
      ${kv('Distance', fmtDist(distKm(f.from, f.to)))}${kv('Duration', dur(a - d))}${kv('Aircraft', f.aircraft)}
    </div>
    ${delayMin(f) ? `<p class="small" style="color:var(--warn)">Departure ${delayMin(f) > 0 ? 'delayed' : 'early'} by ${dur(delayMin(f) * M)} (scheduled ${fmtTime(f.depSched, f.from?.tz)})</p>` : ''}
    <h2>Timeline</h2><div class="timeline">
      ${step('Leave for the airport', d - 3 * H, f.from?.tz, now > d - 3 * H)}
      ${step('Boarding', d - 40 * M, f.from?.tz, now > d - 40 * M)}
      ${step(`Depart ${esc(f.from?.iata)}`, d, f.from?.tz, now > d)}
      ${step(`Arrive ${esc(f.to?.iata)}`, a, f.to?.tz, now > a)}
    </div>
    ${f.conf ? `<p class="small">Confirmation: <b>${esc(f.conf)}</b></p>` : ''}
    ${f.notes ? `<p class="small muted">${esc(f.notes)}</p>` : ''}
    <div class="actions">
      ${!friend ? `<button class="btn sm" data-act="share-one" data-id="${f.id}">Share</button><button class="btn sm" data-act="edit" data-id="${f.id}">Edit</button>` : `<button class="btn sm" data-act="copy-friend" data-id="${f.id}">I'm on this flight too</button>`}
      <button class="btn sm" data-act="ics-one" data-id="${f.id}" data-src="${src}">Add to calendar</button>
      ${S.settings.apiKey ? `<button class="btn sm" data-act="refresh-one" data-id="${f.id}" data-src="${src}">↻ Refresh</button>` : ''}
      <button class="btn sm danger" data-act="delete" data-id="${f.id}" data-src="${src}">Delete</button>
    </div>
    <p class="muted small">${ph.key === 'air' ? 'Position is estimated along the great-circle route from live times.' : ''} ${f.updatedLive ? 'Live data updated ' + dur(now - f.updatedLive) + ' ago.' : ''}</p>`,
  el => setTimeout(() => drawFlightMap(el, f), 30));
}
function drawFlightMap(el, f) {
  const box = el.querySelector('#fmap');
  if (!window.L || !f.from?.lat || !f.to?.lat) { box.innerHTML = `<div class="empty small">${window.L ? 'Map unavailable for unknown airports' : 'Map loading…'}</div>`; if (!window.L) setTimeout(() => $('#sheet') === el && drawFlightMap(el, f), 800); return; }
  const map = L.map(box, { zoomControl: false, attributionControl: true, worldCopyJump: true });
  el._map = map;
  L.tileLayer('https://{s}.basemaps.cartocdn.com/dark_all/{z}/{x}/{y}{r}.png', { attribution: '© OpenStreetMap © CARTO', subdomains: 'abcd', maxZoom: 18 }).addTo(map);
  const line = gcLine(f.from, f.to);
  const ph = phase(f);
  const cut = Math.round(Math.max(0, Math.min(1, ph.p)) * (line.length - 1));
  L.polyline(line, { color: '#38bdf8', weight: 2, opacity: .45, dashArray: '4 6' }).addTo(map);
  if (cut > 0) L.polyline(line.slice(0, cut + 1), { color: '#5eead4', weight: 3 }).addTo(map);
  [[f.from, line[0]], [f.to, line[line.length - 1]]].forEach(([ap, p]) => L.circleMarker(p, { radius: 5, color: '#e8edf7', fillColor: '#0b1220', fillOpacity: 1, weight: 2 }).addTo(map).bindTooltip(ap.iata, { permanent: true, direction: 'top', className: '' }));
  if (ph.key === 'air') {
    const p = line[cut], q = line[Math.min(cut + 1, line.length - 1)], b = bearing(p, q);
    L.marker(p, { icon: L.divIcon({ className: 'plane-ico', html: planeSvg(b, 26), iconSize: [26, 26], iconAnchor: [13, 13] }) }).addTo(map);
  }
  map.fitBounds(L.latLngBounds(line), { padding: [30, 30] });
}
let worldMap = null;
function drawWorldMap() {
  const box = $('#worldMap'); if (!box) return;
  if (!window.L) { box.innerHTML = '<div class="empty small">Map loading…</div>'; setTimeout(() => tab === 'stats' && drawWorldMap(), 800); return; }
  box.innerHTML = '';
  if (worldMap) { try { worldMap.remove(); } catch (e) {} }
  const map = worldMap = L.map(box, { zoomControl: false, worldCopyJump: true }).setView([25, 0], 1);
  L.tileLayer('https://{s}.basemaps.cartocdn.com/dark_all/{z}/{x}/{y}{r}.png', { attribution: '© OpenStreetMap © CARTO', subdomains: 'abcd' }).addTo(map);
  const s = computeStats(statYear), bounds = [];
  s.fl.forEach(f => { if (f.from?.lat && f.to?.lat) { const l = gcLine(f.from, f.to, 40); bounds.push(...l); L.polyline(l, { color: '#5eead4', weight: 1.5, opacity: .7 }).addTo(map); } });
  const seen = new Set();
  s.fl.forEach(f => [f.from, f.to].forEach(a => { if (a?.lat && !seen.has(a.iata)) { seen.add(a.iata); L.circleMarker([a.lat, a.lon], { radius: 3, color: '#e8edf7', weight: 1, fillOpacity: 1 }).addTo(map).bindTooltip(a.iata); } }));
  if (bounds.length) map.fitBounds(L.latLngBounds(bounds), { padding: [20, 20], maxZoom: 6 });
}

// ---------- Add / edit ----------
function airportOptions() { return `<datalist id="apList">${Object.values(AP).map(a => `<option value="${a.iata}">${esc(a.city)} — ${esc(a.name)}</option>`).join('')}</datalist>`; }
function openEditor(id, prefill = {}) {
  const f = id ? S.flights.find(x => x.id === id) : null;
  const today = localDate(Date.now(), DEVICE_TZ);
  window.__lookup = null;
  const v = f ? {
    num: f.num, date: localDate(f.depSched, f.from?.tz), from: f.from?.iata, to: f.to?.iata,
    dep: localHM(f.depSched, f.from?.tz), arr: localHM(f.arrSched, f.to?.tz), arrDate: localDate(f.arrSched, f.to?.tz),
    terminalDep: f.terminalDep, gateDep: f.gateDep, terminalArr: f.terminalArr, gateArr: f.gateArr, seat: f.seat, conf: f.conf, aircraft: f.aircraft, notes: f.notes
  } : Object.assign({ date: today }, prefill);
  const inp = (k, label, ph = '', type = 'text') => `<label class="f"><span>${label}</span><input id="e_${k}" type="${type}" value="${esc(v[k] || '')}" placeholder="${ph}" ${k === 'from' || k === 'to' ? 'list="apList" autocapitalize="characters" maxlength="4"' : ''}></label>`;
  sheet(`${sheetHd(f ? 'Edit flight' : 'Add flight')}
    <div class="row">${inp('num', 'Flight number or airline', 'LY8 · ELY8 · El Al 8')}${inp('date', 'Date', '', 'date')}</div>
    <div class="detect-slot" id="editChip">${detectChip(parseFlight(v.num))}</div>
    ${f ? '' : `<button class="btn sm" style="margin:-2px 0 12px" data-act="smart-paste">📋 Paste from email or message</button>`}
    ${S.settings.apiKey ? `<div id="lookupStatus" class="muted small" style="margin:-4px 4px 10px">Route and times fill in automatically once the flight number and date are set.</div>` : `<p class="muted small" style="margin:-4px 4px 12px">Add a free live-data key in Settings and the route, times, gates and aircraft fill in automatically.</p>`}
    <div class="row">${inp('from', 'From (airport code)', 'JFK')}${inp('to', 'To', 'TLV')}</div>
    <div class="row">${inp('dep', 'Departs (local time)', '', 'time')}${inp('arr', 'Arrives (local time)', '', 'time')}</div>
    ${inp('arrDate', 'Arrival date (if different)', '', 'date')}
    <details ${f && (f.seat || f.gateDep || f.conf) ? 'open' : ''}><summary class="muted small" style="margin-bottom:10px;cursor:pointer">More details — seat, gate, confirmation…</summary>
    <div class="row">${inp('terminalDep', 'Dep terminal')}${inp('gateDep', 'Dep gate')}</div>
    <div class="row">${inp('terminalArr', 'Arr terminal')}${inp('gateArr', 'Arr gate')}</div>
    <div class="row">${inp('seat', 'Seat', '23A')}${inp('conf', 'Confirmation', 'ABC123')}</div>
    ${inp('aircraft', 'Aircraft', 'Boeing 787-9')}
    <label class="f"><span>Notes</span><textarea id="e_notes" rows="2">${esc(v.notes || '')}</textarea></label></details>
    <button class="btn pri block" data-act="save-flight" data-id="${f ? f.id : ''}">${f ? 'Save changes' : 'Add flight'}</button>
    ${airportOptions()}`);
  if (!f && v.num) scheduleAutoLookup();
}
function fillEditor(o) {
  Object.entries(o).forEach(([k, val]) => { const el = $('#e_' + k); if (el && val) el.value = val; });
  if (o.num) $('#editChip').innerHTML = detectChip(parseFlight(o.num));
  if (o.seat || o.conf) { const d = document.querySelector('#sheet details'); if (d) d.open = true; }
}
let lookupTimer = null;
function scheduleAutoLookup() {
  clearTimeout(lookupTimer);
  if (!S.settings.apiKey) return;
  const p = parseFlight(ev('num')), date = ev('date');
  if (!p || p.partial || !date) return;
  lookupTimer = setTimeout(async () => {
    const st = $('#lookupStatus'); if (!st) return;
    st.textContent = `Looking up ${p.num}…`;
    try {
      const res = await lookupFlight(p.num, date);
      if (normNum(parseFlight(ev('num'))?.num) !== p.num || ev('date') !== date) return; // input changed meanwhile
      if (!res || !res.length) { st.textContent = `No live data for ${p.num} on that date — fill in the details below.`; return; }
      let pick = res[0];
      if (res.length > 1) { const from = ev('from'); pick = res.find(r => r.from.iata === from) || res[0]; }
      window.__lookup = pick;
      fillEditor({ from: pick.from.iata, to: pick.to.iata, dep: localHM(pick.depSched, pick.from.tz), arr: localHM(pick.arrSched, pick.to.tz),
        arrDate: localDate(pick.arrSched, pick.to.tz), terminalDep: pick.terminalDep, gateDep: pick.gateDep, terminalArr: pick.terminalArr, gateArr: pick.gateArr, aircraft: pick.aircraft });
      st.innerHTML = `✓ Found <b>${esc(pick.from.iata)} → ${esc(pick.to.iata)}</b>${pick.aircraft ? ' · ' + esc(pick.aircraft) : ''}${res.length > 1 ? ` · ${res.length} legs, change “From” to pick another` : ''}`;
    } catch (e) { st.textContent = e.message; }
  }, 650);
}
async function smartPaste() {
  let text = '';
  try { text = await navigator.clipboard.readText(); } catch (e) {}
  const apply = t => {
    const x = extractFromText(t || '');
    if (!x.num && !x.from) return toast('Couldn’t find a flight in that text');
    if (!$('#e_num')) openEditor(null, x); else { fillEditor(x); scheduleAutoLookup(); }
    toast(x.num ? `Found ${x.num}${x.from && x.to ? ` · ${x.from} → ${x.to}` : ''}` : 'Found route details');
  };
  if (text && text.length > 3) return apply(text);
  const wasEditor = !!$('#e_num');
  const keep = wasEditor ? collectEditor() : null;
  sheet(`${sheetHd('Paste flight details')}<p class="muted small" style="margin-top:-6px">Paste a confirmation email, text message or itinerary. Contrail picks out the flight number, airline, airports, date, times, seat and booking code.</p>
    <textarea id="pasteBox" rows="8" placeholder="e.g. Your El Al flight LY 8 from JFK to TLV departs Nov 20 at 6:00 PM…"></textarea>
    <button class="btn pri block" style="margin-top:12px" data-act="paste-go">Find my flight</button>`, el => el.querySelector('#pasteBox').focus());
  window.__pasteApply = t => { closeSheet(); if (keep) { openEditor(null, keep); } apply(t); };
}
function collectEditor() { const o = {}; ['num', 'date', 'from', 'to', 'dep', 'arr', 'arrDate', 'seat', 'conf'].forEach(k => { const v = ev(k); if (v) o[k] = v; }); return o; }
const ev = k => ($('#e_' + k)?.value || '').trim();
function saveFromEditor(id) {
  const pf = parseFlight(ev('num'));
  const num = pf && !pf.partial ? pf.num : normNum(ev('num')), date = ev('date');
  const lk = window.__lookup && window.__lookup.num === num && window.__lookup.from.iata === ev('from').toUpperCase() && window.__lookup.to.iata === ev('to').toUpperCase() ? window.__lookup : null;
  const from = lk ? lk.from : getAirport(ev('from')), to = lk ? lk.to : getAirport(ev('to'));
  if (!num || !date || !from || !to || !ev('dep') || !ev('arr')) return toast('Fill in flight number, date, airports and times');
  const depSched = zonedToUtc(date, ev('dep'), from.tz);
  let arrSched = zonedToUtc(ev('arrDate') || date, ev('arr'), to.tz);
  while (arrSched <= depSched) arrSched += 864e5;
  const existing = id ? S.flights.find(x => x.id === id) : null;
  const f = Object.assign(existing || { id: uid(), source: 'manual' }, {
    num, airline: lk?.airline || pf?.airline || airlineOf(num) || existing?.airline || '', from, to, depSched, arrSched,
    ...(lk ? { depEst: lk.depEst, arrEst: lk.arrEst, baggage: lk.baggage, status: lk.status, updatedLive: lk.updatedLive, source: 'api' } : {}),
    terminalDep: ev('terminalDep'), gateDep: ev('gateDep'), terminalArr: ev('terminalArr'), gateArr: ev('gateArr'),
    seat: ev('seat'), conf: ev('conf'), aircraft: ev('aircraft'), notes: ev('notes'), updatedAt: Date.now()
  });
  if (f.depEst && Math.abs(f.depEst - depSched) > 12 * H) { delete f.depEst; delete f.arrEst; }
  if (!existing) S.flights.push(f);
  save(); closeSheet(); tab = 'flights'; sub = arrT(f) > Date.now() - 6 * H ? 'upcoming' : 'past'; render();
  toast(existing ? 'Saved' : `Added ${num}`);
}

// ---------- Live data (AeroDataBox) ----------
function parseAdbAirport(x) {
  const a = x?.airport || {}; const known = AP[a.iata] || {};
  return { iata: a.iata || a.icao || '???', name: a.name || known.name || '', city: a.municipalityName || known.city || '', cc: a.countryCode || known.cc || '',
    lat: a.location?.lat ?? known.lat, lon: a.location?.lon ?? known.lon, tz: a.timeZone || known.tz || DEVICE_TZ };
}
const adbTime = t => { const s = t?.utc; if (!s) return null; const v = Date.parse(s.replace(' ', 'T').replace(/Z?$/, 'Z')); return isNaN(v) ? null : v; };
async function lookupFlight(num, date) {
  const key = S.settings.apiKey; if (!key) throw new Error('No API key');
  const r = await fetch(`https://aerodatabox.p.rapidapi.com/flights/number/${encodeURIComponent(num)}/${date}?withAircraftImage=false&withLocation=false`, {
    headers: { 'X-RapidAPI-Key': key, 'X-RapidAPI-Host': 'aerodatabox.p.rapidapi.com' } });
  if (r.status === 204 || r.status === 404) return null;
  if (!r.ok) throw new Error(`Lookup failed (${r.status})`);
  const j = await r.json(); const list = Array.isArray(j) ? j : [j];
  return list.map(x => {
    const dep = x.departure || {}, arr = x.arrival || {};
    const depSched = adbTime(dep.scheduledTime), arrSched = adbTime(arr.scheduledTime);
    const depEst = adbTime(dep.runwayTime) || adbTime(dep.revisedTime) || adbTime(dep.predictedTime);
    const arrEst = adbTime(arr.runwayTime) || adbTime(arr.revisedTime) || adbTime(arr.predictedTime);
    return { num: normNum(x.number || num), airline: x.airline?.name || airlineOf(num), from: parseAdbAirport(dep), to: parseAdbAirport(arr),
      depSched, arrSched, depEst: depEst && depEst !== depSched ? depEst : null, arrEst: arrEst && arrEst !== arrSched ? arrEst : null,
      terminalDep: dep.terminal || '', gateDep: dep.gate || '', terminalArr: arr.terminal || '', gateArr: arr.gate || '', baggage: arr.baggageBelt || '',
      aircraft: x.aircraft?.model || '', status: x.status || '', updatedLive: Date.now() };
  }).filter(x => x.depSched && x.arrSched);
}
async function doLookup() {
  const num = normNum(ev('num')), date = ev('date');
  if (!num || !date) return toast('Enter flight number and date');
  const btn = document.querySelector('[data-act="lookup"]'); btn.disabled = true; btn.textContent = 'Looking up…';
  try {
    const res = await lookupFlight(num, date);
    if (!res || !res.length) { toast('Flight not found — add details manually'); return; }
    let pick = res[0];
    if (res.length > 1) { const choice = prompt(`This flight has ${res.length} legs:\n` + res.map((r, i) => `${i + 1}. ${r.from.iata} → ${r.to.iata}`).join('\n') + '\nWhich one? (number)', '1'); pick = res[(+choice || 1) - 1] || res[0]; }
    const f = Object.assign({ id: uid(), source: 'api', updatedAt: Date.now() }, pick);
    S.flights.push(f); save(); closeSheet(); tab = 'flights'; sub = 'upcoming'; render(); openFlight(f.id);
    toast(`Added ${f.num} ${f.from.iata} → ${f.to.iata}`);
  } catch (e) { toast(e.message); } finally { btn.disabled = false; btn.textContent = 'Look up flight'; }
}
async function refreshFlight(f) {
  const res = await lookupFlight(f.num, localDate(f.depSched, f.from?.tz));
  if (!res) return false;
  const m = res.find(r => r.from.iata === f.from?.iata) || res[0];
  f.depEst = m.depEst; f.arrEst = m.arrEst;
  ['terminalDep', 'gateDep', 'terminalArr', 'gateArr', 'baggage', 'aircraft', 'status', 'updatedLive'].forEach(k => { if (m[k]) f[k] = m[k]; });
  if (f.from && !f.from.lat) f.from = m.from; if (f.to && !f.to.lat) f.to = m.to;
  f.updatedAt = Date.now();
  return true;
}
async function refreshAll(force) {
  if (!S.settings.apiKey) return;
  const now = Date.now();
  const due = [...live(S.flights), ...live(S.friends)].filter(f => depT(f) - now < 36 * H && arrT(f) > now - 2 * H && (force || !f.updatedLive || now - f.updatedLive > 10 * M));
  let n = 0;
  for (const f of due) { try { if (await refreshFlight(f)) n++; } catch (e) { console.warn(e); } }
  if (n) { save(); render(); }
  if (force) toast(n ? `Updated ${n} flight${n > 1 ? 's' : ''}` : 'Nothing to refresh right now');
}

// ---------- Calendar (.ics) ----------
function parseIcs(text) {
  const lines = text.replace(/\r\n[ \t]/g, '').replace(/\n[ \t]/g, '').split(/\r?\n/);
  const events = []; let cur = null;
  for (const line of lines) {
    if (line === 'BEGIN:VEVENT') cur = {};
    else if (line === 'END:VEVENT') { if (cur) events.push(cur); cur = null; }
    else if (cur) {
      const i = line.indexOf(':'); if (i < 0) continue;
      const [name, ...params] = line.slice(0, i).split(';'); const val = line.slice(i + 1);
      const p = {}; params.forEach(x => { const [k, v] = x.split('='); p[k] = v; });
      cur[name] = { val: val.replace(/\\n/gi, '\n').replace(/\\([,;\\])/g, '$1'), p };
    }
  }
  return events;
}
function icsTime(prop) {
  if (!prop) return null;
  const m = prop.val.match(/^(\d{4})(\d{2})(\d{2})(?:T(\d{2})(\d{2})(\d{2})?(Z)?)?/); if (!m) return null;
  const [, y, mo, d, h = '00', mi = '00', , z] = m;
  if (z) return Date.UTC(+y, mo - 1, +d, +h, +mi);
  return zonedToUtc(`${y}-${mo}-${d}`, `${h}:${mi}`, prop.p.TZID ? safeTz(prop.p.TZID.replace(/^"|"$/g, '')) : DEVICE_TZ);
}
function detectFlight(e) {
  const text = [e.SUMMARY?.val, e.LOCATION?.val, e.DESCRIPTION?.val].filter(Boolean).join('\n');
  const summary = e.SUMMARY?.val || '';
  let num = null;
  const re = /\b([A-Z][A-Z0-9]|[0-9][A-Z])\s?(\d{1,4})\b/g; let m;
  while ((m = re.exec(text))) { if (AIRLINES[m[1]] || /flight|flug|vol|vuelo|טיסה/i.test(text)) { if (!/^\d+$/.test(m[1])) { num = m[1] + m[2]; break; } } }
  if (!num && !/\bflight\b|✈/i.test(summary)) return null;
  const codes = []; const cre = /\b([A-Z]{3})\b/g;
  [summary, e.LOCATION?.val || '', e.DESCRIPTION?.val || ''].forEach(t => { let c; while ((c = cre.exec(t))) if (AP[c[1]] && !codes.includes(c[1])) codes.push(c[1]); });
  let from = codes[0], to = codes[1];
  // "Flight to Paris (AF 23)" style: destination by city name
  if (!to) { const city = (summary.match(/flight to ([^(\n]+)/i) || [])[1]?.trim().toLowerCase(); if (city) { const hit = Object.values(AP).find(a => a.city.toLowerCase() === city); if (hit && hit.iata !== from) { to = hit.iata; } } }
  const dep = icsTime(e.DTSTART); let arr = icsTime(e.DTEND);
  if (!dep) return null; if (!arr || arr <= dep) arr = dep + 2 * H;
  return { num: num || 'FLIGHT', airline: airlineOf(num), from: getAirport(from) || { iata: '???', tz: DEVICE_TZ }, to: getAirport(to) || { iata: '???', tz: DEVICE_TZ },
    depSched: dep, arrSched: arr, conf: ((e.DESCRIPTION?.val || '').match(/(?:confirmation|booking|record locator|PNR)[^A-Z0-9]{0,20}([A-Z0-9]{6})\b/i) || [])[1] || '',
    source: 'calendar', calUid: e.UID?.val || '' };
}
function importIcsText(text) {
  const found = parseIcs(text).map(detectFlight).filter(Boolean);
  if (!found.length) return sheet(`${sheetHd('Import from calendar')}<div class="empty"><p>No flights found in that calendar file.</p><p class="small">Contrail looks for flight numbers (like “UA 123”) and airport codes in event titles, locations and notes.</p></div>`);
  const dupe = c => live(S.flights).some(f => (c.calUid && f.calUid === c.calUid) || (f.num === c.num && Math.abs(f.depSched - c.depSched) < 6 * H));
  window.__icsFound = found;
  sheet(`${sheetHd(`Found ${found.length} flight${found.length > 1 ? 's' : ''}`)}
    <div class="card" style="padding:0 4px">${found.map((c, i) => `<label class="chk"><input type="checkbox" data-ics="${i}" ${dupe(c) ? '' : 'checked'}>
      <div style="flex:1"><b>${esc(c.num)}</b> ${esc(c.from.iata)} → ${esc(c.to.iata)}<div class="muted small">${fmtDate(c.depSched, c.from.tz, { weekday: 'short', month: 'short', day: 'numeric', year: 'numeric' })} · ${fmtTime(c.depSched, c.from.tz)}${dupe(c) ? ' · already added' : ''}</div></div></label>`).join('')}</div>
    <p class="muted small">Flights with “???” airports can be fixed with Edit after importing${S.settings.apiKey ? ', or refreshed from live data' : ''}.</p>
    <button class="btn pri" style="width:100%" data-act="ics-confirm">Import selected</button>`);
}
function confirmIcs() {
  const picks = [...document.querySelectorAll('[data-ics]')].filter(x => x.checked).map(x => window.__icsFound[+x.dataset.ics]);
  picks.forEach(c => S.flights.push(Object.assign({ id: uid(), updatedAt: Date.now() }, c)));
  save(); closeSheet(); tab = 'flights'; render(); toast(`Imported ${picks.length} flight${picks.length === 1 ? '' : 's'}`);
  if (S.settings.apiKey) refreshAll();
}
function icsFor(flights) {
  const z = ts => new Date(ts).toISOString().replace(/[-:]/g, '').replace(/\.\d+/, '');
  const escI = s => String(s || '').replace(/([,;\\])/g, '\\$1').replace(/\n/g, '\\n');
  const body = flights.map(f => ['BEGIN:VEVENT', `UID:${f.id}@contrail`, `DTSTAMP:${z(Date.now())}`, `DTSTART:${z(depT(f))}`, `DTEND:${z(arrT(f))}`,
    `SUMMARY:${escI(`✈ ${f.num} ${f.from?.iata} → ${f.to?.iata}`)}`, `LOCATION:${escI(`${f.from?.name || ''} (${f.from?.iata})`)}`,
    `DESCRIPTION:${escI(`${f.airline || ''} ${f.num}\n${f.from?.iata} ${fmtTime(depT(f), f.from?.tz)} → ${f.to?.iata} ${fmtTime(arrT(f), f.to?.tz)}${f.seat ? '\nSeat ' + f.seat : ''}${f.conf ? '\nConfirmation ' + f.conf : ''}`)}`,
    'BEGIN:VALARM', 'TRIGGER:-PT3H', 'ACTION:DISPLAY', 'DESCRIPTION:Time to head to the airport', 'END:VALARM', 'END:VEVENT'].join('\r\n'));
  return ['BEGIN:VCALENDAR', 'VERSION:2.0', 'PRODID:-//Contrail//Flights//EN', 'CALSCALE:GREGORIAN', ...body, 'END:VCALENDAR'].join('\r\n');
}
function download(name, text, type) {
  const a = document.createElement('a'); a.href = URL.createObjectURL(new Blob([text], { type })); a.download = name;
  document.body.appendChild(a); a.click(); setTimeout(() => { URL.revokeObjectURL(a.href); a.remove(); }, 500);
}

// ---------- Sharing ----------
const b64e = s => btoa(unescape(encodeURIComponent(s))).replace(/\+/g, '-').replace(/\//g, '_').replace(/=+$/, '');
const b64d = s => decodeURIComponent(escape(atob(s.replace(/-/g, '+').replace(/_/g, '/'))));
const slimAp = a => a && { iata: a.iata, name: a.name, city: a.city, cc: a.cc, lat: a.lat, lon: a.lon, tz: a.tz };
function shareUrl(flights) {
  const by = S.settings.name || account?.username || 'A friend';
  const payload = { v: 1, by, f: flights.map(f => ({ id: f.id, num: f.num, airline: f.airline, from: AP[f.from?.iata] ? f.from.iata : slimAp(f.from), to: AP[f.to?.iata] ? f.to.iata : slimAp(f.to),
    depSched: f.depSched, arrSched: f.arrSched, depEst: f.depEst, arrEst: f.arrEst, gateDep: f.gateDep, terminalDep: f.terminalDep, aircraft: f.aircraft, status: f.status })) };
  return location.origin + location.pathname + '#share=' + b64e(JSON.stringify(payload));
}
async function shareFlights(flights) {
  if (!flights.length) return toast('No upcoming flights to share');
  if (!S.settings.name) { const n = prompt('Your name (so friends know who is flying):', ''); if (n) { S.settings.name = n.trim(); save(); } }
  const url = shareUrl(flights);
  const text = flights.length === 1 ? `Track my flight ${flights[0].num} ${flights[0].from?.iata} → ${flights[0].to?.iata} on Contrail` : `Track my ${flights.length} upcoming flights on Contrail`;
  if (navigator.share) { try { await navigator.share({ title: 'My flights', text, url }); return; } catch (e) { if (e.name === 'AbortError') return; } }
  try { await navigator.clipboard.writeText(url); toast('Link copied — send it to a friend'); }
  catch (e) { prompt('Copy this link:', url); }
}
function receiveShare(hash) {
  let data; try { data = JSON.parse(b64d(hash)); } catch (e) { return toast('That share link looks broken'); }
  const fl = (data.f || []).map(x => ({ ...x, from: typeof x.from === 'string' ? getAirport(x.from) : x.from, to: typeof x.to === 'string' ? getAirport(x.to) : x.to, sharedBy: data.by, shareId: x.id }));
  if (!fl.length) return;
  window.__incoming = fl;
  sheet(`${sheetHd(`${esc(data.by)} shared ${fl.length} flight${fl.length > 1 ? 's' : ''}`)}
    ${fl.map(f => flightCard({ ...f, id: '' }, { friend: true })).join('')}
    <div class="actions"><button class="btn pri" data-act="accept-share">Follow in Friends</button><button class="btn" data-act="accept-mine">I'm on ${fl.length > 1 ? 'these' : 'this'} too</button></div>`);
}
function acceptShare(mine) {
  const fl = window.__incoming || [];
  fl.forEach(f => {
    const target = mine ? S.flights : S.friends;
    const ex = target.find(x => !x.deleted && ((x.shareId && x.shareId === f.shareId) || (x.num === f.num && Math.abs(x.depSched - f.depSched) < 6 * H)));
    if (ex) Object.assign(ex, f, { id: ex.id, updatedAt: Date.now() });
    else target.push(Object.assign({}, f, { id: uid(), updatedAt: Date.now() }, mine ? { sharedBy: undefined, source: 'shared' } : {}));
  });
  save(); closeSheet(); tab = mine ? 'flights' : 'friends'; render(); toast('Added');
}

// ---------- Notifications ----------
let reminderTimers = [];
function notify(title, body) {
  if (!('Notification' in window) || Notification.permission !== 'granted') return;
  if (navigator.serviceWorker?.controller) navigator.serviceWorker.ready.then(r => r.showNotification(title, { body, icon: 'icon.svg', badge: 'icon.svg' })).catch(() => new Notification(title, { body }));
  else new Notification(title, { body, icon: 'icon.svg' });
}
function scheduleReminders() {
  reminderTimers.forEach(clearTimeout); reminderTimers = [];
  if (!S.settings.notify) return;
  const now = Date.now();
  live(S.flights).forEach(f => {
    [[depT(f) - 3 * H, `Time to head to ${f.from?.iata}`, `${f.num} departs at ${fmtTime(depT(f), f.from?.tz)}${f.terminalDep ? ', terminal ' + f.terminalDep : ''}`],
     [depT(f) - 45 * M, `${f.num} boards soon`, `${f.gateDep ? 'Gate ' + f.gateDep + ' · ' : ''}departs ${fmtTime(depT(f), f.from?.tz)}`],
     [arrT(f), `Welcome to ${apLabel(f.to)}`, `${f.num} has landed${f.baggage ? ' · Bags at belt ' + f.baggage : ''}`]]
      .forEach(([t, title, body]) => { if (t > now && t - now < 24 * H) reminderTimers.push(setTimeout(() => notify(title, body), t - now)); });
  });
}

// ---------- Sign-in & sync (Firebase, optional) ----------
function parseConfig(txt) {
  const m = (txt || '').match(/\{[\s\S]*\}/); if (!m) return null;
  try { return JSON.parse(m[0]); } catch (e) {}
  try { return JSON.parse(m[0].replace(/([{,]\s*)([A-Za-z_$][\w$]*)\s*:/g, '$1"$2":').replace(/'/g, '"').replace(/,\s*}/g, '}')); } catch (e) { return null; }
}
const loadScript = src => new Promise((res, rej) => { const s = document.createElement('script'); s.src = src; s.onload = res; s.onerror = rej; document.head.appendChild(s); });
let fbReady = null;
function initFirebase() {
  const cfg = parseConfig(CFG.fbConfig); if (!cfg || !cfg.apiKey) return Promise.resolve(false);
  return fbReady ||= (async () => {
    try {
      const base = 'https://www.gstatic.com/firebasejs/10.12.2/';
      if (!window.firebase) { await loadScript(base + 'firebase-app-compat.js'); await loadScript(base + 'firebase-auth-compat.js'); await loadScript(base + 'firebase-firestore-compat.js'); }
      const app = firebase.apps.length ? firebase.app() : firebase.initializeApp(cfg);
      fb = { auth: app.auth(), db: app.firestore() };
      await new Promise(res => { let first = true; fb.auth.onAuthStateChanged(u => {
        user = u;
        if (u && (!account || account.uid !== u.uid)) startSession({ username: u.displayName || u.email.split('@')[0], mode: 'cloud', uid: u.uid });
        else if (!u && account?.mode === 'cloud') { account = null; render(); }
        if (first) { first = false; res(); }
      }); });
      return true;
    } catch (e) { console.error(e); fb = null; fbReady = null; return false; }
  })();
}

// ---------- Accounts (username + password) ----------
const USER_RE = /^[a-zA-Z0-9_.-]{3,24}$/;
const toEmail = u => u.includes('@') ? u : `${u.toLowerCase()}@users.contrail.app`;
const rand = n => [...crypto.getRandomValues(new Uint8Array(n))].map(b => b.toString(16).padStart(2, '0')).join('');
async function hashPw(pw, salt, iter = 210000) {
  const enc = new TextEncoder();
  const k = await crypto.subtle.importKey('raw', enc.encode(pw), 'PBKDF2', false, ['deriveBits']);
  const bits = await crypto.subtle.deriveBits({ name: 'PBKDF2', salt: enc.encode(salt), iterations: iter, hash: 'SHA-256' }, k, 256);
  return [...new Uint8Array(bits)].map(b => b.toString(16).padStart(2, '0')).join('');
}
const getUsers = () => readJSON(USERS_KEY, {});
const fbErr = e => ({ 'auth/email-already-in-use': 'That username is taken', 'auth/invalid-credential': 'Wrong username or password', 'auth/wrong-password': 'Wrong username or password', 'auth/user-not-found': 'No account with that username', 'auth/weak-password': 'Password must be at least 6 characters', 'auth/too-many-requests': 'Too many attempts — try again in a minute', 'auth/network-request-failed': 'No connection to the sync server' }[e.code] || e.message);
async function signUp(username, pw) {
  if (!USER_RE.test(username)) throw new Error('Username: 3–24 letters, numbers, . _ or -');
  if (pw.length < 6) throw new Error('Password must be at least 6 characters');
  if (await initFirebase()) {
    try { const c = await fb.auth.createUserWithEmailAndPassword(toEmail(username), pw); await c.user.updateProfile({ displayName: username }); startSession({ username, mode: 'cloud', uid: c.user.uid }); return; }
    catch (e) { throw new Error(fbErr(e)); }
  }
  const users = getUsers(), key = username.toLowerCase();
  if (users[key]) throw new Error('That username is taken on this device');
  const salt = rand(16), iter = 210000;
  users[key] = { username, salt, iter, hash: await hashPw(pw, salt, iter), created: Date.now() };
  localStorage.setItem(USERS_KEY, JSON.stringify(users));
  // carry over flights saved before accounts existed
  const legacy = readJSON(LEGACY_KEY, null);
  if (legacy && Object.keys(users).length === 1) { localStorage.setItem('contrail.data.' + key, JSON.stringify({ flights: legacy.flights || [], friends: legacy.friends || [], settings: { ...legacy.settings, fbConfig: undefined } })); localStorage.removeItem(LEGACY_KEY); }
  startSession({ username, mode: 'local' });
}
async function signInPw(username, pw) {
  if (await initFirebase()) {
    try { await fb.auth.signInWithEmailAndPassword(toEmail(username), pw); return; }
    catch (e) { throw new Error(fbErr(e)); }
  }
  const u = getUsers()[username.toLowerCase()];
  if (!u || await hashPw(pw, u.salt, u.iter) !== u.hash) throw new Error('Wrong username or password');
  startSession({ username: u.username, mode: 'local' });
}
function startSession(acc) {
  account = acc; authMode = 'signin';
  if (acc.mode === 'local') localStorage.setItem(SESSION_KEY, acc.username.toLowerCase());
  loadUser(); closeSheet(); tab = 'flights';
  document.body.classList.add('authed'); render(); scheduleReminders(); refreshAll();
  if (pendingShare) { const p = pendingShare; pendingShare = null; receiveShare(p); }
  if (acc.mode === 'cloud') pull();
}
async function signOut() {
  if (account?.mode === 'cloud' && fb) await fb.auth.signOut().catch(() => {});
  localStorage.removeItem(SESSION_KEY); account = null; user = null;
  S.flights = []; S.friends = []; S.settings = { ...DEFAULTS };
  reminderTimers.forEach(clearTimeout); authMode = 'signin'; render();
}
let authMode = 'signin';
function renderAuth() {
  document.body.classList.remove('authed'); closeSheet();
  const cloud = !!parseConfig(CFG.fbConfig);
  const isUp = authMode === 'signup';
  $('#main').innerHTML = `<div class="auth"><div class="auth-card">
    <img class="auth-logo" src="icon.svg" alt="">
    <h1>Contrail</h1><p class="sub">${isUp ? 'Create your account' : 'Welcome back'}</p>
    <div class="seg"><button data-auth="signin" class="${!isUp ? 'on' : ''}">Sign in</button><button data-auth="signup" class="${isUp ? 'on' : ''}">Create account</button></div>
    <form id="authForm" autocomplete="on">
      <label class="f"><span>Username</span><input id="a_user" name="username" autocomplete="username" autocapitalize="none" spellcheck="false" required></label>
      <label class="f"><span>Password</span><div class="pw"><input id="a_pw" type="password" name="password" autocomplete="${isUp ? 'new-password' : 'current-password'}" required minlength="6"><button type="button" data-act="toggle-pw">Show</button></div></label>
      ${isUp ? `<label class="f"><span>Confirm password</span><input id="a_pw2" type="password" autocomplete="new-password" required></label>` : ''}
      <div class="err" id="authErr"></div>
      <button class="btn pri block" type="submit" id="authBtn">${isUp ? 'Create account' : 'Sign in'}</button>
    </form>
    <p class="muted small" style="text-align:center;margin:16px 0 0">${cloud ? '☁︎ Accounts sync across your devices.' : 'Your account and flights are stored on this device.'}<br><a href="#" data-act="sync-server">${cloud ? 'Sync server settings' : 'Sync across devices…'}</a></p>
  </div></div>`;
  setTimeout(() => $('#a_user')?.focus(), 50);
}
document.addEventListener('submit', async e => {
  if (e.target.id !== 'authForm') return;
  e.preventDefault();
  const u = $('#a_user').value.trim(), pw = $('#a_pw').value, err = $('#authErr'), btn = $('#authBtn');
  err.textContent = '';
  if (authMode === 'signup' && pw !== $('#a_pw2').value) { err.textContent = 'Passwords don’t match'; return; }
  btn.disabled = true; const label = btn.textContent; btn.textContent = 'One moment…';
  try { authMode === 'signup' ? await signUp(u, pw) : await signInPw(u, pw); }
  catch (x) { err.textContent = x.message; btn.disabled = false; btn.textContent = label; }
});
function syncServerHtml() {
  return `<p class="muted small" style="margin-top:0">By default, accounts live on one device. To sign in from any device, connect a free Firebase project — then usernames and flights sync everywhere.</p>
    <label class="f"><span>Firebase web config</span><textarea id="setFb" rows="5" placeholder='{ "apiKey": "...", "authDomain": "...", "projectId": "...", "appId": "..." }'>${esc(CFG.fbConfig || '')}</textarea></label>
    <button class="btn sm" data-act="save-fb">Save</button>
    <details class="small muted" style="margin-top:12px"><summary>How to set this up (5 min)</summary><ol style="padding-left:18px">
    <li>console.firebase.google.com → Add project.</li><li>Build → Authentication → Sign-in method → enable <b>Email/Password</b>.</li>
    <li>Authentication → Settings → Authorized domains → add <code>${esc(location.hostname || 'your-site.github.io')}</code>.</li>
    <li>Build → Firestore Database → Create, then set rules:<br><code>match /users/{u} { allow read, write: if request.auth.uid == u; }</code></li>
    <li>Project settings → Your apps → Web → copy the config here.</li></ol>
    Accounts created before connecting stay on their device; create a new account after connecting to sync.</details>`;
}
async function changePassword() {
  const cur = prompt('Current password:'); if (cur == null) return;
  const nw = prompt('New password (6+ characters):'); if (!nw) return;
  if (nw.length < 6) return toast('Password must be at least 6 characters');
  try {
    if (account.mode === 'cloud') {
      const cred = firebase.auth.EmailAuthProvider.credential(user.email, cur);
      await user.reauthenticateWithCredential(cred); await user.updatePassword(nw);
    } else {
      const users = getUsers(), u = users[account.username.toLowerCase()];
      if (await hashPw(cur, u.salt, u.iter) !== u.hash) return toast('Current password is wrong');
      u.salt = rand(16); u.hash = await hashPw(nw, u.salt, u.iter); localStorage.setItem(USERS_KEY, JSON.stringify(users));
    }
    toast('Password changed');
  } catch (e) { toast(fbErr(e)); }
}
async function deleteAccount() {
  if (!confirm(`Delete the account “${account.username}” and all its flights? This can’t be undone.`)) return;
  const pw = prompt('Enter your password to confirm:'); if (pw == null) return;
  try {
    if (account.mode === 'cloud') {
      await user.reauthenticateWithCredential(firebase.auth.EmailAuthProvider.credential(user.email, pw));
      await fb.db.collection('users').doc(user.uid).delete(); await user.delete();
    } else {
      const users = getUsers(), key = account.username.toLowerCase(), u = users[key];
      if (await hashPw(pw, u.salt, u.iter) !== u.hash) return toast('Wrong password');
      delete users[key]; localStorage.setItem(USERS_KEY, JSON.stringify(users));
    }
    localStorage.removeItem(dataKey()); await signOut(); toast('Account deleted');
  } catch (e) { toast(fbErr(e)); }
}
function mergeList(local, remote) {
  const map = new Map(local.map(f => [f.id, f]));
  (remote || []).forEach(r => { const l = map.get(r.id); if (!l || (r.updatedAt || 0) > (l.updatedAt || 0)) map.set(r.id, r); });
  return [...map.values()];
}
async function pull() {
  if (!fb || !user) return;
  try {
    const doc = await fb.db.collection('users').doc(user.uid).get();
    if (doc.exists) { const d = doc.data(); S.flights = mergeList(S.flights, d.flights); S.friends = mergeList(S.friends, d.friends); if (!S.settings.name && d.name) S.settings.name = d.name; }
    
    save(false); await push(); render();
  } catch (e) { console.error(e); toast('Sync failed: ' + (e.code || e.message)); }
}
const clean = o => JSON.parse(JSON.stringify(o));
async function push() {
  if (!fb || !user) return;
  try { await fb.db.collection('users').doc(user.uid).set(clean({ flights: S.flights, friends: S.friends, name: S.settings.name || '', updatedAt: Date.now() })); }
  catch (e) { console.error(e); }
}
function schedulePush() { if (!user) return; clearTimeout(pushTimer); pushTimer = setTimeout(push, 1200); }

// ---------- Events ----------
document.addEventListener('click', async e => {
  const t = e.target.closest('[data-tab],[data-sub],[data-year],[data-act],[data-open],[data-auth]'); if (!t) return;
  if (t.dataset.auth) { authMode = t.dataset.auth; renderAuth(); return; }
  if (t.dataset.tab) { tab = t.dataset.tab; render(); scrollTo(0, 0); return; }
  if (t.dataset.sub) { sub = t.dataset.sub; render(); return; }
  if (t.dataset.year) { statYear = t.dataset.year; render(); return; }
  if (t.dataset.open && t.dataset.open !== '' && !t.closest('.sheet')) { openFlight(t.dataset.open, t.dataset.src); return; }
  const id = t.dataset.id, src = t.dataset.src || 'flights';
  switch (t.dataset.act) {
    case 'close': closeSheet(); break;
    case 'add': openEditor(); break;
    case 'edit': closeSheet(); openEditor(id); break;
    case 'save-flight': saveFromEditor(id); break;
    case 'lookup': doLookup(); break;
    case 'delete': if (confirm('Delete this flight?')) { const f = S[src].find(x => x.id === id); f.deleted = true; f.updatedAt = Date.now(); save(); closeSheet(); render(); } break;
    case 'share-one': shareFlights(S.flights.filter(f => f.id === id)); break;
    case 'share-all': shareFlights(live(S.flights).filter(f => arrT(f) > Date.now()).sort((a, b) => depT(a) - depT(b))); break;
    case 'paste-link': { const l = prompt('Paste the link your friend sent:'); const m = l && l.match(/#share=([\w-]+)/); m ? receiveShare(m[1]) : l && toast('That isn’t a Contrail share link'); break; }
    case 'accept-share': acceptShare(false); break;
    case 'accept-mine': acceptShare(true); break;
    case 'copy-friend': window.__incoming = [S.friends.find(x => x.id === id)]; acceptShare(true); break;
    case 'import-ics': $('#icsFile').click(); break;
    case 'ics-confirm': confirmIcs(); break;
    case 'export-ics': { const fl = live(S.flights); fl.length ? download('contrail-flights.ics', icsFor(fl), 'text/calendar') : toast('No flights to export'); break; }
    case 'ics-one': { const f = S[src].find(x => x.id === id); download(`${f.num}.ics`, icsFor([f]), 'text/calendar'); break; }
    case 'refresh-one': { const f = S[src].find(x => x.id === id); t.disabled = true; try { await refreshFlight(f) ? (save(), openFlight(id, src), render(), toast('Updated')) : toast('No live data yet'); } catch (err) { toast(err.message); } t.disabled = false; break; }
    case 'refresh-all': refreshAll(true); break;
    case 'notify': {
      if (!('Notification' in window)) return toast('Notifications aren’t supported here. On iPhone, add Contrail to your Home Screen first.');
      const p = await Notification.requestPermission(); S.settings.notify = p === 'granted'; save(false); render();
      toast(p === 'granted' ? 'Reminders on' : 'Notifications were blocked'); break;
    }
    case 'save-fb': {
      const txt = $('#setFb').value.trim();
      if (txt && !parseConfig(txt)) { toast('That config wasn’t recognized'); break; }
      CFG.fbConfig = txt; saveCfg(); fbReady = null;
      if (!txt) { toast('Sync server removed'); break; }
      toast(await initFirebase() ? 'Sync server connected' : 'Couldn’t reach Firebase'); if (!account) { closeSheet(); renderAuth(); } break;
    }
    case 'sync-server': e.preventDefault(); sheet(`${sheetHd('Sync server')}${syncServerHtml()}`); break;
    case 'toggle-pw': { const i = $('#a_pw'); i.type = i.type === 'password' ? 'text' : 'password'; t.textContent = i.type === 'password' ? 'Show' : 'Hide'; break; }
    case 'signout': await signOut(); toast('Signed out'); break;
    case 'change-pw': changePassword(); break;
    case 'delete-account': deleteAccount(); break;
    case 'smart-paste': smartPaste(); break;
    case 'paste-go': window.__pasteApply($('#pasteBox').value); break;
    case 'backup': download('contrail-backup.json', JSON.stringify({ flights: S.flights, friends: S.friends }, null, 1), 'application/json'); break;
    case 'restore': $('#backupFile').click(); break;
    case 'wipe': if (confirm('Delete all flights on this device? (Synced copies are also cleared.)')) { [...S.flights, ...S.friends].forEach(f => { f.deleted = true; f.updatedAt = Date.now(); }); save(); render(); } break;
  }
});
document.addEventListener('change', e => {
  const st = S.settings;
  if (e.target.id === 'setName') { st.name = e.target.value.trim(); save(); }
  if (e.target.id === 'setUnits') { st.units = e.target.value; save(false); }
  if (e.target.id === 'setKey') { st.apiKey = e.target.value.trim(); save(false); toast(st.apiKey ? 'Live data on' : 'Live data off'); }
  if (e.target.id === 'e_from' || e.target.id === 'e_to') { e.target.value = e.target.value.toUpperCase(); if (e.target.id === 'e_from' && window.__lookup) scheduleAutoLookup(); }
  if (e.target.id === 'e_date') scheduleAutoLookup();
});
$('#icsFile').addEventListener('change', async e => { const f = e.target.files[0]; if (f) importIcsText(await f.text()); e.target.value = ''; });
$('#backupFile').addEventListener('change', async e => {
  const file = e.target.files[0]; if (!file) return;
  try { const d = JSON.parse(await file.text()); S.flights = mergeList(S.flights, d.flights); S.friends = mergeList(S.friends, d.friends); save(); render(); toast('Restored'); }
  catch (err) { toast('Not a valid backup'); } e.target.value = '';
});
$('#hdrAction').addEventListener('click', () => openEditor());

document.addEventListener('input', e => {
  const id = e.target.id;
  if (id === 'quickNum') {
    const v = e.target.value;
    if (v.length > 24 || /\n/.test(v)) { e.target.value = ''; $('#quickChip').innerHTML = ''; const x = extractFromText(v); if (x.num || x.from) { openEditor(null, x); toast(`Found ${x.num || ''} ${x.from && x.to ? x.from + ' → ' + x.to : ''}`); } return; }
    $('#quickChip').innerHTML = detectChip(parseFlight(v));
  }
  if (id === 'e_num') { $('#editChip').innerHTML = detectChip(parseFlight(e.target.value)); scheduleAutoLookup(); }
});
document.addEventListener('keydown', e => {
  if (e.target.id === 'quickNum' && e.key === 'Enter') {
    const p = parseFlight(e.target.value); if (!p) return toast('Type a flight number like LY8');
    openEditor(null, { num: p.partial ? p.iata : p.num });
  }
});

// ---------- Boot ----------
function handleHash() { const m = location.hash.match(/^#share=([\w-]+)/); if (m) { history.replaceState(null, '', location.pathname + location.search); account ? receiveShare(m[1]) : (pendingShare = m[1], toast('Sign in to see the shared flight')); } }
window.addEventListener('hashchange', handleHash);
(async () => {
  const sess = localStorage.getItem(SESSION_KEY), local = sess && getUsers()[sess];
  if (local) startSession({ username: local.username, mode: 'local' });
  else if (CFG.fbConfig) { $('#main').innerHTML = '<div class="auth"><p class="muted">Loading…</p></div>'; await initFirebase(); if (!account) renderAuth(); }
  else renderAuth();
  handleHash();
})();
setInterval(() => { if (account && !$('#sheet') && tab !== 'stats' && tab !== 'settings' && document.activeElement?.id !== 'quickNum') render(); }, 30e3);
setInterval(() => refreshAll(), 10 * M);
document.addEventListener('visibilitychange', () => { if (!document.hidden && account) { if (document.activeElement?.id !== 'quickNum') render(); refreshAll(); } });
if ('serviceWorker' in navigator && location.protocol === 'https:') navigator.serviceWorker.register('sw.js').catch(() => {});
window.__contrail = { S, parseIcs, detectFlight, importIcsText, zonedToUtc, shareUrl, receiveShare };
})();
