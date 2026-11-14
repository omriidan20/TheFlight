// Contrail flight alerts — runs on a schedule in GitHub Actions.
// Reads encrypted alert subscriptions from Firestore (push/{uid}), checks each upcoming
// flight at a few key moments, and sends Web Push notifications to the person's devices.
import fs from 'node:fs';
const { subtle } = globalThis.crypto;

export const PROJECT = 'theflight-fb02e';
export const API_KEY = 'AIzaSyADdMj7l07qZaNNRkd-XnGY6BDpywmBCdI';
export const VAPID_PUB = 'BOCaKFeb0udfN8yuh6kHG8wSh8u1_KJykdCZ-cuydHr68ql-_kWhP7RRFNvPNw3famzfGFM2GzjhkWPkHRvGiIw';
const M = 6e4, H = 36e5;
const b64 = s => Buffer.from(s, 'base64url');

// ---------- decryption (ECDH P-256 + HKDF-SHA256 + AES-GCM) ----------
export async function decrypt(doc, d) {
  const pub = b64(VAPID_PUB);
  const priv = await subtle.importKey('jwk', { kty: 'EC', crv: 'P-256', d, x: pub.subarray(1, 33).toString('base64url'), y: pub.subarray(33).toString('base64url') }, { name: 'ECDH', namedCurve: 'P-256' }, false, ['deriveBits']);
  const epk = await subtle.importKey('raw', b64(doc.epk), { name: 'ECDH', namedCurve: 'P-256' }, false, []);
  const bits = await subtle.deriveBits({ name: 'ECDH', public: epk }, priv, 256);
  const hk = await subtle.importKey('raw', bits, 'HKDF', false, ['deriveKey']);
  const key = await subtle.deriveKey({ name: 'HKDF', hash: 'SHA-256', salt: new Uint8Array(0), info: new TextEncoder().encode('contrail-push-v1') }, hk, { name: 'AES-GCM', length: 256 }, false, ['decrypt']);
  const pt = await subtle.decrypt({ name: 'AES-GCM', iv: b64(doc.iv) }, key, b64(doc.ct));
  return JSON.parse(new TextDecoder().decode(pt));
}

// ---------- data sources ----------
async function listDocs() {
  const out = []; let page = '';
  do {
    const r = await fetch(`https://firestore.googleapis.com/v1/projects/${PROJECT}/databases/(default)/documents/push?key=${API_KEY}&pageSize=300${page ? '&pageToken=' + page : ''}`);
    if (!r.ok) throw new Error('Firestore ' + r.status + ' ' + (await r.text()).slice(0, 200));
    const j = await r.json();
    (j.documents || []).forEach(d => { const f = d.fields || {}; const v = k => f[k]?.stringValue; out.push({ uid: d.name.split('/').pop(), epk: v('epk'), iv: v('iv'), ct: v('ct') }); });
    page = j.nextPageToken || '';
  } while (page);
  return out;
}
const adbTime = t => { const s = t?.utc; if (!s) return null; const v = Date.parse(s.replace(' ', 'T').replace(/Z?$/, 'Z')); return isNaN(v) ? null : v; };
export function parseAdb(list, f) {
  const legs = (Array.isArray(list) ? list : [list]).map(x => {
    const dep = x.departure || {}, arr = x.arrival || {};
    const depAct = adbTime(dep.runwayTime) || adbTime(dep.actualTime), arrAct = adbTime(arr.runwayTime) || adbTime(arr.actualTime);
    return { from: dep.airport?.iata, to: arr.airport?.iata, toName: arr.airport?.municipalityName || arr.airport?.iata, status: x.status || '',
      depSched: adbTime(dep.scheduledTime), depEst: depAct || adbTime(dep.revisedTime) || adbTime(dep.predictedTime), arrEst: arrAct || adbTime(arr.revisedTime) || adbTime(arr.predictedTime),
      depActual: !!depAct, arrActual: !!arrAct, gate: dep.gate || '', terminal: dep.terminal || '', baggage: arr.baggageBelt || '', gateArr: arr.gate || '', reg: x.aircraft?.reg || '' };
  });
  const m = legs.find(l => l.from === f.from.iata && l.to === f.to.iata) || legs.find(l => l.from === f.from.iata) || legs[0];
  if (!m) return null;
  const side = legs.find(l => l !== m && l.from === f.from.iata && l.to !== f.to.iata);
  m.diverted = /divert/i.test(m.status) || (m.to !== f.to.iata) || !!(side && /divert|arrived|landed/i.test(side.status) && !m.arrActual);
  if (m.diverted) m.divertedTo = m.to !== f.to.iata ? m.to : side?.to;
  return m;
}
const localDate = (ts, tz) => new Intl.DateTimeFormat('en-CA', { timeZone: tz || 'UTC', year: 'numeric', month: '2-digit', day: '2-digit' }).format(ts);
async function fetchAdb(f, key) {
  const r = await fetch(`https://aerodatabox.p.rapidapi.com/flights/number/${encodeURIComponent(f.num)}/${localDate(f.depSched, f.from.tz)}?withAircraftImage=false&withLocation=false`,
    { headers: { 'X-RapidAPI-Key': key, 'X-RapidAPI-Host': 'aerodatabox.p.rapidapi.com' } });
  if (r.status === 204 || r.status === 404) return null;
  if (!r.ok) throw new Error('AeroDataBox ' + r.status);
  return parseAdb(await r.json(), f);
}
async function fetchAdsb(f) {
  const urls = [];
  if (f.reg) urls.push(`https://api.adsb.lol/v2/reg/${encodeURIComponent(f.reg)}`);
  if (f.cs) urls.push(`https://api.adsb.lol/v2/callsign/${encodeURIComponent(f.cs)}`, `https://api.airplanes.live/v2/callsign/${encodeURIComponent(f.cs)}`);
  for (const u of urls) {
    try {
      const r = await fetch(u, { headers: { 'User-Agent': 'contrail-alerts' } }); if (!r.ok) continue;
      const j = await r.json(); const a = (j.ac || j.aircraft || [])[0];
      if (a && a.lat != null) return { lat: a.lat, lon: a.lon, ground: a.alt_baro === 'ground', alt: typeof a.alt_baro === 'number' ? a.alt_baro : null, gs: a.gs || 0 };
    } catch (e) {}
  }
  return null;
}

