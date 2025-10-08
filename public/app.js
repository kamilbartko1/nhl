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
    if (isMobile()) {
      sections.forEach((s) => (s.style.display = "none"));
      document.getElementById(`${select.value}-section`).style.display = "block";
      if (select.value === "mantingal") displayMantingal();
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
 * MANTINGAL – simulácia sezóny + DENNÍK (plná logika)
 *************************************************/
function displayMantingal() {
  // len odohrané zápasy s hráčskymi štatistikami
  const completed = (allMatches || [])
    .filter((m) =>
      ["closed", "complete", "final"].includes(m.status)
    )
    .filter((m) => {
      const hasPlayers =
        m.statistics &&
        (m.statistics?.home?.leaders?.points ||
         m.statistics?.away?.leaders?.points ||
         m.statistics?.home?.players ||
         m.statistics?.away?.players);
      return Boolean(hasPlayers);
    });

  if (!completed.length) {
    const c = document.getElementById("mantingal-container");
    c.innerHTML = "<p>Žiadne odohrané zápasy so štatistikami</p>";
    return;
  }

  // zoradiť chronologicky
  completed.sort(
    (a, b) => new Date(a.scheduled) - new Date(b.scheduled)
  );

  // zoskupiť podľa dňa
  const byDay = {};
  for (const m of completed) {
    const d = new Date(m.scheduled).toISOString().slice(0, 10);
    (byDay[d] ||= []).push(m);
  }
  const days = Object.keys(byDay).sort();

  // priebežné ratingy hráčov
  const ratingSoFar = { ...playerRatings };
  const initRating = (name) => {
    if (ratingSoFar[name] == null) ratingSoFar[name] = 1500;
  };

  // stav mantingalu
  const BASE_STAKE = 1;
  const ODDS = 2.5;
  const state = {};
  const ensureState = (name) => {
    if (!state[name]) {
      state[name] = {
        stake: BASE_STAKE,
        totalStakes: 0,
        totalWins: 0,
        lastResult: "—",
        log: [],
      };
    }
    return state[name];
  };

  // simulácia deň po dni
  for (const day of days) {
    const top3 = Object.entries(ratingSoFar)
      .sort((a, b) => b[1] - a[1])
      .slice(0, 3)
      .map(([name]) => name);

    for (const playerName of top3) {
      let played = false;
      let goals = 0;

      for (const match of byDay[day]) {
        const allPlayers = [];
        const collect = (side) => {
          const team = match.statistics?.[side];
          if (!team) return;
          if (Array.isArray(team.players)) allPlayers.push(...team.players);
          if (team.leaders?.points)
            allPlayers.push(...team.leaders.points);
        };
        collect("home");
        collect("away");

        const player = allPlayers.find(
          (p) =>
            p.full_name === playerName ||
            p.name === playerName ||
            `${p.first_name} ${p.last_name}`.trim() === playerName
        );
        if (player) {
          played = true;
          goals += player.statistics?.total?.goals || 0;
        }
      }

      if (played) {
        const s = ensureState(playerName);
        const stakeBefore = s.stake;
        s.totalStakes += stakeBefore;

        if (goals > 0) {
          const win = stakeBefore * ODDS;
          s.totalWins += win;
          s.stake = BASE_STAKE;
          s.lastResult = "✅ výhra";
          s.log.push({
            date: day,
            stake_before: stakeBefore,
            goals,
            result: "výhra",
            win_amount: win.toFixed(2),
            new_stake: s.stake,
          });
        } else {
          s.stake *= 2;
          s.lastResult = "❌ prehra";
          s.log.push({
            date: day,
            stake_before: stakeBefore,
            goals: 0,
            result: "prehra",
            win_amount: 0,
            new_stake: s.stake,
          });
        }
      }
    }

    // po dni aktualizuj priebežné ratingy
    for (const match of byDay[day]) {
      const allPlayers = [];
      ["home", "away"].forEach((side) => {
        const team = match.statistics?.[side];
        if (team?.players) allPlayers.push(...team.players);
      });
      for (const p of allPlayers) {
        const name = p.full_name || p.name || `${p.first_name} ${p.last_name}`;
        initRating(name);
        ratingSoFar[name] +=
          (p.statistics?.total?.goals || 0) * 20 +
          (p.statistics?.total?.assists || 0) * 10;
      }
    }
  }

  // zhrnutie
  const currentTop3 = Object.entries(playerRatings)
    .sort((a, b) => b[1] - a[1])
    .slice(0, 3);

  const totals = Object.values(state).reduce(
    (acc, s) => {
      acc.stakes += s.totalStakes;
      acc.wins += s.totalWins;
      return acc;
    },
    { stakes: 0, wins: 0 }
  );
  const profit = totals.wins - totals.stakes;

  // render
  const c = document.getElementById("mantingal-container");
  c.innerHTML = "";

  const table = document.createElement("table");
  table.innerHTML = `
    <thead>
      <tr><th colspan="5">Mantingal – TOP 3 (kurz ${ODDS})</th></tr>
      <tr><th>Hráč</th><th>Kurz</th><th>Vklad</th><th>Posledný výsledok</th><th>Denník</th></tr>
    </thead>
    <tbody>
      ${currentTop3
        .map(([name]) => {
          const s = state[name] || { stake: BASE_STAKE, lastResult: "—", log: [] };
          const logId = `log-${slug(name)}`;
          const logHtml = s.log.length
            ? s.log
                .map(
                  (e) => `
              <div>
                <b>${e.date}</b> – stake: ${e.stake_before} €, góly: ${e.goals},
                ${e.result}, výhra: ${e.win_amount} €, nový stake: ${e.new_stake} €
              </div>`
                )
                .join("")
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

  table.querySelectorAll(".btn-log").forEach((btn) => {
    btn.addEventListener("click", () => {
      const target = document.getElementById(btn.dataset.target);
      if (target)
        target.style.display = target.style.display === "none" ? "" : "none";
    });
  });
}

/*************************************************
 * 
 * 
 *************************************************/
window.addEventListener("DOMContentLoaded", () => {
  setupMobileSectionsOnLoad();
  fetchMatches();
});
