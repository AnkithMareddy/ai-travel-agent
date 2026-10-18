/* Reel Studio front end. No build step: plain JS, hash routes:
   #/            the trip: film + day cards
   #/day/DATE    one day: player per format, song, notes, ask for changes, timeline editor
   #/upload      drag footage in (resumable) */

const $ = (s, el = document) => el.querySelector(s);
const esc = (s) => String(s ?? '').replace(/[&<>"']/g, (c) => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' }[c]));
const fmtTime = (t) => { t = Math.max(0, Math.round(t || 0)); return `${Math.floor(t / 60)}:${String(t % 60).padStart(2, '0')}`; };
const fmtBytes = (b) => b > 1e9 ? `${(b / 1e9).toFixed(1)} GB` : `${Math.round(b / 1e6)} MB`;

let OV = null;          // overview cache (styles, looks…)
let DAY = null;         // current day detail
let ui = { style: localStorage.getItem('reel.style') || 'vlog', draft: null };
let pollTimer = null;

async function api(path, opts = {}) {
  const init = { ...opts };
  if (opts.json !== undefined) {
    init.method = init.method || 'POST';
    init.headers = { 'Content-Type': 'application/json' };
    init.body = JSON.stringify(opts.json);
  }
  const r = await fetch(path, init);
  if (r.status === 401) { location.reload(); throw new Error('login'); }
  const data = r.headers.get('content-type')?.includes('json') ? await r.json() : null;
  if (!r.ok) throw new Error(data?.detail || data?.error || `HTTP ${r.status}`);
  return data;
}

function toast(msg, ms = 2800) {
  const t = $('#toast');
  t.textContent = msg; t.hidden = false;
  clearTimeout(toast.t); toast.t = setTimeout(() => (t.hidden = true), ms);
}

function styleInfo(id) {
  if (id === 'film') return { id: 'film', name: 'Trip Film', aspect: [1920, 1080], platform: 'YouTube' };
  return OV.styles.find((s) => s.id === id) || { id, name: id, aspect: [1920, 1080] };
}
const isPortrait = (st) => st.aspect[1] > st.aspect[0];

function pill(status) {
  if (!status) return '';
  const label = { ready: 'ready', rendering: 'editing…', queued: 'queued', error: 'failed' }[status] || status;
  return `<span class="pill ${esc(status)}">${label}</span>`;
}

function queueBar(q) {
  const el = $('#queue');
  const n = q.jobs.length;
  if (!n) { el.hidden = true; return; }
  el.hidden = false;
  const cur = q.jobs.find((j) => j.status === 'running');
  const what = cur ? ({ treatment: 'Building the treatment', ingest: 'Analysing footage', plan: 'Planning the story', revise: 'Re-editing', render: `Rendering ${styleInfo(cur.style || 'vlog').name}`, stills: 'Grading photos', film: 'Cutting the trip film', export: 'Packing for Palmier' }[cur.kind] || cur.kind) : 'Waiting';
  el.innerHTML = `<div class="bar"><i style="width:${Math.round((q.progress || 0) * 100)}%"></i></div><span>${esc(what)}${n > 1 ? ` · ${n - 1} more` : ''}</span>`;
}

function schedulePoll(fn, busy) {
  clearTimeout(pollTimer);
  pollTimer = setTimeout(fn, busy ? 3000 : 15000);
}

/* ------------------------------------------------------------------ router */

async function route() {
  const h = location.hash || '#/';
  document.querySelectorAll('[data-nav]').forEach((a) => a.classList.toggle('on',
    (a.dataset.nav === 'upload' && h.startsWith('#/upload')) || (a.dataset.nav === 'trip' && !h.startsWith('#/upload'))));
  clearTimeout(pollTimer);
  ui.draft = null;
  try {
    if (!OV) OV = await api('/api/overview');
    if (h.startsWith('#/day/')) return await dayPage(decodeURIComponent(h.slice(6)));
    if (h.startsWith('#/upload')) return await uploadPage();
    return await tripPage();
  } catch (e) {
    if (e.message !== 'login') $('#app').innerHTML = `<div class="card err">Couldn't load: ${esc(e.message)}</div>`;
  }
}
window.addEventListener('hashchange', () => { window.scrollTo(0, 0); route(); });

/* ------------------------------------------------------------------ trip page */

async function tripPage(refresh = false) {
  OV = await api('/api/overview');
  queueBar(OV.queue);
  const film = OV.film.render;
  const withFootage = OV.days.filter((d) => d.shots);
  const app = $('#app');
  const keepVideo = refresh && $('#film-video')?.dataset.src === (film.video || '');
  const dayCards = OV.days.map((d) => {
    const statuses = Object.entries(d.renders || {});
    const pills = statuses.length
      ? statuses.filter(([k]) => k !== 'film').map(([k, s]) => `<span class="pill ${esc(s)}">${esc(styleInfo(k).name)}</span>`).join('')
      : (d.shots ? '<span class="pill queued">planning…</span>' : (d.waiting ? '' : '<span class="pill">no footage yet</span>'));
    const wait = d.waiting ? `<span class="pill rendering">${d.waiting} clip${d.waiting > 1 ? 's' : ''} analysing…</span>` : '';
    return `<a class="day" href="#/day/${d.date}">
      <div class="cover ${d.cover ? '' : 'empty'}" ${d.cover ? `style="background-image:url('${d.cover}')"` : ''}>
        ${d.cover ? '' : (d.waiting ? 'Analysing footage…' : 'Drop footage to start')}${d.number ? `<span class="num">${d.number}</span>` : ''}</div>
      <div class="body"><div class="title">${esc(d.label)}</div>
        <div class="sub">${esc(d.story || (d.shots ? `${d.shots} shots from ${d.clips} clips` : ''))}</div>
        <div class="pills">${d.song ? `<span class="pill">♪ ${esc(d.song)}</span>` : ''}${wait}${pills}</div></div></a>`;
  }).join('');
  const P = OV.processing;
  const busy = (P.total && P.done < P.total - OV.failed.length) || P.arriving;
  const arriving = P.arriving ? `<div class="card" style="margin-bottom:16px"><b>${P.arriving} file${P.arriving > 1 ? 's' : ''} arriving in the Inbox (${fmtBytes(P.arriving_bytes)})</b>
      <div class="muted" style="font-size:13px">Each file is imported once it has finished copying, then analysed. Big GoPro files take a minute or two to copy.</div></div>` : '';
  const progress = (P.total && P.done < P.total - OV.failed.length) ? `<div class="card" style="margin-bottom:16px;display:flex;gap:14px;align-items:center;flex-wrap:wrap">
      <div style="flex:1;min-width:220px"><b>Analysing footage: ${P.done} of ${P.total - OV.failed.length} clips done</b>
        <div class="muted" style="font-size:13px">${P.now ? `Now: ${esc(P.now)} · ` : ''}Each day gets its edits as soon as its own clips are finished, earliest day first. 4K takes a while, so leave the Mac awake.</div></div>
      <div class="bar" style="flex:0 0 160px;height:6px;background:var(--line);border-radius:6px;overflow:hidden"><i style="display:block;height:100%;background:var(--accent);width:${Math.round(P.done / Math.max(1, P.total) * 100)}%"></i></div></div>` : '';
  const banner = arriving + progress;
  const undated = P.undated ? `<div class="card" style="margin-bottom:16px">${P.undated} file(s) have no date in them; they're placed on the day they were added. Use the Day picker on the Upload page to put them on the right day.</div>` : '';
  const failed = OV.failed.length ? `<div class="card err" style="margin-bottom:16px">${OV.failed.length} clip(s) couldn't be read: ${OV.failed.slice(0, 3).map((f) => esc(f.name)).join(', ')}. <button class="btn small" id="retry">Retry</button></div>` : '';
  const filmPlayer = film.video
    ? (keepVideo ? null : `<video id="film-video" data-src="${film.video}" src="${film.video}#t=0.6" controls playsinline preload="metadata"></video>`)
    : `<div class="empty">The trip film builds itself as days come in.<br>${OV.film.shots ? 'Rendering soon…' : 'Upload your first footage to start.'}</div>`;
  if (keepVideo) {
    $('#film-status').innerHTML = pill(film.status);
    $('#trip-status').innerHTML = banner + undated + failed;
    $('#retry')?.addEventListener('click', async () => { await api('/api/retry', { json: {} }); toast('Retrying'); tripPage(true); });
  } else {
    app.innerHTML = `
      <div id="trip-status">${banner}${undated}${failed}</div>
      <section class="hero">
        <div><div class="player landscape">${filmPlayer}</div></div>
        <div class="hero-side">
          <div><div class="muted" style="font-size:13px;letter-spacing:.08em;text-transform:uppercase">The trip film · YouTube</div>
          <h1>${esc(OV.trip)}</h1></div>
          <div class="stats">
            <div class="stat"><b>${withFootage.length}</b><span>days filmed</span></div>
            <div class="stat"><b>${OV.film.shots}</b><span>shots</span></div>
            <div class="stat"><b>${fmtBytes(OV.disk.used)}</b><span>${fmtBytes(OV.disk.free)} free</span></div>
          </div>
          <div class="row"><a class="btn primary" href="#/upload">＋ Add tonight's footage</a>
            <a class="btn" href="#/day/trip">Edit the film</a><span id="film-status">${pill(film.status)}</span></div>
          ${OV.ai ? '' : '<p class="muted" style="font-size:13px;margin:0">Running without Claude: add ANTHROPIC_API_KEY for story planning and change requests.</p>'}
        </div>
      </section>
      <div class="section-title"><h2>Days</h2><span class="muted" style="font-size:13px">Vertical vlog for Instagram · Episode + cinematic for YouTube</span></div>
      <section class="days">${dayCards}</section>`;
    $('#retry')?.addEventListener('click', async () => { await api('/api/retry', { json: {} }); toast('Retrying'); tripPage(true); });
  }
  if (!keepVideo) { /* first paint done */ } else {
    $('.days').innerHTML = dayCards;
  }
  schedulePoll(() => location.hash.length <= 2 && tripPage(true), OV.queue.jobs.length > 0 || busy);
}

/* ------------------------------------------------------------------ day page */

const QUICK = {
  vlog: ['Open on the funniest moment', 'More of us, less scenery', 'Tighter, under 45 s', 'Add more dialogue', 'End on a laugh'],
  youtube: ['Let the moments breathe', 'More establishing shots', 'Cut the boring bits', 'Add a chapter for the drive', 'Shorter, around 3 min'],
  cinematic: ['More slow motion', 'Build slower to the peak', 'No dialogue at all', 'End on the sunset'],
  reel: ['Faster cuts', 'Hook with the best view', 'Shorter, 12 s', 'Flash on the drop'],
  photos: ['More people shots', 'More landscapes', 'Include food'],
  film: ['Shorter, 5 minutes', 'More dialogue between days', 'Open on the best day'],
};

async function dayPage(date, refresh = false) {
  const data = await api(`/api/day/${encodeURIComponent(date)}`);
  const changed = !DAY || DAY.info.date !== date;
  DAY = data;
  queueBar(data.queue);
  const styleIds = date === 'trip' ? ['film'] : OV.styles.map((s) => s.id);
  if (!styleIds.includes(ui.style)) ui.style = styleIds[0];
  const busy = data.queue.jobs.length > 0;

  if (!refresh || changed) {
    const info = data.info;
    $('#app').innerHTML = `
      <div class="day-head">
        <div><div class="kicker">${date === 'trip' ? 'Whole trip' : (info.number ? `Day ${info.number} · ${esc(info.date)}` : esc(info.date))}</div>
          <h1>${esc(info.title || info.label)}</h1></div>
        <div class="row"><a class="btn small ghost" href="#/">← All days</a>
          <a class="btn small" href="#/upload?day=${date === 'trip' ? '' : date}">＋ Footage</a></div>
      </div>
      <p class="story" id="story"></p>
      <div class="tabs" id="tabs"></div>
      <div id="workspace"></div>`;
  }
  $('#story').textContent = data.story || (data.shots.length ? '' : 'No footage for this day yet. Upload it and the edits appear here.');
  $('#tabs').innerHTML = styleIds.map((id) => {
    const st = styleInfo(id);
    const r = data.renders[id];
    return `<button data-style="${id}" class="${id === ui.style ? 'on' : ''}"><span class="s ${esc(r?.status || '')}"></span>${esc(st.name)}<span class="fmt">${isPortrait(st) ? '9:16' : (st.still ? '4:5' : '16:9')}</span></button>`;
  }).join('');
  $('#tabs').querySelectorAll('button').forEach((b) => b.onclick = () => {
    ui.style = b.dataset.style; localStorage.setItem('reel.style', ui.style); ui.draft = null; renderWorkspace(true);
  });
  renderWorkspace(changed || !refresh);
  schedulePoll(() => location.hash === `#/day/${date}` && dayPage(date, true), busy);
}

function renderWorkspace(full) {
  const d = DAY;
  const sid = ui.style;
  const st = styleInfo(sid);
  const r = d.renders[sid] || {};
  const plan = d.plans[sid];
  const ws = $('#workspace');
  const portrait = isPortrait(st) && !st.still;
  const playerKey = `${sid}|${r.video || ''}|${(r.stills || []).join()}`;

  // Keep a playing video alive across polls.
  if (!full && ws.dataset.key === playerKey && !ui.dirty) {
    $('#render-status').innerHTML = statusLine(r, plan);
    renderRequests();
    const tc = $('#treat');
    if (tc && !tc.contains(document.activeElement)) { tc.outerHTML = treatmentCard(); wireTreat(DAY.info.date); }
    return;
  }
  ws.dataset.key = playerKey;
  ws.className = `workspace ${portrait ? 'portrait' : ''}`;
  let player;
  if (st.still) {
    player = r.stills?.length
      ? `<div class="card"><div class="stills">${r.stills.map((u, i) => `<a href="${u}" download="photo-${i + 1}.jpg" target="_blank"><img src="${u}" loading="lazy" alt=""></a>`).join('')}</div>
         <p class="muted" style="font-size:13px;margin:10px 0 0">Tap a photo to save it. They're 4:5, the Instagram carousel size.</p></div>`
      : `<div class="player landscape"><div class="empty">${d.shots.length ? 'Grading photos…' : 'No footage yet'}</div></div>`;
  } else {
    player = `<div class="player ${portrait ? 'portrait' : 'landscape'}">${r.video
      ? `<video src="${r.video}#t=0.6" controls playsinline preload="metadata"></video>`
      : `<div class="empty">${r.status === 'error' ? `Render failed:<br><span class="mono">${esc((r.error || '').split('\n')[0])}</span>`
        : (!d.shots.length ? 'No footage yet'
          : (!plan && !r.status ? `This one isn't made automatically.<br><br><button class="btn primary" id="make">Make the ${esc(st.name)} edit</button>` : 'Editing… it appears here when ready.'))}</div>`}</div>`;
  }
  const downloads = st.still ? '' : `
    <div class="row" style="margin-top:12px">
      ${r.video ? `<a class="btn primary" href="/download/${r.video.split('/media/')[1].split('?')[0]}?name=${encodeURIComponent(fileName(sid, 'mp4'))}">↓ Video with music</a>` : ''}
      ${r.natsound ? `<a class="btn" href="/download/${r.natsound.split('/media/')[1].split('?')[0]}?name=${encodeURIComponent(fileName(sid + '-no-music', 'mp4'))}" title="Add the song in Instagram/TikTok so it's licensed">↓ No music (add in app)</a>` : ''}
      ${r.srt ? `<a class="btn" href="/download/${r.srt.split('/media/')[1].split('?')[0]}?name=${encodeURIComponent(fileName(sid, 'srt'))}">↓ Subtitles</a>` : ''}
      ${plan ? `<button class="btn" id="palmier">${d.exports[sid] ? '' : '⇢ '}Open in Palmier</button>` : ''}
      ${d.exports[sid] ? `<a class="btn" href="/download/${d.exports[sid].split('/media/')[1].split('?')[0]}">↓ Palmier pack</a>` : ''}
    </div>`;

  ws.innerHTML = `
    <div class="stack">
      ${player}
      <div id="render-status">${statusLine(r, plan)}</div>
      ${downloads}
      ${postCard(sid, r)}
    </div>
    <div class="stack">
      ${treatmentCard()}
      <div class="card">
        <h3>Ask for changes</h3>
        <p class="muted" style="font-size:13px;margin:4px 0 10px">${OV.ai ? 'Claude re-cuts this edit from your note.' : 'Without Claude this understands shorter/longer/faster/slower.'}</p>
        <form class="ask" id="ask"><input type="text" id="ask-text" placeholder="e.g. open on Sam losing the keys, less driving"><button class="btn primary">Re-edit</button></form>
        <div class="chips">${(QUICK[sid] || []).map((q) => `<button type="button">${esc(q)}</button>`).join('')}</div>
        <div class="requests" id="requests"></div>
      </div>
      ${songCard()}
      ${notesCard()}
      ${editorCard(sid, plan)}
    </div>`;
  wire(sid, plan);
  renderRequests();
}

function fileName(sid, ext) {
  const d = DAY.info;
  const base = DAY.info.date === 'trip' ? 'trip-film' : `day${d.number || ''}-${(d.title || '').toLowerCase().replace(/[^a-z0-9]+/g, '-').slice(0, 30)}-${sid}`;
  return `${base}.${ext}`.replace(/-+/g, '-');
}

function statusLine(r, plan) {
  const bits = [];
  if (r.status) bits.push(pill(r.status));
  if (r.duration) bits.push(`${fmtTime(r.duration)}`);
  if (r.cuts) bits.push(`${r.cuts} cuts`);
  if (r.look) bits.push(`grade: ${esc((OV.looks.find((l) => l.id === r.look) || {}).name || r.look)}`);
  if (r.version) bits.push(`v${r.version}`);
  if (plan?.by) bits.push(plan.by === 'claude' ? 'cut by Claude' : plan.by === 'you' ? 'edited by you' : plan.by === 'request' ? 'from your note' : 'auto-cut');
  return `<div class="meta">${bits.join('<span>·</span>')}</div>${plan?.logline ? `<p class="logline">“${esc(plan.logline)}”</p>` : ''}`;
}

function postCard(sid, r) {
  const p = DAY.posts[sid];
  const st = styleInfo(sid);
  if (!p && !r.description) return '';
  const tags = (p?.hashtags || []).map((t) => (st.platform === 'YouTube' ? t.replace(/^#/, '') : (t.startsWith('#') ? t : `#${t}`)));
  if (st.platform === 'YouTube') {
    const desc = r.description || p?.caption || '';
    return `<div class="card post"><h3>Post to YouTube</h3>
      ${p?.title ? `<label class="field">Title</label><pre>${esc(p.title)}</pre>` : ''}
      <label class="field">Description${r.chapters?.length ? ' + chapters' : ''}</label><pre>${esc(desc)}</pre>
      ${tags.length ? `<label class="field">Tags</label><pre class="tags">${esc(tags.join(', '))}</pre>` : ''}
      <div class="row"><button class="btn small" data-copy="${esc(p?.title || '')}">Copy title</button>
      <button class="btn small" data-copy="${esc(desc)}">Copy description</button>
      ${tags.length ? `<button class="btn small" data-copy="${esc(tags.join(', '))}">Copy tags</button>` : ''}</div></div>`;
  }
  const text = `${p.caption}\n\n${tags.join(' ')}`.trim();
  return `<div class="card post"><h3>Post to Instagram</h3><pre>${esc(p.caption)}\n\n<span class="tags">${esc(tags.join(' '))}</span></pre>
    <button class="btn small" data-copy="${esc(text)}">Copy caption</button></div>`;
}

function treatmentCard() {
  const t = DAY.treatment;
  const st = DAY.treatment_status || '';
  const busy = st === 'queued' || st === 'researching';
  const active = t ? (t.preset || 'custom') : 'clean';
  const knobs = t ? [
    t.look && `grade: ${(OV.looks.find((l) => l.id === t.look) || {}).name || t.look}`,
    t.aspect !== 'full' && t.aspect, t.vhs > 0.05 && 'VHS', t.fisheye > 0.05 && 'fisheye',
    t.rgb_split && 'RGB split', t.shake > 0.05 && 'handheld', t.timestamp && 'date stamp',
    t.flash !== 'none' && `flash on ${t.flash === 'every' ? 'every cut' : t.flash}`, t.stutter > 0.05 && 'stutters',
    t.freeze && 'freeze frame', t.punch_in > 0.05 && 'punch-ins', t.bw_moments > 0.05 && 'B&W cutaways',
    t.pacing && `${t.pacing} cuts`,
  ].filter(Boolean) : [];
  const songName = DAY.song?.name;
  return `<div class="card" id="treat">
    <h3>Treatment</h3>
    <p class="muted" style="font-size:13px;margin:4px 0 10px">The look and cutting style over every edit ${DAY.info.date === 'trip' ? 'of the film' : 'today'}.</p>
    <div class="chips" style="margin:0 0 10px">${DAY.presets.map((p) => `<button type="button" data-preset="${p.id}" class="${active === p.id ? 'on' : ''}" title="${esc(p.summary)}">${esc(p.name)}</button>`).join('')}</div>
    ${t ? `<div style="font-weight:600">${esc(t.name)}${t.source ? ` <span class="muted" style="font-weight:400;font-size:13px">· ${esc(t.source)}</span>` : ''}</div>
      <p class="muted" style="font-size:13px;margin:4px 0 6px">${esc(t.summary)}</p>
      <div class="chips" style="margin:0 0 8px">${knobs.map((k) => `<span class="pill">${esc(k)}</span>`).join('')}</div>` : ''}
    ${busy ? `<p class="muted" style="font-size:13px">${st === 'researching' ? 'Researching the style on the web…' : 'Queued…'}</p>` : ''}
    ${st.startsWith('error') ? `<p class="err" style="font-size:13px">${esc(st)}</p>` : ''}
    <form class="ask" id="treat-describe"><input type="text" id="treat-text" placeholder="Edit like… Sole Bennett, AWGE, a director, a video"><button class="btn primary" ${busy ? 'disabled' : ''}>Research</button></form>
    <div class="row" style="margin-top:8px">
      <button class="btn small" id="treat-mv" ${songName && !busy ? '' : 'disabled'} title="${songName ? '' : 'Set today\'s song first'}">🎬 Match ${songName ? `“${esc(songName)}”` : 'the song'}'s music video</button>
      <label class="muted" style="font-size:13px;display:flex;gap:6px;align-items:center"><input type="checkbox" id="treat-all"> use for every day</label>
    </div>
  </div>`;
}

function wireTreat(date) {
  const sendTreat = async (body, msg) => {
    try {
      await api(`/api/day/${date}/treatment`, { json: { ...body, everywhere: $('#treat-all')?.checked } });
      toast(msg, 4000); dayPage(date, true);
    } catch (err) { toast(err.message); }
  };
  document.querySelectorAll('[data-preset]').forEach((b) => b.onclick = () =>
    sendTreat({ preset: b.dataset.preset }, b.dataset.preset === 'clean' ? 'Back to clean: re-cutting' : `${b.textContent}: re-cutting every edit`));
  $('#treat-describe')?.addEventListener('submit', (e) => {
    e.preventDefault();
    const text = $('#treat-text').value.trim();
    if (text) sendTreat({ describe: text }, `Researching “${text}”… then re-cutting`);
  });
  $('#treat-mv')?.addEventListener('click', () => sendTreat({ music_video: true }, 'Researching the music video… then re-cutting'));
}

function songCard() {
  const s = DAY.song;
  const isTrip = DAY.info.date === 'trip';
  return `<div class="card">
    <h3>${isTrip ? 'Song for the trip film' : "Today's song"}</h3>
    ${s ? `<div class="song" style="margin-top:10px"><div class="disc"></div><div style="flex:1;min-width:0">
        <div style="font-weight:600">${esc(s.name)}</div>
        <div class="muted" style="font-size:13px">${s.bpm ? `${Math.round(s.bpm)} BPM` : ''}${s.duration && s.url ? ` · ${fmtTime(s.duration)}` : ''}${s.drop ? ` · drop ${fmtTime(s.drop)}` : ''}${!s.url ? ' · name only: cuts follow its tempo, add the track in Instagram' : ''}</div></div>
        <button class="btn small ghost" id="song-clear" title="Remove song">✕</button></div>
        ${s.url ? `<audio src="${s.url}" controls preload="none"></audio>` : ''}
        <label class="field">Start the edit at (seconds into the song)</label>
        <form class="ask" id="song-start"><input type="number" step="0.1" min="0" id="song-start-v" value="${s.start ?? ''}" placeholder="auto: ${ui.style === 'reel' ? 'one bar before the drop' : 'the top'}"><button class="btn">Set</button></form>`
      : `<p class="muted" style="font-size:13px;margin:6px 0 10px">Upload the track and every edit is cut to its beat. Or just name it: the cuts follow its tempo and you add the song in Instagram.</p>`}
    <div class="row" style="margin-top:12px">
      <label class="btn primary small" style="cursor:pointer">${s ? 'Change track' : 'Upload track'}<input type="file" id="song-file" accept="audio/*,.mp3,.m4a,.wav,.aac" hidden></label>
      <form class="ask" id="song-name" style="flex:1;min-width:220px"><input type="text" id="song-name-v" placeholder="…or type the song name"><button class="btn small">Use</button></form>
    </div></div>`;
}

function notesCard() {
  return `<details class="card" ${DAY.notes ? '' : 'open'}><summary><h3>What happened today?</h3></summary>
    <p class="muted" style="font-size:13px;margin:0 0 8px">Inside jokes, who did what, the moment that mattered. Claude builds the story around it.</p>
    <textarea id="notes" placeholder="Sam left the car keys in the pub in Dingle. Alex finally tried a spice bag. Best sunset of the trip at Slea Head.">${esc(DAY.notes)}</textarea>
    <div class="row" style="margin-top:8px"><button class="btn primary small" id="notes-save">Save &amp; re-cut the day</button><button class="btn small" id="notes-only">Just save</button></div></details>`;
}

function editorCard(sid, plan) {
  if (!DAY.shots.length) return '';
  const draft = ui.draft || (ui.draft = JSON.parse(JSON.stringify(plan || { shots: [] })));
  const byId = Object.fromEntries(DAY.shots.map((s) => [s.id, s]));
  const st = styleInfo(sid);
  const used = new Set(draft.shots.map((e) => e.id));
  const cuts = draft.shots.map((e, i) => {
    const s = byId[e.id];
    if (!s) return '';
    return `<div class="cut" data-i="${i}"><img src="${s.thumb}" alt="" loading="lazy">
      <div class="info"><div class="row" style="gap:5px">${e.role ? `<span class="role ${esc(e.role)}">${esc(e.role)}</span>` : ''}
        ${e.dialogue ? '<span class="role dlg">dialogue</span>' : ''}${s.photo ? `<span class="role">📷 ${esc({ full: 'full frame', flash: 'flash burst', overlay: 'sticker' }[e.photo_mode || 'full'])}</span>` : ''}<span class="muted">${esc(s.time)} ${esc(s.place)}</span></div>
        ${s.said ? `<div class="said">“${esc(s.said)}”</div>` : ''}
        <input type="text" data-k="${st.platform === 'YouTube' ? 'chapter' : 'caption'}" value="${esc(st.platform === 'YouTube' ? e.chapter || '' : e.caption || '')}" placeholder="${st.platform === 'YouTube' ? 'chapter card (optional)' : 'on-screen caption (optional)'}"></div>
      <div class="acts"><button data-a="up" title="Earlier">↑</button>${s.said ? `<button data-a="dlg" title="Toggle dialogue">${e.dialogue ? '🔊' : '🔈'}</button>` : ''}${s.photo ? '<button data-a="mode" title="Full frame → flash burst → sticker">⟳</button>' : ''}<button data-a="del" title="Remove">✕</button><button data-a="down" title="Later">↓</button></div></div>`;
  }).join('');
  const pool = DAY.shots.map((s) => `<div class="p ${used.has(s.id) ? 'used' : ''} ${s.hidden ? 'hidden' : ''}" data-id="${s.id}" title="${esc(s.said || s.place)}">
      <img src="${s.thumb}" alt="" loading="lazy">${s.photo ? '<span class="badge">📷</span>' : (s.said ? '<span class="badge">💬</span>' : '')}<div class="t">${esc(s.time)} ${esc(s.place || s.camera || '')}</div></div>`).join('');
  const looks = OV.looks.map((l) => `<option value="${l.id}" ${draft.look === l.id ? 'selected' : ''}>${esc(l.name)}: ${esc(l.blurb)}</option>`).join('');
  return `<details class="card" id="editor" ${ui.editorOpen ? 'open' : ''}><summary><h3>Edit the cut yourself</h3></summary>
    <div class="row" style="gap:10px;align-items:start">
      <div style="flex:1;min-width:180px"><label class="field">Title</label><input type="text" data-p="title" value="${esc(draft.title || '')}"></div>
      ${st.still ? '' : `<div style="flex:1;min-width:180px"><label class="field">${sid === 'vlog' || sid === 'reel' ? 'Hook (first seconds)' : 'Subtitle'}</label>
        <input type="text" data-p="${sid === 'vlog' || sid === 'reel' ? 'hook' : 'subtitle'}" value="${esc((sid === 'vlog' || sid === 'reel') ? draft.hook || '' : draft.subtitle || '')}"></div>`}
    </div>
    <label class="field">Colour grade</label><select data-p="look"><option value="">Style default</option>${looks}</select>
    <label class="field">Cuts in order (${draft.shots.length})</label>
    <div class="timeline" id="timeline">${cuts || '<p class="muted">Tap shots below to add them.</p>'}</div>
    <label class="field">All shots from the day: tap to add · long-press to hide a bad one</label>
    <div class="pool" id="pool">${pool}</div>
    <div class="row" style="margin-top:12px"><button class="btn primary" id="save-plan">Save &amp; render</button>
      <button class="btn" id="replan">Let Claude re-cut from scratch</button><button class="btn ghost" id="reset-plan">Discard changes</button></div>
  </details>`;
}

function renderRequests() {
  const el = $('#requests');
  if (!el) return;
  const reqs = (DAY.requests || []).filter((r) => r.style === ui.style).slice(-4).reverse();
  el.innerHTML = reqs.map((r) => `<div>${r.status === 'done' ? '✓' : '…'} ${esc(r.text)}</div>`).join('');
}

function wire(sid, plan) {
  const date = DAY.info.date;
  document.querySelectorAll('[data-copy]').forEach((b) => b.onclick = async () => {
    await navigator.clipboard.writeText(b.dataset.copy); toast('Copied');
  });
  $('#ask').onsubmit = async (e) => {
    e.preventDefault();
    const text = $('#ask-text').value.trim();
    if (!text) return;
    await api(`/api/day/${date}/ask`, { json: { style: sid, text } });
    $('#ask-text').value = '';
    toast('Re-editing: the new cut appears here when it\'s ready');
    dayPage(date, true);
  };
  document.querySelectorAll('.chips button').forEach((b) => b.onclick = () => { $('#ask-text').value = b.textContent; $('#ask-text').focus(); });
  $('#make')?.addEventListener('click', async () => {
    await api(`/api/day/${date}/replan`, { json: { style: sid } });
    toast('Planning and rendering…'); dayPage(date, true);
  });
  wireTreat(date);
  $('#palmier')?.addEventListener('click', async () => {
    await api(`/api/day/${date}/export/${sid}`, { json: {} });
    toast('Packing graded shots + song for Palmier…');
    dayPage(date, true);
  });

  // Song
  $('#song-file')?.addEventListener('change', async (e) => {
    const f = e.target.files[0];
    if (!f) return;
    const fd = new FormData(); fd.append('file', f); fd.append('name', f.name.replace(/\.[^.]+$/, ''));
    toast('Analysing the beat…', 8000);
    try { const r = await api(`/api/day/${date}/song`, { method: 'POST', body: fd }); toast(`♪ ${r.name}: ${Math.round(r.bpm)} BPM. Re-cutting every edit to it.`); }
    catch (err) { toast(err.message); }
    dayPage(date);
  });
  $('#song-name')?.addEventListener('submit', async (e) => {
    e.preventDefault();
    const name = $('#song-name-v').value.trim();
    if (!name) return;
    await api(`/api/day/${date}/song-name`, { json: { name } });
    toast('Got it: cutting to its tempo'); dayPage(date);
  });
  $('#song-start')?.addEventListener('submit', async (e) => {
    e.preventDefault();
    await api(`/api/day/${date}/song-start`, { json: { start: $('#song-start-v').value } });
    toast('Re-cutting from that point'); dayPage(date, true);
  });
  $('#song-clear')?.addEventListener('click', async () => { await api(`/api/day/${date}/song`, { method: 'DELETE' }); dayPage(date); });

  // Notes
  const saveNotes = async (replan) => {
    await api(`/api/day/${date}/notes`, { json: { notes: $('#notes').value, replan } });
    toast(replan ? 'Saved: re-cutting the day around it' : 'Saved');
    if (replan) dayPage(date, true);
  };
  $('#notes-save')?.addEventListener('click', () => saveNotes(true));
  $('#notes-only')?.addEventListener('click', () => saveNotes(false));

  // Editor
  const ed = $('#editor');
  if (!ed) return;
  ed.addEventListener('toggle', () => (ui.editorOpen = ed.open));
  const draft = ui.draft;
  const redraw = () => { ui.dirty = true; const open = ed.open; renderWorkspace(true); ui.dirty = false; if (open) $('#editor').open = true; };
  ed.querySelectorAll('[data-p]').forEach((inp) => inp.onchange = () => { draft[inp.dataset.p] = inp.value || undefined; });
  $('#timeline').querySelectorAll('.cut').forEach((row) => {
    const i = +row.dataset.i;
    row.querySelectorAll('[data-k]').forEach((inp) => inp.onchange = () => { draft.shots[i][inp.dataset.k] = inp.value || undefined; });
    row.querySelectorAll('[data-a]').forEach((b) => b.onclick = () => {
      const a = b.dataset.a;
      if (a === 'del') draft.shots.splice(i, 1);
      if (a === 'up' && i > 0) [draft.shots[i - 1], draft.shots[i]] = [draft.shots[i], draft.shots[i - 1]];
      if (a === 'down' && i < draft.shots.length - 1) [draft.shots[i + 1], draft.shots[i]] = [draft.shots[i], draft.shots[i + 1]];
      if (a === 'dlg') draft.shots[i].dialogue = !draft.shots[i].dialogue;
      if (a === 'mode') { const m = ['full', 'flash', 'overlay']; draft.shots[i].photo_mode = m[(m.indexOf(draft.shots[i].photo_mode || 'full') + 1) % 3]; }
      redraw();
    });
  });
  $('#pool').querySelectorAll('.p').forEach((p) => {
    let pressTimer = null;
    let longPressed = false;
    const id = p.dataset.id;
    p.onpointerdown = () => { longPressed = false; pressTimer = setTimeout(async () => {
      longPressed = true;
      const s = DAY.shots.find((x) => x.id === id);
      await api(`/api/shot/${id}`, { json: { hidden: !s.hidden } });
      s.hidden = !s.hidden; toast(s.hidden ? 'Hidden: it won\'t be used again' : 'Shot restored'); redraw();
    }, 600); };
    p.onpointerup = p.onpointerleave = () => clearTimeout(pressTimer);
    p.onclick = () => {
      if (longPressed) return;
      if (draft.shots.some((e) => e.id === id)) { toast('Already in the cut'); return; }
      const s = DAY.shots.find((x) => x.id === id);
      draft.shots.push(s.photo ? { id, photo_mode: 'overlay' } : { id, dialogue: !!s.said && sid !== 'reel' && sid !== 'cinematic' });
      redraw();
    };
  });
  $('#save-plan').onclick = async () => {
    await api(`/api/day/${date}/plan/${sid}`, { json: draft });
    toast('Saved: rendering your cut'); ui.draft = null; dayPage(date, true);
  };
  $('#replan').onclick = async () => {
    if (!confirm('Throw away this cut and let Claude plan it again?')) return;
    await api(`/api/day/${date}/replan`, { json: { style: sid } });
    ui.draft = null; toast('Re-planning…'); dayPage(date, true);
  };
  $('#reset-plan').onclick = () => { ui.draft = null; redraw(); };
}

/* ------------------------------------------------------------------ upload page */

async function uploadPage() {
  const params = new URLSearchParams(location.hash.split('?')[1] || '');
  const days = OV.days.map((d) => `<option value="${d.date}" ${params.get('day') === d.date ? 'selected' : ''}>${esc(d.label)}</option>`).join('');
  $('#app').innerHTML = `
    <h1 style="margin-bottom:6px">Add footage</h1>
    <p class="muted" style="margin:0 0 18px">GoPro files, iPhone videos and photos (photos become stickers, flash bursts or full-frame moments). Each clip is sorted into its day by the camera's clock, analysed, transcribed and cut into the day's edits. Uploads resume if the connection drops.</p>
    ${OV.inbox ? `<div class="card" style="margin-bottom:14px"><b>Fastest on the Mac:</b> drag files straight into <span class="mono">${esc(OV.inbox)}</span> in Finder (or AirDrop there). They're picked up automatically.</div>` : ''}
    <label class="drop" id="drop"><h2>Drop videos and photos here</h2><div class="muted">or tap to choose · .MP4 .MOV .HEIC .JPG</div>
      <input type="file" id="files" accept="video/*,image/*,.mp4,.mov,.MP4,.MOV,.heic,.HEIC,.jpg,.jpeg" multiple hidden></label>
    <div class="row" style="margin-top:12px"><label class="muted" for="day">Day:</label>
      <select id="day" style="max-width:340px"><option value="auto">Automatic, from the camera clock</option>${days}</select></div>
    <div class="uploads" id="uploads"></div>
    <div class="section-title"><h2>Recent clips</h2><button class="btn small" id="retry">Retry failed</button></div>
    <div class="card" style="padding:4px 12px"><table class="table" id="clips"></table></div>`;
  const drop = $('#drop');
  const files = $('#files');
  files.onchange = () => queueFiles([...files.files]);
  drop.addEventListener('dragover', (e) => { e.preventDefault(); drop.classList.add('over'); });
  drop.addEventListener('dragleave', () => drop.classList.remove('over'));
  drop.addEventListener('drop', (e) => { e.preventDefault(); drop.classList.remove('over'); queueFiles([...e.dataTransfer.files]); });
  $('#retry').onclick = async () => {
    // Uploads the browser couldn't send, plus clips that failed analysis on the Mac.
    const again = failedUploads.splice(0);
    for (const { f, day, row } of again) {
      const st = $('.st', row);
      st.textContent = 'retrying…'; st.classList.remove('err');
      uploading = uploading.then(() => uploadFile(f, day, row)).catch(() => {});
    }
    const r = await api('/api/retry', { json: {} });
    toast(`Retrying ${again.length + r.retried} file(s)`); refreshClips();
  };
  refreshClips();
}

async function refreshClips() {
  const t = $('#clips');
  if (!t) return;
  const rows = await api('/api/clips');
  const ov = await api('/api/overview');
  queueBar(ov.queue);
  t.innerHTML = rows.length ? rows.map((c) => `<tr><td>${esc(c.name)}</td><td class="muted">${esc(c.day || '')}</td>
    <td>${{ ready: `<span class="pill ready">${c.shots} shots</span>`, queued: '<span class="pill queued">waiting</span>', analysing: '<span class="pill rendering">analysing…</span>', error: `<span class="pill error" title="${esc(c.error)}">failed</span>` }[c.status] || esc(c.status)}</td></tr>`).join('')
    : '<tr><td class="muted">Nothing yet.</td></tr>';
  clearTimeout(pollTimer);
  if (location.hash.startsWith('#/upload')) pollTimer = setTimeout(refreshClips, ov.queue.jobs.length ? 4000 : 15000);
}

const CHUNK = 8 * 1024 * 1024;
let failedUploads = [];
let uploading = Promise.resolve();

function queueFiles(list) {
  const day = $('#day').value;
  for (const f of list) {
    const row = document.createElement('div');
    row.className = 'up';
    row.innerHTML = `<div>${esc(f.name)}</div><div class="muted st">${fmtBytes(f.size)}</div><div class="bar"><i></i></div>`;
    $('#uploads').prepend(row);
    uploading = uploading.then(() => uploadFile(f, day, row)).catch(() => {});
  }
}

async function uploadFile(f, day, row) {
  const st = $('.st', row), bar = $('.bar i', row);
  try {
    const init = await api('/api/upload/init', { json: { name: f.name, size: f.size, lastModified: f.lastModified, day } });
    let offset = init.offset;
    let tries = 0;
    while (offset < f.size) {
      const chunk = f.slice(offset, offset + CHUNK);
      try {
        const r = await fetch(`/api/upload/${init.id}?offset=${offset}`, { method: 'PUT', body: chunk });
        const j = await r.json();
        offset = j.offset;
        tries = 0;
        if (j.done) { st.textContent = j.duplicate ? 'already uploaded' : 'uploaded · analysing'; row.classList.add('done'); }
      } catch (e) {
        if (++tries > 8) throw e;
        st.textContent = 'connection lost, retrying…';
        await new Promise((r) => setTimeout(r, 2000 * tries));
        const again = await api('/api/upload/init', { json: { name: f.name, size: f.size, lastModified: f.lastModified, day } });
        offset = again.offset;
      }
      bar.style.width = `${Math.round((offset / f.size) * 100)}%`;
      if (!row.classList.contains('done')) st.textContent = `${fmtBytes(offset)} / ${fmtBytes(f.size)}`;
    }
    if (f.size === 0) throw new Error('empty file');
  } catch (e) {
    st.textContent = `failed: ${e.message}`; st.classList.add('err');
    failedUploads.push({ f, day, row });
  }
  refreshClips();
}

route();
