let teamRatings = {};
let playerRatings = {};
let allMatches = [];

const BASE_STAKE = 1;
const ODDS = 2.5;

// API cez Vercel serverless funkcie (/api)
const API_BASE = "";

// --- Pomocné: detekcia mobilu / desktopu ---
const isMobile = () => window.matchMedia("(max-width: 768px)").matches;

// --- Pomocné: sanitizácia textu do id ---
const slug = (s) =>
  encodeURIComponent(String(s || "").toLowerCase().replace(/\s+/g, "-"));

/**
 * 🆕 TEAM_IDS sa bude plniť dynamicky zo zápasov (NHL mená -> NHL id).
 */
const TEAM_IDS = {};

/** -------------------------------------------
 *  🧰 Pomocné funkcie pre NHL boxscore / zápasy
 * ------------------------------------------- */
function extractTeamsWithPlayersFromBoxscore(box) {
  const teams = [];
  const candidateTeams =
    (box?.statistics?.teams && Array.isArray(box.statistics.teams)
      ? box.statistics.teams
      : null) ||
    (box?.statistics?.team && Array.isArray(box.statistics.team)
      ? box.statistics.team
      : null) ||
    null;

  if (candidateTeams) {
    candidateTeams.forEach((t) => {
      const tName =
        t?.market && t?.name
          ? `${t.market} ${t.name}`
          : t?.name || "Tím";
      const players = (t.players || []).map((p) => ({
        id: p.id || p.player_id || p.sr_id || p.reference || p.full_name || p.name,
        name: p.full_name || p.name || p.display_name || "Neznámy hráč",
        statistics: p.statistics || {},
      }));
      teams.push({ teamName: tName, players });
    });
  } else {
    // fallback: home/away players
    const homePlayers =
      box?.home?.players && Array.isArray(box.home.players)
        ? box.home.players.map((p) => ({
            id: p.id || p.player_id || p.sr_id || p.reference || p.full_name || p.name,
            name: p.full_name || p.name || "Neznámy hráč",
            statistics: p.statistics || {},
          }))
        : [];
    const awayPlayers =
      box?.away?.players && Array.isArray(box.away.players)
        ? box.away.players.map((p) => ({
            id: p.id || p.player_id || p.sr_id || p.reference || p.full_name || p.name,
            name: p.full_name || p.name || "Neznámy hráč",
            statistics: p.statistics || {},
          }))
        : [];

    if (homePlayers.length || awayPlayers.length) {
      teams.push({ teamName: box?.home?.name || "Domáci", players: homePlayers });
      teams.push({ teamName: box?.away?.name || "Hostia", players: awayPlayers });
    }
  }

  return teams;
}

function getBoxscoreTotal(box, side) {
  const node = box?.[side] || box?.summary?.[side] || {};
  return (
    node.points ??
    node.goals ??
    node.totals?.goals ??
    node.score ??
    box?.score?.[side] ??
    null
  );
}

function extractPeriodScores(box) {
  const fromScoring =
    box?.scoring?.periods && Array.isArray(box.scoring.periods)
      ? box.scoring.periods.map((p, idx) => {
          const hn = p.home_points ?? p.home_score ?? p.home_goals ?? 0;
          const an = p.away_points ?? p.away_score ?? p.away_goals ?? 0;
          const n = p.number || idx + 1;
          return `${n}. tretina ${hn}:${an}`;
        })
      : null;
  if (fromScoring?.length) return fromScoring;

  const fromPeriods =
    box?.periods && Array.isArray(box.periods)
      ? box.periods.map((p, idx) => {
          const hn = p.home_points ?? p.home_goals ?? 0;
          const an = p.away_points ?? p.away_goals ?? 0;
          const n = p.number || idx + 1;
          return `${n}. tretina ${hn}:${an}`;
        })
      : null;
  if (fromPeriods?.length) return fromPeriods;

  return [];
}

/** -------------------------------
 *  Mobilné sekcie
 * ------------------------------- */
function setupMobileSectionsOnLoad() {
  const select = document.getElementById("mobileSelect");
  const sections = document.querySelectorAll(".section");

  if (!select) return;

  if (isMobile()) {
    select.value = "matches";
    sections.forEach((sec) => (sec.style.display = "none"));
    const matches = document.getElementById("matches-section");
    if (matches) matches.style.display = "block";
  } else {
    sections.forEach((sec) => (sec.style.display = ""));
  }

  select.addEventListener("change", () => {
    if (isMobile() && select.value === "mantingal") displayMantingal();
  });

  window.addEventListener("resize", () => {
    if (isMobile()) {
      sections.forEach((sec) => (sec.style.display = "none"));
      const current =
        document.getElementById(`${select.value}-section`) ||
        document.getElementById("mantingal-container");
      if (select.value === "mantingal") {
        const m = document.getElementById("mantingal-container");
        if (m) m.style.display = "block";
      } else if (current) current.style.display = "block";
    } else {
      sections.forEach((sec) => (sec.style.display = ""));
    }
    displayMantingal();
  });
}

