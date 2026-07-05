// Paragon Focus Board — Cloudflare Worker
// KV binding: FOCUS_BOARD
// Cron: configure in Cloudflare dashboard for weekly summary

const CORS = {
  'Access-Control-Allow-Origin': '*',
  'Access-Control-Allow-Methods': 'GET, POST, DELETE, OPTIONS',
  'Access-Control-Allow-Headers': 'Content-Type, X-Team-Code, X-Admin-Code',
};

function respond(data, status) {
  return new Response(JSON.stringify(data), {
    status: status || 200,
    headers: Object.assign({ 'Content-Type': 'application/json' }, CORS),
  });
}

// ── Send notification email via MailChannels ───────────────────────────────
// Posts JSON to Make.com webhook (or any plain webhook URL)
async function sendToWebhook(webhookUrl, payload) {
  if (!webhookUrl) return { ok: false, error: 'No webhook URL' };
  try {
    const res = await fetch(webhookUrl, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify(payload),
    });
    const text = await res.text();
    console.log('Webhook status:', res.status, text);
    return { ok: res.status < 300, status: res.status, body: text };
  } catch(e) {
    console.error('Webhook error:', e.message);
    return { ok: false, error: e.message };
  }
}
// Alias so existing calls work
async function sendEmail(toAddress, subject, htmlBody) {
  return { ok: false, error: 'Use sendToWebhook instead' };
}

function buildNotificationEmail(event) {
  const icons  = { completed:'✅', claimed:'👋', unclaimed:'🔓', added:'➕' };
  const verbs  = { completed:'completed', claimed:'is working on', unclaimed:'released', added:'added' };
  const colors = { completed:'#27500A', claimed:'#633806', unclaimed:'#444', added:'#0C447C' };
  const bgs    = { completed:'#EAF3DE', claimed:'#FAEEDA', unclaimed:'#f5f5f3', added:'#E6F1FB' };

  const icon  = icons[event.type]  || '📋';
  const verb  = verbs[event.type]  || event.type;
  const color = colors[event.type] || '#111';
  const bg    = bgs[event.type]    || '#f5f5f3';
  const who   = event.who          || 'Someone';
  const title = event.taskTitle    || 'Untitled task';
  const list  = event.listLabel    || '';

  const subject = `${icon} ${who} ${verb} a task — Paragon Focus Board`;

  const html = `
    <div style="font-family:system-ui,sans-serif;max-width:480px;margin:0 auto;padding:24px;">
      <div style="background:${bg};border-radius:10px;padding:16px 20px;margin-bottom:16px;">
        <div style="font-size:28px;margin-bottom:8px;">${icon}</div>
        <div style="font-size:16px;font-weight:600;color:${color};">${who} ${verb}</div>
        <div style="font-size:20px;font-weight:700;color:#111;margin:6px 0;">${title}</div>
        ${list ? `<div style="font-size:13px;color:#888;">List: ${list}</div>` : ''}
      </div>
      <div style="font-size:11px;color:#bbb;text-align:center;">
        Paragon Focus Board · ${new Date(event.ts||Date.now()).toLocaleString()}
      </div>
    </div>`;

  return { subject, html };
}

