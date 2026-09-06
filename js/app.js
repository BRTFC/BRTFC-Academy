import { db, auth, ref, set, get, push, update, remove, onValue, child,
         signInWithEmailAndPassword, signOut, sendPasswordResetEmail, onAuthStateChanged }
  from './firebase.js';

// ── STATE ────────────────────────────────────────────────────────
let currentCoach = null;
let allPlayers   = {};
let allPotential = {};
let allCoaches   = {};
let allTraining  = {};
let allMatches   = {};
let allMonthly   = {};
let allGoals     = {};
let allFitness   = {};
let halfTerms    = {};
let termDates    = {
  1: { start: '', end: '' },
  2: { start: '', end: '' },
  3: { start: '', end: '' }
};
let activePlayerFilter = 'all';

const POSITIONS = ['GK','CB','RB','LB','CDM','CM','CAM','RW','LW','CF','ST'];

function generatePlayerPIN() {
  return String(Math.floor(1000 + Math.random() * 9000));
}

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
  if (isPhaseLead()) return ['players','training','match','monthly','idp','dashboard','insights','potential','teamreview','fitness'].includes(view);
  if (isManager())   return ['players','match','idp','insights'].includes(view);
  return false;
}

// ── BOOT ─────────────────────────────────────────────────────────
window.addEventListener('DOMContentLoaded', () => {
  setTodayDates();
  initTheme();

  // Listen for Firebase Auth state changes
  let dataListening = false;
  onAuthStateChanged(auth, async (user) => {
    if (user) {
      // Only start listeners once — prevents duplicate onValue registrations
      if (!dataListening) {
        dataListening = true;
        listenData();
      }
      await resolveCoachFromEmail(user.email);
    } else {
      // Not signed in — show login screen
      dataListening = false;
      currentCoach = null;
      document.getElementById('screen-app')?.classList.add('hidden');
      document.getElementById('screen-login')?.classList.remove('hidden');
      document.querySelectorAll('.nav-btn').forEach(el => el.classList.add('hidden'));
    }
  });

  document.getElementById('login-email')?.addEventListener('keydown', e => {
    if (e.key === 'Enter') document.getElementById('login-password')?.focus();
  });
  document.getElementById('login-password')?.addEventListener('keydown', e => {
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
  onValue(ref(db, 'fitness'),   s => { allFitness  = s.val() || {}; });
  onValue(ref(db, 'halfTerms'), s => { halfTerms = s.val() || {}; populateHalfTermSelects(); renderHalfTermFields(); });
  onValue(ref(db, 'termDates'), s => {
    if (s.val()) { termDates = s.val(); }
    renderTermFields();
  });
}

// ── AUTH ─────────────────────────────────────────────────────────
window.doLogin = async function() {
  const email    = document.getElementById('login-email')?.value.trim();
  const password = document.getElementById('login-password')?.value;
  const errEl    = document.getElementById('login-error');
  const btn      = document.getElementById('login-btn');

  if (!email || !password) {
    if (errEl) errEl.textContent = 'Please enter your email and password.';
    return;
  }
  if (btn) { btn.textContent = 'Signing in...'; btn.disabled = true; }
  if (errEl) errEl.textContent = '';

  try {
    await signInWithEmailAndPassword(auth, email, password);
    // onAuthStateChanged will handle the rest
    if (document.getElementById('login-password')) document.getElementById('login-password').value = '';
  } catch(err) {
    let msg = 'Sign in failed. Check your email and password.';
    if (err.code === 'auth/user-not-found' || err.code === 'auth/wrong-password' || err.code === 'auth/invalid-credential') {
      msg = 'Incorrect email or password.';
    } else if (err.code === 'auth/too-many-requests') {
      msg = 'Too many attempts. Try again in a few minutes.';
    }
    if (errEl) errEl.textContent = msg;
    if (btn) { btn.textContent = 'Sign in'; btn.disabled = false; }
  }
};

window.doPasswordReset = async function() {
  const email = document.getElementById('login-email')?.value.trim();
  const errEl = document.getElementById('login-error');
  if (!email) {
    if (errEl) errEl.textContent = 'Enter your email address first, then click Forgot password.';
    return;
  }
  try {
    await sendPasswordResetEmail(auth, email);
    if (errEl) { errEl.style.color = 'var(--green)'; errEl.textContent = `Password reset email sent to ${email}.`; }
  } catch(err) {
    if (errEl) errEl.textContent = 'Could not send reset email. Check the address is correct.';
  }
};

async function resolveCoachFromEmail(email) {
  // Wait for both coaches and players data to be available
  let attempts = 0;
  while ((Object.keys(allCoaches).length === 0 || Object.keys(allPlayers).length === 0) && attempts < 40) {
    await new Promise(r => setTimeout(r, 250));
    attempts++;
  }

  const coach = Object.entries(allCoaches).find(([id, c]) =>
    c.email && c.email.toLowerCase().trim() === email.toLowerCase().trim()
  );

  if (!coach) {
    // Email authenticated but no matching coach record
    document.getElementById('login-error').textContent =
      'Account found but no coach profile linked to ' + email + '. Contact your administrator.';
    document.getElementById('screen-login').classList.remove('hidden');
    document.getElementById('screen-app').classList.add('hidden');
    await signOut(auth);
    return;
  }

  currentCoach = { id: coach[0], ...coach[1] };
  document.getElementById('login-error').textContent = '';
  const nameEl = document.getElementById('header-coach-name');
  if (nameEl) nameEl.textContent = currentCoach.name;
  const loginBtn = document.getElementById('login-btn');
  if (loginBtn) { loginBtn.textContent = 'Sign in'; loginBtn.disabled = false; }

  // Show permitted nav items
  const navViews = ['players','training','match','monthly','idp','admin','dashboard','insights','potential','fitness','teamreview'];
  navViews.forEach(v => {
    const btn = document.querySelector(`[data-view="${v}"]`);
    if (!btn) return;
    if (canAccessNav(v)) btn.classList.remove('hidden');
    else btn.classList.add('hidden');
  });

  document.getElementById('screen-login').classList.add('hidden');
  document.getElementById('screen-app').classList.remove('hidden');

  if (isManager()) {
    switchView('match', document.querySelector('[data-view="match"]'));
  } else {
    renderPlayersView();
  }
}

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

window.doLogout = async function() {
  currentCoach = null;
  await signOut(auth);
  // onAuthStateChanged handles the rest
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
  if (v === 'fitness')   initFitnessView();
  if (v === 'teamreview') { document.getElementById('tr-review-output').innerHTML = ''; }
  if (v === 'match')     initMatchView();
  if (v === 'monthly')   initMonthlyView();
  if (v === 'admin')     renderAdminPlayers();
  if (v === 'dashboard') renderDashboard();
  if (v === 'insights')  renderInsights();
  if (v === 'potential') initPotentialView();
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
          <span class="badge badge-pos">${p.pos}${p.pos2 ? ' / '+p.pos2 : ''}</span>
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
      <div style="margin-top:1rem;display:flex;gap:8px;flex-wrap:wrap;">
        <button class="btn-primary" onclick="closeModal('modal-player');openIDPForPlayer('${pid}');">
          View full IDP
        </button>
        <button class="btn-secondary" onclick="closeModal('modal-player');switchView('fitness',document.querySelector('[data-view=fitness]'));setTimeout(()=>{const g=allPlayers['${pid}']?.group;if(g){document.getElementById('fit-group').value=g;loadFitnessPlayers();setTimeout(()=>{document.getElementById('fit-player').value='${pid}';loadFitnessForm();},200);}},100);">
          Fitness data
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
  if (!p) { toast('Player data not loaded yet. Try again in a moment.'); return; }
  // Switch to IDP view
  switchView('idp', document.querySelector('[data-view=idp]'));
  // Set group then populate player select then set player
  setTimeout(() => {
    const grpSel = document.getElementById('idp-group');
    if (!grpSel) return;
    grpSel.value = p.group;
    loadIDPPlayers();
    setTimeout(() => {
      const playerSel = document.getElementById('idp-player');
      if (playerSel) playerSel.value = pid;
      renderIDP();
    }, 150);
  }, 150);
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
          <button class="att-btn" id="att_injured_${id}" onclick="setAttendance('${id}','injured','tr')"     title="Injured">🤕</button>
          <button class="att-btn" id="att_absent_${id}"  onclick="setAttendance('${id}','absent','tr')"      title="Absent">❌</button>
          <button class="att-btn" id="att_ns_${id}"      onclick="setAttendance('${id}','notselected','tr')" title="Not Selected">🔵</button>
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
  const cycle = document.getElementById('tr-cycle')?.value || '';
  const key = `${date}_${group}`;
  await set(ref(db, `training/${key}`), {
    date, group, block, cycle,
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
          <button class="att-btn" id="mr_att_injured_${id}" onclick="setAttendance('${id}','injured','mr')"     title="Injured">🤕</button>
          <button class="att-btn" id="mr_att_absent_${id}"  onclick="setAttendance('${id}','absent','mr')"      title="Absent">❌</button>
          <button class="att-btn" id="mr_att_ns_${id}"      onclick="setAttendance('${id}','notselected','mr')" title="Not Selected">🔵</button>
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
  if (!p) { output.innerHTML = '<div class="empty-state">Player not found.</div>'; return; }

  const termLabel = { '1': 'Term 1 (Aug-Oct)', '2': 'Term 2 (Nov-Jan)', '3': 'Term 3 (Feb-Apr)' }[termNo];
  const termRange = getTermRange(parseInt(termNo));

  // Filter data to this term
  const trainSessions = Object.values(allTraining).filter(t =>
    t.entries?.[pid] && inTermRange(t.date, termRange)
  );
  const matchSessions = Object.values(allMatches).filter(m =>
    m.entries?.[pid] && inTermRange(m.date, termRange)
  );
  const monthlyReports = Object.values(allMonthly).filter(mo => {
    if (mo.pid !== pid) return false;
    // Handle half-term key format (ht_TIMESTAMP)
    if (mo.month && mo.month.startsWith('ht_')) {
      const ht = halfTerms[mo.month];
      if (!ht?.start) return true; // include if no date info
      return inTermRange(ht.start, termRange);
    }
    // Handle standard YYYY-MM format
    if (mo.month) return inTermRange(mo.month + '-01', termRange);
    return true;
  });
  const goals = Object.entries(allGoals).filter(([id, g]) => g.pid === pid);

  // Averages
  const trainPerfAvg    = calcAvg(trainSessions.map(t => t.entries[pid].performance));
  const trainAttAvg     = calcAvg(trainSessions.map(t => t.entries[pid].attitude));
  const trainCommAvg    = calcAvg(trainSessions.map(t => t.entries[pid].communication));
  const matchMindsetAvg  = calcAvg(matchSessions.map(m => m.entries[pid].mindset));
  const matchPhysicalAvg = calcAvg(matchSessions.map(m => m.entries[pid].physical));
  const matchImpactAvg   = calcAvg(matchSessions.map(m => m.entries[pid].impact));

  const moAvgs = {};
  ['technical','tactical','behaviours','physical','nonNegotiables'].forEach(cat => {
    moAvgs[cat] = calcAvg(monthlyReports.map(r => r[cat]?.rating || 0).filter(v => v > 0));
    // Build comments with half-term label if available
    moAvgs[`${cat}_comments`] = monthlyReports
      .map(r => {
        const comment = r[cat]?.comments;
        if (!comment) return null;
        const htLabel = r.month?.startsWith('ht_') && halfTerms[r.month]?.label
          ? halfTerms[r.month].label + ': '
          : '';
        return htLabel + comment;
      })
      .filter(Boolean)
      .join(' | ');
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

  const attendStats = getPlayerAttendanceStats(pid);
  const age  = p.dob ? calcAge(p.dob) : 'N/A';
  const year = new Date().getFullYear();
  const hasData = trainSessions.length > 0 || matchSessions.length > 0 || monthlyReports.length > 0 || goals.length > 0;

  output.innerHTML = `
    <div class="idp-doc">
      <div class="idp-header-band">
        <div style="display:flex;align-items:flex-start;gap:14px;margin-bottom:12px;">
          <img src="images/crest.png" alt="BRTFC" style="width:52px;height:52px;object-fit:contain;filter:drop-shadow(0 2px 6px rgba(0,0,0,0.3));flex-shrink:0;">
          <div>
            <div class="idp-club-name">Bognor Regis Town FC</div>
            <div class="idp-doc-title">Individual Development Plan</div>
            <div class="idp-player-name">${p.fname} ${p.lname}</div>
          </div>
        </div>
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
            ${attendStats.injured     ? `${attendStats.injured} session${attendStats.injured!==1?'s':''} missed through injury.` : ''}
            ${attendStats.absent      ? `${attendStats.absent} session${attendStats.absent!==1?'s':''} absent without reason.` : ''}
            ${attendStats.notSelected ? `${attendStats.notSelected} session${attendStats.notSelected!==1?'s':''} not selected (not counted in attendance rate).` : ''}
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
            ${attendStats.notSelected ? `<div class="idp-metric"><div class="idp-metric-val" style="color:var(--text2);">${attendStats.notSelected}</div><div class="idp-metric-lbl">Not Selected</div></div>` : ''}
          </div>
          <div class="idp-bar-row">
            <div class="idp-bar-labels"><span>Attendance</span><span>${attendStats.pct}%</span></div>
            <div class="idp-bar-track"><div class="idp-bar-fill" style="width:${attendStats.pct}%;background:${attendStats.pct < 85 ? 'linear-gradient(90deg,#e07000,#f09030)' : 'linear-gradient(90deg,#1a5c28,#2A8C3F)'};"></div></div>
          </div>
        </div>` : ''}

        ${/* SEASON PROGRESSION CHART - weekly data points */`
        <div class="idp-section">
          <div class="idp-section-title">Season progression</div>
          <div style="font-size:12px;color:var(--text3);margin-bottom:1rem;">Weekly averages across the season. Each point is the average of all sessions in that week. Training metrics are solid lines, match metrics are dashed.</div>
          ${(function() {
            const METRICS = [
              { label: 'Attitude',      colour: '#2A8C3F', type: 'training', key: 'attitude' },
              { label: 'Communication', colour: '#185fa5', type: 'training', key: 'communication' },
              { label: 'Performance',   colour: '#B8922A', type: 'training', key: 'performance' },
              { label: 'Mindset',       colour: '#ef9f27', type: 'match',    key: 'mindset' },
              { label: 'Physical',      colour: '#C0272D', type: 'match',    key: 'physical' },
              { label: 'Impact',        colour: '#7b2d8b', type: 'match',    key: 'impact' }
            ];

            // Get all sessions for this player across the full season, sorted by date
            const allSess = [
              ...Object.values(allTraining)
                .filter(t => t.entries?.[pid] && t.date &&
                  (!t.entries[pid].attendance || t.entries[pid].attendance === 'present'))
                .map(t => ({ date: t.date, type: 'training', entry: t.entries[pid] })),
              ...Object.values(allMatches)
                .filter(m => m.entries?.[pid] && m.date &&
                  (!m.entries[pid].attendance || m.entries[pid].attendance === 'present'))
                .map(m => ({ date: m.date, type: 'match', entry: m.entries[pid] }))
            ].sort((a, b) => a.date.localeCompare(b.date));

            if (!allSess.length) return '<div style="font-size:13px;color:var(--text3);">No data yet. Scores will appear here as the season progresses.</div>';

            // Group sessions into 3-week blocks
            // Get the season start date from term 1
            const term1Range = getTermRange(1);
            const seasonStart = new Date(term1Range.start);

            // Get week number relative to season start
            const getWeekNum = (dateStr) => {
              const d = new Date(dateStr);
              const diff = d - seasonStart;
              return Math.floor(diff / (7 * 24 * 60 * 60 * 1000));
            };

            // Group into 3-week buckets
            const buckets = {};
            allSess.forEach(s => {
              const wk = getWeekNum(s.date);
              const bucket = Math.floor(wk / 3); // 3-week bucket
              if (!buckets[bucket]) buckets[bucket] = { training: [], match: [], weekStart: wk };
              buckets[bucket][s.type].push(s);
            });

            const sortedBuckets = Object.entries(buckets)
              .sort((a, b) => parseInt(a[0]) - parseInt(b[0]))
              .map(([bucketIdx, data]) => ({
                bucketIdx: parseInt(bucketIdx),
                ...data
              }));

            if (!sortedBuckets.length) return '<div style="font-size:13px;color:var(--text3);">No data yet.</div>';

            // Calculate term boundaries for shading
            const term2Range = getTermRange(2);
            const term3Range = getTermRange(3);

            const term1End   = new Date(term1Range.end);
            const term2Start = new Date(term2Range.start);
            const term2End   = new Date(term2Range.end);
            const term3Start = new Date(term3Range.start);

            const getTerm = (dateStr) => {
              const d = new Date(dateStr);
              if (d <= term1End) return 1;
              if (d >= term2Start && d <= term2End) return 2;
              return 3;
            };

            // SVG dimensions
            const W = 580, H = 220, PAD_L = 36, PAD_R = 16, PAD_T = 20, PAD_B = 48;
            const chartW = W - PAD_L - PAD_R;
            const chartH = H - PAD_T - PAD_B;
            const n = sortedBuckets.length;
            const valY = v => PAD_T + chartH - ((parseFloat(v) - 1) / 4) * chartH;
            const bucketX = i => PAD_L + (n === 1 ? chartW / 2 : (i / (n - 1)) * chartW);

            let svg = `<svg viewBox="0 0 ${W} ${H}" style="width:100%;overflow:visible;" xmlns="http://www.w3.org/2000/svg">`;

            // Background term shading
            // Determine x position for each bucket by its first session date
            const firstDate = (b) => {
              const sessions = [...b.training, ...b.match];
              return sessions.length ? sessions[0].date : null;
            };

            // Shade term bands based on bucket positions
            let lastTerm = null;
            let termStartX = PAD_L;
            sortedBuckets.forEach((b, i) => {
              const fd = firstDate(b);
              const term = fd ? getTerm(fd) : null;
              if (term && term !== lastTerm) {
                if (lastTerm !== null) {
                  // End of previous term band
                }
                lastTerm = term;
                termStartX = bucketX(i);
              }
            });

            // Draw term labels at top
            const termColors = { 1: '#e8f5ec', 2: '#faf0dc', 3: '#e8edf5' };
            const termTextColors = { 1: '#0f3d1a', 2: '#8a6000', 3: '#1a2a4a' };
            let curTerm = null, termXStart = PAD_L;
            sortedBuckets.forEach((b, i) => {
              const fd = firstDate(b);
              const term = fd ? getTerm(fd) : curTerm;
              if (term !== curTerm) {
                if (curTerm !== null) {
                  const endX = bucketX(i);
                  svg += `<rect x="${termXStart}" y="${PAD_T}" width="${endX - termXStart}" height="${chartH}" fill="${termColors[curTerm]}" opacity="0.4"/>`;
                  const midX = (termXStart + endX) / 2;
                  svg += `<text x="${midX}" y="${H - 6}" text-anchor="middle" font-size="11" font-weight="600" fill="${termTextColors[curTerm]}">Term ${curTerm}</text>`;
                }
                curTerm = term;
                termXStart = bucketX(i);
              }
            });
            // Last term band
            if (curTerm !== null) {
              const endX = bucketX(n - 1) + (n > 1 ? 0 : chartW / 2);
              svg += `<rect x="${termXStart}" y="${PAD_T}" width="${Math.min(endX + 20, W - PAD_R) - termXStart}" height="${chartH}" fill="${termColors[curTerm]}" opacity="0.4"/>`;
              const midX = (termXStart + Math.min(endX + 20, W - PAD_R)) / 2;
              svg += `<text x="${midX}" y="${H - 6}" text-anchor="middle" font-size="11" font-weight="600" fill="${termTextColors[curTerm]}">Term ${curTerm}</text>`;
            }

            // Grid lines and Y labels
            [1,2,3,4,5].forEach(v => {
              const y = valY(v);
              svg += `<line x1="${PAD_L}" y1="${y}" x2="${W - PAD_R}" y2="${y}" stroke="var(--border)" stroke-width="${v===1||v===5?1.5:1}" stroke-dasharray="${v===1||v===5?'none':'3,3'}"/>`;
              svg += `<text x="${PAD_L - 6}" y="${y + 4}" text-anchor="end" font-size="10" fill="var(--text3)">${v}</text>`;
            });

            // 3-week block labels on X axis (Block 1, Block 2...)
            sortedBuckets.forEach((b, i) => {
              const blockNum = b.bucketIdx + 1;
              svg += `<text x="${bucketX(i)}" y="${H - 20}" text-anchor="middle" font-size="9" fill="var(--text3)">Wk${b.weekStart+1}-${b.weekStart+3}</text>`;
            });

            // Plot each metric
            METRICS.forEach(metric => {
              const points = sortedBuckets.map((b, i) => {
                const sessions = b[metric.type];
                const vals = sessions
                  .map(s => parseFloat(s.entry?.[metric.key]))
                  .filter(v => !isNaN(v) && v > 0);
                const avg = vals.length ? vals.reduce((a,v)=>a+v,0)/vals.length : null;
                return avg !== null ? { x: bucketX(i), y: valY(avg), v: avg } : null;
              });

              const valid = points.filter(Boolean);
              if (!valid.length) return;

              const dash = metric.type === 'match' ? 'stroke-dasharray="5,3"' : '';

              // Connecting lines
              for (let i = 0; i < valid.length - 1; i++) {
                svg += `<line x1="${valid[i].x}" y1="${valid[i].y}" x2="${valid[i+1].x}" y2="${valid[i+1].y}" stroke="${metric.colour}" stroke-width="2" stroke-linecap="round" ${dash}/>`;
              }

              // Dots
              valid.forEach((pt, i) => {
                const isLast = i === valid.length - 1;
                svg += `<circle cx="${pt.x}" cy="${pt.y}" r="${isLast ? 5 : 3.5}" fill="${metric.colour}" stroke="white" stroke-width="1.5"/>`;
                // Only show value label on last point to avoid clutter
                if (isLast) {
                  svg += `<text x="${pt.x + 8}" y="${pt.y + 4}" text-anchor="start" font-size="10" font-weight="700" fill="${metric.colour}">${pt.v.toFixed(1)}</text>`;
                }
              });
            });

            svg += `</svg>`;

            // Legend — training solid, match dashed
            const legend = METRICS.map(m =>
              `<span style="display:flex;align-items:center;gap:5px;font-size:12px;color:var(--text2);">
                <svg width="18" height="10" style="flex-shrink:0;"><line x1="0" y1="5" x2="18" y2="5" stroke="${m.colour}" stroke-width="2.5" ${m.type==='match'?'stroke-dasharray="4,2"':''}/><circle cx="9" cy="5" r="3" fill="${m.colour}"/></svg>${m.label}
              </span>`
            ).join('');

            return svg + `<div style="display:flex;gap:14px;flex-wrap:wrap;margin-top:10px;">${legend}</div>`;
          })()}
        </div>`}

        ${/* TRAINING: side-by-side across reviews */trainSessions.length ? `
        <div class="idp-section">
          <div class="idp-section-title">Training performance</div>
          ${[
            { label: 'Attitude',      val: trainAttAvg },
            { label: 'Communication', val: trainCommAvg },
            { label: 'Performance',   val: trainPerfAvg }
          ].map(item => `
            <div class="idp-bar-row">
              <div class="idp-bar-labels"><span>${item.label}</span><span>${item.val ? item.val + '/5' : 'N/A'}</span></div>
              ${item.val ? `<div class="idp-bar-track"><div class="idp-bar-fill" style="width:${Math.round((parseFloat(item.val)/5)*100)}%;background:${idpBarColour(item.val)};"></div></div>` : ''}
            </div>
          `).join('')}
          ${trainSessions.length > 0 ? (() => {
            const byBlock = trainSessions.reduce((acc, t) => {
              const k = t.block || '';
              if (!acc[k]) acc[k] = 0;
              acc[k]++;
              return acc;
            }, {});
            const blockNames = {'1':'B1: Build & Progress','2':'B2: Create & Exploit','3':'B3: Final Third','4':'B4: Press & Regain','5':'B5: Defend & Transition','6':'B6: Game Control'};
            const cycleCount = trainSessions.filter(t => t.cycle).length;
            const c1 = trainSessions.filter(t => ['recognition','execution','application'].includes(t.cycle)).length;
            const c2 = trainSessions.filter(t => ['execution+','application2','integration'].includes(t.cycle)).length;
            const blockRows = Object.entries(byBlock)
              .filter(([k]) => k)
              .map(([k, n]) => `<span style="font-size:11px;padding:2px 7px;background:#e8f5ec;color:#0f3d1a;border-radius:4px;font-weight:600;margin-right:4px;margin-bottom:3px;display:inline-block;">${blockNames[k]||'Block '+k} &times;${n}</span>`)
              .join('');
            const cycleRow = (c1||c2) ? `<div style="font-size:12px;color:var(--text2);margin-top:4px;">Cycle 1: ${c1} sessions &nbsp;|&nbsp; Cycle 2: ${c2} sessions</div>` : '';
            return blockRows ? `<div style="margin-top:10px;">${blockRows}${cycleRow}</div>` : '';
          })() : ''}
        </div>` : ''}

        ${/* MATCH: side-by-side across reviews */matchSessions.length ? `
        <div class="idp-section">
          <div class="idp-section-title">Match performance</div>
          ${[
            { label: 'Mindset',  val: matchMindsetAvg },
            { label: 'Physical', val: matchPhysicalAvg },
            { label: 'Impact',   val: matchImpactAvg }
          ].map(item => `
            <div class="idp-bar-row">
              <div class="idp-bar-labels"><span>${item.label}</span><span>${item.val ? item.val + '/5' : 'N/A'}</span></div>
              ${item.val ? `<div class="idp-bar-track"><div class="idp-bar-fill" style="width:${Math.round((parseFloat(item.val)/5)*100)}%;background:${idpBarColour(item.val)};"></div></div>` : ''}
            </div>
          `).join('')}
        </div>` : ''}

        ${/* HALF-TERM REVIEWS: one row per category showing all periods side by side */monthlyReports.length ? `
        <div class="idp-section">
          <div class="idp-section-title">Half-term reviews</div>

          ${/* Period headers */`
          <div class="idp-review-comparison">
            <div class="idp-review-attr-col"></div>
            ${monthlyReports.map(r => {
              const htLabel = r.month?.startsWith('ht_') && halfTerms[r.month]?.label
                ? halfTerms[r.month].label : r.month || 'Review';
              return `<div class="idp-review-period-col">
                <div class="idp-review-period-label">${htLabel}</div>
                <div class="idp-review-coach">Coach: ${r.coach || 'Unknown'}</div>
              </div>`;
            }).join('')}
          </div>`}

          ${/* One row per category */['technical','tactical','behaviours','physical'].map(cat => {
            const hasAnyData = monthlyReports.some(r => r[cat]?.rating || r[cat]?.comments);
            if (!hasAnyData) return '';
            return `<div class="idp-review-cat-section">
              <div class="idp-review-cat-title">${DNA_LABELS[cat]}</div>
              <div class="idp-review-comparison">
                <div class="idp-review-attr-col">
                  <div class="idp-review-attr-name">Rating</div>
                </div>
                ${monthlyReports.map(r => {
                  const rating = r[cat]?.rating;
                  const pct = rating ? Math.round((parseFloat(rating)/5)*100) : 0;
                  return `<div class="idp-review-period-col">
                    ${rating ? `
                    <div style="display:flex;align-items:center;gap:6px;">
                      <div class="idp-bar-track" style="flex:1;height:8px;">
                        <div class="idp-bar-fill" style="width:${pct}%;background:${idpBarColour(rating)};"></div>
                      </div>
                      <span style="font-size:12px;font-weight:700;color:var(--text);flex-shrink:0;">${parseFloat(rating).toFixed(1)}</span>
                    </div>` : '<span style="font-size:12px;color:var(--text3);">N/A</span>'}
                  </div>`;
                }).join('')}
              </div>
              ${monthlyReports.some(r => r[cat]?.comments) ? `
              <div style="margin-top:8px;">
                ${monthlyReports.map(r => {
                  const comment = r[cat]?.comments;
                  if (!comment) return '';
                  const htLabel = r.month?.startsWith('ht_') && halfTerms[r.month]?.label
                    ? halfTerms[r.month].label : r.month || 'Review';
                  return `<div class="idp-comments-block" style="margin-bottom:6px;">
                    <span style="font-size:11px;font-weight:700;color:var(--green);text-transform:uppercase;letter-spacing:0.06em;">${htLabel}</span><br>
                    ${comment}
                  </div>`;
                }).join('')}
              </div>` : ''}
            </div>`;
          }).join('')}

          ${/* Non-Negotiables row */monthlyReports.some(r => r.nonNegotiables?.rating || r.nonNegotiables?.comments) ? `
          <div class="idp-review-cat-section" style="background:var(--green-light);border-radius:var(--r-sm);padding:12px;margin-top:8px;">
            <div class="idp-review-cat-title" style="color:var(--green-dark);">BRTFC Non-Negotiables</div>
            <div style="font-size:12px;color:var(--green-dark);margin-bottom:8px;opacity:0.7;">Scan early. Communicate early. React immediately.</div>
            <div class="idp-review-comparison">
              <div class="idp-review-attr-col"><div class="idp-review-attr-name">Rating</div></div>
              ${monthlyReports.map(r => {
                const rating = r.nonNegotiables?.rating;
                const pct = rating ? Math.round((parseFloat(rating)/5)*100) : 0;
                return `<div class="idp-review-period-col">
                  ${rating ? `
                  <div style="display:flex;align-items:center;gap:6px;">
                    <div class="idp-bar-track" style="flex:1;height:8px;">
                      <div class="idp-bar-fill" style="width:${pct}%;background:${idpBarColour(rating)};"></div>
                    </div>
                    <span style="font-size:12px;font-weight:700;color:var(--text);flex-shrink:0;">${parseFloat(rating).toFixed(1)}</span>
                  </div>` : '<span style="font-size:12px;color:var(--text3);">N/A</span>'}
                </div>`;
              }).join('')}
            </div>
            ${monthlyReports.some(r => r.nonNegotiables?.comments) ? `
            <div style="margin-top:8px;">
              ${monthlyReports.map(r => {
                if (!r.nonNegotiables?.comments) return '';
                const htLabel = r.month?.startsWith('ht_') && halfTerms[r.month]?.label
                  ? halfTerms[r.month].label : r.month || 'Review';
                return `<div class="idp-comments-block" style="margin-bottom:6px;">
                  <span style="font-size:11px;font-weight:700;color:var(--green);text-transform:uppercase;letter-spacing:0.06em;">${htLabel}</span><br>
                  ${r.nonNegotiables.comments}
                </div>`;
              }).join('')}
            </div>` : ''}
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

      ${(() => {
        const season = year + '/' + (year+1);
        const fKey = `${pid}_${season.replace('/','_')}`;
        const fd = allFitness[fKey];
        if (!fd) return '';
        const tests = [
          { label: '10m sprint', base: fd.test?.sprint10, ret: fd.retest?.sprint10, unit: 's', lower: true },
          { label: '30m sprint', base: fd.test?.sprint30, ret: fd.retest?.sprint30, unit: 's', lower: true },
          { label: 'Yo-Yo Level 1', base: fd.test?.yoyo, ret: fd.retest?.yoyo, unit: '', lower: false },
          { label: 'CMJ', base: fd.test?.cmj, ret: fd.retest?.cmj, unit: 'cm', lower: false }
        ].filter(t => t.base);
        if (!tests.length) return '';
        return `<div class="idp-section">
          <div class="idp-section-title">Fitness data — ${season}</div>
          <div style="display:grid;grid-template-columns:repeat(auto-fit,minmax(160px,1fr));gap:10px;margin-top:6px;">
            ${tests.map(t => {
              const diff = t.ret ? (parseFloat(t.ret) - parseFloat(t.base)) : null;
              const improved = diff !== null ? (t.lower ? diff < 0 : diff > 0) : null;
              return `<div style="padding:10px 12px;background:var(--bg2);border-radius:6px;">
                <div style="font-size:11px;color:var(--text3);margin-bottom:3px;">${t.label}</div>
                <div style="font-size:16px;font-weight:700;color:var(--text);">${t.base}${t.unit}</div>
                ${t.ret ? `<div style="font-size:12px;color:${improved ? '#2A8C3F' : '#C0272D'};margin-top:2px;">Retest: ${t.ret}${t.unit} (${diff > 0 ? '+' : ''}${diff?.toFixed(2)}${t.unit})</div>` : '<div style="font-size:11px;color:var(--text3);margin-top:2px;">No retest yet</div>'}
              </div>`;
            }).join('')}
          </div>
        </div>`;
      })()}
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

function blockBadge(block, cycle) {
  if (!block) return '';
  const blockNames = {
    '1':'Block 1: Build & Progress','2':'Block 2: Create & Exploit',
    '3':'Block 3: Final Third','4':'Block 4: Press & Regain',
    '5':'Block 5: Defend & Transition','6':'Block 6: Game Control'
  };
  const cycleLabels = {
    'recognition':'Wk1 Recognition','execution':'Wk2 Execution',
    'application':'Wk3 Application','execution+':'C2 Wk1 Exec+',
    'application2':'C2 Wk2 Application','integration':'C2 Wk3 Integration'
  };
  const bName = blockNames[block] || `Block ${block}`;
  const cName = cycle ? (cycleLabels[cycle] || cycle) : '';
  return `<span style="display:inline-block;font-size:11px;padding:2px 7px;border-radius:4px;background:#e8f5ec;color:#0f3d1a;font-weight:600;margin-right:6px;">${bName}</span>${cName ? `<span style="display:inline-block;font-size:11px;padding:2px 7px;border-radius:4px;background:#faf0dc;color:#8a6000;font-weight:500;">${cName}</span>` : ''}`;
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
  if (tab === 'pins')       { renderPINSheet(); }
};

window.addCoach = async function() {
  const name      = document.getElementById('ac-name').value.trim();
  const email     = document.getElementById('ac-email').value.trim().toLowerCase();
  const role      = document.getElementById('ac-role').value.trim();
  const role_type = document.getElementById('ac-role-type').value;
  const phase     = document.getElementById('ac-phase').value;
  const ageGroup  = document.getElementById('ac-agegroup').value;
  const admin     = document.getElementById('ac-admin').value === 'true';
  if (!name || !email) { setStatus('coach-status', 'Name and email are required.', false); return; }
  if (!email.includes('@')) { setStatus('coach-status', 'Please enter a valid email address.', false); return; }
  const exists = Object.values(allCoaches).find(c => c.email && c.email.toLowerCase() === email);
  if (exists) { setStatus('coach-status', 'A coach with that email already exists.', false); return; }
  await push(ref(db, 'coaches'), { name, email, role, role_type, phase, ageGroup, admin });
  ['ac-name','ac-email','ac-role'].forEach(id => document.getElementById(id) && (document.getElementById(id).value = ''));
  setStatus('coach-status', `Coach ${name} added. Remember to create their Firebase Auth account with ${email}.`, true);
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
        <div class="data-row-sub" style="margin-top:2px;">
          ${c.email
            ? `<span style="font-size:12px;color:var(--green-dark);">&#10003; ${c.email}</span>`
            : `<span style="font-size:12px;color:var(--red);">&#9888; No email set — coach cannot log in</span>`}
        </div>
      </div>
      <div style="display:flex;gap:6px;">
        <button class="btn-secondary" onclick="editCoachEmail('${id}','${c.email || ''}','${c.name}')">Edit email</button>
        <button class="btn-danger" onclick="removeCoach('${id}','${c.name}')">Remove</button>
      </div>
    </div>
  `).join('');
}

window.removeCoach = async function(id, name) {
  if (!confirm(`Remove ${name}?`)) return;
  await remove(ref(db, `coaches/${id}`));
};

window.editCoachEmail = function(id, currentEmail, name) {
  const newEmail = prompt(`Update email for ${name}:`, currentEmail);
  if (newEmail === null) return; // cancelled
  const email = newEmail.trim().toLowerCase();
  if (!email || !email.includes('@')) { alert('Please enter a valid email address.'); return; }
  update(ref(db, `coaches/${id}`), { email })
    .then(() => toast(`Email updated for ${name}. Make sure their Firebase Auth account uses ${email}.`))
    .catch(err => toast('Error: ' + err.message));
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
  const playerPin = generatePlayerPIN();
  await push(ref(db, 'players'), { fname, lname, dob, group, pos, email, pemail, playerPin });
  ['ap-fname','ap-lname','ap-dob','ap-email','ap-pemail'].forEach(id => document.getElementById(id).value = '');
  setStatus('player-status', `${fname} ${lname} added. PIN: ${playerPin}`, true);
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
        <div style="margin-top:4px;display:flex;align-items:center;gap:8px;flex-wrap:wrap;">
          <span style="font-size:12px;font-weight:600;background:var(--bg2);border:1px solid var(--border2);padding:2px 10px;border-radius:var(--r-full);font-family:monospace;letter-spacing:0.1em;">PIN: ${p.playerPin || 'None'}</span>
          <button onclick="regeneratePIN('${id}','${p.fname}')" style="font-size:11px;color:var(--green);background:none;border:none;cursor:pointer;font-weight:600;padding:0;">Regenerate</button>
          ${p.email||p.pemail ? `<button onclick="sendWelcomeEmail('${id}')" style="font-size:11px;color:var(--blue);background:none;border:none;cursor:pointer;font-weight:600;padding:0;">✉ Send welcome</button>` : ''}
        </div>
      </div>
      <div style="display:flex;gap:6px;">
        <button class="btn-secondary" style="font-size:13px;padding:6px 14px;" onclick="openEditPlayer('${id}')">Edit</button>
        <button class="btn-danger" onclick="removePlayer('${id}','${p.fname} ${p.lname}')">Remove</button>
      </div>
    </div>
  `).join('');
}

window.regeneratePIN = async function(pid, fname) {
  const newPin = generatePlayerPIN();
  await update(ref(db, `players/${pid}`), { playerPin: newPin });
  toast(`New PIN for ${fname}: ${newPin}`);
};

window.sendWelcomeEmail = function(pid) {
  const p = allPlayers[pid];
  if (!p) return;
  const to = [p.email, p.pemail].filter(Boolean).join(',');
  if (!to) { toast('No email address on file.'); return; }
  const portalUrl = window.location.origin + window.location.pathname.replace('index.html','') + 'player.html';
  const subject = encodeURIComponent(`BRTFC Academy Player Portal — Welcome ${p.fname}`);
  const body = encodeURIComponent(
`Hi ${p.fname} and family,

You have been added to the Bognor Regis Town FC Academy player portal. You can now view your Individual Development Plan, track your progress, and set your own goals.

Your login details:
Portal: ${portalUrl}
Date of birth: ${p.dob || 'Your date of birth'}
PIN: ${p.playerPin || 'Contact your coach for your PIN'}

To sign in, go to the portal link above, enter your date of birth and your PIN.

Keep your PIN private. If you lose it, ask your coach to reset it.

BRTFC Academy Coaching Team`
  );
  window.location.href = `mailto:${to}?subject=${subject}&body=${body}`;
};

window.openEditPlayer = function(pid) {
  const p = allPlayers[pid];
  if (!p) return;
  document.getElementById('edit-player-id').value  = pid;
  document.getElementById('edit-fname').value       = p.fname || '';
  document.getElementById('edit-lname').value       = p.lname || '';
  document.getElementById('edit-dob').value         = p.dob   || '';
  document.getElementById('edit-group').value       = p.group || 'U16';
  document.getElementById('edit-pos').value         = p.pos   || 'CM';
  document.getElementById('edit-pos2').value        = p.pos2  || '';
  document.getElementById('edit-email').value       = p.email  || '';
  document.getElementById('edit-pemail').value      = p.pemail || '';
  document.getElementById('edit-player-status').textContent = '';
  document.getElementById('modal-edit-player').classList.remove('hidden');
};

window.savePlayerEdit = async function() {
  const pid    = document.getElementById('edit-player-id').value;
  const fname  = document.getElementById('edit-fname').value.trim();
  const lname  = document.getElementById('edit-lname').value.trim();
  const dob    = document.getElementById('edit-dob').value;
  const group  = document.getElementById('edit-group').value;
  const pos    = document.getElementById('edit-pos').value;
  const pos2   = document.getElementById('edit-pos2').value;
  const email  = document.getElementById('edit-email').value.trim();
  const pemail = document.getElementById('edit-pemail').value.trim();

  if (!fname || !lname) {
    document.getElementById('edit-player-status').textContent = 'First and last name are required.';
    document.getElementById('edit-player-status').className = 'status-msg status-err';
    return;
  }

  await update(ref(db, `players/${pid}`), { fname, lname, dob, group, pos, pos2, email, pemail });
  document.getElementById('edit-player-status').textContent = 'Saved.';
  document.getElementById('edit-player-status').className = 'status-msg status-ok';
  setTimeout(() => closeModal('modal-edit-player'), 800);
};

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
      const pos2 = (row[7] || '').trim();
      await push(ref(db, 'players'), {
        fname, lname, dob,
        group:    validGroups.includes(group) ? group : 'U16',
        pos:      POSITIONS.includes(pos) ? pos : 'CM',
        pos2:     POSITIONS.includes(pos2) ? pos2 : '',
        email, pemail,
        playerPin: generatePlayerPIN()
      });
      added++;
    }
    setStatus('import-status', `${added} player${added !== 1 ? 's' : ''} imported, ${skipped} skipped.`, true);
  } catch(err) {
    setStatus('import-status', `Error: ${err.message}`, false);
  }
};

window.importFromCSV = async function() {
  const fileInput = document.getElementById('import-csv-file');
  if (!fileInput || !fileInput.files.length) {
    setStatus('import-csv-status', 'Please select a CSV file first.', false);
    return;
  }
  const file = fileInput.files[0];
  const text = await file.text();
  const lines = text.split(/\r?\n/).filter(l => l.trim());
  if (!lines.length) { setStatus('import-csv-status', 'File is empty.', false); return; }

  // Parse header
  const headers = lines[0].split(',').map(h => h.trim().toLowerCase().replace(/['"]/g,''));
  const getCol  = (name) => headers.indexOf(name);

  const iFirst  = getCol('firstname');
  const iLast   = getCol('lastname');
  const iDob    = getCol('dob');
  const iGroup  = getCol('agegroup');
  const iPos    = getCol('position');
  const iPos2   = getCol('position2');
  const iEmail  = getCol('playeremail');
  const iPEmail = getCol('parentemail');

  if (iFirst === -1 || iLast === -1) {
    setStatus('import-csv-status', 'Could not find FirstName/LastName columns. Check the CSV header row.', false);
    return;
  }

  // Parse rows — handle quoted fields with commas
  function parseCSVLine(line) {
    const result = [];
    let cur = '', inQ = false;
    for (let i = 0; i < line.length; i++) {
      const ch = line[i];
      if (ch === '"') { inQ = !inQ; }
      else if (ch === ',' && !inQ) { result.push(cur.trim()); cur = ''; }
      else { cur += ch; }
    }
    result.push(cur.trim());
    return result;
  }

  const validGroups = ['U14','U15','U16','U18'];
  let added = 0, skipped = 0, errors = [];

  setStatus('import-csv-status', 'Importing...', true);

  for (let i = 1; i < lines.length; i++) {
    const row = parseCSVLine(lines[i]);
    const fname  = iFirst  >= 0 ? (row[iFirst]  || '').replace(/['"]/g,'').trim() : '';
    const lname  = iLast   >= 0 ? (row[iLast]   || '').replace(/['"]/g,'').trim() : '';
    const dob    = iDob    >= 0 ? (row[iDob]    || '').replace(/['"]/g,'').trim() : '';
    const group  = iGroup  >= 0 ? (row[iGroup]  || '').replace(/['"]/g,'').trim() : '';
    const pos    = iPos    >= 0 ? (row[iPos]    || '').replace(/['"]/g,'').trim() : '';
    const pos2   = iPos2   >= 0 ? (row[iPos2]   || '').replace(/['"]/g,'').trim() : '';
    const email  = iEmail  >= 0 ? (row[iEmail]  || '').replace(/['"]/g,'').trim() : '';
    const pemail = iPEmail >= 0 ? (row[iPEmail] || '').replace(/['"]/g,'').trim() : '';

    if (!fname || !lname) { skipped++; continue; }

    const exists = Object.values(allPlayers).find(p =>
      p.fname.toLowerCase() === fname.toLowerCase() &&
      p.lname.toLowerCase() === lname.toLowerCase()
    );
    if (exists) { skipped++; continue; }

    try {
      await push(ref(db, 'players'), {
        fname, lname, dob,
        group:    validGroups.includes(group) ? group : 'U14',
        pos:      POSITIONS.includes(pos) ? pos : 'CM',
        pos2:     POSITIONS.includes(pos2) ? pos2 : '',
        email, pemail,
        playerPin: generatePlayerPIN()
      });
      added++;
    } catch(err) {
      errors.push(`${fname} ${lname}: ${err.message}`);
    }
  }

  let msg = `${added} player${added !== 1 ? 's' : ''} imported`;
  if (skipped) msg += `, ${skipped} skipped (already exist or blank)`;
  if (errors.length) msg += `. Errors: ${errors.join(', ')}`;
  setStatus('import-csv-status', msg, errors.length === 0);
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
const attendanceState = {}; // pid -> 'present'|'injured'|'absent'|'notselected'

window.setAttendance = function(pid, status, prefix) {
  const current = attendanceState[pid] || 'present';
  // Toggle off if already set
  const newStatus = current === status ? 'present' : status;
  attendanceState[pid] = newStatus;

  const rowId    = prefix === 'tr' ? `row_${pid}`        : `mr_row_${pid}`;
  const injBtnId = prefix === 'tr' ? `att_injured_${pid}` : `mr_att_injured_${pid}`;
  const absBtnId = prefix === 'tr' ? `att_absent_${pid}`  : `mr_att_absent_${pid}`;
  const nsBtnId  = prefix === 'tr' ? `att_ns_${pid}`      : `mr_att_ns_${pid}`;
  const ratingsId = prefix === 'tr' ? `ratings_${pid}`    : `mr_ratings_${pid}`;

  const row     = document.getElementById(rowId);
  const injBtn  = document.getElementById(injBtnId);
  const absBtn  = document.getElementById(absBtnId);
  const nsBtn   = document.getElementById(nsBtnId);
  const ratings = document.getElementById(ratingsId);

  // Reset all button states
  if (injBtn) injBtn.classList.remove('att-active-injured');
  if (absBtn) absBtn.classList.remove('att-active-absent');
  if (nsBtn)  nsBtn.classList.remove('att-active-ns');
  if (row)    row.classList.remove('att-row-injured','att-row-absent','att-row-ns');
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
  } else if (newStatus === 'notselected') {
    if (nsBtn)  nsBtn.classList.add('att-active-ns');
    if (row)    row.classList.add('att-row-ns');
    if (ratings) { ratings.style.opacity = '0.3'; ratings.style.pointerEvents = 'none'; }
  }
};

function resetAttendance() {
  Object.keys(attendanceState).forEach(k => delete attendanceState[k]);
}

function getAttendanceForPlayer(pid) {
  return attendanceState[pid] || 'present';
}

// ── TEAM REVIEW ──────────────────────────────────────────────────
window.renderTeamReview = function() {
  const group  = document.getElementById('tr-review-group').value;
  const output = document.getElementById('tr-review-output');
  if (!group) { output.innerHTML = '<div class="empty-state">Select an age group.</div>'; return; }

  // ── Gather data ───────────────────────────────────────────────
  const players = Object.entries(allPlayers).filter(([id, p]) => p.group === group);
  if (!players.length) { output.innerHTML = '<div class="empty-state">No players found in this group.</div>'; return; }
  const pids = players.map(([id]) => id);

  const trainSessions = Object.values(allTraining)
    .filter(t => t.group === group && t.entries)
    .sort((a, b) => a.date.localeCompare(b.date));

  const matchSessions = Object.values(allMatches)
    .filter(m => m.group === group && m.entries)
    .sort((a, b) => a.date.localeCompare(b.date));

  // ── Helper ────────────────────────────────────────────────────
  const avg = (vals) => {
    const v = vals.map(x => parseFloat(x)).filter(x => !isNaN(x) && x > 0);
    return v.length ? (v.reduce((a,b)=>a+b,0)/v.length) : null;
  };
  const pct = (n, d) => d ? Math.round((n/d)*100) : 0;
  const col = (v) => {
    if (!v) return 'var(--text3)';
    if (v >= 3.5) return '#B8922A';
    if (v >= 2.5) return '#2A8C3F';
    return '#C0272D';
  };
  const bar = (v, max=5) => {
    if (!v) return '';
    const w = Math.round((v/max)*100);
    const bg = v >= 3.5 ? 'linear-gradient(90deg,#8a6a00,#B8922A)' :
               v >= 2.5 ? 'linear-gradient(90deg,#1a5c28,#2A8C3F)' :
                          'linear-gradient(90deg,#e07000,#f09030)';
    return `<div style="height:6px;background:var(--bg3);border-radius:3px;margin-top:4px;">
      <div style="width:${w}%;height:100%;border-radius:3px;background:${bg};"></div></div>`;
  };
  const metricCard = (label, val) => `
    <div style="flex:1;min-width:120px;padding:12px 14px;background:var(--bg2);border-radius:8px;">
      <div style="font-size:11px;color:var(--text3);margin-bottom:4px;text-transform:uppercase;letter-spacing:.05em;">${label}</div>
      <div style="font-size:22px;font-weight:700;color:${col(val)};">${val ? val.toFixed(2) : 'N/A'}</div>
      ${val ? bar(val) : ''}
    </div>`;
  const dnaCard = (label, val) => `
    <div style="flex:1;min-width:110px;padding:12px 14px;background:var(--bg2);border-radius:8px;border-top:3px solid ${col(val)};">
      <div style="font-size:11px;color:var(--text3);margin-bottom:4px;">${label}</div>
      <div style="font-size:20px;font-weight:700;color:${col(val)};">${val ? val.toFixed(2) : 'N/A'}<span style="font-size:12px;color:var(--text3);">/5</span></div>
      ${val ? bar(val) : ''}
    </div>`;

  // ── Attendance ────────────────────────────────────────────────
  const totalSessions = trainSessions.length + matchSessions.length;
  let presentCount = 0, injuredCount = 0, absentCount = 0, nsCount = 0;
  pids.forEach(pid => {
    trainSessions.forEach(t => {
      if (!t.entries[pid]) return;
      const att = t.entries[pid].attendance || 'present';
      if (att === 'present') presentCount++;
      else if (att === 'injured') injuredCount++;
      else if (att === 'absent') absentCount++;
      else if (att === 'notselected') nsCount++;
    });
    matchSessions.forEach(m => {
      if (!m.entries[pid]) return;
      const att = m.entries[pid].attendance || 'present';
      if (att === 'present') presentCount++;
      else if (att === 'injured') injuredCount++;
      else if (att === 'absent') absentCount++;
      else if (att === 'notselected') nsCount++;
    });
  });
  const totalSlots = players.length * totalSessions;
  const countableSlots = totalSlots - nsCount;
  const attPct = pct(presentCount, countableSlots);

  // ── Player attendance table ───────────────────────────────────
  const playerAttRows = players.map(([pid, p]) => {
    let pp=0, ii=0, aa=0, nn=0;
    [...trainSessions, ...matchSessions].forEach(s => {
      if (!s.entries?.[pid]) return;
      const att = s.entries[pid].attendance || 'present';
      if (att==='present') pp++;
      else if (att==='injured') ii++;
      else if (att==='absent') aa++;
      else if (att==='notselected') nn++;
    });
    const countable = totalSessions - nn;
    const playerPct = pct(pp, countable);
    const flagColor = playerPct < 85 ? '#C0272D' : '#2A8C3F';
    return { pid, p, pp, ii, aa, nn, playerPct, flagColor };
  }).sort((a,b) => a.playerPct - b.playerPct);

  // ── Group rating averages ─────────────────────────────────────
  const attitude = avg(trainSessions.flatMap(t =>
    pids.filter(pid => t.entries?.[pid] && (!t.entries[pid].attendance || t.entries[pid].attendance==='present'))
        .map(pid => t.entries[pid].attitude)));
  const communication = avg(trainSessions.flatMap(t =>
    pids.filter(pid => t.entries?.[pid] && (!t.entries[pid].attendance || t.entries[pid].attendance==='present'))
        .map(pid => t.entries[pid].communication)));
  const performance = avg(trainSessions.flatMap(t =>
    pids.filter(pid => t.entries?.[pid] && (!t.entries[pid].attendance || t.entries[pid].attendance==='present'))
        .map(pid => t.entries[pid].performance)));
  const mindset = avg(matchSessions.flatMap(m =>
    pids.filter(pid => m.entries?.[pid] && (!m.entries[pid].attendance || m.entries[pid].attendance==='present'))
        .map(pid => m.entries[pid].mindset)));
  const physical = avg(matchSessions.flatMap(m =>
    pids.filter(pid => m.entries?.[pid] && (!m.entries[pid].attendance || m.entries[pid].attendance==='present'))
        .map(pid => m.entries[pid].physical)));
  const impact = avg(matchSessions.flatMap(m =>
    pids.filter(pid => m.entries?.[pid] && (!m.entries[pid].attendance || m.entries[pid].attendance==='present'))
        .map(pid => m.entries[pid].impact)));

  // ── DNA compliance ────────────────────────────────────────────
  const dnaForward    = avg(matchSessions.map(m => m.dna?.forward));
  const dnaBallspeed  = avg(matchSessions.map(m => m.dna?.ballspeed));
  const dnaFinalthird = avg(matchSessions.map(m => m.dna?.finalthird));
  const dnaPress      = avg(matchSessions.map(m => m.dna?.press));
  const dnaRecovery   = avg(matchSessions.map(m => m.dna?.recovery));

  // Per-match DNA table
  const dnaMatchRows = matchSessions.map(m => {
    const dnaAvg = avg([m.dna?.forward, m.dna?.ballspeed, m.dna?.finalthird, m.dna?.press, m.dna?.recovery]);
    return { date: m.date, opp: m.opposition || 'Unknown', venue: m.venue || '', dna: m.dna, dnaAvg };
  });

  // ── Block coverage ────────────────────────────────────────────
  const blockNames = {
    '1':'Build and Progress','2':'Create and Exploit Space',
    '3':'Final Third Effectiveness','4':'Press and Regain',
    '5':'Defend and Transition','6':'Game Control and Compete'
  };
  const blockCoverage = {};
  [...trainSessions, ...matchSessions].forEach(s => {
    if (s.block) {
      if (!blockCoverage[s.block]) blockCoverage[s.block] = { sessions: 0, cycles: new Set() };
      blockCoverage[s.block].sessions++;
      if (s.cycle) blockCoverage[s.block].cycles.add(s.cycle);
    }
  });

  // ── Player rating table ───────────────────────────────────────
  const playerRatingRows = players.map(([pid, p]) => {
    const trSess = trainSessions.filter(t =>
      t.entries?.[pid] && (!t.entries[pid].attendance || t.entries[pid].attendance==='present'));
    const mtSess = matchSessions.filter(m =>
      m.entries?.[pid] && (!m.entries[pid].attendance || m.entries[pid].attendance==='present'));
    const att  = avg(trSess.map(t => t.entries[pid].attitude));
    const comm = avg(trSess.map(t => t.entries[pid].communication));
    const perf = avg(trSess.map(t => t.entries[pid].performance));
    const mind = avg(mtSess.map(m => m.entries[pid].mindset));
    const phys = avg(mtSess.map(m => m.entries[pid].physical));
    const imp  = avg(mtSess.map(m => m.entries[pid].impact));
    const overall = avg([att,comm,perf,mind,phys,imp].filter(Boolean));
    return { pid, p, att, comm, perf, mind, phys, imp, overall };
  }).sort((a,b) => (b.overall||0)-(a.overall||0));

  const today = new Date().toLocaleDateString('en-GB', { day:'numeric', month:'long', year:'numeric' });

  // ── RENDER ────────────────────────────────────────────────────
  output.innerHTML = `
  <div id="team-review-print" style="font-family:Arial,sans-serif;max-width:900px;">

    <!-- Header -->
    <div style="background:#0f3d1a;color:white;padding:24px 28px;border-radius:10px;margin-bottom:20px;">
      <div style="font-size:11px;color:#B8922A;font-weight:700;letter-spacing:.1em;text-transform:uppercase;margin-bottom:6px;">Bognor Regis Town FC Academy</div>
      <div style="font-size:28px;font-weight:700;margin-bottom:4px;">${group} — Team Review</div>
      <div style="font-size:14px;color:#aaaaaa;">Season to date &bull; Generated ${today} &bull; ${players.length} players &bull; ${trainSessions.length} training sessions &bull; ${matchSessions.length} matches</div>
    </div>

    <!-- Attendance summary -->
    <div style="margin-bottom:20px;">
      <div style="font-size:13px;font-weight:700;color:#0f3d1a;text-transform:uppercase;letter-spacing:.06em;margin-bottom:10px;">Attendance Summary</div>
      <div style="display:flex;gap:12px;flex-wrap:wrap;margin-bottom:14px;">
        <div style="flex:1;min-width:110px;padding:14px;background:var(--bg2);border-radius:8px;border-top:3px solid ${attPct>=85?'#2A8C3F':'#C0272D'};">
          <div style="font-size:11px;color:var(--text3);margin-bottom:4px;">Group attendance</div>
          <div style="font-size:24px;font-weight:700;color:${attPct>=85?'#2A8C3F':'#C0272D'};">${attPct}%</div>
        </div>
        <div style="flex:1;min-width:110px;padding:14px;background:var(--bg2);border-radius:8px;">
          <div style="font-size:11px;color:var(--text3);margin-bottom:4px;">Sessions delivered</div>
          <div style="font-size:24px;font-weight:700;color:var(--text);">${totalSessions}</div>
        </div>
        <div style="flex:1;min-width:110px;padding:14px;background:var(--bg2);border-radius:8px;">
          <div style="font-size:11px;color:var(--text3);margin-bottom:4px;">Injured absences</div>
          <div style="font-size:24px;font-weight:700;color:var(--text);">${injuredCount}</div>
        </div>
        <div style="flex:1;min-width:110px;padding:14px;background:var(--bg2);border-radius:8px;">
          <div style="font-size:11px;color:var(--text3);margin-bottom:4px;">Unexplained absences</div>
          <div style="font-size:24px;font-weight:700;color:${absentCount>0?'#C0272D':'var(--text)'};">${absentCount}</div>
        </div>
      </div>

      <!-- Player attendance table -->
      <table style="width:100%;border-collapse:collapse;font-size:13px;">
        <thead>
          <tr style="background:#0f3d1a;color:white;">
            <th style="padding:8px 10px;text-align:left;font-weight:600;">Player</th>
            <th style="padding:8px 10px;text-align:center;">Present</th>
            <th style="padding:8px 10px;text-align:center;">Injured</th>
            <th style="padding:8px 10px;text-align:center;">Absent</th>
            <th style="padding:8px 10px;text-align:center;">Not Selected</th>
            <th style="padding:8px 10px;text-align:center;">Rate</th>
          </tr>
        </thead>
        <tbody>
          ${playerAttRows.map((r,i) => `
          <tr style="background:${i%2===0?'var(--bg2)':'var(--bg)'};border-bottom:1px solid var(--border);">
            <td style="padding:7px 10px;font-weight:500;">${r.p.fname} ${r.p.lname}</td>
            <td style="padding:7px 10px;text-align:center;">${r.pp}</td>
            <td style="padding:7px 10px;text-align:center;">${r.ii || '-'}</td>
            <td style="padding:7px 10px;text-align:center;color:${r.aa>0?'#C0272D':'inherit'};">${r.aa || '-'}</td>
            <td style="padding:7px 10px;text-align:center;color:var(--text3);">${r.nn || '-'}</td>
            <td style="padding:7px 10px;text-align:center;font-weight:700;color:${r.flagColor};">${r.playerPct}%</td>
          </tr>`).join('')}
        </tbody>
      </table>
    </div>

    <!-- Group rating averages -->
    <div style="margin-bottom:20px;">
      <div style="font-size:13px;font-weight:700;color:#0f3d1a;text-transform:uppercase;letter-spacing:.06em;margin-bottom:10px;">Group Rating Averages — Season to Date</div>
      <div style="margin-bottom:8px;font-size:12px;color:var(--text3);">Training metrics</div>
      <div style="display:flex;gap:10px;flex-wrap:wrap;margin-bottom:14px;">
        ${metricCard('Attitude', attitude)}
        ${metricCard('Communication', communication)}
        ${metricCard('Performance', performance)}
      </div>
      <div style="margin-bottom:8px;font-size:12px;color:var(--text3);">Match metrics</div>
      <div style="display:flex;gap:10px;flex-wrap:wrap;margin-bottom:14px;">
        ${metricCard('Mindset', mindset)}
        ${metricCard('Physical', physical)}
        ${metricCard('Impact', impact)}
      </div>
    </div>

    <!-- Player ratings table -->
    <div style="margin-bottom:20px;">
      <div style="font-size:13px;font-weight:700;color:#0f3d1a;text-transform:uppercase;letter-spacing:.06em;margin-bottom:10px;">Individual Player Ratings</div>
      <table style="width:100%;border-collapse:collapse;font-size:12px;">
        <thead>
          <tr style="background:#0f3d1a;color:white;">
            <th style="padding:8px 10px;text-align:left;">Player</th>
            <th style="padding:8px 10px;text-align:center;">Attitude</th>
            <th style="padding:8px 10px;text-align:center;">Comms</th>
            <th style="padding:8px 10px;text-align:center;">Perf</th>
            <th style="padding:8px 10px;text-align:center;">Mindset</th>
            <th style="padding:8px 10px;text-align:center;">Physical</th>
            <th style="padding:8px 10px;text-align:center;">Impact</th>
            <th style="padding:8px 10px;text-align:center;">Overall</th>
          </tr>
        </thead>
        <tbody>
          ${playerRatingRows.map((r,i) => `
          <tr style="background:${i%2===0?'var(--bg2)':'var(--bg)'};border-bottom:1px solid var(--border);">
            <td style="padding:7px 10px;font-weight:500;">${r.p.fname} ${r.p.lname}</td>
            ${[r.att,r.comm,r.perf,r.mind,r.phys,r.imp].map(v =>
              `<td style="padding:7px 10px;text-align:center;color:${col(v)};font-weight:600;">${v?v.toFixed(2):'-'}</td>`
            ).join('')}
            <td style="padding:7px 10px;text-align:center;font-weight:700;color:${col(r.overall)};">${r.overall?r.overall.toFixed(2):'-'}</td>
          </tr>`).join('')}
        </tbody>
      </table>
    </div>

    <!-- DNA Compliance -->
    <div style="margin-bottom:20px;">
      <div style="font-size:13px;font-weight:700;color:#0f3d1a;text-transform:uppercase;letter-spacing:.06em;margin-bottom:10px;">DNA Compliance — Match Reports (${matchSessions.length} matches)</div>
      ${matchSessions.length ? `
      <div style="display:flex;gap:10px;flex-wrap:wrap;margin-bottom:16px;">
        ${dnaCard('Forward First', dnaForward)}
        ${dnaCard('Ball Speed', dnaBallspeed)}
        ${dnaCard('Final Third', dnaFinalthird)}
        ${dnaCard('Press &amp; Regain', dnaPress)}
        ${dnaCard('Recovery', dnaRecovery)}
      </div>
      <div style="font-size:13px;font-weight:600;color:#0f3d1a;margin-bottom:8px;">Per-match DNA record</div>
      <table style="width:100%;border-collapse:collapse;font-size:12px;">
        <thead>
          <tr style="background:#0f3d1a;color:white;">
            <th style="padding:7px 10px;text-align:left;">Date</th>
            <th style="padding:7px 10px;text-align:left;">Opposition</th>
            <th style="padding:7px 10px;text-align:center;">Forward</th>
            <th style="padding:7px 10px;text-align:center;">Ball Speed</th>
            <th style="padding:7px 10px;text-align:center;">Final Third</th>
            <th style="padding:7px 10px;text-align:center;">Press</th>
            <th style="padding:7px 10px;text-align:center;">Recovery</th>
            <th style="padding:7px 10px;text-align:center;">Avg</th>
          </tr>
        </thead>
        <tbody>
          ${dnaMatchRows.map((r,i) => `
          <tr style="background:${i%2===0?'var(--bg2)':'var(--bg)'};border-bottom:1px solid var(--border);">
            <td style="padding:6px 10px;">${r.date}</td>
            <td style="padding:6px 10px;font-weight:500;">${r.opp} ${r.venue?'('+r.venue+')':''}</td>
            ${['forward','ballspeed','finalthird','press','recovery'].map(k =>
              `<td style="padding:6px 10px;text-align:center;color:${col(r.dna?.[k])};font-weight:600;">${r.dna?.[k]||'-'}</td>`
            ).join('')}
            <td style="padding:6px 10px;text-align:center;font-weight:700;color:${col(r.dnaAvg)};">${r.dnaAvg?r.dnaAvg.toFixed(2):'-'}</td>
          </tr>`).join('')}
        </tbody>
      </table>` : '<div style="color:var(--text3);font-size:13px;">No match reports recorded yet.</div>'}
    </div>

    <!-- Block coverage -->
    <div style="margin-bottom:20px;">
      <div style="font-size:13px;font-weight:700;color:#0f3d1a;text-transform:uppercase;letter-spacing:.06em;margin-bottom:10px;">Block Coverage — Season to Date</div>
      ${Object.keys(blockCoverage).length ? `
      <table style="width:100%;border-collapse:collapse;font-size:13px;">
        <thead>
          <tr style="background:#0f3d1a;color:white;">
            <th style="padding:8px 10px;text-align:left;">Block</th>
            <th style="padding:8px 10px;text-align:center;">Sessions</th>
            <th style="padding:8px 10px;text-align:left;">Cycles delivered</th>
          </tr>
        </thead>
        <tbody>
          ${[1,2,3,4,5,6].map((bn,i) => {
            const bc = blockCoverage[String(bn)];
            if (!bc) return `<tr style="background:${i%2===0?'var(--bg2)':'var(--bg)'};border-bottom:1px solid var(--border);">
              <td style="padding:7px 10px;color:var(--text3);">Block ${bn}: ${blockNames[bn]||''}</td>
              <td style="padding:7px 10px;text-align:center;color:var(--text3);">-</td>
              <td style="padding:7px 10px;color:var(--text3);">Not yet delivered</td></tr>`;
            const cycleLabels = { 'recognition':'C1 Wk1','execution':'C1 Wk2','application':'C1 Wk3','execution+':'C2 Wk1','application2':'C2 Wk2','integration':'C2 Wk3' };
            const cyclesStr = bc.cycles.size ? [...bc.cycles].map(cy => cycleLabels[cy]||cy).join(', ') : 'Cycle not recorded';
            return `<tr style="background:${i%2===0?'var(--bg2)':'var(--bg)'};border-bottom:1px solid var(--border);">
              <td style="padding:7px 10px;font-weight:500;">Block ${bn}: ${blockNames[bn]||''}</td>
              <td style="padding:7px 10px;text-align:center;font-weight:700;color:#0f3d1a;">${bc.sessions}</td>
              <td style="padding:7px 10px;color:var(--text2);">${cyclesStr}</td></tr>`;
          }).join('')}
        </tbody>
      </table>` : '<div style="color:var(--text3);font-size:13px;">No block data recorded yet. Make sure coaches select the block when entering training sessions.</div>'}
    </div>

  </div>`;
};

window.printTeamReview = function() {
  const content = document.getElementById('team-review-print');
  if (!content) return;
  const group = document.getElementById('tr-review-group').value;
  const win = window.open('', '_blank');
  win.document.write(`<!DOCTYPE html><html><head>
    <title>${group} Team Review</title>
    <style>
      body { font-family: Arial, sans-serif; margin: 20px; color: #111; background: white; }
      table { width: 100%; border-collapse: collapse; }
      th, td { padding: 7px 10px; border: 1px solid #e0e0e0; }
      th { background: #0f3d1a; color: white; }
      @media print { body { margin: 0; } }
    </style>
  </head><body>${content.innerHTML}</body></html>`);
  win.document.close();
  win.focus();
  setTimeout(() => { win.print(); }, 500);
};

// ── DATA CLEANUP ─────────────────────────────────────────────────
window.deleteDataBefore = async function() {
  const cutoff = document.getElementById('cleanup-date').value;
  if (!cutoff) { setStatus('cleanup-status', 'Please select a date.', false); return; }

  const confirmed = confirm(
    `This will permanently delete ALL training sessions, match reports, monthly reviews, and goals recorded before ${cutoff}.\n\nPlayers, coaches, and fitness data will NOT be affected.\n\nThis cannot be undone. Are you sure?`
  );
  if (!confirmed) return;

  // Double confirm
  const confirmed2 = confirm('Are you absolutely sure? This data cannot be recovered.');
  if (!confirmed2) return;

  setStatus('cleanup-status', 'Deleting...', true);

  const collections = [
    { path: 'training', dateField: 'date' },
    { path: 'matches',  dateField: 'date' },
    { path: 'monthly',  dateField: 'month' },
    { path: 'goals',    dateField: 'createdAt' },
  ];

  let totalDeleted = 0;
  let errors = [];

  for (const col of collections) {
    try {
      const snap = await get(ref(db, col.path));
      if (!snap.val()) continue;
      const entries = snap.val();
      for (const [key, val] of Object.entries(entries)) {
        // Get the date field — goals use createdAt (ISO string), others use date (YYYY-MM-DD)
        let dateStr = val[col.dateField] || '';
        // Normalise — take first 10 chars (YYYY-MM-DD) from any format
        dateStr = dateStr.slice(0, 10);
        if (dateStr && dateStr < cutoff) {
          await remove(ref(db, `${col.path}/${key}`));
          totalDeleted++;
        }
      }
    } catch(err) {
      errors.push(`${col.path}: ${err.message}`);
    }
  }

  const msg = errors.length
    ? `Deleted ${totalDeleted} records. Errors: ${errors.join(', ')}`
    : `Done. ${totalDeleted} record${totalDeleted !== 1 ? 's' : ''} deleted before ${cutoff}.`;
  setStatus('cleanup-status', msg, errors.length === 0);
};

// ── FITNESS DATA ─────────────────────────────────────────────────
window.saveFitnessData = async function(pid) {
  const sprint10  = document.getElementById('fit-sprint10')?.value || '';
  const sprint30  = document.getElementById('fit-sprint30')?.value || '';
  const yoyo      = document.getElementById('fit-yoyo')?.value || '';
  const cmj       = document.getElementById('fit-cmj')?.value || '';
  const sprint10r = document.getElementById('fit-sprint10-retest')?.value || '';
  const sprint30r = document.getElementById('fit-sprint30-retest')?.value || '';
  const yoyor     = document.getElementById('fit-yoyo-retest')?.value || '';
  const cmjr      = document.getElementById('fit-cmj-retest')?.value || '';
  const season    = document.getElementById('fit-season-sel')?.value || document.getElementById('fit-season')?.value || new Date().getFullYear() + '/' + (new Date().getFullYear()+1);
  if (!pid) { toast('No player selected.'); return; }
  const key = `${pid}_${season.replace('/','_')}`;
  await set(ref(db, `fitness/${key}`), {
    pid, season,
    test:   { sprint10, sprint30, yoyo, cmj },
    retest: { sprint10: sprint10r, sprint30: sprint30r, yoyo: yoyor, cmj: cmjr },
    updatedAt: new Date().toISOString()
  });
  toast('Fitness data saved.');
};

function initFitnessView() {
  const grpSel = document.getElementById('fit-group');
  const groups = coachPhaseGroups ? coachPhaseGroups() : ['U14','U15','U16','U18'];
  if (grpSel) {
    grpSel.innerHTML = '<option value="">Select group...</option>' +
      groups.map(g => `<option>${g}</option>`).join('');
  }
  loadFitnessPlayers();
}

window.loadFitnessPlayers = function() {
  const group = document.getElementById('fit-group')?.value;
  const sel   = document.getElementById('fit-player');
  if (!sel) return;
  sel.innerHTML = '<option value="">Select player...</option>';
  document.getElementById('fit-form-container').innerHTML = '';
  if (!group) return;
  Object.entries(allPlayers)
    .filter(([id, p]) => p.group === group)
    .sort((a, b) => a[1].lname.localeCompare(b[1].lname))
    .forEach(([id, p]) => {
      sel.innerHTML += `<option value="${id}">${p.fname} ${p.lname}</option>`;
    });
};

window.loadFitnessForm = function() {
  const pid    = document.getElementById('fit-player')?.value;
  const season = document.getElementById('fit-season-sel')?.value || (new Date().getFullYear() + '/' + (new Date().getFullYear()+1));
  const container = document.getElementById('fit-form-container');
  if (!container) return;
  if (!pid) { container.innerHTML = ''; return; }
  container.innerHTML = renderFitnessSection(pid, season);
};

function renderFitnessSection(pid, season) {
  season = season || (new Date().getFullYear() + '/' + (new Date().getFullYear()+1));
  const key = `${pid}_${season.replace('/','_')}`;
  const f = allFitness[key] || {};
  const p = allPlayers[pid];
  if (!p) return '<div class="empty-state">Player not found.</div>';
  const isU18 = p.group === 'U18';
  const benchmarks = isU18
    ? { sprint10: '< 1.75s', sprint30: '< 4.10s', yoyo: 'Level 17+ (1120m+)', cmj: '38cm+' }
    : { sprint10: '< 1.85s', sprint30: '< 4.30s', yoyo: 'Level 15+ (800m+)', cmj: '30cm+' };

  const testFields = [
    { id: 'sprint10', label: '10m sprint (best of 3)', unit: 's', bench: benchmarks.sprint10 },
    { id: 'sprint30', label: '30m sprint (best of 3)', unit: 's', bench: benchmarks.sprint30 },
    { id: 'yoyo',     label: 'Yo-Yo Level 1 (level reached)', unit: '', bench: benchmarks.yoyo },
    { id: 'cmj',      label: 'Counter-movement jump', unit: 'cm', bench: benchmarks.cmj }
  ];

  const fieldRow = (prefix, existing) => testFields.map(tf => `
    <div class="form-group">
      <label>${tf.label} ${tf.unit ? '(' + tf.unit + ')' : ''}</label>
      <input type="text" id="fit-${prefix}${tf.id}" value="${existing?.[tf.id] || ''}" placeholder="${tf.bench}">
      <div style="font-size:11px;color:var(--text3);margin-top:2px;">Target: ${tf.bench}</div>
    </div>`).join('');

  return `
    <div class="form-card" style="border-left:4px solid #2A8C3F;">
      <div class="form-section-title">Fitness Testing — ${season}</div>
      <p style="font-size:13px;color:var(--text2);margin-bottom:1rem;">
        Record Week 1 baseline and Week 6 retest. Benchmarks shown are ${isU18 ? 'U18' : 'U14/U15/U16'} targets.
      </p>
      <div style="font-size:13px;font-weight:600;color:var(--text);margin-bottom:10px;">Week 1 — Baseline</div>
      <input type="hidden" id="fit-season" value="${season}">
      <div class="form-row">${fieldRow('', f.test || {})}</div>
      <div style="font-size:13px;font-weight:600;color:var(--text);margin:16px 0 10px;">Week 6 — Retest</div>
      <div class="form-row">${fieldRow('retest-', f.retest || {})}</div>
      ${f.test && f.retest ? `
      <div style="margin-top:14px;padding:12px 14px;background:#e8f5ec;border-radius:6px;">
        <div style="font-size:13px;font-weight:600;color:#0f3d1a;margin-bottom:8px;">Improvement vs baseline</div>
        ${testFields.map(tf => {
          const base = parseFloat(f.test?.[tf.id]);
          const ret  = parseFloat(f.retest?.[tf.id]);
          if (!base || !ret) return '';
          const diff = ret - base;
          const improved = tf.id === 'sprint10' || tf.id === 'sprint30' ? diff < 0 : diff > 0;
          const display = (diff > 0 ? '+' : '') + diff.toFixed(2) + (tf.unit ? tf.unit : '');
          return `<div style="font-size:12px;color:var(--text2);margin-bottom:3px;">${tf.label}: <strong style="color:${improved ? '#2A8C3F' : '#C0272D'};">${display}</strong></div>`;
        }).join('')}
      </div>` : ''}
      <div class="form-actions" style="margin-top:14px;">
        <button class="btn-primary" onclick="saveFitnessData('${pid}')">Save fitness data</button>
      </div>
    </div>`;
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

  const notSelected = allSessions.filter(s => s.entries[pid].attendance === 'notselected').length;
  // Not Selected sessions are excluded from attendance calculation entirely
  const countable   = total - notSelected;
  const present     = allSessions.filter(s => !s.entries[pid].attendance || s.entries[pid].attendance === 'present').length;
  const injured     = allSessions.filter(s => s.entries[pid].attendance === 'injured').length;
  const absent      = allSessions.filter(s => s.entries[pid].attendance === 'absent').length;
  const pct         = countable > 0 ? Math.round((present / countable) * 100) : 100;

  return { total, countable, present, injured, absent, notSelected, pct };
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
    1: { start: `${y-1}-08-01`, end: `${y-1}-10-31` },
    2: { start: `${y-1}-11-01`, end: `${y}-01-31` },
    3: { start: `${y}-02-01`, end: `${y}-04-30` }
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

// ── SQUAD INSIGHTS ────────────────────────────────────────────────
window.renderInsights = function() {
  const termNo  = parseInt(document.getElementById('ins-term')?.value || 1);
  const grpFilter = document.getElementById('ins-group')?.value || 'all';
  const termRange = getTermRange(termNo);

  const GROUPS = ['U14','U15','U16','U18'];
  const filteredGroups = grpFilter === 'all' ? GROUPS : [grpFilter];

  const termTraining = Object.values(allTraining).filter(t => inTermRange(t.date, termRange));
  const termMatches  = Object.values(allMatches).filter(m => inTermRange(m.date, termRange));

  const filteredPlayers = Object.entries(allPlayers)
    .filter(([id,p]) => filteredGroups.includes(p.group))
    .sort((a,b) => a[1].group.localeCompare(b[1].group) || a[1].lname.localeCompare(b[1].lname));

  renderHeatmap(filteredPlayers, termTraining, termMatches);
  renderDNATrend(termMatches, filteredGroups);
  renderBlockImpact(termTraining, filteredPlayers);
  renderCohortComparison(termTraining, termMatches);
};

// ── 1. ATTRIBUTE HEATMAP ──────────────────────────────────────────
function renderHeatmap(players, termTraining, termMatches) {
  const el = document.getElementById('ins-heatmap');
  if (!players.length) { el.innerHTML = '<div class="empty-state">No players found.</div>'; return; }

  const TRAIN_ATTRS = [
    { key: 'attitude',      label: 'Attitude' },
    { key: 'communication', label: 'Comm.' },
    { key: 'performance',   label: 'Perf.' }
  ];
  const MATCH_ATTRS = [
    { key: 'mindset',  label: 'Mindset' },
    { key: 'physical', label: 'Physical' },
    { key: 'impact',   label: 'Impact' }
  ];

  const heatColour = v => {
    if (!v || isNaN(v)) return 'var(--bg3)';
    const n = parseFloat(v);
    if (n > 3.5)  return 'linear-gradient(135deg,#8a6a00,#B8922A)';
    if (n >= 2.5) return 'linear-gradient(135deg,#1a5c28,#2A8C3F)';
    return 'linear-gradient(135deg,#e07000,#c05000)';
  };

  const heatText = v => {
    if (!v || isNaN(v)) return '';
    return parseFloat(v).toFixed(1);
  };

  const headers = ['Player', 'Grp', ...TRAIN_ATTRS.map(a => a.label), ...MATCH_ATTRS.map(a => a.label)];

  let html = `<div style="overflow-x:auto;">
    <table class="heatmap-table">
      <thead><tr>${headers.map(h => `<th>${h}</th>`).join('')}</tr></thead>
      <tbody>`;

  players.forEach(([pid, p]) => {
    const pt = termTraining.filter(t => t.entries?.[pid] && (!t.entries[pid].attendance || t.entries[pid].attendance === 'present'));
    const pm = termMatches.filter(m => m.entries?.[pid] && (!m.entries[pid].attendance || m.entries[pid].attendance === 'present'));

    const tVals = TRAIN_ATTRS.map(a => calcAvg(pt.map(t => t.entries[pid][a.key])));
    const mVals = MATCH_ATTRS.map(a => calcAvg(pm.map(m => m.entries[pid][a.key])));
    const allVals = [...tVals, ...mVals].map(v => parseFloat(v)).filter(v => !isNaN(v) && v > 0);
    const rowAvg = allVals.length ? (allVals.reduce((a,b)=>a+b,0)/allVals.length).toFixed(1) : null;

    html += `<tr>
      <td class="heatmap-name">${p.fname[0]}. ${p.lname}</td>
      <td><span class="badge badge-group" style="font-size:10px;">${p.group}</span></td>
      ${[...tVals, ...mVals].map(v => `
        <td>
          <div class="heat-cell" style="background:${heatColour(v)};">
            ${heatText(v)}
          </div>
        </td>
      `).join('')}
    </tr>`;
  });

  html += `</tbody></table></div>`;

  // Add legend
  html += `<div class="heatmap-legend">
    <span><span class="heat-legend-dot" style="background:linear-gradient(135deg,#e07000,#c05000);"></span>Below 2.5</span>
    <span><span class="heat-legend-dot" style="background:linear-gradient(135deg,#1a5c28,#2A8C3F);"></span>2.5 to 3.5</span>
    <span><span class="heat-legend-dot" style="background:linear-gradient(135deg,#8a6a00,#B8922A);"></span>Above 3.5</span>
    <span><span class="heat-legend-dot" style="background:var(--bg3);"></span>No data</span>
  </div>`;

  el.innerHTML = html;
}

// ── 2. DNA TREND LINE ─────────────────────────────────────────────
function renderDNATrend(termMatches, filteredGroups) {
  const el = document.getElementById('ins-dna-trend');

  const matches = termMatches
    .filter(m => filteredGroups.includes(m.group))
    .sort((a,b) => a.date.localeCompare(b.date));

  if (!matches.length) {
    el.innerHTML = '<div class="empty-state">No match data for this term yet.</div>';
    return;
  }

  const DNA_KEYS = [
    { key: 'forward',    label: 'Forward first',   colour: '#2A8C3F' },
    { key: 'ballspeed',  label: 'High ball speed',  colour: '#B8922A' },
    { key: 'finalthird', label: 'Final third',      colour: '#185fa5' },
    { key: 'press',      label: 'Pressing',         colour: '#C0272D' },
    { key: 'recovery',   label: 'Recovery',         colour: '#7b2d8b' }
  ];

  // Build trend chart using SVG
  const W = 600, H = 200, PAD = 40;
  const xStep = matches.length > 1 ? (W - PAD * 2) / (matches.length - 1) : W - PAD * 2;

  const valY = (v) => PAD + (H - PAD * 2) * (1 - (v - 1) / 4);

  let svg = `<svg viewBox="0 0 ${W} ${H + 20}" style="width:100%;max-width:${W}px;" xmlns="http://www.w3.org/2000/svg">`;

  // Grid lines
  for (let i = 1; i <= 5; i++) {
    const y = valY(i);
    svg += `<line x1="${PAD}" y1="${y}" x2="${W - PAD}" y2="${y}" stroke="var(--border)" stroke-width="1"/>`;
    svg += `<text x="${PAD - 6}" y="${y + 4}" text-anchor="end" font-size="10" fill="var(--text3)">${i}</text>`;
  }

  // X axis labels
  matches.forEach((m, i) => {
    const x = PAD + i * xStep;
    const label = m.date ? m.date.slice(5) : '';
    svg += `<text x="${x}" y="${H + 14}" text-anchor="middle" font-size="9" fill="var(--text3)">${label}</text>`;
  });

  // Lines per DNA key
  DNA_KEYS.forEach(dk => {
    const points = matches.map((m, i) => {
      const v = parseFloat(m.dna?.[dk.key]);
      if (isNaN(v)) return null;
      return { x: PAD + i * xStep, y: valY(v), v };
    });

    // Draw line
    const validPoints = points.filter(Boolean);
    if (validPoints.length > 1) {
      const d = validPoints.map((pt, i) => `${i === 0 ? 'M' : 'L'} ${pt.x} ${pt.y}`).join(' ');
      svg += `<path d="${d}" fill="none" stroke="${dk.colour}" stroke-width="2" stroke-linejoin="round"/>`;
    }

    // Draw dots
    validPoints.forEach(pt => {
      svg += `<circle cx="${pt.x}" cy="${pt.y}" r="4" fill="${dk.colour}"/>`;
      svg += `<title>${dk.label}: ${pt.v}</title>`;
    });
  });

  svg += `</svg>`;

  // Legend
  const legend = DNA_KEYS.map(dk =>
    `<span style="display:flex;align-items:center;gap:5px;font-size:12px;color:var(--text2);">
      <span style="width:16px;height:3px;border-radius:99px;background:${dk.colour};display:inline-block;flex-shrink:0;"></span>
      ${dk.label}
    </span>`
  ).join('');

  el.innerHTML = `${svg}<div style="display:flex;gap:14px;flex-wrap:wrap;margin-top:10px;">${legend}</div>`;
}

// ── 3. BLOCK IMPACT ───────────────────────────────────────────────
function renderBlockImpact(termTraining, filteredPlayers) {
  const el = document.getElementById('ins-block-impact');

  const BLOCK_LABELS = {
    '1':'Build and Progress','2':'Create and Exploit','3':'Final Third',
    '4':'Press and Regain','5':'Defend and Transition','6':'Game Control'
  };

  const blockData = {};
  Object.keys(BLOCK_LABELS).forEach(b => { blockData[b] = []; });

  const pids = new Set(filteredPlayers.map(([id]) => id));

  termTraining.forEach(t => {
    if (!t.block || !BLOCK_LABELS[t.block]) return;
    Object.entries(t.entries || {}).forEach(([pid, e]) => {
      if (!pids.has(pid)) return;
      if (e.attendance && e.attendance !== 'present') return;
      const vals = [e.attitude, e.communication, e.performance]
        .map(v => parseFloat(v)).filter(v => !isNaN(v) && v > 0);
      if (vals.length) blockData[t.block].push(vals.reduce((a,b)=>a+b,0)/vals.length);
    });
  });

  const hasAny = Object.values(blockData).some(v => v.length > 0);
  if (!hasAny) {
    el.innerHTML = '<div class="empty-state">No training data with blocks assigned yet.</div>';
    return;
  }

  el.innerHTML = `<div class="block-impact-grid">
    ${Object.entries(BLOCK_LABELS).map(([b, label]) => {
      const vals = blockData[b];
      const avg = vals.length ? (vals.reduce((a,b2)=>a+b2,0)/vals.length) : null;
      const pct = avg ? Math.round((avg/5)*100) : 0;
      const colour = avg > 3.5 ? 'linear-gradient(90deg,#8a6a00,#B8922A)' : avg >= 2.5 ? 'linear-gradient(90deg,#1a5c28,#2A8C3F)' : avg ? 'linear-gradient(90deg,#e07000,#c05000)' : 'var(--bg3)';
      return `<div class="block-impact-item">
        <div class="block-impact-num">Block ${b}</div>
        <div class="block-impact-label">${label}</div>
        <div class="block-impact-bar-track">
          <div class="block-impact-bar-fill" style="width:${pct}%;background:${colour};"></div>
        </div>
        <div class="block-impact-avg">${avg ? avg.toFixed(1) + '/5' : 'No data'}</div>
        <div class="block-impact-sessions">${vals.length} rating${vals.length!==1?'s':''}</div>
      </div>`;
    }).join('')}
  </div>`;
}

// ── 4. COHORT COMPARISON ──────────────────────────────────────────
function renderCohortComparison(termTraining, termMatches) {
  const el = document.getElementById('ins-cohort');

  const phases = [
    { label: 'Phase 1', groups: ['U14','U15'], colour: '#185fa5' },
    { label: 'Phase 2', groups: ['U16','U18'], colour: '#2A8C3F' }
  ];

  const METRICS = [
    { label: 'Attitude',         type: 'train', key: 'attitude' },
    { label: 'Communication',    type: 'train', key: 'communication' },
    { label: 'Performance',      type: 'train', key: 'performance' },
    { label: 'Mindset',          type: 'match', key: 'mindset' },
    { label: 'Physical',         type: 'match', key: 'physical' },
    { label: 'Impact',           type: 'match', key: 'impact' }
  ];

  const getPhaseAvg = (phase, metric) => {
    const phasePids = new Set(
      Object.entries(allPlayers)
        .filter(([id,p]) => phase.groups.includes(p.group))
        .map(([id]) => id)
    );
    const sessions = metric.type === 'train' ? termTraining : termMatches;
    const vals = sessions.flatMap(s =>
      Object.entries(s.entries || {})
        .filter(([pid, e]) => phasePids.has(pid) && (!e.attendance || e.attendance === 'present'))
        .map(([pid, e]) => parseFloat(e[metric.key]))
        .filter(v => !isNaN(v) && v > 0)
    );
    return vals.length ? (vals.reduce((a,b)=>a+b,0)/vals.length) : null;
  };

  el.innerHTML = `<div style="overflow-x:auto;">
    <table class="cohort-table">
      <thead>
        <tr>
          <th>Metric</th>
          ${phases.map(ph => `<th style="color:${ph.colour};">${ph.label}</th>`).join('')}
          <th>Gap</th>
        </tr>
      </thead>
      <tbody>
        ${METRICS.map(m => {
          const avgs = phases.map(ph => getPhaseAvg(ph, m));
          const gap = avgs[0] && avgs[1] ? Math.abs(avgs[0] - avgs[1]).toFixed(1) : null;
          const gapCol = gap > 0.5 ? 'var(--red)' : gap > 0.2 ? 'var(--amber)' : 'var(--green)';
          return `<tr>
            <td style="font-weight:600;font-size:13px;">${m.label}</td>
            ${avgs.map((v,i) => `<td>
              <div style="display:flex;align-items:center;gap:8px;">
                <div style="flex:1;height:6px;background:var(--bg3);border-radius:99px;overflow:hidden;">
                  <div style="height:100%;width:${v ? Math.round((v/5)*100) : 0}%;background:${phases[i].colour};border-radius:99px;"></div>
                </div>
                <span style="font-size:12px;font-weight:600;width:28px;">${v ? v.toFixed(1) : '-'}</span>
              </div>
            </td>`).join('')}
            <td style="font-size:12px;font-weight:600;color:${gapCol};">${gap ? gap : '-'}</td>
          </tr>`;
        }).join('')}
      </tbody>
    </table>
  </div>
  <div style="font-size:12px;color:var(--text3);margin-top:8px;">Gap colour: green = small difference, amber = notable, red = significant gap between phases.</div>`;
}

// ── POTENTIAL ASSESSMENT ──────────────────────────────────────────
const POT_LEVELS = {
  1: { label: 'County 1 / 2',    colour: '#9b9a96', bg: '#f0efea' },
  2: { label: 'County Premier',  colour: '#185fa5', bg: '#e6f1fb' },
  3: { label: 'Step 4',          colour: '#2A8C3F', bg: '#e8f5ec' },
  4: { label: 'Step 3 or above', colour: '#B8922A', bg: '#faf0dc' }
};

function initPotentialView() {
  // Populate season selector - current year back to 2024
  const sel = document.getElementById('pot-season');
  if (sel && !sel.options.length) {
    const y = new Date().getFullYear();
    for (let i = y; i >= 2024; i--) {
      sel.innerHTML += `<option value="${i}/${i+1}">${i}/${i+1}</option>`;
    }
  }
  loadPotentialPlayers();
  renderPotentialHistory();
  document.getElementById('pot-history-card').style.display = 'block';
}

window.loadPotentialPlayers = function() {
  const group  = document.getElementById('pot-group')?.value;
  const season = document.getElementById('pot-season')?.value;
  const list   = document.getElementById('pot-players-list');
  if (!group) { list.innerHTML = ''; return; }

  const players = Object.entries(allPlayers)
    .filter(([id,p]) => p.group === group)
    .sort((a,b) => a[1].lname.localeCompare(b[1].lname));

  if (!players.length) {
    list.innerHTML = '<div class="empty-state">No players in this group.</div>';
    return;
  }

  list.innerHTML = players.map(([pid, p]) => {
    const existing = allPotential[`${pid}_${season?.replace('/','_')}`];
    const currentLevel = existing?.level || 0;
    const age = p.dob ? calcAge(p.dob) : 'N/A';

    return `<div class="pot-player-card" id="pot_card_${pid}">
      <div class="pot-player-header">
        <div class="player-avatar" style="width:40px;height:40px;font-size:13px;">${initials(p)}</div>
        <div style="flex:1;">
          <div style="font-size:15px;font-weight:600;">${p.fname} ${p.lname}</div>
          <div style="font-size:12px;color:var(--text2);">${p.group} &bull; ${p.pos} &bull; Age ${age}</div>
        </div>
        ${currentLevel ? `<div class="pot-current-badge" style="background:${POT_LEVELS[currentLevel].bg};color:${POT_LEVELS[currentLevel].colour};">${POT_LEVELS[currentLevel].label}</div>` : '<div style="font-size:12px;color:var(--text3);">Not assessed</div>'}
      </div>
      <div class="pot-level-selector">
        ${[1,2,3,4].map(level => `
          <button class="pot-level-btn ${currentLevel === level ? 'active' : ''}"
            style="${currentLevel === level ? `background:${POT_LEVELS[level].bg};border-color:${POT_LEVELS[level].colour};color:${POT_LEVELS[level].colour};` : ''}"
            onclick="setPotentialLevel('${pid}', ${level}, '${season}')">
            <span class="pot-level-num">${level}</span>
            <span class="pot-level-label">${POT_LEVELS[level].label}</span>
          </button>
        `).join('')}
      </div>
      ${existing?.notes !== undefined ? `<div style="margin-top:10px;">
        <textarea class="pot-notes" id="pot_notes_${pid}" placeholder="Optional notes (coach only, never shown to player)..." rows="2">${existing.notes || ''}</textarea>
        <button class="btn-secondary" style="font-size:12px;padding:6px 14px;margin-top:6px;" onclick="savePotentialNotes('${pid}','${season}')">Save notes</button>
      </div>` : `<div style="margin-top:8px;">
        <button class="btn-secondary" style="font-size:12px;padding:6px 14px;" onclick="showPotentialNotes('${pid}')">+ Add notes</button>
      </div>`}
    </div>`;
  }).join('');
};

window.setPotentialLevel = async function(pid, level, season) {
  if (!season) { toast('Select a season first.'); return; }
  const key = `${pid}_${season.replace('/','_')}`;
  const existing = allPotential[key] || {};
  await set(ref(db, `potential/${key}`), {
    pid, season, level,
    notes:    existing.notes || '',
    assessedBy: currentCoach.name,
    assessedAt: new Date().toISOString(),
    group: allPlayers[pid]?.group || ''
  });
  toast(`${allPlayers[pid]?.fname} assessed as ${POT_LEVELS[level].label}`);
  loadPotentialPlayers();
  renderPotentialHistory();
};

window.showPotentialNotes = function(pid) {
  const card = document.getElementById(`pot_card_${pid}`);
  if (!card) return;
  const btn = card.querySelector('.btn-secondary');
  if (btn) btn.parentElement.innerHTML = `
    <textarea class="pot-notes" id="pot_notes_${pid}" placeholder="Optional notes (coach only, never shown to player)..." rows="2"></textarea>
    <button class="btn-secondary" style="font-size:12px;padding:6px 14px;margin-top:6px;" onclick="savePotentialNotes('${pid}', document.getElementById('pot-season').value)">Save notes</button>
  `;
};

window.savePotentialNotes = async function(pid, season) {
  if (!season) return;
  const key   = `${pid}_${season.replace('/','_')}`;
  const notes = document.getElementById(`pot_notes_${pid}`)?.value.trim() || '';
  const existing = allPotential[key];
  if (!existing) { toast('Set a potential level first.'); return; }
  await update(ref(db, `potential/${key}`), { notes });
  toast('Notes saved.');
};

window.renderPotentialHistory = function() {
  const grpFilter = document.getElementById('pot-history-group')?.value || 'all';
  const el = document.getElementById('pot-history-table');
  if (!el) return;

  const entries = Object.values(allPotential)
    .filter(e => grpFilter === 'all' || e.group === grpFilter)
    .sort((a,b) => {
      const pa = allPlayers[a.pid]?.lname || '';
      const pb = allPlayers[b.pid]?.lname || '';
      return pa.localeCompare(pb) || b.season?.localeCompare(a.season||'');
    });

  if (!entries.length) {
    el.innerHTML = '<div style="font-size:13px;color:var(--text3);">No assessments recorded yet.</div>';
    return;
  }

  // Group by player
  const byPlayer = {};
  entries.forEach(e => {
    if (!byPlayer[e.pid]) byPlayer[e.pid] = [];
    byPlayer[e.pid].push(e);
  });

  el.innerHTML = `<div style="overflow-x:auto;">
    <table class="player-table">
      <thead><tr>
        <th>Player</th>
        <th>Group</th>
        <th>Season</th>
        <th>Assessment</th>
        <th>Assessed by</th>
        <th>Notes</th>
      </tr></thead>
      <tbody>
        ${Object.entries(byPlayer).flatMap(([pid, seasons]) => {
          const p = allPlayers[pid];
          return seasons.map((e, i) => `<tr>
            ${i === 0 ? `<td rowspan="${seasons.length}" style="font-weight:600;vertical-align:top;padding-top:10px;">${p ? p.fname+' '+p.lname : 'Unknown'}</td>
            <td rowspan="${seasons.length}" style="vertical-align:top;padding-top:10px;"><span class="badge badge-group">${p?.group||''}</span></td>` : ''}
            <td style="font-weight:500;">${e.season||'N/A'}</td>
            <td>
              ${e.level ? `<span style="display:inline-block;padding:3px 10px;border-radius:999px;font-size:12px;font-weight:600;background:${POT_LEVELS[e.level].bg};color:${POT_LEVELS[e.level].colour};">${POT_LEVELS[e.level].label}</span>` : '<span style="color:var(--text3);font-size:12px;">Not set</span>'}
            </td>
            <td style="font-size:12px;color:var(--text2);">${e.assessedBy||'Unknown'}</td>
            <td style="font-size:12px;color:var(--text2);max-width:180px;">${e.notes||''}</td>
          </tr>`);
        }).join('')}
      </tbody>
    </table>
  </div>`;
};

// ── PIN MANAGEMENT ────────────────────────────────────────────────
window.renderPINSheet = function() {
  const grp = document.getElementById('pin-filter-group')?.value || 'all';
  const el  = document.getElementById('pin-sheet-list');
  if (!el) return;

  const sorted = Object.entries(allPlayers)
    .filter(([id,p]) => grp === 'all' || p.group === grp)
    .sort((a,b) => a[1].group.localeCompare(b[1].group) || a[1].lname.localeCompare(b[1].lname));

  if (!sorted.length) { el.innerHTML = '<div class="empty-state">No players found.</div>'; return; }

  el.innerHTML = `<div id="printable-pin-sheet">
    <div class="pin-sheet-header">
      <img src="images/crest.png" alt="BRTFC" style="width:40px;height:40px;object-fit:contain;">
      <div>
        <div style="font-size:15px;font-weight:700;">BRTFC Academy — Player Portal PINs</div>
        <div style="font-size:12px;color:var(--text2);">Confidential. Share with players and parents only.</div>
      </div>
    </div>
    <table class="pin-table">
      <thead><tr><th>Player</th><th>Group</th><th>DOB</th><th>PIN</th><th>Portal</th></tr></thead>
      <tbody>
        ${sorted.map(([id,p]) => `<tr>
          <td style="font-weight:600;">${p.fname} ${p.lname}</td>
          <td><span class="badge badge-group">${p.group}</span></td>
          <td style="font-family:monospace;">${p.dob||'N/A'}</td>
          <td><span style="font-family:monospace;font-weight:800;font-size:15px;letter-spacing:0.15em;color:var(--green-dark);">${p.playerPin||'—'}</span></td>
          <td style="font-size:11px;color:var(--text3);">player.html</td>
        </tr>`).join('')}
      </tbody>
    </table>
    <div style="font-size:11px;color:var(--text3);margin-top:12px;text-align:center;">Login: Enter date of birth + PIN at the player portal. Keep your PIN private.</div>
  </div>`;
};

window.printPINSheet = function() {
  renderPINSheet();
  setTimeout(() => window.print(), 400);
};

window.sendAllWelcomeEmails = function() {
  const grp = document.getElementById('pin-filter-group')?.value || 'all';
  const players = Object.entries(allPlayers)
    .filter(([id,p]) => (grp==='all'||p.group===grp) && (p.email||p.pemail))
    .sort((a,b) => a[1].lname.localeCompare(b[1].lname));

  if (!players.length) { setStatus('pin-status','No players with email addresses found.',false); return; }

  let i = 0;
  const sendNext = () => {
    if (i >= players.length) {
      setStatus('pin-status', `${players.length} welcome email${players.length!==1?'s':''} opened.`, true);
      return;
    }
    setStatus('pin-status', `Opening email ${i+1} of ${players.length}...`, true);
    sendWelcomeEmail(players[i][0]);
    i++;
    setTimeout(sendNext, 1500);
  };
  sendNext();
};

window.regenerateAllPINs = async function() {
  const grp = document.getElementById('pin-filter-group')?.value || 'all';
  if (!confirm(`Regenerate PINs for ${grp === 'all' ? 'all players' : grp}? Players will need to be told their new PINs.`)) return;
  const players = Object.entries(allPlayers)
    .filter(([id,p]) => grp==='all'||p.group===grp);
  for (const [id] of players) {
    await update(ref(db, `players/${id}`), { playerPin: generatePlayerPIN() });
  }
  toast(`${players.length} PINs regenerated.`);
  renderPINSheet();
  renderAdminPlayers();
};

// Wire PIN tab switch
const _origSwitchAdmin = window.switchAdminTab;
