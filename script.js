let finalCandidates = {};
let finalRoles      = {};
let rawAuditLog     = [];

function handleFile(type, input) {
  const file = input.files[0];
  if (!file) return;
  const el = document.getElementById(type === 'cand' ? 'candFileName' : 'roleFileName');
  el.textContent = file.name;
  el.classList.add('loaded');
}

function parseFile(file) {
  return new Promise((res, rej) => {
    Papa.parse(file, {
      header: true, skipEmptyLines: true,
      complete: r => res(r.data),
      error:    e => rej(e.message)
    });
  });
}

function resetEngine() {
  ['candidatesCsv','rolesCsv'].forEach(id => document.getElementById(id).value = '');
  ['candFileName','roleFileName'].forEach(id => {
    document.getElementById(id).textContent = 'Choose file…';
    document.getElementById(id).classList.remove('loaded');
  });
  document.getElementById('resultsCard').style.display    = 'none';
  document.getElementById('logWrap').style.display        = 'none';
  document.getElementById('errorMessage').style.display   = 'none';
  document.getElementById('warningMessage').style.display = 'none';
  finalCandidates = {}; finalRoles = {}; rawAuditLog = [];
}

function addLog(html, plain, cls) {
  const el  = document.getElementById('auditLog');
  const div = document.createElement('div');
  if (cls) div.className = cls;
  div.innerHTML = html;
  el.appendChild(div);
  rawAuditLog.push(plain);
  el.scrollTop = el.scrollHeight;
}

async function runAlgorithm() {
  const runBtn  = document.getElementById('runBtn');
  const errDiv  = document.getElementById('errorMessage');
  const warnDiv = document.getElementById('warningMessage');

  runBtn.disabled = true;
  runBtn.innerHTML = '<div class="spinner"></div> Running…';
  errDiv.style.display = warnDiv.style.display = 'none';
  warnDiv.innerHTML = '';
  document.getElementById('auditLog').innerHTML = '';
  document.getElementById('logWrap').style.display = 'block';
  rawAuditLog = [];

  const candFile = document.getElementById('candidatesCsv').files[0];
  const roleFile = document.getElementById('rolesCsv').files[0];

  if (!candFile || !roleFile) {
    errDiv.textContent = 'Please upload both CSV files before running.';
    errDiv.style.display = 'block';
    runBtn.disabled = false;
    runBtn.textContent = 'Run Algorithm';
    return;
  }

  try {
    const [candData, roleData] = await Promise.all([parseFile(candFile), parseFile(roleFile)]);
    executeGaleShapley(candData, roleData, warnDiv);
  } catch (err) {
    errDiv.textContent = 'Parse error: ' + err;
    errDiv.style.display = 'block';
  }

  runBtn.disabled = false;
  runBtn.textContent = 'Run Algorithm';
}