function buildWeeklySummaryEmail(summary) {
  const subject = `📋 Weekly Summary — Paragon Focus Board`;
  const overduRows = (summary.overdue||[]).map(t =>
    `<tr><td style="padding:4px 8px;border-bottom:0.5px solid #eee;">${t.title}</td><td style="padding:4px 8px;border-bottom:0.5px solid #eee;color:#888;">${t.list}</td></tr>`
  ).join('');
  const completedRows = (summary.completedTasks||[]).map(t =>
    `<li style="margin-bottom:4px;">${t.title}${t.who?' <span style="color:#888;font-size:12px;">('+t.who+')</span>':''}</li>`
  ).join('');

  const html = `
    <div style="font-family:system-ui,sans-serif;max-width:520px;margin:0 auto;padding:24px;">
      <div style="background:#3B6D11;border-radius:10px;padding:20px 24px;margin-bottom:20px;">
        <div style="font-size:22px;font-weight:700;color:#fff;">📋 Weekly Summary</div>
        <div style="font-size:13px;color:#C0DD97;margin-top:4px;">${summary.weekOf}</div>
      </div>

      <div style="display:flex;gap:12px;margin-bottom:20px;">
        <div style="flex:1;background:#EAF3DE;border-radius:8px;padding:14px;text-align:center;">
          <div style="font-size:28px;font-weight:700;color:#3B6D11;">${summary.completed}</div>
          <div style="font-size:12px;color:#639922;">✅ Completed</div>
        </div>
        <div style="flex:1;background:#E6F1FB;border-radius:8px;padding:14px;text-align:center;">
          <div style="font-size:28px;font-weight:700;color:#0C447C;">${summary.added}</div>
          <div style="font-size:12px;color:#185FA5;">➕ Added</div>
        </div>
        <div style="flex:1;background:#FAEEDA;border-radius:8px;padding:14px;text-align:center;">
          <div style="font-size:28px;font-weight:700;color:#633806;">${summary.claimed}</div>
          <div style="font-size:12px;color:#854F0B;">👋 Claimed</div>
        </div>
      </div>

      ${completedRows ? `
      <div style="margin-bottom:20px;">
        <div style="font-size:13px;font-weight:600;color:#111;margin-bottom:8px;">Completed this week</div>
        <ul style="margin:0;padding-left:20px;font-size:13px;color:#333;">${completedRows}</ul>
      </div>` : ''}

      ${summary.roster ? `
      <div style="background:#f5f5f3;border-radius:8px;padding:12px 16px;margin-bottom:20px;font-size:13px;">
        🏃 <strong>Active team members:</strong> ${summary.roster}
      </div>` : ''}

      ${overduRows ? `
      <div style="margin-bottom:20px;">
        <div style="font-size:13px;font-weight:600;color:#A32D2D;margin-bottom:8px;">⚠️ Overdue tasks</div>
        <table style="width:100%;border-collapse:collapse;font-size:13px;">
          <thead><tr>
            <th style="text-align:left;padding:4px 8px;background:#FCEBEB;color:#791F1F;">Task</th>
            <th style="text-align:left;padding:4px 8px;background:#FCEBEB;color:#791F1F;">List</th>
          </tr></thead>
          <tbody>${overduRows}</tbody>
        </table>
      </div>` : `
      <div style="background:#EAF3DE;border-radius:8px;padding:12px 16px;margin-bottom:20px;font-size:13px;color:#3B6D11;">
        ✓ No overdue tasks — great work!
      </div>`}

      <div style="font-size:11px;color:#bbb;text-align:center;">
        Paragon Focus Board · Auto-generated weekly summary
      </div>
    </div>`;

  return { subject, html };
}

// ── Log activity for weekly summary ───────────────────────────────────────
async function logActivity(env, team, event) {
  // event: { type, who, taskTitle, listLabel, ts }
  var key = team + ':activity';
  var raw = await env.FOCUS_BOARD.get(key);
  var log = raw ? JSON.parse(raw) : [];
  log.push(event);
  // Keep last 500 events max
  if (log.length > 500) log = log.slice(log.length - 500);
  await env.FOCUS_BOARD.put(key, JSON.stringify(log));
}

