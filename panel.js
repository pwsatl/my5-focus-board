// ── Constants ──────────────────────────────────────────────────────────────
const CATS = ['action','inbound','outbound','request','freight','billing','research','devy'];
const CAT_LABEL = {
  action:'Action', inbound:'Inbound', outbound:'Outbound', request:'Request',
  freight:'Freight', billing:'Billing', research:'Research', devy:'Devy'
};
const STORAGE_KEY = 'paragon_focus_v2'; // legacy internal key — do NOT rename or existing boards are lost
const BUILTIN_LISTS = ['pipeline','backlog'];

// ── Built-in Worker URL ─────────────────────────────────────────────────────
// Set this ONCE to your deployed Worker. Nobody on the team ever types it again.
// (Settings → Team → Advanced can still override it per-device if ever needed.)
const DEFAULT_WORKER_URL = 'https://paragon-focus-sync.sgrim.workers.dev';

function workerUrl() {
  const u = (syncConfig.url || DEFAULT_WORKER_URL).replace(/\/$/, '');
  return u;
}
function workerConfigured() {
  const u = workerUrl();
  return !!u && !u.includes('YOUR.workers.dev');
}

// Friendly, unambiguous codes (no 0/O, 1/I/L — and no underscores, per Worker rules)
const CODE_ALPHABET = 'ABCDEFGHJKMNPQRSTUVWXYZ23456789';
function randCode(n) {
  const a = new Uint32Array(n); crypto.getRandomValues(a);
  let s = ''; for (let i = 0; i < n; i++) s += CODE_ALPHABET[a[i] % CODE_ALPHABET.length];
  return s;
}

// ── State ──────────────────────────────────────────────────────────────────
let lists      = [
  { id:'pipeline', label:'Pipeline', builtin:true },
  { id:'backlog',  label:'Backlog',  builtin:true }
];
let tasks      = [];
let doneTasks  = [];
let nextId     = 1;
let nextListId = 1;

let draggingId    = null;
let reorderDragId = null;
let reorderListEl = null;
let currentTab    = 'pipeline';
let selectedCat   = 'action';
let editingId     = null;
let searchQ       = '';
let drawerOpen    = false;

// Sync config (stored separately from task data)
let syncConfig = { url: '', team: '', adminCode: '', interval: 120 };
let savedTeams = []; // [{ name, url, team, adminCode }]
// Device sync: whole personal board (My 5, Pipeline, Backlog, private lists) as one blob
let personalSync = { code: '', adminCode: '' };
let personalLastSaved = 0;        // ms timestamp of last local personal change
let personalPushTimer = null;     // debounce handle
let suppressPersonalPush = false; // true while applying a remote board
let userName = '';
let syncTimer = null;
let prefs = { theme: 'green', font: 'system', sound: 'off', volume: 60 };

// ── Persistence ────────────────────────────────────────────────────────────
function saveState(changedListId) {
  const s = JSON.stringify({ lists, tasks, doneTasks, nextId, nextListId });
  try { chrome.storage.local.set({ [STORAGE_KEY]: s }); } catch(e) { localStorage.setItem(STORAGE_KEY, s); }
  // Auto-push if a shared list was changed
  if (changedListId && syncReady()) {
    const list = lists.find(l => l.id === changedListId);
    if (list && list.shared) syncPush(list);
  }
  // Device sync: any change schedules a debounced personal-board push
  if (!suppressPersonalPush && personalReady()) {
    personalLastSaved = Date.now();
    schedulePersonalPush();
  }
}

function saveSyncConfig() {
  const data = JSON.stringify({ syncConfig, userName, prefs, savedTeams, personalSync });
  try { chrome.storage.local.set({ paragon_sync_config: data }); }
  catch(e) { localStorage.setItem('paragon_sync_config', data); }
}

function loadState(cb) {
  try {
    chrome.storage.local.get([STORAGE_KEY, 'paragon_sync_config'], r => {
      if (r[STORAGE_KEY]) applyState(JSON.parse(r[STORAGE_KEY]));
      if (r.paragon_sync_config) {
        const sc = JSON.parse(r.paragon_sync_config);
        if (sc.syncConfig) syncConfig = Object.assign({ url:'', team:'', adminCode:'', interval:120 }, sc.syncConfig);
        if (sc.userName)   userName   = sc.userName;
        if (sc.prefs)      prefs      = Object.assign({ theme:'green', font:'system', sound:'off', volume:60 }, sc.prefs);
        // migrate retired sounds
        const SOUND_MIGRATE = { ding:'chime', pop:'success', wood:'bubble' };
        if (SOUND_MIGRATE[prefs.sound]) prefs.sound = SOUND_MIGRATE[prefs.sound];
        if (sc.savedTeams) savedTeams = sc.savedTeams;
        if (sc.personalSync) personalSync = Object.assign({ code:'', adminCode:'' }, sc.personalSync);
        // legacy format
        if (sc.url)  syncConfig.url  = sc.url;
        if (sc.team) syncConfig.team = sc.team;
      }
      cb();
    });
  } catch(e) {
    const raw = localStorage.getItem(STORAGE_KEY);
    if (raw) applyState(JSON.parse(raw));
    const sc = localStorage.getItem('paragon_sync_config');
    if (sc) {
      try {
        const parsed = JSON.parse(sc);
        if (parsed.syncConfig) syncConfig = Object.assign({ url:'', team:'', adminCode:'', interval:120 }, parsed.syncConfig);
        if (parsed.userName)   userName   = parsed.userName;
        if (parsed.prefs)      prefs      = Object.assign({ theme:'green', font:'system', sound:'off', volume:60 }, parsed.prefs);
        if (parsed.savedTeams) savedTeams = parsed.savedTeams;
        if (parsed.personalSync) personalSync = Object.assign({ code:'', adminCode:'' }, parsed.personalSync);
        const SOUND_MIGRATE2 = { ding:'chime', pop:'success', wood:'bubble' };
        if (SOUND_MIGRATE2[prefs.sound]) prefs.sound = SOUND_MIGRATE2[prefs.sound];
        if (parsed.url)  syncConfig.url  = parsed.url;
        if (parsed.team) syncConfig.team = parsed.team;
      } catch(e2) {}
    }
    cb();
  }
}

function applyState(s) {
  if (s.lists)      lists      = s.lists;
  if (s.tasks)      tasks      = s.tasks;
  if (s.doneTasks)  doneTasks  = s.doneTasks;
  if (s.nextId)     nextId     = s.nextId;
  if (s.nextListId) nextListId = s.nextListId;
  // migrate old listId names
  tasks.forEach(t => {
    if (t.listId === 'now')   t.listId = 'pipeline';
    if (t.listId === 'later') t.listId = 'backlog';
  });
}

// ── CSV helpers ────────────────────────────────────────────────────────────
function buildCSV(taskList) {
  const rows = [['Title','Category','From','Due','Notes','List','ClientCode','Active']];
  taskList.forEach(t => {
    const listLabel = (lists.find(l=>l.id===t.listId)||{}).label || t.listId;
    const notes = Array.isArray(t.notes)
      ? t.notes.map(n=>`[${n.ts}] ${n.text}`).join(' | ')
      : (t.notes||'');
    rows.push([
      `"${(t.title ||'').replace(/"/g,'""')}"`,
      CAT_LABEL[t.cat]||t.cat,
      `"${(t.sender||'').replace(/"/g,'""')}"`,
      `"${(t.due   ||'').replace(/"/g,'""')}"`,
      `"${notes.replace(/"/g,'""')}"`,
      `"${listLabel}"`,
      `"${(t.client||'').replace(/"/g,'""')}"`,
      t.active?'Yes':'No'
    ]);
  });
  return rows.map(r=>r.join(',')).join('\n');
}

function parseCSVLine(line) {
  const result=[]; let cur='', inQ=false;
  for (let i=0;i<line.length;i++) {
    const ch=line[i];
    if (ch==='"'){ if(inQ&&line[i+1]==='"'){cur+='"';i++;}else inQ=!inQ; }
    else if(ch===','&&!inQ){result.push(cur);cur='';}
    else cur+=ch;
  }
  result.push(cur); return result;
}

function importCSV(csvText) {
  const lines=csvText.trim().split('\n'); if(lines.length<2) throw new Error('File appears empty');
  const hdr=parseCSVLine(lines[0]).map(h=>h.trim().toLowerCase());
  const col=n=>hdr.indexOf(n);
  const iT=col('title'),iC=col('category'),iF=col('from'),iD=col('due'),iN=col('notes'),iL=col('list'),iCl=col('clientcode'),iA=col('active');
  if(iT===-1) throw new Error('CSV must have a "Title" column');
  let imported=0;
  for(let i=1;i<lines.length;i++){
    const line=lines[i].trim(); if(!line) continue;
    const cols=parseCSVLine(line);
    const title=(cols[iT]||'').trim(); if(!title) continue;
    const rawCat=(cols[iC]||'').trim().toLowerCase();
    const cat=CATS.includes(rawCat)?rawCat:'action';
    const sender=iF>=0?(cols[iF]||'').trim():'';
    const due=iD>=0?(cols[iD]||'').trim():'';
    const notesRaw=iN>=0?(cols[iN]||'').trim():'';
    const client=iCl>=0?(cols[iCl]||'').trim():'';
    const rawList=iL>=0?(cols[iL]||'').trim():'';
    const isActive=iA>=0?(cols[iA]||'').trim().toLowerCase()==='yes':false;
    let listId='pipeline';
    const matched=lists.find(l=>l.label.toLowerCase()===rawList.toLowerCase()||l.id===rawList.toLowerCase());
    if(matched){ listId=matched.id; }
    else if(rawList){ const nid='custom-'+(nextListId++); lists.push({id:nid,label:rawList,builtin:false}); listId=nid; }
    const notes=notesRaw?[{ts:new Date().toLocaleString(),text:notesRaw}]:[];
    const ok=isActive&&tasks.filter(t=>t.active).length<5;
    tasks.unshift({id:nextId++,title,sender,cat,due,notes,client,listId:ok?'pipeline':listId,active:ok,done:false});
    imported++;
  }
  return imported;
}

// ── Icons ──────────────────────────────────────────────────────────────────
const SVG_UP    = `<svg viewBox="0 0 9 9" fill="none" stroke="currentColor" stroke-width="1.2"><path d="M4.5 8V1M2 4l2.5-3L7 4"/></svg>`;
const SVG_RIGHT = `<svg viewBox="0 0 9 9" fill="none" stroke="currentColor" stroke-width="1.2"><path d="M1 4.5h7M5 2l3 2.5L5 7"/></svg>`;
const SVG_LEFT  = `<svg viewBox="0 0 9 9" fill="none" stroke="currentColor" stroke-width="1.2"><path d="M8 4.5H1M4 2L1 4.5 4 7"/></svg>`;
const SVG_STAR  = `<svg viewBox="0 0 9 9" fill="none" stroke="currentColor" stroke-width="1.1"><path d="M4.5 1l1 2.5H8L5.8 5l.8 2.5L4.5 6l-2.1 1.5L3.2 5 1 3.5h2.5z"/></svg>`;
const SVG_GRIP  = `<svg viewBox="0 0 8 14" fill="currentColor"><circle cx="2" cy="2" r="1"/><circle cx="6" cy="2" r="1"/><circle cx="2" cy="6" r="1"/><circle cx="6" cy="6" r="1"/><circle cx="2" cy="10" r="1"/><circle cx="6" cy="10" r="1"/></svg>`;

function badge(cat){ return `<span class="badge cat-${cat}">${CAT_LABEL[cat]||cat}</span>`; }

function fmtDue(iso) {
  if (!iso) return '';
  try {
    const [y,m,d] = iso.split('-');
    return new Date(+y,+m-1,+d).toLocaleDateString('en-US',{month:'short',day:'numeric'});
  } catch(e) { return iso; }
}

function noteCount(t) {
  return Array.isArray(t.notes) ? t.notes.length : (t.notes ? 1 : 0);
}

// ── Celebration ────────────────────────────────────────────────────────────
const CELEBRATE = ['🎉','✅','🙌','⭐','🚀','💪','🎯','🏆'];

function fireCelebration(cardEl) {
  const emoji = CELEBRATE[Math.floor(Math.random()*CELEBRATE.length)];
  const wrap  = document.createElement('div'); wrap.className='burst-wrap';
  const colors=['#639922','#97C459','#BA7517','#378ADD','#D85A30'];
  for(let i=0;i<8;i++){
    const p=document.createElement('div');
    p.style.cssText=`position:absolute;width:6px;height:6px;border-radius:50%;background:${colors[i%colors.length]};left:${20+Math.random()*60}%;top:${20+Math.random()*60}%;animation:floatUp 0.6s ease-out ${i*0.05}s forwards;`;
    wrap.appendChild(p);
  }
  const em=document.createElement('div');
  em.textContent=emoji;
  em.style.cssText='position:absolute;left:50%;top:50%;transform:translate(-50%,-50%);font-size:22px;animation:floatUp 0.8s ease-out forwards;z-index:11;';
  wrap.appendChild(em); cardEl.appendChild(wrap);
  setTimeout(()=>wrap.remove(),900);
}

function completeTask(taskId, cardEl) {
  const task=tasks.find(t=>t.id===taskId); if(!task) return;
  fireCelebration(cardEl);
  playSound(prefs.sound, prefs.volume);
  notifyIfShared(task, 'completed');
  setTimeout(()=>{
    cardEl.classList.add('card-exiting');
    setTimeout(()=>{
      tasks=tasks.filter(t=>t.id!==taskId);
      doneTasks.unshift({...task,doneAt:new Date().toLocaleDateString()});
      saveState(task.listId); updateDoneUI(); render();
      if(drawerOpen) renderDoneDrawer();
    },500);
  },700);
}

