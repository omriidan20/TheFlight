// Contrail server (Cloudflare Worker, free plan). Paste this whole file into a Worker and deploy.
//  • /cal/<token>.ics  — your live "Contrail Flights" calendar feed for iPhone / Google Calendar
//  • /track?callsign=…&lat=…&lon=…  — live plane position from the OpenSky Network
// Optional secrets for OpenSky (Settings → Variables and Secrets): OPENSKY_CLIENT_ID, OPENSKY_CLIENT_SECRET
const ALLOWED = ['https://omriidan20.github.io'];
const PROJECT = 'theflight-fb02e', API_KEY = 'AIzaSyADdMj7l07qZaNNRkd-XnGY6BDpywmBCdI';
let token = null, tokenExp = 0;

async function getToken(env) {
  if (!env.OPENSKY_CLIENT_ID || !env.OPENSKY_CLIENT_SECRET) return null;
  if (token && Date.now() < tokenExp) return token;
  const r = await fetch('https://auth.opensky-network.org/auth/realms/opensky-network/protocol/openid-connect/token', {
    method: 'POST', headers: { 'Content-Type': 'application/x-www-form-urlencoded' },
    body: new URLSearchParams({ grant_type: 'client_credentials', client_id: env.OPENSKY_CLIENT_ID, client_secret: env.OPENSKY_CLIENT_SECRET })
  });
  if (!r.ok) return null;
  const j = await r.json();
  token = j.access_token; tokenExp = Date.now() + ((j.expires_in || 1800) - 60) * 1000;
  return token;
}

async function calendar(tok) {
  if (!/^[A-Za-z0-9_-]{20,64}$/.test(tok)) return new Response('Not found', { status: 404 });
  const r = await fetch(`https://firestore.googleapis.com/v1/projects/${PROJECT}/databases/(default)/documents/cal/${tok}?key=${API_KEY}`, { cf: { cacheTtl: 0 } });
  if (r.status === 404 || r.status === 403) return new Response('This calendar link was turned off in Contrail.', { status: 404 });
  if (!r.ok) return new Response('Calendar temporarily unavailable', { status: 503, headers: { 'Retry-After': '300' } });
  const ics = (await r.json()).fields?.ics?.stringValue || '';
  return new Response(ics, { headers: { 'Content-Type': 'text/calendar; charset=utf-8', 'Content-Disposition': 'inline; filename="contrail-flights.ics"', 'Cache-Control': 'public, max-age=300' } });
}

export default {
  async fetch(req, env) {
    const u = new URL(req.url);
    const cal = u.pathname.match(/^\/cal\/([A-Za-z0-9_-]+)(?:\.ics)?$/);
    if (cal) return calendar(cal[1]);
    const origin = req.headers.get('Origin') || '';
    const cors = { 'Access-Control-Allow-Origin': ALLOWED.includes(origin) ? origin : ALLOWED[0], 'Vary': 'Origin', 'Content-Type': 'application/json', 'Cache-Control': 'no-store' };
    const json = (o, status = 200) => new Response(JSON.stringify(o), { status, headers: cors });
    if (req.method === 'OPTIONS') return new Response(null, { headers: { ...cors, 'Access-Control-Allow-Methods': 'GET' } });
    if (u.pathname !== '/track') return json({ ok: true, service: 'contrail-server', calendar: true });
    const cs = (u.searchParams.get('callsign') || '').toUpperCase().replace(/[^A-Z0-9]/g, '');
    const lat = parseFloat(u.searchParams.get('lat')), lon = parseFloat(u.searchParams.get('lon'));
    if (!cs || !isFinite(lat) || !isFinite(lon)) return json({ error: 'bad request' }, 400);
    const t = await getToken(env); const headers = t ? { Authorization: 'Bearer ' + t } : {};
    for (const d of [2.4, 6, 12]) {
      const q = new URLSearchParams({ lamin: Math.max(-90, lat - d), lamax: Math.min(90, lat + d), lomin: Math.max(-180, lon - d), lomax: Math.min(180, lon + d) });
      const r = await fetch('https://opensky-network.org/api/states/all?' + q, { headers });
      if (r.status === 429) return json({ error: 'rate limited' }, 429);
      if (!r.ok) continue;
      const j = await r.json();
      const s = (j.states || []).find(x => (x[1] || '').trim().toUpperCase() === cs);
      if (s && s[6] != null) return json({ found: true, lat: s[6], lon: s[5], alt: s[7], ground: s[8], speed: s[9], track: s[10], time: j.time });
    }
    return json({ found: false });
  }
};
