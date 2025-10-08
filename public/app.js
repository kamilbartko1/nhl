// public/app.js

/*************************************************
 * GLOBÁLNE STAVY
 *************************************************/
let teamRatings = {};
let playerRatings = {};
let allMatches = []; // plné objekty (so štatistikami pre Mantingal)

/*************************************************
 * KONŠTANTY
 *************************************************/
const BASE_STAKE = 1;
const ODDS = 2.5;

// API cez Vercel serverless funkcie (/api). Na Verceli nechávame prázdne.
const API_BASE = "";

/*************************************************
 * POMOCNÉ – ZARIADENIE, SLUG, ID TÍMOV
 *************************************************/
const isMobile = () => window.matchMedia("(max-width: 768px)").matches;
const slug = (s) =>
  encodeURIComponent(String(s || "").toLowerCase().replace(/\s+/g, "-"));

// ⚠️ NHL: plníme dynamicky počas načítania (mapa názov -> ID)
const TEAM_IDS = {};

/*************************************************
 * POMOCNÉ – EXTRAKCIA Z NHL BOXSCORE (v7)
 *************************************************/

/**
 * Z boxscore (NHL v7) vytiahne zoznam tímov s hráčmi:
 * [{ teamName, players: [{ id, name, statistics: {goals, assists,...} }] }]
 */