// ── Tab navigation helpers ─────────────────────────────────────────────────
function getAdjacentLists(listId) {
  const all=[...lists];
  const idx=all.findIndex(l=>l.id===listId);
  return {
    prev: idx>0 ? all[idx-1] : null,
    next: idx<all.length-1 ? all[idx+1] : null
  };
}

// ── Card builder ───────────────────────────────────────────────────────────
function makeCard(t, context) {
  const isActive = context === 'active';
  const outer    = document.createElement('div');
  outer.className  = isActive ? 'my5-card' : 'card';
  outer.dataset.id = t.id;

  // ── Determine if this is a shared list ───────────────────────────────
  const taskList   = lists.find(l => l.id === t.listId);
  const isShared   = !isActive && taskList && taskList.shared;
  const nc         = noteCount(t);
  const { prev, next } = (isActive || isShared) ? { prev:null, next:null } : getAdjacentLists(t.listId);

  // ── Actions (right side) ──────────────────────────────────────────────
  let arrows = '';
  if (isActive) {
    arrows += `<div class="ca ca-text" data-a="to-pipeline" title="Return to Pipeline">↙ Pipeline</div>`;
    arrows += `<div class="ca ca-text" data-a="to-backlog"  title="Move to Backlog">Backlog ↗</div>`;
  } else if (isShared) {
    const claimedBy = t.claimedBy || null;
    const isMine    = claimedBy === (userName || '___');
    if (isMine) {
      arrows += `<div class="ca claim-btn claimed" data-a="unclaim" title="Click to release">✋ ${userName}</div>`;
    } else if (claimedBy) {
      arrows += `<span class="claim-taken" title="${claimedBy} is working on this">🔵 ${claimedBy}</span>`;
    } else {
      arrows += `<div class="ca claim-btn" data-a="claim" title="I'm working on this">👋 On it</div>`;
    }
  } else {
    if (prev) arrows += `<div class="ca" data-a="to-prev" data-lid="${prev.id}" title="Move to ${prev.label}">${SVG_LEFT}</div>`;
    arrows += `<div class="ca my5-btn" data-a="my5" title="Move to My 5">${SVG_STAR}</div>`;
    if (next) arrows += `<div class="ca" data-a="to-next" data-lid="${next.id}" title="Move to ${next.label}">${SVG_RIGHT}</div>`;
  }

  // ── Attachment pill ───────────────────────────────────────────────────
  const attachPill = t.attachment?.url
    ? `<div class="card-attach-row"><a class="card-attachment" href="${t.attachment.url}" target="_blank" title="${t.attachment.name}">📎 ${t.attachment.name}</a></div>`
    : '';

  outer.innerHTML = `
    <div class="card-inner">
      <div class="card-handle" data-handle="${t.id}">${SVG_GRIP}</div>
      <div class="card-body" data-body="${t.id}">
        <div class="card-row1">
          <div class="card-check${t.done?' done':''}" data-check="${t.id}"></div>
          <div class="card-title" contenteditable="false" data-title="${t.id}" title="${t.title}">${t.title}</div>
          ${t.client ? `<span class="card-client" title="${t.client}">${t.client}</span>` : ''}
        </div>
        <div class="card-row2">
          <div class="card-meta">
            ${badge(t.cat)}
            <div class="ca comment-btn" data-action="quick-comment" title="Add comment">
              <svg viewBox="0 0 9 9" fill="none" stroke="currentColor" stroke-width="1.2"><path d="M4.5 1v3M3 2.5h3"/><rect x="1" y="3" width="7" height="5" rx="1"/><path d="M3 7.5L2 8.5V7.5"/></svg>
            </div>
            ${!isActive && nc ? `<span class="card-note-badge" data-action="expand">🗒 ${nc}</span>` : ''}
            ${t.sender ? `<span class="card-sender">${t.sender}</span>` : ''}
            ${t.due    ? `<span class="card-due">${fmtDue(t.due)}</span>` : ''}
          </div>
          <div class="card-actions">${arrows}</div>
        </div>
        ${attachPill}
      </div>
    </div>
    ${(!isActive) ? `<div class="card-notes-expanded" id="notes-exp-${t.id}">${renderNoteEntries(t)}</div>` : ''}`;

  // ── Drag via handle only — disabled on shared list cards ─────────────
  const handle = outer.querySelector('[data-handle]');
  if (handle && !isShared) {
    handle.addEventListener('mousedown', () => { outer.draggable = true; });
    outer.addEventListener('dragstart', e => {
      draggingId    = t.id;
      reorderDragId = !isActive ? t.id : null;
      reorderListEl = !isActive ? outer.closest('.card-list') : null;
      e.dataTransfer.effectAllowed = 'move';
      setTimeout(() => outer.classList.add('dragging'), 0);
    });
    outer.addEventListener('dragend', () => {
      outer.draggable = false;
      draggingId = reorderDragId = reorderListEl = null;
      outer.classList.remove('dragging');
      document.querySelectorAll('.drop-above,.drop-below').forEach(el => el.classList.remove('drop-above','drop-below'));
    });
  } else if (handle && isShared) {
    handle.style.cursor = 'default';
    handle.style.opacity = '0.3';
  }

  // ── Reorder within same list (not on shared lists) ───────────────────
  if (!isActive && !isShared) {
    outer.addEventListener('dragover', e => {
      if (!reorderDragId || reorderDragId === t.id) return;
      if (reorderListEl !== outer.closest('.card-list')) return;
      e.preventDefault(); e.stopPropagation();
      const mid = outer.getBoundingClientRect().top + outer.getBoundingClientRect().height / 2;
      document.querySelectorAll('.drop-above,.drop-below').forEach(el => el.classList.remove('drop-above','drop-below'));
      outer.classList.add(e.clientY < mid ? 'drop-above' : 'drop-below');
    });
    outer.addEventListener('dragleave', () => outer.classList.remove('drop-above','drop-below'));
    outer.addEventListener('drop', e => {
      if (!reorderDragId || reorderDragId === t.id) return;
      if (reorderListEl !== outer.closest('.card-list')) return;
      e.preventDefault(); e.stopPropagation();
      const mid = outer.getBoundingClientRect().top + outer.getBoundingClientRect().height / 2;
      outer.classList.remove('drop-above','drop-below');
      reorderTask(reorderDragId, t.id, e.clientY < mid ? 'before' : 'after');
    });
  }

  // ── Inline title edit ─────────────────────────────────────────────────
  const titleEl = outer.querySelector('[data-title]');
  titleEl.addEventListener('click', e => { e.stopPropagation(); titleEl.contentEditable = 'true'; titleEl.focus(); });
  titleEl.addEventListener('keydown', e => { if (e.key === 'Enter') { e.preventDefault(); titleEl.blur(); } });
  titleEl.addEventListener('blur', () => {
    titleEl.contentEditable = 'false';
    const newTitle = titleEl.textContent.trim();
    if (newTitle && newTitle !== t.title) {
      const task = tasks.find(x => x.id === t.id);
      if (task) { task.title = newTitle; saveState(task.listId); }
    } else { titleEl.textContent = t.title; }
  });

  // ── Comment button ────────────────────────────────────────────────────
  const commentBtn = outer.querySelector('[data-action="quick-comment"]');
  commentBtn.addEventListener('click', e => { e.stopPropagation(); showQuickComment(t.id, outer); });

  // ── Note badge → expand notes ─────────────────────────────────────────
  const noteBadge = outer.querySelector('[data-action="expand"]');
  if (noteBadge) {
    noteBadge.addEventListener('click', e => {
      e.stopPropagation();
      const exp = document.getElementById('notes-exp-' + t.id);
      if (exp) exp.classList.toggle('open');
    });
  }

  // ── Card body click → open editor (anything not caught above) ─────────
  const body = outer.querySelector('[data-body]');
  body.addEventListener('click', e => {
    if (e.target.closest('[data-check]'))       return;
    if (e.target.closest('[data-title]'))       return;
    if (e.target.closest('[data-a]'))           return;
    if (e.target.closest('[data-action]'))      return;
    if (e.target.closest('.quick-comment-box')) return;
    if (e.target.closest('.card-attachment'))   return;
    openModal(tasks.find(x => x.id === t.id));
  });

  // ── Checkbox ──────────────────────────────────────────────────────────
  outer.querySelector('[data-check]').addEventListener('click', e => {
    e.stopPropagation(); completeTask(t.id, outer);
  });

  // ── Movement arrows & claim ───────────────────────────────────────────
  outer.querySelectorAll('[data-a]').forEach(btn => {
    btn.addEventListener('click', e => {
      e.stopPropagation();
      const task = tasks.find(x => x.id === t.id); if (!task) return;
      const act = btn.dataset.a;
      if (act === 'my5') {
        if (tasks.filter(t => t.active).length >= 5) return;
        task.active = true; task.listId = 'pipeline';
      }
      if (act === 'to-pipeline') { task.active = false; task.listId = 'pipeline'; }
      if (act === 'to-backlog')  { task.active = false; task.listId = 'backlog'; }
      if (act === 'to-prev' || act === 'to-next') { task.listId = btn.dataset.lid; task.active = false; }
      if (act === 'claim') {
        if (!userName) { alert('Set your name in Settings first so the team knows who you are.'); return; }
        task.claimedBy = userName;
        notifyIfShared(task, 'claimed');
      }
      if (act === 'unclaim') {
        task.claimedBy = null;
        notifyIfShared(task, 'unclaimed');
      }
      saveState(task.listId); render();
    });
  });

  return outer;
}

function renderNoteEntries(t) {
  const notes = Array.isArray(t.notes) ? t.notes : (t.notes?[{ts:'',text:t.notes}]:[]);
  if (!notes.length) return '<div style="font-size:11px;color:#bbb;padding:4px 0;">No notes yet.</div>';
  return notes.map(n=>
    `<div class="note-entry"><span class="note-ts">${n.ts}</span><span class="note-text">${n.text}</span></div>`
  ).join('');
}

// ── Quick comment ──────────────────────────────────────────────────────────
function showQuickComment(taskId, cardEl) {
  // Only one open at a time
  document.querySelectorAll('.quick-comment-box').forEach(el => el.remove());

  const task = tasks.find(t => t.id === taskId); if (!task) return;
  if (!Array.isArray(task.notes)) task.notes = task.notes ? [{ts:'',text:task.notes}] : [];

  const box = document.createElement('div');
  box.className = 'quick-comment-box';
  box.innerHTML = `
    <textarea class="quick-comment-ta" placeholder="Add a comment… (Enter to save, Esc to cancel)" rows="2"></textarea>
    <div class="quick-comment-actions">
      <span class="quick-comment-cancel">Cancel</span>
      <button class="quick-comment-save">Save</button>
    </div>`;

  // Insert below card inner, above notes expanded
  const inner = cardEl.querySelector('.card-inner');
  inner.insertAdjacentElement('afterend', box);

  const ta = box.querySelector('.quick-comment-ta');
  ta.focus();

  function saveComment() {
    const text = ta.value.trim(); if (!text) { box.remove(); return; }
    const ts = (userName ? userName + ' · ' : '') + new Date().toLocaleString();
    task.notes.push({ ts, text });
    saveState(task.listId); render();
    // Re-open the note section on the refreshed card
    setTimeout(() => {
      const newCard = document.querySelector(`[data-id="${taskId}"]`);
      if (newCard) {
        const exp = document.getElementById('notes-exp-'+taskId);
        if (exp) exp.classList.add('open');
      }
    }, 50);
  }

  ta.addEventListener('keydown', e => {
    if (e.key === 'Enter' && !e.shiftKey) { e.preventDefault(); saveComment(); }
    if (e.key === 'Escape') box.remove();
  });
  box.querySelector('.quick-comment-save').addEventListener('click', saveComment);
  box.querySelector('.quick-comment-cancel').addEventListener('click', () => box.remove());
}


function reorderTask(taskId, targetId, position) {
  const listId=tasks.find(t=>t.id===taskId)?.listId; if(!listId) return;
  const inList=tasks.filter(t=>!t.active&&t.listId===listId);
  const rest   =tasks.filter(t=>t.active||t.listId!==listId);
  const from=inList.findIndex(t=>t.id===taskId);
  const to  =inList.findIndex(t=>t.id===targetId);
  if(from===-1||to===-1) return;
  const [moved]=inList.splice(from,1);
  let ins=position==='before'?to:to+(from<to?0:1);
  ins=Math.max(0,Math.min(ins,inList.length));
  inList.splice(ins,0,moved);
  tasks=[...rest,...inList];
  saveState(listId); render();
}

// ── Zone drop ──────────────────────────────────────────────────────────────
function setupZoneDrop(el, onDrop, allowReorderDrag) {
  el.addEventListener('dragover', e=>{ e.preventDefault(); el.classList.add('drag-over'); });
  el.addEventListener('dragleave',()=>el.classList.remove('drag-over'));
  el.addEventListener('drop',e=>{
    e.preventDefault(); el.classList.remove('drag-over');
    if(reorderDragId && !allowReorderDrag) return;
    onDrop(e);
  });
}

function filterTasks(arr) {
  if(!searchQ) return arr;
  const q=searchQ.toLowerCase();
  return arr.filter(t=>
    t.title.toLowerCase().includes(q)||
    (t.sender||'').toLowerCase().includes(q)||
    (t.cat||'').toLowerCase().includes(q)||
    (t.client||'').toLowerCase().includes(q)
  );
}

