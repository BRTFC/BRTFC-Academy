import { db, ref, set, get, push, update, remove, onValue, child }
  from './firebase.js';

// ── STATE ────────────────────────────────────────────────────────
let currentCoach = null;
let allPlayers   = {};
let allCoaches   = {};
let allTraining  = {};
let allMatches   = {};
let allMonthly   = {};
let allGoals     = {};
let halfTerms    = {};
let termDates    = {
  1: { start: '', end: '' },
  2: { start: '', end: '' },
  3: { start: '', end: '' }
};
let activePlayerFilter = 'all';

const POSITIONS = ['GK','CB','RB','LB','CDM','CM','CAM','RW','LW','ST'];

const PHASE_GROUPS = {
  '1':    ['U14','U15'],
  '2':    ['U16','U18'],
  'both': ['U14','U15','U16','U18']
};

function coachPhaseGroups() {
  const phase = currentCoach?.phase || 'both';
  return PHASE_GROUPS[phase] || PHASE_GROUPS['both'];
}

function groupInCoachPhase(group) {
  return coachPhaseGroups().includes(group);
}

// ── BOOT ─────────────────────────────────────────────────────────
window.addEventListener('DOMContentLoaded', () => {
  setTodayDates();
  listenData();

  document.getElementById('login-pin').addEventListener('keydown', e => {
    if (e.key === 'Enter') doLogin();
  });
});

function setTodayDates() {
  const today = new Date().toISOString().split('T')[0];
  const nowMonth = today.slice(0, 7);
  ['tr-date','mr-date'].forEach(id => {
    const el = document.getElementById(id);
    if (el) el.value = today;
  });
  const mo = document.getElementById('mo-month');
  if (mo) mo.value = nowMonth;
}

// ── FIREBASE LISTENERS ───────────────────────────────────────────
function listenData() {
  onValue(ref(db, 'players'),   s => { allPlayers  = s.val() || {}; renderPlayersView(); });
  onValue(ref(db, 'coaches'),   s => { allCoaches  = s.val() || {}; renderCoachesList(); });
  onValue(ref(db, 'training'),  s => { allTraining = s.val() || {}; });
  onValue(ref(db, 'matches'),   s => { allMatches  = s.val() || {}; });
  onValue(ref(db, 'monthly'),   s => { allMonthly  = s.val() || {}; });
  onValue(ref(db, 'goals'),     s => { allGoals    = s.val() || {}; });
  onValue(ref(db, 'halfTerms'), s => { halfTerms = s.val() || {}; populateHalfTermSelects(); renderHalfTermFields(); });
  onValue(ref(db, 'termDates'), s => {
    if (s.val()) { termDates = s.val(); }
    renderTermFields();
  });
}

// ── AUTH ─────────────────────────────────────────────────────────
window.doLogin = function() {
  const pin = document.getElementById('login-pin').value.trim();
  if (!pin) return;

  const coach = Object.entries(allCoaches).find(([id, c]) => String(c.pin) === String(pin));
  if (!coach) {
    document.getElementById('login-error').textContent = 'Incorrect PIN. Try again.';
    document.getElementById('login-pin').value = '';
    return;
  }

  currentCoach = { id: coach[0], ...coach[1] };
  document.getElementById('login-pin').value = '';
  document.getElementById('login-error').textContent = '';
  document.getElementById('header-coach-name').textContent = currentCoach.name;

  if (currentCoach.admin) {
    document.querySelectorAll('.nav-admin').forEach(el => el.classList.remove('hidden'));
  }

  document.getElementById('screen-login').classList.add('hidden');
  document.getElementById('screen-app').classList.remove('hidden');
  renderPlayersView();
};

window.doLogout = function() {
  currentCoach = null;
  document.getElementById('screen-app').classList.add('hidden');
  document.getElementById('screen-login').classList.remove('hidden');
  document.querySelectorAll('.nav-admin').forEach(el => el.classList.add('hidden'));
};

// ── VIEW SWITCHING ────────────────────────────────────────────────
window.switchView = function(v, btn) {
  document.querySelectorAll('.view').forEach(el => {
    el.classList.remove('active');
    el.classList.add('hidden');
  });
  const el = document.getElementById('view-' + v);
  if (el) { el.classList.remove('hidden'); el.classList.add('active'); }
  document.querySelectorAll('.nav-btn').forEach(b => b.classList.remove('active'));
  if (btn) btn.classList.add('active');

  if (v === 'training') initTrainingView();
  if (v === 'match')    initMatchView();
  if (v === 'monthly')  initMonthlyView();
  if (v === 'admin')    renderAdminPlayers();
};

// ── PLAYERS VIEW ──────────────────────────────────────────────────
window.filterPlayers = function(g, btn) {
  activePlayerFilter = g;
  document.querySelectorAll('#players-group-filter .filter-btn').forEach(b => b.classList.remove('active'));
  btn.classList.add('active');
  renderPlayersView();
};

function renderPlayersView() {
  const list = document.getElementById('players-list');
  if (!list) return;
  const filtered = Object.entries(allPlayers).filter(([id, p]) =>
    activePlayerFilter === 'all' || p.group === activePlayerFilter
  );
  if (!filtered.length) {
    list.innerHTML = '<div class="empty-state">No players found.</div>';
    return;
  }
  filtered.sort((a, b) => a[1].lname.localeCompare(b[1].lname));
  list.innerHTML = filtered.map(([id, p]) => {
    const avg = getPlayerOverallAvg(id);
    return `<div class="player-card" onclick="openPlayerModal('${id}')">
      <div class="player-avatar">${initials(p)}</div>
      <div class="player-card-info">
        <div class="player-card-name">${p.fname} ${p.lname}</div>
        <div class="player-card-meta">
          <span class="badge badge-group">${p.group}</span>
          <span class="badge badge-pos" style="margin-left:4px;">${p.pos}</span>
        </div>
        ${avg ? `<div style="font-size:12px;color:var(--text3);margin-top:3px;">Avg ${avg}/5</div>` : ''}
      </div>
    </div>`;
  }).join('');
}

