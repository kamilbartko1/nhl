// api/matches.js
import axios from "axios";

// --- KONFIGURÁCIA ---
const API_KEY = "WaNt9YL5305o4hT2iGrsnoxUhegUG0St1ZYcs11g";

// rating – tímy
const START_RATING = 1500;
const GOAL_POINTS = 10;
const WIN_POINTS = 10;
const LOSS_POINTS = -10;

// rating – hráči
const PLAYER_GOAL_POINTS = 20;
const PLAYER_ASSIST_POINTS = 10;

// Mantingal
const MANTINGALE_ODDS = 2.5;
const MANTINGALE_START_STAKE = 1;

/** Pomocná funkcia – zoradenie zápasov podľa času. */
function sortByStartTimeAsc(matches) {
  return [...matches].sort(
    (a, b) => new Date(a.scheduled) - new Date(b.scheduled)
  );
}

/** 🧩 Extrakcia hráčov z boxscore (iba players, bez leaders) */
function extractPlayersFromBoxscore(box) {
  const players = [];
  if (!box) return players;

  const teams = [box.home, box.away];
  for (const team of teams) {
    if (!Array.isArray(team?.players)) continue;

    team.players.forEach((p) => {
      const id =
        p.id ||
        p.sr_id ||
        p.reference ||
        p.full_name ||
        `${p.first_name} ${p.last_name}`;
      const name =
        p.full_name ||
        `${p.first_name || ""} ${p.last_name || ""}`.trim();
      const stats = p.statistics?.total || {};
      const goals = stats.goals ?? 0;
      const assists = stats.assists ?? 0;
      if (id && name) players.push({ id, name, goals, assists });
    });
  }

  // odstráni duplicity
  const unique = {};
  for (const p of players) {
    if (!unique[p.id]) unique[p.id] = { ...p };
    else {
      unique[p.id].goals += p.goals;
      unique[p.id].assists += p.assists;
    }
  }
  return Object.values(unique);
}

/** 🔧 Handler pre endpoint /api/matches */
export default async function handler(req, res) {
  try {
    const scheduleUrl = `https://api.sportradar.com/nhl/trial/v7/en/games/2025/REG/schedule.json?api_key=${API_KEY}`;
    const response = await axios.get(scheduleUrl);
    let matches = response.data.games || [];

    // iba ukončené zápasy
    matches = matches.filter((m) =>
      ["closed", "complete"].includes(m.status)
    );

    // načítanie boxscore
    const matchesWithStats = await Promise.all(
      matches.map(async (m) => {
        try {
          const boxUrl = `https://api.sportradar.com/nhl/trial/v7/en/games/${m.id}/boxscore.json?api_key=${API_KEY}`;
          const det = await axios.get(boxUrl);
          m.statistics = det.data;
          return m;
        } catch {
          return m;
        }
      })
    );

    // --- Výpočty ---
    const ordered = sortByStartTimeAsc(matchesWithStats);
    const teamRatings = {};
    const playerRatingsById = {};
    const playerNamesById = {};
    const martingaleState = new Map();

    let totalStaked = 0;
    let totalReturn = 0;

    for (const match of ordered) {
      const players = extractPlayersFromBoxscore(match.statistics);

      // === RATING HRÁČOV (iba goals + assists) ===
      for (const p of players) {
        const pid = p.id;
        const name = p.name;
        if (!pid || !name) continue;
        playerNamesById[pid] = name;
        if (playerRatingsById[pid] == null)
          playerRatingsById[pid] = START_RATING;
        playerRatingsById[pid] +=
          p.goals * PLAYER_GOAL_POINTS + p.assists * PLAYER_ASSIST_POINTS;
      }

      // === RATING TÍMOV ===
      const homeName = match.home?.name || "Domáci";
      const awayName = match.away?.name || "Hostia";
      const homeScore = match.home_points ?? 0;
      const awayScore = match.away_points ?? 0;

      if (!teamRatings[homeName]) teamRatings[homeName] = START_RATING;
      if (!teamRatings[awayName]) teamRatings[awayName] = START_RATING;

      teamRatings[homeName] += homeScore * GOAL_POINTS - awayScore * GOAL_POINTS;
      teamRatings[awayName] += awayScore * GOAL_POINTS - homeScore * GOAL_POINTS;

      if (homeScore > awayScore) {
        teamRatings[homeName] += WIN_POINTS;
        teamRatings[awayName] += LOSS_POINTS;
      } else if (awayScore > homeScore) {
        teamRatings[awayName] += WIN_POINTS;
        teamRatings[homeName] += LOSS_POINTS;
      }

      // === MANTINGAL ===
      const currentTop3 = Object.entries(playerRatingsById)
        .sort((a, b) => b[1] - a[1])
        .slice(0, 3)
        .map(([id]) => id);

      const playerIds = new Set(players.map((p) => p.id));

      currentTop3.forEach((pid) => {
        if (playerIds.has(pid)) {
          if (!martingaleState.has(pid)) {
            martingaleState.set(pid, {
              stake: MANTINGALE_START_STAKE,
              lastOutcome: null,
            });
          }
          totalStaked += martingaleState.get(pid).stake;
        }
      });

      currentTop3.forEach((pid) => {
        if (!playerIds.has(pid)) return;
        const state = martingaleState.get(pid);
        const player = players.find((p) => p.id === pid);
        const scored = player && player.goals > 0;

        if (scored) {
          totalReturn += state.stake * MANTINGALE_ODDS;
          martingaleState.set(pid, {
            stake: MANTINGALE_START_STAKE,
            lastOutcome: "win",
          });
        } else {
          martingaleState.set(pid, {
            stake: state.stake * 2,
            lastOutcome: "loss",
          });
        }
      });
    }

    // konverzia ratingov hráčov do mien
    const playerRatingsByName = {};
    for (const [pid, rating] of Object.entries(playerRatingsById)) {
      const name = playerNamesById[pid] || pid;
      playerRatingsByName[name] = rating;
    }

    const martingaleSummary = {
      totalStaked: Number(totalStaked.toFixed(2)),
      totalReturn: Number(totalReturn.toFixed(2)),
      profit: Number((totalReturn - totalStaked).toFixed(2)),
      odds: MANTINGALE_ODDS,
    };

    res.status(200).json({
      matches: matchesWithStats,
      teamRatings,
      playerRatings: playerRatingsByName,
      martingale: { summary: martingaleSummary },
    });
  } catch (err) {
    console.error("❌ Chyba pri načítaní NHL zápasov:", err.message);
    res.status(500).json({ error: "Chyba pri načítaní NHL zápasov" });
  }
}