// ── Tab strip ──────────────────────────────────────────────────────────────
function renderTabStrip() {
  const strip=document.getElementById('tab-strip');
  const addBtn=document.getElementById('tab-add');
  strip.innerHTML='';
  lists.forEach(list=>{
    // Skip hidden shared lists
    if (list.shared && list.hidden) return;

    const count=list.id==='pipeline'
      ? tasks.filter(t=>!t.active&&t.listId==='pipeline').length
      : tasks.filter(t=>t.listId===list.id&&!t.active).length;
    const div=document.createElement('div');
    div.className='tab'+(currentTab===list.id?' active':'');
    div.dataset.tabId=list.id;
    const labelText = (list.shared ? '🌐 ' : '') + list.label;
    div.innerHTML=`<span>${labelText}</span><span class="tab-count">${count}</span>`;
    if(!list.builtin){
      const x=document.createElement('span');
      x.className='tab-close';
      x.textContent='×';
      x.title = list.shared ? 'Hide from your view' : 'Remove list';
      x.addEventListener('click',e=>{
        e.stopPropagation();
        if (list.shared) {
          // Shared: hide locally only, never touch Cloudflare
          list.hidden = true;
          saveState();
          if(currentTab===list.id) switchTab('pipeline');
          else { renderTabStrip(); render(); }
        } else {
          // Private: delete entirely
          tasks.forEach(t=>{if(t.listId===list.id)t.listId='pipeline';});
          lists=lists.filter(l=>l.id!==list.id);
          saveState();
          if(currentTab===list.id) switchTab('pipeline');
          else { renderTabStrip(); render(); }
        }
      });
      div.appendChild(x);
    }
    div.addEventListener('click',()=>switchTab(list.id));

    // Drop card onto tab to move it
    div.addEventListener('dragover',e=>{
      if(!draggingId) return;
      e.preventDefault(); div.classList.add('drag-over-tab');
    });
    div.addEventListener('dragleave',()=>div.classList.remove('drag-over-tab'));
    div.addEventListener('drop',e=>{
      e.preventDefault(); div.classList.remove('drag-over-tab');
      if(!draggingId) return;
      const task=tasks.find(t=>t.id===draggingId); if(!task) return;
      task.listId=list.id; task.active=false;
      saveState(list.id);
      if(list.id!==currentTab) switchTab(list.id); else render();
    });

    strip.appendChild(div);
  });
  strip.appendChild(addBtn);
}

// ── Done ───────────────────────────────────────────────────────────────────
function updateDoneUI() {
  const n=doneTasks.length;
  const pill=document.getElementById('done-count-pill');
  pill.textContent=n; pill.style.display=n>0?'inline':'none';
  document.getElementById('done-footer-meta').textContent=n>0?`${n} task${n!==1?'s':''} done`:'';
}

function renderDoneDrawer() {
  const list=document.getElementById('done-list'); list.innerHTML='';
  if(!doneTasks.length){list.innerHTML='<div class="done-empty">Nothing completed yet — go get some wins!</div>';return;}
  doneTasks.forEach(t=>{
    const d=document.createElement('div'); d.className='done-card';
    d.innerHTML=`<div class="done-card-title" title="${t.title}">${t.title}</div><div class="done-card-meta">${badge(t.cat)}<span class="done-when">Done ${t.doneAt}</span><span class="restore-btn" data-rid="${t.id}">restore</span></div>`;
    d.querySelector('.restore-btn').addEventListener('click',()=>{
      const restored={...t,done:false,doneAt:undefined};
      doneTasks=doneTasks.filter(x=>x.id!==t.id); tasks.push(restored);
      saveState(); updateDoneUI(); render(); renderDoneDrawer();
    });
    list.appendChild(d);
  });
}

function toggleDrawer(){
  drawerOpen=!drawerOpen;
  document.getElementById('done-drawer').classList.toggle('open',drawerOpen);
  if(drawerOpen) renderDoneDrawer();
}

// ── Views ──────────────────────────────────────────────────────────────────
function ensureView(listId) {
  if(BUILTIN_LISTS.includes(listId)) return;
  if(document.getElementById('view-'+listId)) return;
  const list=lists.find(l=>l.id===listId);
  const isShared = list && list.shared;
  const v=document.createElement('div'); v.className='view'; v.id='view-'+listId;
  v.innerHTML=`
    <div class="list-area">
      <div class="quickadd-bar">
        <input type="text" class="quickadd-input" id="quickadd-${listId}" placeholder="Quick add to ${list?list.label:'list'}… (Enter to save)">
        <button class="quickadd-btn" data-qa="${listId}">+ Add Task</button>
      </div>
      <div class="card-list" id="list-${listId}"></div>
    </div>`;
  document.getElementById('panel').insertBefore(v,document.getElementById('done-drawer'));

  // Wire quick-add bar
  wireQuickAdd(listId);

  // Add sync button to header if list is shared
  if (isShared) {
    const bar = v.querySelector('.quickadd-bar');
    if (bar) {
      const syncBtn = makeSyncBtn(listId);
      syncBtn.style.marginLeft = '4px';
      bar.appendChild(syncBtn);
    }
  }

  setupZoneDrop(v.querySelector('.card-list'),()=>{
    if(!draggingId) return;
    const task=tasks.find(t=>t.id===draggingId);
    if(task&&!isShared){task.listId=listId;task.active=false;saveState(listId);render();}
  });
}

function switchTab(id) {
  currentTab=id;
  document.querySelectorAll('.view').forEach(v=>v.classList.remove('visible'));
  ensureView(id);
  const v=document.getElementById('view-'+id); if(v) v.classList.add('visible');
  renderTabStrip(); render();
}

// ── Export / Import ─────────────────────────────────────────────────────────
function dlCSV(content, filename) {
  const blob = new Blob([content], { type: 'text/csv' });
  const url  = URL.createObjectURL(blob);
  const a    = document.createElement('a');
  a.href = url; a.download = filename; a.click();
  URL.revokeObjectURL(url);
}

// ── Data drawer ────────────────────────────────────────────────────────────
function openDataDrawer() {
  // Populate list selector
  const sel = document.getElementById('export-list-select');
  sel.innerHTML = '';
  lists.forEach(l => {
    const opt = document.createElement('option');
    opt.value = l.id;
    opt.textContent = (l.shared ? '🌐 ' : '') + l.label + ' (' + tasks.filter(t => t.listId === l.id).length + ' tasks)';
    sel.appendChild(opt);
  });
  // Default to current tab
  if (lists.find(l => l.id === currentTab)) sel.value = currentTab;

  const drawer = document.getElementById('data-drawer');
  drawer.style.display = 'flex';
  document.getElementById('data-btn').classList.add('active');
}

function closeDataDrawer() {
  document.getElementById('data-drawer').style.display = 'none';
  document.getElementById('data-btn').classList.remove('active');
}

document.getElementById('data-btn').addEventListener('click', e => {
  e.stopPropagation();
  const drawer = document.getElementById('data-drawer');
  if (drawer.style.display === 'flex') closeDataDrawer();
  else openDataDrawer();
});
document.getElementById('data-drawer-close').addEventListener('click', closeDataDrawer);

function setExportStatus(msg) {
  const el = document.getElementById('export-status');
  el.textContent = msg; el.className = 'sync-status ok';
  clearTimeout(setExportStatus._t);
  setExportStatus._t = setTimeout(() => { el.className = 'sync-status'; el.textContent = ''; }, 4000);
}
function flashBtn(btn, text) {
  const orig = btn.textContent;
  btn.textContent = text;
  setTimeout(() => { btn.textContent = orig; }, 1500);
}

document.getElementById('exp-csv-btn').addEventListener('click', () => {
  const listId = document.getElementById('export-list-select').value;
  const list   = lists.find(l => l.id === listId);
  const items  = tasks.filter(t => t.listId === listId);
  const fname  = `${list ? list.label : 'tasks'}.csv`;
  dlCSV(buildCSV(items), fname);
  flashBtn(document.getElementById('exp-csv-btn'), '✓ Done');
  setExportStatus(`✓ Downloaded ${fname} — ${items.length} task${items.length !== 1 ? 's' : ''}.`);
});

document.getElementById('exp-all-btn').addEventListener('click', () => {
  dlCSV(buildCSV(tasks), 'my5-focus-board-all.csv');
  flashBtn(document.getElementById('exp-all-btn'), '✓ Done');
  setExportStatus(`✓ Downloaded my5-focus-board-all.csv — ${tasks.length} tasks across ${lists.length} lists.`);
});

document.getElementById('exp-print-btn').addEventListener('click', () => {
  const listId = document.getElementById('export-list-select').value;
  const list   = lists.find(l => l.id === listId);
  const items  = tasks.filter(t => t.listId === listId);
  const win    = window.open('', '_blank');
  win.document.write(`<!DOCTYPE html><html><head><title>${list ? list.label : 'Tasks'}</title>
    <style>body{font-family:system-ui,sans-serif;padding:32px;max-width:600px;margin:0 auto;color:#111;}
    h1{font-size:18px;font-weight:600;margin-bottom:4px;}.meta{font-size:12px;color:#888;margin-bottom:24px;}
    .card{border:1px solid #e5e5e5;border-radius:8px;padding:12px 14px;margin-bottom:10px;}
    .title{font-size:14px;font-weight:500;margin-bottom:6px;}
    .row{display:flex;gap:10px;font-size:12px;color:#666;flex-wrap:wrap;}
    .badge{font-size:11px;padding:2px 8px;border-radius:4px;background:#f3f3f3;}
    @media print{body{padding:16px;}}</style></head><body>
    <h1>${list ? list.label : 'Tasks'}</h1>
    <div class="meta">Printed ${new Date().toLocaleDateString()} · ${items.length} items</div>
    ${items.map(t => `<div class="card">
      <div class="title">${t.title}${t.client ? ` <small>[${t.client}]</small>` : ''}</div>
      <div class="row">
        <span class="badge">${CAT_LABEL[t.cat] || t.cat}</span>
        ${t.sender ? `<span>${t.sender}</span>` : ''}
        ${t.due ? `<span>Due: ${fmtDue(t.due)}</span>` : ''}
      </div>
    </div>`).join('')}
    </body></html>`);
  win.document.close(); win.print();
});

document.getElementById('exp-copy-btn').addEventListener('click', () => {
  const listId = document.getElementById('export-list-select').value;
  const items  = tasks.filter(t => t.listId === listId);
  const text   = items.map((t, i) =>
    `${i + 1}. [${CAT_LABEL[t.cat] || t.cat}] ${t.title}` +
    `${t.client ? ' [' + t.client + ']' : ''}` +
    `${t.sender ? ' — ' + t.sender : ''}` +
    `${t.due ? ' (' + fmtDue(t.due) + ')' : ''}`
  ).join('\n');
  navigator.clipboard.writeText(text).then(() => {
    const btn = document.getElementById('exp-copy-btn');
    const orig = btn.textContent;
    btn.textContent = '✓ Copied!';
    setTimeout(() => { btn.textContent = orig; }, 1500);
  });
});

document.getElementById('import-choose-btn').addEventListener('click', () => {
  document.getElementById('data-import-file-input').click();
});

document.getElementById('data-import-file-input').addEventListener('change', function() {
  const file = this.files[0]; if (!file) return;
  const reader = new FileReader();
  reader.onload = e => {
    const result = document.getElementById('import-result');
    try {
      const count = importCSV(e.target.result);
      saveState();
      lists.filter(l => !l.builtin).forEach(l => ensureView(l.id));
      renderTabStrip(); render();
      // refresh list selector
      openDataDrawer();
      result.className = 'success'; result.style.display = 'block';
      result.textContent = `✓ Imported ${count} task${count !== 1 ? 's' : ''} successfully.`;
    } catch(err) {
      result.className = 'error'; result.style.display = 'block';
      result.textContent = 'Error: ' + err.message;
    }
    setTimeout(() => { result.style.display = 'none'; }, 5000);
  };
  reader.readAsText(file); this.value = '';
});

// ── Settings drawer ────────────────────────────────────────────────────────
function toggleSettings() {
  const drawer = document.getElementById('settings-drawer');
  const btn    = document.getElementById('settings-btn');
  const open   = drawer.classList.toggle('open');
  btn.classList.toggle('active', open);
}

document.getElementById('settings-btn').addEventListener('click', e => { e.stopPropagation(); toggleSettings(); });
document.getElementById('settings-close').addEventListener('click', toggleSettings);

// Export / Import via settings — one implementation, lives in the data drawer
document.getElementById('s-open-data').addEventListener('click', () => {
  toggleSettings();   // close settings
  openDataDrawer();   // open the Export/Import drawer
});

// Clear completed via settings
document.getElementById('s-clear-done').addEventListener('click', () => {
  if (!doneTasks.length) return;
  doneTasks = []; saveState(); updateDoneUI(); renderDoneDrawer();
  let result = document.getElementById('settings-import-result');
  if (!result) {
    result = document.createElement('div');
    result.id = 'settings-import-result';
    result.className = 'settings-import-result';
    document.getElementById('s-clear-done').insertAdjacentElement('afterend', result);
  }
  result.className = 'settings-import-result success';
  result.style.display = 'block';
  result.textContent = '✓ Completed tasks cleared.';
  setTimeout(() => { result.style.display = 'none'; }, 3000);
});


// ── Sync engine ────────────────────────────────────────────────────────────
function syncReady() {
  return !!(syncConfig.team && workerConfigured());
}

function syncHeaders() {
  return { 'Content-Type': 'application/json', 'X-Team-Code': syncConfig.team };
}