// ── PLAYER MODAL ──────────────────────────────────────────────────
window.openPlayerModal = function(pid) {
  const p = allPlayers[pid];
  if (!p) return;
  document.getElementById('modal-player-name').textContent = `${p.fname} ${p.lname}`;

  const trainingSessions = Object.values(allTraining).filter(t =>
    t.entries && t.entries[pid]
  );
  const matchSessions = Object.values(allMatches).filter(m =>
    m.entries && m.entries[pid]
  );

  const trainAvg = calcAvg(trainingSessions.map(t => {
    const e = t.entries[pid];
    return (e.performance + e.attitude) / 2;
  }));
  const matchAvg = calcAvg(matchSessions.map(m => {
    const e = m.entries[pid];
    return (e.performance + e.tactical + e.behaviours) / 3;
  }));

  const age = p.dob ? calcAge(p.dob) : 'N/A';
  const goals = Object.values(allGoals).filter(g => g.pid === pid);

  document.getElementById('modal-player-content').innerHTML = `
    <div class="modal-body">
      <div style="display:flex;gap:10px;margin-bottom:1.25rem;flex-wrap:wrap;">
        <span class="badge badge-group" style="font-size:13px;padding:4px 10px;">${p.group}</span>
        <span class="badge badge-pos" style="font-size:13px;padding:4px 10px;">${p.pos}</span>
        <span style="font-size:13px;color:var(--text2);">DOB: ${p.dob || 'N/A'}</span>
        <span style="font-size:13px;color:var(--text2);">Age: ${age}</span>
      </div>
      <div class="modal-stat-grid">
        <div class="modal-stat"><div class="modal-stat-val">${trainingSessions.length}</div><div class="modal-stat-lbl">Training sessions</div></div>
        <div class="modal-stat"><div class="modal-stat-val">${matchSessions.length}</div><div class="modal-stat-lbl">Matches</div></div>
        <div class="modal-stat"><div class="modal-stat-val">${goals.filter(g => g.achieved).length}/${goals.length}</div><div class="modal-stat-lbl">Goals met</div></div>
      </div>
      ${trainAvg ? `<div style="font-size:13px;color:var(--text2);margin-bottom:6px;">Training avg: <strong>${trainAvg}/5</strong> &nbsp;|&nbsp; Match avg: <strong>${matchAvg || 'N/A'}/5</strong></div>` : ''}
      <div style="margin-top:1rem;">
        <button class="btn-primary" onclick="closeModal('modal-player');switchView('idp',document.querySelector('[data-view=idp]'));setTimeout(()=>{document.getElementById('idp-player').value='${pid}';renderIDP();},100);">
          View full IDP
        </button>
      </div>
    </div>
  `;
  document.getElementById('modal-player').classList.remove('hidden');
};

window.closeModal = function(id) {
  document.getElementById(id).classList.add('hidden');
};

// ── TRAINING VIEW ─────────────────────────────────────────────────
function initTrainingView() {
  const grpSel = document.getElementById('tr-group');
  const groups = coachPhaseGroups();
  grpSel.innerHTML = '<option value="">Select group...</option>' +
    groups.map(g => `<option>${g}</option>`).join('');
  loadTrainingPlayers();
}

window.loadTrainingPlayers = function() {
  const group = document.getElementById('tr-group').value;
  const container = document.getElementById('tr-players-container');
  if (!group) { container.innerHTML = '<div class="empty-state">Select an age group to load players.</div>'; return; }

  const players = Object.entries(allPlayers).filter(([id, p]) => p.group === group)
    .sort((a, b) => a[1].lname.localeCompare(b[1].lname));

  if (!players.length) { container.innerHTML = '<div class="empty-state">No players in this group.</div>'; return; }

  container.innerHTML = players.map(([id, p]) => `
    <div class="report-player-row">
      <div class="report-player-header">
        <div class="player-avatar" style="width:34px;height:34px;font-size:12px;">${initials(p)}</div>
        <div class="report-player-name">${p.fname} ${p.lname}</div>
        <span class="badge badge-pos">${p.pos}</span>
      </div>
      <div class="rating-group">
        <div class="rating-item">
          <div class="rating-label">Performance</div>
          <div class="stars" id="tr_perf_${id}" data-val="3">
            ${buildStars(`tr_perf_${id}`, 3)}
          </div>
        </div>
        <div class="rating-item">
          <div class="rating-label">Attitude</div>
          <div class="stars" id="tr_att_${id}" data-val="3">
            ${buildStars(`tr_att_${id}`, 3)}
          </div>
        </div>
      </div>
    </div>
  `).join('');
};

window.saveTrainingReport = async function() {
  const date    = document.getElementById('tr-date').value;
  const group   = document.getElementById('tr-group').value;
  const session = document.getElementById('tr-session').value;
  if (!date || !group) { toast('Select a date and age group.'); return; }

  const players = Object.entries(allPlayers).filter(([id, p]) => p.group === group);
  if (!players.length) { toast('No players loaded.'); return; }

  const entries = {};
  players.forEach(([id]) => {
    const perfEl = document.getElementById(`tr_perf_${id}`);
    const attEl  = document.getElementById(`tr_att_${id}`);
    if (perfEl && attEl) {
      entries[id] = {
        performance: parseInt(perfEl.dataset.val || 3),
        attitude:    parseInt(attEl.dataset.val  || 3)
      };
    }
  });

  const block = document.getElementById('tr-block')?.value || '';
  const cycle = document.getElementById('tr-cycle')?.value || '';
  const key = `${date}_${group}_S${session}`;
  await set(ref(db, `training/${key}`), {
    date, group, session: parseInt(session),
    block, cycle,
    coach: currentCoach.name,
    coachId: currentCoach.id,
    entries
  });
  toast('Training session saved.');
};

// ── MATCH VIEW ────────────────────────────────────────────────────
function initMatchView() {
  const grpSel = document.getElementById('mr-group');
  const groups = coachPhaseGroups();
  grpSel.innerHTML = '<option value="">Select group...</option>' +
    groups.map(g => `<option>${g}</option>`).join('');
  loadMatchPlayers();
}

