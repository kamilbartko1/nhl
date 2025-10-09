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
 * MANTINGAL – NHL kontinuálny po každom zápase
 * - pracuje len s UKONČENÝMI zápasmi
 * - ratingy: gól = +20, asistencia = +10
 * - žiadne duplicity z boxscore
 *************************************************/
function displayMantingal() {
  const completed = (allMatches || [])
    .filter(m => ["closed", "complete", "final"].includes(m?.status))
    .filter(m => {
      const s = m?.statistics || {};
      return Boolean(
        s?.home?.players || s?.away?.players ||
        s?.home?.leaders?.points || s?.away?.leaders?.points
      );
    })
    .slice();

  const c = document.getElementById("mantingal-container");
  if (!completed.length) {
    if (c) {
      c.innerHTML = `<div class="notice">Žiadne odohrané zápasy so štatistikami</div>`;
      if (isMobile()) c.style.display = "block";
    }
    return;
  }

  // zoradenie po zápasoch chronologicky
  completed.sort((a, b) => new Date(a.scheduled) - new Date(b.scheduled));

  const R_START = 1500;
  const GOAL_W = 20;
  const ASSIST_W = 10;
  const ratingSoFar = {}; // priebežné ratingy hráčov
  const initR = (name) => { if (ratingSoFar[name] == null) ratingSoFar[name] = R_START; };

  const BASE_STAKE = 1;
  const ODDS = 2.5;
  const state = {}; // stav mantingalu
  const ensureState = (name) => {
    if (!state[name]) {
      state[name] = { stake: BASE_STAKE, totalStakes: 0, totalWins: 0, lastResult: "—", log: [] };
    }
    return state[name];
  };

  const normName = (p) =>
    p?.full_name || p?.name || `${p?.first_name || ""} ${p?.last_name || ""}`.trim();

  // 🧩 Pomocná funkcia: unikátni hráči z tímu
  function collectPlayers(teamNode) {
    const map = new Map();
    if (!teamNode) return [];
    const merge = (p) => {
      const name = normName(p);
      if (!name) return;
      const goals = Number(p?.statistics?.total?.goals ?? p?.statistics?.goals ?? 0);
      const assists = Number(p?.statistics?.total?.assists ?? p?.statistics?.assists ?? 0);
      if (!map.has(name)) map.set(name, { name, goals: 0, assists: 0 });
      const prev = map.get(name);
      map.set(name, { name, goals: prev.goals + goals, assists: prev.assists + assists });
    };
    (teamNode.players || []).forEach(merge);
    const leaderLists = [
      ...(teamNode.leaders?.points || []),
      ...(teamNode.leaders?.goals || []),
      ...(teamNode.leaders?.assists || []),
    ];
    for (const p of leaderLists) {
      const name = normName(p);
      if (name && !map.has(name)) merge(p);
    }
    return Array.from(map.values());
  }

  // 🧩 Unikátni hráči z celého zápasu
  function playersInMatch(match) {
    const s = match?.statistics || {};
    const all = [
      ...collectPlayers(s.home),
      ...collectPlayers(s.away),
    ];
    const merged = {};
    for (const p of all) {
      if (!merged[p.name]) merged[p.name] = { goals: 0, assists: 0 };
      merged[p.name].goals += p.goals;
      merged[p.name].assists += p.assists;
    }
    return Object.entries(merged).map(([name, st]) => ({
      name,
      goals: st.goals,
      assists: st.assists,
    }));
  }

  // 🧮 Spracovanie zápasov jeden po druhom
  for (const match of completed) {
    const currentTop3 = Object.entries(ratingSoFar)
      .sort((a, b) => b[1] - a[1])
      .slice(0, 3)
      .map(([n]) => n);

    const plist = playersInMatch(match);
    const byName = new Map(plist.map(p => [p.name, p]));

    // ak niekto z TOP3 hral tento zápas, vyhodnoť stávku
    for (const name of currentTop3) {
      if (!byName.has(name)) continue;
      const p = byName.get(name);
      const s = ensureState(name);
      const stakeBefore = s.stake;
      s.totalStakes += stakeBefore;

      if ((p.goals || 0) > 0) {
        const winAmount = stakeBefore * ODDS;
        s.totalWins += winAmount;
        s.stake = BASE_STAKE;
        s.lastResult = "✅ výhra";
        s.log.push({
          date: new Date(match.scheduled).toISOString().slice(0, 10),
          stake_before: stakeBefore,
          goals: p.goals,
          result: "výhra",
          win_amount: winAmount.toFixed(2),
          new_stake: s.stake,
        });
      } else {
        s.stake = stakeBefore * 2;
        s.lastResult = "❌ prehra";
        s.log.push({
          date: new Date(match.scheduled).toISOString().slice(0, 10),
          stake_before: stakeBefore,
          goals: 0,
          result: "prehra",
          win_amount: 0,
          new_stake: s.stake,
        });
      }
    }

    // po zápase aktualizuj rating hráčov podľa výkonu (bez duplicít)
    const uniquePlayers = playersInMatch(match);
    for (const p of uniquePlayers) {
      initR(p.name);
      ratingSoFar[p.name] += p.goals * GOAL_W + p.assists * ASSIST_W;
    }
  }

  // TOP3 aktuálne podľa ratingov
  const currentTop3Final = Object.entries(ratingSoFar)
    .sort((a, b) => b[1] - a[1])
    .slice(0, 3);

  const totals = Object.values(state).reduce(
    (acc, s) => {
      acc.stakes += s.totalStakes || 0;
      acc.wins += s.totalWins || 0;
      return acc;
    },
    { stakes: 0, wins: 0 }
  );
  const profit = totals.wins - totals.stakes;

  // RENDER výstupu
  if (isMobile()) c.style.display = "block";
  c.innerHTML = "";

  const table = document.createElement("table");
  table.innerHTML = `
    <thead>
      <tr><th colspan="5">Mantingal – TOP 3 (kurz ${ODDS})</th></tr>
      <tr><th>Hráč</th><th>Kurz</th><th>Vklad</th><th>Posledný výsledok</th><th>Denník</th></tr>
    </thead>
    <tbody>
      ${currentTop3Final
        .map(([name]) => {
          const s = state[name] || { stake: BASE_STAKE, lastResult: "—", log: [] };
          const logId = `log-${slug(name)}`;
          const logHtml = s.log.length
            ? s.log.map(e => `
                <div>
                  <b>${e.date}</b> – stake: ${e.stake_before} €, góly: ${e.goals}, ${e.result},
                  výhra: ${e.win_amount} €, nový stake: ${e.new_stake} €
                </div>`).join("")
            : "<div>Denník je prázdny</div>";
          return `
            <tr>
              <td>${name}</td>
              <td>${ODDS}</td>
              <td>${s.stake} €</td>
              <td>${s.lastResult}</td>
              <td><button class="btn-log" data-target="${logId}">📜</button></td>
            </tr>
            <tr id="${logId}" style="display:none;">
              <td colspan="5" style="text-align:left;">${logHtml}</td>
            </tr>`;
        })
        .join("")}
    </tbody>
  `;
  c.appendChild(table);

  const summary = document.createElement("div");
  summary.innerHTML = `
    <p><b>Celkové stávky:</b> ${totals.stakes.toFixed(2)} €</p>
    <p><b>Výhry:</b> ${totals.wins.toFixed(2)} €</p>
    <p><b>Profit:</b> ${profit.toFixed(2)} €</p>
  `;
  c.appendChild(summary);

  table.querySelectorAll(".btn-log").forEach(btn => {
    btn.addEventListener("click", () => {
      const target = document.getElementById(btn.dataset.target);
      if (target) target.style.display = target.style.display === "none" ? "" : "none";
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