// ---------- helpers ----------
const fmtTime = (ts, tz) => new Intl.DateTimeFormat('en-US', { hour: 'numeric', minute: '2-digit', timeZone: tz || 'UTC' }).format(ts);
const dur = ms => { const m = Math.max(0, Math.round(ms / M)), h = Math.floor(m / 60); return h ? `${h}h ${String(m % 60).padStart(2, '0')}m` : `${m}m`; };
function distKm(a, b) {
  if (a?.lat == null || b?.lat == null) return 0;
  const r = x => x * Math.PI / 180, dLat = r(b.lat - a.lat), dLon = r(b.lon - a.lon);
  const h = Math.sin(dLat / 2) ** 2 + Math.cos(r(a.lat)) * Math.cos(r(b.lat)) * Math.sin(dLon / 2) ** 2;
  return 12742 * Math.asin(Math.sqrt(h));
}
// moments when we ask AeroDataBox (each check costs API units, so only a handful per flight)
export const STAGES = [['d24', -24 * H, 'dep'], ['d3', -3 * H, 'dep'], ['d75', -75 * M, 'dep'], ['d25', -25 * M, 'dep'], ['d+25', 25 * M, 'dep'], ['a30', -30 * M, 'arr'], ['a+20', 20 * M, 'arr']];

