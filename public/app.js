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
 * MANTINGAL – realistický pre NHL (len odohrané zápasy)
 *************************************************/
function displayMantingal() {
  const BASE_STAKE = 1;
  const ODDS = 2.5;
  const c = document.getElementById("mantingal-container");
  if (!c) return;
  c.innerHTML = "";

  // 🔹 1. vyber len zápasy s akýmikoľvek hráčskymi dátami
  const completed = (allMatches || []).filter(
    (m) =>
      ["closed", "complete", "final"].includes(m.status) &&
      m.statistics &&
      (
        m.statistics?.home?.players ||
        m.statistics?.away?.players ||
        m.statistics?.home?.leaders?.points ||
        m.statistics?.away?.leaders?.points
      )
  );

  if (!completed.length) {
    c.innerHTML = "<p>Žiadne odohrané zápasy so štatistikami</p>";
    return;
  }

  // 🔹 2. zoradiť podľa dátumu
  completed.sort((a, b) => new Date(a.scheduled) - new Date(b.scheduled));

  // 🔹 3. priebežný rating
  const ratingSoFar = { ...playerRatings };
  const initRating = (n) => (ratingSoFar[n] ??= 1500);

  // 🔹 4. stav Mantingalu
  const state = {};
  const ensureState = (n) => (state[n] ??= { stake: BASE_STAKE, totalStakes: 0, totalWins: 0, lastResult: "—", log: [] });

  // 🔹 5. prechádzanie zápasov
  for (const match of completed) {
    const top3 = Object.entries(ratingSoFar)
      .sort((a, b) => b[1] - a[1])
      .slice(0, 3)
      .map(([n]) => n);

    // získať hráčov z rôznych štruktúr
    const allPlayers = [];
    ["home", "away"].forEach((side) => {
      const team = match.statistics?.[side];
      if (!team) return;
      if (Array.isArray(team.players)) allPlayers.push(...team.players);
      if (Array.isArray(team.leaders?.points)) allPlayers.push(...team.leaders.points);
    });

    // spracovanie pre top3
    for (const playerName of top3) {
      const p = allPlayers.find(
        (pl) =>
          pl.full_name === playerName ||
          pl.name === playerName ||
          `${pl.first_name || ""} ${pl.last_name || ""}`.trim() === playerName
      );
      if (!p) continue;

      const s = ensureState(playerName);
      const stakeBefore = s.stake;
      s.totalStakes += stakeBefore;
      const goals = p.statistics?.total?.goals || 0;

      if (goals > 0) {
        const win = stakeBefore * ODDS;
        s.totalWins += win;
        s.stake = BASE_STAKE;
        s.lastResult = "✅ výhra";
      } else {
        s.stake *= 2;
        s.lastResult = "❌ prehra";
      }

      s.log.push({
        date: new Date(match.scheduled).toISOString().slice(0, 10),
        goals,
        stake_before: stakeBefore,
        result: s.lastResult,
        new_stake: s.stake,
      });
    }

    // aktualizuj ratingy
    for (const pl of allPlayers) {
      const name = pl.full_name || pl.name || `${pl.first_name || ""} ${pl.last_name || ""}`.trim();
      initRating(name);
      ratingSoFar[name] +=
        (pl.statistics?.total?.goals || 0) * 20 +
        (pl.statistics?.total?.assists || 0) * 10;
    }
  }

  // 🔹 6. výstup
  const totals = Object.values(state).reduce(
    (acc, s) => {
      acc.stakes += s.totalStakes;
      acc.wins += s.totalWins;
      return acc;
    },
    { stakes: 0, wins: 0 }
  );
  const profit = totals.wins - totals.stakes;

  const currentTop3 = Object.entries(ratingSoFar)
    .sort((a, b) => b[1] - a[1])
    .slice(0, 3);

  const table = document.createElement("table");
  table.innerHTML = `
    <thead>
      <tr><th colspan="5">Mantingal – NHL kontinuálny (kurz ${ODDS})</th></tr>
      <tr><th>Hráč</th><th>Kurz</th><th>Vklad</th><th>Posledný výsledok</th><th>Denník</th></tr>
    </thead>
    <tbody>
      ${currentTop3
        .map(([name]) => {
          const s = state[name] || { stake: BASE_STAKE, lastResult: "—", log: [] };
          const logId = `log-${slug(name)}`;
          const logHtml =
            s.log.length > 0
              ? s.log
                  .map(
                    (e) =>
                      `<div><b>${e.date}</b> – ${e.result}, stake: ${e.stake_before} €, góly: ${e.goals}, nový stake: ${e.new_stake} €</div>`
                  )
                  .join("")
              : "<div>Žiadne zápasy</div>";
          return `
            <tr>
              <td>${name}</td><td>${ODDS}</td><td>${s.stake} €</td><td>${s.lastResult}</td>
              <td><button class="btn-log" data-target="${logId}">📜</button></td>
            </tr>
            <tr id="${logId}" style="display:none;">
              <td colspan="5">${logHtml}</td>
            </tr>`;
        })
        .join("")}
    </tbody>`;
  c.appendChild(table);

  const summary = document.createElement("div");
  summary.innerHTML = `
    <p><b>Celkové stávky:</b> ${totals.stakes.toFixed(2)} €</p>
    <p><b>Výhry:</b> ${totals.wins.toFixed(2)} €</p>
    <p><b>Profit:</b> ${profit.toFixed(2)} €</p>`;
  c.appendChild(summary);

  table.querySelectorAll(".btn-log").forEach((btn) =>
    btn.addEventListener("click", () => {
      const t = document.getElementById(btn.dataset.target);
      if (t) t.style.display = t.style.display === "none" ? "" : "none";
    })
  );

  if (isMobile()) c.style.display = "block";
}

/*************************************************
 * ŠTART CELEJ APPKY
 *************************************************/
window.addEventListener("DOMContentLoaded", () => {
  setupMobileSectionsOnLoad();
  fetchMatches();
});
