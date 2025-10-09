let allMatches = [];
let teamRatings = {};
let playerRatings = {};
let martingaleSummary = {};

const API_BASE = "";
const isMobile = () => window.matchMedia("(max-width: 768px)").matches;

window.addEventListener("DOMContentLoaded", () => {
  setupMobileSectionsOnLoad();
  fetchMatches();
});

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
    document.querySelectorAll(".section").forEach((sec) => (sec.style.display = "none"));
    const sectionToShow = document.getElementById(`${selected}-section`);
    if (sectionToShow) sectionToShow.style.display = "block";
  });
}

/*************************************************
 * FETCH – HLAVNÉ DÁTA
 *************************************************/
async function fetchMatches() {
  try {
    const response = await fetch(`${API_BASE}/api/matches`);
    const data = await response.json();

    allMatches = data.matches || [];
    teamRatings = data.teamRatings || {};
    playerRatings = data.playerRatings || {};
    martingaleSummary = data.martingale?.summary || {};

    displayMatches(allMatches);
    displayTeamRatings();
    displayPlayerRatings();
    displayMantingal();
  } catch (err) {
    console.error("❌ Chyba pri načítaní dát:", err);
  }
}

/*************************************************
 * ZOBRAZENIE ZÁPASOV
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

  completed.sort((a, b) => new Date(b.scheduled) - new Date(a.scheduled));
  completed.forEach((m) => {
    const row = document.createElement("tr");
    row.innerHTML = `
      <td>${m.home?.name || "Domáci"}</td>
      <td>${m.away?.name || "Hostia"}</td>
      <td>${m.home_points ?? 0} : ${m.away_points ?? 0}</td>
      <td>${m.status}</td>`;
    tableBody.appendChild(row);
  });
}

/*************************************************
 * ZOBRAZENIE RATINGOV
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
 * ZOBRAZENIE MANTINGALU
 *************************************************/
function displayMantingal() {
  const c = document.getElementById("mantingal-container");
  c.innerHTML = "";

  if (!martingaleSummary || !martingaleSummary.totalStaked) {
    c.innerHTML = `<div class="notice">Žiadne odohrané zápasy so štatistikami</div>`;
    return;
  }

  const { totalStaked, totalReturn, profit, odds } = martingaleSummary;

  c.innerHTML = `
    <h3>Mantingal – Súhrn</h3>
    <p><b>Kurz:</b> ${odds}</p>
    <p><b>Celkové stávky:</b> ${totalStaked} €</p>
    <p><b>Výhry:</b> ${totalReturn} €</p>
    <p><b>Profit:</b> ${profit} €</p>
  `;
}