function executeGaleShapley(candData, roleData, warnDiv) {
  let candidates = {};
  let roles      = {};
  let warnings   = [];

  // Parse Candidates
  candData.forEach(row => {
    const keys  = Object.keys(row);
    const idKey = keys.find(k => /candidateid|^id$/i.test(k.trim()));
    if (!idKey || !row[idKey]) return;
    const id = row[idKey].trim().toUpperCase();

    const nameKey = keys.find(k => /^name$|candidatename|fullname/i.test(k.trim()));
    let name = nameKey ? row[nameKey].trim() : '';
    if (!name) {
      const fn = keys.find(k => /firstname/i.test(k.trim()));
      const ln = keys.find(k => /lastname/i.test(k.trim()));
      name = [fn && row[fn], ln && row[ln]].filter(Boolean).join(' ') || id;
    }

    const prefs = keys
      .filter(k => /^pref\d*/i.test(k.trim()) && row[k])
      .sort((a, b) => parseInt(a.replace(/\D/g,'')) - parseInt(b.replace(/\D/g,'')))
      .map(k => row[k].trim().toUpperCase());

    const gradeKey = keys.find(k => /grade/i.test(k.trim()));

    candidates[id] = {
      id, 
      name, 
      preferences: prefs,
      grade: gradeKey ? row[gradeKey].trim() : '',
      currentMatch: null,
      proposedIndex: 0 // Track how far down their list the candidate has gone
    };
  });

  // Parse Roles
  roleData.forEach(row => {
    const keys  = Object.keys(row);
    const idKey = keys.find(k => /roleid|^id$/i.test(k.trim()));
    if (!idKey || !row[idKey]) return;
    const id = row[idKey].trim().toUpperCase();

    const nameKey = keys.find(k => /rolename|name/i.test(k.trim()));
    const name    = nameKey ? row[nameKey].trim() : id;

    const seatKey = keys.find(k => /seat/i.test(k.trim()));
    let seats     = seatKey ? parseInt(row[seatKey]) : 1;
    if (isNaN(seats) || seats < 1) seats = 1;

    const rankings = keys
      .filter(k => /^rank\d+$/i.test(k.trim()) && row[k])
      .sort((a, b) => parseInt(a.replace(/\D/g,'')) - parseInt(b.replace(/\D/g,'')))
      .map(k => row[k].trim().toUpperCase());

    const divKey  = keys.find(k => /division/i.test(k.trim()));
    const tierKey = keys.find(k => /tier/i.test(k.trim()));

    if (rankings.length < seats) {
      warnings.push(`<strong>${id} — ${name}</strong>: needs ${seats} seat(s) but only ${rankings.length} candidate(s) ranked.`);
    }

    roles[id] = {
      id, name, seats, rankings,
      division:      divKey  ? row[divKey].trim()  : '',
      tier:          tierKey ? row[tierKey].trim()  : '',
      matches:       [] // Array of candidate IDs currently holding a seat
    };
  });

  if (!Object.keys(candidates).length) {
    document.getElementById('errorMessage').textContent = 'No candidates found. Check your CSV headers.';
    document.getElementById('errorMessage').style.display = 'block';
    return;
  }
  if (!Object.keys(roles).length) {
    document.getElementById('errorMessage').textContent = 'No roles found. Check your CSV headers.';
    document.getElementById('errorMessage').style.display = 'block';
    return;
  }

  if (warnings.length) {
    warnDiv.innerHTML = '<strong>Warnings:</strong><ul>' + warnings.map(w => `<li>${w}</li>`).join('') + '</ul>';
    warnDiv.style.display = 'block';
  }

  // ALGORITHM LOGIC: Candidate-Proposing Gale-Shapley
  let isRunning = true;
  let round = 1;

  while (isRunning && round < 5000) {
    // Find all candidates who are unmatched AND still have booths on their list to ask
    const activeCandidates = Object.values(candidates).filter(
      c => !c.currentMatch && c.proposedIndex < c.preferences.length
    );
    
    if (!activeCandidates.length) {
      isRunning = false;
      break;
    }

    addLog(`<span class="log-round">── Round ${round}</span>`, `\n── Round ${round}`, 'log-round');

    for (const cand of activeCandidates) {
      const roleId = cand.preferences[cand.proposedIndex++];
      const role = roles[roleId];

      if (!role) {
        addLog(`${cand.name} → ${roleId}`, `${cand.name} -> ${roleId}`);
        addLog(`&nbsp;&nbsp;<span class="log-reject">✗ rejected (Booth ID not found)</span>`, `  rejected`, 'log-reject');
        continue;
      }

      addLog(`${cand.name} → ${role.name}`, `${cand.name} -> ${role.name}`);

      // Check if the role actually ranked this candidate. If not, auto-reject.
      const candRankInRole = role.rankings.indexOf(cand.id);
      if (candRankInRole === -1) {
        addLog(`&nbsp;&nbsp;<span class="log-reject">✗ rejected (Candidate not ranked by booth)</span>`, `  rejected`, 'log-reject');
        continue;
      }

      // If the booth has open seats, tentatively accept the candidate
      if (role.matches.length < role.seats) {
        cand.currentMatch = role.id;
        role.matches.push(cand.id);
        addLog(`&nbsp;&nbsp;<span class="log-accept">✓ accepted</span>`, `  accepted`, 'log-accept');
      } else {
        // Booth is full. Find the *least* preferred candidate currently holding a seat.
        // Higher index in role.rankings = worse preference.
        let worstCandId = null;
        let worstRank = -1;
        let worstIndexInMatches = -1;

        for (let i = 0; i < role.matches.length; i++) {
          const matchedCandId = role.matches[i];
          const rank = role.rankings.indexOf(matchedCandId);
          if (rank > worstRank) {
            worstRank = rank;
            worstCandId = matchedCandId;
            worstIndexInMatches = i;
          }
        }

        // Compare the new applicant to the worst current hold
        if (candRankInRole < worstRank) {
          // The new applicant is better! Dump the old one.
          const dumpedCand = candidates[worstCandId];
          dumpedCand.currentMatch = null; // Sent back to the active pool for the next round
          
          role.matches[worstIndexInMatches] = cand.id;
          cand.currentMatch = role.id;
          addLog(`&nbsp;&nbsp;<span class="log-swap">⇄ accepted (dumped ${dumpedCand.name})</span>`, `  swapped`, 'log-swap');
        } else {
          // The booth prefers everyone it currently has.
          addLog(`&nbsp;&nbsp;<span class="log-reject">✗ rejected (booth full)</span>`, `  rejected`, 'log-reject');
        }
      }
    }
    round++;
  }

  addLog('<span class="log-done">Algorithm complete.</span>', 'Algorithm complete.', 'log-done');

  finalCandidates = candidates;
  finalRoles      = roles;
  document.getElementById('lastUpdated').textContent = new Date().toLocaleString();
  renderResults(roles, candidates);
}