window.loadMatchPlayers = function() {
  const group = document.getElementById('mr-group').value;
  const container = document.getElementById('mr-players-container');
  if (!group) { container.innerHTML = '<div class="empty-state">Select an age group to load players.</div>'; return; }

  const players = Object.entries(allPlayers).filter(([id, p]) => p.group === group)
    .sort((a, b) => a[1].lname.localeCompare(b[1].lname));

  if (!players.length) { container.innerHTML = '<div class="empty-state">No players in this group.</div>'; return; }

  container.innerHTML = players.map(([id, p]) => `
    <div class="report-player-row">
      <div class="report-player-header">
        <div class="player-avatar" style="width:34px;height:34px;font-size:12px;">${initials(p)}</div>
        <div class="report-player-name">${p.fname} ${p.lname}</div>
        <select class="match-pos-select" id="mr_pos_${id}">
          ${POSITIONS.map(pos => `<option ${pos === p.pos ? 'selected' : ''}>${pos}</option>`).join('')}
        </select>
      </div>
      <div class="rating-group">
        <div class="rating-item">
          <div class="rating-label">Performance</div>
          <div class="stars" id="mr_perf_${id}" data-val="3">${buildStars(`mr_perf_${id}`, 3)}</div>
        </div>
        <div class="rating-item">
          <div class="rating-label">Tactical understanding</div>
          <div class="stars" id="mr_tact_${id}" data-val="3">${buildStars(`mr_tact_${id}`, 3)}</div>
        </div>
        <div class="rating-item">
          <div class="rating-label">Behaviours</div>
          <div class="stars" id="mr_beh_${id}" data-val="3">${buildStars(`mr_beh_${id}`, 3)}</div>
        </div>
      </div>
    </div>
  `).join('');
};

window.saveMatchReport = async function() {
  const date       = document.getElementById('mr-date').value;
  const group      = document.getElementById('mr-group').value;
  const opposition = document.getElementById('mr-opposition').value.trim();
  const venue      = document.getElementById('mr-venue').value;
  if (!date || !group) { toast('Select a date and age group.'); return; }

  const players = Object.entries(allPlayers).filter(([id, p]) => p.group === group);
  const entries = {};
  players.forEach(([id]) => {
    const perfEl = document.getElementById(`mr_perf_${id}`);
    const tactEl = document.getElementById(`mr_tact_${id}`);
    const behEl  = document.getElementById(`mr_beh_${id}`);
    const posEl  = document.getElementById(`mr_pos_${id}`);
    if (perfEl) {
      entries[id] = {
        performance: parseInt(perfEl.dataset.val || 3),
        tactical:    parseInt(tactEl?.dataset.val  || 3),
        behaviours:  parseInt(behEl?.dataset.val   || 3),
        position:    posEl?.value || 'N/A'
      };
    }
  });

  const dnaPress      = document.querySelector('#dna-press .dna-toggle.active-yes, #dna-press .dna-toggle.active-partly, #dna-press .dna-toggle.active-no');
  const dnaTransition = document.querySelector('#dna-transition .dna-toggle.active-yes, #dna-transition .dna-toggle.active-partly, #dna-transition .dna-toggle.active-no');
  const dnaControl    = document.querySelector('#dna-control .dna-toggle.active-yes, #dna-control .dna-toggle.active-partly, #dna-control .dna-toggle.active-no');
  const dna = {
    press:      dnaPress?.dataset.val      || '',
    transition: dnaTransition?.dataset.val || '',
    control:    dnaControl?.dataset.val    || ''
  };

  const key = `${date}_${group}`;
  await set(ref(db, `matches/${key}`), {
    date, group, opposition, venue,
    coach: currentCoach.name,
    coachId: currentCoach.id,
    dna, entries
  });
  toast('Match report saved.');
};

// ── MONTHLY VIEW ──────────────────────────────────────────────────
function initMonthlyView() {
  populateHalfTermSelects();
  const grpSel = document.getElementById('mo-group');
  const groups = coachPhaseGroups();
  grpSel.innerHTML = '<option value="">Select group...</option>' +
    groups.map(g => `<option>${g}</option>`).join('');
  // Show phase notice
  const notice = document.getElementById('ht-phase-notice');
  const phase = currentCoach?.phase || 'both';
  if (notice) {
    const label = phase === '1' ? 'Phase 1 (U14 and U15)' : phase === '2' ? 'Phase 2 (U16 and U18)' : 'All phases';
    notice.textContent = `You can add reviews for: ${label}`;
    notice.style.display = 'block';
  }
  loadMonthlyPlayers();
}

function populateHalfTermSelects() {
  const sel = document.getElementById('mo-month');
  if (!sel) return;
  const cur = sel.value;
  sel.innerHTML = '<option value="">Select half term...</option>';
  Object.entries(halfTerms)
    .sort((a,b) => a[1].start.localeCompare(b[1].start))
    .forEach(([key, ht]) => {
      sel.innerHTML += `<option value="${key}">${ht.label} (${ht.start} to ${ht.end})</option>`;
    });
  if (cur) sel.value = cur;
}

window.loadMonthlyPlayers = function() {
  const group = document.getElementById('mo-group').value;
  const sel   = document.getElementById('mo-player');
  sel.innerHTML = '<option value="">Select player...</option>';
  document.getElementById('mo-form-container').innerHTML = '';
  if (!group) return;
  Object.entries(allPlayers)
    .filter(([id, p]) => p.group === group)
    .sort((a, b) => a[1].lname.localeCompare(b[1].lname))
    .forEach(([id, p]) => {
      sel.innerHTML += `<option value="${id}">${p.fname} ${p.lname}</option>`;
    });
};

