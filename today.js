/* =====================================================================
   Today: the day's work on a phone, for whoever is out doing it.
   Jobs in order with directions, a call button and access notes; mark each one
   done or skipped (with a reason), add a note, and take before and after photos.
   Works without signal: the day is kept on the phone, and changes and photos
   are sent when the connection comes back.
   Uses from purgo.js: $, esc, sb, gbp, flash, ME, ROLE, LS, isNetErr
   ===================================================================== */
const TODAY = (()=>{
  const BUCKET = 'visit-photos';
  const SVC = {windows:'Window cleaning', gutters:'Gutter clean', roof:'Roof clean', pressure:'Pressure washing'};
  const SKIPS = ['No access (gate locked, car on drive)', 'Customer cancelled', 'Weather', 'Ran out of time', 'Other'];
  const pad = n => String(n).padStart(2, '0');
  const ymd = d => `${d.getFullYear()}-${pad(d.getMonth()+1)}-${pad(d.getDate())}`;
  const day = s => new Date(s + 'T12:00:00');
  const whole = n => '£' + Math.round(n||0).toLocaleString('en-GB');
  const root = () => $('view-today');
  let date = ymd(new Date()), who = null, cals = [], visits = [], photos = {}, urls = {}, loading = false, offline = false, openNote = null;

  /* ---------- kept on the phone ---------- */
  const qKey = () => 'purgoTodayQ:' + (ME && ME.id);
  const dayKey = (d, w) => `purgoToday:${ME && ME.id}:${d}:${w || 'all'}`;
  const queue = () => LS.get(qKey(), []);
  const setQueue = q => LS.set(qKey(), q);
  // photos waiting to upload live in IndexedDB (too big for local storage)
  const idb = () => new Promise((res, rej) => { const r = indexedDB.open('purgo-today', 1); r.onupgradeneeded = () => r.result.createObjectStore('photos', {keyPath:'id'}); r.onsuccess = () => res(r.result); r.onerror = () => rej(r.error); });
  async function idbAll(){ try{ const db = await idb(); return await new Promise(res => { const t = db.transaction('photos').objectStore('photos').getAll(); t.onsuccess = () => res(t.result || []); t.onerror = () => res([]); }); }catch(e){ return []; } }
  async function idbPut(x){ const db = await idb(); await new Promise((res, rej) => { const t = db.transaction('photos', 'readwrite'); t.objectStore('photos').put(x); t.oncomplete = res; t.onerror = () => rej(t.error); }); }
  async function idbDel(id){ try{ const db = await idb(); await new Promise(res => { const t = db.transaction('photos', 'readwrite'); t.objectStore('photos').delete(id); t.oncomplete = res; t.onerror = res; }); }catch(e){} }

  /* ---------- loading ---------- */
  async function loadCals(){
    if(cals.length) return;
    const {data} = await sb.from('staff_calendars').select('id,name,profile_id,active,sort').eq('active', true).order('sort');
    cals = data || [];
    // last choice on this phone; otherwise your own day (the admin sees everyone's)
    if(who === null){ const kept = LS.get('purgoTodayWho:' + (ME && ME.id), null), mine = cals.find(c => c.profile_id === (ME && ME.id));
      who = kept !== null && (kept === '' || cals.some(c => c.id === kept)) ? kept : (ROLE !== 'admin' && mine ? mine.id : ''); }
  }
  async function load(){
    loading = true; render();
    try{
      await loadCals();
      let q = sb.from('visits').select('id,date,start_time,duration_min,status,price,notes,skip_reason,done_at,done_by_name,calendar_id,account_id,job_id,accounts(name,phone,kind),jobs(title,service,line,postcode,notes,frequency_weeks,monthly)')
        .eq('date', date).in('status', ['booked','done','skipped']).order('start_time', {nullsFirst:false}).order('created_at');
      if(who) q = q.eq('calendar_id', who);
      const {data, error} = await q;
      if(error) throw error;
      visits = data || [];
      const ids = visits.map(v => v.id);
      photos = {};
      if(ids.length){
        const {data:ph} = await sb.from('visit_photos').select('id,visit_id,kind,path').in('visit_id', ids).order('created_at');
        (ph || []).forEach(p => (photos[p.visit_id] = photos[p.visit_id] || []).push(p));
        const need = (ph || []).map(p => p.path).filter(p => !urls[p]);
        if(need.length){ const {data:su} = await sb.storage.from(BUCKET).createSignedUrls(need, 60*60*6); (su || []).forEach(s => { if(s.signedUrl) urls[s.path] = s.signedUrl; }); }
      }
      LS.set(dayKey(date, who), {visits, photos, at: Date.now()});
      offline = false;
    }catch(e){
      const kept = LS.get(dayKey(date, who), null);
      if(kept){ visits = kept.visits; photos = kept.photos || {}; offline = true; }
      else { visits = []; offline = true; if(!isNetErr(e)) flash('Could not load the day: ' + (e.message || e)); }
    }
    applyQueue();
    loading = false; render();
  }
  // show changes still waiting to send, so the list matches what was tapped
  function applyQueue(){
    queue().forEach(a => { const v = visits.find(x => x.id === a.id); if(v) Object.assign(v, a.patch); });
  }

  /* ---------- changes ---------- */
  async function change(v, patch, msg){
    Object.assign(v, patch); render();
    try{
      if(!navigator.onLine) throw new Error('offline');
      const {error} = await sb.from('visits').update(patch).eq('id', v.id);
      if(error) throw error;
      if(typeof JOBS!=='undefined' && JOBS.kick) JOBS.kick();
      if(msg) flash(msg);
      LS.set(dayKey(date, who), {visits, photos, at: Date.now()});
    }catch(e){
      if(!isNetErr(e) && e.message !== 'offline'){ flash('Not saved: ' + (e.message || e)); return load(); }
      const q = queue().filter(a => a.id !== v.id || Object.keys(a.patch).some(k => !(k in patch)));
      q.push({id:v.id, patch, at:Date.now()}); setQueue(q);
      LS.set(dayKey(date, who), {visits, photos, at: Date.now()});
      flash((msg ? msg + '. ' : '') + 'No signal: it will be sent when you\'re back online.');
      render();
    }
  }
  async function flush(){
    if(!navigator.onLine || !ME) return;
    let q = queue(), sent = 0;
    for(const a of q.slice()){
      const {error} = await sb.from('visits').update(a.patch).eq('id', a.id);
      if(error && isNetErr(error)) break;
      q = q.filter(x => x !== a); setQueue(q); sent++;
    }
    for(const p of await idbAll()){
      try{ await uploadPhoto(p.visitId, p.accountId, p.kind, p.blob); await idbDel(p.id); sent++; }
      catch(e){ if(isNetErr(e)) break; await idbDel(p.id); }
    }
    if(sent){ if(typeof JOBS!=='undefined' && JOBS.kick) JOBS.kick(); flash(`Sent ${sent} change${sent===1?'':'s'} made without signal`); if(!root().hidden) load(); }
  }
  window.addEventListener('online', () => { flush(); });

  /* ---------- photos ---------- */
  async function shrink(file){
    try{
      const bmp = await createImageBitmap(file), max = 1600, k = Math.min(1, max / Math.max(bmp.width, bmp.height));
      const cv = document.createElement('canvas'); cv.width = Math.round(bmp.width*k); cv.height = Math.round(bmp.height*k);
      cv.getContext('2d').drawImage(bmp, 0, 0, cv.width, cv.height);
      return await new Promise(r => cv.toBlob(b => r(b || file), 'image/jpeg', .82));
    }catch(e){ return file; }
  }
  async function uploadPhoto(visitId, accountId, kind, blob){
    const path = `${accountId || 'none'}/${visitId}/${kind}-${Date.now()}-${Math.random().toString(36).slice(2,7)}.jpg`;
    const {error} = await sb.storage.from(BUCKET).upload(path, blob, {contentType:'image/jpeg', upsert:false});
    if(error) throw error;
    const {data:row, error:e2} = await sb.from('visit_photos').insert({visit_id:visitId, account_id:accountId, kind, path, created_by_name:ME.name}).select('id,visit_id,kind,path').single();
    if(e2) throw e2;
    const {data} = await sb.storage.from(BUCKET).createSignedUrl(path, 60*60*6); if(data) urls[path] = data.signedUrl;
    return row;
  }
  async function addPhotos(v, kind, files){
    for(const f of files){
      const blob = await shrink(f);
      try{
        if(!navigator.onLine) throw new Error('offline');
        const row = await uploadPhoto(v.id, v.account_id, kind, blob);
        (photos[v.id] = photos[v.id] || []).push(row);
      }catch(e){
        if(!isNetErr(e) && e.message !== 'offline'){ flash('Photo not saved: ' + (e.message || e)); continue; }
        await idbPut({id:crypto.randomUUID(), visitId:v.id, accountId:v.account_id, kind, blob});
        (photos[v.id] = photos[v.id] || []).push({id:'local', kind, local:URL.createObjectURL(blob)});
        flash('No signal: the photo will upload when you\'re back online.');
      }
    }
    render();
  }

  /* ---------- drawing ---------- */
  const addr = v => { const j = v.jobs || {}; return [j.line, j.postcode].filter(Boolean).join(', '); };
  const mapsTo = v => 'https://www.google.com/maps/dir/?api=1&travelmode=driving&destination=' + encodeURIComponent(addr(v));
  function routeLink(list){
    const stops = list.filter(v => v.status === 'booked' && addr(v)).slice(0, 10);
    if(!stops.length) return '';
    const last = stops[stops.length - 1], way = stops.slice(0, -1).map(addr);
    return 'https://www.google.com/maps/dir/?api=1&travelmode=driving&destination=' + encodeURIComponent(addr(last)) + (way.length ? '&waypoints=' + encodeURIComponent(way.join('|')) : '');
  }
  function dayLabel(){
    const t = ymd(new Date()), d = day(date);
    const tm = ymd(new Date(Date.now() + 864e5)), ye = ymd(new Date(Date.now() - 864e5));
    const name = date === t ? 'Today' : date === tm ? 'Tomorrow' : date === ye ? 'Yesterday' : d.toLocaleDateString('en-GB', {weekday:'long'});
    return {name, full: d.toLocaleDateString('en-GB', {weekday:'long', day:'numeric', month:'long'})};
  }
  function card(v, i){
    const j = v.jobs || {}, a = v.accounts || {}, ph = photos[v.id] || [];
    const tel = (a.phone || '').replace(/[^\d+]/g, '');
    const state = v.status === 'done' ? `<span class="td-st good">Done${v.done_by_name ? ' · ' + esc(v.done_by_name) : ''}</span>` : v.status === 'skipped' ? `<span class="td-st">Skipped${v.skip_reason ? ': ' + esc(v.skip_reason) : ''}</span>` : '';
    const thumbs = ph.map(p => { const src = p.local || urls[p.path]; return src ? `<a class="td-ph" href="${esc(src)}" target="_blank" rel="noopener"><img src="${esc(src)}" alt="${esc(p.kind)} photo" loading="lazy"><span>${esc(p.kind)}</span></a>` : ''; }).join('');
    return `<article class="td-card ${v.status}" data-v="${v.id}">
      <div class="td-top"><span class="td-n">${i+1}</span><div class="td-main">
        <div class="td-name"><b>${esc(a.name || 'Customer')}</b>${+v.price ? `<span class="td-price">${gbp(+v.price)}</span>` : ''}</div>
        <div class="td-line">${v.start_time ? `<b>${v.start_time.slice(0,5)}</b> · ` : ''}${esc(SVC[j.service] || j.title || 'Visit')}${v.duration_min ? ` · ${v.duration_min} min` : ''}</div>
        <div class="td-addr">${esc(addr(v) || 'No address on the job')}</div>
        ${j.notes ? `<div class="td-note"><b>Notes:</b> ${esc(j.notes)}</div>` : ''}
        ${v.notes ? `<div class="td-note"><b>Today:</b> ${esc(v.notes)}</div>` : ''}
        ${state}
      </div></div>
      ${thumbs ? `<div class="td-phs">${thumbs}</div>` : ''}
      <div class="td-acts">
        ${addr(v) ? `<a class="btn sm" href="${mapsTo(v)}" target="_blank" rel="noopener">Directions</a>` : ''}
        ${tel ? `<a class="btn sm" href="tel:${esc(tel)}">Call</a>` : ''}
        <label class="btn sm td-file">Photo<input type="file" accept="image/*" capture="environment" multiple data-photo="${v.status === 'booked' ? 'before' : 'after'}" hidden></label>
        <button class="btn sm" type="button" data-note>${v.notes ? 'Edit note' : 'Note'}</button>
        ${v.status === 'booked' ? `<button class="btn sm" type="button" data-skip>Skip</button><button class="btn sm pri" type="button" data-done>Done</button>` : `<button class="btn sm" type="button" data-undo>Undo</button>`}
      </div>
      ${openNote === v.id ? `<div class="td-noteform"><textarea rows="3" placeholder="e.g. side gate was locked, back windows not done">${esc(v.notes || '')}</textarea><div class="td-acts"><button class="btn sm" type="button" data-notecancel>Cancel</button><button class="btn sm pri" type="button" data-notesave>Save note</button></div></div>` : ''}
    </article>`;
  }
  function render(){
    const el = root(); if(!el || el.hidden) return;
    const L = dayLabel();
    const booked = visits.filter(v => v.status === 'booked'), done = visits.filter(v => v.status === 'done');
    const total = visits.filter(v => v.status !== 'skipped');
    const pct = total.length ? Math.round(100 * done.length / total.length) : 0;
    const route = routeLink(visits);
    const waiting = queue().length;
    el.innerHTML = `<div class="viewbar"><div><h2 class="vtitle">${L.name}</h2><p class="sub">${L.full}</p></div>
        <div class="vb-actions td-nav"><button class="btn sm" type="button" data-day="-1" aria-label="Previous day">‹</button><input type="date" id="tdDate" value="${date}"><button class="btn sm" type="button" data-day="1" aria-label="Next day">›</button></div></div>
      ${cals.length > 1 ? `<div class="td-who"><label>Whose day <select id="tdWho"><option value="">Everyone</option>${cals.map(c => `<option value="${c.id}" ${who === c.id ? 'selected' : ''}>${esc(c.name)}</option>`).join('')}</select></label></div>` : ''}
      ${offline ? `<p class="note w">No signal: showing the day as last loaded on this phone.${waiting ? ` ${waiting} change${waiting===1?'':'s'} waiting to send.` : ''}</p>` : waiting ? `<p class="note w">${waiting} change${waiting===1?'':'s'} waiting to send.</p>` : ''}
      ${loading && !visits.length ? `<section class="card"><p class="hint">Loading…</p></section>` : !visits.length ? `<section class="card"><p class="hint">Nothing booked${who ? ' for ' + esc((cals.find(c => c.id === who) || {}).name || '') : ''} on this day.</p></section>` : `
      <section class="card td-sum">
        <div class="td-prog"><div style="width:${pct}%"></div></div>
        <div class="td-sumrow"><span><b>${done.length} of ${total.length}</b> done · ${booked.length} to go</span><span>${whole(+done.reduce((t, v) => t + (+v.price || 0), 0))} of ${whole(total.reduce((t, v) => t + (+v.price || 0), 0))}</span></div>
        ${route ? `<a class="btn sm" href="${route}" target="_blank" rel="noopener">Route for the jobs left, in Google Maps</a>` : ''}
      </section>
      <div class="td-list">${visits.map(card).join('')}</div>`}`;
    wire();
  }
  function wire(){
    const el = root();
    el.querySelectorAll('[data-day]').forEach(b => b.onclick = () => { const d = day(date); d.setDate(d.getDate() + +b.dataset.day); date = ymd(d); openNote = null; load(); });
    const dt = $('tdDate'); if(dt) dt.onchange = () => { if(dt.value){ date = dt.value; openNote = null; load(); } };
    const w = $('tdWho'); if(w) w.onchange = () => { who = w.value; LS.set('purgoTodayWho:' + (ME && ME.id), who); load(); };
    el.querySelectorAll('.td-card').forEach(c => {
      const v = visits.find(x => x.id === c.dataset.v); if(!v) return;
      const q = s => c.querySelector(s);
      if(q('[data-done]')) q('[data-done]').onclick = () => change(v, {status:'done', done_at:new Date().toISOString(), done_by_name:ME.name, skip_reason:null}, 'Marked done');
      if(q('[data-undo]')) q('[data-undo]').onclick = () => change(v, {status:'booked', done_at:null, done_by_name:null, skip_reason:null}, 'Back to booked');
      if(q('[data-skip]')) q('[data-skip]').onclick = () => skipDialog(v);
      q('[data-note]').onclick = () => { openNote = openNote === v.id ? null : v.id; render(); const t = root().querySelector('.td-noteform textarea'); if(t) t.focus(); };
      if(q('[data-notecancel]')) q('[data-notecancel]').onclick = () => { openNote = null; render(); };
      if(q('[data-notesave]')) q('[data-notesave]').onclick = () => { const t = q('.td-noteform textarea').value.trim(); openNote = null; change(v, {notes:t || null}, 'Note saved'); };
      const f = q('[data-photo]'); if(f) f.onchange = () => { if(f.files.length) addPhotos(v, f.dataset.photo, [...f.files]); };
    });
  }
  function skipDialog(v){
    const dlg = document.createElement('dialog'); dlg.className = 'ac-dlg';
    dlg.innerHTML = `<form method="dialog"><h3>Skip ${esc((v.accounts||{}).name || 'this visit')}?</h3>
      <div class="td-reasons">${SKIPS.map((s, i) => `<label class="ck"><input type="radio" name="r" value="${esc(s)}" ${i===0?'checked':''}> ${esc(s)}</label>`).join('')}</div>
      <label class="f">Anything to add <small>(optional)</small><input name="more" placeholder="e.g. back gate padlocked"></label>
      <p class="hint">${(v.jobs||{}).frequency_weeks || (v.jobs||{}).monthly ? 'This regular job moves on to its next clean.' : 'This one-off job goes back on the To book list.'}</p>
      <div class="vb-actions"><button class="btn" value="cancel">Cancel</button><button class="btn pri" value="ok">Skip visit</button></div></form>`;
    document.body.appendChild(dlg); dlg.showModal();
    dlg.addEventListener('close', () => {
      if(dlg.returnValue === 'ok'){
        const fd = new FormData(dlg.querySelector('form')), r = fd.get('r'), more = String(fd.get('more') || '').trim();
        change(v, {status:'skipped', skip_reason:[r, more].filter(Boolean).join(': '), done_at:null, done_by_name:ME.name}, 'Skipped');
      }
      dlg.remove();
    });
  }

  function onShow(){ flush(); load(); }
  return {onShow, flush, reset:() => { cals = []; who = null; visits = []; photos = {}; date = ymd(new Date()); }};
})();