function renderResults(roles, candidates) {
  document.getElementById('resultsCard').style.display = 'block';

  const counts = { 1:0, 2:0, 3:0, '4+':0, unmatched:0 };
  let totalMatched = 0;
  Object.values(candidates).forEach(c => {
    if (!c.currentMatch) { counts.unmatched++; return; }
    totalMatched++;
    const r = c.preferences.indexOf(c.currentMatch) + 1;
    if      (r === 1) counts[1]++;
    else if (r === 2) counts[2]++;
    else if (r === 3) counts[3]++;
    else              counts['4+']++;
  });

  const total   = Object.keys(candidates).length;
  const pct     = n => total ? Math.round(n / total * 100) : 0;
  const cumTop2 = pct(counts[1] + counts[2]);

  document.getElementById('statRow').innerHTML = `
    <div class="stat-item"><div class="stat-num c-green">${totalMatched}</div><div class="stat-lbl">Matched</div></div>
    <div class="stat-item"><div class="stat-num c-green">${counts[1]}</div><div class="stat-lbl">1st choice</div></div>
    <div class="stat-item"><div class="stat-num c-green">${counts[2]}</div><div class="stat-lbl">2nd choice</div></div>
    <div class="stat-item"><div class="stat-num c-yellow">${counts[3]}</div><div class="stat-lbl">3rd choice</div></div>
    <div class="stat-item"><div class="stat-num c-yellow">${counts['4+']}</div><div class="stat-lbl">4th+ choice</div></div>
    <div class="stat-item"><div class="stat-num c-red">${counts.unmatched}</div><div class="stat-lbl">Unmatched</div></div>
    <div class="stat-item" style="margin-left:auto;text-align:right;">
      <div class="stat-num ${cumTop2 >= 75 ? 'c-green' : 'c-yellow'}">${cumTop2}%</div>
      <div class="stat-lbl">Top-2 rate</div>
    </div>
  `;

  const tbody = document.querySelector('#resultsTable tbody');
  tbody.innerHTML = '';
  Object.values(roles).forEach(role => {
    const tr = document.createElement('tr');
    
    // Sort matched candidates by how much the booth preferred them
    const sortedMatches = [...role.matches].sort((a, b) => {
        return role.rankings.indexOf(a) - role.rankings.indexOf(b);
    });

    const matchedHtml = sortedMatches.map(cid => {
      const c  = candidates[cid];
      if (!c) return cid;
      const rk  = c.preferences.indexOf(role.id) + 1;
      const cls = rk === 1 ? 'p1' : rk === 2 ? 'p2' : rk === 3 ? 'p3' : rk === 4 ? 'p4' : 'pn';
      const lbl = rk === 0 ? 'unlisted' : `#${rk}`;
      return `${c.name} <span class="pref-tag ${cls}">${lbl}</span>`;
    }).join('<br>') || '<span style="color:#bbb;font-style:italic;">None</span>';

    const f = role.matches.length, s = role.seats;
    const statusHtml = f === s
      ? `<span class="fill-ok">✓ ${f}/${s}</span>`
      : f > 0
        ? `<span class="fill-part">⚠ ${f}/${s}</span>`
        : `<span class="fill-none">✗ 0/${s}</span>`;

    tr.innerHTML = `
      <td><code>${role.id}</code></td>
      <td>${role.name}</td>
      <td style="color:#888;">${role.division || '—'}</td>
      <td style="color:#888;">${role.tier ? 'T' + role.tier : '—'}</td>
      <td style="text-align:center;color:#888;">${s}</td>
      <td>${matchedHtml}</td>
      <td>${statusHtml}</td>
    `;
    tbody.appendChild(tr);
  });

  const unmatched = Object.values(candidates).filter(c => !c.currentMatch);
  const sec = document.getElementById('unmatchedSection');
  const ul  = document.getElementById('unmatchedList');
  if (!unmatched.length) {
    sec.style.display = 'none';
  } else {
    sec.style.display = 'block';
    ul.innerHTML = unmatched.map(c => {
      const prefs = c.preferences.map((rid, i) => {
        const r = finalRoles[rid];
        return `#${i+1}: ${rid}${r ? ' — ' + r.name : ''}`;
      }).join('  ·  ');
      return `<li>
        <strong>${c.name}</strong>${c.grade ? ` · Grade ${c.grade}` : ''}
        <div class="unmatched-prefs">${prefs || 'No preferences listed'}</div>
      </li>`;
    }).join('');
  }
}