window.loadMonthlyForm = function() {
  const pid   = document.getElementById('mo-player').value;
  const month = document.getElementById('mo-month').value;
  const container = document.getElementById('mo-form-container');
  if (!pid) { container.innerHTML = ''; return; }

  const existing = allMonthly[`${month}_${pid}`] || {};

  const categories = [
    { key: 'technical',  label: 'On the Ball', sub: 'Calm, controlled, forward-first mindset' },
    { key: 'tactical',   label: 'Game Understanding', sub: 'Recognise situations, react, exploit space' },
    { key: 'behaviours', label: 'Compete and Commit', sub: 'Press, win first contact, work rate' },
    { key: 'physical',   label: 'Physical Execution', sub: 'Sprint, recover, support at intensity' }
  ];

  container.innerHTML = categories.map(cat => `
    <div class="monthly-category">
      <div class="monthly-cat-title">${cat.label}</div>
      <div style="font-size:12px;color:var(--text3);margin-bottom:12px;">${cat.sub}</div>
      <div class="rating-item" style="margin-bottom:12px;">
        <div class="rating-label">Rating</div>
        <div class="stars" id="mo_${cat.key}_stars" data-val="${existing[cat.key]?.rating || 3}">
          ${buildStars(`mo_${cat.key}_stars`, existing[cat.key]?.rating || 3)}
        </div>
      </div>
      <div class="form-group">
        <label>Comments</label>
        <textarea id="mo_${cat.key}_comments" placeholder="Observations for ${cat.label.toLowerCase()} this month...">${existing[cat.key]?.comments || ''}</textarea>
      </div>
    </div>
  `).join('') + `
    <div class="monthly-category" style="border-left:4px solid #2A8C3F;">
      <div class="monthly-cat-title" style="color:#1a5c28;">BRTFC Non-Negotiables</div>
      <div style="font-size:12px;color:var(--text3);margin-bottom:12px;">Scan early. Communicate early. React immediately.</div>
      <div class="rating-item" style="margin-bottom:12px;">
        <div class="rating-label">How consistently did this player scan, communicate and react this month?</div>
        <div class="stars" id="mo_nonneg_stars" data-val="${existing.nonNegotiables?.rating || 3}">
          ${buildStars('mo_nonneg_stars', existing.nonNegotiables?.rating || 3)}
        </div>
      </div>
      <div class="form-group">
        <label>Comments</label>
        <textarea id="mo_nonneg_comments" placeholder="Specific examples of scanning, communication and reaction...">${existing.nonNegotiables?.comments || ''}</textarea>
      </div>
    </div>
    <div class="monthly-category">
      <div class="monthly-cat-title">Term goals</div>
      <div id="mo-goals-list" style="margin-bottom:12px;"></div>
      <div style="display:flex;gap:8px;margin-top:8px;">
        <input type="text" id="mo-new-goal" placeholder="Add a goal for this player...">
        <button class="btn-secondary" onclick="addMonthlyGoal('${pid}')">Add</button>
      </div>
    </div>
    <div class="form-actions">
      <button class="btn-primary" onclick="saveMonthlyReport('${pid}')">Save monthly report</button>
    </div>
  `;

  renderMonthlyGoals(pid);
};

function renderMonthlyGoals(pid) {
  const el = document.getElementById('mo-goals-list');
  if (!el) return;
  const goals = Object.entries(allGoals).filter(([id, g]) => g.pid === pid);
  if (!goals.length) {
    el.innerHTML = '<div style="font-size:13px;color:var(--text3);">No goals set yet.</div>';
    return;
  }
  el.innerHTML = goals.map(([id, g]) => `
    <div style="display:flex;align-items:center;gap:10px;padding:8px 0;border-bottom:1px solid var(--border);">
      <div onclick="toggleGoal('${id}','${pid}')" style="cursor:pointer;">
        <div class="idp-goal-checkbox ${g.achieved ? 'done' : ''}"></div>
      </div>
      <span style="flex:1;font-size:14px;${g.achieved ? 'text-decoration:line-through;color:var(--text3);' : ''}">${g.text}</span>
      <button onclick="deleteGoal('${id}')" class="btn-danger" style="padding:3px 8px;font-size:12px;">✕</button>
    </div>
  `).join('');
}

window.addMonthlyGoal = async function(pid) {
  const inp = document.getElementById('mo-new-goal');
  const text = inp.value.trim();
  if (!text) return;
  await push(ref(db, 'goals'), {
    pid,
    text,
    achieved: false,
    setBy: currentCoach.name,
    setAt: new Date().toISOString()
  });
  inp.value = '';
  toast('Goal added.');
};

window.toggleGoal = async function(goalId, pid) {
  const goal = allGoals[goalId];
  if (!goal) return;
  await update(ref(db, `goals/${goalId}`), { achieved: !goal.achieved });
};

window.deleteGoal = async function(goalId) {
  if (!confirm('Delete this goal?')) return;
  await remove(ref(db, `goals/${goalId}`));
};

window.saveMonthlyReport = async function(pid) {
  const month = document.getElementById('mo-month').value;
  if (!month || !pid) { toast('Select a month and player.'); return; }

  const categories = ['technical','tactical','behaviours','physical'];
  const data = {};
  categories.forEach(cat => {
    const starsEl    = document.getElementById(`mo_${cat}_stars`);
    const commentsEl = document.getElementById(`mo_${cat}_comments`);
    data[cat] = {
      rating:   parseInt(starsEl?.dataset.val || 3),
      comments: commentsEl?.value.trim() || ''
    };
  });
  const nnStars    = document.getElementById('mo_nonneg_stars');
  const nnComments = document.getElementById('mo_nonneg_comments');
  data.nonNegotiables = {
    rating:   parseInt(nnStars?.dataset.val || 3),
    comments: nnComments?.value.trim() || ''
  };

  const key = `${month}_${pid}`;
  await set(ref(db, `monthly/${key}`), {
    month, pid,
    coach: currentCoach.name,
    coachId: currentCoach.id,
    ...data
  });
  toast('Monthly report saved.');
};

