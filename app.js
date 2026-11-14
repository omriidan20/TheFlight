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
// Built-in sync server (Firebase web config is public by design; access is protected by Auth + Firestore rules)
const BUILTIN_FB = { apiKey: 'AIzaSyADdMj7l07qZaNNRkd-XnGY6BDpywmBCdI', authDomain: 'theflight-fb02e.firebaseapp.com', projectId: 'theflight-fb02e', storageBucket: 'theflight-fb02e.firebasestorage.app', messagingSenderId: '348811031034', appId: '1:348811031034:web:839a649e8ad9b2ad49f443' };
const fbCfgText = () => CFG.fbConfig || JSON.stringify(BUILTIN_FB);
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
  const tm = Math.round(Math.abs(ms) / M), d = Math.floor(tm / 1440), h = Math.floor(tm % 1440 / 60), m = tm % 60;
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
  document.body.classList.toggle('home', tab === 'flights');
  if (tab === 'flights') { m.innerHTML = viewFlights(); updateHomeGlobe(); }
  else if (tab === 'friends') m.innerHTML = viewFriends();
  else if (tab === 'stats') { m.innerHTML = viewStats(); drawWorldMap(); }
  else m.innerHTML = viewSettings();
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
function viewSettings() {
  const st = S.settings;
  const acct = `<div style="display:flex;gap:14px;align-items:center"><div class="avatar lg" style="${avatarStyle(account.username)}">${esc(initials(account.username))}</div>
      <div style="flex:1;min-width:0"><b style="font-size:18px">${esc(account.username)}</b><div class="muted small">${account.mode === 'cloud' ? (account.google ? '☁︎ Google account · synced' : '☁︎ Synced account') : 'Account on this device'}</div></div></div>
    <div class="actions" style="margin-bottom:0">${account.google ? '' : '<button class="btn sm" data-act="change-pw">Change password</button>'}<button class="btn sm" data-act="signout">Sign out</button><button class="btn sm danger" data-act="delete-account">Delete account</button></div>`;
  return `<h2>Account</h2><div class="card">${acct}</div>
    <h2>Profile</h2><div class="card"><label class="f"><span>Your name (shown when you share flights)</span><input id="setName" value="${esc(st.name)}" placeholder="e.g. Omri"></label>
      <label class="f" style="margin:0"><span>Distance units</span><select id="setUnits"><option value="mi" ${st.units === 'mi' ? 'selected' : ''}>Miles</option><option value="km" ${st.units === 'km' ? 'selected' : ''}>Kilometers</option></select></label></div>
    <h2>Calendar</h2><div class="card"><div class="actions" style="margin:0"><button class="btn" data-act="import-ics">Import .ics file</button><button class="btn" data-act="export-ics">Export all to calendar</button></div>
      <p class="muted small" style="margin-bottom:0">Export a calendar file from Google Calendar, Apple Calendar, Outlook or TripIt and import it — Contrail finds the flights automatically.</p></div>
    <h2>Notifications</h2><div class="card"><button class="btn" data-act="notify">${st.notify && 'Notification' in window && Notification.permission === 'granted' ? '✓ Reminders on' : 'Turn on departure reminders'}</button>
      <p class="muted small" style="margin-bottom:0">Reminders 3 hours and 45 minutes before departure, and when you land, while Contrail is open or installed.</p></div>
    <h2>Live flight data</h2><div class="card" id="liveCard">
      <p class="small" style="margin-top:0">${st.apiKey ? '✓ <b>Live data is on.</b> Times, gates, terminals, delays and aircraft fill in automatically and update every 10 minutes.' : 'Turn this on to get exact <b>times, gates, terminals, delays and aircraft</b> automatically. It’s free for personal use (AeroDataBox free plan).'}</p>
      ${st.apiKey ? '' : `<ol class="small muted steps"><li>Open <a href="https://rapidapi.com/aedbx-aedbx/api/aerodatabox/pricing" target="_blank" rel="noopener">AeroDataBox on RapidAPI</a> and sign up (free).</li><li>Choose the <b>Basic</b> plan ($0) and tap <b>Subscribe</b>.</li><li>Open the <b>Endpoints</b> tab and copy the <b>X-RapidAPI-Key</b> value.</li><li>Paste it below.</li></ol>`}
      <label class="f"><span>API key</span><input id="setKey" value="${esc(st.apiKey)}" placeholder="Paste your X-RapidAPI-Key" autocomplete="off" autocapitalize="none" spellcheck="false"></label>
      <button class="btn sm" data-act="test-key">Test it</button>
      <p class="muted small">Your key is saved to your account only, so it works on all your devices.</p>
      <label class="f" style="margin-top:14px"><span>Live plane position server (OpenSky)</span><input id="setLive" value="${esc(st.liveProxy || '')}" placeholder="https://contrail-live.you.workers.dev" autocomplete="off" autocapitalize="none" spellcheck="false"></label>
      <p class="muted small" style="margin:0">${liveProxy() ? '✓ The plane on the map follows the real aircraft while it’s in the air.' : 'Optional: shows the real aircraft position instead of an estimate.'}</p></div>
    <h2>Sync server</h2><div class="card">${syncServerHtml()}</div>
    <h2>Data</h2><div class="card"><div class="actions" style="margin:0"><button class="btn sm" data-act="backup">Download backup</button><button class="btn sm" data-act="restore">Restore backup</button><button class="btn sm danger" data-act="wipe">Delete all data</button></div></div>
    <p class="muted small" style="text-align:center">Contrail · version 10</p>`;
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
function closeSheet() { const s = $('#sheet'); if (s) { s._liveTimer && clearInterval(s._liveTimer); s._map && s._map.remove(); s.remove(); } document.body.style.overflow = ''; }
const sheetHd = title => `<div class="hd"><h3>${title}</h3><button class="icon-btn" data-act="close" aria-label="Close">✕</button></div>`;

// ---------- Live plane position (OpenSky via proxy) ----------
const LIVE_PROXY_DEFAULT = '';
const liveProxy = () => (S.settings.liveProxy || LIVE_PROXY_DEFAULT).replace(/\/+$/, '');
const AIRLINE_ICAO_REV = Object.fromEntries(Object.entries(AIRLINE_ICAO).map(([i, a]) => [a, i]));
const icaoCallsign = num => { const c = num.slice(0, 2), ic = AIRLINE_ICAO_REV[c]; return ic ? ic + num.slice(2) : num; };
const liveFresh = f => f.livePos && Date.now() - f.livePos.t < 4 * M;
async function fetchLivePos(f) {
  const px = liveProxy(), ph = phase(f);
  if (!px || ph.key !== 'air' || f.from?.lat == null || f.to?.lat == null) return false;
  if (f._liveBackoff && Date.now() < f._liveBackoff) return false;
  const est = liveFresh(f) ? [f.livePos.lat, f.livePos.lon] : gcPoint(f.from, f.to, ph.p);
  try {
    const r = await fetch(`${px}/track?callsign=${encodeURIComponent(icaoCallsign(f.num))}&lat=${est[0].toFixed(3)}&lon=${est[1].toFixed(3)}`);
    const j = await r.json();
    if (j.found) { f.livePos = { lat: j.lat, lon: j.lon, alt: j.alt, speed: j.speed, track: j.track, ground: j.ground, t: Date.now() }; f._liveBackoff = 0; return true; }
    f._liveBackoff = Date.now() + (r.status === 429 ? 30 : 5) * M;
  } catch (e) { f._liveBackoff = Date.now() + 5 * M; }
  return false;
}
const liveLine = f => { if (!liveFresh(f)) return ''; const p = f.livePos, km = S.settings.units === 'km';
  const alt = p.alt != null ? `${Math.round(km ? p.alt : p.alt * 3.28084).toLocaleString()} ${km ? 'm' : 'ft'}` : '', spd = p.speed != null ? `${Math.round(p.speed * (km ? 3.6 : 2.23694))} ${km ? 'km/h' : 'mph'}` : '';
  return ['● Live position', alt, spd].filter(Boolean).join(' · '); };

// ---------- Globe maps (MapLibre + NASA night-lights imagery, no API key) ----------
const NIGHT_TILES = 'https://gibs.earthdata.nasa.gov/wmts/epsg3857/best/VIIRS_CityLights_2012/default//GoogleMapsCompatible_Level8/{z}/{y}/{x}.jpg';
const ML = () => window.maplibregl;
function globeStyle() {
  return { version: 8, projection: { type: 'globe' },
    sources: { night: { type: 'raster', tiles: [NIGHT_TILES], tileSize: 256, maxzoom: 8, attribution: 'Imagery © NASA GIBS' } },
    layers: [{ id: 'space', type: 'background', paint: { 'background-color': '#02040a' } },
             { id: 'night', type: 'raster', source: 'night', paint: { 'raster-saturation': -0.15, 'raster-contrast': 0.2, 'raster-brightness-min': 0.04 } }],
    sky: { 'atmosphere-blend': ['interpolate', ['linear'], ['zoom'], 0, 1, 5, 1, 7, 0] } };
}
function makeGlobe(box, { interactive = true, center = [10, 30], zoom = 1.2 } = {}) {
  const map = new (ML().Map)({ container: box, style: globeStyle(), center, zoom, interactive, attributionControl: { compact: true }, renderWorldCopies: false, maxZoom: 9 });
  map._markers = [];
  map._ready = new Promise(res => map.on('load', () => {
    map.resize();
    map.addSource('routes', { type: 'geojson', data: { type: 'FeatureCollection', features: [] } });
    map.addLayer({ id: 'routes-glow', type: 'line', source: 'routes', filter: ['==', ['get', 'kind'], 'main'], paint: { 'line-color': '#7cc4ff', 'line-width': 9, 'line-opacity': 0.18, 'line-blur': 4 }, layout: { 'line-cap': 'round' } });
    map.addLayer({ id: 'routes-dim', type: 'line', source: 'routes', filter: ['==', ['get', 'kind'], 'dim'], paint: { 'line-color': '#7ef0dc', 'line-width': 1.4, 'line-opacity': 0.55 }, layout: { 'line-cap': 'round' } });
    map.addLayer({ id: 'routes-main', type: 'line', source: 'routes', filter: ['==', ['get', 'kind'], 'main'], paint: { 'line-color': '#8fd0ff', 'line-width': 2.8 }, layout: { 'line-cap': 'round' } });
    map.addLayer({ id: 'routes-done', type: 'line', source: 'routes', filter: ['==', ['get', 'kind'], 'done'], paint: { 'line-color': '#7ef0dc', 'line-width': 3.2 }, layout: { 'line-cap': 'round' } });
    res(map);
  }));
  return map;
}
const lineFeat = (coords, kind, id) => ({ type: 'Feature', properties: { kind, id }, geometry: { type: 'LineString', coordinates: coords.map(([la, lo]) => [lo, la]) } });
function pinMarker(map, a, side) {
  const el = document.createElement('div'); el.className = 'gpin ' + side;
  el.innerHTML = `<i></i><span>${esc(a.city || a.name || '')}</span><b>${esc(a.iata)}</b>`;
  return new (ML().Marker)({ element: el, anchor: side === 'r' ? 'left' : 'right', offset: side === 'r' ? [-6, 0] : [6, 0] }).setLngLat([a.lon, a.lat]).addTo(map);
}
// Camera that fits a route into the part of the map not covered by panels
function routeCam(map, f, padTop = 0, padBottom = 0) {
  const c = map.getContainer(), W = c.clientWidth || innerWidth, Hh = c.clientHeight || innerHeight;
  const visH = Math.max(140, Hh - padTop - padBottom);
  const mid = gcPoint(f.from, f.to, 0.5), km = Math.max(distKm(f.from, f.to), 60);
  const target = 0.66 * Math.min(W - 40, visH * 1.35);
  const zoom = Math.max(0.9, Math.min(7, Math.log2(target * 40075 * Math.cos(rad(mid[0])) / (km * 512))));
  return { center: [mid[1], mid[0]], zoom, padding: { top: padTop, bottom: padBottom, left: 0, right: 0 } };
}
function placePins(map, f) {
  map._pins?.forEach(m => m.remove());
  const pa = map.project([f.from.lon, f.from.lat]), pb = map.project([f.to.lon, f.to.lat]), fromLeft = pa.x <= pb.x;
  map._pins = [pinMarker(map, f.from, fromLeft ? 'l' : 'r'), pinMarker(map, f.to, fromLeft ? 'r' : 'l')];
}
async function showRoutes(map, flights, focus, opts = {}) {
  await map._ready; map.resize();
  map._markers.forEach(m => m.remove()); map._markers = []; map._pins?.forEach(m => m.remove()); map._pins = [];
  const feats = [];
  flights.filter(f => f.from?.lat != null && f.to?.lat != null).forEach(f => {
    const line = gcLine(f.from, f.to, 96);
    if (focus && f.id === focus.id) {
      const ph = phase(f);
      let cut = Math.round(Math.max(0, Math.min(1, ph.p)) * (line.length - 1));
      if (ph.key === 'air' && liveFresh(f)) { let best = 1e9; line.forEach((pt, i) => { const d = (pt[0] - f.livePos.lat) ** 2 + (pt[1] - f.livePos.lon) ** 2; if (d < best) { best = d; cut = i; } }); }
      feats.push(lineFeat(line, 'main', f.id));
      if (cut > 0) feats.push(lineFeat(line.slice(0, cut + 1), 'done', f.id));
      if (ph.key === 'air') {
        const el = document.createElement('div'); el.className = 'gplane' + (liveFresh(f) ? ' live' : '');
        let pos, rot;
        if (liveFresh(f)) { pos = [f.livePos.lat, f.livePos.lon]; rot = f.livePos.track ?? 0; }
        else { const p = line[cut], q = line[Math.min(cut + 1, line.length - 1)]; pos = p; rot = bearing(p, q); }
        el.innerHTML = planeSvg(rot, 30);
        map._markers.push(new (ML().Marker)({ element: el }).setLngLat([pos[1], pos[0]]).addTo(map));
      }
    } else feats.push(lineFeat(line, 'dim', f.id));
  });
  map.getSource('routes').setData({ type: 'FeatureCollection', features: feats });
  map._focus = focus;
  if (focus && focus.from?.lat != null && focus.to?.lat != null) {
    if (!opts.keepCamera) map.jumpTo(routeCam(map, focus, opts.padTop || 0, opts.padBottom || 0));
    placePins(map, focus);
  } else if (opts.fitAll) {
    const pts = flights.flatMap(f => f.from?.lat != null && f.to?.lat != null ? [[f.from.lon, f.from.lat], [f.to.lon, f.to.lat]] : []);
    if (pts.length) { const lon = pts.reduce((s, p) => s + p[0], 0) / pts.length, lat = pts.reduce((s, p) => s + p[1], 0) / pts.length; map.jumpTo({ center: [lon, lat], zoom: 1.1 }); }
  }
}
function globeFallback(box) { if (box) box.classList.add('nomap'); }
function drawFlightMap(el, f) {
  const box = el.querySelector('#fmap'); if (!box) return;
  if (f.from?.lat == null || f.to?.lat == null) { box.style.display = 'none'; return; }
  if (!ML()) { if (!el._tries) el._tries = 0; if (el._tries++ < 20) setTimeout(() => $('#sheet') === el && drawFlightMap(el, f), 400); else globeFallback(box); return; }
  try { const map = makeGlobe(box, { interactive: true }); el._map = map; showRoutes(map, [f], f, { padTop: 70, padBottom: el._vis || innerHeight * 0.55 }); } catch (e) { console.warn(e); globeFallback(box); }
}
// Home: one persistent full-screen globe behind the flight list
let homeGlobe = null;
function updateHomeGlobe() {
  const box = $('#globe'); if (!box) return;
  if (!ML()) { setTimeout(() => tab === 'flights' && updateHomeGlobe(), 500); return; }
  try {
    if (!homeGlobe) {
      homeGlobe = makeGlobe(box, { interactive: true });
      homeGlobe._ready.then(m => m.on('click', 'routes-main', () => homeGlobe._focus && openFlight(homeGlobe._focus)));
    }
    const now = Date.now(), up = live(S.flights).filter(f => arrT(f) > now - 6 * H).sort((a, b) => depT(a) - depT(b));
    const focus = up.find(f => f.from?.lat != null && f.to?.lat != null);
    homeGlobe._focus = focus?.id;
    requestAnimationFrame(() => { try { homeGlobe.resize(); } catch (e) {} });
    if (focus && phase(focus).key === 'air' && liveProxy() && !liveFresh(focus)) fetchLivePos(focus).then(ok => { if (ok) { save(false); homeGlobe._key = ''; updateHomeGlobe(); } });
    const key = JSON.stringify([innerWidth, innerHeight, ...up.map(f => [f.id, f.from?.iata, f.to?.iata, Math.round(phase(f).p * 50), f.livePos?.t || 0])]);
    if (homeGlobe._key === key) return; homeGlobe._key = key;
    showRoutes(homeGlobe, focus ? up : live(S.flights), focus, { fitAll: true, padTop: 90, padBottom: innerHeight * 0.56 });
  } catch (e) { console.warn(e); }
}
let worldMap = null;
function drawWorldMap() {
  const box = $('#worldMap'); if (!box) return;
  if (worldMap) { try { worldMap.remove(); } catch (e) {} worldMap = null; }
  if (!ML()) { setTimeout(() => tab === 'stats' && drawWorldMap(), 500); return; }
  try { worldMap = makeGlobe(box, { interactive: true }); showRoutes(worldMap, computeStats(statYear).fl, null, { fitAll: true }); } catch (e) { globeFallback(box); }
}

function viewFlights() {
  const now = Date.now(), all = live(S.flights);
  const up = all.filter(f => arrT(f) > now - 6 * H).sort((a, b) => depT(a) - depT(b));
  const past = all.filter(f => arrT(f) <= now - 6 * H).sort((a, b) => depT(b) - depT(a));
  const list = sub === 'upcoming' ? up : past;
  let html = `<div class="homepanel"><button class="quick" data-act="add"><svg width="18" height="18" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2.2" stroke-linecap="round" style="opacity:.6;flex:none"><circle cx="11" cy="11" r="7"/><path d="m20 20-3.5-3.5"/></svg><span class="sp muted">Add a flight — LY8, Delta 100…</span><span class="plus">+</span></button>`;
  html += `<div class="seg"><button data-sub="upcoming" class="${sub === 'upcoming' ? 'on' : ''}">Upcoming${up.length ? ` · ${up.length}` : ''}</button><button data-sub="past" class="${sub === 'past' ? 'on' : ''}">Past${past.length ? ` · ${past.length}` : ''}</button></div>`;
  if (!list.length) {
    html += `<div class="empty"><p>${sub === 'upcoming' ? 'No upcoming flights yet.' : 'No past flights yet.'}</p>
      <div class="actions" style="justify-content:center"><button class="btn pri" data-act="add">Add a flight</button><button class="btn" data-act="import-ics">Import from calendar</button></div></div>`;
  } else if (sub === 'upcoming') {
    html += `<div class="card list">${list.map(f => rowItem(f)).join('')}</div>`;
    html += `<div class="actions"><button class="btn sm" data-act="import-ics">📅 Import from calendar</button>${S.settings.apiKey ? '<button class="btn sm" data-act="refresh-all">↻ Refresh live data</button>' : ''}</div>`;
  } else html += pastList(past);
  return html + '</div>';
}
const dayDiff = f => { const a = localDate(arrT(f), f.to?.tz), d = localDate(depT(f), f.from?.tz); return Math.round((Date.parse(a) - Date.parse(d)) / 864e5); };
const cityOf = a => esc(a?.city || a?.name || a?.iata || '???');
function rowItem(f, past) {
  const now = Date.now(), ph = phase(f), d = depT(f), a = arrT(f), plus = dayDiff(f);
  let big, unit;
  if (past) { big = fmtDate(d, f.from?.tz, { day: 'numeric' }); unit = fmtDate(d, f.from?.tz, { month: 'short' }); }
  else if (ph.key === 'air') { big = '✈︎'; unit = 'In air'; }
  else if (ph.key === 'landed') { big = '✓'; unit = 'Landed'; }
  else if (ph.key === 'cancel') { big = '✕'; unit = 'Canceled'; }
  else { const ms = d - now; if (ms >= 864e5) { big = Math.floor(ms / 864e5); unit = big === 1 ? 'Day' : 'Days'; } else if (ms >= H) { big = Math.floor(ms / H); unit = big === 1 ? 'Hour' : 'Hours'; } else { big = Math.max(1, Math.round(ms / M)); unit = 'Min'; } }
  const dl = delayMin(f);
  return `<div class="frow" data-open="${esc(f.id)}" data-src="flights">
    <div class="cd ${ph.key === 'air' ? 'air' : ''}"><b>${big}</b><span>${unit}</span></div>
    <div class="fr-main">
      <div class="fr-top">${badge(f.num.slice(0, 2))}<span>${esc(f.num)}</span><span class="sp"></span><span>${past ? fmtDate(d, f.from?.tz, { year: 'numeric' }) : fmtDate(d, f.from?.tz)}</span></div>
      <div class="fr-title">${cityOf(f.from)} <span class="muted">to</span> ${cityOf(f.to)}</div>
      <div class="fr-times"><span><i>↗</i> <em>${esc(f.from?.iata)}</em> ${fmtTime(d, f.from?.tz)}</span><span><i>↘</i> <em>${esc(f.to?.iata)}</em> ${fmtTime(a, f.to?.tz)}${plus ? `<sup>${plus > 0 ? '+' : ''}${plus}</sup>` : ''}</span></div>
      ${ph.key === 'air' ? `<div class="bar"><i style="width:${ph.p * 100}%"></i></div><div class="small" style="color:var(--acc)">Lands in ${dur(a - now)}</div>` : ''}
      ${!past && dl >= 15 ? `<span class="pill warn" style="margin-top:6px">Delayed ${dur(dl * M)}</span>` : ''}
    </div></div>`;
}
let pastSort = 'date';
function pastList(past) {
  const key = { date: f => -depT(f), from: f => f.from?.city || f.from?.iata || '', to: f => f.to?.city || f.to?.iata || '', airline: f => f.airline || airlineOf(f.num) || f.num };
  const sorted = [...past].sort((a, b) => { const x = key[pastSort](a), y = key[pastSort](b); return x < y ? -1 : x > y ? 1 : depT(b) - depT(a); });
  let html = `<div class="chips sort">${[['date', 'Date'], ['from', 'From'], ['to', 'To'], ['airline', 'Airline']].map(([k, l]) => `<button class="chipbtn ${pastSort === k ? 'on' : ''}" data-act="sort" data-k="${k}">${l}${pastSort === k && k === 'date' ? ' ↓' : ''}</button>`).join('')}</div>`;
  if (pastSort === 'date') {
    const groups = {}; sorted.forEach(f => (groups[fmtDate(depT(f), f.from?.tz, { year: 'numeric' })] ||= []).push(f));
    Object.entries(groups).forEach(([y, fl]) => { html += `<div class="yearhd"><b>${y}</b><span>${fl.length} flight${fl.length > 1 ? 's' : ''}</span></div><div class="card list">${fl.map(f => rowItem(f, true)).join('')}</div>`; });
  } else html += `<div class="card list">${sorted.map(f => rowItem(f, true)).join('')}</div>`;
  return html;
}

let statYear = 'all';
function viewStats() {
  const years = [...new Set(live(S.flights).filter(f => depT(f) < Date.now()).map(f => fmtDate(depT(f), f.from?.tz, { year: 'numeric' })))].sort().reverse();
  const s = computeStats(statYear);
  const longHaul = s.fl.filter(f => arrT(f) - depT(f) >= 6 * H).length;
  const delayed = s.fl.filter(f => delayMin(f) >= 5), lost = delayed.reduce((t, f) => t + delayMin(f), 0);
  const days = Math.floor(s.ms / 864e5), hrs = Math.round(s.ms % 864e5 / H);
  const label = statYear === 'all' ? 'All-time' : statYear;
  const list = (arr, empty) => arr.length ? arr.map(([k, v]) => `<div class="list-row"><span>${esc(k)}</span><span class="muted">${v}</span></div>`).join('') : `<div class="muted small">${empty}</div>`;
  let html = `<div class="chips years">${['all', ...years].map(y => `<button class="chipbtn ${statYear === y ? 'on' : ''}" data-year="${y}">${y === 'all' ? 'All-time' : y}</button>`).join('')}</div>`;
  html += `<div class="pcard p1"><div class="ph">${esc(label)} travel record</div>
    <div class="pgrid"><div><span>Flights</span><b>${s.fl.length}</b><em>${longHaul} long haul</em></div><div><span>Distance</span><b>${fmtDist(s.km)}</b><em>${(s.km / 40075).toFixed(1)}× around the world</em></div>
    <div><span>Flight time</span><b>${days ? `${days}d ${hrs}h` : `${hrs}h`}</b></div><div class="two"><div><span>Airports</span><b>${s.airports.size}</b></div><div><span>Airlines</span><b>${new Set(s.fl.map(f => f.airline || airlineOf(f.num) || f.num.slice(0, 2))).size}</b></div></div></div></div>`;
  if (lost > 0) html += `<div class="pcard p2"><b class="hugeN">${lost >= 60 ? Math.round(lost / 60) : lost}</b><div class="pt">${lost >= 60 ? 'hours' : 'minutes'} lost to delays</div><div class="ps">Delayed flights averaged ${dur(lost / delayed.length * M)} late</div></div>`;
  if (s.aircraft[0]) html += `<div class="pcard p3"><div class="pt">Most flown aircraft</div><b class="bigN">${esc(s.aircraft[0][0])}</b><div class="ps">${s.aircraft[0][1]} flight${s.aircraft[0][1] > 1 ? 's' : ''}</div></div>`;
  if (s.longest) html += `<div class="pcard p4"><div class="pt">Longest flight</div><b class="bigN">${esc(s.longest.f.from?.iata)} → ${esc(s.longest.f.to?.iata)}</b><div class="ps">${fmtDist(s.longest.d)} · ${esc(s.longest.f.num)}</div></div>`;
  html += `<h2>Your routes</h2><div class="map big" id="worldMap"></div>
    <h2>Top airlines</h2><div class="card">${list(s.airlines, 'No flights yet')}</div>
    <h2>Top routes</h2><div class="card">${list(s.routes, 'No flights yet')}</div>`;
  return html;
}

function openFlight(id, src = 'flights') {
  const f = S[src].find(x => x.id === id); if (!f) return;
  const ph = phase(f), now = Date.now(), friend = src === 'friends', d = depT(f), a = arrT(f), plus = dayDiff(f), dl = delayMin(f);
  const status = ph.key === 'air' ? `Lands in ${dur(a - now)}` : ph.key === 'landed' ? `Landed ${fmtDate(a, f.to?.tz)}` : ph.key === 'cancel' ? 'Canceled' : `Departs in ${dur(d - now)}`;
  const sub2 = ph.key === 'landed' ? (dl >= 15 ? `Arrived ${dur(dl * M)} late` : 'Completed') : dl >= 15 ? `Delayed ${dur(dl * M)}` : f.status && !/unknown/i.test(f.status) ? esc(f.status) : f.estArr ? 'Arrival time is estimated — tap it to set' : f.updatedLive ? 'On time' : 'Scheduled';
  const km = distKm(f.from, f.to);
  const overnight = plus > 0 || (+localHM(d, f.from?.tz).slice(0, 2) >= 21);
  const gate = (term, g, which) => `<button class="gatechip" data-act="tile" data-field="${which}" data-id="${f.id}" data-src="${src}"><b>${esc(g || '—')}</b><span>${term ? 'Terminal ' + esc(term) : 'Gate'}</span></button>`;
  const tile = (field, label, val, icon) => `<button class="tile" data-act="tile" data-field="${field}" data-id="${f.id}" data-src="${src}"><span class="ti">${icon}</span><b>${label}</b><span class="${val ? '' : 'muted'}">${esc(val || 'Tap to add')}</span></button>`;
  closeSheet();
  const el = document.createElement('div'); el.className = 'fview'; el.id = 'sheet';
  el.innerHTML = `<div class="fmap" id="fmap"></div>
    <div class="dsheet"><div class="grabzone"><div class="grabber"></div>
    <div class="dhead">${badge(f.num.slice(0, 2), true)}<div class="sp"><div class="muted small caps">${esc(f.num)} · ${fmtDate(d, f.from?.tz)}${f.airline ? ' · ' + esc(f.airline) : ''}</div><h3>${cityOf(f.from)} to ${cityOf(f.to)}</h3>${friend ? `<div class="muted small">Shared by ${esc(f.sharedBy || 'a friend')}</div>` : ''}</div><button class="icon-btn" data-act="close" aria-label="Close">✕</button></div></div>
    <div class="dscroll"><div class="statusbox ${ph.cls}"><b>${status}</b><span>${sub2}</span>${ph.key === 'air' && liveProxy() ? `<span class="liveln" id="liveLine">${liveLine(f) || 'Looking for live position…'}</span>` : ''}${ph.key === 'air' ? `<div class="bar"><i style="width:${ph.p * 100}%"></i></div>` : ''}</div>
    <div class="leg"><div class="lh"><i>↗</i> <b>${esc(f.from?.iata)}</b> · ${esc(f.from?.name || f.from?.city || '')}</div>
      <div class="lrow"><div><div class="bigt">${fmtTime(d, f.from?.tz)}</div><div class="muted small">${dl >= 5 ? `<s>${fmtTime(f.depSched, f.from?.tz)}</s> delayed` : 'Scheduled'} · ${fmtDate(d, f.from?.tz)}</div></div>${gate(f.terminalDep, f.gateDep, 'gateDep')}</div></div>
    <div class="legmid">⏱ ${dur(a - d)}${km ? ` · ${fmtDist(km)}` : ''}${overnight ? ' · ☾ Overnight' : ''}</div>
    <div class="leg"><div class="lh"><i>↘</i> <b>${esc(f.to?.iata)}</b> · ${esc(f.to?.name || f.to?.city || '')}</div>
      <div class="lrow"><button class="plain" data-act="tile" data-field="arrTime" data-id="${f.id}" data-src="${src}"><div class="bigt">${fmtTime(a, f.to?.tz)}${plus ? `<sup>${plus > 0 ? '+' : ''}${plus}</sup>` : ''}</div><div class="muted small">${f.estArr ? 'Estimated · tap to set' : 'Scheduled'} · ${fmtDate(a, f.to?.tz)}</div></button>${gate(f.terminalArr, f.gateArr, 'gateArr')}</div></div>
    <div class="tiles">
      ${tile('conf', 'Booking code', f.conf, '🎫')}${tile('seat', 'Seat', f.seat, '💺')}
      ${tile('baggage', 'Baggage belt', f.baggage, '🧳')}${tile('aircraft', 'Aircraft', f.aircraft, '✈︎')}
    </div>
    ${tile('notes', 'Notes', f.notes, '📝').replace('class="tile"', 'class="tile wide"')}
    <div class="actions">
      ${!friend ? `<button class="btn pri sm" data-act="share-one" data-id="${f.id}">Share</button>` : `<button class="btn sm" data-act="copy-friend" data-id="${f.id}">I'm on this flight too</button>`}
      <button class="btn sm" data-act="ics-one" data-id="${f.id}" data-src="${src}">Add to calendar</button>
      ${!friend ? `<button class="btn sm" data-act="edit" data-id="${f.id}">Edit route & times</button>` : ''}
      ${S.settings.apiKey ? `<button class="btn sm" data-act="refresh-one" data-id="${f.id}" data-src="${src}">↻ Refresh</button>` : ''}
      <button class="btn sm danger" data-act="delete" data-id="${f.id}" data-src="${src}">Delete</button>
    </div></div></div>`;
  document.body.appendChild(el); document.body.style.overflow = 'hidden';
  attachDrag(el, vis => { el._vis = vis; const m = el._map; if (m && m._focus) { m.easeTo({ ...routeCam(m, f, 70, vis), duration: 420 }); setTimeout(() => m._focus && placePins(m, f), 440); } });
  setTimeout(() => drawFlightMap(el, f), 30);
  if (liveProxy() && ph.key === 'air') {
    const tick = async () => { if (!el.isConnected) return clearInterval(el._liveTimer);
      if (await fetchLivePos(f)) { save(false); const ln = el.querySelector('#liveLine'); if (ln) ln.textContent = liveLine(f); if (el._map) showRoutes(el._map, [f], f, { keepCamera: true }); } };
    el._liveTimer = setInterval(tick, 30000); setTimeout(tick, 600);
  }
}
function attachDrag(view, onSnap) {
  const sh = view.querySelector('.dsheet'), sc = view.querySelector('.dscroll'), gz = view.querySelector('.grabzone');
  const SH = () => sh.offsetHeight, snaps = () => [0, Math.max(0, SH() - innerHeight * 0.58), SH() - gz.offsetHeight - 8];
  let y = snaps()[1], startY = 0, startT = 0, dragging = false, lastY = 0, lastT = 0, v = 0;
  const apply = () => { sh.style.transform = `translateY(${y}px)`; };
  sh.style.transition = 'none'; apply(); view._vis = SH() - y; requestAnimationFrame(() => { sh.style.transition = ''; });
  const begin = cy => { dragging = true; startY = cy; startT = y; lastY = cy; lastT = performance.now(); v = 0; sh.style.transition = 'none'; };
  const move = cy => { const t = performance.now(); v = (cy - lastY) / Math.max(1, t - lastT); lastY = cy; lastT = t; const max = snaps()[2]; let ny = startT + cy - startY; if (ny < 0) ny = ny / 3; if (ny > max) ny = max + (ny - max) / 3; y = ny; apply(); };
  const settle = target => { y = target; sh.style.transition = ''; apply(); sc.style.overflowY = target === snaps()[2] ? 'hidden' : ''; onSnap(SH() - y); };
  const end = () => {
    dragging = false; const s = snaps();
    let target = v > 0.45 ? (s.find(p => p > y + 4) ?? s[2]) : v < -0.45 ? ([...s].reverse().find(p => p < y - 4) ?? 0) : s.reduce((a, b) => Math.abs(b - y) < Math.abs(a - y) ? b : a);
    settle(target);
  };
  gz.addEventListener('pointerdown', e => { if (e.target.closest('button')) return; begin(e.clientY); try { gz.setPointerCapture(e.pointerId); } catch (x) {} });
  gz.addEventListener('pointermove', e => { if (dragging) move(e.clientY); });
  ['pointerup', 'pointercancel'].forEach(t => gz.addEventListener(t, e => { if (!dragging) return; const moved = Math.abs(e.clientY - startY) > 6; if (moved) end(); else { dragging = false; const s = snaps(); settle(y >= s[2] - 2 ? s[1] : s[2]); } }));
  let ty = null;
  sc.addEventListener('touchstart', e => { ty = e.touches[0].clientY; }, { passive: true });
  sc.addEventListener('touchmove', e => { const cy = e.touches[0].clientY; if (!dragging && sc.scrollTop <= 0 && cy - ty > 6) begin(ty); if (dragging) { e.preventDefault(); move(cy); } }, { passive: false });
  sc.addEventListener('touchend', () => { if (dragging) end(); });
  addEventListener('resize', () => { if (!view.isConnected) return; settle(snaps()[1]); });
}
const TILE_LABELS = { conf: 'Booking code', seat: 'Seat', baggage: 'Baggage belt', aircraft: 'Aircraft', notes: 'Notes', gateDep: 'Departure gate', gateArr: 'Arrival gate', arrTime: 'Arrival time' };
function editTile(id, src, field) {
  const f = S[src].find(x => x.id === id); if (!f) return;
  let body;
  if (field === 'arrTime') body = `<label class="f"><span>Arrival time at ${esc(f.to?.iata)} (local)</span><input id="t_v" type="time" value="${localHM(arrT(f), f.to?.tz)}"></label>`;
  else if (field === 'gateDep' || field === 'gateArr') { const t = field === 'gateDep' ? 'terminalDep' : 'terminalArr'; body = `<div class="row"><label class="f"><span>Terminal</span><input id="t_t" value="${esc(f[t] || '')}" autocapitalize="characters"></label><label class="f"><span>Gate</span><input id="t_v" value="${esc(f[field] || '')}" autocapitalize="characters"></label></div>`; }
  else if (field === 'notes') body = `<textarea id="t_v" rows="4">${esc(f.notes || '')}</textarea>`;
  else body = `<input id="t_v" value="${esc(f[field] || '')}" ${field === 'conf' || field === 'seat' ? 'autocapitalize="characters"' : ''} placeholder="${field === 'seat' ? 'e.g. 23A' : field === 'conf' ? 'e.g. ABC123' : ''}">`;
  sheet(`${sheetHd(TILE_LABELS[field])}${body}<button class="btn pri block" style="margin-top:14px" data-act="tile-save" data-field="${field}" data-id="${id}" data-src="${src}">Save</button>`, el => setTimeout(() => el.querySelector('#t_t,#t_v')?.focus(), 250));
}
function saveTile(id, src, field) {
  const f = S[src].find(x => x.id === id), v = ($('#t_v')?.value || '').trim();
  if (field === 'arrTime') {
    if (v) { let t = zonedToUtc(localDate(depT(f), f.from?.tz), v, f.to?.tz); while (t <= f.depSched) t += 864e5; f.arrSched = t; f.estArr = false; delete f.arrEst; }
  } else {
    f[field] = ['conf', 'seat'].includes(field) ? v.toUpperCase() : v;
    if (field === 'gateDep') f.terminalDep = ($('#t_t')?.value || '').trim();
    if (field === 'gateArr') f.terminalArr = ($('#t_t')?.value || '').trim();
  }
  f.updatedAt = Date.now(); save(); render(); openFlight(id, src);
}

// ---------- Add flight (search first) ----------
const IATA2ICAO = Object.fromEntries(Object.entries(AIRLINE_ICAO).map(([i, a]) => [a, i]));
const tzGuess = lon => { const o = Math.round((lon || 0) / 15); return o === 0 ? 'Etc/GMT' : `Etc/GMT${o > 0 ? '-' : '+'}${Math.abs(o)}`; };
function apFromRoute(a) {
  if (!a) return null; const k = AP[a.iata_code];
  return k ? { ...k } : { iata: a.iata_code || a.icao_code, name: a.name || '', city: a.municipality || '', cc: a.country_iso_name || '', lat: a.latitude, lon: a.longitude, tz: tzGuess(a.longitude) };
}
const routeCache = {};
async function freeRoute(num) {
  if (num in routeCache) return routeCache[num];
  const code = num.slice(0, 2), n = num.slice(2);
  const tries = [...(IATA2ICAO[code] ? [IATA2ICAO[code] + n] : []), num];
  const one = async cs => {
    const ctl = new AbortController(); const to = setTimeout(() => ctl.abort(), 6000);
    try {
      const r = await fetch(`https://api.adsbdb.com/v0/callsign/${encodeURIComponent(cs)}`, { signal: ctl.signal });
      if (!r.ok) return null;
      const fr = (await r.json())?.response?.flightroute;
      return fr?.origin && fr?.destination ? { from: apFromRoute(fr.origin), to: apFromRoute(fr.destination), airline: fr.airline?.name || '' } : null;
    } catch (e) { return null; } finally { clearTimeout(to); }
  };
  const res = await Promise.all(tries.map(one));
  return routeCache[num] = res.find(Boolean) || null;
}
const estDur = (a, b) => { const km = distKm(a, b); return km ? Math.round((km / 820 + .5) * 4) / 4 * H : 2 * H; };
let AF = null, afTimer = null;
function openAdd(pre = {}) {
  const p0 = parseFlight(pre.num || '');
  AF = { date: pre.date || localDate(Date.now(), DEVICE_TZ), pre, state: 'idle', key: '' };
  sheet(`${sheetHd('Add flight')}
    <div class="bigfield"><svg width="22" height="22" viewBox="0 0 24 24" fill="currentColor" style="opacity:.55"><path d="M21 16v-2l-8-5V3.5a1.5 1.5 0 0 0-3 0V9l-8 5v2l8-2.5V19l-2 1.5V22l3.5-1 3.5 1v-1.5L13 19v-5.5z"/></svg>
      <input id="af_num" placeholder="Flight number" autocomplete="off" autocapitalize="characters" spellcheck="false" enterkeyhint="search" value="${esc(p0 && !p0.partial ? p0.num : pre.num || '')}"></div>
    <div class="detect-slot" id="af_chip"></div>
    <div class="chips" id="af_dates"></div>
    <div id="af_body"></div>
    <div class="links"><button class="link" data-act="smart-paste">📋 Paste from email</button><button class="link" data-act="import-ics">📅 From calendar</button></div>
    ${airportOptions()}`, el => { const i = el.querySelector('#af_num'); if (!i.value) setTimeout(() => i.focus(), 300); });
  afDates(); afUpdate();
}
function afDates() {
  const t = localDate(Date.now(), DEVICE_TZ), tm = localDate(Date.now() + 864e5, DEVICE_TZ), other = AF.date !== t && AF.date !== tm;
  const lbl = other ? fmtDate(zonedToUtc(AF.date, '12:00', DEVICE_TZ), DEVICE_TZ, { weekday: 'short', day: 'numeric', month: 'short' }) : 'Other date';
  $('#af_dates').innerHTML = `<button class="chipbtn ${AF.date === t ? 'on' : ''}" data-act="af-date" data-d="${t}">Today</button><button class="chipbtn ${AF.date === tm ? 'on' : ''}" data-act="af-date" data-d="${tm}">Tomorrow</button><label class="chipbtn datechip ${other ? 'on' : ''}">📅 ${lbl}<input type="date" id="af_otherdate" value="${AF.date}"></label>`;
}
function afUpdate() {
  if (!AF || !$('#af_num')) return;
  const p = parseFlight($('#af_num').value); $('#af_chip').innerHTML = detectChip(p);
  if (!p || p.partial) { clearTimeout(afTimer); AF.p = null; AF.state = 'idle'; AF.key = ''; return afBody(); }
  AF.p = p; const key = p.num + '|' + AF.date;
  if (AF.key === key) return;
  clearTimeout(afTimer); AF.key = key; AF.state = 'searching'; afBody();
  afTimer = setTimeout(() => afSearch(key), 450);
}
async function afSearch(key) {
  AF.movedFrom = null; AF.searching = null;
  const p = AF.p; let r = null;
  AF.live = null; AF.dates = null;
  if (S.settings.apiKey) {
    try { const res = await lookupFlight(p.num, AF.date); if (res?.length) r = { ...res[0], full: true, legs: res }; else AF.live = 'noflight'; }
    catch (e) { const c = +(e.message.match(/\((\d+)\)/) || [])[1]; AF.live = c === 401 || c === 403 ? 'rejected' : c === 429 ? 'quota' : 'error'; AF.liveMsg = e.message; }
    if (AF.live === 'noflight') {
      // Jump to the next day this flight actually operates
      AF.searching = `Checking which days ${p.num} flies…`; afBody();
      const asked = AF.date, d = await flightDates(p.num, asked);
      if (!AF || AF.key !== key) return;
      AF.dates = d;
      const next = d?.find(x => x > asked);
      if (next) {
        try { const res = await lookupFlight(p.num, next); if (!AF || AF.key !== key) return;
          if (res?.length) { r = { ...res[0], full: true, legs: res }; AF.movedFrom = asked; AF.date = next; AF.key = p.num + '|' + next; key = AF.key; afDates(); AF.live = 'moved'; } } catch (e) {}
      }
    }
  }
  if (!r && AF.pre?.from && AF.pre?.to && (!AF.pre.num || parseFlight(AF.pre.num)?.num === p.num)) r = { from: getAirport(AF.pre.from), to: getAirport(AF.pre.to) };
  if (!r) { const mine = live(S.flights).filter(f => f.num === p.num && f.from?.iata && f.to?.iata && f.source !== 'route' && f.routeSrc !== 'public').sort((a, b) => depT(b) - depT(a))[0]; if (mine) r = { from: mine.from, to: mine.to, src: 'history' }; }
  if (!r && !(S.settings.apiKey && AF.live === 'noflight')) { const fr = await freeRoute(p.num); if (fr) r = { ...fr, src: 'public' }; }
  if (!AF || AF.key !== key) return;
  AF.route = r; AF.state = r ? 'found' : 'manual'; afBody();
}
function afBody() {
  const b = $('#af_body'); if (!b) return;
  if (AF.state === 'idle') { b.innerHTML = `<p class="muted small hint">Type a flight number like <b>LY8</b>, <b>ELY8</b> or <b>Delta 100</b>. Contrail finds the airline and route for you.</p>`; return; }
  if (AF.state === 'searching') { b.innerHTML = `<div class="card searching"><span class="spin"></span>${esc(AF.searching || `Finding ${AF.p.num}…`)}</div>`; return; }
  const r = AF.route, pre = AF.pre || {};
  if (AF.state === 'manual') {
    b.innerHTML = `<div class="card">${liveNote()}<p class="small muted" style="margin-top:0">${AF.pre?.from ? 'Set the right airports' : `Couldn’t find the route for <b>${esc(AF.p.num)}</b> automatically. Just add the airports`}:</p>
      <div class="row"><label class="f"><span>From</span><input id="af_from" placeholder="Airport code" list="apList" maxlength="4" autocapitalize="characters" value="${esc(pre.from || '')}"></label><label class="f"><span>To</span><input id="af_to" placeholder="Airport code" list="apList" maxlength="4" autocapitalize="characters" value="${esc(pre.to || '')}"></label></div>
      ${afTimes(null, null)}<button class="btn pri block" data-act="af-add">Add flight</button></div>`; return;
  }
  const km = distKm(r.from, r.to);
  const legs = r.legs && r.legs.length > 1 ? `<div class="chips">${r.legs.map((l, i) => `<button class="chipbtn ${l.from.iata === r.from.iata ? 'on' : ''}" data-act="af-leg" data-i="${i}">${esc(l.from.iata)} → ${esc(l.to.iata)}</button>`).join('')}</div>` : '';
  b.innerHTML = `${legs}<div class="card result">
    <div class="fr-top">${badge(AF.p.iata)}<span><b style="color:var(--text)">${esc(AF.p.num)}</b> · ${esc(AF.p.airline || r.airline || '')}</span></div>
    <div class="route"><div class="ap"><div class="code">${esc(r.from.iata)}</div><div class="city">${cityOf(r.from)}</div>${r.full ? `<div class="t">${fmtTime(r.depSched, r.from.tz)}</div>` : ''}</div>
      <div class="mid">${planeSvg(90, 18)}<div>${r.full ? dur(r.arrSched - r.depSched) : km ? '≈ ' + dur(estDur(r.from, r.to)) : ''}</div><div>${km ? fmtDist(km) : ''}</div></div>
      <div class="ap right"><div class="code">${esc(r.to.iata)}</div><div class="city" style="margin-left:auto">${cityOf(r.to)}</div>${r.full ? `<div class="t">${fmtTime(r.arrSched, r.to.tz)}</div>` : ''}</div></div>
    ${AF.live === 'moved' ? liveNote() : ''}${r.full ? `<div class="srcnote ok">✓ Live schedule${r.status ? ' · ' + esc(r.status) : ''}${r.gateDep ? ' · Gate ' + esc(r.gateDep) : ''}${r.terminalDep ? ' · Terminal ' + esc(r.terminalDep) : ''}</div>`
      : r.src === 'history' ? `<div class="srcnote">Route from your previous ${esc(AF.p.num)} flight · <button class="link inl" data-act="af-change">Change</button></div>`
      : `${liveNote()}<div class="srcnote warn">⚠︎ Route from a public database and may be outdated — check it. <button class="link inl" data-act="af-change">Change airports</button>${S.settings.apiKey ? '' : '<br>For exact times, gates and delays, <button class="link inl" data-act="goto-live">turn on live data</button> (free).'}</div>`}
    ${r.full ? '' : afTimes(r.from, r.to)}
    <button class="btn pri block" data-act="af-add" style="margin-top:12px">Add flight</button></div>`;
}
function liveNote() {
  if (!AF.live) return '';
  const d = fmtDate(zonedToUtc(AF.date, '12:00', DEVICE_TZ), DEVICE_TZ);
  const chips = AF.dates?.length ? `<div class="chips" style="padding:8px 0 0">${AF.dates.slice(0, 6).map(x => `<button class="chipbtn" data-act="af-date" data-d="${x}">${fmtDate(zonedToUtc(x, '12:00', DEVICE_TZ), DEVICE_TZ)}</button>`).join('')}</div>` : '';
  const others = (AF.dates || []).filter(x => x !== AF.date);
  if (AF.live === 'moved') return `<div class="srcnote live">${esc(AF.p.num)} doesn’t fly on ${fmtDate(zonedToUtc(AF.movedFrom, '12:00', DEVICE_TZ), DEVICE_TZ)} — showing the next flight.${others.length ? `<div class="chips" style="padding:8px 0 0">${others.slice(0, 6).map(x => `<button class="chipbtn" data-act="af-date" data-d="${x}">${fmtDate(zonedToUtc(x, '12:00', DEVICE_TZ), DEVICE_TZ)}</button>`).join('')}</div>` : ''}</div>`;
  const msg = AF.live === 'noflight' ? `Live data has no <b>${esc(AF.p.num)}</b> on <b>${d}</b>.${AF.dates?.length ? ' It flies on:' : ' Try another date.'}`
    : AF.live === 'rejected' ? 'Your live-data key wasn’t accepted. Make sure you subscribed to AeroDataBox’s free <b>Basic</b> plan on RapidAPI, then <button class="link inl" data-act="goto-live">test the key</button>.'
    : AF.live === 'quota' ? 'You’ve used this month’s free live-data lookups.'
    : `Live data didn’t respond (${esc(AF.liveMsg || 'network error')}).`;
  return `<div class="srcnote live ${AF.live === 'noflight' ? '' : 'bad'}">${msg}${chips}</div>`;
}
async function flightDates(num, date) {
  try {
    const from = date, to = localDate(zonedToUtc(date, '12:00', DEVICE_TZ) + 20 * 864e5, DEVICE_TZ);
    const r = await fetch(`https://aerodatabox.p.rapidapi.com/flights/number/${encodeURIComponent(num)}/dates/${from}/${to}`, { headers: { 'X-RapidAPI-Key': S.settings.apiKey, 'X-RapidAPI-Host': 'aerodatabox.p.rapidapi.com' } });
    if (!r.ok) return null;
    const j = await r.json(); const arr = Array.isArray(j) ? j : j.items || j.dates || [];
    return [...new Set(arr.map(x => String(typeof x === 'string' ? x : x.date || x.dateLocal || x.scheduledDateLocal || '').slice(0, 10)).filter(x => /^\d{4}-\d\d-\d\d$/.test(x) && x !== date))].sort();
  } catch (e) { return null; }
}
function afTimes(from, to) {
  const pre = AF.pre || {};
  return `<div class="row" style="margin-top:12px"><label class="f"><span>Departs${from ? ' ' + esc(from.iata) : ''} (local)</span><input id="af_dep" type="time" value="${esc(pre.dep || '')}"></label>
    <label class="f"><span>Arrives (optional)</span><input id="af_arr" type="time" value="${esc(pre.arr || '')}"></label></div>
    <p class="muted small" style="margin:-4px 4px 0">Leave arrival empty and Contrail estimates it. Seat and booking code go on the next screen.</p>`;
}
function afAdd() {
  const p = AF.p, r = AF.route, pre = AF.pre || {};
  if (!p) return toast('Enter the flight number');
  let f;
  if (r && r.full) { f = { ...r, id: uid(), source: 'api', updatedAt: Date.now() }; delete f.full; delete f.legs; }
  else {
    const from = r ? r.from : getAirport($('#af_from')?.value), to = r ? r.to : getAirport($('#af_to')?.value);
    if (!from || !to) return toast('Add both airports');
    const dep = $('#af_dep')?.value; if (!dep) { $('#af_dep').focus(); return toast('Add the departure time'); }
    const depSched = zonedToUtc(AF.date, dep, from.tz), arr = $('#af_arr')?.value;
    let arrSched; if (arr) { arrSched = zonedToUtc(AF.date, arr, to.tz); while (arrSched <= depSched) arrSched += 864e5; } else arrSched = depSched + estDur(from, to);
    f = { id: uid(), num: p.num, airline: p.airline || r?.airline || '', from, to, depSched, arrSched, estArr: !arr, source: r ? 'route' : 'manual', routeSrc: r?.src || 'manual', updatedAt: Date.now() };
  }
  if (pre.seat) f.seat = pre.seat; if (pre.conf) f.conf = pre.conf;
  S.flights.push(f); save(); AF = null; closeSheet(); tab = 'flights'; sub = arrT(f) > Date.now() - 6 * H ? 'upcoming' : 'past'; render(); openFlight(f.id);
  toast(`Added ${f.num}`);
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
    if (AF && $('#af_num')) { AF.pre = x; if (x.date) AF.date = x.date; if (x.num) $('#af_num').value = x.num; AF.key = ''; afDates(); afUpdate(); }
    else openAdd(x);
    toast(x.num ? `Found ${x.num}${x.from && x.to ? ` · ${x.from} → ${x.to}` : ''}` : 'Found route details');
  };
  if (text && text.length > 3) return apply(text);
  const keep = null;
  sheet(`${sheetHd('Paste flight details')}<p class="muted small" style="margin-top:-6px">Paste a confirmation email, text message or itinerary. Contrail picks out the flight number, airline, airports, date, times, seat and booking code.</p>
    <textarea id="pasteBox" rows="8" placeholder="e.g. Your El Al flight LY 8 from JFK to TLV departs Nov 20 at 6:00 PM…"></textarea>
    <button class="btn pri block" style="margin-top:12px" data-act="paste-go">Find my flight</button>`, el => el.querySelector('#pasteBox').focus());
  window.__pasteApply = t => { closeSheet(); AF = null; apply(t); };
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
async function testKey(btn) {
  const k = ($('#setKey')?.value || '').trim(); if (!k) return toast('Paste your key first');
  S.settings.apiKey = k; save();
  btn.disabled = true; btn.textContent = 'Testing…';
  try { const r = await lookupFlight('LY8', localDate(Date.now() + 864e5, DEVICE_TZ)); toast(r && r.length ? `✓ Works — LY8 ${r[0].from.iata} → ${r[0].to.iata}` : '✓ Key works'); render(); }
  catch (e) { toast(/40[13]/.test(e.message) ? 'Key not accepted — check you subscribed to the Basic plan' : e.message); }
  btn.disabled = false; btn.textContent = 'Test it';
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
  const every = f => (now > depT(f) - 3 * H && now < arrT(f) + 30 * M) ? 15 * M : 6 * H;
  const due = [...live(S.flights), ...live(S.friends)].filter(f => depT(f) - now < 36 * H && arrT(f) > now - 1 * H && (force || !f.updatedLive || now - f.updatedLive > every(f)));
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
  const cfg = parseConfig(fbCfgText()); if (!cfg || !cfg.apiKey) return Promise.resolve(false);
  return fbReady ||= (async () => {
    try {
      const base = 'https://www.gstatic.com/firebasejs/10.12.2/';
      if (!window.firebase) { await loadScript(base + 'firebase-app-compat.js'); await loadScript(base + 'firebase-auth-compat.js'); await loadScript(base + 'firebase-firestore-compat.js'); }
      const app = firebase.apps.length ? firebase.app() : firebase.initializeApp(cfg);
      fb = { auth: app.auth(), db: app.firestore() };
      await new Promise(res => { let first = true; fb.auth.onAuthStateChanged(u => {
        user = u;
        if (u && (!account || account.uid !== u.uid)) startSession({ username: u.displayName || (u.email || 'traveler').split('@')[0], mode: 'cloud', uid: u.uid, google: u.providerData.some(p => p.providerId === 'google.com') });
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
async function signInGoogle() {
  const err = $('#authErr'); if (err) err.textContent = '';
  if (!(await initFirebase())) { if (err) err.textContent = 'Can’t reach the sync server — check your connection'; return; }
  const prov = new firebase.auth.GoogleAuthProvider(); prov.setCustomParameters({ prompt: 'select_account' });
  try { await fb.auth.signInWithPopup(prov); }
  catch (e) {
    if (/popup-blocked|operation-not-supported|web-storage-unsupported/.test(e.code || '')) return fb.auth.signInWithRedirect(prov);
    if (/popup-closed|cancelled-popup/.test(e.code || '')) return;
    const msg = e.code === 'auth/operation-not-allowed' ? 'Google sign-in isn’t enabled yet in Firebase' : e.code === 'auth/unauthorized-domain' ? 'Add this site to Firebase → Authentication → Authorized domains' : fbErr(e);
    if (err) err.textContent = msg; else toast(msg);
  }
}
async function signInPw(username, pw) {
  if (await initFirebase()) {
    try { await fb.auth.signInWithEmailAndPassword(toEmail(username), pw); return; }
    catch (e) {
      const loc = getUsers()[username.toLowerCase()];
      if (loc && /invalid-credential|user-not-found|wrong-password/.test(e.code || '') && await hashPw(pw, loc.salt, loc.iter) === loc.hash) {
        try { const c = await fb.auth.createUserWithEmailAndPassword(toEmail(username), pw); await c.user.updateProfile({ displayName: loc.username }); startSession({ username: loc.username, mode: 'cloud', uid: c.user.uid }); toast('Your account now syncs across devices'); return; }
        catch (e2) { throw new Error(fbErr(e2)); }
      }
      throw new Error(fbErr(e));
    }
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
  if (pendingCfg) { const c = pendingCfg; pendingCfg = null; setTimeout(() => applyCfgLink(c), 300); }
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
  document.body.classList.remove('authed', 'home'); closeSheet();
  const cloud = !!parseConfig(fbCfgText());
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
    ${cloud ? `<div class="or"><span>or</span></div><button class="btn block gbtn" data-act="google"><svg width="18" height="18" viewBox="0 0 48 48"><path fill="#FFC107" d="M43.6 20.5H42V20H24v8h11.3C33.7 32.7 29.2 36 24 36c-6.6 0-12-5.4-12-12s5.4-12 12-12c3.1 0 5.8 1.2 7.9 3.1l5.7-5.7C34 6.1 29.3 4 24 4 12.9 4 4 12.9 4 24s8.9 20 20 20 20-8.9 20-20c0-1.3-.1-2.4-.4-3.5z"/><path fill="#FF3D00" d="m6.3 14.7 6.6 4.8C14.7 15.1 19 12 24 12c3.1 0 5.8 1.2 7.9 3.1l5.7-5.7C34 6.1 29.3 4 24 4 16.3 4 9.7 8.3 6.3 14.7z"/><path fill="#4CAF50" d="M24 44c5.2 0 9.9-2 13.4-5.2l-6.2-5.2C29.2 35.1 26.7 36 24 36c-5.2 0-9.6-3.3-11.3-8l-6.5 5C9.5 39.6 16.2 44 24 44z"/><path fill="#1976D2" d="M43.6 20.5H42V20H24v8h11.3c-.8 2.2-2.2 4.2-4.1 5.6l6.2 5.2C37 39.2 44 34 44 24c0-1.3-.1-2.4-.4-3.5z"/></svg>Continue with Google</button>` : ''}
    <p class="muted small" style="text-align:center;margin:16px 0 0">${cloud ? '☁︎ Sign in on any device — your flights sync.' : 'Your account and flights are stored on this device.'}</p>
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
  return `<p class="muted small" style="margin-top:0">${CFG.fbConfig ? 'Using a custom sync server.' : `Connected to <b>${esc(BUILTIN_FB.projectId)}</b>. Flights sync to every device you sign in on.`} Only change this if you want your own server.</p>
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
    if (account.google) return toast('You sign in with Google — manage your password in your Google account');
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
  const pw = account.google ? '' : prompt('Enter your password to confirm:'); if (pw == null) return;
  try {
    if (account.mode === 'cloud') {
      if (account.google) await user.reauthenticateWithPopup(new firebase.auth.GoogleAuthProvider());
      else await user.reauthenticateWithCredential(firebase.auth.EmailAuthProvider.credential(user.email, pw));
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
    if (doc.exists) { const d = doc.data(); S.flights = mergeList(S.flights, d.flights); S.friends = mergeList(S.friends, d.friends); if (!S.settings.name && d.name) S.settings.name = d.name; if (!S.settings.apiKey && d.apiKey) S.settings.apiKey = d.apiKey; if (!S.settings.liveProxy && d.liveProxy) S.settings.liveProxy = d.liveProxy; if (d.units) S.settings.units = d.units; }
    
    save(false); await push(); render();
  } catch (e) { console.error(e); toast('Sync failed: ' + (e.code || e.message)); }
}
const clean = o => JSON.parse(JSON.stringify(o));
async function push() {
  if (!fb || !user) return;
  try { await fb.db.collection('users').doc(user.uid).set(clean({ flights: S.flights, friends: S.friends, name: S.settings.name || '', apiKey: S.settings.apiKey || '', liveProxy: S.settings.liveProxy || '', units: S.settings.units || 'mi', updatedAt: Date.now() })); }
  catch (e) { console.error(e); }
}
function schedulePush() { if (!user) return; clearTimeout(pushTimer); pushTimer = setTimeout(push, 1200); }

// ---------- Events ----------
document.addEventListener('click', async e => {
  const t = e.target.closest('[data-tab],[data-sub],[data-year],[data-act],[data-open],[data-auth],[data-hero]'); if (!t) return;
  if (t.dataset.auth) { authMode = t.dataset.auth; renderAuth(); return; }
  if (t.dataset.tab) { tab = t.dataset.tab; render(); scrollTo(0, 0); return; }
  if (t.dataset.sub) { sub = t.dataset.sub; render(); return; }
  if (t.dataset.year) { statYear = t.dataset.year; render(); return; }
  if (t.dataset.open && t.dataset.open !== '' && !t.closest('.sheet')) { openFlight(t.dataset.open, t.dataset.src); return; }
  const id = t.dataset.id, src = t.dataset.src || 'flights';
  switch (t.dataset.act) {
    case 'close': closeSheet(); break;
    case 'add': openAdd(); break;
    case 'af-date': AF.date = t.dataset.d; AF.key = ''; afDates(); afUpdate(); break;
    case 'af-add': afAdd(); break;
    case 'af-change': AF.pre = { ...(AF.pre || {}), from: AF.route?.from?.iata, to: AF.route?.to?.iata, num: '' }; AF.route = null; AF.state = 'manual'; afBody(); break;
    case 'goto-live': closeSheet(); tab = 'settings'; render(); setTimeout(() => $('#liveCard')?.scrollIntoView({ behavior: 'smooth', block: 'center' }), 50); break;
    case 'test-key': testKey(t); break;
    case 'af-leg': { const l = AF.route.legs[+t.dataset.i]; AF.route = { ...l, full: true, legs: AF.route.legs }; afBody(); break; }
    case 'sort': pastSort = t.dataset.k; render(); break;
    case 'tile': editTile(id, src, t.dataset.field); break;
    case 'tile-save': saveTile(id, src, t.dataset.field); break;
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
    case 'google': signInGoogle(); break;
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
  if (e.target.id === 'setLive') { st.liveProxy = e.target.value.trim(); save(); toast(st.liveProxy ? 'Live position server saved' : 'Live position off'); }
  if (e.target.id === 'setUnits') { st.units = e.target.value; save(false); }
  if (e.target.id === 'setKey') { st.apiKey = e.target.value.trim(); save(); toast(st.apiKey ? 'Key saved — tap Test it' : 'Live data off'); }
  if (e.target.id === 'e_from' || e.target.id === 'e_to') { e.target.value = e.target.value.toUpperCase(); if (e.target.id === 'e_from' && window.__lookup) scheduleAutoLookup(); }
  if (e.target.id === 'e_date') scheduleAutoLookup();
  if (e.target.id === 'af_otherdate' && e.target.value) { AF.date = e.target.value; afDates(); afUpdate(); }
});
$('#icsFile').addEventListener('change', async e => { const f = e.target.files[0]; if (f) importIcsText(await f.text()); e.target.value = ''; });
$('#backupFile').addEventListener('change', async e => {
  const file = e.target.files[0]; if (!file) return;
  try { const d = JSON.parse(await file.text()); S.flights = mergeList(S.flights, d.flights); S.friends = mergeList(S.friends, d.friends); save(); render(); toast('Restored'); }
  catch (err) { toast('Not a valid backup'); } e.target.value = '';
});
$('#hdrAction').addEventListener('click', () => openAdd());

document.addEventListener('input', e => {
  const id = e.target.id;
  if (id === 'quickNum') {
    const v = e.target.value;
    if (v.length > 24 || /\n/.test(v)) { e.target.value = ''; $('#quickChip').innerHTML = ''; const x = extractFromText(v); if (x.num || x.from) { openEditor(null, x); toast(`Found ${x.num || ''} ${x.from && x.to ? x.from + ' → ' + x.to : ''}`); } return; }
    $('#quickChip').innerHTML = detectChip(parseFlight(v));
  }
  if (id === 'af_num') afUpdate();
  if (id === 'e_num') { $('#editChip').innerHTML = detectChip(parseFlight(e.target.value)); scheduleAutoLookup(); }
});
document.addEventListener('keydown', e => {
  if (e.target.id === 'af_num' && e.key === 'Enter') { e.preventDefault(); e.target.blur(); }
  if (e.target.id === 'quickNum' && e.key === 'Enter') {
    const p = parseFlight(e.target.value); if (!p) return toast('Type a flight number like LY8');
    openEditor(null, { num: p.partial ? p.iata : p.num });
  }
});

// ---------- Boot ----------
let pendingCfg = null;
function applyCfgLink(c) {
  if (c.key) S.settings.apiKey = c.key;
  if (c.live) S.settings.liveProxy = c.live;
  save(); render(); toast(c.key ? '✓ Live flight data is on' : '✓ Live plane position is on');
  if (c.key) refreshAll(true);
}
function handleHash() {
  const k = location.hash.match(/^#(key|live)=(.+)$/);
  if (k) { history.replaceState(null, '', location.pathname + location.search); const c = { [k[1]]: decodeURIComponent(k[2]).trim() }; account ? applyCfgLink(c) : (pendingCfg = c, toast('Sign in to finish setup')); return; }
  const m = location.hash.match(/^#share=([\w-]+)/); if (m) { history.replaceState(null, '', location.pathname + location.search); account ? receiveShare(m[1]) : (pendingShare = m[1], toast('Sign in to see the shared flight')); } }
window.addEventListener('hashchange', handleHash);
(async () => {
  const sess = localStorage.getItem(SESSION_KEY), local = sess && getUsers()[sess];
  if (local && !parseConfig(fbCfgText())) startSession({ username: local.username, mode: 'local' });
  else if (parseConfig(fbCfgText())) {
    $('#main').innerHTML = '<div class="auth"><p class="muted">Loading…</p></div>';
    const ok = await initFirebase();
    if (!account) { if (!ok && local) startSession({ username: local.username, mode: 'local' }); else renderAuth(); }
  }
  else renderAuth();
  handleHash();
})();
setInterval(() => { if (account && !$('#sheet') && tab !== 'stats' && tab !== 'settings' && document.activeElement?.id !== 'quickNum') render(); }, 30e3);
setInterval(() => refreshAll(), 10 * M);
document.addEventListener('visibilitychange', () => { if (!document.hidden && account) { if (document.activeElement?.id !== 'quickNum') render(); refreshAll(); } });
if ('serviceWorker' in navigator && location.protocol === 'https:') navigator.serviceWorker.register('sw.js', { updateViaCache: 'none' }).then(r => r.update()).catch(() => {});
window.__contrail = { S, parseIcs, detectFlight, importIcsText, zonedToUtc, shareUrl, receiveShare };
})();