// ---------- core ----------
export async function run({ subs, state, now = Date.now(), adb, adsb, send, log = () => {} }) {
  const adbCache = new Map();
  const getAdb = async f => { const k = f.num + '|' + f.depSched; if (!adbCache.has(k)) adbCache.set(k, adb(f).catch(e => { log('adb', f.num, e.message); return undefined; })); return adbCache.get(k); };
  const seen = new Set();
  for (const s of subs) {
    const p = s.data; if (!p?.sub?.endpoint) continue;
    const prefs = { live: true, friends: true, ...(p.prefs || {}) };
    for (const f of p.flights || []) {
      if (f.friend && !prefs.friends) continue;
      const key = s.uid + ':' + f.id; seen.add(key);
      const st = state[key] ||= { done: {} };
      const dep = st.depEst || f.depEst || f.depSched, arr = st.arrEst || f.arrEst || f.arrSched;
      if (now < dep - 25 * H || now > arr + 3 * H || st.final) continue;
      const who = f.friend ? `${f.friend}’s flight ` : '';
      const out = [];
      const note = (title, body, tag = f.id) => out.push({ title, body, tag, url: `./#open=${encodeURIComponent(f.id)}` });

      // 1) scheduled AeroDataBox checks
      const due = STAGES.filter(([k, off, base]) => !st.done[k] && now >= (base === 'dep' ? dep : arr) + off);
      const needAirCheck = due.some(([k]) => k === 'd+25') && !st.airborne;
      if (due.length && (due.some(([k]) => k !== 'd+25') || needAirCheck)) {
        due.forEach(([k]) => st.done[k] = 1);
        const m = await getAdb(f);
        if (m) {
          const delay = m.depEst && m.depSched ? Math.round((m.depEst - m.depSched) / M) : 0;
          if (/cancel/i.test(m.status) && !st.canceled) { st.canceled = st.final = true; note(`${who}${f.num} is canceled`, `${f.from.iata} → ${f.to.iata} on ${localDate(f.depSched, f.from.tz)} was canceled.`); }
          else if (m.diverted && !st.diverted) { st.diverted = true; note(`${who}${f.num} diverted`, `Diverted${m.divertedTo ? ' to ' + m.divertedTo : ''} instead of ${f.to.iata}.`); }
          else {
            if (!m.depActual) {
              const prev = st.delay ?? Math.round(((f.depEst || f.depSched) - f.depSched) / M);
              if (Math.abs(delay - prev) >= 10) { if (m.gate) st.gate = m.gate; note(delay >= 5 ? `${who}${f.num} delayed ${dur(delay * M)}` : `${who}${f.num} is back on time`, `Now departs ${f.from.iata} at ${fmtTime(m.depEst || f.depSched, f.from.tz)}${m.gate ? ' · gate ' + m.gate : ''}`); }
              st.delay = delay;
            }
            if (m.gate && m.gate !== (st.gate ?? f.gate ?? '') && now > dep - 6 * H && !m.depActual) note(`${who}${f.num}: gate ${m.gate}`, `${st.gate || f.gate ? 'Gate changed from ' + (st.gate || f.gate) + '. ' : ''}${m.terminal ? 'Terminal ' + m.terminal + ' · ' : ''}departs ${fmtTime(m.depEst || f.depSched, f.from.tz)}`);
            if (m.gate) st.gate = m.gate;
            if (m.depActual && !st.airborne) { st.airborne = true; note(`${who}${f.num} took off`, `${f.from.iata} → ${f.to.iata} · lands around ${fmtTime(m.arrEst || arr, f.to.tz)}`, 'live-' + f.id); st.lastLive = now; }
            if (m.arrActual && !st.landed) { st.landed = st.final = true; note(`${who}${f.num} landed in ${m.toName || f.to.iata}`, [m.gateArr && 'Gate ' + m.gateArr, m.baggage && 'Bags at belt ' + m.baggage].filter(Boolean).join(' · ') || `Arrived ${fmtTime(m.arrEst || arr, f.to.tz)}`, 'live-' + f.id); }
          }
          if (m.depEst) st.depEst = m.depEst; if (m.arrEst) st.arrEst = m.arrEst; if (m.reg) st.reg = m.reg;
        }
      }

      // 2) live position while it should be flying (free community ADS-B, no API units)
      const d2 = st.depEst || dep, a2 = st.arrEst || arr;
      if (!st.final && now >= d2 - 10 * M && now <= a2 + 60 * M) {
        const pos = await adsb({ ...f, reg: st.reg || f.reg });
        if (pos) {
          const left = distKm(pos, f.to), airborne = !pos.ground && (pos.alt ?? 0) > 500 && pos.gs > 80;
          if (airborne && !st.airborne) { st.airborne = true; st.lastLive = now; note(`${who}${f.num} took off`, `${f.from.iata} → ${f.to.iata} · lands around ${fmtTime(a2, f.to.tz)}`, 'live-' + f.id); }
          else if (st.airborne && (pos.ground || ((pos.alt ?? 99999) < 300 && left < 15))) {
            if (!st.landed) { st.landed = true; note(`${who}${f.num} landed`, left < 40 ? `Welcome to ${f.to.city || f.to.iata}` : `On the ground ${Math.round(left)} km from ${f.to.iata}`, 'live-' + f.id); }
          } else if (st.airborne && airborne && prefs.live && now - (st.lastLive || 0) >= 55 * M && left > 150) {
            st.lastLive = now;
            const eta = now + left / (pos.gs * 1.852) * H;
            note(`${who}${f.num} · ${dur(eta - now)} to ${f.to.iata}`, `${Math.round(left * 0.621).toLocaleString('en-US')} mi to go · ${pos.alt ? (Math.round(pos.alt / 100) * 100).toLocaleString('en-US') + ' ft' : 'cruising'} · lands ~${fmtTime(eta, f.to.tz)}`, 'live-' + f.id);
          }
        }
      }
      for (const n of out) { log('send', s.uid, n.title); const ok = await send(p.sub, n); if (ok === 'gone') break; }
    }
  }
  for (const k of Object.keys(state)) if (!seen.has(k)) delete state[k];
  return state;
}

// ---------- entry point ----------
if (import.meta.url === `file://${process.argv[1]}`) {
  const [d, adbKey] = (process.env.CONTRAIL_PUSH || '').trim().split(':');
  if (!d) { console.log('CONTRAIL_PUSH secret is not set — nothing to do.'); process.exit(0); }
  const webpush = (await import('web-push')).default;
  webpush.setVapidDetails('https://omriidan20.github.io/TheFlight/', VAPID_PUB, d);
  const statePath = process.env.STATE_FILE || 'state.json';
  let state = {}; try { state = JSON.parse(fs.readFileSync(statePath, 'utf8')); } catch (e) {}
  const docs = await listDocs(), subs = [];
  for (const doc of docs) { try { subs.push({ uid: doc.uid, data: await decrypt(doc, d) }); } catch (e) { console.log('skip', doc.uid, e.message); } }
  console.log(`${subs.length} subscriber(s)`);
  await run({ subs, state, adb: f => adbKey ? fetchAdb(f, adbKey) : Promise.resolve(null), adsb: fetchAdsb, log: (...a) => console.log(...a),
    send: async (sub, n) => { try { await webpush.sendNotification(sub, JSON.stringify(n), { TTL: 6 * 3600, urgency: 'high' }); return true; } catch (e) { console.log('push failed', e.statusCode, e.body); return e.statusCode === 404 || e.statusCode === 410 ? 'gone' : false; } } });
  fs.writeFileSync(statePath, JSON.stringify(state));
}