function exportResults() {
  let csv = 'CandidateID,Name,Grade,MatchedRoleID,MatchedRoleName,Division,Tier,PrefRank\n';
  Object.values(finalCandidates).forEach(c => {
    const role = c.currentMatch ? finalRoles[c.currentMatch] : null;
    const rank = c.currentMatch ? (c.preferences.indexOf(c.currentMatch) + 1 || 'unlisted') : '';
    const q    = s => `"${String(s).replace(/"/g,'""')}"`;
    csv += `${c.id},${q(c.name)},${q(c.grade)},${c.currentMatch||'UNMATCHED'},${q(role?role.name:'')},${q(role?role.division:'')},${q(role?role.tier:'')},${rank}\n`;
  });
  dl(csv, 'Final_Matches.csv', 'text/csv');
}

function exportAuditLog() {
  dl(rawAuditLog.join('\n'), 'Algorithm_Log.txt', 'text/plain');
}

function downloadCandidateTemplate() {
  const csv = [
    'CandidateID,Name,Grade,Pref1,Pref2,Pref3,Pref4,Pref5,Pref6',
    'C01,Malia Akana,12,A01,SP01,A02,F01,G01,SP02',
    'C02,Rafael Bautista,12,SP01,F01,A01,A02,G01,SP02',
    'C03,Sera Chung,11,A02,SP03,G01,A03,F02,A04',
  ].join('\n');
  dl(csv, 'Candidates_Template.csv', 'text/csv');
}

function downloadRolesTemplate() {
  const csv = [
    'RoleID,RoleName,Division,Tier,Seats,Rank1,Rank2,Rank3,Rank4,Rank5',
    'A01,Shirts & Materials,Admin,1,2,C01,C05,C11,C04,C02',
    'A02,Publicity Lead,Admin,2,4,C07,C03,C15,C01,C09',
    'F01,Signature Food Lead,Food,1,8,C04,C13,C11,C02,C06',
  ].join('\n');
  dl(csv, 'Roles_Template.csv', 'text/csv');
}

function dl(content, filename, mime) {
  const a = document.createElement('a');
  a.href = URL.createObjectURL(new Blob([content], { type: mime }));
  a.download = filename;
  document.body.appendChild(a);
  a.click();
  document.body.removeChild(a);
}