// ── IDP ───────────────────────────────────────────────────────────
window.loadIDPPlayers = function() {
  const group = document.getElementById('idp-group').value;
  const sel   = document.getElementById('idp-player');
  sel.innerHTML = '<option value="">Select player...</option>';
  if (!group) return;
  Object.entries(allPlayers)
    .filter(([id, p]) => p.group === group)
    .sort((a, b) => a[1].lname.localeCompare(b[1].lname))
    .forEach(([id, p]) => {
      sel.innerHTML += `<option value="${id}">${p.fname} ${p.lname}</option>`;
    });
};

window.renderIDP = function() {
  const pid    = document.getElementById('idp-player').value;
  const termNo = document.getElementById('idp-term').value;
  const output = document.getElementById('idp-output');

  if (!pid) { output.innerHTML = '<div class="empty-state">Select a player to generate their IDP.</div>'; return; }

  const p = allPlayers[pid];
  if (!p) return;

  const termLabel = { '1': 'Term 1 (Aug-Oct)', '2': 'Term 2 (Nov-Jan)', '3': 'Term 3 (Feb-Apr)' }[termNo];
  const termRange = getTermRange(parseInt(termNo));

  // Filter data to this term
  const trainSessions = Object.values(allTraining).filter(t =>
    t.entries?.[pid] && inTermRange(t.date, termRange)
  );
  const matchSessions = Object.values(allMatches).filter(m =>
    m.entries?.[pid] && inTermRange(m.date, termRange)
  );
  const monthlyReports = Object.values(allMonthly).filter(mo =>
    mo.pid === pid && inTermRange(mo.month + '-01', termRange)
  );
  const goals = Object.entries(allGoals).filter(([id, g]) => g.pid === pid);

  // Averages
  const trainPerfAvg = calcAvg(trainSessions.map(t => t.entries[pid].performance));
  const trainAttAvg  = calcAvg(trainSessions.map(t => t.entries[pid].attitude));
  const matchPerfAvg = calcAvg(matchSessions.map(m => m.entries[pid].performance));
  const matchTactAvg = calcAvg(matchSessions.map(m => m.entries[pid].tactical));
  const matchBehAvg  = calcAvg(matchSessions.map(m => m.entries[pid].behaviours));

  const moAvgs = {};
  ['technical','tactical','behaviours','physical','nonNegotiables'].forEach(cat => {
    moAvgs[cat] = calcAvg(monthlyReports.map(r => r[cat]?.rating || 0).filter(v => v > 0));
    moAvgs[`${cat}_comments`] = monthlyReports
      .map(r => r[cat]?.comments)
      .filter(Boolean)
      .join(' ');
  });
  const DNA_LABELS = {
    technical:       'On the Ball',
    tactical:        'Game Understanding',
    behaviours:      'Compete and Commit',
    physical:        'Physical Execution',
    nonNegotiables:  'BRTFC Non-Negotiables'
  };

  const overallAvg = calcAvg([
    trainPerfAvg, trainAttAvg, matchPerfAvg, matchTactAvg, matchBehAvg,
    moAvgs.technical, moAvgs.tactical, moAvgs.behaviours, moAvgs.physical
  ].map(v => parseFloat(v)).filter(v => !isNaN(v) && v > 0));

  const age  = p.dob ? calcAge(p.dob) : 'N/A';
  const year = new Date().getFullYear();

  output.innerHTML = `
    <div class="idp-doc">
      <div class="idp-header-band">
        <div class="idp-club-name">Bognor Regis Town FC</div>
        <div class="idp-doc-title">Individual Development Plan</div>
        <div class="idp-player-name">${p.fname} ${p.lname}</div>
        <div class="idp-meta-row">
          <div class="idp-meta-item"><strong>${termLabel}</strong>Term</div>
          <div class="idp-meta-item"><strong>${p.group}</strong>Age group</div>
          <div class="idp-meta-item"><strong>${p.pos}</strong>Position</div>
          <div class="idp-meta-item"><strong>${age}</strong>Age</div>
          <div class="idp-meta-item"><strong>${overallAvg ? overallAvg + '/5' : 'N/A'}</strong>Overall rating</div>
        </div>
      </div>

      <div class="idp-body">

        <div class="idp-section">
          <div class="idp-section-title">Season summary</div>
          <div class="idp-metric-grid">
            <div class="idp-metric"><div class="idp-metric-val">${trainSessions.length}</div><div class="idp-metric-lbl">Training sessions</div></div>
            <div class="idp-metric"><div class="idp-metric-val">${matchSessions.length}</div><div class="idp-metric-lbl">Matches</div></div>
            <div class="idp-metric"><div class="idp-metric-val">${trainPerfAvg || 'N/A'}</div><div class="idp-metric-lbl">Training performance avg</div></div>
            <div class="idp-metric"><div class="idp-metric-val">${trainAttAvg || 'N/A'}</div><div class="idp-metric-lbl">Training attitude avg</div></div>
            <div class="idp-metric"><div class="idp-metric-val">${matchPerfAvg || 'N/A'}</div><div class="idp-metric-lbl">Match performance avg</div></div>
          </div>
        </div>

        ${trainSessions.length ? `
        <div class="idp-section">
          <div class="idp-section-title">Training performance</div>
          ${idpBar('Performance', trainPerfAvg)}
          ${idpBar('Attitude', trainAttAvg)}
        </div>` : ''}

        ${matchSessions.length ? `
        <div class="idp-section">
          <div class="idp-section-title">Match performance</div>
          ${idpBar('Performance', matchPerfAvg)}
          ${idpBar('Tactical understanding', matchTactAvg)}
          ${idpBar('Behaviours', matchBehAvg)}
        </div>` : ''}

        ${monthlyReports.length ? `
        <div class="idp-section">
          <div class="idp-section-title">Monthly assessment</div>
          ${['technical','tactical','behaviours','physical'].map(cat => `
            <div style="margin-bottom:1.25rem;">
              <div style="font-size:13px;font-weight:600;color:var(--text);margin-bottom:6px;">${DNA_LABELS[cat]}</div>
              ${idpBar(DNA_LABELS[cat], moAvgs[cat])}
              ${moAvgs[cat+'_comments'] ? `<div class="idp-comments-block">${moAvgs[cat+'_comments']}</div>` : ''}
            </div>
          `).join('')}
          ${moAvgs.nonNegotiables ? `
          <div style="margin-bottom:1.25rem;padding:12px 14px;background:var(--green-light);border-radius:var(--radius);border-left:4px solid var(--green);">
            <div style="font-size:13px;font-weight:700;color:var(--green-dark);margin-bottom:4px;">BRTFC Non-Negotiables</div>
            <div style="font-size:12px;color:var(--text2);margin-bottom:8px;">Scan early. Communicate early. React immediately.</div>
            ${idpBar('Consistency', moAvgs.nonNegotiables)}
            ${moAvgs.nonNegotiables_comments ? `<div class="idp-comments-block" style="margin-top:6px;">${moAvgs.nonNegotiables_comments}</div>` : ''}
          </div>` : ''}
        </div>` : ''}

        <div class="idp-section">
          <div class="idp-section-title">Development goals</div>
          ${goals.length ? `
            <div class="idp-goals-list">
              ${goals.slice(0, 2).map(([id, g]) => `
                <div class="idp-goal-item">
                  <div class="idp-goal-checkbox ${g.achieved ? 'done' : ''}"
                    onclick="toggleGoal('${id}','${p.id}');setTimeout(renderIDP,300);"
                    title="${g.achieved ? 'Mark incomplete' : 'Mark achieved'}"></div>
                  <div class="idp-goal-text">
                    <div style="${g.achieved ? 'text-decoration:line-through;color:var(--text3);' : ''}">${g.text}</div>
                    <div class="idp-goal-set-by">Set by ${g.setBy} &bull; ${g.achieved ? '✓ Achieved' : 'In progress'}</div>
                  </div>
                </div>
              `).join('')}
            </div>
          ` : '<div style="font-size:14px;color:var(--text3);">No goals set for this term.</div>'}
        </div>

      </div>

      <div class="idp-actions">
        <button class="btn-primary" onclick="window.open('idp-generator.html')">Open IDP Generator</button>
        <button class="btn-secondary" onclick="emailIDPPrompt('${pid}')">Generate email</button>
      </div>

      <div class="idp-footer">
        <span>Bognor Regis Town FC Academy &bull; ${termLabel} ${year}</span>
        <span>Confidential</span>
      </div>
    </div>
  `;
};

