import { createServer } from 'node:http';
import { londonParts, hhmm, dayLabel } from './time.js';

const esc = (s) => String(s ?? '').replace(/[&<>"']/g, (c) => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' }[c]));

// Tiny web server: /healthz for the host, /today?k=SECRET for the timeline + map page.
export function startWeb({ engine, port, log = console }) {
  const server = createServer((req, res) => {
    const url = new URL(req.url, 'http://x');
    if (url.pathname === '/healthz' || url.pathname === '/') {
      res.writeHead(200, { 'content-type': 'text/plain' });
      return res.end('ok');
    }
    if (url.pathname === '/today') {
      if (url.searchParams.get('k') !== engine.s.webKey) {
        res.writeHead(403, { 'content-type': 'text/plain' });
        return res.end('Forbidden: open this page from the bot (/map).');
      }
      const date = url.searchParams.get('date') || londonParts(engine.now()).date;
      res.writeHead(200, { 'content-type': 'text/html; charset=utf-8' });
      return res.end(renderToday(engine, date));
    }
    res.writeHead(404);
    res.end();
  });
  server.listen(port, () => log.info?.(`web server on :${port}`));
  return server;
}

export function renderToday(engine, date) {
  const { data } = engine;
  const day = data.days[date] || {};
  const now = engine.now();
  const plans = engine.plansOn(date);
  const suggested = engine.tr.suggested.map((id) => engine.placeById(id)).filter(Boolean);
  const loc = engine.tr.location;
  const markers = [
    { lat: data.trip.home.lat, lng: data.trip.home.lng, label: 'Airbnb', kind: 'home' },
    ...plans.map((p) => ({ lat: p.location.lat, lng: p.location.lng, label: `${hhmm(p.start)} ${p.title}`, kind: p.fixed ? 'fixed' : 'soft' })),
    ...Object.keys(engine.s.personalPlans).flatMap((uid) => engine.personalPlansOf(uid)
      .filter((p) => p.location && londonParts(p.start).date === date)
      .map((p) => ({ lat: p.location.lat, lng: p.location.lng, label: `👤 ${engine.personName(uid)}: ${hhmm(p.start)} ${p.title}`, kind: 'soft' }))),
    ...suggested.map((p) => ({ lat: p.lat, lng: p.lng, label: p.name, kind: 'idea' })),
    ...engine.allPlaces().filter((p) => p.wishlist).map((p) => ({ lat: p.lat, lng: p.lng, label: `⭐ ${p.name}`, kind: 'wish' })),
    ...(loc ? [{ lat: loc.lat, lng: loc.lng, label: `You (${hhmm(new Date(loc.at))})`, kind: 'me' }] : []),
  ];
  const tabs = Object.keys(data.days).map((d) => `<a class="tab${d === date ? ' on' : ''}" href="?k=${esc(engine.s.webKey)}&date=${d}">${esc(dayLabel(d))}</a>`).join('');
  const items = plans.map((p) => {
    const past = p.end < now;
    const cur = p.start <= now && now < p.end;
    return `<li class="${past ? 'past' : ''}${cur ? ' now' : ''}"><span class="t">${hhmm(p.start)}</span><div><b>${esc(p.title)}</b>${p.fixed ? '' : ' <em>flexible</em>'}<br><small>${esc(p.location?.name)} · ${esc(p.location?.address || '')}</small>${p.details?.booking ? `<br><small>${esc(p.details.booking)}</small>` : ''}${p.details?.confirmation ? `<br><small>Conf ${esc(p.details.confirmation)}</small>` : ''}</div></li>`;
  }).join('') || '<li><div>No fixed plans today.</div></li>';

  return `<!doctype html><html lang="en"><head><meta charset="utf-8"><meta name="viewport" content="width=device-width,initial-scale=1">
<title>London Trip · ${esc(dayLabel(date))}</title>
<link rel="stylesheet" href="https://cdn.jsdelivr.net/npm/leaflet@1.9.4/dist/leaflet.css">
<style>
:root{--bg:#f7f5f0;--fg:#1b1b1b;--muted:#6b6b6b;--card:#fff;--line:#e3dfd6;--accent:#c8102e}
@media (prefers-color-scheme:dark){:root{--bg:#141414;--fg:#eee;--muted:#a0a0a0;--card:#1f1f1f;--line:#333;--accent:#ff4d5e}}
*{box-sizing:border-box}body{margin:0;font:15px/1.45 -apple-system,system-ui,sans-serif;background:var(--bg);color:var(--fg)}
header{padding:16px 16px 8px}h1{font-size:20px;margin:0 0 4px}p.flow{color:var(--muted);margin:4px 0 0}
.tabs{display:flex;gap:6px;overflow-x:auto;padding:8px 16px}.tab{padding:6px 10px;border:1px solid var(--line);border-radius:999px;color:var(--fg);text-decoration:none;white-space:nowrap;font-size:13px}.tab.on{background:var(--accent);border-color:var(--accent);color:#fff}
#map{height:45vh;margin:8px 16px;border-radius:12px;border:1px solid var(--line)}
ul{list-style:none;margin:0;padding:0 16px 24px}li{display:flex;gap:12px;background:var(--card);border:1px solid var(--line);border-radius:12px;padding:12px;margin:8px 0}
li.past{opacity:.5}.legend{margin:0 16px;color:var(--muted);font-size:12px}.legend i{display:inline-block;width:9px;height:9px;border-radius:50%;margin:0 4px 0 8px}li.now{border-color:var(--accent)}.t{font-weight:700;min-width:48px}small{color:var(--muted)}em{color:var(--accent);font-style:normal;font-size:12px}
</style></head><body>
<header><h1>${esc(dayLabel(date))}${day.label ? ` · ${esc(day.label.split(': ')[1] || day.label)}` : ''}</h1><p class="flow">${esc(day.flow || '')}</p></header>
<nav class="tabs">${tabs}</nav>
<div id="map"></div>
<p class="legend"><i style="background:#c8102e"></i>fixed plan <i style="background:#d69e2e"></i>flexible <i style="background:#38a169"></i>suggested <i style="background:#dd6b20"></i>wishlist <i style="background:#805ad5"></i>you <i style="background:#2b6cb0"></i>Airbnb</p>
<ul>${items}</ul>
<script src="https://cdn.jsdelivr.net/npm/leaflet@1.9.4/dist/leaflet.js"></script>
<script>
const markers=${JSON.stringify(markers).replace(/</g, '\\u003c')};
const colors={home:'#2b6cb0',fixed:'#c8102e',soft:'#d69e2e',idea:'#38a169',me:'#805ad5',wish:'#dd6b20'};
const map=L.map('map');
L.tileLayer('https://{s}.tile.openstreetmap.org/{z}/{x}/{y}.png',{maxZoom:19,attribution:'© OpenStreetMap'}).addTo(map);
const pts=[];for(const m of markers){pts.push([m.lat,m.lng]);L.circleMarker([m.lat,m.lng],{radius:m.kind==='me'?9:7,color:colors[m.kind],fillOpacity:.85}).addTo(map).bindPopup(m.label.replace(/[<>&]/g,''));}
const bb=${JSON.stringify(data.trip.region.bbox)};
const inside=pts.filter(p=>p[1]>=bb[0]&&p[1]<=bb[2]&&p[0]>=bb[1]&&p[0]<=bb[3]);
map.fitBounds(inside.length?inside:pts,{padding:[24,24],maxZoom:15});
</script></body></html>`;
}
