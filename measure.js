/* =====================================================================
   Purgō Measure (dev): satellite view, AI outline, drag to adjust,
   live m² / metres, drop the figure into the quote.
   Uses: $, esc, gbp, num, fmtPc, sb, CFG, ME, ROLE, pwRows, render, show, renderPw, syncSvc from purgo.js
   ===================================================================== */
const MEASURE = (()=>{
  const PITCH = [
    {v:'flat',  label:'Flat / very low (≤10°)', f:1.00, rf:'low'},
    {v:'low',   label:'Low (about 20°)',        f:1.06, rf:'low'},
    {v:'std',   label:'Standard (about 35°)',   f:1.22, rf:'std'},
    {v:'steep', label:'Steep (about 45°)',      f:1.41, rf:'steep'},
    {v:'vsteep',label:'Very steep (about 55°)', f:1.74, rf:'steep'}
  ];
  const COLORS = {ai:'#6da7c4', manual:'#f2c14e'};
  const KIND_LABEL = {patio:'Drive / patio', roof:'Roof', gutters:'Gutters'};
  let gmap = null, geocoder = null, loading = null;
  let kind = 'patio', target = null, drawing = null, delMode = false, splitPts = null, splitLine = null;
  let shapes = [];        // {id, label, type:'area'|'line', kind, source, pitch, obj}
  let suggestions = null, lastNotes = '';
  let seq = 0;

  const el = id => document.getElementById(id);
  const status = (t, cls) => { const s = el('mStatus'); s.textContent = t || ''; s.className = 'note ' + (cls||'') ; s.hidden = !t; };

  function loadGoogle(){
    if(window.google && google.maps && google.maps.geometry) return Promise.resolve();
    if(loading) return loading;
    const key = (window.PURGO_CONFIG||{}).googleMapsKey;
    if(!key) return Promise.reject(new Error('The Google Maps key is not set up yet. Add it to config.js as googleMapsKey.'));
    loading = new Promise((res, rej)=>{
      window.__purgoGm = ()=> res();
      const s = document.createElement('script');
      s.src = `https://maps.googleapis.com/maps/api/js?key=${encodeURIComponent(key)}&libraries=geometry&v=quarterly&loading=async&callback=__purgoGm`;
      s.async = true; s.onerror = ()=>{ loading = null; rej(new Error('Google Maps did not load. Check your connection and the key.')); };
      document.head.appendChild(s);
    });
    return loading;
  }

  async function ensureMap(){
    await loadGoogle();
    if(gmap) return;
    gmap = new google.maps.Map(el('mMap'), {
      center:{lat:53.726587, lng:-0.416505}, zoom:19, mapTypeId:'satellite', tilt:0, heading:0,
      disableDefaultUI:true, zoomControl:true, fullscreenControl:true, gestureHandling:'greedy', clickableIcons:false
    });
    gmap.setTilt(0);
    geocoder = new google.maps.Geocoder();
    gmap.addListener('click', e=>{ if(splitPts) splitClick(e.latLng); else if(drawing) addPoint(e.latLng); });
  }

  function measureOf(s){
    const path = s.obj.getPath();
    if(s.type==='line') return google.maps.geometry.spherical.computeLength(path);
    return path.getLength()>=3 ? google.maps.geometry.spherical.computeArea(path) : 0;
  }
  function pitchOf(s){ return PITCH.find(p=>p.v===s.pitch) || PITCH[2]; }
  function shownValue(s){
    const m = measureOf(s);
    if(s.type==='line') return {n:m, txt:`${m.toFixed(1)} m`};
    if(s.kind==='roof'){ const a = m*pitchOf(s).f; return {n:a, txt:`${a.toFixed(1)} m² roof`, sub:`${m.toFixed(1)} m² footprint × ${pitchOf(s).f}`}; }
    return {n:m, txt:`${m.toFixed(1)} m²`};
  }

  function makeObj(type, path, source){
    const opts = {path, editable:true, draggable:false, strokeColor:COLORS[source], strokeWeight:3, strokeOpacity:1, map:gmap, zIndex:2};
    return type==='line' ? new google.maps.Polyline(opts) : new google.maps.Polygon(Object.assign(opts, {fillColor:COLORS[source], fillOpacity:.28}));
  }
  function addShape({label, type, path, source, pitch}){
    const s = {id:++seq, label, type, kind, source, pitch: pitch || (kind==='roof' ? 'std' : null)};
    s.obj = makeObj(type, path, source);
    const p = s.obj.getPath();
    ['set_at','insert_at','remove_at'].forEach(ev=> p.addListener(ev, ()=> list()));
    s.obj.addListener('click', e=>{
      if(delMode && e.vertex!=null){ if(p.getLength() > (type==='line'?2:3)) p.removeAt(e.vertex); else status('A shape needs at least '+(type==='line'?2:3)+' points. Delete the shape instead.', 'w'); }
    });
    shapes.push(s); list(); return s;
  }
  function removeShape(id){ const i = shapes.findIndex(s=>s.id===id); if(i<0) return; shapes[i].obj.setMap(null); shapes.splice(i,1); list(); }
  function clearAll(){ shapes.forEach(s=>s.obj.setMap(null)); shapes = []; stopDraw(); suggestions = null; lastNotes=''; list(); }

  function startDraw(){
    stopDraw();
    const type = kind==='gutters' ? 'line' : 'area';
    drawing = addShape({label: kind==='gutters' ? 'Gutter run' : kind==='roof' ? 'Roof' : 'Area', type, path:[], source:'manual'});
    el('mDraw').textContent = 'Finish shape'; el('mDraw').classList.add('pri');
    status(type==='line' ? 'Tap along the gutter line, then press Finish shape.' : 'Tap each corner in turn, then press Finish shape.', '');
    gmap.setOptions({draggableCursor:'crosshair'});
  }
  /* ----- split along a line (party wall) and keep the side with the cross ----- */
  function startSplit(){
    stopDraw();
    if(!shapes.some(s=>s.kind===kind)){ status('Outline something first, then split it.', 'w'); return; }
    splitPts = [];
    shapes.forEach(s=> s.obj.setOptions({clickable:false}));
    gmap.setOptions({draggableCursor:'crosshair'});
    el('mSplit').textContent = 'Cancel split'; el('mSplit').classList.add('pri');
    status('Tap one end of the party wall, then the other end. The side with the cross is kept.', '');
  }
  function endSplit(msg, cls){
    splitPts = null;
    if(splitLine){ const l = splitLine; setTimeout(()=>l.setMap(null), 1200); splitLine = null; }
    shapes.forEach(s=> s.obj.setOptions({clickable: s.kind===kind}));
    gmap.setOptions({draggableCursor:null});
    el('mSplit').textContent = 'Split'; el('mSplit').classList.remove('pri');
    status(msg||'', cls);
  }
  function splitClick(ll){
    splitPts.push(ll);
    if(!splitLine) splitLine = new google.maps.Polyline({map:gmap, path:[ll], strokeColor:'#ffffff', strokeWeight:3, strokeOpacity:1, zIndex:5, clickable:false,
      icons:[{icon:{path:'M 0,-1 0,1', strokeOpacity:1, scale:3}, offset:'0', repeat:'12px'}]});
    else splitLine.getPath().push(ll);
    if(splitPts.length < 2) return;
    const [a, b] = splitPts, ref = gmap.getCenter();
    const k = Math.cos(ref.lat()*Math.PI/180);
    const P = q => [q.lng()*k, q.lat()], Q = p => ({lat:p[1], lng:p[0]/k});
    const A = P(a), B = P(b);
    const side = p => (B[0]-A[0])*(p[1]-A[1]) - (B[1]-A[1])*(p[0]-A[0]);
    const keep = Math.sign(side(P(ref))) || 1;
    const inside = p => side(p)*keep >= 0;
    const cut = (p, q) => { const sp = side(p), sq = side(q), t = sp/(sp-sq); return [p[0]+(q[0]-p[0])*t, p[1]+(q[1]-p[1])*t]; };
    let changed = 0;
    shapes.filter(s=>s.kind===kind).slice().forEach(s=>{
      const pts = s.obj.getPath().getArray().map(P);
      if(s.type==='area'){
        const out = [];
        for(let i=0;i<pts.length;i++){
          const cur = pts[i], prev = pts[(i+pts.length-1)%pts.length];
          if(inside(cur)){ if(!inside(prev)) out.push(cut(prev,cur)); out.push(cur); }
          else if(inside(prev)) out.push(cut(prev,cur));
        }
        if(out.length===pts.length && out.every((p,i)=>p===pts[i])) return;
        changed++;
        if(out.length < 3) removeShape(s.id); else s.obj.setPath(out.map(Q));
      } else {
        const pieces = []; let curPiece = [], crossed = false;
        for(let i=0;i<pts.length;i++){
          const p = pts[i];
          if(i>0){ const prev = pts[i-1];
            if(inside(prev) !== inside(p)){ crossed = true; const x = cut(prev,p); if(inside(prev)){ curPiece.push(x); pieces.push(curPiece); curPiece = []; } else curPiece.push(x); } }
          if(inside(p)) curPiece.push(p);
        }
        if(curPiece.length) pieces.push(curPiece);
        const good = pieces.filter(pc=>pc.length>=2);
        if(!crossed && pts.every(inside)) return;
        changed++;
        if(!good.length){ removeShape(s.id); return; }
        s.obj.setPath(good[0].map(Q));
        good.slice(1).forEach((pc,i)=> addShape({label:s.label+' ('+(i+2)+')', type:'line', path:pc.map(Q), source:s.source, pitch:s.pitch}));
      }
      // re-attach change listeners to the new path
      const np = s.obj.getPath(); ['set_at','insert_at','remove_at'].forEach(ev=> np.addListener(ev, ()=> list()));
    });
    list();
    endSplit(changed ? 'Split done. Kept the side with the cross; drag any dots to tidy up.' : 'That line did not cross anything. Try again across the outline.', changed ? '' : 'w');
  }

  function stopDraw(){
    if(!drawing) return;
    const min = drawing.type==='line' ? 2 : 3;
    if(drawing.obj.getPath().getLength() < min) removeShape(drawing.id);
    drawing = null; el('mDraw').textContent = 'Draw by hand'; el('mDraw').classList.remove('pri');
    if(gmap) gmap.setOptions({draggableCursor:null}); status('');
  }
  function addPoint(ll){ drawing.obj.getPath().push(ll); list(); }

  function list(){
    const box = el('mList');
    const mine = shapes.filter(s=>s.kind===kind);
    let html = '';
    if(suggestions){
      const bits = [];
      if(kind==='patio' && suggestions.surface && suggestions.surface!=='unknown') bits.push(`surface: <b>${esc(SURF_NAME(suggestions.surface))}</b>`);
      if(kind==='patio' && suggestions.soiling && suggestions.soiling!=='unknown') bits.push(`soiling: <b>${esc(suggestions.soiling)}</b>`);
      if(kind==='roof' && suggestions.roof_covering && suggestions.roof_covering!=='unknown') bits.push(`covering: <b>${esc(suggestions.roof_covering)}</b>`);
      if(kind==='roof' && suggestions.moss && suggestions.moss!=='unknown') bits.push(`moss: <b>${esc(suggestions.moss)}</b>`);
      if(bits.length || lastNotes) html += `<div class="m-ai"><span class="tag">AI</span> ${bits.join(' · ')}${lastNotes?`<div class="hint">${esc(lastNotes)}</div>`:''}</div>`;
    }
    html += mine.length ? mine.map(s=>{
      const v = shownValue(s);
      return `<div class="m-row" data-sid="${s.id}">
        <span class="m-sw" style="background:${COLORS[s.source]}"></span>
        <input class="m-label" data-sid="${s.id}" value="${esc(s.label)}" aria-label="Name">
        <div class="m-val"><b>${v.txt}</b>${v.sub?`<small>${v.sub}</small>`:''}</div>
        ${s.kind==='roof' ? `<select class="m-pitch" data-sid="${s.id}" aria-label="Roof pitch">${PITCH.map(p=>`<option value="${p.v}" ${p.v===s.pitch?'selected':''}>${p.label}</option>`).join('')}</select>` : '<span></span>'}
        <button class="btn sm" type="button" data-mdel="${s.id}">Delete</button>
      </div>`;
    }).join('') : `<p class="hint">Nothing measured yet. ${kind==='patio' ? 'Put the cross on the drive or patio you want measured' : 'Put the cross on the customer\'s house'}, then press <b>AI outline</b> or <b>Draw by hand</b>.</p>`;
    const tot = mine.reduce((t,s)=>t+shownValue(s).n,0);
    if(mine.length) html += `<div class="m-total">Total <b>${kind==='gutters' ? tot.toFixed(1)+' m' : tot.toFixed(1)+' m²'}</b></div>`;
    box.innerHTML = html;
    el('mUse').disabled = !mine.some(s=>shownValue(s).n>0);
    el('mUse').textContent = useLabel();
  }
  const SURF_NAME = k => ({block:'Block paving',concrete:'Concrete',tarmac:'Tarmac',stone:'Natural stone',imprint:'Imprinted concrete',porcelain:'Porcelain',deck:'Decking',gravel:'Gravel',mixed:'Mixed'})[k] || k;
  function useLabel(){
    if(kind==='patio') return target && target.startsWith('pw:') ? 'Use for this area' : 'Add to pressure washing';
    if(kind==='roof') return 'Use for roof cleaning';
    return 'Use for gutters';
  }

  async function aiOutline(){
    stopDraw();
    const btn = el('mAi'); btn.disabled = true; btn.textContent = 'Measuring…';
    status(kind==='patio' ? 'Asking AI to outline the drive or patio under the cross. This takes 10–30 seconds.' : 'Asking AI to outline the ' + KIND_LABEL[kind].toLowerCase() + ' of the ' + el('mProp').selectedOptions[0].text.toLowerCase() + ' property under the cross. This takes 10–30 seconds.', '');
    try{
      if(!navigator.onLine) throw new Error('You need a connection for AI outlines.');
      const c = gmap.getCenter();
      const {data, error} = await sb.functions.invoke((window.PURGO_CONFIG||{}).measureFunction || 'measure', {body:{lat:c.lat(), lng:c.lng(), zoom:gmap.getZoom(), kind, property:el('mProp').value}});
      if(error){ let msg = error.message; try{ const b = await error.context.json(); if(b && b.error) msg = b.error; }catch(e){} throw new Error(msg); }
      if(data.error) throw new Error(data.error);
      if(kind!=='patio') shapes.filter(s=>s.kind===kind && s.source==='ai').forEach(s=>removeShape(s.id));
      (data.shapes||[]).forEach(sh=> addShape({label:sh.label, type: kind==='gutters' ? 'line' : sh.type, path: sh.points.map(p=>({lat:p[0], lng:p[1]})), source:'ai', pitch: kind==='roof' ? guessPitch(data.suggestions) : null}));
      suggestions = data.suggestions || null; lastNotes = data.notes || '';
      if(!(data.shapes||[]).length) status('The AI could not find it. Move the map so the property is under the cross, zoom in, and try again, or draw it by hand.', 'w');
      else status(`AI outline added (${data.confidence||'unknown'} confidence). Drag the white dots to correct it.${kind==='patio' ? ' To add another area, move the cross onto it and press AI outline again.' : ''}`, data.confidence==='low' ? 'w' : '');
      list();
    }catch(e){ status('AI outline failed: ' + (e.message||e), 'b'); }
    btn.disabled = false; btn.textContent = 'AI outline';
  }
  function guessPitch(s){ const c = s && s.roof_covering; return c==='flat' ? 'flat' : c==='slate' ? 'steep' : 'std'; }

  async function find(){
    const q = el('mAddr').value.trim();
    if(!q) return;
    try{
      await ensureMap();
      const {results} = await geocoder.geocode({address:q, region:'gb'});
      if(!results || !results.length) throw new Error('Address not found');
      gmap.setCenter(results[0].geometry.location); gmap.setZoom(20);
      status('Drag the map so the property sits under the cross, then measure.', '');
    }catch(e){ status('Could not find that address: ' + (e.message||e) + '. Drag the map to it instead.', 'w'); }
  }

  function setKind(k){
    stopDraw(); kind = k;
    document.querySelectorAll('#mKind button').forEach(b=>b.classList.toggle('on', b.dataset.k===k));
    shapes.forEach(s=>{ const on = s.kind===k; s.obj.setOptions({strokeOpacity: on?1:.35, fillOpacity: on ? .28 : .08, editable:on, clickable:on}); });
    list();
  }

  function useInQuote(){
    stopDraw();
    const mine = shapes.filter(s=>s.kind===kind && shownValue(s).n>0);
    if(!mine.length) return;
    const tot = mine.reduce((t,s)=>t+shownValue(s).n,0);
    if(kind==='patio'){
      const surf = suggestions && ['block','concrete','tarmac','stone','imprint','porcelain','deck'].includes(suggestions.surface) ? suggestions.surface : null;
      const soil = suggestions && ['light','normal','heavy'].includes(suggestions.soiling) ? suggestions.soiling : null;
      if(target && target.startsWith('pw:')){
        const r = pwRows[+target.slice(3)]; if(r){ r.sqm = Math.round(tot); if(surf){ r.surf = surf; if(surf==='block') r.sand = true; } if(soil) r.soil = soil; }
      } else {
        pwRows = pwRows.filter(r=>+r.sqm>0);
        mine.forEach(s=>{ const sur = surf || 'block'; pwRows.push({name:s.label, surf:sur, sqm:Math.round(shownValue(s).n), soil:soil||'normal', sand:sur==='block', chem:''}); });
      }
      $('on-pw').checked = true; renderPw();
    } else if(kind==='roof'){
      $('rfA').value = Math.round(tot);
      const p = pitchOf(mine[0]); $('rfP').value = p.rf;
      if(suggestions && ['concrete','clay','slate','flat','other'].includes(suggestions.roof_covering)) $('rfT').value = suggestions.roof_covering;
      if(suggestions && ['light','moderate','heavy'].includes(suggestions.moss)) $('rfMoss').value = suggestions.moss;
      $('on-rf').checked = true;
    } else {
      $('gtM').value = Math.round(tot);
      $('on-gt').checked = true;
    }
    syncSvc(); show('quote'); render();
    flash(`Added ${kind==='gutters' ? Math.round(tot)+' m of gutter' : Math.round(tot)+' m²'} from the measurement`);
  }

  // saved with the quote so anyone can see what was measured
  function snapshot(){
    if(!gmap) return MEASURE._pending || [];
    return shapes.filter(s=>s.obj.getPath().getLength()).map(s=>({label:s.label, type:s.type, kind:s.kind, source:s.source, pitch:s.pitch,
      points:s.obj.getPath().getArray().map(ll=>[+ll.lat().toFixed(7), +ll.lng().toFixed(7)]), value:+shownValue(s).n.toFixed(1)}));
  }
  function restore(list){
    clearAll(); MEASURE._pending = list || [];
    if(!gmap || !list) return;
    list.forEach(x=>{ const k = kind; kind = x.kind; addShape({label:x.label, type:x.type, path:x.points.map(p=>({lat:p[0],lng:p[1]})), source:x.source, pitch:x.pitch}); kind = k; });
    MEASURE._pending = null; setKind(kind);
  }

  async function open(tgt){
    target = tgt || null;
    show('measure');
    const wt = $('wnType') && $('wnType').value; if(wt && !el('mProp').dataset.touched) el('mProp').value = wt==='D' ? 'detached' : wt==='T' ? 'mid' : 'semi';
    if(ctype==='com' && !el('mProp').dataset.touched) el('mProp').value = 'commercial';
    const k = !tgt ? kind : tgt.startsWith('pw') ? 'patio' : tgt==='rf' ? 'roof' : 'gutters';
    status('');
    try{
      await ensureMap();
      if(MEASURE._pending && MEASURE._pending.length) restore(MEASURE._pending);
      setKind(k);
      const addr = [$('addr').value.trim(), fmtPc($('pc').value)].filter(Boolean).join(', ');
      if(addr && el('mAddr').value !== addr){ el('mAddr').value = addr; await find(); }
      else if(!shapes.length && typeof loc!=='undefined' && loc){ gmap.setCenter({lat:loc.lat, lng:loc.lng}); gmap.setZoom(19); }
      google.maps.event.trigger(gmap, 'resize');
    }catch(e){ status(e.message||String(e), 'b'); }
  }

  function bind(){
    el('mFind').onclick = find;
    el('mProp').addEventListener('change', ()=>{ el('mProp').dataset.touched = '1'; });
    el('mAddr').addEventListener('keydown', e=>{ if(e.key==='Enter'){ e.preventDefault(); find(); } });
    document.querySelectorAll('#mKind button').forEach(b=> b.onclick = ()=> setKind(b.dataset.k));
    el('mAi').onclick = ()=> gmap && aiOutline();
    el('mDraw').onclick = ()=>{ if(!gmap) return; drawing ? stopDraw() : startDraw(); };
    el('mDelPts').onclick = ()=>{ delMode = !delMode; el('mDelPts').classList.toggle('pri', delMode); el('mDelPts').textContent = delMode ? 'Done deleting' : 'Delete points'; status(delMode ? 'Tap a corner dot to remove it.' : ''); };
    el('mClear').onclick = ()=>{ if(splitPts) endSplit(); shapes.filter(s=>s.kind===kind).forEach(s=>removeShape(s.id)); stopDraw(); };
    el('mSplit').onclick = ()=>{ if(!gmap) return; splitPts ? endSplit() : startSplit(); };
    el('mUse').onclick = useInQuote;
    el('mBack').onclick = ()=>{ stopDraw(); show('quote'); };
    el('mList').addEventListener('input', e=>{ const id = +e.target.dataset.sid; const s = shapes.find(x=>x.id===id); if(!s) return;
      if(e.target.classList.contains('m-label')) s.label = e.target.value;
      if(e.target.classList.contains('m-pitch')){ s.pitch = e.target.value; list(); } });
    el('mList').addEventListener('click', e=>{ const d = e.target.dataset && e.target.dataset.mdel; if(d) removeShape(+d); });
    document.addEventListener('click', e=>{ const b = e.target.closest && e.target.closest('[data-measure]'); if(b){ e.preventDefault(); open(b.dataset.measure); } });
  }
  bind();
  return {open, snapshot, restore, _pending:null};
})();
