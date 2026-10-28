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

/* =====================================================================
   Photo measuring (dev): the paving is the ruler.
   A reference rectangle of known size on the ground gives a perspective
   transform (homography) from photo pixels to metres on the ground.
   ===================================================================== */
const PHOTO = (()=>{
  const el = id => document.getElementById(id);
  const MAXPX = 1568;
  let W = 0, H = 0, b64 = null;
  let outline = [], ref = [], mode = null, sugg = null, drag = null, check = null, useCount = false;

  // ---- maths ----
  function solve(A, b){ // Gaussian elimination, n x n
    const n = b.length; const M = A.map((r,i)=>[...r, b[i]]);
    for(let c=0;c<n;c++){
      let p = c; for(let r=c+1;r<n;r++) if(Math.abs(M[r][c])>Math.abs(M[p][c])) p = r;
      if(Math.abs(M[p][c]) < 1e-12) return null;
      [M[c], M[p]] = [M[p], M[c]];
      for(let r=0;r<n;r++){ if(r===c) continue; const f = M[r][c]/M[c][c]; for(let k=c;k<=n;k++) M[r][k] -= f*M[c][k]; }
    }
    return M.map((r,i)=>r[n]/r[i]);
  }
  function homography(src, dst){
    const A = [], b = [];
    for(let i=0;i<4;i++){ const [x,y] = src[i], [u,v] = dst[i];
      A.push([x,y,1,0,0,0,-u*x,-u*y]); b.push(u);
      A.push([0,0,0,x,y,1,-v*x,-v*y]); b.push(v); }
    const h = solve(A, b); return h ? [...h, 1] : null;
  }
  const apply = (h, [x,y]) => { const d = h[6]*x + h[7]*y + 1; return {p:[(h[0]*x + h[1]*y + h[2])/d, (h[3]*x + h[4]*y + h[5])/d], d}; };
  const shoelace = pts => { let s = 0; for(let i=0;i<pts.length;i++){ const [x1,y1] = pts[i], [x2,y2] = pts[(i+1)%pts.length]; s += x1*y2 - x2*y1; } return Math.abs(s)/2; };
  function measure(){
    if(outline.length < 3) return {err:'Outline the drive or patio first.'};
    if(ref.length < 4) return {err:'Mark the four corners of the reference (yellow box).'};
    const {L:Lmm, W:Wmm} = refSize(), L = Lmm/1000, Wd = Wmm/1000;
    if(!(L>0 && Wd>0)) return {err:'Enter how many blocks or slabs the yellow box covers along each side, and their size.'};
    const h = homography(ref, [[0,0],[L,0],[L,Wd],[0,Wd]]);
    if(!h) return {err:'The reference corners are in a straight line. Move them to the four corners of the box.'};
    const s0 = Math.sign(apply(h, ref[0]).d);
    const mapped = outline.map(q=>apply(h,q));
    if(mapped.some(m=>Math.sign(m.d)!==s0)) return {err:'Part of the outline is above the horizon for this reference. Check the yellow corners are on the ground and in order.'};
    const area = shoelace(mapped.map(m=>m.p));
    const refPx = shoelace(ref), outPx = shoelace(outline);
    return {area, refShare: refPx/Math.max(1,outPx)};
  }
  // exposed for testing
  window.__photoMath = {homography, apply, shoelace};

  // ---- drawing ----
  const r = () => Math.max(W,H)/110;
  function draw(){
    const svg = el('pSvg'); if(!W) return;
    svg.setAttribute('viewBox', `0 0 ${W} ${H}`);
    const R = r(), sw = R/2.4;
    let s = '';
    if(outline.length){
      const pts = outline.map(p=>p.join(',')).join(' ');
      s += outline.length>=3 ? `<polygon points="${pts}" fill="rgba(109,167,196,.32)" stroke="#6da7c4" stroke-width="${sw}"/>` : `<polyline points="${pts}" fill="none" stroke="#6da7c4" stroke-width="${sw}"/>`;
      if(outline.length>=3) outline.forEach((p,i)=>{ const q = outline[(i+1)%outline.length]; s += `<circle class="mid" data-mid="${i}" cx="${(p[0]+q[0])/2}" cy="${(p[1]+q[1])/2}" r="${R*0.7}" fill="rgba(255,255,255,.55)" stroke="#132f47" stroke-width="${sw/2}"/>`; });
      outline.forEach((p,i)=>{ s += `<circle class="pt" data-o="${i}" cx="${p[0]}" cy="${p[1]}" r="${R}" fill="#fff" stroke="#132f47" stroke-width="${sw/1.5}"/>`; });
    }
    if(ref.length){
      const pts = ref.map(p=>p.join(',')).join(' ');
      s += ref.length===4 ? `<polygon points="${pts}" fill="rgba(242,193,78,.25)" stroke="#f2c14e" stroke-width="${sw}"/>` : `<polyline points="${pts}" fill="none" stroke="#f2c14e" stroke-width="${sw}"/>`;
      ref.forEach((p,i)=>{ s += `<g class="pt" data-r="${i}"><circle cx="${p[0]}" cy="${p[1]}" r="${R*1.1}" fill="#f2c14e" stroke="#132f47" stroke-width="${sw/1.5}"/><text x="${p[0]}" y="${p[1]+R*0.45}" text-anchor="middle" font-size="${R*1.25}" font-weight="800" fill="#132f47" pointer-events="none">${i+1}</text></g>`; });
    }
    svg.innerHTML = s;
    result();
  }
  // the yellow box's real size = how many blocks/slabs along each side x their size
  function refSize(){
    const n1 = +el('pN1').value, u1 = +el('pU1').value, n2 = +el('pN2').value, u2 = +el('pU2').value;
    return {L: n1*u1, W: n2*u2, n1, u1, n2, u2};
  }
  const fmtM = mm => mm >= 1000 ? (mm/1000).toFixed(2).replace(/\.?0+$/,'') + ' m' : Math.round(mm) + ' mm';
  function showRefSize(){
    const r = refSize();
    el('pRefSize').innerHTML = r.L>0 && r.W>0 ? `Yellow box = <b>${fmtM(r.L)} × ${fmtM(r.W)}</b> (${r.n1} × ${r.u1} mm by ${r.n2} × ${r.u2} mm)` : '';
  }
  // the area the quote will use: the photo measurement, or the AI's block count if chosen
  function finalArea(){
    const m = measure();
    if(useCount && check) return {area: check.area_m2, from:'count'};
    return m.err ? null : {area: m.area, from:'photo'};
  }
  function result(){
    showRefSize();
    const m = measure(), box = el('pResult');
    let html = '';
    if(m.err) html = `<small>${esc(m.err)}</small>`;
    else {
      const small = m.refShare < 0.02;
      html = `<span class="big"${useCount&&check?' style="opacity:.45"':''}>${m.area.toFixed(1)} m²</span><small>Measured from the photo using the yellow box.</small>`;
      if(small) html += '<br><small><b>The yellow box is small compared with the area</b>, so a slip on its corners or one block miscounted makes a big difference. Stretch it over more blocks and update the counts.</small>';
    }
    if(check){
      const diff = m.err ? 0 : Math.abs(m.area - check.area_m2) / Math.max(m.area, check.area_m2);
      html += `<div class="p-check${!m.err && diff>0.25?' bad':''}"><b>Block count check: about ${check.area_m2.toFixed(1)} m²</b>`
        + (check.length_m && check.width_m ? ` (roughly ${check.length_m.toFixed(1)} × ${check.width_m.toFixed(1)} m)` : '')
        + (check.how ? `<br><small>${esc(check.how)}</small>` : '')
        + (!m.err && diff>0.25 ? `<br><small><b>The two figures disagree by ${Math.round(diff*100)}%.</b> Check the yellow box covers exactly the number of blocks entered, or use the count.</small>` : '')
        + `<label class="p-usecount"><input type="checkbox" id="pUseCount"${useCount?' checked':''}> Use the block count instead</label></div>`;
    }
    box.innerHTML = html;
    const cb = el('pUseCount'); if(cb) cb.onchange = ()=>{ useCount = cb.checked; result(); };
    el('pUse').disabled = !finalArea();
  }
  const status = (t, cls) => { const s = el('pStatus'); s.textContent = t||''; s.className = 'note ' + (cls||''); s.hidden = !t; };

  // ---- pointer handling ----
  function svgPoint(evt){
    const svg = el('pSvg'); const pt = svg.createSVGPoint(); pt.x = evt.clientX; pt.y = evt.clientY;
    const p = pt.matrixTransform(svg.getScreenCTM().inverse());
    return [Math.min(W, Math.max(0, p.x)), Math.min(H, Math.max(0, p.y))];
  }
  function onDown(e){
    const t = e.target.closest('[data-o],[data-r],[data-mid]');
    if(t && mode==='del'){
      if(t.dataset.o!=null && outline.length>3){ outline.splice(+t.dataset.o,1); draw(); }
      else if(t.dataset.o!=null) status('An outline needs at least 3 points. Use Clear to start again.', 'w');
      return;
    }
    if(t && t.dataset.mid!=null){ const i = +t.dataset.mid; outline.splice(i+1, 0, svgPoint(e)); drag = {arr:outline, i:i+1}; }
    else if(t && t.dataset.o!=null) drag = {arr:outline, i:+t.dataset.o};
    else if(t && t.dataset.r!=null) drag = {arr:ref, i:+t.dataset.r};
    else if(mode==='draw'){ outline.push(svgPoint(e)); draw(); return; }
    else if(mode==='ref'){ ref.push(svgPoint(e)); if(ref.length===4){ setMode(null); status('Reference marked. Drag the numbered corners onto the joints if needed.'); } draw(); return; }
    if(drag){ e.preventDefault(); el('pSvg').setPointerCapture(e.pointerId); draw(); }
  }
  function onMove(e){ if(!drag) return; e.preventDefault(); drag.arr[drag.i] = svgPoint(e); draw(); }
  function onUp(){ drag = null; }

  function setMode(m){
    mode = m;
    el('pDraw').classList.toggle('pri', m==='draw'); el('pDraw').textContent = m==='draw' ? 'Finish outline' : 'Draw by hand';
    el('pRef').classList.toggle('pri', m==='ref');
    el('pDel').classList.toggle('pri', m==='del'); el('pDel').textContent = m==='del' ? 'Done deleting' : 'Delete points';
  }

  // ---- loading a photo ----
  function load(file){
    if(!file) return;
    const fr = new FileReader();
    fr.onload = ()=>{
      const img = new Image();
      img.onload = ()=>{
        const k = Math.min(1, MAXPX/Math.max(img.width, img.height));
        W = Math.round(img.width*k); H = Math.round(img.height*k);
        const c = document.createElement('canvas'); c.width = W; c.height = H;
        c.getContext('2d').drawImage(img, 0, 0, W, H);
        const url = c.toDataURL('image/jpeg', 0.85); b64 = url.split(',')[1];
        el('pImg').src = url; el('pImg').hidden = false; el('pSvg').removeAttribute('hidden'); el('pEmpty').hidden = true;
        outline = []; ref = []; sugg = null; check = null; useCount = false; el('pAiNote').innerHTML = ''; setMode(null);
        ['pAi','pDraw','pRef','pDel','pClear'].forEach(id=> el(id).disabled = false);
        draw(); status('Press AI outline, or draw the area and mark a reference yourself.');
      };
      img.src = fr.result;
    };
    fr.readAsDataURL(file);
  }

  function setRefSize(r){
    const n1 = Math.max(1, Math.round(r.count_12 || 1)), n2 = Math.max(1, Math.round(r.count_23 || 1));
    const u1 = r.unit_12_mm || (r.length_mm/n1), u2 = r.unit_23_mm || (r.width_mm/n2);
    el('pN1').value = n1; el('pU1').value = Math.round(u1); el('pN2').value = n2; el('pU2').value = Math.round(u2);
    const key = r.unit_mm && r.unit_mm.length===2 ? `${Math.round(Math.max(...r.unit_mm))}x${Math.round(Math.min(...r.unit_mm))}` : '';
    const opt = key && [...el('pRefType').options].find(o=>o.value===key);
    el('pRefType').value = opt ? key : (u1 % 100 === 0 && u2 % 100 === 0 && Math.max(u1,u2) <= 200 ? '200x100' : 'custom');
  }

  async function ai(){
    if(!b64) return;
    setMode(null);
    const btn = el('pAi'); btn.disabled = true; btn.textContent = 'Measuring…';
    status('Asking AI to outline the area and find a reference. This takes 10–30 seconds.');
    try{
      if(!navigator.onLine) throw new Error('You need a connection for AI outlines.');
      const {data, error} = await sb.functions.invoke((window.PURGO_CONFIG||{}).measureFunction || 'measure', {body:{kind:'photo', image:b64, mediaType:'image/jpeg', w:W, h:H, hint:el('pHint').value.trim()}});
      if(error){ let msg = error.message; try{ const b = await error.context.json(); if(b && b.error) msg = b.error; }catch(e){} throw new Error(msg); }
      if(data.error) throw new Error(data.error);
      if(data.outline && data.outline.length>=3) outline = data.outline;
      if(data.reference){ ref = data.reference.corners; setRefSize(data.reference); }
      check = data.count_check && data.count_check.area_m2 > 0 ? data.count_check : null; useCount = !data.reference && !!check;
      if(data.label) el('pLabel').value = data.label;
      sugg = data.suggestions || null;
      const bits = [];
      if(sugg){ const nm = {block:'Block paving',concrete:'Concrete',tarmac:'Tarmac',stone:'Natural stone',imprint:'Imprinted concrete',porcelain:'Porcelain',deck:'Decking',gravel:'Gravel',mixed:'Mixed'};
        if(sugg.surface && sugg.surface!=='unknown') bits.push(`surface: <b>${esc(nm[sugg.surface]||sugg.surface)}</b>`);
        ['soiling','moss','weeds'].forEach(k=>{ if(sugg[k] && sugg[k]!=='unknown') bits.push(`${k}: <b>${esc(sugg[k])}</b>`); }); }
      if(data.reference && data.reference.what) bits.push(`yellow box: <b>${esc(data.reference.what)}</b>`);
      el('pAiNote').innerHTML = (bits.length || data.notes) ? `<div class="m-ai"><span class="tag">AI</span> ${bits.join(' · ')}${data.notes?`<div class="hint">${esc(data.notes)}</div>`:''}</div>` : '';
      draw();
      if(!data.reference) status('AI outlined the area but could not find a reliable reference. Press Mark reference, tap the 4 corners of a run of blocks or slabs, and enter how many along each side.', 'w');
      else status(`Done (${data.confidence||'unknown'} confidence). Check the yellow corners sit exactly on the joints and the blue outline follows the edges.`, data.confidence==='low' ? 'w' : '');
    }catch(e){ status('AI outline failed: ' + (e.message||e), 'b'); }
    btn.disabled = false; btn.textContent = 'AI outline';
  }

  function use(){
    const m = finalArea(); if(!m) return;
    const surf = sugg && ['block','concrete','tarmac','stone','imprint','porcelain','deck'].includes(sugg.surface) ? sugg.surface : 'block';
    const soil = sugg && ['light','normal','heavy'].includes(sugg.soiling) ? sugg.soiling : 'normal';
    pwRows = pwRows.filter(r=>+r.sqm>0);
    pwRows.push({name: el('pLabel').value.trim() || 'Driveway', surf, sqm: Math.round(m.area), soil, sand: surf==='block', chem:''});
    if(sugg && sugg.weeds==='heavy' && $('cx_weeds')) $('cx_weeds').checked = true;
    $('on-pw').checked = true; renderPw(); syncSvc(); show('quote'); render();
    flash(`Added ${Math.round(m.area)} m² from the photo`);
  }

  function bind(){
    el('pCam').addEventListener('change', e=> load(e.target.files[0]));
    el('pFile').addEventListener('change', e=> load(e.target.files[0]));
    const svg = el('pSvg');
    svg.addEventListener('pointerdown', onDown); svg.addEventListener('pointermove', onMove);
    svg.addEventListener('pointerup', onUp); svg.addEventListener('pointercancel', onUp);
    el('pAi').onclick = ai;
    el('pDraw').onclick = ()=>{ if(mode==='draw'){ setMode(null); status(''); } else { outline = []; setMode('draw'); draw(); status('Tap each corner of the area in turn, then press Finish outline.'); } };
    el('pRef').onclick = ()=>{ ref = []; setMode('ref'); draw(); status('Tap the 4 corners of the reference in order around it. Cover as many whole blocks or slabs as you can, then enter how many along each side.'); };
    el('pDel').onclick = ()=>{ setMode(mode==='del' ? null : 'del'); status(mode==='del' ? 'Tap a white dot to remove it.' : ''); };
    el('pClear').onclick = ()=>{ outline = []; ref = []; check = null; useCount = false; setMode(null); draw(); status(''); };
    el('pRefType').addEventListener('change', ()=>{ const v = el('pRefType').value; if(v!=='custom'){ const [a,b] = v.split('x'); el('pU1').value = a; el('pU2').value = b; } draw(); });
    ['pN1','pN2'].forEach(id=> el(id).addEventListener('input', result));
    ['pU1','pU2'].forEach(id=> el(id).addEventListener('input', ()=>{ el('pRefType').value = 'custom'; result(); }));
    el('pSwap').onclick = ()=>{ const n = el('pN1').value, u = el('pU1').value; el('pN1').value = el('pN2').value; el('pU1').value = el('pU2').value; el('pN2').value = n; el('pU2').value = u; result(); };
    el('pUse').onclick = use;
    document.querySelectorAll('#mSrc button').forEach(b=> b.onclick = ()=>{
      const photo = b.dataset.s==='photo';
      document.querySelectorAll('#mSrc button').forEach(x=>x.classList.toggle('on', x===b));
      el('mMapMode').hidden = photo; el('mPhotoMode').hidden = !photo; el('mUse').hidden = photo;
      document.querySelector('#view-measure .sub').textContent = photo ? 'Take or choose a photo of the drive or patio, then press AI outline. Check the yellow reference corners sit on the joints and the blue outline follows the edges.' : "Put the cross on the customer's house, choose the property type, then press AI outline. Drag the dots to correct it; the figures update as you go.";
    });
  }
  bind();
  return {measure};
})();
