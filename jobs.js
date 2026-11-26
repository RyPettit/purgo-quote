/* =====================================================================
   Purgō Jobs: the work we do for customers, window cleaning rounds and
   the diary.
   - A job is a service at a customer's address: a regular clean every N
     weeks, or a one-off. Each job knows when it's next due.
   - A round is a list of window cleaning jobs done in order on one day,
     every N weeks.
   - A visit is a booking of a job on a date in someone's calendar
     (Jamie's by default). Marking it done moves the job's next due date on.
   Visits are copied to Google Calendar (a calendar each for Jamie, Ryan and
   Benna) by the mail server function.
   Uses from purgo.js: $, esc, gbp, sb, ME, ROLE, show, flash, isNetErr, confirmInline, fmtPc
   ===================================================================== */
const JOBS = (()=>{
  const SVC = {windows:'Window cleaning', gutters:'Gutter clean', roof:'Roof clean', pressure:'Pressure washing', other:'Other'};
  const SVC_SHORT = {windows:'Windows', gutters:'Gutters', roof:'Roof', pressure:'Pressure wash', other:'Other'};
  const VST = {booked:'Booked', done:'Done', skipped:'Skipped', cancelled:'Cancelled'};
  const FREQS = [1,2,3,4,5,6,8,10,12,13,16,26,52];
  const GAP = 10;   // minutes allowed between jobs when a postcode can't be found
  // Drive time between two jobs, estimated from their postcodes (the Portal's built-in postcode list,
  // the road factor and average speed from Admin → rates) plus a few minutes to park and unload.
  function drive(a, b){
    const pa = normPc((a && a.postcode) || ''), pb = normPc((b && b.postcode) || '');
    if(pa && pa===pb) return {min:2, mi:0};
    const la = pa && typeof lookupPc==='function' ? lookupPc(pa) : null, lb = pb && typeof lookupPc==='function' ? lookupPc(pb) : null;
    if(!la || !lb) return {min:GAP, mi:null};
    const mi = haversine(la.lat, la.lng, lb.lat, lb.lng) * ((typeof R!=='undefined' && R.roadFactor) || 1.3);
    const mph = (typeof R!=='undefined' && R.avgMph) || 28;
    return {min: Math.max(5, Math.ceil((mi/mph*60 + 3)/5)*5), mi: Math.round(mi*10)/10};
  }
  const driveTxt = d => d.mi===null ? `${d.min} min allowed (postcode not found)` : d.mi===0 ? 'Same postcode' : `≈ ${d.min} min drive · ${d.mi} mi`;
  const root = () => $('view-jobs');

  /* ---------- dates ---------- */
  const pad = n => String(n).padStart(2,'0');
  const ymd = d => `${d.getFullYear()}-${pad(d.getMonth()+1)}-${pad(d.getDate())}`;
  const pd = s => { const [y,m,d] = String(s).split('-').map(Number); return new Date(y, m-1, d); };
  const addDays = (s, n) => { const d = pd(s); d.setDate(d.getDate()+n); return ymd(d); };
  const today = () => ymd(new Date());
  const monday = s => { const d = pd(s); const k = (d.getDay()+6)%7; d.setDate(d.getDate()-k); return ymd(d); };
  const fmtDay = s => s ? pd(s).toLocaleDateString('en-GB', {weekday:'short', day:'numeric', month:'short'}) : '';
  const fmtDate = s => s ? pd(s).toLocaleDateString('en-GB', {day:'numeric', month:'short', year:'numeric'}) : '';
  const hm = t => t ? String(t).slice(0,5) : '';
  const addMin = (t, m) => { const [h, mi] = t.split(':').map(Number); const x = Math.min(h*60+mi+m, 23*60+59); return `${pad(Math.floor(x/60))}:${pad(x%60)}`; };
  const up5 = t => { const [h,m] = t.split(':').map(Number); const x = Math.min(Math.ceil((h*60+m)/5)*5, 23*60+55); return `${pad(Math.floor(x/60))}:${pad(x%60)}`; };
  const daysBetween = (a, b) => Math.round((pd(b)-pd(a))/864e5);
  const freqLabel = (f, m) => m ? 'Monthly' : f ? (f===1 ? 'Every week' : `Every ${f} weeks`) : 'One-off';
  const freqVal = x => x.monthly ? 'm' : (x.frequency_weeks || '');
  const readFreq = v => v==='m' ? {monthly:true, frequency_weeks:null} : {monthly:false, frequency_weeks:+v||null};
  function dueText(j){
    if(!j.next_due) return j.status==='ended' ? 'Finished' : 'Any time';
    const d = daysBetween(today(), j.next_due);
    return d < 0 ? `${-d} day${d===-1?'':'s'} overdue` : d===0 ? 'Due today' : `Due ${fmtDate(j.next_due)}`;
  }

  /* ---------- data ---------- */
  let cals = [], rounds = [], jobs = [], roundDates = [], booked = new Map(), loaded = false, err = '';
  let sub = 'week', week = monday(today()), calF = '', q = '', showEnded = false, horizon = 14;
  let visits = [], openRound = null, roundForm = false, sel = new Set(), moving = null, addDay = null, addLast = null;

  async function loadBase(){
    const [c, r, j, b, rd] = await Promise.all([
      sb.from('staff_calendars').select('*').eq('active', true).order('sort'),
      sb.from('rounds').select('*').order('sort').order('name'),
      sb.from('jobs').select('*,accounts(id,name,account_no,phone)').order('created_at').limit(10000),
      sb.from('visits').select('job_id,date').eq('status','booked').gte('date', today()).limit(10000),
      sb.from('round_dates').select('*').gte('date', today()).order('date').limit(5000)
    ]);
    for(const x of [c,r,j,b,rd]) if(x.error) throw x.error;
    cals = c.data; rounds = r.data; jobs = j.data; roundDates = rd.data;
    booked = new Map(); b.data.forEach(v=>{ const e = booked.get(v.job_id); if(!e || v.date < e) booked.set(v.job_id, v.date); });
    loaded = true; err = '';
  }
  async function loadWeek(){
    const {data, error} = await sb.from('visits').select('*,jobs(id,job_no,service,title,line,postcode,price,round_id,notes),accounts(id,name,phone,account_no)')
      .gte('date', week).lte('date', addDays(week, 6)).neq('status','cancelled').order('date').order('start_time', {nullsFirst:false}).limit(2000);
    if(error) throw error;
    visits = data;
  }
  const calById = id => cals.find(c=>c.id===id);
  const defCal = () => cals.find(c=>c.is_default) || cals[0];
  const calName = id => (calById(id)||{}).name || '';
  const calDot = id => { const c = calById(id); return c ? `<i class="jb-dot" style="background:${esc(c.colour||'#888')}" title="${esc(c.name)}"></i>` : ''; };
  const calOpts = (id, blank) => (blank ? `<option value="">${esc(blank)}</option>` : '') + cals.map(c=>`<option value="${c.id}" ${c.id===id?'selected':''}>${esc(c.name)}${c.is_default?' (default)':''}</option>`).join('');
  const roundOpts = id => `<option value="">Not on a round</option>` + rounds.filter(r=>r.active || r.id===id).map(r=>`<option value="${r.id}" ${r.id===id?'selected':''}>${esc(r.name)}</option>`).join('');
  const freqOpts = (x, noOne) => { const v = String(freqVal(x)), f = x.frequency_weeks;
    return (noOne ? '' : `<option value="" ${v===''?'selected':''}>One-off (ad hoc)</option>`) + `<option value="m" ${v==='m'?'selected':''}>Monthly</option>` +
      [...new Set([...FREQS, ...(f?[f]:[])])].sort((a,b)=>a-b).map(n=>`<option value="${n}" ${v===String(n)?'selected':''}>${freqLabel(n)}</option>`).join(''); };
  const where = j => [j.line, j.postcode].filter(Boolean).join(', ');

  // tell the server to copy changed bookings to Google Calendar (quietly; the server also does it every couple of minutes)
  let kickT = null;
  function kick(){ clearTimeout(kickT); kickT = setTimeout(()=>{ if(typeof MAIL!=='undefined' && MAIL.fn) MAIL.fn({action:'calendar_sync'}).catch(()=>{}); }, 1200); }

  // book jobs on a date, one after another from a start time (or all day if no time)
  async function book(list, date, calId, start){
    if(!list.length) return 0;
    let t = start || null;
    const rows = list.map(j=>{
      const r = {job_id:j.id, account_id:j.account_id, date, start_time:t, duration_min:j.duration_min||30, calendar_id:calId || j.calendar_id || (defCal()||{}).id || null, price:j.price, created_by_name:ME.name};
      return r;
    });
    if(t) for(let i=1;i<rows.length;i++) rows[i].start_time = up5(addMin(rows[i-1].start_time, (list[i-1].duration_min||30) + drive(list[i-1], list[i]).min));
    const {error} = await sb.from('visits').insert(rows);
    if(error) throw error;
    kick();
    return rows.length;
  }
  async function setVisit(id, patch){
    const {error} = await sb.from('visits').update(patch).eq('id', id);
    if(error) throw error;
    kick();
  }
  const doneP = () => ({status:'done', done_at:new Date().toISOString(), done_by_name:ME.name});

  /* ---------- the Jobs page ---------- */
  async function onShow(){
    root().innerHTML = `<section class="card"><p class="hint">Loading…</p></section>`;
    try{ await loadBase(); if(!planned){ await planAll(); await loadBase(); } if(sub==='week') await loadWeek(); }
    catch(e){ err = isNetErr(e) ? 'Could not reach the server. Check your connection.' : 'Could not load jobs: ' + (e.message||e); }
    render();
  }
  async function refresh(){ try{ await loadBase(); if(sub==='week') await loadWeek(); }catch(e){ flash('Could not refresh: ' + (e.message||e)); } render(); }

  function render(){
    if(root().hidden) return;
    const due = dueJobs();
    const tabs = [['week','Diary'],['due',`To book (${due.length})`],['rounds',`Rounds (${rounds.filter(r=>r.active).length})`],['all',`All jobs (${jobs.filter(j=>j.status!=='ended').length})`]];
    root().innerHTML = `
      <div class="viewbar"><div><h2 class="vtitle">Jobs</h2><p class="sub">${jobs.filter(j=>j.status==='active').length} active job${jobs.filter(j=>j.status==='active').length===1?'':'s'} · ${due.length} to book in the next ${horizon} days</p></div>
        <div class="vb-actions"><button class="btn" type="button" id="jbRefresh">Refresh</button></div></div>
      ${err ? `<p class="note b">${esc(err)}</p>` : ''}
      <div class="pf-rtabs ac-tabs">${tabs.map(([k,v])=>`<button type="button" data-jtab="${k}" class="${sub===k?'on':''}">${v}</button>`).join('')}</div>
      <div id="jbBody">${({week:viewWeek, due:viewDue, rounds:viewRounds, all:viewAll}[sub])()}</div>`;
    $('jbRefresh').onclick = refresh;
    root().querySelectorAll('[data-jtab]').forEach(b=> b.onclick = async ()=>{ sub = b.dataset.jtab; openRound = null; sel.clear(); moving = null; if(sub==='week'){ try{ await loadWeek(); }catch(e){} } render(); });
    root().querySelectorAll('[data-goacc]').forEach(b=> b.addEventListener('click', ()=> goJobsTab(b.dataset.goacc), true));
    ({week:wireWeek, due:wireDue, rounds:wireRounds, all:wireAll}[sub])();
  }
  function goJobsTab(accId){ try{ sessionStorage.setItem('acTab', JSON.stringify({id:accId, tab:'jobs'})); }catch(e){} }

  /* ---------- Diary (week) ---------- */
  function visitRow(v){
    const j = v.jobs || {}, a = v.accounts || {};
    const isMove = moving===v.id;
    return `<div class="jb-v ${v.status}">
      <div class="jb-t">${v.start_time ? hm(v.start_time) : 'Any time'}</div>
      <div class="m">${calDot(v.calendar_id)}<b><button class="linkbtn" type="button" data-goacc="${a.id}">${esc(a.name||'')}</button></b>${v.round_date_id && !v.detached ? ` <span class="jb-rtag">${esc((rounds.find(r=>r.id===j.round_id)||{}).name||'Round')} round</span>` : ''}
        <small>${esc(SVC_SHORT[j.service]||'')}${j.title?' · '+esc(j.title):''} · ${esc(where(j))}</small>
        ${j.notes ? `<small>Access: ${esc(j.notes)}</small>` : ''}${v.notes ? `<small>Note: ${esc(v.notes)}</small>` : ''}
        ${v.gcal_error ? `<small class="jb-err">Calendar: ${esc(v.gcal_error)}</small>` : ''}</div>
      <div class="v">${gbp(+(v.price ?? j.price) || 0)}${v.status!=='booked' ? `<small class="pill ${v.status==='done'?'accepted':'declined'}">${VST[v.status]}</small>` : ''}</div>
      <div class="qacts">${v.status==='booked' ? `<button class="btn sm pri" type="button" data-vdone="${v.id}">Done</button><button class="btn sm" type="button" data-vmove="${v.id}">Move</button><button class="btn sm" type="button" data-vskip="${v.id}">Skip</button>`
        : `<button class="btn sm" type="button" data-vundo="${v.id}">Undo</button>`}</div>
      ${isMove ? `<div class="fields jb-move wide">
        <label class="f">Date<input type="date" id="mvDate" value="${v.date}"></label>
        <label class="f">Time<input type="time" id="mvTime" value="${hm(v.start_time)}"></label>
        <label class="f">Calendar<select id="mvCal">${calOpts(v.calendar_id)}</select></label>
        <label class="f">Note<input id="mvNote" value="${esc(v.notes||'')}" placeholder="for whoever does it"></label>
        <div class="vb-actions wide"><button class="btn sm del" type="button" id="mvDel">Cancel booking</button><button class="btn sm" type="button" id="mvCancel">Close</button><button class="btn sm pri" type="button" id="mvSave">Save</button></div></div>` : ''}
    </div>`;
  }
  // the day's bookings with the drive between each pair of timed jobs (and a warning if the gap is too short)
  const minsOf = t => { const [h,m] = hm(t).split(':').map(Number); return h*60+m; };
  function dayRows(dv){
    let out = '', prev = null;
    for(const v of dv){
      if(prev && prev.start_time && v.start_time){
        const d = drive(prev.jobs, v.jobs), gap = minsOf(v.start_time) - (minsOf(prev.start_time) + (prev.duration_min||30));
        out += `<div class="jb-drive ${gap < d.min ? 'short' : ''}">🚐 ${esc(driveTxt(d))}${gap < d.min ? ` · only ${Math.max(gap,0)} min between jobs` : ''}</div>`;
      }
      out += visitRow(v); prev = v;
    }
    return out;
  }
  // re-space a day's bookings: same order and first start time, each job's length plus the drive to the next
  async function retimeDay(d){
    const dv = visits.filter(v=>v.date===d && v.start_time && v.status!=='cancelled' && (!calF || v.calendar_id===calF)).sort((a,b)=>a.start_time.localeCompare(b.start_time));
    let changed = 0;
    for(let i=1;i<dv.length;i++){
      const p = dv[i-1], v = dv[i];
      const want = up5(addMin(hm(p.start_time), (p.duration_min||30) + drive(p.jobs, v.jobs).min));
      if(v.status==='booked' && hm(v.start_time)!==want){ await setVisit(v.id, {start_time:want}); v.start_time = want; changed++; }
    }
    return changed;
  }
  function viewWeek(){
    const days = [...Array(7)].map((_,i)=>addDays(week, i));
    const vs = visits.filter(v=>!calF || v.calendar_id===calF);
    const tot = vs.filter(v=>v.status!=='skipped').reduce((s,v)=>s+(+(v.price ?? (v.jobs||{}).price)||0),0);
    return `<section class="card">
      <div class="jb-weekbar"><button class="btn sm" type="button" id="wkPrev">‹</button><b>${fmtDate(week)} – ${fmtDate(addDays(week,6))}</b><button class="btn sm" type="button" id="wkNext">›</button><button class="btn sm" type="button" id="wkToday">This week</button>
        <span class="jb-chips"><button type="button" class="chip ${!calF?'on':''}" data-calf="">Everyone</button>${cals.map(c=>`<button type="button" class="chip ${calF===c.id?'on':''}" data-calf="${c.id}">${calDot(c.id)}${esc(c.name)}</button>`).join('')}</span></div>
      <p class="hint">${vs.length} booking${vs.length===1?'':'s'} · ${gbp(tot)}</p>
      ${days.map(d=>{ const dv = vs.filter(v=>v.date===d); const isT = d===today();
        return `<div class="jb-day ${isT?'today':''}"><div class="jb-dh"><b>${fmtDay(d)}${isT?' · Today':''}</b><small>${dv.length ? `${dv.length} · ${gbp(dv.filter(v=>v.status!=='skipped').reduce((s,v)=>s+(+(v.price ?? (v.jobs||{}).price)||0),0))}` : ''}</small>
          <span class="jb-dha">${dv.filter(v=>v.start_time && v.status==='booked').length>1 ? `<button class="btn sm" type="button" data-retime="${d}" title="Space the day out with drive times">Re-time</button>` : ''}${dv.some(v=>v.status==='booked') && d<=today() ? `<button class="btn sm" type="button" data-daydone="${d}">All done</button>` : ''}${d>=today() ? `<button class="btn sm" type="button" data-addday="${d}">+ Add</button>` : ''}</span></div>
          ${addDay===d ? addForm(d, dv) : ''}
          ${dv.length ? dayRows(dv) : '<p class="hint jb-none">Nothing booked</p>'}</div>`; }).join('')}
    </section>`;
  }
  // fill a day: pick any unbooked job (ad hoc first, then anything due soonest)
  function addForm(d, dv){
    const free = jobs.filter(j=>j.status==='active' && !booked.has(j.id))
      .sort((a,b)=> (!!a.round_id - !!b.round_id) || (a.next_due||'0000').localeCompare(b.next_due||'0000'));
    const last = dv.filter(v=>v.start_time && v.status!=='cancelled').sort((a,b)=>a.start_time.localeCompare(b.start_time)).pop();
    const t = last ? up5(addMin(hm(last.start_time), (last.duration_min||30) + GAP)) : '08:30';
    addLast = last || null;
    return `<div class="fields jb-move">
      <label class="f wide">Job to add<select id="adJob"><option value="">${free.length ? 'Choose a job…' : 'Nothing waiting to be booked'}</option>${free.map(j=>`<option value="${j.id}">${esc((j.accounts||{}).name||'')} – ${esc(SVC_SHORT[j.service])} · ${esc(j.postcode||j.line||'')} · ${gbp(+j.price||0)}${j.round_id?' (round)':''} · ${esc(dueText(j))}</option>`).join('')}</select></label>
      <label class="f">Time<input type="time" id="adTime" value="${t}"><small class="hint" id="adDrive">${last ? 'Straight after the last job, plus the drive' : ''}</small></label>
      <label class="f">Calendar<select id="adCal">${calOpts((defCal()||{}).id, 'The job\'s own calendar')}</select></label>
      <div class="vb-actions wide"><button class="btn sm" type="button" id="adCancel">Close</button><button class="btn sm pri" type="button" id="adGo">Add to ${esc(fmtDay(d))}</button></div></div>`;
  }
  function wireWeek(){
    root().querySelectorAll('[data-retime]').forEach(b=> b.onclick = async ()=>{ b.disabled = true;
      try{ const n = await retimeDay(b.dataset.retime); flash(n ? `${n} booking${n===1?'':'s'} re-timed with drive times` : 'Times already allow for driving'); }catch(e){ flash(e.message); }
      await loadWeek(); render(); });
    root().querySelectorAll('[data-addday]').forEach(b=> b.onclick = ()=>{ addDay = addDay===b.dataset.addday ? null : b.dataset.addday; moving = null; render(); });
    if($('adGo')){
      $('adCancel').onclick = ()=>{ addDay = null; render(); };
      $('adJob').onchange = ()=>{ const j = jobs.find(x=>x.id===$('adJob').value); if(!j || !addLast) return;
        const d = drive(addLast.jobs, j); $('adTime').value = up5(addMin(hm(addLast.start_time), (addLast.duration_min||30) + d.min)); $('adDrive').textContent = driveTxt(d) + ' from the last job'; };
      $('adGo').onclick = async ()=>{ const j = jobs.find(x=>x.id===$('adJob').value); if(!j){ flash('Choose a job'); return; }
        $('adGo').disabled = true;
        try{ await book([j], addDay, $('adCal').value, $('adTime').value); flash(`Added to ${fmtDay(addDay)}`); }catch(e){ flash('Could not book: ' + e.message); }
        addDay = null; await loadWeek(); await loadBase(); render(); };
    }
    const go = async w=>{ week = w; moving = null; addDay = null; try{ await loadWeek(); }catch(e){ flash(e.message); } render(); };
    $('wkPrev').onclick = ()=> go(addDays(week,-7)); $('wkNext').onclick = ()=> go(addDays(week,7)); $('wkToday').onclick = ()=> go(monday(today()));
    root().querySelectorAll('[data-calf]').forEach(b=> b.onclick = ()=>{ calF = b.dataset.calf; render(); });
    wireVisitActions(async ()=>{ await loadWeek(); await loadBase(); render(); });
    root().querySelectorAll('[data-daydone]').forEach(b=> b.onclick = async ()=>{
      const ids = visits.filter(v=>v.date===b.dataset.daydone && v.status==='booked' && (!calF || v.calendar_id===calF)).map(v=>v.id);
      if(!confirmInline('dd'+b.dataset.daydone, `Press again to mark all ${ids.length} as done`)) return;
      try{ for(const id of ids) await setVisit(id, doneP()); flash(`${ids.length} marked done`); }catch(e){ flash(e.message); }
      await loadWeek(); await loadBase(); render();
    });
  }
  // Done / Skip / Move / Undo buttons on visit rows (diary and account page)
  function wireVisitActions(after, scope){
    const el = scope || root();
    el.querySelectorAll('[data-vdone]').forEach(b=> b.onclick = async ()=>{ b.disabled = true; try{ await setVisit(b.dataset.vdone, doneP()); flash('Done – next one is due on the job'); }catch(e){ flash(e.message); } await after(); });
    el.querySelectorAll('[data-vskip]').forEach(b=> b.onclick = async ()=>{ if(!confirmInline('sk'+b.dataset.vskip, 'Press Skip again: it won\'t be done this time and the next clean is due one cycle on')) return; try{ await setVisit(b.dataset.vskip, {status:'skipped'}); }catch(e){ flash(e.message); } await after(); });
    el.querySelectorAll('[data-vundo]').forEach(b=> b.onclick = async ()=>{ try{ await setVisit(b.dataset.vundo, {status:'booked', done_at:null, done_by_name:null}); flash('Back to booked. Check the job\'s next due date.'); }catch(e){ flash(e.message); } await after(); });
    el.querySelectorAll('[data-vmove]').forEach(b=> b.onclick = ()=>{ moving = moving===b.dataset.vmove ? null : b.dataset.vmove; after(true); });
    if(el.querySelector('#mvSave')){
      $('mvCancel').onclick = ()=>{ moving = null; after(true); };
      $('mvSave').onclick = async ()=>{ const ov = visits.find(x=>x.id===moving) || accVisits.find(x=>x.id===moving) || {};
        const extra = ov.round_date_id && $('mvDate').value !== ov.date ? {detached:true} : {};
        try{ await setVisit(moving, {...extra, date:$('mvDate').value, start_time:$('mvTime').value||null, calendar_id:$('mvCal').value||null, notes:$('mvNote').value.trim()||null}); flash('Booking moved'); moving = null; }catch(e){ flash(e.message); } await after(); };
      $('mvDel').onclick = async ()=>{ if(!confirmInline('mvd', 'Press again to cancel this booking (the job stays due)')) return; try{ await setVisit(moving, {status:'cancelled'}); moving = null; flash('Booking cancelled'); }catch(e){ flash(e.message); } await after(); };
    }
  }

  /* ---------- To book (due jobs with nothing booked) ---------- */
  function dueJobs(){
    const lim = addDays(today(), horizon);
    return jobs.filter(j=>j.status==='active' && (!j.next_due || j.next_due <= lim) && !booked.has(j.id));
  }
  function jobLine(j, check){
    const r = rounds.find(x=>x.id===j.round_id);
    const od = j.next_due && j.next_due < today();
    return `<label class="jb-j ${check && sel.has(j.id)?'on':''}">${check ? `<input type="checkbox" data-sel="${j.id}" ${sel.has(j.id)?'checked':''}>` : ''}
      <span class="m"><b>${esc((j.accounts||{}).name||'')}</b><small>${esc(SVC_SHORT[j.service])}${j.title?' · '+esc(j.title):''} · ${esc(where(j))}</small><small>${freqLabel(j.frequency_weeks, j.monthly)}${r?' · '+esc(r.name):''} · ${calDot(j.calendar_id)}${esc(calName(j.calendar_id)||calName((defCal()||{}).id))}</small></span>
      <span class="v">${gbp(+j.price||0)}<small class="${od?'jb-od':''}">${dueText(j)}</small></span></label>`;
  }
  function viewDue(){
    const due = dueJobs().sort((a,b)=> (a.next_due||'9999').localeCompare(b.next_due||'9999'));
    const groups = [];
    rounds.forEach(r=>{ const l = due.filter(j=>j.round_id===r.id).sort((a,b)=>(a.round_order??1e9)-(b.round_order??1e9)); if(l.length) groups.push([r.name, l, r]); });
    const loose = due.filter(j=>!j.round_id || !rounds.some(r=>r.id===j.round_id)); if(loose.length) groups.push(['Ad hoc jobs (not on a round)', loose, null]);
    const selJobs = due.filter(j=>sel.has(j.id));
    return `<section class="card">
      <div class="jb-weekbar"><span>Due in the next</span><select id="dueH">${[7,14,21,28,42,56].map(n=>`<option value="${n}" ${horizon===n?'selected':''}>${n} days</option>`).join('')}</select><span class="hint">(plus overdue, and ad hoc jobs with no date) with nothing booked yet</span></div>
      ${groups.length ? groups.map(([name, l, r])=>`<div class="jb-grp"><div class="jb-dh"><b>${esc(name)}</b><small>${l.length} · ${gbp(l.reduce((s,j)=>s+(+j.price||0),0))}</small><button class="linkbtn" type="button" data-selall="${r?r.id:'none'}">Select all</button></div>${l.map(j=>jobLine(j, true)).join('')}</div>`).join('')
        : `<p class="hint">Nothing to book. Jobs show here when they're coming due, or straight away for ad hoc jobs, until they're booked.</p>`}
    </section>
    ${selJobs.length ? `<section class="card jb-bookbar"><h2>Book ${selJobs.length} job${selJobs.length===1?'':'s'} · ${gbp(selJobs.reduce((s,j)=>s+(+j.price||0),0))}</h2>
      <div class="fields">
        <label class="f">Date<input type="date" id="bkDate" value="${addDays(today(),1)}"></label>
        <label class="f">Start time<input type="time" id="bkTime" value="08:30"></label>
        <label class="f">Calendar<select id="bkCal">${calOpts((defCal()||{}).id, 'Each job\'s own calendar')}</select></label>
      </div><p class="hint">Booked in the order shown: each job's length, then the drive to the next (estimated from the postcodes). Clear the start time to book them as all-day.</p>
      <div class="vb-actions"><button class="btn" type="button" id="bkClear">Clear</button><button class="btn pri" type="button" id="bkGo">Book</button></div></section>` : ''}`;
  }
  function wireDue(){
    $('dueH').onchange = e=>{ horizon = +e.target.value; render(); };
    root().querySelectorAll('[data-sel]').forEach(c=> c.onchange = ()=>{ c.checked ? sel.add(c.dataset.sel) : sel.delete(c.dataset.sel); render(); });
    root().querySelectorAll('[data-selall]').forEach(b=> b.onclick = ()=>{ const k = b.dataset.selall; dueJobs().filter(j=> k==='none' ? (!j.round_id || !rounds.some(r=>r.id===j.round_id)) : j.round_id===k).forEach(j=>sel.add(j.id)); render(); });
    if($('bkGo')){
      $('bkClear').onclick = ()=>{ sel.clear(); render(); };
      $('bkGo').onclick = async ()=>{
        const date = $('bkDate').value; if(!date){ flash('Pick a date'); return; }
        const order = []; root().querySelectorAll('[data-sel]').forEach(c=>{ if(sel.has(c.dataset.sel)) order.push(jobs.find(j=>j.id===c.dataset.sel)); });
        $('bkGo').disabled = true;
        try{ const n = await book(order.filter(Boolean), date, $('bkCal').value, $('bkTime').value); flash(`Booked ${n} on ${fmtDay(date)}`); sel.clear(); }catch(e){ flash('Could not book: ' + e.message); }
        await loadBase(); render();
      };
    }
  }

  /* ---------- Rounds ---------- */
  // A round has a next date and repeats every N weeks from it. The Portal keeps about 6 months of round
  // dates planned: each is one event in Google Calendar, and every customer on the round is booked on it.
  const HORIZON = 26*7;
  const stepDate = (d, r) => { if(r.monthly){ const x = pd(d); x.setMonth(x.getMonth()+1); return ymd(x); } return addDays(d, 7*(r.frequency_weeks||4)); };
  function cycleDates(r){
    if(!r.next_date || !r.active) return [];
    const out = [], end = addDays(today(), HORIZON); let d = r.next_date, g = 0;
    while(d < today() && g++ < 600) d = stepDate(d, r);
    while(d <= end && g++ < 1200){ out.push(d); d = stepDate(d, r); }
    return out;
  }
  const rdKey = rd => rd.moved_from || rd.date;
  // which of a round's dates a customer is booked on: every one for a customer on the round's own frequency,
  // every 2nd for 8 weeks on a 4-weekly round, every 3rd for 12 weeks, and just the next one for a one-off
  function roundEvery(j, r){
    const rf = r.monthly ? 4 : (r.frequency_weeks||4);
    if(!j.frequency_weeks && !j.monthly) return 0;            // one-off
    if(j.monthly) return 1;
    return Math.max(1, Math.round(j.frequency_weeks / rf));
  }
  function wantedFor(j, r, rds){
    const live = rds.filter(d=>d.status==='planned').sort((a,b)=>rdKey(a).localeCompare(rdKey(b)));
    if(!live.length) return new Set();
    const k = roundEvery(j, r), rf = r.monthly ? 4 : (r.frequency_weeks||4);
    // line the customer up with their next due date (the round date nearest to it, never earlier than half a round before)
    const from = j.next_due ? addDays(j.next_due, -Math.floor(rf*7/2)) : today();
    const ai = live.findIndex(d=>rdKey(d) >= from);
    if(ai < 0) return new Set();
    if(k===0) return new Set([live[ai].id]);
    const anchor = rdKey(live[ai]);
    return new Set(live.filter(d=>{ const diff = daysBetween(anchor, rdKey(d)); return diff >= 0 && Math.round(diff/(7*rf)) % k === 0; }).map(d=>d.id));
  }
  const everyTxt = (j, r) => { const k = roundEvery(j, r); return k===0 ? 'next round only' : k===1 ? 'every round' : `every ${k===2?'2nd':k===3?'3rd':k+'th'} round`; };
  const ignoreDup = e => e && e.code !== '23505' ? e : null;
  // bring a round's dates and bookings into line with its settings and customers
  async function planRound(r){
    if(!r) return;
    const q1 = await sb.from('round_dates').select('*').eq('round_id', r.id).gte('date', today()).order('date');
    if(q1.error) throw q1.error;
    let rds = q1.data;
    const want = new Set(cycleDates(r));
    const stale = rds.filter(rd=>!want.has(rdKey(rd)));
    if(stale.length){
      const ids = stale.map(x=>x.id);
      const d1 = await sb.from('visits').delete().in('round_date_id', ids).eq('status','booked'); if(d1.error) throw d1.error;
      const left = await sb.from('visits').select('round_date_id').in('round_date_id', ids); if(left.error) throw left.error;
      const keep = new Set(left.data.map(v=>v.round_date_id));
      const gone = ids.filter(id=>!keep.has(id));
      if(gone.length){ const d2 = await sb.from('round_dates').delete().in('id', gone); if(d2.error) throw d2.error; }
      rds = rds.filter(rd=>!stale.includes(rd));
    }
    const have = new Set(rds.map(rdKey));
    const add = [...want].filter(d=>!have.has(d)).map(d=>({round_id:r.id, date:d, start_time:r.start_time||'08:30', calendar_id:r.calendar_id || (defCal()||{}).id || null}));
    if(add.length){ const {error} = await sb.from('round_dates').insert(add); if(ignoreDup(error)) throw error; }
    const q2 = await sb.from('round_dates').select('*').eq('round_id', r.id).gte('date', today()).eq('status','planned').order('date');
    if(q2.error) throw q2.error;
    rds = q2.data;
    if(!rds.length) return;
    const js = jobs.filter(j=>j.round_id===r.id && j.status==='active').sort((a,b)=>(a.round_order??1e9)-(b.round_order??1e9));
    const jid = new Set(js.map(j=>j.id));
    const qv = await sb.from('visits').select('id,job_id,round_date_id,date,start_time,duration_min,calendar_id,status,price,detached').in('round_date_id', rds.map(x=>x.id));
    if(qv.error) throw qv.error;
    const vs = qv.data;
    const wantJ = new Map(js.map(j=>[j.id, wantedFor(j, r, rds)]));
    // customers taken off the round (or paused), or not due on that date any more, come off it
    const drop = vs.filter(v=>v.status==='booked' && !v.detached && (!jid.has(v.job_id) || !wantJ.get(v.job_id).has(v.round_date_id))).map(v=>v.id);
    if(drop.length){ const {error} = await sb.from('visits').delete().in('id', drop); if(error) throw error; }
    const ins = [];
    for(const rd of rds){
      const mine = vs.filter(v=>v.round_date_id===rd.id && !drop.includes(v.id));
      for(const j of js) if(wantJ.get(j.id).has(rd.id) && !mine.some(v=>v.job_id===j.id))
        ins.push({job_id:j.id, account_id:j.account_id, round_date_id:rd.id, date:rd.date, duration_min:j.duration_min||30, calendar_id:rd.calendar_id, price:j.price, created_by_name:ME.name});
    }
    if(ins.length){ const {error} = await sb.from('visits').insert(ins); if(ignoreDup(error)) throw error; }
    // times: the round's start, then each customer's job length plus the drive to the next, in driving order
    const qv2 = await sb.from('visits').select('id,job_id,round_date_id,date,start_time,calendar_id,status,price,detached').in('round_date_id', rds.map(x=>x.id)).neq('status','cancelled');
    if(qv2.error) throw qv2.error;
    for(const rd of rds){
      let t = hm(rd.start_time) || '08:30', prev = null;
      for(const j of js){
        const v = qv2.data.find(x=>x.round_date_id===rd.id && x.job_id===j.id); if(!v || v.detached) continue;
        if(prev) t = up5(addMin(t, (prev.duration_min||30) + drive(prev, j).min));
        prev = j;
        if(v.status!=='booked') continue;
        const patch = {};
        if(hm(v.start_time)!==t) patch.start_time = t;
        if(v.date!==rd.date) patch.date = rd.date;
        if(v.calendar_id!==rd.calendar_id) patch.calendar_id = rd.calendar_id;
        if(+v.price!==+j.price) patch.price = j.price;
        if(Object.keys(patch).length){ const {error} = await sb.from('visits').update(patch).eq('id', v.id); if(error) throw error; }
      }
    }
    kick();
  }
  async function planSafely(r){ try{ await planRound(r); }catch(e){ flash('Could not plan the round dates: ' + (e.message||e)); } }
  // keep every round planned about 6 months ahead (run when the Jobs page opens)
  let planned = false;
  async function planAll(){
    if(planned) return; planned = true;
    for(const r of rounds.filter(x=>x.active && x.next_date)){
      const last = roundDates.filter(d=>d.round_id===r.id).map(d=>d.date).sort().pop();
      if(!last || last < addDays(today(), HORIZON - 7*(r.frequency_weeks||4))) await planSafely(r);
    }
  }

  function roundStats(r){
    const l = jobs.filter(j=>j.round_id===r.id && j.status==='active');
    const next = roundDates.filter(d=>d.round_id===r.id && d.status==='planned' && d.date>=today()).map(d=>d.date).sort()[0];
    return {l, n:l.length, val:l.reduce((s,j)=>s+(+j.price||0),0), next};
  }
  function roundForm_(r){
    return `<div class="fields">
      <label class="f wide">Area<input id="rdName" value="${esc(r.name||'')}" placeholder="e.g. Hessle, Anlaby, Cottingham"></label>
      <label class="f">Next round date<input type="date" id="rdNext" value="${r.next_date||''}"></label>
      <label class="f">How often<select id="rdFreq">${freqOpts(r.id ? r : {frequency_weeks:4}, true)}</select></label>
      <label class="f">Calendar<select id="rdCal">${calOpts(r.calendar_id || (defCal()||{}).id)}</select></label>
      <label class="f">Start time<input type="time" id="rdTime" value="${hm(r.start_time)||'08:30'}"></label>
      <label class="f wide">Notes<input id="rdNotes" value="${esc(r.notes||'')}" placeholder="Where to park the van, key safe codes for the area…"></label>
    </div>`;
  }
  function viewRounds(){
    if(openRound) return viewRound(rounds.find(r=>r.id===openRound));
    const act = rounds.filter(r=>r.active), old = rounds.filter(r=>!r.active);
    return `<section class="card"><div class="svc-head"><h2>Window cleaning rounds</h2>${roundForm ? '' : `<button class="btn sm pri" type="button" id="rdNew">New round</button>`}</div>
      <p class="hint" style="margin-top:6px">One round per area, done every 4 weeks on the same day. Put in the next date for the round and it's planned every 4 weeks from then, about 6 months ahead, and each date goes into Google Calendar. Customers added to the round are booked on every future date. Everything else is ad hoc: book it from To book, or press + Add on a day in the Diary.</p>
      ${roundForm ? `<div class="ac-cform" style="padding:10px 0">${roundForm_({next_date:today()})}<div class="vb-actions"><button class="btn sm" type="button" id="rdCancel">Cancel</button><button class="btn sm pri" type="button" id="rdSave">Create round</button></div></div>` : ''}
      <div class="qlist" style="margin-top:8px">${act.map(r=>{ const s = roundStats(r);
        return `<div class="qitem"><div class="m"><b>${esc(r.name)}</b><small>${freqLabel(r.frequency_weeks, r.monthly)} · ${calDot(r.calendar_id)}${esc(calName(r.calendar_id))} · from ${hm(r.start_time)}</small><small>${s.n} customer${s.n===1?'':'s'} · ${s.next ? '<b>next '+fmtDay(s.next)+'</b>' : 'no date set'}</small></div>
          <div class="v">${gbp(s.val)}<small style="display:block;color:var(--muted);font-size:.72rem">per round</small></div>
          <div class="qacts"><button class="btn sm" type="button" data-rdopen="${r.id}">Open</button></div></div>`; }).join('') || (roundForm ? '' : '<p class="hint">No rounds yet.</p>')}
      ${old.length ? `<details><summary class="hint">Stopped rounds (${old.length})</summary>${old.map(r=>`<div class="qitem"><div class="m"><b>${esc(r.name)}</b></div><div class="qacts"><button class="btn sm" type="button" data-rdopen="${r.id}">Open</button></div></div>`).join('')}</details>` : ''}
      </div></section>`;
  }
  let rdMove = null;
  function viewRound(r){
    if(!r){ openRound = null; return viewRounds(); }
    const l = jobs.filter(j=>j.round_id===r.id && j.status!=='ended').sort((a,b)=>(a.round_order??1e9)-(b.round_order??1e9));
    const free = jobs.filter(j=>!j.round_id && j.status==='active' && j.service==='windows');
    const s = roundStats(r);
    const dates = roundDates.filter(d=>d.round_id===r.id && d.date>=today()).sort((a,b)=>a.date.localeCompare(b.date));
    const act = l.filter(j=>j.status==='active'), wants = new Map(act.map(j=>[j.id, wantedFor(j, r, dates)]));
    const onDate = d => act.filter(j=>wants.get(j.id).has(d.id));
    return `<section class="card">
      <button class="linkbtn" type="button" id="rdBack">← All rounds</button>
      <div class="svc-head" style="margin-top:6px"><h2>${esc(r.name)}</h2><span class="hint">${s.n} customers · ${gbp(s.val)} per round</span></div>
      <div style="margin-top:10px">${roundForm_(r)}</div>
      <div class="vb-actions" style="margin-top:8px"><button class="btn sm ${r.active?'del':''}" type="button" id="rdStop">${r.active?'Stop round':'Restart round'}</button><button class="btn sm pri" type="button" id="rdUpd">Save round</button></div>
    </section>
    <section class="card"><h2>Round dates</h2>
      ${!r.next_date ? `<p class="hint">Put in the next round date above and press Save round: it's then planned every ${r.monthly?'month':(r.frequency_weeks||4)+' weeks'} and added to ${esc(calName(r.calendar_id)||'the')} calendar.</p>` : !r.active ? `<p class="hint">This round is stopped, so no dates are planned.</p>` : ''}
      <div class="qlist" style="margin-top:8px">${dates.map(d=>`<div class="qitem ${d.status==='cancelled'?'jb-acj ended':''}"><div class="m"><b>${fmtDay(d.date)} ${pd(d.date).getFullYear()}</b><small>${d.status==='cancelled' ? 'Cancelled' : `${calDot(d.calendar_id)}${esc(calName(d.calendar_id))} · from ${hm(d.start_time)} · ${onDate(d).length} customer${onDate(d).length===1?'':'s'} · ${gbp(onDate(d).reduce((a,j)=>a+(+j.price||0),0))}`}${d.moved_from?` · moved from ${fmtDay(d.moved_from)}`:''}${d.gcal_error?` · <span class="jb-err">Calendar: ${esc(d.gcal_error)}</span>`:''}</small></div>
        <div class="qacts">${d.status==='cancelled' ? `<button class="btn sm" type="button" data-rdrestore="${d.id}">Restore</button>` : `<button class="btn sm" type="button" data-rdmove="${d.id}">Move</button><button class="btn sm" type="button" data-rdcancel="${d.id}">Cancel</button>`}</div>
        ${rdMove===d.id ? `<div class="fields jb-move wide"><label class="f">New date<input type="date" id="rmDate" value="${d.date}"></label><label class="f">Start time<input type="time" id="rmTime" value="${hm(d.start_time)}"></label>
          <div class="vb-actions wide"><button class="btn sm" type="button" id="rmCancel">Close</button><button class="btn sm pri" type="button" id="rmSave">Move round</button></div><p class="hint wide">Only this date moves; the next one stays ${r.monthly?'a month':(r.frequency_weeks||4)+' weeks'} after the original date.</p></div>` : ''}</div>`).join('') || (r.next_date && r.active ? '<p class="hint">Planning…</p>' : '')}</div>
    </section>
    <section class="card"><h2>Customers in driving order</h2>
      <div class="qlist" style="margin-top:8px">${l.map((j,i)=>`<div class="qitem jb-ri"><span class="jb-n">${i+1}</span><div class="m"><b><button class="linkbtn" type="button" data-goacc="${j.account_id}">${esc((j.accounts||{}).name||'')}</button></b><small>${esc(where(j))}${j.title?' · '+esc(j.title):''}</small><small>${freqLabel(j.frequency_weeks, j.monthly)} · ${everyTxt(j, r)}</small>${j.status==='paused'?'<small>Paused: not booked on round dates</small>':''}${i>0 ? `<small>🚐 ${esc(driveTxt(drive(l[i-1], j)))}</small>` : ''}</div>
        <div class="v">${gbp(+j.price||0)}</div>
        <div class="qacts"><button class="btn sm" type="button" data-up="${j.id}" ${i?'':'disabled'} aria-label="Move up">↑</button><button class="btn sm" type="button" data-down="${j.id}" ${i<l.length-1?'':'disabled'} aria-label="Move down">↓</button><button class="btn sm" type="button" data-rdrm="${j.id}">Remove</button></div></div>`).join('') || '<p class="hint">No customers on this round yet.</p>'}</div>
      <div class="fields one" style="margin-top:10px"><label class="f">Add a customer's window cleaning job<select id="rdAdd"><option value="">${free.length ? 'Choose…' : 'No window cleaning jobs without a round'}</option>${free.map(j=>`<option value="${j.id}">${esc((j.accounts||{}).name||'')} – ${esc(where(j))} (${gbp(+j.price||0)})</option>`).join('')}</select></label></div>
      <p class="hint">To add someone new, open their account → Jobs → Add job, and pick this round. They're booked on every future round date straight away.</p>
    </section>`;
  }
  async function saveOrder(l){
    for(let i=0;i<l.length;i++){ if(l[i].round_order!==i+1){ const {error} = await sb.from('jobs').update({round_order:i+1}).eq('id', l[i].id); if(error) throw error; l[i].round_order = i+1; } }
  }
  function roundVals(){ const f = readFreq($('rdFreq').value); return {name:$('rdName').value.trim(), next_date:$('rdNext').value||null, monthly:f.monthly, frequency_weeks:f.frequency_weeks||4, calendar_id:$('rdCal').value||null, start_time:$('rdTime').value||'08:30', notes:$('rdNotes').value.trim()||null}; }
  async function replan(r, msg){ await loadBase(); await planSafely(rounds.find(x=>x.id===r.id) || r); await loadBase(); if(msg) flash(msg); render(); }
  function wireRounds(){
    if(!openRound){
      if($('rdNew')) $('rdNew').onclick = ()=>{ roundForm = true; render(); };
      if($('rdCancel')) $('rdCancel').onclick = ()=>{ roundForm = false; render(); };
      if($('rdSave')) $('rdSave').onclick = async ()=>{ const v = roundVals(); if(!v.name){ flash('Give the round an area name'); return; }
        $('rdSave').disabled = true;
        const {data, error} = await sb.from('rounds').insert(v).select().single(); if(error){ flash(error.message); $('rdSave').disabled = false; return; }
        roundForm = false; openRound = data.id; await replan(data, v.next_date ? `${v.name} planned from ${fmtDay(v.next_date)}` : 'Round created'); };
      root().querySelectorAll('[data-rdopen]').forEach(b=> b.onclick = ()=>{ openRound = b.dataset.rdopen; rdMove = null; render(); });
      return;
    }
    const r = rounds.find(x=>x.id===openRound); if(!r) return;
    const l = jobs.filter(j=>j.round_id===r.id && j.status!=='ended').sort((a,b)=>(a.round_order??1e9)-(b.round_order??1e9));
    $('rdBack').onclick = ()=>{ openRound = null; rdMove = null; render(); };
    $('rdUpd').onclick = async ()=>{ const v = roundVals(); if(!v.name){ flash('Give the round an area name'); return; }
      $('rdUpd').disabled = true;
      const {error} = await sb.from('rounds').update(v).eq('id', r.id); if(error){ flash(error.message); $('rdUpd').disabled = false; return; }
      // customers on the round follow its calendar (each keeps their own frequency); future round dates follow its start time and calendar
      const e2 = (await sb.from('jobs').update({calendar_id:v.calendar_id}).eq('round_id', r.id)).error;
      const e3 = (await sb.from('round_dates').update({start_time:v.start_time, calendar_id:v.calendar_id}).eq('round_id', r.id).eq('status','planned').gte('date', today()).is('moved_from', null)).error;
      if(e2 || e3) flash((e2||e3).message);
      await replan({...r, ...v}, 'Round saved'); };
    $('rdStop').onclick = async ()=>{ const {error} = await sb.from('rounds').update({active:!r.active}).eq('id', r.id); if(error) flash(error.message); await replan({...r, active:!r.active}, r.active ? 'Round stopped: future dates removed' : 'Round restarted'); };
    root().querySelectorAll('[data-up],[data-down]').forEach(b=> b.onclick = async ()=>{
      const id = b.dataset.up || b.dataset.down, i = l.findIndex(j=>j.id===id), k = b.dataset.up ? i-1 : i+1;
      if(k<0 || k>=l.length) return; [l[i], l[k]] = [l[k], l[i]];
      try{ await saveOrder(l); }catch(e){ flash(e.message); } render(); clearTimeout(reorderT); reorderT = setTimeout(()=> replan(r), 1500); });
    root().querySelectorAll('[data-rdrm]').forEach(b=> b.onclick = async ()=>{ const {error} = await sb.from('jobs').update({round_id:null, round_order:null}).eq('id', b.dataset.rdrm); if(error) flash(error.message); await replan(r, 'Taken off the round and its future dates'); });
    $('rdAdd').onchange = async e=>{ const id = e.target.value; if(!id) return;
      // each customer keeps their own frequency: 4 weeks = every round, 8 = every 2nd, 12 = every 3rd, one-off = next round only
      const {error} = await sb.from('jobs').update({round_id:r.id, round_order:l.length+1, calendar_id:r.calendar_id}).eq('id', id);
      if(error) flash(error.message); await replan(r, r.next_date ? 'Added and booked on the future round dates' : 'Added to the round'); };
    root().querySelectorAll('[data-rdmove]').forEach(b=> b.onclick = ()=>{ rdMove = rdMove===b.dataset.rdmove ? null : b.dataset.rdmove; render(); });
    if($('rmSave')){
      $('rmCancel').onclick = ()=>{ rdMove = null; render(); };
      $('rmSave').onclick = async ()=>{ const d = roundDates.find(x=>x.id===rdMove), nd = $('rmDate').value, nt = $('rmTime').value || hm(d.start_time);
        if(!nd){ flash('Pick a date'); return; }
        const {error} = await sb.from('round_dates').update({date:nd, start_time:nt, moved_from: d.moved_from || (nd!==d.date ? d.date : null)}).eq('id', d.id);
        if(error){ flash(error.code==='23505' ? 'There\'s already a round date there' : error.message); return; }
        const e2 = (await sb.from('visits').update({date:nd}).eq('round_date_id', d.id).eq('status','booked').eq('detached', false)).error; if(e2) flash(e2.message);
        rdMove = null; await replan(r, `Round moved to ${fmtDay(nd)}`); };
    }
    root().querySelectorAll('[data-rdcancel]').forEach(b=> b.onclick = async ()=>{
      if(!confirmInline('rc'+b.dataset.rdcancel, 'Press Cancel again: nobody on the round is done that day. The next date stays where it is.')) return;
      const e1 = (await sb.from('round_dates').update({status:'cancelled'}).eq('id', b.dataset.rdcancel)).error;
      const e2 = (await sb.from('visits').update({status:'cancelled'}).eq('round_date_id', b.dataset.rdcancel).eq('status','booked')).error;
      if(e1 || e2) flash((e1||e2).message); kick(); await loadBase(); render(); });
    root().querySelectorAll('[data-rdrestore]').forEach(b=> b.onclick = async ()=>{
      const e1 = (await sb.from('round_dates').update({status:'planned'}).eq('id', b.dataset.rdrestore)).error;
      const e2 = (await sb.from('visits').update({status:'booked'}).eq('round_date_id', b.dataset.rdrestore).eq('status','cancelled')).error;
      if(e1 || e2) flash((e1||e2).message); await replan(r, 'Round date restored'); });
  }
  let reorderT = null;

  /* ---------- All jobs ---------- */
  function viewAll(){
    const s = q.trim().toLowerCase();
    const l = jobs.filter(j=>(showEnded || j.status!=='ended') && (!s || [(j.accounts||{}).name, j.line, j.postcode, j.title, SVC[j.service], 'jb-'+j.job_no].join(' ').toLowerCase().includes(s)))
      .sort((a,b)=>(a.next_due||'9999').localeCompare(b.next_due||'9999'));
    return `<section class="card">
      <div class="fields"><label class="f wide">Search<input id="jbQ" type="search" value="${esc(q)}" placeholder="Customer, address, postcode or job no."></label>
        <label class="ck" style="align-self:end"><input type="checkbox" id="jbEnded" ${showEnded?'checked':''}> Show finished jobs</label></div>
      <p class="hint">Add jobs from the customer's account (Accounts → customer → Jobs).</p>
      <div class="qlist">${l.map(j=>`<button type="button" class="ac-row" data-openacc="${j.account_id}">
        <span class="ac-n"><b>${esc((j.accounts||{}).name||'')}</b><small>JB-${j.job_no} · ${esc(SVC_SHORT[j.service])} · ${esc(where(j))}</small></span>
        <span class="ac-c"><small>${freqLabel(j.frequency_weeks, j.monthly)}</small><small>${calDot(j.calendar_id)}${esc(calName(j.calendar_id))}${j.round_id?' · '+esc((rounds.find(r=>r.id===j.round_id)||{}).name||''):''}</small></span>
        <span class="ac-q"><small>${gbp(+j.price||0)}</small><small>${dueText(j)}</small></span>
        <span class="pill ${j.status==='active'?'accepted':j.status==='paused'?'sent':'draft'}">${j.status==='active'?'Active':j.status==='paused'?'Paused':'Finished'}</span></button>`).join('') || '<p class="hint">No jobs yet.</p>'}</div></section>`;
  }
  function wireAll(){
    const re = ()=>{ const el = document.activeElement, pos = el && el.selectionStart; render(); const i = $('jbQ'); if(i && el && el.id==='jbQ'){ i.focus(); try{ i.setSelectionRange(pos,pos); }catch(e){} } };
    $('jbQ').oninput = e=>{ q = e.target.value; re(); };
    $('jbEnded').onchange = e=>{ showEnded = e.target.checked; render(); };
    root().querySelectorAll('[data-openacc]').forEach(b=> b.onclick = ()=>{ goJobsTab(b.dataset.openacc); ACCOUNTS.open(b.dataset.openacc); });
  }

  /* =====================================================================
     Account page: the customer's jobs and visits (rendered inside ACCOUNTS)
     ===================================================================== */
  let acc = {editing:null, prefill:null, bookFor:null}, accVisits = [];
  async function loadAccount(id){
    if(!cals.length || !loaded){ try{ await loadBase(); }catch(e){} }
    const [j, v] = await Promise.all([
      sb.from('jobs').select('*').eq('account_id', id).order('created_at'),
      sb.from('visits').select('*').eq('account_id', id).neq('status','cancelled').order('date', {ascending:false}).limit(200)
    ]);
    if(j.error) throw j.error; if(v.error) throw v.error;
    return {jobs:j.data, visits:v.data};
  }
  function guessSvc(s){ s = String(s||'').toLowerCase(); return /window/.test(s) ? 'windows' : /gutter|fascia|soffit/.test(s) ? 'gutters' : /roof|moss/.test(s) ? 'roof' : /pressure|patio|drive|jet|soft wash|render/.test(s) ? 'pressure' : 'other'; }
  // names: the quote sections this job is for (all of them when not given); withFixed: include travel/access
  function prefillFromQuote(qt, names, withFixed){
    const f = ((qt.state||{}).form||{});
    if(names && names.length){
      const opt = optionsOf(qt), p = pickPrice(opt, names, withFixed);
      const svc = guessSvc(names[0]), wf = names.some(n=>/^Windows/.test(n)) && f['on-wn'] ? (+f.wnFreq || null) : null;
      return {service:svc, title:names.join(', '), price:p.total, line:qt.address||'', postcode:qt.postcode||'', quote_id:qt.id, frequency_weeks:wf,
        quote_sections: p.all ? null : names};
    }
    const groups = (qt.lines||[]).map(g=>g.name).filter(Boolean);
    const svc = guessSvc(groups[0]||'');
    const wf = svc==='windows' && f['on-wn'] ? (+f.wnFreq || null) : null;   // window quotes say how often
    return {service:svc, title:groups.join(', '), price:+qt.total||0, line:qt.address||'', postcode:qt.postcode||'', quote_id:qt.id, frequency_weeks:wf};
  }
  // job discounts: price is what's charged; base_price is the price before the discount
  function jobNet(base, type, val){ base = +base||0; val = Math.max(0, +val||0); if(!val) return base;
    const off = type==='pct' ? base*Math.min(val,100)/100 : Math.min(val, base); return Math.round((base-off)*100)/100; }
  function discText(j){ if(!(+j.discount_value>0) || !j.discount_type) return '';
    const what = j.discount_type==='pct' ? `${+j.discount_value}% off` : `${gbp(+j.discount_value)} off`;
    return `${what} ${gbp(+j.base_price||0)}${j.discount_note?' · '+j.discount_note:''}`; }
  function jobForm(d, j){
    const props = d.props || [];
    const pickAddr = props.find(p=>p.id===j.address_id) || (j.line ? props.find(p=>(p.line||'').toLowerCase()===String(j.line).toLowerCase()) : null) || (!j.id && props.length===1 ? props[0] : null);
    return `<div class="fields ac-cform jb-form" style="padding:10px 0;border-bottom:1px solid var(--line)">
      ${props.length ? `<label class="f wide">Address<select id="jfAddr"><option value="">Type an address below</option>${props.map(p=>`<option value="${p.id}" ${pickAddr&&pickAddr.id===p.id?'selected':''}>${esc([p.line,p.postcode].filter(Boolean).join(', '))}</option>`).join('')}</select></label>` : ''}
      <label class="f">Address line<input id="jfLine" value="${esc(pickAddr ? pickAddr.line||'' : j.line||'')}"></label>
      <label class="f">Postcode<input id="jfPc" value="${esc(pickAddr ? pickAddr.postcode||'' : j.postcode||'')}"></label>
      <label class="f">Service<select id="jfSvc">${Object.entries(SVC).map(([k,v])=>`<option value="${k}" ${(j.service||'windows')===k?'selected':''}>${v}</option>`).join('')}</select></label>
      <label class="f">Price before discount (£)<input id="jfPrice" type="number" step="0.01" min="0" inputmode="decimal" value="${j.base_price!=null?+j.base_price:j.price!=null?+j.price:''}"></label>
      <label class="f">Discount<span class="inrow"><select id="jfDT" aria-label="Discount type" style="flex:0 0 64px;width:64px"><option value="pct" ${j.discount_type!=='gbp'?'selected':''}>%</option><option value="gbp" ${j.discount_type==='gbp'?'selected':''}>£</option></select><input id="jfDV" type="number" step="0.5" min="0" inputmode="decimal" value="${+j.discount_value||0}"></span></label>
      <label class="f">Discount reason<input id="jfDR" value="${esc(j.discount_note||'')}" placeholder="e.g. Neighbour discount"></label>
      <div class="f"><span>Charged per visit</span><b id="jfNet" style="font-size:1.05rem;color:var(--ink)"></b></div>
      <label class="f wide">What's included<input id="jfTitle" value="${esc(j.title||'')}" placeholder="e.g. Front & back, conservatory, frames every 3rd clean"></label>
      <label class="f">How often<select id="jfFreq">${freqOpts(j)}</select></label>
      <label class="f">Next due<input id="jfDue" type="date" value="${j.next_due||''}"></label>
      <label class="f">Round<select id="jfRound">${roundOpts(j.round_id)}</select><small class="hint">On a 4-weekly round: 8 weeks = every 2nd round, 12 = every 3rd</small></label>
      <label class="f">Calendar<select id="jfCal">${calOpts(j.calendar_id || (defCal()||{}).id)}</select></label>
      <label class="f">Takes (minutes)<input id="jfDur" type="number" min="5" step="5" value="${j.duration_min||30}"></label>
      ${j.id ? `<label class="f">Status<select id="jfStatus">${[['active','Active'],['paused','Paused'],['ended','Finished']].map(([k,v])=>`<option value="${k}" ${j.status===k?'selected':''}>${v}</option>`).join('')}</select></label>` : ''}
      <label class="f wide">Access notes<input id="jfNotes" value="${esc(j.notes||'')}" placeholder="Gate code, side access, dog, where the tap is…"></label>
      <div class="vb-actions wide">${j.id ? `<button class="btn sm del" type="button" id="jfDel">Delete job</button>` : ''}<button class="btn sm" type="button" id="jfCancel">Cancel</button><button class="btn sm pri" type="button" id="jfSave">${j.id?'Save job':'Add job'}</button></div>
    </div>`;
  }
  function accountHTML(d){
    const J = d.jobsData || {jobs:[], visits:[]};
    const up = J.visits.filter(v=>v.status==='booked').sort((a,b)=>(a.date+(a.start_time||'')).localeCompare(b.date+(b.start_time||'')));
    const past = J.visits.filter(v=>v.status!=='booked');
    const jobName = id => { const j = J.jobs.find(x=>x.id===id); return j ? `${SVC_SHORT[j.service]}${j.line?' · '+j.line:''}` : ''; };
    const vrow = v => `<div class="jb-v ${v.status}"><div class="jb-t">${fmtDay(v.date)}<small>${v.start_time?hm(v.start_time):''}</small></div>
      <div class="m">${calDot(v.calendar_id)}<b>${esc(jobName(v.job_id))}</b><small>${esc(calName(v.calendar_id))}${v.done_by_name&&v.status==='done'?' · done by '+esc(v.done_by_name):''}${v.notes?' · '+esc(v.notes):''}</small></div>
      <div class="v">${gbp(+v.price||0)}${v.status!=='booked'?`<small class="pill ${v.status==='done'?'accepted':'declined'}">${VST[v.status]}</small>`:''}</div>
      <div class="qacts">${v.status==='booked' ? `<button class="btn sm pri" type="button" data-vdone="${v.id}">Done</button><button class="btn sm" type="button" data-vmove="${v.id}">Move</button>` : `<button class="btn sm" type="button" data-vundo="${v.id}">Undo</button>`}</div>
      ${moving===v.id ? `<div class="fields jb-move wide"><label class="f">Date<input type="date" id="mvDate" value="${v.date}"></label><label class="f">Time<input type="time" id="mvTime" value="${hm(v.start_time)}"></label><label class="f">Calendar<select id="mvCal">${calOpts(v.calendar_id)}</select></label><label class="f">Note<input id="mvNote" value="${esc(v.notes||'')}"></label>
        <div class="vb-actions wide"><button class="btn sm del" type="button" id="mvDel">Cancel booking</button><button class="btn sm" type="button" id="mvCancel">Close</button><button class="btn sm pri" type="button" id="mvSave">Save</button></div></div>` : ''}</div>`;
    return `<section class="card">
      <div class="svc-head"><h2>Jobs</h2>${acc.editing ? '' : `<button class="btn sm pri" type="button" id="jaNew">+ Add job</button>`}</div>
      <div class="qlist" style="margin-top:8px">
      ${acc.editing==='new' ? jobForm(d, acc.prefill || {}) : ''}
      ${J.jobs.map(j=> acc.editing===j.id ? jobForm(d, j) : `<div class="qitem jb-acj ${j.status}"><div class="m"><b>${esc(SVC[j.service])}${j.title?` <span class="hint">· ${esc(j.title)}</span>`:''}</b><small>JB-${j.job_no} · ${esc(where(j)||'no address')}</small>
          <small>${freqLabel(j.frequency_weeks, j.monthly)}${j.round_id?' · '+esc((rounds.find(r=>r.id===j.round_id)||{}).name||'round'):''} · ${calDot(j.calendar_id)}${esc(calName(j.calendar_id))} · <b>${j.status==='active'?dueText(j):j.status==='paused'?'Paused':'Finished'}</b></small>${j.notes?`<small>Access: ${esc(j.notes)}</small>`:''}</div>
          <div class="v">${gbp(+j.price||0)}${discText(j)?`<small>${esc(discText(j))}</small>`:''}</div>
          <div class="qacts">${j.status==='active' ? `<button class="btn sm pri" type="button" data-jbook="${j.id}">Book</button>` : ''}<button class="btn sm" type="button" data-jedit="${j.id}">Edit</button></div>
          ${acc.bookFor===j.id ? `<div class="fields jb-move wide"><label class="f">Date<input type="date" id="jbDate" value="${j.next_due && j.next_due>today() ? j.next_due : addDays(today(),1)}"></label><label class="f">Time<input type="time" id="jbTime"></label><label class="f">Calendar<select id="jbCal">${calOpts(j.calendar_id || (defCal()||{}).id)}</select></label>
            <div class="vb-actions wide"><button class="btn sm" type="button" id="jbCancel">Cancel</button><button class="btn sm pri" type="button" id="jbGo">Book visit</button></div></div>` : ''}</div>`).join('')}
      ${!J.jobs.length && acc.editing!=='new' ? `<p class="hint">No jobs yet. Add their regular window clean or a one-off job here${d.quotes.some(q=>q.status==='accepted') ? ', or press Make job on an accepted quote' : ''}.</p>` : ''}
      </div></section>
      <section class="card"><h2>Booked</h2><div class="qlist" style="margin-top:8px">${up.map(vrow).join('') || '<p class="hint">Nothing booked.</p>'}</div></section>
      ${past.length ? `<section class="card"><h2>History</h2><div class="qlist" style="margin-top:8px">${past.slice(0,30).map(vrow).join('')}</div></section>` : ''}`;
  }
  function wireAccount(d, reload){
    const el = $('view-accounts');
    const J = d.jobsData || {jobs:[], visits:[]};
    accVisits = J.visits;
    const again = async soft=>{ if(soft===true){ ACCOUNTS.rerender(); return; } await reload(); };
    if($('jaNew')) $('jaNew').onclick = ()=>{ acc.editing = 'new'; acc.prefill = null; again(true); };
    el.querySelectorAll('[data-jedit]').forEach(b=> b.onclick = ()=>{ acc.editing = b.dataset.jedit; acc.bookFor = null; again(true); });
    el.querySelectorAll('[data-jbook]').forEach(b=> b.onclick = ()=>{ acc.bookFor = acc.bookFor===b.dataset.jbook ? null : b.dataset.jbook; again(true); });
    if($('jbGo')){
      $('jbCancel').onclick = ()=>{ acc.bookFor = null; again(true); };
      $('jbGo').onclick = async ()=>{ const j = J.jobs.find(x=>x.id===acc.bookFor); if(!j || !$('jbDate').value) return;
        $('jbGo').disabled = true;
        try{ await book([j], $('jbDate').value, $('jbCal').value, $('jbTime').value); flash(`Booked for ${fmtDay($('jbDate').value)}`); acc.bookFor = null; }catch(e){ flash('Could not book: ' + e.message); }
        loaded = false; await again(); };
    }
    if($('jfAddr')) $('jfAddr').onchange = e=>{ const p = (d.props||[]).find(x=>x.id===e.target.value); if(p){ $('jfLine').value = p.line||''; $('jfPc').value = p.postcode||''; } };
    if($('jfRound')) $('jfRound').onchange = e=>{ const r = rounds.find(x=>x.id===e.target.value); if(r){ if(!$('jfFreq').value) $('jfFreq').value = r.monthly ? 'm' : String(r.frequency_weeks); if(r.calendar_id) $('jfCal').value = r.calendar_id; if($('jfSvc').value!=='windows') $('jfSvc').value = 'windows'; } };
    if($('jfSave')){
      const showNet = ()=>{ const b = +$('jfPrice').value||0, n = jobNet(b, $('jfDT').value, $('jfDV').value);
        $('jfNet').textContent = gbp(n) + (n<b ? ` (${gbp(b-n)} off)` : ''); };
      ['jfPrice','jfDT','jfDV'].forEach(id=>{ $(id).addEventListener('input', showNet); $(id).addEventListener('change', showNet); }); showNet();
      $('jfCancel').onclick = ()=>{ acc.editing = null; acc.prefill = null; again(true); };
      $('jfSave').onclick = async ()=>{
        const id = acc.editing, old = J.jobs.find(x=>x.id===id) || {};
        const v = {account_id:d.acc.id, address_id:($('jfAddr')||{}).value||null, line:$('jfLine').value.trim()||null, postcode:fmtPc($('jfPc').value)||null,
          service:$('jfSvc').value, title:$('jfTitle').value.trim()||null, ...jobPrice(), ...readFreq($('jfFreq').value),
          next_due:$('jfDue').value||null, round_id:$('jfRound').value||null, calendar_id:$('jfCal').value||null, duration_min:Math.max(5, +$('jfDur').value||30), notes:$('jfNotes').value.trim()||null};
        if($('jfStatus')) v.status = $('jfStatus').value;
        if(v.discount_type==='pct' && v.discount_value>100){ flash('A discount can\'t be more than 100%'); return; }
        if(!v.line && !v.postcode){ flash('Add the address for this job'); return; }
        if(!(v.price>0) && !confirmInline('jf0', 'No price set. Press Save again to save it at £0.')) return;
        if(v.round_id && v.round_id!==old.round_id){ v.round_order = jobs.filter(j=>j.round_id===v.round_id).length + 1; }
        if(!v.round_id) v.round_order = null;
        if(id==='new'){ v.created_by_name = ME.name; if(acc.prefill && acc.prefill.quote_id){ v.quote_id = acc.prefill.quote_id; if(acc.prefill.quote_sections) v.quote_sections = acc.prefill.quote_sections; } }
        $('jfSave').disabled = true;
        const r = id==='new' ? await sb.from('jobs').insert(v) : await sb.from('jobs').update(v).eq('id', id);
        if(r.error){ flash('Could not save: ' + r.error.message); $('jfSave').disabled = false; return; }
        flash(id==='new' ? (v.round_id ? 'Job added to the round' : 'Job added – it\'s in Jobs → To book until it\'s booked') : 'Job saved');
        const touched = [...new Set([old.round_id, v.round_id].filter(Boolean))];
        if(touched.length){ try{ await loadBase(); for(const rid of touched) await planRound(rounds.find(x=>x.id===rid)); }catch(e){ flash('Could not update the round dates: ' + (e.message||e)); } }
        acc.editing = null; acc.prefill = null; loaded = false; await again();
      };
      if($('jfDel')) $('jfDel').onclick = async ()=>{ if(!confirmInline('jfd', 'Press again to delete this job and its bookings (history included). To keep the history, set it to Finished instead.')) return;
        const {error} = await sb.from('jobs').delete().eq('id', acc.editing); if(error){ flash(error.message); return; }
        kick(); acc.editing = null; loaded = false; await again(); };
    }
    wireVisitActions(async soft=>{ if(soft===true) return again(true); loaded = false; await again(); }, el);
  }
  function jobPrice(){
    const base = Math.round((+$('jfPrice').value||0)*100)/100, val = Math.max(0, +$('jfDV').value||0), type = $('jfDT').value;
    return {base_price:base, price:jobNet(base, type, val), discount_type:val ? type : null, discount_value:val, discount_note:val ? ($('jfDR').value.trim()||null) : null};
  }
  function startFromQuote(qt, names, withFixed){ acc.editing = 'new'; acc.prefill = prefillFromQuote(qt, names, withFixed); acc.bookFor = null; }
  function resetAccount(){ acc = {editing:null, prefill:null, bookFor:null}; moving = null; }

  return {onShow, refresh, loadAccount, accountHTML, wireAccount, startFromQuote, resetAccount, kick,
    reset:()=>{ loaded = false; cals = []; rounds = []; jobs = []; visits = []; openRound = null; sel.clear(); }};
})();
if(typeof ME!=='undefined' && ME && !document.getElementById('view-jobs').hidden) JOBS.onShow();
