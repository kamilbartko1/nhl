// public/app.js

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
 * Vďaka tomu funguje klik na "rating tímov" bez ručného mapovania.
 */
const TEAM_IDS = {};

/** -------------------------------------------
 *  🧰 POMOCNÉ FUNKCIE PRE NHL BOXCORE / SCHEDULE
 * ------------------------------------------- */

/**
 * Z detaily boxscore (NHL v7) sa pokúsi vytiahnuť zoznam tímov so zoznamom hráčov.
 * Vracia pole objektov { teamName, players: [{ id, name, statistics: { goals, assists, ... } }] }
 */
function extractTeamsWithPlayersFromBoxscore(box) {
  const teams = [];

  // 💡 typické tvary v NHL v7 boxscore:
  // - box.statistics.teams = [{ name, players: [{ id, full_name, statistics: {goals, assists,...}}]}]
  // - box.statistics.team   (alternatívny názov v niektorých feedoch)
  // - niekedy aj box.home.players / box.away.players, ale to je menej časté v v7

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
      const tName = t?.name || t?.market
        ? `${t.market || ""} ${t.name || ""}`.trim()
        : t?.name || "Tím";
      const players = (t.players || []).map((p) => ({
        id: p.id || p.player_id || p.sr_id || p.reference || p.full_name || p.name,
        name: p.full_name || p.name || p.display_name || "Neznámy hráč",
        statistics: p.statistics || {},
      }));
      teams.push({ teamName: tName, players });
    });
  } else {
    // fallback – skús štruktúru home/away s players
    const homePlayers =
      box?.home?.players && Array.isArray(box.home.players)
        ? box.home.players.map((p) => ({
            id: p.id || p.player_id || p.sr_id || p.reference || p.full_name || p.name,
            name: p.full_name || p.name || p.display_name || "Neznámy hráč",
            statistics: p.statistics || {},
          }))
        : [];
    const awayPlayers =
      box?.away?.players && Array.isArray(box.away.players)
        ? box.away.players.map((p) => ({
            id: p.id || p.player_id || p.sr_id || p.reference || p.full_name || p.name,
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
 * Vytiahne sumárne skóre domáci/hostia z boxscore (rôzne možné polia).
 */
function getBoxscoreTotal(box, side /* 'home' | 'away' */) {
  const node = box?.[side] || box?.summary?.[side] || {};
  // možné polia v rôznych feedoch:
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
 * Vytiahne skóre po tretinách z boxscore (ak je k dispozícii).
 * Výstup: pole reťazcov typu "1. tretina 1:0", "2. tretina 0:2", ...
 */
function extractPeriodScores(box) {
  // najprv skús štruktúry s "periods"
  // možný tvar: box.scoring.periods = [{number, home_points, away_points}, ...]
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

  // alternatívne: box.periods = [{ number, home_points/away_points }, ...]
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

  // posledný fallback: ak sú niekde stashnuté per-period info pod home/away
  // (napr. home.scoring.periods / away.scoring.periods)
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

  return []; // nič k dispozícii
}

/** ------------------------------------------------
 *  MOBILNÉ SEKCIe – základné nastavenie po načítaní
 * ------------------------------------------------ */
function setupMobileSectionsOnLoad() {
  const select = document.getElementById("mobileSelect");
  const sections = document.querySelectorAll(".section");

  if (!select) return;

  if (isMobile()) {
    // default – Zápasy
    select.value = "matches";
    sections.forEach((sec) => (sec.style.display = "none"));
    const matches = document.getElementById("matches-section");
    if (matches) matches.style.display = "block";
  } else {
    // desktop – necháme CSS (3 stĺpce), nič neschovávame tu
    sections.forEach((sec) => (sec.style.display = ""));
  }

  // Pre istotu: keď používateľ prepína, re-renderujeme Mantingal pre mobil
  select.addEventListener("change", () => {
    if (isMobile()) {
      if (select.value === "mantingal") {
        // pri otvorení sekcie mantingal sprav render len do mobil kontajnera
        displayMantingal();
      }
    }
  });

  // Pri zmene veľkosti okna pre-render aby sa neobjavili duplicity
  window.addEventListener("resize", () => {
    // Prepneme zobrazenie sekcií korektne
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
    // a pre-render Mantingal do správneho kontajnera podľa režimu
    displayMantingal();
  });
}

/** =========================
 *  API načítanie – NHL (v7)
 * ========================= */
async function fetchMatches() {
  try {
    const response = await fetch(`${API_BASE}/api/team/matches`);
    const data = await response.json();

    // 🔹 preferuj rounds (iba odohrané a zoradené kolá)
    let matches = [];

    // Uložíme si "plné" dáta pre Mantingal (potrebuje hráčske štatistiky)
    // a zároveň pripravíme zjednodušené položky pre zobrazenie v tabuľke.
    if (Array.isArray(data.rounds) && data.rounds.length > 0) {
      // Pôvodne sme mali Extraligu; teraz prichádzajú NHL zápasy (m) s:
      // m.id, m.home{name,id}, m.away{name,id}, m.home_points, m.away_points, m.status, m.scheduled
      allMatches = data.rounds.flatMap((r) => r.matches) || [];

      // Mantingal potrebuje štatistiky – v NHL boxscore sme ich uložili do m.statistics
      const withStats = allMatches.filter(
        (m) =>
          m.statistics &&
          (m.statistics?.statistics?.teams ||
            m.statistics?.team ||
            m.statistics?.home?.players ||
            m.statistics?.away?.players)
      );

      if (withStats.length === 0) {
        console.warn(
          "⚠️ Žiadne zápasy s hráčskymi štatistikami – Mantingal nebude počítať"
        );
      } else {
        console.log(`✅ Načítaných ${withStats.length} zápasov so štatistikami`);
      }

      // pre tabuľku vytvoríme zjednodušené zobrazenie
      matches = allMatches.map((m) => {
        const homeId = m.home?.id || m.home_id;
        const awayId = m.away?.id || m.away_id;
        const homeName = m.home?.name || m.home_team || "Domáci";
        const awayName = m.away?.name || m.away_team || "Hostia";

        // 🆕 dynamicky naplníme TEAM_IDS
        if (homeId && homeName) TEAM_IDS[homeName] = homeId;
        if (awayId && awayName) TEAM_IDS[awayName] = awayId;

        // statusy (NHL): "scheduled" | "inprogress" | "complete" | "closed"
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
          ap: false, // NHL nepoužíva AP ako v Extralige; nechávame false
          round: (() => {
            const date = new Date(m.scheduled || m.date).toISOString().slice(0, 10);
            const foundRound = data.rounds.find((r) => r.date === date);
            return foundRound ? foundRound.round : null;
          })(),
          date: new Date(m.scheduled || m.date).toISOString().slice(0, 10),
        };
      });
    } else {
      // fallback – ak máš len matches
      allMatches = data.matches || [];
      matches = allMatches.map((m) => {
        const homeId = m.home?.id || m.home_id;
        const awayId = m.away?.id || m.away_id;
        const homeName = m.home?.name || m.home_team || "Domáci";
        const awayName = m.away?.name || m.away_team || "Hostia";

        if (homeId && homeName) TEAM_IDS[homeName] = homeId;
        if (awayId && awayName) TEAM_IDS[awayName] = awayId;

        const status = m.status || "";

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
          ap: false,
          date: new Date(m.scheduled || m.date).toISOString().slice(0, 10),
        };
      });
    }

    // 🔹 zoradiť od posledného kola alebo najnovšieho zápasu
    matches.sort((a, b) => {
      if (a.round && b.round) return b.round - a.round;
      return new Date(b.date) - new Date(a.date);
    });

    // ⚠️ zachováme pôvodné plné dáta pre Mantingal (so štatistikami)
    if (!allMatches || allMatches.length === 0) {
      allMatches =
        data.matches || (data.rounds?.flatMap((r) => r.matches) || []);
    }

    displayMatches(matches);

    teamRatings = data.teamRatings || {};
    playerRatings = data.playerRatings || {};

    displayTeamRatings();
    displayPlayerRatings();
    displayMantingal();
  } catch (err) {
    console.error("Chyba pri načítaní zápasov:", err);
  }
}

/** =========================
 *  Zápasy – render tabuľky
 * ========================= */
function displayMatches(matches) {
  const tableBody = document.querySelector("#matches tbody");
  if (!tableBody) return;
  tableBody.innerHTML = "";

  // 🔹 iba odohrané zápasy
  const completed = matches.filter(
    (m) =>
      m.status === "closed" ||
      m.status === "complete" ||
      m.status === "final" ||
      m.status === "ap"
  );

  if (completed.length === 0) {
    tableBody.innerHTML = `<tr><td colspan="4">Žiadne odohrané zápasy</td></tr>`;
    return;
  }

  // 🔹 zoradiť od najnovšieho dátumu k najstaršiemu
  completed.sort((a, b) => new Date(b.date) - new Date(a.date));

  // 🔹 zoskupiť podľa dňa zápasov (každý deň = jedno kolo)
  const grouped = {};
  completed.forEach((m) => {
    const day = new Date(m.date).toISOString().slice(0, 10);
    if (!grouped[day]) grouped[day] = [];
    grouped[day].push(m);
  });

  const allDays = Object.keys(grouped).sort(
    (a, b) => new Date(b) - new Date(a)
  );

  // 🔹 priraď číslovanie kôl (napr. 8. kolo, 7. kolo, ...)
  allDays.forEach((day, index) => {
    const roundNumber = allDays.length - index;
    const roundRow = document.createElement("tr");
    roundRow.innerHTML = `<td colspan="4"><b>${roundNumber}. kolo (${day})</b></td>`;
    tableBody.appendChild(roundRow);

    grouped[day].forEach((match) => {
      const homeScore = match.home_score ?? "-";
      const awayScore = match.away_score ?? "-";

      const row = document.createElement("tr");

      let statusText = "";
      if (
        match.status === "closed" ||
        match.status === "complete" ||
        match.status === "final"
      ) {
        statusText = match.overtime || match.ap ? "✅ PP" : "✅";
      } else if (match.status === "ap") {
        statusText = "✅ PP";
      }

      row.innerHTML = `
        <td>${match.home_team}</td>
        <td>${match.away_team}</td>
        <td>${homeScore} : ${awayScore}</td>
        <td>${statusText}</td>
      `;

      // klik na detail zápasu (NHL: podľa gameId)
      row.style.cursor = "pointer";
      row.addEventListener("click", async () => {
        const existingDetails = row.nextElementSibling;
        if (existingDetails && existingDetails.classList.contains("details-row")) {
          existingDetails.remove();
          return;
        }

        try {
          const endpoint = `${API_BASE}/api/team/match-details?gameId=${encodeURIComponent(
            match.id
          )}`;
          const response = await fetch(endpoint);
          const data = await response.json();

          document.querySelectorAll(".details-row").forEach((el) => el.remove());

          const detailsRow = document.createElement("tr");
          detailsRow.classList.add("details-row");

          const detailsCell = document.createElement("td");
          detailsCell.colSpan = 4;

          const periodsArr = extractPeriodScores(data);
          const periodsStr = periodsArr.length
            ? `/${periodsArr.join("; ")}/`
            : "/(bez záznamu po tretinách)/";

          // skóre z boxscore – robustne
          const hTotal =
            getBoxscoreTotal(data, "home") ??
            match.home_score ??
            "-";
          const aTotal =
            getBoxscoreTotal(data, "away") ??
            match.away_score ??
            "-";

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

/** ==============================
 *  Rating tímov – render tabuľky
 * ============================== */
function displayTeamRatings() {
  const tableBody = document.querySelector("#teamRatings tbody");
  if (!tableBody) return;
  tableBody.innerHTML = "";

  const sortedTeams = Object.entries(teamRatings).sort((a, b) => b[1] - a[1]);

  sortedTeams.forEach(([team, rating]) => {
    const row = document.createElement("tr");
    row.innerHTML = `<td>${team}</td><td>${rating}</td>`;

    // klik na riadok tímu -> načítanie štatistík tímu (ak máš endpoint)
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
        // Pozn.: /api/team/:id endpoint si môžeš dorobiť podľa potreby
        const resp = await fetch(`${API_BASE}/api/team/${encodeURIComponent(id)}`);
        if (!resp.ok) {
          // ak endpoint nemáš, len to ticho preskočíme
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

/** ==================================
 *  Rating hráčov – render TOP 20
 * ================================== */
function displayPlayerRatings() {
  const tableBody = document.querySelector("#playerRatings tbody");
  if (!tableBody) return;
  tableBody.innerHTML = "";

  const sortedPlayers = Object.entries(playerRatings)
    .sort((a, b) => b[1] - a[1])
    .slice(0, 20);

  sortedPlayers.forEach(([player, rating]) => {
    const row = document.createElement("tr");
    row.innerHTML = `<td>${player}</td><td>${rating}</td>`;
    tableBody.appendChild(row);
  });
}

/** ============================================================
 *  MANTINGAL – simulácia sezóny + DENNÍK  (pôvodná logika ZACHOVANÁ)
 *  – prejde všetky odohrané dni chronologicky,
 *  – pred dňom zoberie TOP3 podľa „dovtedajších“ ratingov,
 *  – ak TOP3 hráč v ten deň hrá:
 *      * gól => výhra (stake × 2.5), reset na 1 €
 *      * bez gólu => prehra, stake ×2
 *  – počas simulácie plní denník (log) pre každého hráča
 *  ============================================================ */
function displayMantingal() {
  // vyber len ukončené zápasy s hráčskymi štatistikami
  const completed = (allMatches || [])
    .filter(
      (m) =>
        (m.status && (m.status === "closed" || m.status === "complete" || m.status === "final")) ||
        m.sport_event_status?.status === "closed" ||
        m.sport_event_status?.status === "ap"
    )
    .filter((m) => {
      // NHL boxscore hráčov:
      const hasNhlPlayers =
        m.statistics &&
        (m.statistics?.statistics?.teams ||
          m.statistics?.team ||
          m.statistics?.home?.players ||
          m.statistics?.away?.players);
      return Boolean(hasNhlPlayers);
    })
    .slice();

  // zoradiť podľa času (od najstarších)
  completed.sort(
    (a, b) =>
      new Date(a.scheduled || a.sport_event?.start_time) -
      new Date(b.scheduled || b.sport_event?.start_time)
  );

  // zoskupiť podľa dňa (YYYY-MM-DD)
  const byDay = {};
  for (const m of completed) {
    const ts = m.scheduled || m.sport_event?.start_time;
    const d = new Date(ts).toISOString().slice(0, 10);
    (byDay[d] ||= []).push(m);
  }
  const days = Object.keys(byDay).sort();

  // priebežné ratingy (iba na určenie TOP3 „pred dňom“)
  const ratingSoFar = {};
  const initRating = (name) => {
    if (ratingSoFar[name] == null) ratingSoFar[name] = 1500;
  };

  // stav mantingalu pre všetkých hráčov, ktorí sa niekedy ocitli v TOP3
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
    // TOP3 podľa ratingSoFar (pred spracovaním tohto dňa)
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

          // vsádzame vždy „aktuálny stake“ platný pred týmto dňom
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

    // po vyhodnotení dňa aktualizujeme priebežné ratingy podľa výkonov v tento deň
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

  // aktuálna TOP3 podľa „globálneho“ playerRatings (čo zobrazujeme v tabuľke)
  const currentTop3 = Object.entries(playerRatings)
    .sort((a, b) => b[1] - a[1])
    .slice(0, 3);

  // celkové sumáre naprieč všetkými hráčmi, ktorí boli niekedy v TOP3
  const totals = Object.values(state).reduce(
    (acc, s) => {
      acc.stakes += s.totalStakes || 0;
      acc.wins += s.totalWins || 0;
      return acc;
    },
    { stakes: 0, wins: 0 }
  );
  const profit = totals.wins - totals.stakes;

  // ---------- RENDER DO SPRÁVNEHO KONTajnera (PC vs mobil) ----------
  const pcWrapper = document.querySelector("#players-section"); // pravý stĺpec
  const mobileWrapper = document.getElementById("mantingal-container"); // samostatná mobil sekcia

  // Vymaž staré rendery na oboch miestach
  if (pcWrapper) {
    const oldPc = pcWrapper.querySelector("#mantingal-wrapper-pc");
    if (oldPc) oldPc.remove();
  }
  if (mobileWrapper) {
    mobileWrapper.innerHTML = "";
  }

  // Helper: vytvorí DOM uzol mantingalu (tabuľka + sumár)
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
                </div>
              `
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
              <td colspan="5" style="text-align:left;">
                ${logHtml}
              </td>
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

    // toggle denníka (otvoriť/zavrieť)
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
    // render len do mobilnej sekcie (a uistiť sa, že sekcia je viditeľná len ak je v menu vybraná)
    if (mobileWrapper) {
      mobileWrapper.appendChild(buildMantingalNode("mobile"));
    }
  } else {
    // render do PC – pod tabuľku hráčov (pravý stĺpec)
    if (pcWrapper) {
      const pcNode = buildMantingalNode("pc");
      // umiestniť pod tabuľku hráčov
      pcWrapper.appendChild(pcNode);
    }
  }
}

/** =========================
 *  ŠTART
 * ========================= */
window.addEventListener("DOMContentLoaded", () => {
  setupMobileSectionsOnLoad();
  fetchMatches();
});
