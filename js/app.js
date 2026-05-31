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

// Role helpers
function coachRole()        { return currentCoach?.role_type || 'phase_lead'; }
function isAdmin()          { return currentCoach?.admin === true; }
function isPhaseLead()      { return coachRole() === 'phase_lead' || isAdmin(); }
function isManager()        { return coachRole() === 'manager'; }
function coachAgeGroup()    { return currentCoach?.ageGroup || ''; }

function coachPhaseGroups() {
  if (isManager()) {
    const ag = coachAgeGroup();
    return ag ? [ag] : [];
  }
  const phase = currentCoach?.phase || 'both';
  return PHASE_GROUPS[phase] || PHASE_GROUPS['both'];
}

function canAccessNav(view) {
  if (isAdmin())     return true;
  if (isPhaseLead()) return ['players','training','match','monthly','idp','dashboard'].includes(view);
  if (isManager())   return ['players','match','idp'].includes(view);
  return false;
}

// ── BOOT ─────────────────────────────────────────────────────────
window.addEventListener('DOMContentLoaded', () => {
  setTodayDates();
  initTheme();
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

  // Show only permitted nav items based on role
  const navViews = ['players','training','match','monthly','idp','admin','dashboard'];
  navViews.forEach(v => {
    const btn = document.querySelector(`[data-view="${v}"]`);
    if (!btn) return;
    if (canAccessNav(v)) {
      btn.classList.remove('hidden');
    } else {
      btn.classList.add('hidden');
    }
  });

  document.getElementById('screen-login').classList.add('hidden');
  document.getElementById('screen-app').classList.remove('hidden');

  // Managers land on match tab, others on players
  if (isManager()) {
    switchView('match', document.querySelector('[data-view="match"]'));
  } else {
    renderPlayersView();
  }
};

// ── THEME ─────────────────────────────────────────────────────────
window.toggleTheme = function() {
  const isDark = document.documentElement.getAttribute('data-theme') === 'dark';
  const newTheme = isDark ? 'light' : 'dark';
  document.documentElement.setAttribute('data-theme', newTheme);
  localStorage.setItem('brtfc_theme', newTheme);
  document.getElementById('theme-btn').textContent = newTheme === 'dark' ? '☀️' : '🌙';
};

function initTheme() {
  const saved = localStorage.getItem('brtfc_theme') || 'light';
  document.documentElement.setAttribute('data-theme', saved);
  const btn = document.getElementById('theme-btn');
  if (btn) btn.textContent = saved === 'dark' ? '☀️' : '🌙';
}

window.doLogout = function() {
  currentCoach = null;
  document.getElementById('screen-app').classList.add('hidden');
  document.getElementById('screen-login').classList.remove('hidden');
  // Hide all nav buttons ready for next login
  document.querySelectorAll('.nav-btn').forEach(el => el.classList.add('hidden'));
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

  if (v === 'training')  initTrainingView();
  if (v === 'match')     initMatchView();
  if (v === 'monthly')   initMonthlyView();
  if (v === 'admin')     renderAdminPlayers();
  if (v === 'dashboard') renderDashboard();
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
    const sessions = Object.values(allTraining).filter(t => t.entries?.[id]).length;
    return `<div class="player-card" onclick="openPlayerModal('${id}')">
      <div class="player-avatar">${initials(p)}</div>
      <div class="player-card-info">
        <div class="player-card-name">${p.fname} ${p.lname}</div>
        <div class="player-card-meta">
          <span class="badge badge-group">${p.group}</span>
          <span class="badge badge-pos">${p.pos}</span>
          ${sessions ? `<span style="font-size:11px;color:var(--text3);">${sessions} sessions</span>` : ''}
        </div>
      </div>
      ${avg ? `<div class="player-score"><div class="score-num">${avg}</div><div class="score-lbl">/ 5</div></div>` : ''}
      <div class="chevron-right">›</div>
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
        <button class="btn-primary" onclick="closeModal('modal-player');openIDPForPlayer('${pid}');">
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

window.openIDPForPlayer = function(pid) {
  const p = allPlayers[pid];
  if (!p) return;
  // Switch to IDP view
  switchView('idp', document.querySelector('[data-view=idp]'));
  // Set group then populate player select then set player
  setTimeout(() => {
    const grpSel = document.getElementById('idp-group');
    grpSel.value = p.group;
    loadIDPPlayers();
    setTimeout(() => {
      document.getElementById('idp-player').value = pid;
      renderIDP();
    }, 50);
  }, 50);
};

// ── TRAINING VIEW ─────────────────────────────────────────────────
function initTrainingView() {
  resetAttendance();
  const grpSel = document.getElementById('tr-group');
  const groups = coachPhaseGroups();
  grpSel.innerHTML = '<option value="">Select group...</option>' +
    groups.map(g => `<option>${g}</option>`).join('');

  // Auto-detect block from current date
  const trDate = document.getElementById('tr-date')?.value;
  const detectedBlock = autoDetectBlock(trDate);
  if (detectedBlock) {
    const blockSel = document.getElementById('tr-block');
    if (blockSel) {
      blockSel.value = detectedBlock;
      showBlockInfo('tr-block', 'tr-block-info');
    }
  }
  // Wire date change to re-detect block
  const trDateEl = document.getElementById('tr-date');
  if (trDateEl) trDateEl.onchange = window.onTrainingDateChange;
  loadTrainingPlayers();
}

const BLOCK_INFO = {
  '1': { title: 'Block 1: Build and Progress', focus: 'Controlled possession, play through the thirds, forward-first mindset.', behaviours: 'Scanning, communication, support angles.' },
  '2': { title: 'Block 2: Create and Exploit Space', focus: 'High ball speed, switch play when compact, create overloads.', behaviours: 'Support movement, communication, engagement.' },
  '3': { title: 'Block 3: Final Third Effectiveness', focus: 'Every entry ends with a cross or shot, fast decisions under pressure.', behaviours: 'Scanning, reaction, engagement.' },
  '4': { title: 'Block 4: Press and Regain', focus: 'High pressing, win the ball high up the pitch.', behaviours: 'Reaction, communication, work rate.' },
  '5': { title: 'Block 5: Defend and Transition', focus: 'Compact shape, win first contact, dominate second balls.', behaviours: 'Reaction, engagement, support.' },
  '6': { title: 'Block 6: Game Control and Compete', focus: 'Reset when needed, control tempo, manage risk.', behaviours: 'Communication, engagement, accountability.' }
};

function autoDetectBlock(dateStr) {
  const check = dateStr ? new Date(dateStr) : new Date();
  check.setHours(0,0,0,0);

  let termStart = null;
  for (let n = 1; n <= 3; n++) {
    const t = termDates[n];
    if (!t?.start || !t?.end) continue;
    const s = new Date(t.start);
    const e = new Date(t.end);
    if (check >= s && check <= e) { termStart = s; break; }
  }
  if (!termStart) return null;

  const daysIn   = Math.floor((check - termStart) / (1000 * 60 * 60 * 24));
  const weekNum  = Math.floor(daysIn / 7);
  const blockNum = (Math.floor(weekNum / 3) % 6) + 1;
  return String(blockNum);
}

// Called when training date changes
window.onTrainingDateChange = function() {
  const date = document.getElementById('tr-date')?.value;
  const block = autoDetectBlock(date);
  if (block) {
    const blockSel = document.getElementById('tr-block');
    if (blockSel) { blockSel.value = block; showBlockInfo('tr-block', 'tr-block-info'); }
  }
};

// Called when match date changes
window.onMatchDateChange = function() {
  const date = document.getElementById('mr-date')?.value;
  const block = autoDetectBlock(date);
  if (block) {
    const blockSel = document.getElementById('mr-block');
    if (blockSel) { blockSel.value = block; showBlockInfo('mr-block', 'mr-block-info'); }
  }
};

window.showBlockInfo = function(selectId, infoId) {
  const sId = selectId || 'tr-block';
  const iId = infoId   || 'tr-block-info';
  const val = document.getElementById(sId)?.value;
  const el  = document.getElementById(iId);
  if (!el) return;
  if (!val || !BLOCK_INFO[val]) { el.style.display = 'none'; return; }
  const b = BLOCK_INFO[val];
  el.innerHTML = `<div style="font-weight:700;margin-bottom:4px;">${b.title}</div><div>Focus: ${b.focus}</div><div>Key behaviours: ${b.behaviours}</div>`;
  el.style.display = 'block';
};

window.loadTrainingPlayers = function() {
  const group = document.getElementById('tr-group').value;
  const container = document.getElementById('tr-players-container');
  if (!group) { container.innerHTML = '<div class="empty-state">Select an age group to load players.</div>'; return; }

  const players = Object.entries(allPlayers).filter(([id, p]) => p.group === group)
    .sort((a, b) => a[1].lname.localeCompare(b[1].lname));

  if (!players.length) { container.innerHTML = '<div class="empty-state">No players in this group.</div>'; return; }

  container.innerHTML = players.map(([id, p]) => `
    <div class="report-player-row" id="row_${id}">
      <div class="report-player-header">
        <div class="player-avatar" style="width:34px;height:34px;font-size:12px;">${initials(p)}</div>
        <div class="report-player-name">${p.fname} ${p.lname}</div>
        <span class="badge badge-pos">${p.pos}</span>
        <div class="attendance-btns">
          <button class="att-btn" id="att_injured_${id}" onclick="setAttendance('${id}','injured','tr')" title="Injured">🤕</button>
          <button class="att-btn" id="att_absent_${id}"  onclick="setAttendance('${id}','absent','tr')"  title="Absent">❌</button>
        </div>
      </div>
      <div class="rating-group" id="ratings_${id}">
        <div class="rating-item">
          <div class="rating-label">Attitude</div>
          <div class="rating-hint">Effort levels and intensity throughout the session</div>
          <div class="stars" id="tr_att_${id}" data-val="3">${buildStars(`tr_att_${id}`, 3)}</div>
        </div>
        <div class="rating-item">
          <div class="rating-label">Communication</div>
          <div class="rating-hint">Did they give feedback and communicate with teammates?</div>
          <div class="stars" id="tr_comm_${id}" data-val="3">${buildStars(`tr_comm_${id}`, 3)}</div>
        </div>
        <div class="rating-item">
          <div class="rating-label">Performance</div>
          <div class="rating-hint">Overall performance and contribution to the session</div>
          <div class="stars" id="tr_perf_${id}" data-val="3">${buildStars(`tr_perf_${id}`, 3)}</div>
        </div>
      </div>
    </div>
  `).join('');
};

window.saveTrainingReport = async function() {
  const date  = document.getElementById('tr-date').value;
  const group = document.getElementById('tr-group').value;
  if (!date || !group) { toast('Select a date and age group.'); return; }

  const players = Object.entries(allPlayers).filter(([id, p]) => p.group === group);
  if (!players.length) { toast('No players loaded.'); return; }

  const entries = {};
  players.forEach(([id]) => {
    const perfEl = document.getElementById(`tr_perf_${id}`);
    const attEl  = document.getElementById(`tr_att_${id}`);
    const commEl = document.getElementById(`tr_comm_${id}`);
    if (perfEl && attEl) {
      entries[id] = {
        performance:   parseInt(perfEl.dataset.val || 3),
        attitude:      parseInt(attEl.dataset.val  || 3),
        communication: parseInt(commEl?.dataset.val || 3)
      };
    }
  });

  const block = document.getElementById('tr-block')?.value || '';
  const key = `${date}_${group}`;
  await set(ref(db, `training/${key}`), {
    date, group, block,
    coach: currentCoach.name,
    coachId: currentCoach.id,
    entries
  });
  toast('Training session saved.');
};

// ── MATCH VIEW ────────────────────────────────────────────────────
window.onMatchGroupChange = function() {
  const group = document.getElementById('mr-group').value;
  const compRow = document.getElementById('mr-competition-row');
  if (compRow) compRow.style.display = group === 'U18' ? 'flex' : 'none';
  loadMatchPlayers();
};

function initMatchView() {
  resetAttendance();
  const grpSel = document.getElementById('mr-group');
  const groups = coachPhaseGroups();
  grpSel.innerHTML = '<option value="">Select group...</option>' +
    groups.map(g => `<option>${g}</option>`).join('');
  // Hide competition row initially
  const compRow = document.getElementById('mr-competition-row');
  if (compRow) compRow.style.display = 'none';

  // Reset DNA stars to 3
  ['dna_forward','dna_ballspeed','dna_finalthird','dna_press','dna_recovery'].forEach(id => {
    const el = document.getElementById(id);
    if (el) { el.dataset.val = 3; el.querySelectorAll('.star').forEach((s,i) => s.classList.toggle('on', i < 3)); const cnt = el.querySelector('.star-count'); if(cnt) cnt.textContent = '3/5'; }
  });

  // Auto-detect block from match date
  const mrDate = document.getElementById('mr-date')?.value;
  const detectedBlock = autoDetectBlock(mrDate);
  if (detectedBlock) {
    const blockSel = document.getElementById('mr-block');
    if (blockSel) {
      blockSel.value = detectedBlock;
      showBlockInfo('mr-block', 'mr-block-info');
    }
  }
  // Wire date change
  const mrDateEl = document.getElementById('mr-date');
  if (mrDateEl) mrDateEl.onchange = window.onMatchDateChange;
}

window.loadMatchPlayers = function() {
  const group = document.getElementById('mr-group').value;
  const container = document.getElementById('mr-players-container');
  if (!group) { container.innerHTML = '<div class="empty-state">Select an age group to load players.</div>'; return; }

  const players = Object.entries(allPlayers).filter(([id, p]) => p.group === group)
    .sort((a, b) => a[1].lname.localeCompare(b[1].lname));

  if (!players.length) { container.innerHTML = '<div class="empty-state">No players in this group.</div>'; return; }

  container.innerHTML = players.map(([id, p]) => `
    <div class="report-player-row" id="mr_row_${id}">
      <div class="report-player-header">
        <div class="player-avatar" style="width:34px;height:34px;font-size:12px;">${initials(p)}</div>
        <div class="report-player-name">${p.fname} ${p.lname}</div>
        <select class="match-pos-select" id="mr_pos_${id}">
          ${POSITIONS.map(pos => `<option ${pos === p.pos ? 'selected' : ''}>${pos}</option>`).join('')}
        </select>
        <div class="attendance-btns">
          <button class="att-btn" id="mr_att_injured_${id}" onclick="setAttendance('${id}','injured','mr')" title="Injured">🤕</button>
          <button class="att-btn" id="mr_att_absent_${id}"  onclick="setAttendance('${id}','absent','mr')"  title="Absent">❌</button>
        </div>
      </div>
      <div class="rating-group" id="mr_ratings_${id}">
        <div class="rating-item">
          <div class="rating-label">Mindset</div>
          <div class="rating-hint">Aggressive without the ball, calm on the ball, selfless movement</div>
          <div class="stars" id="mr_mindset_${id}" data-val="3">${buildStars(`mr_mindset_${id}`, 3)}</div>
        </div>
        <div class="rating-item">
          <div class="rating-label">Physical</div>
          <div class="rating-hint">Repeated sprints, aggressive ball recovery, winning first contacts</div>
          <div class="stars" id="mr_physical_${id}" data-val="3">${buildStars(`mr_physical_${id}`, 3)}</div>
        </div>
        <div class="rating-item">
          <div class="rating-label">Impact</div>
          <div class="rating-hint">How effective were they in their position in supporting team performance?</div>
          <div class="stars" id="mr_impact_${id}" data-val="3">${buildStars(`mr_impact_${id}`, 3)}</div>
        </div>
      </div>
    </div>
  `).join('');
};

window.saveMatchReport = async function() {
  const date        = document.getElementById('mr-date').value;
  const group       = document.getElementById('mr-group').value;
  const opposition  = document.getElementById('mr-opposition').value.trim();
  const venue       = document.getElementById('mr-venue').value;
  const competition = group === 'U18' ? (document.getElementById('mr-competition')?.value || '') : '';
  if (!date || !group) { toast('Select a date and age group.'); return; }

  const players = Object.entries(allPlayers).filter(([id, p]) => p.group === group);
  const entries = {};
  players.forEach(([id]) => {
    const attendance = getAttendanceForPlayer(id);
    if (attendance !== 'present') {
      entries[id] = { attendance, position: 'N/A' };
      return;
    }
    const mindsetEl  = document.getElementById(`mr_mindset_${id}`);
    const physicalEl = document.getElementById(`mr_physical_${id}`);
    const impactEl   = document.getElementById(`mr_impact_${id}`);
    const posEl      = document.getElementById(`mr_pos_${id}`);
    if (mindsetEl) {
      entries[id] = {
        attendance: 'present',
        mindset:    parseInt(mindsetEl.dataset.val   || 3),
        physical:   parseInt(physicalEl?.dataset.val || 3),
        impact:     parseInt(impactEl?.dataset.val   || 3),
        position:   posEl?.value || 'N/A'
      };
    }
  });

  const dnaStarVal = id => parseInt(document.getElementById(id)?.dataset.val || 3);
  const dna = {
    forward:    dnaStarVal('dna_forward'),
    ballspeed:  dnaStarVal('dna_ballspeed'),
    finalthird: dnaStarVal('dna_finalthird'),
    press:      dnaStarVal('dna_press'),
    recovery:   dnaStarVal('dna_recovery')
  };

  const block       = document.getElementById('mr-block')?.value       || '';
  const blockReview = document.getElementById('mr-block-review')?.value.trim() || '';

  const key = `${date}_${group}`;
  await set(ref(db, `matches/${key}`), {
    date, group, opposition, venue, competition, block, blockReview,
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
  const trainCommAvg2 = calcAvg(trainSessions.map(t => t.entries[pid].communication));
  const trainCommAvg = calcAvg(trainSessions.map(t => t.entries[pid].communication));
  const matchMindsetAvg  = calcAvg(matchSessions.map(m => m.entries[pid].mindset));
  const matchPhysicalAvg = calcAvg(matchSessions.map(m => m.entries[pid].physical));
  const matchImpactAvg   = calcAvg(matchSessions.map(m => m.entries[pid].impact));
  const matchPerfAvg     = matchImpactAvg; // keep for overall calc

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
    trainPerfAvg, trainAttAvg, matchMindsetAvg, matchPhysicalAvg, matchImpactAvg,
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
            <div class="idp-metric"><div class="idp-metric-val">${attendStats ? attendStats.pct + '%' : 'N/A'}</div><div class="idp-metric-lbl">Attendance</div></div>
            <div class="idp-metric"><div class="idp-metric-val">${trainPerfAvg || 'N/A'}</div><div class="idp-metric-lbl">Training avg</div></div>
            <div class="idp-metric"><div class="idp-metric-val">${matchMindsetAvg || 'N/A'}</div><div class="idp-metric-lbl">Match avg</div></div>
          </div>
          ${attendStats && attendStats.pct < 85 ? `
          <div style="background:var(--red-light);border-left:4px solid var(--red);border-radius:var(--r-sm);padding:10px 14px;margin-top:10px;font-size:13px;color:var(--red);">
            <strong>Attendance flag:</strong> ${attendStats.pct}% attendance this term is below the 85% threshold.
            ${attendStats.injured ? `${attendStats.injured} session${attendStats.injured!==1?'s':''} missed through injury.` : ''}
            ${attendStats.absent  ? `${attendStats.absent} session${attendStats.absent!==1?'s':''} absent without reason.` : ''}
          </div>` : ''}
        </div>

        ${attendStats && attendStats.total > 0 ? `
        <div class="idp-section">
          <div class="idp-section-title">Attendance</div>
          <div class="idp-metric-grid">
            <div class="idp-metric"><div class="idp-metric-val" style="color:${attendStats.pct < 85 ? 'var(--red)' : 'var(--green-dark)'}">${attendStats.pct}%</div><div class="idp-metric-lbl">Attendance rate</div></div>
            <div class="idp-metric"><div class="idp-metric-val">${attendStats.present}</div><div class="idp-metric-lbl">Present</div></div>
            <div class="idp-metric"><div class="idp-metric-val">${attendStats.injured}</div><div class="idp-metric-lbl">Injured</div></div>
            <div class="idp-metric"><div class="idp-metric-val">${attendStats.absent}</div><div class="idp-metric-lbl">Absent</div></div>
          </div>
          <div class="idp-bar-row">
            <div class="idp-bar-labels"><span>Attendance</span><span>${attendStats.pct}%</span></div>
            <div class="idp-bar-track"><div class="idp-bar-fill" style="width:${attendStats.pct}%;background:${attendStats.pct < 85 ? 'linear-gradient(90deg,#e07000,#f09030)' : 'linear-gradient(90deg,#1a5c28,#2A8C3F)'};"></div></div>
          </div>
        </div>` : ''}

        ${trainSessions.length ? `
        <div class="idp-section">
          <div class="idp-section-title">Training performance</div>
          ${idpBar('Attitude', trainAttAvg)}
          ${idpBar('Communication', trainCommAvg2)}
          ${idpBar('Performance', trainPerfAvg)}
          ${idpBar('Communication', trainCommAvg)}
        </div>` : ''}

        ${matchSessions.length ? `
        <div class="idp-section">
          <div class="idp-section-title">Match performance</div>
          ${idpBar('Mindset', matchMindsetAvg)}
          ${idpBar('Physical', matchPhysicalAvg)}
          ${idpBar('Impact', matchImpactAvg)}
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

function idpBarColour(v) {
  const n = parseFloat(v);
  if (n > 3.5)  return 'linear-gradient(90deg,#8a6a00,#B8922A)';
  if (n >= 2.5) return 'linear-gradient(90deg,#1a5c28,#2A8C3F)';
  return 'linear-gradient(90deg,#e07000,#f09030)';
}

function idpBar(label, val) {
  if (!val) return '';
  const pct = Math.round((parseFloat(val) / 5) * 100);
  return `<div class="idp-bar-row">
    <div class="idp-bar-labels"><span>${label}</span><span>${val}/5</span></div>
    <div class="idp-bar-track"><div class="idp-bar-fill" style="width:${pct}%;background:${idpBarColour(val)};"></div></div>
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
  const trainCommAvg2 = calcAvg(trainSessions.map(t => t.entries[pid].communication));
  const trainCommAvg = calcAvg(trainSessions.map(t => t.entries[pid].communication));
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
  if (tab === 'bulkidp')    { document.getElementById('bulk-idp-list').innerHTML = ''; setStatus('bulk-status','',''); }
  if (tab === 'data')       { document.getElementById('dm-entries-list').innerHTML = ''; document.getElementById('dm-type').value = ''; document.getElementById('dm-status').textContent = ''; }
};

window.addCoach = async function() {
  const name      = document.getElementById('ac-name').value.trim();
  const pin       = document.getElementById('ac-pin').value.trim();
  const role      = document.getElementById('ac-role').value.trim();
  const role_type = document.getElementById('ac-role-type').value;
  const phase     = document.getElementById('ac-phase').value;
  const ageGroup  = document.getElementById('ac-agegroup').value;
  const admin     = document.getElementById('ac-admin').value === 'true';
  if (!name || !pin) { setStatus('coach-status', 'Name and PIN are required.', false); return; }
  if (pin.length < 4) { setStatus('coach-status', 'PIN must be at least 4 digits.', false); return; }
  const exists = Object.values(allCoaches).find(c => String(c.pin) === String(pin));
  if (exists) { setStatus('coach-status', 'That PIN is already in use.', false); return; }
  await push(ref(db, 'coaches'), { name, pin, role, role_type, phase, ageGroup, admin });
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
        <div class="data-row-sub">
          ${c.role_type === 'manager' ? '<span class="role-badge role-manager">Manager</span>' : c.admin ? '<span class="role-badge role-admin">Admin</span>' : '<span class="role-badge role-lead">Phase Lead</span>'}
          ${c.role || ''}
          ${c.role_type === 'manager' && c.ageGroup ? '&bull; ' + c.ageGroup : c.phase ? '&bull; Phase ' + (c.phase === '1' ? '1 (U14/U15)' : c.phase === '2' ? '2 (U16/U18)' : 'All') : ''}
        </div>
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

// ── ATTENDANCE ───────────────────────────────────────────────────
const attendanceState = {}; // pid -> 'present'|'injured'|'absent'

window.setAttendance = function(pid, status, prefix) {
  const current = attendanceState[pid] || 'present';
  // Toggle off if already set
  const newStatus = current === status ? 'present' : status;
  attendanceState[pid] = newStatus;

  const rowId    = prefix === 'tr' ? `row_${pid}`        : `mr_row_${pid}`;
  const injBtnId = prefix === 'tr' ? `att_injured_${pid}` : `mr_att_injured_${pid}`;
  const absBtnId = prefix === 'tr' ? `att_absent_${pid}`  : `mr_att_absent_${pid}`;
  const ratingsId = prefix === 'tr' ? `ratings_${pid}`    : `mr_ratings_${pid}`;

  const row     = document.getElementById(rowId);
  const injBtn  = document.getElementById(injBtnId);
  const absBtn  = document.getElementById(absBtnId);
  const ratings = document.getElementById(ratingsId);

  // Reset button states
  if (injBtn) injBtn.classList.remove('att-active-injured');
  if (absBtn) absBtn.classList.remove('att-active-absent');
  if (row)    row.classList.remove('att-row-injured','att-row-absent');
  if (ratings) ratings.style.opacity = '1';
  if (ratings) ratings.style.pointerEvents = 'auto';

  if (newStatus === 'injured') {
    if (injBtn) injBtn.classList.add('att-active-injured');
    if (row)    row.classList.add('att-row-injured');
    if (ratings) { ratings.style.opacity = '0.3'; ratings.style.pointerEvents = 'none'; }
  } else if (newStatus === 'absent') {
    if (absBtn) absBtn.classList.add('att-active-absent');
    if (row)    row.classList.add('att-row-absent');
    if (ratings) { ratings.style.opacity = '0.3'; ratings.style.pointerEvents = 'none'; }
  }
};

function resetAttendance() {
  Object.keys(attendanceState).forEach(k => delete attendanceState[k]);
}

function getAttendanceForPlayer(pid) {
  return attendanceState[pid] || 'present';
}

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

function getPlayerAttendanceStats(pid) {
  const allSessions = [
    ...Object.values(allTraining),
    ...Object.values(allMatches)
  ].filter(s => s.entries?.[pid]);

  const total    = allSessions.length;
  if (!total) return null;

  const present  = allSessions.filter(s => !s.entries[pid].attendance || s.entries[pid].attendance === 'present').length;
  const injured  = allSessions.filter(s => s.entries[pid].attendance === 'injured').length;
  const absent   = allSessions.filter(s => s.entries[pid].attendance === 'absent').length;
  const pct      = Math.round((present / total) * 100);

  return { total, present, injured, absent, pct };
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

// ── BULK IDP ──────────────────────────────────────────────────────
window.generateBulkIDPs = function() {
  const group  = document.getElementById('bulk-group').value;
  const termNo = document.getElementById('bulk-term').value;
  if (!group) { setStatus('bulk-status', 'Select an age group.', false); return; }

  const groupPlayers = Object.entries(allPlayers)
    .filter(([id, p]) => p.group === group)
    .sort((a, b) => a[1].lname.localeCompare(b[1].lname));

  if (!groupPlayers.length) { setStatus('bulk-status', 'No players in this group.', false); return; }

  const termLabels = { '1': 'Term 1 (Aug-Oct)', '2': 'Term 2 (Nov-Jan)', '3': 'Term 3 (Feb-Apr)' };
  const termLabel  = termLabels[termNo];
  const termRange  = getTermRange(parseInt(termNo));
  const year       = new Date().getFullYear();

  const list = document.getElementById('bulk-idp-list');

  list.innerHTML = groupPlayers.map(([pid, p]) => {
    const trainSessions  = Object.values(allTraining).filter(t => t.entries?.[pid] && inTermRange(t.date, termRange));
    const matchSessions  = Object.values(allMatches).filter(m => m.entries?.[pid] && inTermRange(m.date, termRange));
    const trainPerfAvg   = calcAvg(trainSessions.map(t => t.entries[pid].performance));
    const trainAttAvg    = calcAvg(trainSessions.map(t => t.entries[pid].attitude));
    const matchPerfAvg   = calcAvg(matchSessions.map(m => m.entries[pid].performance));
    const playerGoals    = Object.entries(allGoals).filter(([id, g]) => g.pid === pid);
    const overallVals    = [trainPerfAvg, trainAttAvg, matchPerfAvg]
      .map(v => parseFloat(v)).filter(v => !isNaN(v) && v > 0);
    const overall        = overallVals.length
      ? (overallVals.reduce((a, b) => a + b, 0) / overallVals.length).toFixed(1) : null;
    const age            = p.dob ? calcAge(p.dob) : 'N/A';

    return `<div class="bulk-idp-card" id="bulk_${pid}">
      <div class="bulk-idp-header">
        <div class="player-avatar" style="width:38px;height:38px;font-size:13px;">${initials(p)}</div>
        <div style="flex:1;">
          <div style="font-size:15px;font-weight:600;">${p.fname} ${p.lname}</div>
          <div style="font-size:12px;color:var(--text2);">${p.group} &bull; ${p.pos} &bull; Age ${age}</div>
        </div>
        <div style="text-align:right;">
          <div style="font-size:20px;font-weight:800;color:var(--green-dark);">${overall || 'N/A'}<span style="font-size:13px;color:var(--text3);">/5</span></div>
          <div style="font-size:11px;color:var(--text3);">${trainSessions.length} sessions &bull; ${matchSessions.length} matches</div>
        </div>
      </div>
      <div class="bulk-idp-stats">
        ${trainPerfAvg ? `<div class="bulk-stat"><div class="bulk-stat-lbl">Training performance</div><div class="bulk-bar-track"><div class="bulk-bar-fill" style="width:${Math.round((parseFloat(trainPerfAvg)/5)*100)}%"></div></div><div class="bulk-stat-val">${trainPerfAvg}/5</div></div>` : ''}
        ${trainAttAvg  ? `<div class="bulk-stat"><div class="bulk-stat-lbl">Training attitude</div><div class="bulk-bar-track"><div class="bulk-bar-fill" style="width:${Math.round((parseFloat(trainAttAvg)/5)*100)}%"></div></div><div class="bulk-stat-val">${trainAttAvg}/5</div></div>` : ''}
        ${matchPerfAvg ? `<div class="bulk-stat"><div class="bulk-stat-lbl">Match performance</div><div class="bulk-bar-track"><div class="bulk-bar-fill" style="width:${Math.round((parseFloat(matchPerfAvg)/5)*100)}%"></div></div><div class="bulk-stat-val">${matchPerfAvg}/5</div></div>` : ''}
      </div>
      ${playerGoals.length ? `<div class="bulk-goals"><strong>Goals:</strong> ${playerGoals.slice(0,2).map(([id,g]) => `<span class="bulk-goal-chip ${g.achieved ? 'achieved' : ''}">${g.text}</span>`).join('')}</div>` : ''}
      <div class="bulk-idp-actions">
        <button class="btn-secondary" style="font-size:13px;padding:7px 14px;" onclick="printSingleBulkIDP('${pid}')">Print IDP</button>
        <button class="btn-secondary" style="font-size:13px;padding:7px 14px;" onclick="emailBulkIDP('${pid}','${termNo}','${termLabel}')">Generate email</button>
        <button class="btn-primary"   style="font-size:13px;padding:7px 14px;" onclick="openIDPForPlayer('${pid}')">View full IDP</button>
      </div>
    </div>`;
  }).join('');

  setStatus('bulk-status', `${groupPlayers.length} IDPs generated for ${group} &bull; ${termLabel}.`, true);
};

window.printBulkIDPs = function() {
  const group = document.getElementById('bulk-group').value;
  if (!document.getElementById('bulk-idp-list').innerHTML.trim()) {
    setStatus('bulk-status', 'Generate IDPs first.', false);
    return;
  }
  setStatus('bulk-status', 'Opening print dialog...', true);
  setTimeout(() => window.print(), 300);
};

window.printSingleBulkIDP = function(pid) {
  openIDPForPlayer(pid);
  setTimeout(() => window.print(), 800);
};

window.emailBulkIDP = function(pid, termNo, termLabel) {
  const p = allPlayers[pid];
  if (!p) return;
  const termRange    = getTermRange(parseInt(termNo));
  const trainSessions = Object.values(allTraining).filter(t => t.entries?.[pid] && inTermRange(t.date, termRange));
  const matchSessions = Object.values(allMatches).filter(m => m.entries?.[pid] && inTermRange(m.date, termRange));
  const trainPerfAvg  = calcAvg(trainSessions.map(t => t.entries[pid].performance));
  const trainAttAvg   = calcAvg(trainSessions.map(t => t.entries[pid].attitude));
  const matchPerfAvg  = calcAvg(matchSessions.map(m => m.entries[pid].performance));
  const playerGoals   = Object.values(allGoals).filter(g => g.pid === pid).slice(0, 2);

  const prompt = `Write a professional Individual Development Plan email for ${p.fname} ${p.lname}, a ${p.pos} in the ${p.group} at Bognor Regis Town FC Academy.

Term: ${termLabel}
Training sessions: ${trainSessions.length}
Matches: ${matchSessions.length}
Training performance avg: ${trainPerfAvg || 'N/A'}/5
Training attitude avg: ${trainAttAvg || 'N/A'}/5
Match performance avg: ${matchPerfAvg || 'N/A'}/5

Term goals:
${playerGoals.map(g => `- ${g.text} (${g.achieved ? 'Achieved' : 'In progress'})`).join('\n') || 'No goals set.'}

Address it to ${p.fname} and their parents. Include a subject line. Be specific, constructive, and encouraging. Reference the club values: aggressive without the ball, calm on the ball, accountable to each other. Sign off from the BRTFC Academy coaching team.`;

  if (window.sendPrompt) window.sendPrompt(prompt);
};

// ── DASHBOARD ─────────────────────────────────────────────────────
window.renderDashboard = function() {
  const termNo   = parseInt(document.getElementById('dash-term')?.value || 1);
  const grpFilter = document.getElementById('dash-filter-group')?.value || 'all';
  const termRange = getTermRange(termNo);
  const GROUPS    = ['U14','U15','U16','U18'];

  // Filter data to this term
  const termTraining = Object.values(allTraining).filter(t => inTermRange(t.date, termRange));
  const termMatches  = Object.values(allMatches).filter(m => inTermRange(m.date, termRange));

  // ── SUMMARY METRICS ───────────────────────────────────────────
  const totalPlayers  = Object.keys(allPlayers).length;
  const totalSessions = termTraining.length;
  const totalMatches  = termMatches.length;
  const totalEntries  = termTraining.reduce((sum, t) => sum + Object.keys(t.entries || {}).length, 0)
                      + termMatches.reduce((sum,  m) => sum + Object.keys(m.entries  || {}).length, 0);

  document.getElementById('dash-metrics').innerHTML = `
    <div class="dash-metric"><div class="dash-metric-val">${totalPlayers}</div><div class="dash-metric-lbl">Players</div></div>
    <div class="dash-metric"><div class="dash-metric-val">${totalSessions}</div><div class="dash-metric-lbl">Training sessions</div></div>
    <div class="dash-metric"><div class="dash-metric-val">${totalMatches}</div><div class="dash-metric-lbl">Matches</div></div>
    <div class="dash-metric"><div class="dash-metric-val">${totalEntries}</div><div class="dash-metric-lbl">Data entries</div></div>
    <div class="dash-metric"><div class="dash-metric-val">${Object.keys(allCoaches).length}</div><div class="dash-metric-lbl">Coaches</div></div>
  `;

  // ── DNA COMPLIANCE ────────────────────────────────────────────
  const dnaKeys = [
    { key: 'forward',    label: 'Forward first' },
    { key: 'ballspeed',  label: 'High ball speed' },
    { key: 'finalthird', label: 'Final third' },
    { key: 'press',      label: 'Pressing' },
    { key: 'recovery',   label: 'Recovery' }
  ];

  const dnaEl = document.getElementById('dash-dna');
  if (termMatches.length === 0) {
    dnaEl.innerHTML = '<div style="font-size:13px;color:var(--text3);">No match data for this term yet.</div>';
  } else {
    dnaEl.innerHTML = dnaKeys.map(dk => {
      const vals = termMatches.map(m => parseFloat(m.dna?.[dk.key])).filter(v => !isNaN(v) && v > 0);
      const avg  = vals.length ? (vals.reduce((a,b)=>a+b,0)/vals.length) : 0;
      const pct  = Math.round((avg/5)*100);
      const colour = avg > 3.5 ? 'linear-gradient(90deg,#8a6a00,#B8922A)' : avg >= 2.5 ? 'linear-gradient(90deg,#1a5c28,#2A8C3F)' : 'linear-gradient(90deg,#e07000,#f09030)';
      return `<div class="dna-bar-row">
        <div class="dna-bar-label">${dk.label}</div>
        <div class="dna-bar-wrap">
          <div style="display:flex;align-items:center;gap:10px;margin-bottom:4px;">
            <div class="group-bar-track" style="flex:1;height:10px;">
              <div class="group-bar-fill" style="width:${pct}%;background:${colour};height:100%;border-radius:999px;"></div>
            </div>
            <span style="font-size:13px;font-weight:600;color:var(--text);width:36px;text-align:right;">${avg ? avg.toFixed(1) : 'N/A'}/5</span>
          </div>
          <div style="font-size:11px;color:var(--text3);">${vals.length} match${vals.length!==1?'es':''} rated</div>
        </div>
      </div>`;
    }).join('');
  }

  // ── RATINGS BY GROUP ──────────────────────────────────────────
  const ratingsEl = document.getElementById('dash-ratings');
  const ratingCategories = [
    { key: 'training', label: 'Training', metrics: [
      { label: 'Attitude',       fn: e => e.attitude },
      { label: 'Communication',  fn: e => e.communication },
      { label: 'Performance',    fn: e => e.performance }
    ]},
    { key: 'match', label: 'Match', metrics: [
      { label: 'Mindset',  fn: e => e.mindset },
      { label: 'Physical', fn: e => e.physical },
      { label: 'Impact',   fn: e => e.impact }
    ]}
  ];

  ratingsEl.innerHTML = ratingCategories.map(cat => {
    const sessions = cat.key === 'training' ? termTraining : termMatches;
    return `<div class="group-rating-row">
      <div class="group-rating-label"><span>${cat.label} ratings by age group</span></div>
      <div class="group-bar-set">
        ${GROUPS.map(grp => {
          const grpSessions = sessions.filter(s => s.group === grp);
          const grpPlayers  = Object.entries(allPlayers).filter(([id,p]) => p.group === grp);
          if (!grpSessions.length) return '';
          const vals = grpSessions.flatMap(s =>
            grpPlayers.flatMap(([pid]) =>
              cat.metrics.map(m => parseFloat(s.entries?.[pid] ? m.fn(s.entries[pid]) : 0)).filter(v => !isNaN(v) && v > 0)
            )
          );
          const avg = vals.length ? (vals.reduce((a,b)=>a+b,0)/vals.length) : 0;
          const pct = Math.round((avg/5)*100);
          const colour = avg > 3.5 ? 'linear-gradient(90deg,#8a6a00,#B8922A)' : avg >= 2.5 ? 'linear-gradient(90deg,#1a5c28,#2A8C3F)' : 'linear-gradient(90deg,#e07000,#f09030)';
          return `<div class="group-bar-item">
            <div class="group-bar-name">${grp}</div>
            <div class="group-bar-track"><div class="group-bar-fill" style="width:${pct}%;background:${colour};"></div></div>
            <div class="group-bar-val">${avg ? avg.toFixed(1) : 'N/A'}/5</div>
          </div>`;
        }).join('')}
      </div>
    </div>`;
  }).join('');

  // ── BLOCK COVERAGE ────────────────────────────────────────────
  const blockCounts = { '1':0,'2':0,'3':0,'4':0,'5':0,'6':0 };
  const blockLabels = { '1':'Build and Progress','2':'Create and Exploit','3':'Final Third','4':'Press and Regain','5':'Defend and Transition','6':'Game Control' };
  termTraining.forEach(t => { if (t.block && blockCounts[t.block] !== undefined) blockCounts[t.block]++; });
  document.getElementById('dash-blocks').innerHTML = `
    <div class="block-coverage-grid">
      ${Object.entries(blockCounts).map(([b,count]) => `
        <div class="block-coverage-item">
          <div class="block-coverage-num">${count}</div>
          <div class="block-coverage-lbl">Block ${b}<br>${blockLabels[b]}</div>
          <div class="block-coverage-sessions">${count} session${count!==1?'s':''}</div>
        </div>
      `).join('')}
    </div>
  `;

  // ── PLAYER FLAGS ──────────────────────────────────────────────
  const flagEl = document.getElementById('dash-flags');
  const flags  = [];
  Object.entries(allPlayers).forEach(([pid, p]) => {
    const pTraining = termTraining.filter(t => t.entries?.[pid]);
    const pMatches  = termMatches.filter(m => m.entries?.[pid]);
    if (!pTraining.length && !pMatches.length) return;

    const tAvg = val => calcAvg(pTraining.map(t => t.entries[pid][val]).filter(v => v));
    const mAvg = val => calcAvg(pMatches.map(m  => m.entries[pid][val]).filter(v => v));

    const allAvgs = [tAvg('attitude'), tAvg('communication'), tAvg('performance'),
                     mAvg('mindset'),  mAvg('physical'),       mAvg('impact')]
      .map(v => parseFloat(v)).filter(v => !isNaN(v));

    const lowCount   = allAvgs.filter(v => v < 2.5).length;
    const attStats   = getPlayerAttendanceStats(pid);
    const attFlag    = attStats && attStats.pct < 85;
    if (lowCount >= 2 || attFlag) {
      const overall = allAvgs.length ? (allAvgs.reduce((a,b)=>a+b,0)/allAvgs.length).toFixed(1) : 'N/A';
      flags.push({ pid, p, overall, lowCount, attStats, attFlag });
    }
  });

  if (!flags.length) {
    flagEl.innerHTML = '<div style="font-size:13px;color:var(--text3);">No players flagged this term. All averaging 2.5 or above across categories.</div>';
  } else {
    flagEl.innerHTML = flags.sort((a,b) => parseFloat(a.overall)-parseFloat(b.overall)).map(f => `
      <div class="flag-card">
        <div class="player-avatar" style="width:34px;height:34px;font-size:12px;background:var(--red-light);color:var(--red);">${initials(f.p)}</div>
        <div>
          <div class="flag-name">${f.p.fname} ${f.p.lname}</div>
          <div class="flag-detail">${f.p.group} &bull; ${f.p.pos} &bull; Overall avg: ${f.overall}/5</div>
        </div>
        <div style="display:flex;flex-direction:column;gap:4px;align-items:flex-end;">
          ${f.lowCount >= 2 ? `<span class="flag-badge">${f.lowCount} areas below 2.5</span>` : ''}
          ${f.attFlag ? `<span class="flag-badge" style="background:var(--amber-light);color:var(--gold);">${f.attStats.pct}% attendance</span>` : ''}
        </div>
        <button class="btn-secondary" style="font-size:12px;padding:5px 12px;" onclick="openIDPForPlayer('${f.pid}')">View IDP</button>
      </div>
    `).join('');
  }

  // ── FULL PLAYER TABLE ─────────────────────────────────────────
  const tableEl = document.getElementById('dash-table');
  const filtered = Object.entries(allPlayers)
    .filter(([id,p]) => grpFilter === 'all' || p.group === grpFilter)
    .sort((a,b) => a[1].group.localeCompare(b[1].group) || a[1].lname.localeCompare(b[1].lname));

  const pillClass = v => {
    if (!v || v === 'N/A') return 'pill-grey';
    const n = parseFloat(v);
    if (n > 3.5)  return 'pill-gold';
    if (n >= 2.5) return 'pill-green';
    return 'pill-orange';
  };

  tableEl.innerHTML = `
    <div style="overflow-x:auto;">
    <table class="player-table">
      <thead><tr>
        <th>Player</th><th>Group</th><th>Pos</th>
        <th>Attitude</th><th>Comm.</th><th>Perf.</th>
        <th>Mindset</th><th>Physical</th><th>Impact</th>
        <th>Sessions</th><th>Matches</th>
      </tr></thead>
      <tbody>
        ${filtered.map(([pid,p]) => {
          const pt = termTraining.filter(t => t.entries?.[pid]);
          const pm = termMatches.filter(m => m.entries?.[pid]);
          const ta = calcAvg(pt.map(t => t.entries[pid].attitude));
          const tc = calcAvg(pt.map(t => t.entries[pid].communication));
          const tp = calcAvg(pt.map(t => t.entries[pid].performance));
          const mm = calcAvg(pm.map(m => m.entries[pid].mindset));
          const mf = calcAvg(pm.map(m => m.entries[pid].physical));
          const mi = calcAvg(pm.map(m => m.entries[pid].impact));
          const pill = (v) => v ? `<span class="rating-pill ${pillClass(v)}">${v}</span>` : '<span style="color:var(--text3);">-</span>';
          return `<tr>
            <td style="font-weight:600;">${p.fname} ${p.lname}</td>
            <td><span class="badge badge-group">${p.group}</span></td>
            <td>${p.pos}</td>
            <td>${pill(ta)}</td><td>${pill(tc)}</td><td>${pill(tp)}</td>
            <td>${pill(mm)}</td><td>${pill(mf)}</td><td>${pill(mi)}</td>
            <td>${pt.length}</td><td>${pm.length}</td>
          </tr>`;
        }).join('')}
      </tbody>
    </table>
    </div>
  `;
};

// ── ROLE FIELD TOGGLE ─────────────────────────────────────────────
window.toggleCoachRoleFields = function() {
  const roleType  = document.getElementById('ac-role-type')?.value;
  const phaseRow  = document.getElementById('ac-phase-row');
  const agRow     = document.getElementById('ac-agegroup-row');
  if (!phaseRow || !agRow) return;
  if (roleType === 'manager') {
    phaseRow.classList.add('hidden');
    agRow.classList.remove('hidden');
  } else {
    phaseRow.classList.remove('hidden');
    agRow.classList.add('hidden');
  }
};

// ── DATA MANAGEMENT ───────────────────────────────────────────────
window.loadDataEntries = function() {
  const type  = document.getElementById('dm-type')?.value;
  const group = document.getElementById('dm-group')?.value;
  const list  = document.getElementById('dm-entries-list');
  const status = document.getElementById('dm-status');

  if (!type) { list.innerHTML = ''; return; }

  const sourceMap = { training: allTraining, matches: allMatches, monthly: allMonthly };
  const source = sourceMap[type] || {};
  const entries = Object.entries(source)
    .filter(([key, e]) => !group || e.group === group || e.pid)
    .sort((a, b) => {
      const da = a[1].date || a[1].month || '';
      const db = b[1].date || b[1].month || '';
      return db.localeCompare(da);
    });

  if (!entries.length) {
    list.innerHTML = '<div class="empty-state">No entries found.</div>';
    status.textContent = '';
    return;
  }

  status.textContent = `${entries.length} entr${entries.length !== 1 ? 'ies' : 'y'} found.`;
  status.className = 'status-msg status-ok';

  list.innerHTML = entries.map(([key, e]) => {
    let title = '';
    let meta  = '';

    if (type === 'training') {
      title = `Training — ${e.group || 'Unknown'} — ${e.date || 'No date'}`;
      const count = Object.keys(e.entries || {}).length;
      meta  = `Block ${e.block || 'N/A'} &bull; ${count} player${count !== 1 ? 's' : ''} rated &bull; Coach: ${e.coach || 'Unknown'}`;
    } else if (type === 'matches') {
      title = `Match — ${e.group || 'Unknown'} vs ${e.opposition || 'Unknown'} — ${e.date || 'No date'}`;
      const count = Object.keys(e.entries || {}).length;
      meta  = `${e.venue || ''} &bull; ${count} player${count !== 1 ? 's' : ''} rated &bull; Coach: ${e.coach || 'Unknown'}`;
    } else if (type === 'monthly') {
      const p = allPlayers[e.pid];
      const pName = p ? `${p.fname} ${p.lname}` : 'Unknown player';
      title = `Review — ${pName} — ${e.month || 'No date'}`;
      meta  = `Coach: ${e.coach || 'Unknown'}`;
    }

    return `<div class="data-entry-row">
      <div class="data-entry-info">
        <div class="data-entry-title">${title}</div>
        <div class="data-entry-meta">${meta}</div>
      </div>
      <button class="btn-delete-entry" onclick="deleteDataEntry('${type}','${key}','${title.replace(/'/g,'').replace(/"/g,'')}')">
        Delete
      </button>
    </div>`;
  }).join('');
};

window.deleteDataEntry = async function(type, key, label) {
  if (!confirm(`Delete this entry?\n\n${label}\n\nThis cannot be undone.`)) return;
  try {
    await remove(ref(db, `${type}/${key}`));
    toast('Entry deleted.');
    loadDataEntries();
  } catch(err) {
    toast('Error deleting entry. Try again.');
    console.error(err);
  }
};