// ── Weekly summary builder ─────────────────────────────────────────────────
async function sendWeeklySummary(env, team) {
  var webhookUrl = await env.FOCUS_BOARD.get(team + ':webhook');
  if (!webhookUrl) return;

  var key = team + ':activity';
  var raw = await env.FOCUS_BOARD.get(key);
  var log = raw ? JSON.parse(raw) : [];

  // Filter to last 7 days
  var cutoff = Date.now() - (7 * 24 * 60 * 60 * 1000);
  var week   = log.filter(function(e) { return new Date(e.ts).getTime() > cutoff; });

  var completed = week.filter(function(e) { return e.type === 'completed'; });
  var added     = week.filter(function(e) { return e.type === 'added'; });
  var claimed   = week.filter(function(e) { return e.type === 'claimed'; });

  // Who's been active
  var people = {};
  week.forEach(function(e) {
    if (e.who) people[e.who] = (people[e.who] || 0) + 1;
  });
  var roster = Object.entries(people)
    .sort(function(a,b) { return b[1]-a[1]; })
    .map(function(p) { return p[0] + ' (' + p[1] + ' actions)'; })
    .join(', ');

  // Overdue tasks — pull from all shared lists
  var idxRaw = await env.FOCUS_BOARD.get(team + ':index');
  var idx    = idxRaw ? JSON.parse(idxRaw) : [];
  var overdue = [];
  var today   = new Date(); today.setHours(0,0,0,0);

  for (var i = 0; i < idx.length; i++) {
    var listRaw = await env.FOCUS_BOARD.get(team + ':list:' + idx[i].id);
    if (!listRaw) continue;
    var listData = JSON.parse(listRaw);
    (listData.tasks || []).forEach(function(t) {
      if (!t.due || t.done || t.active) return;
      var due = new Date(t.due);
      if (isNaN(due.getTime())) return;
      due.setHours(0,0,0,0);
      if (due < today) {
        overdue.push({ title: t.title, list: idx[i].label, due: t.due });
      }
    });
  }

  var lines = [];
  lines.push('**Week of ' + new Date().toLocaleDateString('en-US', {month:'long', day:'numeric', year:'numeric'}) + '**');
  lines.push('');
  lines.push('✅ **Completed:** ' + completed.length + ' task' + (completed.length!==1?'s':''));
  if (completed.length) {
    completed.slice(0,5).forEach(function(e) {
      lines.push('  • ' + e.taskTitle + (e.who?' (' + e.who + ')':''));
    });
    if (completed.length > 5) lines.push('  • ...and ' + (completed.length-5) + ' more');
  }
  lines.push('');
  lines.push('➕ **Added:** ' + added.length + ' new task' + (added.length!==1?'s':''));
  lines.push('👋 **Claimed:** ' + claimed.length + ' task' + (claimed.length!==1?'s':''));
  lines.push('');
  if (roster) lines.push('🏃 **Active team members:** ' + roster);
  if (overdue.length) {
    lines.push('');
    lines.push('⚠️ **Overdue (' + overdue.length + '):**');
    overdue.slice(0,5).forEach(function(t) {
      lines.push('  • ' + t.title + ' — ' + t.list);
    });
    if (overdue.length > 5) lines.push('  • ...and ' + (overdue.length-5) + ' more');
  }

  const email = buildWeeklySummaryEmail({
    weekOf:         new Date().toLocaleDateString('en-US', {month:'long', day:'numeric', year:'numeric'}),
    completed:      completed.length,
    added:          added.length,
    claimed:        claimed.length,
    roster:         roster,
    overdue:        overdue.slice(0, 10),
    completedTasks: completed.slice(0, 5).map(function(e) { return { title: e.taskTitle, who: e.who }; }),
  });
  await sendToWebhook(webhookUrl, {
    type:      'weekly_summary',
    who:       'Focus Board',
    taskTitle: 'Weekly Summary',
    listLabel: '',
    summary: {
      weekOf:         new Date().toLocaleDateString('en-US', {month:'long',day:'numeric',year:'numeric'}),
      completed:      completed.length,
      added:          added.length,
      claimed:        claimed.length,
      roster:         roster,
      overdue:        overdue.slice(0, 10),
      completedTasks: completed.slice(0,5).map(function(e){return{title:e.taskTitle,who:e.who};}),
    },
    ts: new Date().toISOString(),
  });

  // Clear the activity log after summary
  await env.FOCUS_BOARD.put(key, JSON.stringify([]));
}

// ── Cron handler ───────────────────────────────────────────────────────────
addEventListener('scheduled', function(event) {
  event.waitUntil(handleCron(event));
});

async function handleCron(event) {
  // Find all team codes by listing KV keys (not available on free tier easily)
  // Instead we store a registry of teams that have webhooks
  var regRaw = await FOCUS_BOARD.get('__teams__');
  var teams  = regRaw ? JSON.parse(regRaw) : [];
  for (var i = 0; i < teams.length; i++) {
    await sendWeeklySummary({ FOCUS_BOARD: FOCUS_BOARD }, teams[i]);
  }
}