function idpBar(label, val) {
  if (!val) return '';
  const pct = Math.round((val / 5) * 100);
  return `<div class="idp-bar-row">
    <div class="idp-bar-labels"><span>${label}</span><span>${val}/5</span></div>
    <div class="idp-bar-track"><div class="idp-bar-fill" style="width:${pct}%"></div></div>
  </div>`;
}

window.emailIDPPrompt = function(pid) {
  const p = allPlayers[pid];
  if (!p) return;
  const termNo = document.getElementById('idp-term').value;
  const termLabel = { '1': 'Term 1 (Aug-Oct)', '2': 'Term 2 (Nov-Jan)', '3': 'Term 3 (Feb-Apr)' }[termNo];
  const goals = Object.values(allGoals).filter(g => g.pid === pid).slice(0, 2);
  const termRange = getTermRange(parseInt(termNo));
  const trainSessions = Object.values(allTraining).filter(t => t.entries?.[pid] && inTermRange(t.date, termRange));
  const matchSessions = Object.values(allMatches).filter(m => m.entries?.[pid] && inTermRange(m.date, termRange));
  const trainPerfAvg = calcAvg(trainSessions.map(t => t.entries[pid].performance));
  const trainAttAvg  = calcAvg(trainSessions.map(t => t.entries[pid].attitude));
  const matchPerfAvg = calcAvg(matchSessions.map(m => m.entries[pid].performance));

  const prompt = `Write a professional and encouraging Individual Development Plan email for ${p.fname} ${p.lname}, a ${p.pos} in the ${p.group} at Bognor Regis Town FC Academy.

Term: ${termLabel}
Training sessions attended: ${trainSessions.length}
Matches played: ${matchSessions.length}
Training performance avg: ${trainPerfAvg || 'N/A'}/5
Training attitude avg: ${trainAttAvg || 'N/A'}/5
Match performance avg: ${matchPerfAvg || 'N/A'}/5

Goals:
${goals.map(g => `- ${g.text} (${g.achieved ? 'Achieved' : 'In progress'})`).join('\n') || 'No goals set.'}

Address it to the player and their parents. Be specific, honest, and constructive. Include a subject line. End with encouragement for next term. Sign off from the BRTFC Academy coaching team.`;

  if (window.sendPrompt) window.sendPrompt(prompt);
};

// ── ADMIN ─────────────────────────────────────────────────────────
window.switchAdminTab = function(tab, btn) {
  document.querySelectorAll('.admin-panel').forEach(el => {
    el.classList.remove('active');
    el.classList.add('hidden');
  });
  const el = document.getElementById('admin-' + tab);
  if (el) { el.classList.remove('hidden'); el.classList.add('active'); }
  document.querySelectorAll('.admin-tab').forEach(b => b.classList.remove('active'));
  if (btn) btn.classList.add('active');
  if (tab === 'players')   renderAdminPlayers();
  if (tab === 'terms')     renderTermFields();
  if (tab === 'halfterms') renderHalfTermFields();
};

window.addCoach = async function() {
  const name  = document.getElementById('ac-name').value.trim();
  const pin   = document.getElementById('ac-pin').value.trim();
  const role  = document.getElementById('ac-role').value.trim();
  const phase = document.getElementById('ac-phase').value;
  const admin = document.getElementById('ac-admin').value === 'true';
  if (!name || !pin) { setStatus('coach-status', 'Name and PIN are required.', false); return; }
  if (pin.length < 4) { setStatus('coach-status', 'PIN must be at least 4 digits.', false); return; }
  const exists = Object.values(allCoaches).find(c => String(c.pin) === String(pin));
  if (exists) { setStatus('coach-status', 'That PIN is already in use.', false); return; }
  await push(ref(db, 'coaches'), { name, pin, role, phase, admin });
  ['ac-name','ac-pin','ac-role'].forEach(id => document.getElementById(id).value = '');
  setStatus('coach-status', `Coach ${name} added.`, true);
};