async function syncPush(list) {
  if (!syncReady() || !list) return;
  const listTasks = tasks.filter(t => t.listId === list.id);
  console.log('[Sync] Pushing', listTasks.length, 'tasks for list:', list.label);
  try {
    const res = await fetch(`${workerUrl()}/lists/${list.id}`, {
      method: 'POST',
      headers: syncHeaders(),
      body: JSON.stringify({ tasks: listTasks, listLabel: list.label, updatedBy: syncConfig.team })
    });
    const data = await res.json();
    console.log('[Sync] Push response:', data);
    if (!res.ok) console.warn('[Sync] Push failed:', res.status, data);
  } catch(e) { console.warn('[Sync] Push error:', e); }
}

async function syncPull(listId) {
  if (!syncReady()) return null;
  try {
    const res = await fetch(`${workerUrl()}/lists/${listId}`, { headers: syncHeaders() });
    if (!res.ok) { console.warn('[Sync] Pull returned', res.status); return null; }
    const data = await res.json();
    console.log('[Sync] Pull raw response for', listId, ':', data);
    return data;
  } catch(e) { console.warn('[Sync] Pull error:', e); return null; }
}

async function syncPullList(list) {
  const data = await syncPull(list.id);
  if (!data || !Array.isArray(data.tasks)) {
    console.warn('[Sync] No tasks array in response for', list.id, data);
    return false;
  }
  console.log('[Sync] Merging', data.tasks.length, 'tasks for', list.label);
  tasks = tasks.filter(t => t.listId !== list.id);
  data.tasks.forEach(t => tasks.push(t));
  return true;
}

async function syncDiscoverLists() {
  if (!syncReady()) return false;
  try {
    console.log('[Sync] Discovering lists for team:', syncConfig.team);
    const res = await fetch(`${workerUrl()}/lists`, { headers: syncHeaders() });
    if (!res.ok) { console.warn('[Sync] /lists returned', res.status); return false; }
    const data = await res.json();
    console.log('[Sync] Team index:', data);
    if (!Array.isArray(data.lists) || !data.lists.length) return false;

    let added = false;
    for (const remote of data.lists) {
      if (lists.find(l => l.id === remote.id)) continue;
      console.log('[Sync] Discovered new list:', remote.label);
      lists.push({ id: remote.id, label: remote.label, builtin: false, shared: true });
      ensureView(remote.id);
      added = true;
    }
    if (added) { saveState(); renderTabStrip(); }
    return added;
  } catch(e) { console.warn('[Sync] syncDiscoverLists error:', e); return false; }
}

async function syncPullAll() {
  if (!syncReady()) { console.log('[Sync] Not ready — no URL or team code'); return; }
  await syncDiscoverLists();
  const sharedLists = lists.filter(l => l.shared);
  console.log('[Sync] Pulling', sharedLists.length, 'shared lists');
  if (!sharedLists.length) return;
  let changed = false;
  for (const list of sharedLists) {
    console.log('[Sync] Pulling list:', list.label, list.id);
    const ok = await syncPullList(list);
    console.log('[Sync] Pull result for', list.label, ':', ok);
    if (ok) changed = true;
  }
  if (changed) {
    saveState();
    switchTab(currentTab); // force full DOM rebuild
  }
}

async function syncFullList(listId) {
  const list = lists.find(l => l.id === listId);
  if (!list || !syncReady()) return;
  await syncPush(list);
  const ok = await syncPullList(list);
  if (ok) {
    saveState();
    if (currentTab === listId) switchTab(listId);
    else render();
  }
}

// ── Teams notifications ────────────────────────────────────────────────────
async function notify(type, taskTitle, listLabel) {
  if (!syncReady()) return;
  try {
    await fetch(`${workerUrl()}/notify`, {
      method: 'POST',
      headers: syncHeaders(),
      body: JSON.stringify({
        type,
        who:       userName || 'Someone',
        taskTitle: taskTitle || '',
        listLabel: listLabel || '',
      })
    });
  } catch(e) { console.warn('[Notify] error:', e); }
}

function notifyIfShared(taskOrId, type) {
  const task = typeof taskOrId === 'object' ? taskOrId : tasks.find(t => t.id === taskOrId);
  if (!task) return;
  const list = lists.find(l => l.id === task.listId);
  if (!list || !list.shared) return;
  notify(type, task.title, list.label);
}


function startSyncTimer() {
  stopSyncTimer();
  const secs = parseInt(syncConfig.interval) || 0;
  if (!secs || (!syncReady() && !personalReady())) return;
  syncTimer = setInterval(async () => {
    console.log('[Sync] Auto-pull…');
    if (syncReady())     await syncPullAll();
    if (personalReady()) await personalTick();
  }, secs * 1000);
  console.log('[Sync] Auto-sync every', secs, 'seconds');
}

function stopSyncTimer() {
  if (syncTimer) { clearInterval(syncTimer); syncTimer = null; }
}

// ── Sync UI wiring ─────────────────────────────────────────────────────────
function setSyncStatus(msg, type) {
  const el = document.getElementById('sync-status');
  el.textContent = msg; el.className = 'sync-status ' + type;
}
function setAdminStatus(msg, type) {
  const el = document.getElementById('admin-status');
  el.textContent = msg; el.className = 'sync-status ' + type;
}
function setWebhookStatus(msg, type) {
  const el = document.getElementById('webhook-status');
  el.textContent = msg; el.className = 'sync-status ' + type;
}

function isAdmin() {
  return !!(syncConfig.adminCode && syncConfig.adminCode.length >= 6);
}

function adminHeaders() {
  const h = syncHeaders();
  if (syncConfig.adminCode) h['X-Admin-Code'] = syncConfig.adminCode;
  return h;
}

async function renderTeamListsPanel(teamLists) {
  const body      = document.getElementById('team-lists-body');
  const label     = document.getElementById('team-lists-label');
  const adminLabel = document.getElementById('admin-section-label');
  const adminBody  = document.getElementById('admin-setup-body');

  body.innerHTML = '';

  if (!teamLists || !teamLists.length) {
    label.style.display = 'block';
    body.innerHTML = '<div style="padding:8px 16px 10px;font-size:12px;color:#aaa;">No shared lists yet.</div>';
  } else {
    label.style.display = 'block';
    teamLists.forEach(remote => {
      const isVisible = !!lists.find(l => l.id === remote.id && !l.hidden);
      const row = document.createElement('div');
      row.className = 'team-list-row';
      row.innerHTML = `
        <span class="team-list-globe">🌐</span>
        <span class="team-list-name">${remote.label}</span>
        <span class="team-list-count">${remote.count || 0} tasks</span>
        <div class="team-list-actions">
          <button class="tl-toggle ${isVisible?'visible':'hidden'}" data-lid="${remote.id}">
            ${isVisible ? '👁 Visible' : '○ Hidden'}
          </button>
          ${isAdmin() ? `
            <button class="tl-convert" data-lid="${remote.id}" data-label="${remote.label}" title="Remove from team sync — keeps tasks locally">→ Private</button>
            <button class="tl-delete" data-lid="${remote.id}" data-label="${remote.label}">Delete</button>
          ` : ''}
        </div>`;

      // Toggle visible/hidden
      row.querySelector('.tl-toggle').addEventListener('click', () => {
        const existing = lists.find(l => l.id === remote.id);
        if (existing) {
          existing.hidden = !existing.hidden;
        } else {
          lists.push({ id: remote.id, label: remote.label, builtin: false, shared: true, hidden: false });
          ensureView(remote.id);
        }
        saveState(); renderTabStrip(); render();
        renderTeamListsPanel(teamLists);
      });

      // Convert to private (admin only)
      const convertBtn = row.querySelector('.tl-convert');
      if (convertBtn) {
        convertBtn.addEventListener('click', async () => {
          const label = convertBtn.dataset.label;
          const lid   = convertBtn.dataset.lid;
          if (!confirm(`Remove "${label}" from team sync?\n\nTasks already on your device stay. Other team members will lose access on their next sync.\n\nThis also deletes the list from Cloudflare.`)) return;
          convertBtn.textContent = '…';
          try {
            // Delete from Cloudflare
            const res = await fetch(`${workerUrl()}/lists/${lid}`, {
              method: 'DELETE', headers: adminHeaders()
            });
            const data = await res.json();
            if (data.ok || data.error) { // proceed even if already gone
              // Convert locally: mark as private, keep tasks
              const localList = lists.find(l => l.id === lid);
              if (localList) {
                localList.shared = false;
                localList.hidden = false;
              }
              saveState(); renderTabStrip(); render();
              await loadTeamLists();
            } else {
              alert('Error: ' + (data.error || 'unknown'));
              convertBtn.textContent = '→ Private';
            }
          } catch(e) { alert('Error: ' + e.message); convertBtn.textContent = '→ Private'; }
        });
      }

      // Delete (admin only)
      const delBtn = row.querySelector('.tl-delete');
      if (delBtn) {
        delBtn.addEventListener('click', async () => {
          const label = delBtn.dataset.label;
          if (!confirm(`Permanently delete "${label}" and all its tasks for the entire team? This cannot be undone.`)) return;
          delBtn.textContent = '…';
          try {
            const res = await fetch(`${workerUrl()}/lists/${remote.id}`, {
              method: 'DELETE', headers: adminHeaders()
            });
            const data = await res.json();
            if (data.ok) {
              // Remove locally
              lists = lists.filter(l => l.id !== remote.id);
              tasks = tasks.filter(t => t.listId !== remote.id);
              saveState(); renderTabStrip(); render();
              await loadTeamLists(); // refresh panel
            } else {
              alert('Delete failed: ' + (data.error || 'unknown error'));
              delBtn.textContent = 'Delete';
            }
          } catch(e) { alert('Delete error: ' + e.message); delBtn.textContent = 'Delete'; }
        });
      }

      body.appendChild(row);
    });
  }

  // Admin section (shared list creation now lives in the + tab button)
  adminLabel.style.display = 'block';
  adminBody.style.display  = 'block';
}

async function loadTeamLists() {
  if (!syncReady()) return;
  try {
    const res = await fetch(`${workerUrl()}/lists`, { headers: syncHeaders() });
    if (!res.ok) return;
    const data = await res.json();
    await renderTeamListsPanel(data.lists || []);
  } catch(e) { console.warn('loadTeamLists error:', e); }
}

// ── Team connect panel (Start / Join) ──────────────────────────────────────
function inviteMessage() {
  return `Join my team on My5 Focus Board!\n\n1. Open the My5 Focus Board side panel\n2. Gear icon → Team → paste this code → Join\n\nInvite code: ${syncConfig.team}`;
}

function renderTeamConnectPanel() {
  const notConnected = document.getElementById('team-not-connected');
  const connected    = document.getElementById('team-connected');
  if (!notConnected || !connected) return;
  const isConnected = !!syncConfig.team;
  notConnected.style.display = isConnected ? 'none' : 'block';
  connected.style.display    = isConnected ? 'block' : 'none';
  if (isConnected) {
    document.getElementById('connected-team-name').textContent  = currentTeamName();
    document.getElementById('connected-invite-code').textContent = syncConfig.team;
    document.getElementById('connected-admin-badge').style.display = isAdmin() ? 'inline-block' : 'none';
  }
  const warn = document.getElementById('worker-url-warning');
  if (warn) warn.style.display = workerConfigured() ? 'none' : 'block';
}

async function createTeamFlow() {
  if (!workerConfigured()) { setSyncStatus('Set DEFAULT_WORKER_URL in panel.js first (one-time setup).', 'error'); return; }
  const btn = document.getElementById('start-team-btn');
  btn.disabled = true; btn.textContent = 'Creating…';
  setSyncStatus('Creating your team…', 'info');
  try {
    // Find a free team code (hasAdmin = taken)
    let team = null;
    for (let i = 0; i < 5; i++) {
      const candidate = randCode(8);
      const res  = await fetch(`${workerUrl()}/ping`, { headers: { 'Content-Type':'application/json', 'X-Team-Code': candidate } });
      const data = await res.json();
      if (data.ok && !data.hasAdmin) { team = candidate; break; }
    }
    if (!team) throw new Error('Could not generate a team code. Try again.');

    // Claim it: set the admin code (auto-generated, stored silently)
    const adminCode = randCode(12);
    const res = await fetch(`${workerUrl()}/admin/setup`, {
      method: 'POST',
      headers: { 'Content-Type':'application/json', 'X-Team-Code': team, 'X-Admin-Code': adminCode },
      body: JSON.stringify({ adminCode })
    });
    const data = await res.json();
    if (!data.ok) throw new Error(data.error || 'Worker rejected team creation');

    // Wire it up locally
    syncConfig.team = team; syncConfig.adminCode = adminCode; syncConfig.url = workerUrl();
    const nickname = (document.getElementById('new-team-name').value.trim()) || 'My Team';
    const exists = savedTeams.find(t => t.team === team);
    if (!exists) savedTeams.push({ name: nickname, url: workerUrl(), team, adminCode });
    saveSyncConfig();
    document.getElementById('new-team-name').value = '';
    renderTeamSwitcher(); renderSavedTeamsList(); renderTeamConnectPanel();
    startSyncTimer();
    await loadTeamLists();
    setSyncStatus('✓ Team created! Copy the invite code below and send it to your team.', 'ok');
  } catch (e) {
    setSyncStatus('Error: ' + e.message, 'error');
  }
  btn.disabled = false; btn.textContent = '🚀 Start a team';
}

