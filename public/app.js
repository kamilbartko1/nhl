/*************************************************
 * GLOBÁLNE STAVY
 *************************************************/
let teamRatings = {};
let playerRatings = {};
let allMatches = [];
let martingaleSummary = {};

/*************************************************
 * KONŠTANTY
 *************************************************/
const API_BASE = "";
const isMobile = () => window.matchMedia("(max-width: 768px)").matches;
const slug = (s) => encodeURIComponent(String(s || "").toLowerCase().replace(/\s+/g, "-"));
const TEAM_IDS = {};

/*************************************************
 * POMOCNÉ – BOXCORE FUNKCIE
 *************************************************/
function extractPeriodScores(box) {
  const periods = box?.scoring?.periods || box?.periods || [];
  return periods.map((p, i) => {
    const hn = p.home_points ?? p.home_goals ?? 0;
    const an = p.away_points ?? p.away_goals ?? 0;
    const n = p.number || i + 1;
    return `${n}. tretina ${hn}:${an}`;
  });
}

function getBoxscoreTotal(box, side) {
  const node = box?.[side] || {};
  return node.points ?? node.goals ?? node.score ?? 0;
}

/*************************************************
 * MOBILNÉ SEKCIe – prepínanie
 *************************************************/
function setupMobileSectionsOnLoad() {
  const select = document.getElementById("mobileSelect");
  const sections = document.querySelectorAll(".section");
  if (!select) return;

  if (isMobile()) {
    select.value = "matches";
    sections.forEach((sec) => (sec.style.display = "none"));
    document.getElementById("matches-section").style.display = "block";
  }

  select.addEventListener("change", () => {
    const selected = select.value;
    document.querySelectorAll(".section").forEach(sec => sec.style.display = "none");
    const mantingalContainer = document.getElementById("mantingal-container");

    if (selected === "mantingal") {
      mantingalContainer.style.display = "block";
      setTimeout(displayMantingal, 200);
    } else {
      mantingalContainer.style.display = "none";
      const sectionToShow = document.getElementById(`${selected}-section`);
      if (sectionToShow) sectionToShow.style.display = "block";
    }
  });
}

/*************************************************
 * FETCH – HLAVNÉ DÁTA Z BACKENDU
 *************************************************/
async function fetchMatches() {
  try {
    const response = await fetch(`${API_BASE}/api/matches`);
    const data = await response.json();

    allMatches = data.matches || [];
    teamRatings = data.teamRatings || {};
    playerRatings = data.playerRatings || {};
    martingaleSummary = data.martingale?.summary || {};

    const matches = allMatches.map((m) => ({
      id: m.id,
      home_team: m.home?.name || "Domáci",
      away_team: m.away?.name || "Hostia",
      home_score: m.home_points ?? m.statistics?.home?.points ?? 0,
      away_score: m.away_points ?? m.statistics?.away?.points ?? 0,
      date: new Date(m.scheduled).toISOString().slice(0, 10),
      status: m.status,
    }));

    displayMatches(matches);
    displayTeamRatings();
    displayPlayerRatings();
    displayMantingal();
  } catch (err) {
    console.error("❌ Chyba pri načítaní dát:", err);
  }
}

/*************************************************
 * ZÁPASY – podľa dátumov
 *************************************************/
function displayMatches(matches) {
  const tableBody = document.querySelector("#matches tbody");
  tableBody.innerHTML = "";

  const completed = matches.filter((m) =>
    ["closed", "complete", "final"].includes(m.status)
  );

  if (!completed.length) {
    tableBody.innerHTML = `<tr><td colspan="4">Žiadne odohrané zápasy</td></tr>`;
    return;
  }

  completed.sort((a, b) => new Date(b.date) - new Date(a.date));
  const grouped = {};
  completed.forEach((m) => {
    (grouped[m.date] ||= []).push(m);
  });

  Object.keys(grouped)
    .sort((a, b) => new Date(b) - new Date(a))
    .forEach((day) => {
      const dayRow = document.createElement("tr");
      dayRow.innerHTML = `<td colspan="4"><b>${day}</b></td>`;
      tableBody.appendChild(dayRow);

      grouped[day].forEach((match) => {
        const row = document.createElement("tr");
        row.innerHTML = `
          <td>${match.home_team}</td>
          <td>${match.away_team}</td>
          <td>${match.home_score} : ${match.away_score}</td>
          <td>${match.status === "closed" ? "✅" : ""}</td>
        `;
        row.style.cursor = "pointer";
        row.addEventListener("click", async () => {
          const endpoint = `${API_BASE}/api/match-details?gameId=${match.id}`;
          const resp = await fetch(endpoint);
          const data = await resp.json();
          const periods = extractPeriodScores(data);
          const detRow = document.createElement("tr");
          detRow.classList.add("details-row");
          detRow.innerHTML = `
            <td colspan="4">
              <div><b>Po tretinách:</b> ${periods.join("; ") || "bez záznamu"}</div>
            </td>`;
          row.insertAdjacentElement("afterend", detRow);
        });
        tableBody.appendChild(row);
      });
    });
}