function renderCoachesList() {
  const el = document.getElementById('coaches-list');
  if (!el) return;
  const coaches = Object.entries(allCoaches);
  if (!coaches.length) { el.innerHTML = '<div class="empty-state">No coaches added yet.</div>'; return; }
  el.innerHTML = coaches.map(([id, c]) => `
    <div class="data-row">
      <div class="data-row-info">
        <div class="data-row-name">${c.name}</div>
        <div class="data-row-sub">${c.role || 'Coach'} &bull; Phase ${c.phase === '1' ? '1 (U14/U15)' : c.phase === '2' ? '2 (U16/U18)' : 'All'} &bull; ${c.admin ? 'Admin' : 'Standard access'}</div>
      </div>
      <button class="btn-danger" onclick="removeCoach('${id}','${c.name}')">Remove</button>
    </div>
  `).join('');
}

window.removeCoach = async function(id, name) {
  if (!confirm(`Remove ${name}?`)) return;
  await remove(ref(db, `coaches/${id}`));
};

window.addPlayerManual = async function() {
  const fname  = document.getElementById('ap-fname').value.trim();
  const lname  = document.getElementById('ap-lname').value.trim();
  const dob    = document.getElementById('ap-dob').value;
  const group  = document.getElementById('ap-group').value;
  const pos    = document.getElementById('ap-pos').value;
  const email  = document.getElementById('ap-email').value.trim();
  const pemail = document.getElementById('ap-pemail').value.trim();
  if (!fname || !lname) { setStatus('player-status', 'First and last name required.', false); return; }
  await push(ref(db, 'players'), { fname, lname, dob, group, pos, email, pemail });
  ['ap-fname','ap-lname','ap-dob','ap-email','ap-pemail'].forEach(id => document.getElementById(id).value = '');
  setStatus('player-status', `${fname} ${lname} added.`, true);
};

function renderAdminPlayers() {
  const el = document.getElementById('admin-players-list');
  if (!el) return;
  const sorted = Object.entries(allPlayers).sort((a, b) => a[1].lname.localeCompare(b[1].lname));
  if (!sorted.length) { el.innerHTML = '<div class="empty-state">No players yet.</div>'; return; }
  el.innerHTML = sorted.map(([id, p]) => `
    <div class="data-row">
      <div class="data-row-info">
        <div class="data-row-name">${p.fname} ${p.lname}</div>
        <div class="data-row-sub">${p.group} &bull; ${p.pos} &bull; DOB: ${p.dob || 'N/A'}</div>
      </div>
      <button class="btn-danger" onclick="removePlayer('${id}','${p.fname} ${p.lname}')">Remove</button>
    </div>
  `).join('');
}

window.removePlayer = async function(id, name) {
  if (!confirm(`Remove ${name} and all their data?`)) return;
  await remove(ref(db, `players/${id}`));
};

window.saveImportConfig = function() {
  const sid = document.getElementById('import-sheet-id').value.trim();
  const key = document.getElementById('import-api-key').value.trim();
  localStorage.setItem('brtfc_sheet_id', sid);
  localStorage.setItem('brtfc_api_key', key);
  setStatus('import-status', 'Config saved.', true);
};

window.importFromSheets = async function() {
  const sheetId = document.getElementById('import-sheet-id').value.trim() || localStorage.getItem('brtfc_sheet_id');
  const apiKey  = document.getElementById('import-api-key').value.trim()  || localStorage.getItem('brtfc_api_key');
  if (!sheetId || !apiKey) { setStatus('import-status', 'Enter Sheet ID and API key.', false); return; }

  setStatus('import-status', 'Importing...', true);
  const url = `https://sheets.googleapis.com/v4/spreadsheets/${sheetId}/values/Sheet1!A2:G500?key=${apiKey}`;

  try {
    const res  = await fetch(url);
    const data = await res.json();
    if (data.error) { setStatus('import-status', `Error: ${data.error.message}`, false); return; }

    const rows = data.values || [];
    let added = 0, skipped = 0;

    for (const row of rows) {
      const fname  = (row[0] || '').trim();
      const lname  = (row[1] || '').trim();
      const dob    = (row[2] || '').trim();
      const group  = (row[3] || '').trim();
      const pos    = (row[4] || '').trim();
      const email  = (row[5] || '').trim();
      const pemail = (row[6] || '').trim();
      if (!fname || !lname) { skipped++; continue; }
      const exists = Object.values(allPlayers).find(p =>
        p.fname.toLowerCase() === fname.toLowerCase() && p.lname.toLowerCase() === lname.toLowerCase()
      );
      if (exists) { skipped++; continue; }
      const validGroups = ['U14','U15','U16','U18'];
      await push(ref(db, 'players'), {
        fname, lname, dob,
        group:  validGroups.includes(group) ? group : 'U16',
        pos:    POSITIONS.includes(pos) ? pos : 'CM',
        email, pemail
      });
      added++;
    }
    setStatus('import-status', `${added} player${added !== 1 ? 's' : ''} imported, ${skipped} skipped.`, true);
  } catch(err) {
    setStatus('import-status', `Error: ${err.message}`, false);
  }
};