async function joinTeamFlow() {
  if (!workerConfigured()) { setSyncStatus('Set DEFAULT_WORKER_URL in panel.js first (one-time setup).', 'error'); return; }
  const input = document.getElementById('join-code-input');
  const code  = input.value.trim().toUpperCase().replace(/\s+/g, '');
  if (!code) { setSyncStatus('Paste the invite code you were sent.', 'error'); return; }
  const btn = document.getElementById('join-team-btn');
  btn.disabled = true; btn.textContent = '…';
  setSyncStatus('Checking code…', 'info');
  try {
    const res  = await fetch(`${workerUrl()}/ping`, { headers: { 'Content-Type':'application/json', 'X-Team-Code': code } });
    const data = await res.json();
    if (!data.ok) throw new Error(data.error || 'Could not reach the Worker');
    if (!data.hasAdmin) throw new Error('No team found with that code — double-check it with whoever sent it.');

    syncConfig.team = code; syncConfig.adminCode = ''; syncConfig.url = workerUrl();
    if (!savedTeams.find(t => t.team === code)) savedTeams.push({ name: code, url: workerUrl(), team: code, adminCode: '' });
    saveSyncConfig();
    input.value = '';
    renderTeamSwitcher(); renderSavedTeamsList(); renderTeamConnectPanel();
    setSyncStatus('✓ Joined! Loading team lists…', 'info');
    await syncPullAll();
    startSyncTimer();
    await loadTeamLists();
    renderTabStrip(); render();
    setSyncStatus('✓ You\'re in — team lists are on your tab strip.', 'ok');
  } catch (e) {
    setSyncStatus('Error: ' + e.message, 'error');
  }
  btn.disabled = false; btn.textContent = 'Join';
}

function wireSettingsSync() {
  document.getElementById('sync-url').value      = (syncConfig.url && syncConfig.url !== DEFAULT_WORKER_URL) ? syncConfig.url : '';
  document.getElementById('sync-interval').value = String(syncConfig.interval || 120);
  document.getElementById('settings-name').value = userName || '';
  renderTeamConnectPanel();

  // Save name
  document.getElementById('save-name-btn').addEventListener('click', () => {
    userName = document.getElementById('settings-name').value.trim();
    saveSyncConfig();
    const el = document.getElementById('name-status');
    el.textContent = userName ? `✓ Comments will show as "${userName}"` : '✓ Name cleared';
    el.className = 'sync-status ok';
    setTimeout(() => { el.className = 'sync-status'; el.textContent = ''; }, 3000);
  });

  // Populate webhook field if we know it's set
  if (syncReady()) {
    fetch(`${workerUrl()}/ping`, { headers: adminHeaders() })
      .then(r => r.json())
      .then(d => {
        if (d.hasWebhook) {
          document.getElementById('admin-webhook').placeholder = 'Webhook configured ✓ (paste new URL to change)';
        }
      }).catch(()=>{});
  }

  document.getElementById('webhook-save-btn').addEventListener('click', async () => {
    const webhookUrl = document.getElementById('admin-webhook').value.trim();
    if (!syncReady()) { setWebhookStatus('Connect to a team first.', 'error'); return; }
    setWebhookStatus('Saving…', 'info');
    try {
      const res  = await fetch(`${workerUrl()}/admin/webhook`, {
        method: 'POST', headers: adminHeaders(),
        body: JSON.stringify({ webhookUrl })
      });
      const data = await res.json();
      if (data.ok) {
        setWebhookStatus(webhookUrl ? '✓ Webhook saved. Notifications enabled.' : '✓ Webhook removed.', 'ok');
        document.getElementById('admin-webhook').value = '';
      } else {
        setWebhookStatus('Error: ' + (data.error || 'unknown'), 'error');
      }
    } catch(e) { setWebhookStatus('Error: ' + e.message, 'error'); }
  });

  document.getElementById('webhook-test-btn').addEventListener('click', async () => {
    if (!syncReady()) { setWebhookStatus('Connect to a team first.', 'error'); return; }
    setWebhookStatus('Sending test…', 'info');
    try {
      const res  = await fetch(`${workerUrl()}/notify`, {
        method: 'POST', headers: syncHeaders(),
        body: JSON.stringify({
          type: 'added', who: userName || 'My5 Focus Board',
          taskTitle: 'Test notification', listLabel: 'Test List'
        })
      });
      const data = await res.json();
      if (data.ok) setWebhookStatus('✓ Test sent — check your Teams channel.', 'ok');
      else setWebhookStatus('Error: ' + (data.error || 'unknown'), 'error');
    } catch(e) { setWebhookStatus('Error: ' + e.message, 'error'); }
  });

  // Device sync
  renderPersonalSyncPanel();
  document.getElementById('ps-create-btn').addEventListener('click', setupPersonalSync);
  document.getElementById('ps-link-btn').addEventListener('click', linkPersonalSync);
  document.getElementById('ps-link-input').addEventListener('keydown', e => { if (e.key === 'Enter') linkPersonalSync(); });
  document.getElementById('ps-copy-btn').addEventListener('click', async () => {
    const btn = document.getElementById('ps-copy-btn');
    try { await navigator.clipboard.writeText(personalSync.code); btn.textContent = '✓ Copied'; }
    catch(e) { btn.textContent = personalSync.code; }
    setTimeout(() => { btn.textContent = '📋 Copy code'; }, 2000);
  });
  document.getElementById('ps-sync-now-btn').addEventListener('click', async () => {
    const btn = document.getElementById('ps-sync-now-btn');
    btn.textContent = '…';
    await personalTick();
    btn.textContent = '↻ Sync now';
    setPsStatus('✓ Synced.', 'ok');
  });
  document.getElementById('ps-off-btn').addEventListener('click', () => {
    if (!confirm('Turn off device sync on THIS device?\n\nYour board stays on this device and stays synced on your other devices. You can re-link anytime with your code:\n\n' + personalSync.code)) return;
    personalSync = { code: '', adminCode: '' };
    saveSyncConfig();
    renderPersonalSyncPanel();
    startSyncTimer();
    setPsStatus('Device sync turned off on this device.', 'info');
  });

  // Start / Join
  document.getElementById('start-team-btn').addEventListener('click', createTeamFlow);
  document.getElementById('join-team-btn').addEventListener('click', joinTeamFlow);
  document.getElementById('join-code-input').addEventListener('keydown', e => {
    if (e.key === 'Enter') joinTeamFlow();
  });

  // Copy invite
  document.getElementById('copy-invite-btn').addEventListener('click', async () => {
    const btn = document.getElementById('copy-invite-btn');
    try {
      await navigator.clipboard.writeText(inviteMessage());
      btn.textContent = '✓ Copied — paste it in Teams';
    } catch(e) {
      // Fallback: select the code text
      const codeEl = document.getElementById('connected-invite-code');
      const range = document.createRange(); range.selectNodeContents(codeEl);
      const sel = window.getSelection(); sel.removeAllRanges(); sel.addRange(range);
      btn.textContent = 'Press Ctrl+C to copy';
    }
    setTimeout(() => { btn.textContent = '📋 Copy invite'; }, 2500);
  });

  // Switch back to Personal
  document.getElementById('leave-team-btn').addEventListener('click', async () => {
    await switchToTeam({ name:'Personal', url:'', team:'', adminCode:'' });
    renderTeamConnectPanel();
    setSyncStatus('Switched to Personal. Your team is still saved in the switcher.', 'info');
  });

  // Auto-sync interval saves on change (no Save button needed)
  document.getElementById('sync-interval').addEventListener('change', () => {
    syncConfig.interval = parseInt(document.getElementById('sync-interval').value) || 0;
    saveSyncConfig();
    startSyncTimer();
    setSyncStatus('✓ Auto-sync updated.', 'ok');
  });

  // Advanced: Worker URL override
  document.getElementById('sync-url-save-btn').addEventListener('click', () => {
    const v = document.getElementById('sync-url').value.trim().replace(/\/$/, '');
    syncConfig.url = v; // blank = use built-in DEFAULT_WORKER_URL
    saveSyncConfig();
    renderTeamConnectPanel();
    setSyncStatus(v ? '✓ Using custom Worker URL.' : '✓ Using built-in Worker URL.', 'ok');
  });

  document.getElementById('admin-set-btn').addEventListener('click', async () => {
    const newCode = document.getElementById('admin-new-code').value.trim();
    if (!newCode || newCode.length < 6) { setAdminStatus('Admin code must be at least 6 characters.', 'error'); return; }
    if (!syncReady()) { setAdminStatus('Connect to a team first.', 'error'); return; }
    setAdminStatus('Setting…', 'info');
    try {
      const res = await fetch(`${workerUrl()}/admin/setup`, {
        method: 'POST', headers: adminHeaders(),
        body: JSON.stringify({ adminCode: newCode })
      });
      const data = await res.json();
      if (data.ok) {
        syncConfig.adminCode = newCode;
        const saved = savedTeams.find(t => t.team === syncConfig.team);
        if (saved) saved.adminCode = newCode;
        saveSyncConfig();
        document.getElementById('admin-new-code').value = '';
        setAdminStatus('✓ Admin code set. You are now the admin.', 'ok');
        renderTeamConnectPanel();
        await loadTeamLists();
      } else { setAdminStatus('Error: ' + (data.error || 'unknown'), 'error'); }
    } catch(e) { setAdminStatus('Error: ' + e.message, 'error'); }
  });

  if (syncReady()) loadTeamLists();
}

// Create a shared list on Cloudflare and add it locally (used by the + modal).
// Uses the plain push endpoint (team code only), so ANY team member can create
// shared lists — admin is only needed for destructive actions (delete/convert).
async function createSharedList(label) {
  const id = 'shared-' + label.toLowerCase().replace(/[^a-z0-9]/g, '-') + '-' + Date.now();
  const res  = await fetch(`${workerUrl()}/lists/${id}`, {
    method: 'POST', headers: syncHeaders(),
    body: JSON.stringify({ tasks: [], listLabel: label, updatedBy: userName || syncConfig.team })
  });
  const data = await res.json();
  if (!data.ok) throw new Error(data.error || 'unknown');
  if (!lists.find(l => l.id === id)) {
    lists.push({ id, label, builtin: false, shared: true, hidden: false });
    ensureView(id);
    saveState(); renderTabStrip(); render();
  }
  return id;
}

// ── Device sync (personal board across devices) ─────────────────────────────
// Your whole personal board — My 5, Pipeline, Backlog, private lists, done
// tasks — syncs as ONE blob to a private space on the Worker, keyed by a
// personal code. Completely separate from shared team lists. Last write wins.
const PERSONAL_LIST_ID = 'personal-board';

function personalReady() {
  return !!(personalSync.code && workerConfigured());
}
function personalHeaders() {
  return { 'Content-Type': 'application/json', 'X-Team-Code': personalSync.code };
}

// Snapshot everything that is NOT a shared team list
function personalState() {
  const pl    = lists.filter(l => !l.shared);
  const plIds = new Set(pl.map(l => l.id));
  return {
    savedAt: Date.now(),
    lists: pl,
    tasks: tasks.filter(t => plIds.has(t.listId)),
    doneTasks, nextId, nextListId
  };
}

// Replace local personal data with a remote snapshot (shared lists untouched)
function applyPersonalState(st) {
  suppressPersonalPush = true;
  try {
    const sharedLists = lists.filter(l => l.shared);
    const sharedIds   = new Set(sharedLists.map(l => l.id));
    lists = [ ...(st.lists || []).filter(l => !l.shared), ...sharedLists ];
    tasks = [ ...(st.tasks || []), ...tasks.filter(t => sharedIds.has(t.listId)) ];
    doneTasks  = st.doneTasks || [];
    nextId     = Math.max(nextId,     st.nextId     || 1);
    nextListId = Math.max(nextListId, st.nextListId || 1);
    if (!lists.find(l => l.id === currentTab)) currentTab = 'pipeline';
    lists.filter(l => !l.builtin).forEach(l => ensureView(l.id));
    personalLastSaved = st.savedAt || Date.now();
    saveState();
    renderTabStrip();
    switchTab(currentTab); // full DOM rebuild
    updateDoneUI();
  } finally {
    suppressPersonalPush = false;
  }
}

function schedulePersonalPush() {
  clearTimeout(personalPushTimer);
  personalPushTimer = setTimeout(() => { personalPush(); }, 2500);
}

async function personalPush() {
  if (!personalReady()) return;
  const state = personalState();
  personalLastSaved = state.savedAt;
  try {
    await fetch(`${workerUrl()}/lists/${PERSONAL_LIST_ID}`, {
      method: 'POST', headers: personalHeaders(),
      body: JSON.stringify({ tasks: [{ board: true, state }], listLabel: 'Personal Board', updatedBy: 'device-sync' })
    });
    console.log('[DeviceSync] Pushed personal board', state.tasks.length, 'tasks');
    renderPersonalSyncPanel();
  } catch(e) { console.warn('[DeviceSync] Push failed:', e.message); }
}

// Returns the remote snapshot or null
async function personalFetchRemote() {
  const res = await fetch(`${workerUrl()}/lists/${PERSONAL_LIST_ID}`, { headers: personalHeaders() });
  if (!res.ok) return null;
  const data = await res.json();
  const t = data.tasks && data.tasks[0];
  return (t && t.board && t.state) ? t.state : null;
}

// Reconcile: newer side wins the whole board
async function personalTick() {
  if (!personalReady()) return;
  try {
    const remote = await personalFetchRemote();
    if (!remote) { await personalPush(); return; }
    if (remote.savedAt > personalLastSaved) {
      console.log('[DeviceSync] Remote board is newer — applying');
      applyPersonalState(remote);
    } else if (remote.savedAt < personalLastSaved) {
      await personalPush();
    }
  } catch(e) { console.warn('[DeviceSync] Tick failed:', e.message); }
}