/*************************************************
 * RATING TÍMOV
 *************************************************/
function displayTeamRatings() {
  const tbody = document.querySelector("#teamRatings tbody");
  tbody.innerHTML = "";
  const sorted = Object.entries(teamRatings).sort((a, b) => b[1] - a[1]);
  sorted.forEach(([team, rating]) => {
    const tr = document.createElement("tr");
    tr.innerHTML = `<td>${team}</td><td>${rating}</td>`;
    tbody.appendChild(tr);
  });
}

/*************************************************
 * RATING HRÁČOV
 *************************************************/
function displayPlayerRatings() {
  const tbody = document.querySelector("#playerRatings tbody");
  tbody.innerHTML = "";
  const sorted = Object.entries(playerRatings)
    .sort((a, b) => b[1] - a[1])
    .slice(0, 20);
  if (!sorted.length) {
    tbody.innerHTML = `<tr><td colspan="2">Zatiaľ žiadni hráči</td></tr>`;
    return;
  }
  sorted.forEach(([player, rating]) => {
    const tr = document.createElement("tr");
    tr.innerHTML = `<td>${player}</td><td>${rating}</td>`;
    tbody.appendChild(tr);
  });
}

/*************************************************
 * MANTINGAL – NHL (bez duplicít z boxscore)
 * – počíta len z UKONČENÝCH zápasov
 * – zdroj štatistík IBA home.players & away.players
 * – gól = +20, asistencia = +10
 *************************************************/