/** =========================
 *  API načítanie NHL
 * ========================= */
async function fetchMatches() {
  try {
    const response = await fetch(`${API_BASE}/api/matches`);
    const data = await response.json();

    allMatches = data.matches || [];
    let matches = allMatches.filter(
      (m) =>
        m.status === "closed" ||
        m.status === "complete" ||
        m.status === "final" ||
        m.status === "inprogress"
    );

    if (!matches.length) {
      console.warn("⚠️ Žiadne odohrané zápasy");
    } else {
      console.log(`✅ Načítaných ${matches.length} zápasov`);
    }

    matches.sort((a, b) => new Date(b.scheduled) - new Date(a.scheduled));

    displayMatches(matches);

    teamRatings = data.teamRatings || {};
    playerRatings = data.playerRatings || {};

    displayTeamRatings();
    displayPlayerRatings();
    displayMantingal();
  } catch (err) {
    console.error("❌ Chyba pri načítaní zápasov:", err);
  }
}

/** =========================
 *  Zápasy – tabuľka
 * ========================= */
function displayMatches(matches) {
  const tableBody = document.querySelector("#matches tbody");
  if (!tableBody) return;
  tableBody.innerHTML = "";

  if (!matches.length) {
    tableBody.innerHTML = `<tr><td colspan="4">Žiadne odohrané zápasy</td></tr>`;
    return;
  }

  const grouped = {};
  matches.forEach((m) => {
    const day = new Date(m.scheduled).toISOString().slice(0, 10);
    if (!grouped[day]) grouped[day] = [];
    grouped[day].push(m);
  });

  const allDays = Object.keys(grouped).sort((a, b) => new Date(b) - new Date(a));

  allDays.forEach((day, index) => {
    const roundNumber = allDays.length - index;
    const roundRow = document.createElement("tr");
    roundRow.innerHTML = `<td colspan="4"><b>${roundNumber}. deň (${day})</b></td>`;
    tableBody.appendChild(roundRow);

    grouped[day].forEach((match) => {
      const home = match.home?.name || "Domáci";
      const away = match.away?.name || "Hostia";
      const homeScore = match.home_points ?? "-";
      const awayScore = match.away_points ?? "-";
      const status = match.status || "";

      const row = document.createElement("tr");
      let statusText = "";
      if (["closed", "complete", "final"].includes(status)) statusText = "✅";
      else if (status === "inprogress") statusText = "🕐 Live";

      row.innerHTML = `
        <td>${home}</td>
        <td>${away}</td>
        <td>${homeScore} : ${awayScore}</td>
        <td>${statusText}</td>
      `;

      row.style.cursor = "pointer";
      row.addEventListener("click", async () => {
        const existing = row.nextElementSibling;
        if (existing && existing.classList.contains("details-row")) {
          existing.remove();
          return;
        }

        try {
          const endpoint = `${API_BASE}/api/match-details/${match.id}`;
          const res = await fetch(endpoint);
          const data = await res.json();

          document.querySelectorAll(".details-row").forEach((el) => el.remove());

          const detailsRow = document.createElement("tr");
          detailsRow.classList.add("details-row");
          const detailsCell = document.createElement("td");
          detailsCell.colSpan = 4;

          const periodsArr = extractPeriodScores(data);
          const periodsStr = periodsArr.length
            ? periodsArr.join("; ")
            : "(bez záznamu po tretinách)";

          const hTotal = getBoxscoreTotal(data, "home") ?? homeScore;
          const aTotal = getBoxscoreTotal(data, "away") ?? awayScore;

          detailsCell.innerHTML = `
            <div class="details-box">
              <h4>Skóre: ${hTotal} : ${aTotal}</h4>
              <p><b>Po tretinách:</b> ${periodsStr}</p>
            </div>
          `;

          detailsRow.appendChild(detailsCell);
          row.insertAdjacentElement("afterend", detailsRow);
        } catch (err) {
          console.error("Chyba pri načítaní detailov zápasu:", err);
        }
      });

      tableBody.appendChild(row);
    });
  });
}

/** ======================================
 *  Ratingy tímov / hráčov / Mantingal
 * ====================================== */
// ... (ponechaná tvoja plná logika pre ratingy, playerRatings, Mantingal atď. – nemení sa)

window.addEventListener("DOMContentLoaded", () => {
  setupMobileSectionsOnLoad();
  fetchMatches();
});