// First device: create the private space and push this board up
async function setupPersonalSync() {
  const btn = document.getElementById('ps-create-btn');
  btn.disabled = true; btn.textContent = 'Setting up…';
  setPsStatus('Creating your private sync space…', 'info');
  try {
    // Find a free code (same free-check as teams: hasAdmin = taken)
    let code = null;
    for (let i = 0; i < 5; i++) {
      const candidate = randCode(8);
      const res  = await fetch(`${workerUrl()}/ping`, { headers: { 'Content-Type':'application/json', 'X-Team-Code': candidate } });
      const data = await res.json();
      if (data.ok && !data.hasAdmin) { code = candidate; break; }
    }
    if (!code) throw new Error('Could not generate a code. Try again.');
    const adminCode = randCode(12);
    let res = await fetch(`${workerUrl()}/admin/setup`, {
      method: 'POST',
      headers: { 'Content-Type':'application/json', 'X-Team-Code': code, 'X-Admin-Code': adminCode },
      body: JSON.stringify({ adminCode })
    });
    let data = await res.json();
    if (!data.ok) throw new Error(data.error || 'setup failed');
    // Create the single board container in that space
    res = await fetch(`${workerUrl()}/admin/list`, {
      method: 'POST',
      headers: { 'Content-Type':'application/json', 'X-Team-Code': code, 'X-Admin-Code': adminCode },
      body: JSON.stringify({ id: PERSONAL_LIST_ID, label: 'Personal Board' })
    });
    data = await res.json();
    if (!data.ok) throw new Error(data.error || 'could not create board container');

    personalSync = { code, adminCode };
    saveSyncConfig();
    await personalPush();
    renderPersonalSyncPanel();
    setPsStatus('✓ Device sync is on. Enter the code below on your other devices.', 'ok');
  } catch(e) {
    setPsStatus('Error: ' + e.message, 'error');
  }
  btn.disabled = false; btn.textContent = '🔄 Sync this board across my devices';
}

// Other devices: link with the code — the synced board replaces this device's
async function linkPersonalSync() {
  const input = document.getElementById('ps-link-input');
  const code  = input.value.trim().toUpperCase().replace(/\s+/g, '');
  if (!code) { setPsStatus('Enter your device sync code.', 'error'); return; }
  const btn = document.getElementById('ps-link-btn');
  btn.disabled = true; btn.textContent = '…';
  setPsStatus('Checking code…', 'info');
  try {
    const res  = await fetch(`${workerUrl()}/ping`, { headers: { 'Content-Type':'application/json', 'X-Team-Code': code } });
    const data = await res.json();
    if (!data.ok || !data.hasAdmin) throw new Error('No synced board found with that code.');

    personalSync = { code, adminCode: '' };
    const remote = await personalFetchRemote();
    if (remote) {
      const localCount = personalState().tasks.length;
      if (localCount > 0 && !confirm(`Link this device?\n\nYour synced board (${(remote.tasks||[]).length} tasks) will REPLACE this device's personal board (${localCount} tasks).\n\nShared team lists are not affected.`)) {
        personalSync = { code: '', adminCode: '' };
        btn.disabled = false; btn.textContent = 'Link';
        setPsStatus('Cancelled — nothing changed.', 'info');
        return;
      }
      saveSyncConfig();
      applyPersonalState(remote);
      setPsStatus('✓ Linked! Your board is now synced on this device.', 'ok');
    } else {
      // Space exists but no board yet — push this device's board up
      saveSyncConfig();
      await personalPush();
      setPsStatus('✓ Linked! This device\'s board is now the synced board.', 'ok');
    }
    input.value = '';
    renderPersonalSyncPanel();
  } catch(e) {
    personalSync = { code: '', adminCode: '' };
    setPsStatus('Error: ' + e.message, 'error');
  }
  btn.disabled = false; btn.textContent = 'Link';
}

function setPsStatus(msg, type) {
  const el = document.getElementById('ps-status');
  if (el) { el.textContent = msg; el.className = 'sync-status ' + type; }
}

function renderPersonalSyncPanel() {
  const off = document.getElementById('ps-off');
  const on  = document.getElementById('ps-on');
  if (!off || !on) return;
  const active = !!personalSync.code;
  off.style.display = active ? 'none' : 'block';
  on.style.display  = active ? 'block' : 'none';
  if (active) {
    document.getElementById('ps-code').textContent = personalSync.code;
    const st = personalState();
    document.getElementById('ps-summary').textContent =
      `${st.lists.length} lists · ${st.tasks.length} tasks syncing`;
  }
}


function makeSyncBtn(listId) {
  const btn = document.createElement('button');
  btn.className = 'sync-list-btn';
  btn.dataset.syncBtn = listId;
  btn.textContent = '↻ Sync';
  btn.addEventListener('click', async () => {
    btn.textContent = '…';
    btn.classList.add('syncing');
    // Full sync: discover new lists + push + pull this list
    await syncDiscoverLists();
    await syncFullList(listId);
    btn.textContent = '↻ Sync';
    btn.classList.remove('syncing');
  });
  return btn;
}

// ── Remove old broken sync code (stubs) ───────────────────────────────────
function saveStateAndSync() {} // no longer used
function syncAndSave() {}      // no longer used

// ── Attachment helpers ─────────────────────────────────────────────────────
let pendingAttachment = null; // { name, url }

function setAttachPreview(attach) {
  pendingAttachment = attach || null;
  const preview  = document.getElementById('attach-preview');
  const nameEl   = document.getElementById('attach-preview-name');
  const urlInput = document.getElementById('f-attach-url');
  if (attach && attach.url) {
    if (preview) preview.style.display = 'flex';
    if (nameEl)  nameEl.textContent = attach.name || 'Attachment';
    if (urlInput) urlInput.value = attach.url;
  } else {
    if (preview) preview.style.display = 'none';
    if (urlInput) urlInput.value = '';
  }
}

function getAttachmentFromModal() {
  const url = document.getElementById('f-attach-url').value.trim();
  if (!url) return null;
  const name = pendingAttachment?.name ||
    decodeURIComponent(url.split('/').pop().split('?')[0]) || 'Attachment';
  return { name, url };
}

function setupAttachmentDropZone() {
  const urlInput = document.getElementById('f-attach-url');
  if (!urlInput) return;

  urlInput.addEventListener('input', () => {
    const url = urlInput.value.trim();
    if (url) {
      const name = decodeURIComponent(url.split('/').pop().split('?')[0]) || 'Attachment';
      pendingAttachment = { name, url };
      document.getElementById('attach-preview-name').textContent = name;
      document.getElementById('attach-preview').style.display = 'flex';
    } else {
      pendingAttachment = null;
      document.getElementById('attach-preview').style.display = 'none';
    }
    autoSave();
  });

  const removeBtn = document.getElementById('attach-remove');
  if (removeBtn) {
    removeBtn.addEventListener('click', e => {
      e.stopPropagation();
      urlInput.value = '';
      pendingAttachment = null;
      document.getElementById('attach-preview').style.display = 'none';
      autoSave();
    });
  }
}

// ── Modal ──────────────────────────────────────────────────────────────────
function buildCatGrid(selected){
  const grid=document.getElementById('cat-grid'); grid.innerHTML='';
  CATS.forEach(c=>{
    const btn=document.createElement('button');
    btn.className='cpill cat-'+c+(c===selected?' sel':'');
    btn.textContent=CAT_LABEL[c];
    btn.addEventListener('click',()=>{selectedCat=c;buildCatGrid(c);autoSave();});
    grid.appendChild(btn);
  });
}

function buildListSelect(defaultList){
  const sel=document.getElementById('f-list'); sel.innerHTML='';
  lists.forEach(l=>{
    const opt=document.createElement('option');
    opt.value=l.id; opt.textContent=l.label;
    if(l.id===defaultList) opt.selected=true;
    sel.appendChild(opt);
  });
}

function autoSave() {
  if(editingId===null) return;
  const task=tasks.find(t=>t.id===editingId); if(!task) return;
  task.title      = document.getElementById('f-title').value.trim()  || task.title;
  task.cat        = selectedCat;
  task.client     = document.getElementById('f-client').value.trim();
  task.listId     = document.getElementById('f-list').value;
  task.sender     = document.getElementById('f-sender').value.trim();
  task.due        = document.getElementById('f-due').value;
  task.attachment = getAttachmentFromModal();
  saveState(task.listId);
}

function addTimestampedNote() {
  if(editingId===null) return;
  const ta=document.getElementById('f-note-add');
  const text=ta.value.trim(); if(!text) return;
  const task=tasks.find(t=>t.id===editingId); if(!task) return;
  if(!Array.isArray(task.notes)) task.notes=task.notes?[{ts:'',text:task.notes}]:[];
  const ts = (userName ? userName + ' · ' : '') + new Date().toLocaleString();
  task.notes.push({ts, text});
  ta.value='';
  saveState(task.listId);
  // refresh note log in modal
  const log=document.getElementById('note-log');
  const entries=document.getElementById('note-log-entries');
  log.style.display='block';
  entries.innerHTML=renderNoteEntries(task);
  render();
}

function openModal(editTask, targetListId) {
  editingId = editTask ? editTask.id : null;
  if(editTask){
    selectedCat=editTask.cat;
    document.getElementById('f-title').value  = editTask.title;
    document.getElementById('f-client').value = editTask.client||'';
    document.getElementById('f-sender').value = editTask.sender||'';
    document.getElementById('f-due').value    = editTask.due||'';
    document.getElementById('f-note-add').value='';
    document.getElementById('f-attach-url').value = editTask.attachment?.url||'';
    document.getElementById('modal-head').textContent='Edit task';
    document.getElementById('modal-save').style.display='none';
    document.getElementById('modal-delete').style.display='block';
    buildListSelect(editTask.listId);
    setAttachPreview(editTask.attachment||null);

    // Show notes section in edit mode
    const log=document.getElementById('note-log');
    const entries=document.getElementById('note-log-entries');
    log.style.display='block';
    entries.innerHTML=renderNoteEntries(editTask);
  } else {
    editingId=null; selectedCat='action';
    document.getElementById('f-title').value='';
    document.getElementById('f-client').value='';
    document.getElementById('f-sender').value='';
    document.getElementById('f-due').value='';
    document.getElementById('f-note-add').value='';
    document.getElementById('f-attach-url').value='';
    document.getElementById('modal-head').textContent='Add task';
    document.getElementById('modal-save').style.display='inline-flex';
    document.getElementById('modal-delete').style.display='none';
    // Hide notes section when adding — notes added after task created
    document.getElementById('note-log').style.display='none';
    setAttachPreview(null);
    buildListSelect(targetListId||currentTab);
  }
  buildCatGrid(selectedCat);
  document.getElementById('modal-overlay').classList.add('visible');
  setTimeout(()=>document.getElementById('f-title').focus(),50);

  // Wire auto-save on field changes for edit mode
  ['f-title','f-client','f-sender','f-due','f-list'].forEach(id=>{
    const el=document.getElementById(id);
    el.oninput=el.onchange=()=>autoSave();
  });
}

function closeModal(){
  autoSave();
  // Add any pending note
  const ta=document.getElementById('f-note-add');
  if(ta.value.trim()) addTimestampedNote();
  document.getElementById('modal-overlay').classList.remove('visible');
  editingId=null; render();
}

document.getElementById('modal-cancel').addEventListener('click',closeModal);
document.getElementById('modal-delete').addEventListener('click',()=>{
  if(!editingId) return;
  const deletedTask = tasks.find(t=>t.id===editingId);
  const deletedListId = deletedTask ? deletedTask.listId : null;
  tasks=tasks.filter(t=>t.id!==editingId);
  saveState(deletedListId); document.getElementById('modal-overlay').classList.remove('visible'); editingId=null; render();
});
document.getElementById('modal-save').addEventListener('click',()=>{
  const title=document.getElementById('f-title').value.trim(); if(!title) return;
  const listId=document.getElementById('f-list').value;
  const newTask = {
    id:nextId++, title, sender:document.getElementById('f-sender').value.trim(),
    cat:selectedCat, due:document.getElementById('f-due').value,
    notes:[], client:document.getElementById('f-client').value.trim(),
    attachment: getAttachmentFromModal(),
    listId, active:false, done:false
  };
  tasks.unshift(newTask); // add to top
  saveState(listId);
  notifyIfShared(newTask, 'added');
  document.getElementById('modal-overlay').classList.remove('visible');
  if(listId!==currentTab) switchTab(listId); else render();
});

// Note add button inside modal (Enter in textarea)
document.getElementById('f-note-add').addEventListener('keydown',e=>{
  if(e.key==='Enter'&&!e.shiftKey){e.preventDefault();addTimestampedNote();}
});

// ── Render ─────────────────────────────────────────────────────────────────
function render(){
  const active   =tasks.filter(t=>t.active);
  const pipeline =tasks.filter(t=>!t.active&&t.listId==='pipeline');
  const backlog  =tasks.filter(t=>!t.active&&t.listId==='backlog');

  const headerMeta = document.getElementById('header-meta');
  if (headerMeta) headerMeta.textContent=active.length+' active · '+tasks.filter(t=>!t.active).length+' queued';
  document.getElementById('active-count').textContent=active.length+' / 5';

  // My 5
  const az=document.getElementById('active-zone'); az.innerHTML='';
  const fa=filterTasks(active);
  if(!fa.length) az.innerHTML='<div class="my5-placeholder">'+(searchQ?'No matches':'Drag tasks here — your 5 priorities')+'</div>';
  else fa.forEach(t=>az.appendChild(makeCard(t,'active')));

  // Pipeline
  const bp=document.getElementById('badge-pipeline'); if(bp) bp.textContent=pipeline.length;
  const lp=document.getElementById('list-pipeline'); if(lp){
    lp.innerHTML='';
    const fp=filterTasks(pipeline);
    if(!fp.length&&searchQ) lp.innerHTML='<div class="no-results">No matches</div>';
    else fp.forEach(t=>lp.appendChild(makeCard(t,'pipeline')));
  }

  // Backlog
  const bb=document.getElementById('badge-backlog'); if(bb) bb.textContent=backlog.length;
  const lb=document.getElementById('list-backlog'); if(lb){
    lb.innerHTML='';
    const fb=filterTasks(backlog);
    if(!fb.length&&searchQ) lb.innerHTML='<div class="no-results">No matches</div>';
    else fb.forEach(t=>lb.appendChild(makeCard(t,'backlog')));
  }

  // Custom lists
  lists.filter(l=>!l.builtin).forEach(list=>{
    const cl=document.getElementById('list-'+list.id); if(!cl) return;
    const items=tasks.filter(t=>!t.active&&t.listId===list.id);
    const bdg=document.getElementById('badge-'+list.id); if(bdg) bdg.textContent=items.length;
    const fi=filterTasks(items); cl.innerHTML='';
    if(!fi.length&&searchQ) cl.innerHTML='<div class="no-results">No matches</div>';
    else fi.forEach(t=>cl.appendChild(makeCard(t,'custom')));
  });

  renderTabStrip();
}