// ── Fetch handler ──────────────────────────────────────────────────────────
addEventListener('fetch', function(event) {
  event.respondWith(handle(event.request));
});

async function handle(req) {
  if (req.method === 'OPTIONS') return new Response(null, { headers: CORS });

  var url    = new URL(req.url);
  var path   = url.pathname.replace(/\/$/, '');
  var method = req.method;
  var team   = req.headers.get('X-Team-Code')  || '';
  var admin  = req.headers.get('X-Admin-Code') || '';

  if (!team || team.length < 4 || !/^[a-zA-Z0-9\-]{4,32}$/.test(team)) {
    return respond({ error: 'Missing or invalid team code' }, 401);
  }

  // ── GET /ping ──────────────────────────────────────────────────────────
  if (method === 'GET' && path === '/ping') {
    var hasAdmin   = !!(await FOCUS_BOARD.get(team + ':admin'));
    var hasWebhook = !!(await FOCUS_BOARD.get(team + ':webhook'));
    return respond({ ok: true, team: team, hasAdmin: hasAdmin, hasWebhook: hasWebhook, ts: new Date().toISOString() });
  }

  // ── POST /admin/setup ──────────────────────────────────────────────────
  if (method === 'POST' && path === '/admin/setup') {
    var body; try { body = await req.json(); } catch(e) { return respond({ error: 'Invalid JSON' }, 400); }
    var newCode = (body.adminCode || '').trim();
    if (!newCode || newCode.length < 6) return respond({ error: 'Admin code must be at least 6 characters' }, 400);
    var existing = await FOCUS_BOARD.get(team + ':admin');
    if (existing && admin !== existing) return respond({ error: 'Incorrect admin code' }, 403);
    await FOCUS_BOARD.put(team + ':admin', newCode);
    return respond({ ok: true });
  }

  // ── GET /admin/verify ──────────────────────────────────────────────────
  if (method === 'GET' && path === '/admin/verify') {
    var stored = await FOCUS_BOARD.get(team + ':admin');
    if (!stored || admin !== stored) return respond({ ok: false, error: 'Incorrect admin code' }, 403);
    return respond({ ok: true });
  }

  // ── POST /admin/webhook ────────────────────────────────────────────────
  // Store the Teams webhook URL for this team
  if (method === 'POST' && path === '/admin/webhook') {
    var stored = await FOCUS_BOARD.get(team + ':admin');
    if (!stored || admin !== stored) return respond({ error: 'Admin access required' }, 403);
    var body; try { body = await req.json(); } catch(e) { return respond({ error: 'Invalid JSON' }, 400); }
    var webhookUrl = (body.webhookUrl || '').trim();
    if (webhookUrl) {
      await FOCUS_BOARD.put(team + ':webhook', webhookUrl);
      // Register this team for cron
      var regRaw = await FOCUS_BOARD.get('__teams__');
      var teams  = regRaw ? JSON.parse(regRaw) : [];
      if (!teams.includes(team)) { teams.push(team); await FOCUS_BOARD.put('__teams__', JSON.stringify(teams)); }
      return respond({ ok: true, message: 'Webhook saved' });
    } else {
      await FOCUS_BOARD.delete(team + ':webhook');
      return respond({ ok: true, message: 'Webhook removed' });
    }
  }

  // ── POST /notify ───────────────────────────────────────────────────────
  // Receive a notification event from the extension and post to Teams
  if (method === 'POST' && path === '/notify') {
    var body; try { body = await req.json(); } catch(e) { return respond({ error: 'Invalid JSON' }, 400); }
    var webhookUrl = await FOCUS_BOARD.get(team + ':webhook');
    var event = { type: body.type, who: body.who, taskTitle: body.taskTitle, listLabel: body.listLabel, ts: new Date().toISOString() };

    // Log for weekly summary
    await logActivity({ FOCUS_BOARD: FOCUS_BOARD }, team, event);

    // POST to Make webhook if configured
    var webhookResult = null;
    if (webhookUrl && body.type) {
      webhookResult = await sendToWebhook(webhookUrl, {
        type:      body.type,
        who:       body.who       || 'Someone',
        taskTitle: body.taskTitle || 'Untitled',
        listLabel: body.listLabel || '',
        ts:        new Date().toISOString(),
      });
    }

    return respond({ ok: true, webhook: webhookResult, webhookConfigured: !!webhookUrl });
  }

  // ── POST /admin/list ───────────────────────────────────────────────────
  if (method === 'POST' && path === '/admin/list') {
    var stored = await FOCUS_BOARD.get(team + ':admin');
    if (!stored || admin !== stored) return respond({ error: 'Admin access required' }, 403);
    var body; try { body = await req.json(); } catch(e) { return respond({ error: 'Invalid JSON' }, 400); }
    var listId = body.id || ('list-' + Date.now());
    var listLabel = body.label || listId;
    var idxRaw = await FOCUS_BOARD.get(team + ':index');
    var idx    = idxRaw ? JSON.parse(idxRaw) : [];
    if (!idx.find(function(l) { return l.id === listId; })) {
      idx.push({ id: listId, label: listLabel, updatedAt: new Date().toISOString(), count: 0 });
      await FOCUS_BOARD.put(team + ':index', JSON.stringify(idx));
    }
    return respond({ ok: true, id: listId, label: listLabel });
  }

  // ── DELETE /lists/:id ──────────────────────────────────────────────────
  if (method === 'DELETE' && path.indexOf('/lists/') === 0) {
    var stored = await FOCUS_BOARD.get(team + ':admin');
    if (!stored || admin !== stored) return respond({ error: 'Admin access required' }, 403);
    var listId = path.slice(7);
    await FOCUS_BOARD.delete(team + ':list:' + listId);
    var idxRaw = await FOCUS_BOARD.get(team + ':index');
    if (idxRaw) {
      var idx = JSON.parse(idxRaw).filter(function(l) { return l.id !== listId; });
      await FOCUS_BOARD.put(team + ':index', JSON.stringify(idx));
    }
    return respond({ ok: true });
  }

  // ── GET /lists ─────────────────────────────────────────────────────────
  if (method === 'GET' && path === '/lists') {
    var raw   = await FOCUS_BOARD.get(team + ':index');
    var index = raw ? JSON.parse(raw) : [];
    return respond({ lists: index });
  }

  // ── GET /lists/:id ─────────────────────────────────────────────────────
  if (method === 'GET' && path.indexOf('/lists/') === 0) {
    var listId = path.slice(7);
    if (!listId) return respond({ error: 'Missing list ID' }, 400);
    var raw = await FOCUS_BOARD.get(team + ':list:' + listId);
    if (!raw) return respond({ tasks: [], updatedAt: null });
    return respond(JSON.parse(raw));
  }

  // ── POST /lists/:id ────────────────────────────────────────────────────
  if (method === 'POST' && path.indexOf('/lists/') === 0) {
    var listId = path.slice(7);
    if (!listId) return respond({ error: 'Missing list ID' }, 400);
    var body; try { body = await req.json(); } catch(e) { return respond({ error: 'Invalid JSON' }, 400); }
    if (!Array.isArray(body.tasks)) return respond({ error: 'tasks must be an array' }, 400);

    var payload = { tasks: body.tasks, updatedAt: new Date().toISOString(), updatedBy: body.updatedBy || team };
    await FOCUS_BOARD.put(team + ':list:' + listId, JSON.stringify(payload));

    var idxRaw = await FOCUS_BOARD.get(team + ':index');
    var idx    = idxRaw ? JSON.parse(idxRaw) : [];
    var entry  = null;
    for (var i = 0; i < idx.length; i++) { if (idx[i].id === listId) { entry = idx[i]; break; } }
    if (entry) {
      entry.label = body.listLabel || entry.label;
      entry.updatedAt = payload.updatedAt;
      entry.count = body.tasks.length;
    } else {
      idx.push({ id: listId, label: body.listLabel || listId, updatedAt: payload.updatedAt, count: body.tasks.length });
    }
    await FOCUS_BOARD.put(team + ':index', JSON.stringify(idx));
    return respond({ ok: true, updatedAt: payload.updatedAt });
  }

  return respond({ error: 'Not found' }, 404);
}