function displayMantingal() {
  const completed = (allMatches || [])
    .filter(m => ["closed", "complete", "final"].includes(m?.status))
    .filter(m => Array.isArray(m?.statistics?.home?.players) || Array.isArray(m?.statistics?.away?.players))
    .slice();

  const c = document.getElementById("mantingal-container");
  if (!completed.length) {
    if (c) {
      c.innerHTML = '<div class="notice">Žiadne odohrané zápasy so štatistikami</div>';
      if (isMobile()) c.style.display = "block";
    }
    return;
  }

  completed.sort((a, b) => new Date(a.scheduled) - new Date(b.scheduled));

  const R_START = 1500;
  const GOAL_W = 20;
  const ASSIST_W = 10;
  const ratingSoFar = {};
  const initR = (name) => { if (ratingSoFar[name] == null) ratingSoFar[name] = R_START; };

  const BASE_STAKE = 1;
  const ODDS = 2.5;
  const state = {}; // name -> { stake, totalStakes, totalWins, lastResult, log[] }
  const ensureState = (name) => {
    if (!state[name]) state[name] = { stake: BASE_STAKE, totalStakes: 0, totalWins: 0, lastResult: "-", log: [] };
    return state[name];
  };

  const fullName = (p) => p?.full_name || p?.name || (String(p?.first_name || "") + " " + String(p?.last_name || "")).trim();
  const playerKey = (p) => p?.id || p?.reference || p?.sr_id || fullName(p);

  function uniquePlayers(teamNode) {
    const bag = new Map();
    if (!teamNode) return bag;
    (teamNode.players || []).forEach((p) => {
      const key = playerKey(p);
      const name = fullName(p);
      if (!key || !name) return;
      const goals = Number(p?.statistics?.total?.goals ?? p?.statistics?.goals ?? 0);
      const assists = Number(p?.statistics?.total?.assists ?? p?.statistics?.assists ?? 0);
      if (!bag.has(key)) bag.set(key, { key, name, goals: 0, assists: 0 });
      const rec = bag.get(key);
      rec.goals += goals;
      rec.assists += assists;
    });
    return bag;
  }

  function playersInMatch(match) {
    const s = match?.statistics || {};
    const homeMap = uniquePlayers(s.home);
    const awayMap = uniquePlayers(s.away);
    const merged = new Map(homeMap);
    awayMap.forEach((val, key) => {
      if (!merged.has(key)) merged.set(key, { ...val });
      else {
        const rec = merged.get(key);
        rec.goals += val.goals;
        rec.assists += val.assists;
      }
    });
    return Array.from(merged.values()).map(({ name, goals, assists }) => ({ name, goals, assists }));
  }

  for (const match of completed) {
    const currentTop3 = Object.entries(ratingSoFar)
      .sort((a, b) => b[1] - a[1])
      .slice(0, 3)
      .map(([n]) => n);

    const plist = playersInMatch(match);
    const byName = new Map(plist.map(p => [p.name, p]));

    for (const name of currentTop3) {
      const entry = byName.get(name);
      if (!entry) continue;

      const st = ensureState(name);
      const stakeBefore = st.stake;
      st.totalStakes += stakeBefore;

      if ((entry.goals || 0) > 0) {
        const winAmount = stakeBefore * ODDS;
        st.totalWins += winAmount;
        st.stake = BASE_STAKE;
        st.lastResult = "✅ výhra";
        st.log.push({
          date: new Date(match.scheduled).toISOString().slice(0, 10),
          stake_before: stakeBefore,
          goals: entry.goals,
          result: "výhra",
          win_amount: winAmount.toFixed(2),
          new_stake: st.stake,
        });
      } else {
        st.stake = stakeBefore * 2;
        st.lastResult = "❌ prehra";
        st.log.push({
          date: new Date(match.scheduled).toISOString().slice(0, 10),
          stake_before: stakeBefore,
          goals: 0,
          result: "prehra",
          win_amount: 0,
          new_stake: st.stake,
        });
      }
    }

    for (const p of plist) {
      const name = p.name;
      if (!name) continue;
      initR(name);
      ratingSoFar[name] += (p.goals || 0) * GOAL_W + (p.assists || 0) * ASSIST_W;
    }
  }

  const currentTop3Final = Object.entries(ratingSoFar)
    .sort((a, b) => b[1] - a[1])
    .slice(0, 3);

  const totals = Object.values(state).reduce(
    (acc, s) => ({ stakes: acc.stakes + (s.totalStakes || 0), wins: acc.wins + (s.totalWins || 0) }),
    { stakes: 0, wins: 0 }
  );
  const profit = totals.wins - totals.stakes;

  if (isMobile()) c.style.display = "block";
  c.innerHTML = "";

  // vyrobíme HTML riadky mimo veľkého template-stringu, aby sme sa vyhli chybám
  const rowsHtml = currentTop3Final.map(([name]) => {
    const s = state[name] || { stake: BASE_STAKE, lastResult: "-", log: [] };
    const logId = "log-" + slug(name);
    const logHtml = s.log.length
      ? s.log.map(e =>
          '<div><b>' + e.date + '</b> – stake: ' + e.stake_before + ' €,' +
          ' góly: ' + e.goals + ', ' + e.result + ', výhra: ' + e.win_amount +
          ' €, nový stake: ' + e.new_stake + ' €</div>'
        ).join("")
      : "<div>Denník je prázdny</div>";

    return ''
      + '<tr>'
      +   '<td>' + name + '</td>'
      +   '<td>' + ODDS + '</td>'
      +   '<td>' + s.stake + ' €</td>'
      +   '<td>' + s.lastResult + '</td>'
      +   '<td><button class="btn-log" data-target="' + logId + '">📜</button></td>'
      + '</tr>'
      + '<tr id="' + logId + '" style="display:none;">'
      +   '<td colspan="5" style="text-align:left;">' + logHtml + '</td>'
      + '</tr>';
  }).join("");

  const table = document.createElement("table");
  table.innerHTML =
    '<thead>'
    + '<tr><th colspan="5">Mantingal – TOP 3 (kurz ' + ODDS + ')</th></tr>'
    + '<tr><th>Hráč</th><th>Kurz</th><th>Vklad</th><th>Posledný výsledok</th><th>Denník</th></tr>'
    + '</thead>'
    + '<tbody>' + rowsHtml + '</tbody>';

  c.appendChild(table);

  const summary = document.createElement("div");
  summary.innerHTML =
    '<p><b>Celkové stávky:</b> ' + totals.stakes.toFixed(2) + ' €</p>'
    + '<p><b>Výhry:</b> ' + totals.wins.toFixed(2) + ' €</p>'
    + '<p><b>Profit:</b> ' + profit.toFixed(2) + ' €</p>';
  c.appendChild(summary);

  table.querySelectorAll(".btn-log").forEach((btn) => {
    btn.addEventListener("click", () => {
      const target = document.getElementById(btn.dataset.target);
      if (target) target.style.display = (target.style.display === "none" ? "" : "none");
    });
  });
}

/*************************************************
 * ŠTART CELEJ APPKY
 *************************************************/
window.addEventListener("DOMContentLoaded", () => {
  setupMobileSectionsOnLoad();
  fetchMatches();
});