// ── Static event wiring ─────────────────────────────────────────────────────
setupZoneDrop(document.getElementById('active-zone'),()=>{
  if(!draggingId) return;
  const task=tasks.find(t=>t.id===draggingId); if(!task) return;
  if(task.shared) return;
  if(!task.active&&tasks.filter(t=>t.active).length>=5) return;
  task.active=true; task.listId='pipeline';
  reorderDragId=null; reorderListEl=null;
  saveState('pipeline'); render();
}, true);
setupZoneDrop(document.getElementById('list-pipeline'),()=>{
  if(!draggingId||reorderDragId) return;
  const task=tasks.find(t=>t.id===draggingId);
  if(task){task.active=false;task.listId='pipeline';saveState();render();}
});
setupZoneDrop(document.getElementById('list-backlog'),()=>{
  if(!draggingId||reorderDragId) return;
  const task=tasks.find(t=>t.id===draggingId);
  if(task){task.active=false;task.listId='backlog';saveState();render();}
});

// ── Quick-add wiring ───────────────────────────────────────────────────────
function quickAddTask(listId) {
  const input = document.getElementById('quickadd-' + listId);
  if (!input) return;
  const title = input.value.trim();
  if (!title) { openModal(null, listId); return; } // empty = open full modal
  const newTask = {
    id: nextId++, title, sender: '', cat: 'action', due: '',
    notes: [], client: '', attachment: null, listId, active: false, done: false
  };
  tasks.unshift(newTask);
  saveState(listId);
  notifyIfShared(newTask, 'added');
  input.value = '';
  if (listId !== currentTab) switchTab(listId); else render();
  // briefly highlight the new card
  setTimeout(() => {
    const card = document.querySelector(`[data-id="${newTask.id}"]`);
    if (card) { card.style.transition = 'background 0.3s'; card.style.background = '#f0f9e8'; setTimeout(() => { card.style.background = ''; }, 800); }
  }, 50);
}

function wireQuickAdd(listId) {
  const input = document.getElementById('quickadd-' + listId);
  const btn   = document.querySelector(`.quickadd-btn[data-qa="${listId}"]`);
  if (input) {
    input.addEventListener('keydown', e => {
      if (e.key === 'Enter') { e.preventDefault(); quickAddTask(listId); }
    });
  }
  if (btn) {
    btn.addEventListener('click', () => {
      const val = document.getElementById('quickadd-' + listId)?.value.trim();
      if (val) quickAddTask(listId);
      else openModal(null, listId);
    });
  }
}

wireQuickAdd('pipeline');
wireQuickAdd('backlog');

document.getElementById('search-input').addEventListener('input',function(){
  searchQ=this.value.trim();
  document.getElementById('search-clear').style.display=searchQ?'block':'none';
  render();
});
document.getElementById('search-clear').addEventListener('click',()=>{
  document.getElementById('search-input').value='';searchQ='';
  document.getElementById('search-clear').style.display='none';render();
});

document.getElementById('done-footer-btn').addEventListener('click',toggleDrawer);
document.getElementById('done-close').addEventListener('click',toggleDrawer);
document.getElementById('clear-done-btn').addEventListener('click',()=>{doneTasks=[];saveState();updateDoneUI();renderDoneDrawer();});

document.getElementById('popout-btn').addEventListener('click',()=>{
  try{chrome.tabs.create({url:chrome.runtime.getURL('panel.html')});}
  catch(e){window.open(window.location.href,'_blank');}
});

// ── New list modal ─────────────────────────────────────────────────────────
document.getElementById('tab-add').addEventListener('click', () => {
  document.getElementById('new-list-name').value = '';
  // Shared option: only when connected to a team AND holding the admin code
  const sharedRow = document.getElementById('nl-shared-row');
  const canShare  = syncReady();
  sharedRow.style.display = canShare ? 'flex' : 'none';
  document.getElementById('nl-shared').checked = false;
  if (canShare) document.getElementById('nl-shared-team').textContent = currentTeamName();
  document.getElementById('nl-hint').textContent = canShare
    ? 'Private = just you. Shared = everyone on the team sees it instantly.'
    : 'This list is private to you. Join a team in Settings to create shared lists.';
  document.getElementById('new-list-modal').classList.add('visible');
  setTimeout(() => document.getElementById('new-list-name').focus(), 50);
});
document.getElementById('nl-cancel').addEventListener('click', () => document.getElementById('new-list-modal').classList.remove('visible'));
document.getElementById('nl-create').addEventListener('click', async () => {
  const name = document.getElementById('new-list-name').value.trim();
  if (!name) return;
  const shared = document.getElementById('nl-shared').checked && syncReady();
  const btn = document.getElementById('nl-create');
  if (shared) {
    btn.textContent = 'Creating…'; btn.disabled = true;
    try {
      const id = await createSharedList(name);
      document.getElementById('new-list-modal').classList.remove('visible');
      switchTab(id);
      loadTeamLists();
    } catch(e) { alert('Error creating shared list: ' + e.message); }
    btn.textContent = 'Create list'; btn.disabled = false;
  } else {
    const id = 'custom-' + (nextListId++);
    lists.push({ id, label: name, builtin: false, shared: false });
    document.getElementById('new-list-modal').classList.remove('visible');
    saveState(); ensureView(id); switchTab(id);
  }
});
document.getElementById('new-list-name').addEventListener('keydown', e => { if (e.key === 'Enter') document.getElementById('nl-create').click(); });

// ── Team switcher ──────────────────────────────────────────────────────────
function currentTeamName() {
  if (!syncConfig.team) return 'Personal';
  const saved = savedTeams.find(t => t.team === syncConfig.team);
  return saved ? saved.name : syncConfig.team;
}

function renderTeamSwitcher() {
  const nameEl = document.getElementById('team-switcher-name');
  if (nameEl) nameEl.textContent = currentTeamName();
}

function renderSavedTeamsList() {
  const container = document.getElementById('saved-teams-list');
  if (!container) return;
  container.innerHTML = '';
  if (!savedTeams.length) {
    container.innerHTML = '<div style="font-size:12px;color:#aaa;padding:4px 0;">Teams you start or join appear here automatically.</div>';
    return;
  }
  savedTeams.forEach((team, idx) => {
    const row = document.createElement('div');
    row.className = 'saved-team-row';
    const isActive = team.team === syncConfig.team;
    row.innerHTML = `
      <div class="saved-team-dot" style="background:${isActive?'#639922':'#ddd'}"></div>
      <div>
        <div class="saved-team-name">${team.name}</div>
        <div class="saved-team-code">${team.team}</div>
      </div>
      <span class="saved-team-del" data-idx="${idx}" title="Remove">×</span>`;
    row.querySelector('.saved-team-del').addEventListener('click', e => {
      e.stopPropagation();
      savedTeams.splice(idx, 1);
      saveSyncConfig(); renderSavedTeamsList(); renderTeamSwitcherMenu();
    });
    container.appendChild(row);
  });
}

function renderTeamSwitcherMenu() {
  const menu = document.getElementById('team-switcher-menu');
  if (!menu) return;
  menu.innerHTML = '';

  // Personal (no team)
  const personal = document.createElement('div');
  const isPersonal = !syncConfig.team;
  personal.className = 'team-menu-item' + (isPersonal ? ' active' : '');
  personal.innerHTML = `<div class="team-menu-dot"></div><span>Personal</span>`;
  personal.addEventListener('click', () => {
    switchToTeam({ name:'Personal', url:'', team:'', adminCode:'' });
    document.getElementById('team-switcher-menu').style.display = 'none';
  });
  menu.appendChild(personal);

  if (savedTeams.length) {
    const div = document.createElement('div');
    div.className = 'team-menu-divider';
    menu.appendChild(div);
  }

  savedTeams.forEach((team, idx) => {
    const item = document.createElement('div');
    const isActive = team.team === syncConfig.team;
    item.className = 'team-menu-item' + (isActive ? ' active' : '');
    item.innerHTML = `
      <div class="team-menu-dot"></div>
      <span style="flex:1">${team.name}</span>
      <span class="team-menu-remove" data-idx="${idx}" title="Remove">×</span>`;
    item.querySelector('.team-menu-remove').addEventListener('click', e => {
      e.stopPropagation();
      savedTeams.splice(idx, 1);
      saveSyncConfig(); renderTeamSwitcherMenu(); renderSavedTeamsList();
    });
    item.addEventListener('click', e => {
      if (e.target.closest('.team-menu-remove')) return;
      switchToTeam(team);
      document.getElementById('team-switcher-menu').style.display = 'none';
    });
    menu.appendChild(item);
  });

  const divider = document.createElement('div');
  divider.className = 'team-menu-divider';
  menu.appendChild(divider);

  const addItem = document.createElement('div');
  addItem.className = 'team-menu-item team-menu-add';
  addItem.innerHTML = `<div class="team-menu-dot" style="background:#185FA5"></div><span>＋ Start or join a team…</span>`;
  addItem.addEventListener('click', () => {
    document.getElementById('team-switcher-menu').style.display = 'none';
    document.getElementById('settings-drawer').classList.add('open');
    document.getElementById('settings-btn').classList.add('active');
  });
  menu.appendChild(addItem);
}

async function switchToTeam(team) {
  // Save current shared lists tasks back to Cloudflare before switching
  const sharedLists = lists.filter(l => l.shared);
  for (const list of sharedLists) { await syncPush(list); }

  // Update active config
  syncConfig.url       = team.url       || '';
  syncConfig.team      = team.team      || '';
  syncConfig.adminCode = team.adminCode || '';
  saveSyncConfig();

  // Hide all shared lists (they belong to the old team)
  lists.forEach(l => { if (l.shared) l.hidden = true; });

  stopSyncTimer();
  renderTeamSwitcher();
  renderTeamSwitcherMenu();
  renderTabStrip();
  render();

  // Pull new team's shared lists
  if (syncReady()) {
    await syncPullAll();
    startSyncTimer();
  }

  // Update settings panel to reflect active team
  renderTeamConnectPanel();
}

function wireTeamSwitcher() {
  const btn  = document.getElementById('team-switcher-btn');
  const menu = document.getElementById('team-switcher-menu');

  btn.addEventListener('click', e => {
    e.stopPropagation();
    renderTeamSwitcherMenu();
    const isOpen = menu.style.display !== 'none';
    menu.style.display = isOpen ? 'none' : 'block';
  });

  document.addEventListener('click', () => {
    if (menu) menu.style.display = 'none';
  });

  renderTeamSwitcher();
  renderSavedTeamsList();
}