function extractTeamsWithPlayersFromBoxscore(box) {
  const teams = [];

  // typické v NHL v7:
  // - box.statistics.teams = [{ name/market, players:[{id, full_name, statistics}]}]
  // - box.statistics.team  (alternatíva v niektorých feedoch)
  // fallback: box.home.players / box.away.players
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
        (t?.market || t?.name) ?
          `${t.market || ""} ${t.name || ""}`.trim() :
          (t?.name || "Tím");
      const players = (t.players || []).map((p) => ({
        id:
          p.id ||
          p.player_id ||
          p.sr_id ||
          p.reference ||
          p.full_name ||
          p.name,
        name: p.full_name || p.name || p.display_name || "Neznámy hráč",
        statistics: p.statistics || {},
      }));
      teams.push({ teamName: tName, players });
    });
  } else {
    // fallback – štruktúra home/away
    const homePlayers =
      box?.home?.players && Array.isArray(box.home.players)
        ? box.home.players.map((p) => ({
            id:
              p.id ||
              p.player_id ||
              p.sr_id ||
              p.reference ||
              p.full_name ||
              p.name,
            name: p.full_name || p.name || p.display_name || "Neznámy hráč",
            statistics: p.statistics || {},
          }))
        : [];
    const awayPlayers =
      box?.away?.players && Array.isArray(box.away.players)
        ? box.away.players.map((p) => ({
            id:
              p.id ||
              p.player_id ||
              p.sr_id ||
              p.reference ||
              p.full_name ||
              p.name,
            name: p.full_name || p.name || p.display_name || "Neznámy hráč",
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

/**
 * Sumárne skóre domáci/hostia (rôzne možné polia podľa feedu).
 */
function getBoxscoreTotal(box, side /* 'home' | 'away' */) {
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

/**
 * Skóre po tretinách ak je v boxscore dostupné.
 * Výstup: ["1. tretina 1:0", "2. tretina 0:2", ...]
 */
function extractPeriodScores(box) {
  // preferované: box.scoring.periods
  const fromScoring =
    box?.scoring?.periods && Array.isArray(box.scoring.periods)
      ? box.scoring.periods.map((p, idx) => {
          const hn = p.home_points ?? p.home_score ?? p.home_goals ?? 0;
          const an = p.away_points ?? p.away_score ?? p.away_goals ?? 0;
          const n = p.number || idx + 1;
          return `${n}. tretina ${hn}:${an}`;
        })
      : null;
  if (fromScoring && fromScoring.length) return fromScoring;

  // alternatívne: box.periods
  const fromPeriods =
    box?.periods && Array.isArray(box.periods)
      ? box.periods.map((p, idx) => {
          const hn = p.home_points ?? p.home_score ?? p.home_goals ?? 0;
          const an = p.away_points ?? p.away_score ?? p.away_goals ?? 0;
          const n = p.number || idx + 1;
          return `${n}. tretina ${hn}:${an}`;
        })
      : null;
  if (fromPeriods && fromPeriods.length) return fromPeriods;

  // posledný fallback – ak je per-period info pod home/away
  const hPeriods =
    box?.home?.scoring?.periods && Array.isArray(box.home.scoring.periods)
      ? box.home.scoring.periods
      : null;
  const aPeriods =
    box?.away?.scoring?.periods && Array.isArray(box.away.scoring.periods)
      ? box.away.scoring.periods
      : null;

  if (hPeriods && aPeriods && hPeriods.length === aPeriods.length) {
    return hPeriods.map((hp, idx) => {
      const ap = aPeriods[idx] || {};
      const hn = hp.points ?? hp.goals ?? hp.score ?? 0;
      const an = ap.points ?? ap.goals ?? ap.score ?? 0;
      const n = hp.number || ap.number || idx + 1;
      return `${n}. tretina ${hn}:${an}`;
    });
  }

  return [];
}

/*************************************************
 * MOBIL – sekcie po načítaní
 *************************************************/
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

  // pri prepnutí sekcie v mobile vyrenderuj mantingal
  select.addEventListener("change", () => {
    if (isMobile() && select.value === "mantingal") {
      displayMantingal();
    }
  });

  // pri resize upratovanie/prekreslenie
  window.addEventListener("resize", () => {
    if (isMobile()) {
      sections.forEach((sec) => (sec.style.display = "none"));
      const current =
        document.getElementById(`${select.value}-section`) ||
        document.getElementById("mantingal-container");
      if (select.value === "mantingal") {
        const m = document.getElementById("mantingal-container");
        if (m) m.style.display = "block";
      } else if (current) {
        current.style.display = "block";
      }
    } else {
      sections.forEach((sec) => (sec.style.display = ""));
    }
    displayMantingal();
  });
}

/*************************************************
 * API – načítanie NHL dát
 *************************************************/
async function fetchMatches() {
  try {
    const response = await fetch(`${API_BASE}/api/matches`);
    const data = await response.json();

    // Preferuj rounds ak prišli (ale my zobrazíme po dátumoch, bez kôl)
    let matches = [];
    if (Array.isArray(data.rounds) && data.rounds.length > 0) {
      allMatches = data.rounds.flatMap((r) => r.matches) || [];
    } else {
      allMatches = data.matches || [];
    }

    // Vytvor „ploché“ položky pre tabuľku zápasov (s dátumom)
    matches = allMatches.map((m) => {
      const homeId = m.home?.id || m.home_id;
      const awayId = m.away?.id || m.away_id;
      const homeName = m.home?.name || m.home_team || "Domáci";
      const awayName = m.away?.name || m.away_team || "Hostia";

      // doplň dynamickú mapu team -> id
      if (homeId && homeName) TEAM_IDS[homeName] = homeId;
      if (awayId && awayName) TEAM_IDS[awayName] = awayId;

      const status = m.status || m.game_status || "";

      return {
        id: m.id,
        home_id: homeId,
        away_id: awayId,
        home_team: homeName,
        away_team: awayName,
        home_score:
          m.home_points ??
          m.home_score ??
          m.statistics?.home?.points ??
          m.statistics?.home?.goals ??
          null,
        away_score:
          m.away_points ??
          m.away_score ??
          m.statistics?.away?.points ??
          m.statistics?.away?.goals ??
          null,
        status,
        overtime:
          m.overtime ||
          m.statistics?.scoring?.overtime ||
          m.statistics?.overtime ||
          false,
        ap: false, // NHL nepoužíva AP ako v Extralige
        date: new Date(m.scheduled || m.date).toISOString().slice(0, 10),
      };
    });

    // Zoradiť od najnovšieho dňa k najstaršiemu
    matches.sort((a, b) => new Date(b.date) - new Date(a.date));

    // ➜ najprv prepočítaj ratingy z allMatches (ako pri Extralige – na fronte)
    computeRatingsFromMatches();

    // Render
    displayMatches(matches);
    displayTeamRatings();
    displayPlayerRatings();
    displayMantingal();
  } catch (err) {
    console.error("Chyba pri načítaní zápasov:", err);
  }
}

/*************************************************
 * PREPOČET RATINGOV (ako pri Extralige) – FRONTEND
 *************************************************/
function computeRatingsFromMatches() {
  // Reset
  teamRatings = {};
  playerRatings = {};

  // vyber ukončené/prebiehajúce (ale pre ratingy len ukončené/complete)
  const completed = (allMatches || []).filter((m) =>
    ["closed", "complete", "final"].includes(m.status)
  );

  // zoradiť chronologicky (od najstarších) – aby sa rating vyvíjal v čase
  completed.sort(
    (a, b) =>
      new Date(a.scheduled || a.date) - new Date(b.scheduled || b.date)
  );

  // konštanty ratingov
  const START_RATING = 1500;
  const GOAL_POINTS = 10;
  const WIN_POINTS = 10;
  const LOSS_POINTS = -10;

  const PLAYER_GOAL_POINTS = 20;
  const PLAYER_ASSIST_POINTS = 10;

  // pomocné na zistenie skóre v prípade neštandardných polí
  const safeScore = (match, side /* 'home' | 'away' */) => {
    if (side === "home") {
      return (
        match.home_points ??
        match.statistics?.home?.points ??
        match.statistics?.home?.goals ??
        match.home_score ??
        0
      );
    } else {
      return (
        match.away_points ??
        match.statistics?.away?.points ??
        match.statistics?.away?.goals ??
        match.away_score ??
        0
      );
    }
  };

  const getTeamsAndPlayers = (match) =>
    extractTeamsWithPlayersFromBoxscore(match.statistics || {});

  // PRECHOD CEZ ZÁPASY
  for (const match of completed) {
    // TIMY
    const homeName = match.home?.name || match.home_team || "Domáci";
    const awayName = match.away?.name || match.away_team || "Hostia";

    if (teamRatings[homeName] == null) teamRatings[homeName] = START_RATING;
    if (teamRatings[awayName] == null) teamRatings[awayName] = START_RATING;

    const hs = safeScore(match, "home");
    const as = safeScore(match, "away");

    // gólové body
    teamRatings[homeName] += hs * GOAL_POINTS - as * GOAL_POINTS;
    teamRatings[awayName] += as * GOAL_POINTS - hs * GOAL_POINTS;

    // bonus za výhru / prehru
    if (hs > as) {
      teamRatings[homeName] += WIN_POINTS;
      teamRatings[awayName] += LOSS_POINTS;
    } else if (as > hs) {
      teamRatings[awayName] += WIN_POINTS;
      teamRatings[homeName] += LOSS_POINTS;
    }

    // HRÁČI
    const teamsWithPlayers = getTeamsAndPlayers(match);
    for (const t of teamsWithPlayers) {
      for (const p of t.players || []) {
        const name = p.name || "Neznámy hráč";
        if (playerRatings[name] == null) playerRatings[name] = START_RATING;
        const g = p.statistics?.goals ?? 0;
        const a = p.statistics?.assists ?? 0;
        playerRatings[name] += g * PLAYER_GOAL_POINTS + a * PLAYER_ASSIST_POINTS;
      }
    }
  }
}

/*************************************************
 * RENDER: ZÁPASY (zoskupené po dňoch)
 *************************************************/
function displayMatches(matches) {
  const tableBody = document.querySelector("#matches tbody");
  if (!tableBody) return;
  tableBody.innerHTML = "";

  // iba odohrané/prebiehajúce – zobrazíme len ukončené a AP (ako Extraliga)
  const completed = matches.filter((m) =>
    ["closed", "complete", "final", "ap"].includes(m.status)
  );

  if (completed.length === 0) {
    tableBody.innerHTML = `<tr><td colspan="4">Žiadne odohrané zápasy</td></tr>`;
    return;
  }

  // zoradiť od najnovšieho dátumu
  completed.sort((a, b) => new Date(b.date) - new Date(a.date));

  // zoskupiť podľa dňa (bez „kôl“)
  const grouped = {};
  completed.forEach((m) => {
    const day = new Date(m.date).toISOString().slice(0, 10);
    (grouped[day] ||= []).push(m);
  });

  const allDays = Object.keys(grouped).sort(
    (a, b) => new Date(b) - new Date(a)
  );

  allDays.forEach((day) => {
    const dayRow = document.createElement("tr");
    dayRow.innerHTML = `<td colspan="4"><b>${day}</b></td>`;
    tableBody.appendChild(dayRow);

    grouped[day].forEach((match) => {
      const homeScore = match.home_score ?? "-";
      const awayScore = match.away_score ?? "-";

      let statusText = "";
      if (["closed", "complete", "final"].includes(match.status)) {
        statusText = match.overtime || match.ap ? "✅ PP" : "✅";
      } else if (match.status === "ap") {
        statusText = "✅ PP";
      }

      const row = document.createElement("tr");
      row.innerHTML = `
        <td>${match.home_team}</td>
        <td>${match.away_team}</td>
        <td>${homeScore} : ${awayScore}</td>
        <td>${statusText}</td>
      `;

      // klik – detail zápasu (NHL používa gameId = match.id)
      row.style.cursor = "pointer";
      row.addEventListener("click", async () => {
        const existingDetails = row.nextElementSibling;
        if (existingDetails && existingDetails.classList.contains("details-row")) {
          existingDetails.remove();
          return;
        }
        try {
          const endpoint = `${API_BASE}/api/match-details?gameId=${encodeURIComponent(
            match.id
          )}`;
          const resp = await fetch(endpoint);
          const data = await resp.json();

          document.querySelectorAll(".details-row").forEach((el) => el.remove());

          const detailsRow = document.createElement("tr");
          detailsRow.classList.add("details-row");

          const detailsCell = document.createElement("td");
          detailsCell.colSpan = 4;

          const periodsArr = extractPeriodScores(data);
          const periodsStr = periodsArr.length
            ? `/${periodsArr.join("; ")}/`
            : "/(bez záznamu po tretinách)/";

          const hTotal =
            getBoxscoreTotal(data, "home") ?? match.home_score ?? "-";
          const aTotal =
            getBoxscoreTotal(data, "away") ?? match.away_score ?? "-";

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

/*************************************************
 * RENDER: RATING TÍMOV
 *************************************************/
function displayTeamRatings() {
  const tableBody = document.querySelector("#teamRatings tbody");
  if (!tableBody) return;
  tableBody.innerHTML = "";

  const sorted = Object.entries(teamRatings).sort((a, b) => b[1] - a[1]);

  sorted.forEach(([team, rating]) => {
    const row = document.createElement("tr");
    row.innerHTML = `<td>${team}</td><td>${rating}</td>`;

    // klik na tím – prípadne doplníš vlastný endpoint na detail tímu
    row.style.cursor = "pointer";
    row.addEventListener("click", async () => {
      const id = TEAM_IDS[team];
      if (!id) return;

      const existing = row.nextElementSibling;
      if (existing && existing.classList.contains("team-stats-row")) {
        existing.remove();
        return;
      }

      try {
        // ak nemáš endpoint, ticho preskočíme (ako doteraz)
        const resp = await fetch(`${API_BASE}/api/${encodeURIComponent(id)}`);
        if (!resp.ok) {
          console.warn("Endpoint /api/team/:id nie je k dispozícii.");
          return;
        }
        const stats = await resp.json();

        document.querySelectorAll(".team-stats-row").forEach((el) => el.remove());

        const detailsRow = document.createElement("tr");
        detailsRow.classList.add("team-stats-row");
        detailsRow.innerHTML = `
          <td colspan="2">
            <div><b>Výhry:</b> ${stats.wins ?? "-"}</div>
            <div><b>Prehry:</b> ${stats.losses ?? "-"}</div>
            <div><b>Strelené góly:</b> ${stats.goalsFor ?? "-"}</div>
            <div><b>Obdržané góly:</b> ${stats.goalsAgainst ?? "-"}</div>
          </td>
        `;
        row.insertAdjacentElement("afterend", detailsRow);
      } catch (err) {
        console.error("Chyba pri načítaní štatistík tímu:", err);
      }
    });

    tableBody.appendChild(row);
  });
}

/*************************************************
 * RENDER: RATING HRÁČOV (TOP 20)
 *************************************************/
function displayPlayerRatings() {
  const tableBody = document.querySelector("#playerRatings tbody");
  if (!tableBody) return;
  tableBody.innerHTML = "";

  const top20 = Object.entries(playerRatings)
    .sort((a, b) => b[1] - a[1])
    .slice(0, 20);

  top20.forEach(([player, rating]) => {
    const row = document.createElement("tr");
    row.innerHTML = `<td>${player}</td><td>${rating}</td>`;
    tableBody.appendChild(row);
  });
}

/*************************************************
 * MANTINGAL – simulácia sezóny + DENNÍK (ako pri Extralige)
 *************************************************/
function displayMantingal() {
  // vyber len ukončené zápasy s hráčskymi štatistikami
  const completed = (allMatches || [])
    .filter(
      (m) =>
        (m.status &&
          ["closed", "complete", "final"].includes(m.status)) ||
        m.sport_event_status?.status === "closed" ||
        m.sport_event_status?.status === "ap"
    )
    .filter((m) => {
      // NHL boxscore hráčov – musíme mať hráčov
      const hasPlayers =
        m.statistics &&
        (m.statistics?.statistics?.teams ||
          m.statistics?.team ||
          m.statistics?.home?.players ||
          m.statistics?.away?.players);
      return Boolean(hasPlayers);
    })
    .slice();

  // zoradiť podľa času (od najstarších)
  completed.sort(
    (a, b) =>
      new Date(a.scheduled || a.sport_event?.start_time || a.date) -
      new Date(b.scheduled || b.sport_event?.start_time || b.date)
  );

  // zoskupiť podľa dňa (YYYY-MM-DD)
  const byDay = {};
  for (const m of completed) {
    const ts = m.scheduled || m.sport_event?.start_time || m.date;
    const d = new Date(ts).toISOString().slice(0, 10);
    (byDay[d] ||= []).push(m);
  }
  const days = Object.keys(byDay).sort();

  // priebežné ratingy (iba na určenie TOP3 „pred dňom“)
  const ratingSoFar = {};
  const initRating = (name) => {
    if (ratingSoFar[name] == null) ratingSoFar[name] = 1500;
  };

  // stav mantingalu pre všetkých hráčov z TOP3
  // log: [{date, stake_before, goals, result, win_amount, new_stake}]
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

  // simulácia po dňoch
  for (const day of days) {
    // TOP3 podľa ratingSoFar (pred spracovaním dňa)
    const top3 = Object.entries(ratingSoFar)
      .sort((a, b) => b[1] - a[1])
      .slice(0, 3)
      .map(([name]) => name);

    if (top3.length) {
      // pre každý hráč z TOP3: ak v tento deň hrá, vyhodnotíme stávku
      for (const playerName of top3) {
        let played = false;
        let goalsThatDay = 0;

        for (const match of byDay[day]) {
          const teams = extractTeamsWithPlayersFromBoxscore(match.statistics);
          for (const team of teams) {
            const p = (team.players || []).find((pl) => pl.name === playerName);
            if (p) {
              played = true;
              goalsThatDay += p.statistics?.goals || 0;
            }
          }
        }

        if (played) {
          const s = ensureState(playerName);
          const stakeBefore = s.stake;

          // vsádzame aktuálny stake pred dňom
          s.totalStakes += stakeBefore;

          if (goalsThatDay > 0) {
            // výhra
            const winAmount = stakeBefore * ODDS;
            s.totalWins += winAmount;
            s.stake = BASE_STAKE;
            s.lastResult = "✅ výhra";

            s.log.push({
              date: day,
              stake_before: stakeBefore,
              goals: goalsThatDay,
              result: "výhra",
              win_amount: Number(winAmount.toFixed(2)),
              new_stake: s.stake,
            });
          } else {
            // prehra
            const newStake = stakeBefore * 2;
            s.stake = newStake;
            s.lastResult = "❌ prehra";

            s.log.push({
              date: day,
              stake_before: stakeBefore,
              goals: 0,
              result: "prehra",
              win_amount: 0,
              new_stake: newStake,
            });
          }
        }
      }
    }

    // po vyhodnotení dňa aktualizuj priebežné ratingy podľa výkonov v tento deň
    for (const match of byDay[day]) {
      const teams = extractTeamsWithPlayersFromBoxscore(match.statistics);
      for (const team of teams) {
        for (const p of team.players || []) {
          initRating(p.name);
          ratingSoFar[p.name] +=
            (p.statistics?.goals || 0) * 20 + (p.statistics?.assists || 0) * 10;
        }
      }
    }
  }

  // aktuálna TOP3 podľa globálne vypočítaného playerRatings
  const currentTop3 = Object.entries(playerRatings)
    .sort((a, b) => b[1] - a[1])
    .slice(0, 3);

  // celkové sumáre
  const totals = Object.values(state).reduce(
    (acc, s) => {
      acc.stakes += s.totalStakes || 0;
      acc.wins += s.totalWins || 0;
      return acc;
    },
    { stakes: 0, wins: 0 }
  );
  const profit = totals.wins - totals.stakes;

  // Render do správneho kontajnera (PC vs mobil)
  const pcWrapper = document.querySelector("#players-section");
  const mobileWrapper = document.getElementById("mantingal-container");

  if (pcWrapper) {
    const oldPc = pcWrapper.querySelector("#mantingal-wrapper-pc");
    if (oldPc) oldPc.remove();
  }
  if (mobileWrapper) {
    mobileWrapper.innerHTML = "";
  }

  const buildMantingalNode = (context) => {
    const container = document.createElement("div");
    container.id =
      context === "pc" ? "mantingal-wrapper-pc" : "mantingal-wrapper-mobile";

    const table = document.createElement("table");
    table.id = "mantingal";
    table.innerHTML = `
      <thead>
        <tr><th colspan="5">Mantingal – TOP 3 (kurz ${ODDS})</th></tr>
        <tr><th>Hráč</th><th>Kurz</th><th>Vklad</th><th>Posledný výsledok</th><th>Denník</th></tr>
      </thead>
      <tbody>
        ${currentTop3
          .map(([name]) => {
            const s = state[name] || {
              stake: BASE_STAKE,
              lastResult: "—",
              log: [],
            };
            const logId = `log-${slug(name)}-${context}`;
            const logHtml = s.log.length
              ? s.log
                  .map(
                    (e) => `
                <div>
                  <b>${e.date}</b> – stake: ${e.stake_before} €,
                  góly: ${e.goals},
                  výsledok: ${e.result},
                  výhra: ${
                    typeof e.win_amount === "number"
                      ? e.win_amount.toFixed(2)
                      : e.win_amount
                  } €,
                  nový stake: ${e.new_stake} €
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
              </tr>
            `;
          })
          .join("")}
      </tbody>
    `;

    const summary = document.createElement("div");
    summary.id =
      context === "pc" ? "mantingal-summary-pc" : "mantingal-summary-mobile";
    summary.innerHTML = `
      <p><b>Celkové stávky</b>: ${totals.stakes.toFixed(2)} €</p>
      <p><b>Výhry</b>: ${totals.wins.toFixed(2)} €</p>
      <p><b>Profit</b>: ${profit.toFixed(2)} €</p>
    `;

    container.appendChild(table);
    container.appendChild(summary);

    table.querySelectorAll(".btn-log").forEach((btn) => {
      btn.addEventListener("click", () => {
        const target = document.getElementById(btn.getAttribute("data-target"));
        if (target)
          target.style.display = target.style.display === "none" ? "" : "none";
      });
    });

    return container;
  };

  if (isMobile()) {
    if (mobileWrapper) mobileWrapper.appendChild(buildMantingalNode("mobile"));
  } else {
    if (pcWrapper) pcWrapper.appendChild(buildMantingalNode("pc"));
  }
}

/*************************************************
 * ŠTART
 *************************************************/
window.addEventListener("DOMContentLoaded", () => {
  setupMobileSectionsOnLoad();
  fetchMatches();
});