function renderHalfTermFields() {
  const el = document.getElementById('halfterm-fields');
  if (!el) return;
  const entries = Object.entries(halfTerms).sort((a,b) => a[1].start.localeCompare(b[1].start));
  if (!entries.length) {
    el.innerHTML = '<div style="font-size:13px;color:var(--text3);margin-bottom:10px;">No half-term windows defined yet. Click Add window.</div>';
    return;
  }
  el.innerHTML = entries.map(([key, ht]) => `
    <div class="term-row" style="align-items:flex-end;">
      <div class="form-group" style="min-width:160px;">
        <label style="font-size:11px;">Label</label>
        <input type="text" id="ht_${key}_label" value="${ht.label || ''}" placeholder="e.g. Half Term 1">
      </div>
      <div class="form-group">
        <label style="font-size:11px;">Start</label>
        <input type="date" id="ht_${key}_start" value="${ht.start || ''}">
      </div>
      <div class="form-group">
        <label style="font-size:11px;">End</label>
        <input type="date" id="ht_${key}_end" value="${ht.end || ''}">
      </div>
      <button class="btn-danger" onclick="deleteHalfTerm('${key}')" style="margin-bottom:2px;">✕</button>
    </div>
  `).join('');
}

window.addHalfTermRow = async function() {
  const key = 'ht_' + Date.now();
  await set(ref(db, `halfTerms/${key}`), { label: '', start: '', end: '' });
};

window.saveHalfTerms = async function() {
  const entries = Object.keys(halfTerms);
  for (const key of entries) {
    const label = document.getElementById(`ht_${key}_label`)?.value.trim() || '';
    const start = document.getElementById(`ht_${key}_start`)?.value || '';
    const end   = document.getElementById(`ht_${key}_end`)?.value   || '';
    await set(ref(db, `halfTerms/${key}`), { label, start, end });
  }
  setStatus('halfterms-status', 'Half-term windows saved.', true);
};

window.deleteHalfTerm = async function(key) {
  if (!confirm('Delete this half-term window?')) return;
  await remove(ref(db, `halfTerms/${key}`));
};

function renderTermFields() {
  const el = document.getElementById('term-fields');
  if (!el) return;
  el.innerHTML = [1,2,3].map(n => {
    const t = termDates[n] || {};
    const labels = { 1: 'Term 1 (Aug-Oct)', 2: 'Term 2 (Nov-Jan)', 3: 'Term 3 (Feb-Apr)' };
    return `<div class="term-row">
      <label>${labels[n]}</label>
      <div class="form-group"><label style="font-size:11px;">Start</label><input type="date" id="term_${n}_start" value="${t.start || ''}"></div>
      <div class="form-group"><label style="font-size:11px;">End</label><input type="date" id="term_${n}_end" value="${t.end || ''}"></div>
    </div>`;
  }).join('');
}

window.saveTermDates = async function() {
  const data = {};
  [1,2,3].forEach(n => {
    data[n] = {
      start: document.getElementById(`term_${n}_start`)?.value || '',
      end:   document.getElementById(`term_${n}_end`)?.value   || ''
    };
  });
  await set(ref(db, 'termDates'), data);
  setStatus('terms-status', 'Term dates saved.', true);
};

// ── DNA TOGGLE ───────────────────────────────────────────────────
window.setDNA = function(groupId, val, btn) {
  const group = document.getElementById(groupId);
  if (!group) return;
  group.querySelectorAll('.dna-toggle').forEach(b => {
    b.classList.remove('active-yes','active-partly','active-no');
  });
  btn.classList.add(`active-${val}`);
  btn.dataset.val = val;
};

// ── STARS ─────────────────────────────────────────────────────────
function buildStars(id, val) {
  return [1,2,3,4,5].map(i =>
    `<span class="star${i <= val ? ' on' : ''}" onclick="setStar('${id}',${i})">★</span>`
  ).join('') + `<span class="star-count">${val}/5</span>`;
}

window.setStar = function(id, val) {
  const row = document.getElementById(id);
  if (!row) return;
  row.dataset.val = val;
  const stars = row.querySelectorAll('.star');
  stars.forEach((s, i) => s.classList.toggle('on', i < val));
  const cnt = row.querySelector('.star-count');
  if (cnt) cnt.textContent = val + '/5';
};

// ── HELPERS ───────────────────────────────────────────────────────
function initials(p) {
  return ((p.fname?.[0] || '') + (p.lname?.[0] || '')).toUpperCase();
}

function calcAge(dob) {
  const b = new Date(dob);
  const now = new Date();
  let age = now.getFullYear() - b.getFullYear();
  if (now.getMonth() < b.getMonth() || (now.getMonth() === b.getMonth() && now.getDate() < b.getDate())) age--;
  return age;
}

function calcAvg(vals) {
  const clean = (vals||[]).map(v => parseFloat(v)).filter(v => !isNaN(v) && v > 0);
  if (!clean.length) return null;
  return (clean.reduce((a, b) => a + b, 0) / clean.length).toFixed(1);
}

function getPlayerOverallAvg(pid) {
  const trainVals = Object.values(allTraining)
    .filter(t => t.entries?.[pid])
    .flatMap(t => [t.entries[pid].performance, t.entries[pid].attitude]);
  const matchVals = Object.values(allMatches)
    .filter(m => m.entries?.[pid])
    .flatMap(m => [m.entries[pid].performance, m.entries[pid].tactical, m.entries[pid].behaviours]);
  return calcAvg([...trainVals, ...matchVals]);
}

function getTermRange(termNo) {
  const t = termDates[termNo];
  if (t?.start && t?.end) return { start: t.start, end: t.end };
  const y = new Date().getFullYear();
  const defaults = {
    1: { start: `${y}-08-01`, end: `${y}-10-31` },
    2: { start: `${y}-11-01`, end: `${y+1}-01-31` },
    3: { start: `${y+1}-02-01`, end: `${y+1}-04-30` }
  };
  return defaults[termNo] || defaults[1];
}

function inTermRange(dateStr, range) {
  if (!dateStr) return false;
  return dateStr >= range.start && dateStr <= range.end;
}

function toast(msg) {
  const el = document.getElementById('toast');
  el.textContent = msg;
  el.classList.remove('hidden');
  setTimeout(() => el.classList.add('hidden'), 2500);
}

function setStatus(id, msg, ok) {
  const el = document.getElementById(id);
  if (!el) return;
  el.textContent = msg;
  el.className   = 'status-msg ' + (ok ? 'status-ok' : 'status-err');
}