const THEMES = {
  green:  { my5Bg:'#EAF3DE', my5Border:'#C0DD97', my5Dot:'#639922', my5Text:'#3B6D11', my5Count:'#C0DD97', my5CountText:'#27500A', accent:'#3B6D11', accentHover:'#27500A', addBtn:'#3B6D11', addBtnHover:'#27500A', doneIcon:'#639922', doneBg:'#EAF3DE', doneBorder:'#97C459' },
  blue:   { my5Bg:'#E6F1FB', my5Border:'#A8CDEE', my5Dot:'#378ADD', my5Text:'#0C447C', my5Count:'#A8CDEE', my5CountText:'#0C447C', accent:'#185FA5', accentHover:'#0C447C', addBtn:'#185FA5', addBtnHover:'#0C447C', doneIcon:'#378ADD', doneBg:'#E6F1FB', doneBorder:'#A8CDEE' },
  purple: { my5Bg:'#EEEDFE', my5Border:'#C5C2F9', my5Dot:'#6C66E0', my5Text:'#3C3489', my5Count:'#C5C2F9', my5CountText:'#3C3489', accent:'#534AB7', accentHover:'#3C3489', addBtn:'#534AB7', addBtnHover:'#3C3489', doneIcon:'#6C66E0', doneBg:'#EEEDFE', doneBorder:'#C5C2F9' },
  amber:  { my5Bg:'#FAEEDA', my5Border:'#FAC775', my5Dot:'#D4860A', my5Text:'#633806', my5Count:'#FAC775', my5CountText:'#633806', accent:'#854F0B', accentHover:'#633806', addBtn:'#854F0B', addBtnHover:'#633806', doneIcon:'#D4860A', doneBg:'#FAEEDA', doneBorder:'#FAC775' },
  slate:  { my5Bg:'#F1F1F3', my5Border:'#C8C8D0', my5Dot:'#6B6B7E', my5Text:'#3D3D4E', my5Count:'#C8C8D0', my5CountText:'#3D3D4E', accent:'#3D3D4E', accentHover:'#2A2A38', addBtn:'#3D3D4E', addBtnHover:'#2A2A38', doneIcon:'#6B6B7E', doneBg:'#F1F1F3', doneBorder:'#C8C8D0' },
  dark:   { my5Bg:'#2A2A2A', my5Border:'#444', my5Dot:'#888', my5Text:'#ccc', my5Count:'#444', my5CountText:'#ccc', accent:'#555', accentHover:'#666', addBtn:'#444', addBtnHover:'#555', doneIcon:'#666', doneBg:'#2A2A2A', doneBorder:'#444' },
  pink:   { my5Bg:'#FDEEF5', my5Border:'#F4AACF', my5Dot:'#E05C9A', my5Text:'#8B1A54', my5Count:'#F4AACF', my5CountText:'#8B1A54', accent:'#C4437F', accentHover:'#8B1A54', addBtn:'#C4437F', addBtnHover:'#8B1A54', doneIcon:'#E05C9A', doneBg:'#FDEEF5', doneBorder:'#F4AACF' },
  sparkles: { my5Bg:'linear-gradient(135deg,#FFF0FA,#F0EEFF,#FFF8E7)', my5Border:'#D4AAFF', my5Dot:'#B44FE8', my5Text:'#6B1FA8', my5Count:'#E8C5FF', my5CountText:'#6B1FA8', accent:'#B44FE8', accentHover:'#8B1AC8', addBtn:'#B44FE8', addBtnHover:'#8B1AC8', doneIcon:'#E05C9A', doneBg:'#FFF0FA', doneBorder:'#D4AAFF' },
  teal:    { my5Bg:'#E4F5F3', my5Border:'#99D9D0', my5Dot:'#14A38F', my5Text:'#0B5D52', my5Count:'#99D9D0', my5CountText:'#0B5D52', accent:'#0F766E', accentHover:'#0B5D52', addBtn:'#0F766E', addBtnHover:'#0B5D52', doneIcon:'#14A38F', doneBg:'#E4F5F3', doneBorder:'#99D9D0' },
  crimson: { my5Bg:'#FBEAEA', my5Border:'#F0AEAE', my5Dot:'#D64545', my5Text:'#7C1D1D', my5Count:'#F0AEAE', my5CountText:'#7C1D1D', accent:'#B91C1C', accentHover:'#7C1D1D', addBtn:'#B91C1C', addBtnHover:'#7C1D1D', doneIcon:'#D64545', doneBg:'#FBEAEA', doneBorder:'#F0AEAE' },
  sunset:  { my5Bg:'linear-gradient(135deg,#FFF1E4,#FDE7EF)', my5Border:'#F8B27E', my5Dot:'#EA580C', my5Text:'#8A3208', my5Count:'#FBD3AE', my5CountText:'#8A3208', accent:'#EA580C', accentHover:'#B94408', addBtn:'#EA580C', addBtnHover:'#B94408', doneIcon:'#E05C9A', doneBg:'#FFF1E4', doneBorder:'#F8B27E' },
  midnight:{ my5Bg:'#232A3D', my5Border:'#3B476B', my5Dot:'#7B93D6', my5Text:'#C9D4F2', my5Count:'#3B476B', my5CountText:'#C9D4F2', accent:'#4A5D9E', accentHover:'#5B70B8', addBtn:'#3B4C86', addBtnHover:'#4A5D9E', doneIcon:'#7B93D6', doneBg:'#232A3D', doneBorder:'#3B476B' },
};

const FONTS = {
  system:  '-apple-system, BlinkMacSystemFont, "Segoe UI", sans-serif',
  serif:   'Georgia, "Times New Roman", serif',
  mono:    '"Courier New", "Lucida Console", monospace',
  rounded: '"Trebuchet MS", "Gill Sans", sans-serif',
  elegant: '"Palatino Linotype", "Book Antiqua", Palatino, serif',
  casual:  '"Comic Sans MS", "Segoe Print", cursive',
};

let themeStyleEl = null;

function applyTheme(themeName) {
  const t = THEMES[themeName] || THEMES.green;
  if (!themeStyleEl) {
    themeStyleEl = document.createElement('style');
    themeStyleEl.id = 'theme-vars';
    document.head.appendChild(themeStyleEl);
  }

  // Dark mode body class
  document.body.classList.toggle('theme-dark', themeName === 'dark' || themeName === 'midnight');

  themeStyleEl.textContent = `
    .my5-zone-wrapper { background: ${t.my5Bg} !important; border-color: ${t.my5Border} !important; }
    .my5-label { color: ${t.my5Text} !important; }
    .my5-count { background: ${t.my5Count} !important; color: ${t.my5CountText} !important; }
    .my5-drop  { border-color: ${t.my5Dot} !important; background: rgba(255,255,255,${(themeName==='dark'||themeName==='midnight')?'0.05':'0.6'}) !important; }
    .my5-drop.drag-over { border-color: ${t.accent} !important; }
    .my5-card  { border-color: ${t.my5Border} !important; border-left-color: ${t.my5Dot} !important; }
    .my5-card:hover { border-color: ${t.my5Dot} !important; border-left-color: ${t.accent} !important; }
    .my5-placeholder { border-color: ${t.my5Dot} !important; color: ${t.my5Text} !important; }
    .add-task-btn { background: ${t.addBtn} !important; }
    .add-task-btn:hover { background: ${t.addBtnHover} !important; }
    .btn-p { background: ${t.accent} !important; border-color: ${t.accent} !important; }
    .btn-p:hover { background: ${t.accentHover} !important; }
    .sync-btn-save { background: ${t.accent} !important; }
    .sync-btn-save:hover { background: ${t.accentHover} !important; }
    .done-check-icon { background: ${t.doneIcon} !important; }
    .done-footer-btn { background: ${t.doneBg} !important; border-color: ${t.doneBorder} !important; }
    .done-footer-btn:hover { background: ${t.my5Count} !important; }
    .done-footer-label { color: ${t.my5Text} !important; }
    .done-count-pill { background: ${t.my5Count} !important; color: ${t.my5CountText} !important; }
    .card-check:hover { border-color: ${t.my5Dot} !important; }
    .card-check.done { background: ${t.my5Bg} !important; border-color: ${t.my5Dot} !important; }
    .card-check.done::after { border-color: ${t.accent} !important; }
    .ca.my5-btn { border-color: ${t.my5Border} !important; background: ${t.my5Bg} !important; }
    .ca.my5-btn svg { color: ${t.my5Text} !important; }
    .ca.my5-btn:hover { background: ${t.my5Count} !important; }
    .ca.claim-btn { background: ${t.my5Bg} !important; border-color: ${t.my5Border} !important; color: ${t.my5Text} !important; }
    .tab.active { color: ${(themeName==='dark'||themeName==='midnight')?'#eee':'#111'} !important; border-bottom-color: ${(themeName==='dark'||themeName==='midnight')?'#eee':'#111'} !important; }
    .quick-comment-save { background: ${t.accent} !important; }
    .quick-comment-ta:focus { border-color: ${t.my5Dot} !important; }
  `;

  // Toolbar icon follows the theme
  try { chrome.runtime.sendMessage({ type: 'icon-color', color: t.my5Dot }); } catch(e) {}
}

function applyFont(fontName) {
  const fontStack = FONTS[fontName] || FONTS.system;
  document.body.style.fontFamily = fontStack;
}

// ── Sound engine ────────────────────────────────────────────────────────────
let audioCtx = null;

function getAudioCtx() {
  if (!audioCtx) audioCtx = new (window.AudioContext || window.webkitAudioContext)();
  return audioCtx;
}

function playSound(soundName, volume) {
  if (!soundName || soundName === 'off') return;
  const vol = (volume !== undefined ? volume : prefs.volume) / 100;
  try {
    const ctx = getAudioCtx();
    const gain = ctx.createGain();
    gain.connect(ctx.destination);
    gain.gain.setValueAtTime(vol, ctx.currentTime);

    if (soundName === 'bubble') {
      // Soft bubble pop — quick pitch-up blip
      const osc = ctx.createOscillator();
      osc.connect(gain);
      osc.type = 'sine';
      osc.frequency.setValueAtTime(300, ctx.currentTime);
      osc.frequency.exponentialRampToValueAtTime(900, ctx.currentTime + 0.09);
      gain.gain.setValueAtTime(vol, ctx.currentTime);
      gain.gain.exponentialRampToValueAtTime(0.001, ctx.currentTime + 0.14);
      osc.start(ctx.currentTime);
      osc.stop(ctx.currentTime + 0.15);

    } else if (soundName === 'arcade') {
      // 8-bit coin — two quick square notes
      const o1 = ctx.createOscillator();
      o1.type = 'square';
      o1.frequency.setValueAtTime(987.77, ctx.currentTime);        // B5
      o1.frequency.setValueAtTime(1318.51, ctx.currentTime + 0.08); // E6
      const g1 = ctx.createGain();
      g1.gain.setValueAtTime(vol * 0.5, ctx.currentTime);
      g1.gain.exponentialRampToValueAtTime(0.001, ctx.currentTime + 0.45);
      o1.connect(g1); g1.connect(ctx.destination);
      o1.start(ctx.currentTime);
      o1.stop(ctx.currentTime + 0.45);

    } else if (soundName === 'chime') {
      // Two-note chime
      [523.25, 659.25].forEach((freq, i) => {
        const o = ctx.createOscillator();
        const g = ctx.createGain();
        o.connect(g); g.connect(ctx.destination);
        o.type = 'sine';
        o.frequency.value = freq;
        g.gain.setValueAtTime(0, ctx.currentTime + i * 0.15);
        g.gain.linearRampToValueAtTime(vol, ctx.currentTime + i * 0.15 + 0.01);
        g.gain.exponentialRampToValueAtTime(0.001, ctx.currentTime + i * 0.15 + 0.5);
        o.start(ctx.currentTime + i * 0.15);
        o.stop(ctx.currentTime + i * 0.15 + 0.5);
      });

    } else if (soundName === 'success') {
      // Three-note ascending fanfare
      [523.25, 659.25, 783.99].forEach((freq, i) => {
        const o = ctx.createOscillator();
        const g = ctx.createGain();
        o.connect(g); g.connect(ctx.destination);
        o.type = 'triangle';
        o.frequency.value = freq;
        g.gain.setValueAtTime(0, ctx.currentTime + i * 0.12);
        g.gain.linearRampToValueAtTime(vol * 0.8, ctx.currentTime + i * 0.12 + 0.02);
        g.gain.exponentialRampToValueAtTime(0.001, ctx.currentTime + i * 0.12 + 0.35);
        o.start(ctx.currentTime + i * 0.12);
        o.stop(ctx.currentTime + i * 0.12 + 0.35);
      });
    } else if (soundName === 'sparkles') {
      // Magical ascending glitter — quick random high notes
      const notes = [1047, 1319, 1568, 2093, 1319, 1760];
      notes.forEach((freq, i) => {
        const o = ctx.createOscillator();
        const g = ctx.createGain();
        o.connect(g); g.connect(ctx.destination);
        o.type = 'sine';
        o.frequency.value = freq;
        const t0 = ctx.currentTime + i * 0.07;
        g.gain.setValueAtTime(0, t0);
        g.gain.linearRampToValueAtTime(vol * 0.5, t0 + 0.01);
        g.gain.exponentialRampToValueAtTime(0.001, t0 + 0.2);
        o.start(t0);
        o.stop(t0 + 0.2);
      });
    }
  } catch(e) { console.warn('Sound error:', e); }
}

function wirePersonalization() {
  // Set initial UI state
  document.querySelectorAll('.theme-swatch').forEach(el => {
    el.classList.toggle('active', el.dataset.theme === prefs.theme);
    el.addEventListener('click', () => {
      prefs.theme = el.dataset.theme;
      document.querySelectorAll('.theme-swatch').forEach(e => e.classList.remove('active'));
      el.classList.add('active');
      applyTheme(prefs.theme);
      saveSyncConfig();
    });
  });

  document.querySelectorAll('.font-opt').forEach(el => {
    el.classList.toggle('active', el.dataset.font === prefs.font);
    el.addEventListener('click', () => {
      prefs.font = el.dataset.font;
      document.querySelectorAll('.font-opt').forEach(e => e.classList.remove('active'));
      el.classList.add('active');
      applyFont(prefs.font);
      saveSyncConfig();
    });
  });

  document.querySelectorAll('.sound-opt').forEach(el => {
    el.classList.toggle('active', el.dataset.sound === prefs.sound);
    el.addEventListener('click', () => {
      prefs.sound = el.dataset.sound;
      document.querySelectorAll('.sound-opt').forEach(e => e.classList.remove('active'));
      el.classList.add('active');
      saveSyncConfig();
    });
  });

  const volSlider = document.getElementById('sound-volume');
  volSlider.value = prefs.volume;
  volSlider.addEventListener('input', () => {
    prefs.volume = parseInt(volSlider.value);
    saveSyncConfig();
  });

  document.getElementById('sound-preview-btn').addEventListener('click', () => {
    if (prefs.sound === 'off') return;
    playSound(prefs.sound, prefs.volume);
  });
}


loadState(()=>{
  lists.filter(l=>!l.builtin).forEach(l=>ensureView(l.id));
  setupAttachmentDropZone();
  wireSettingsSync();
  wireTeamSwitcher();
  wirePersonalization();
  applyTheme(prefs.theme);
  applyFont(prefs.font);
  renderTabStrip(); updateDoneUI(); render();
  syncPullAll();
  if (personalReady()) personalTick();
  startSyncTimer();
});


// ── PWA bootstrap ───────────────────────────────────────────────────────────
// (This file is the web-app build. Storage falls back to localStorage,
//  and extension-only UI is hidden below.)
(function pwaInit() {
  const pop = document.getElementById('popout-btn');
  if (pop) pop.style.display = 'none';
  if ('serviceWorker' in navigator) {
    navigator.serviceWorker.register('./sw.js').catch(() => {});
  }
})();
