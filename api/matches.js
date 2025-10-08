// api/matches.js
import axios from "axios";

const API_KEY = "WaNt9YL5305o4hT2iGrsnoxUhegUG0St1ZYcs11g";
const SEASON_ID = "4a67cca6-b450-45f9-91c6-48e92ac19069"; // NHL 2025/26 Regular Season

// --- Konštanty pre výpočty ---
const START_RATING = 1500;
const GOAL_POINTS = 10;
const WIN_POINTS = 10;
const LOSS_POINTS = -10;

const PLAYER_GOAL_POINTS = 20;
const PLAYER_ASSIST_POINTS = 10;

const MANTINGALE_ODDS = 2.5;
const MANTINGALE_START_STAKE = 1;

// --- Pomocné funkcie ---
function sortByStartTimeAsc(matches) {
  return [...matches].sort((a, b) => {
    const ta = new Date(a.scheduled).getTime() || 0;
    const tb = new Date(b.scheduled).getTime() || 0;
    return ta - tb;
  });
}

// ======================== HANDLER ========================
export default async function handler(req, res) {
  try {
    // hlavný endpoint pre všetky zápasy sezóny
    const url = `https://api.sportradar.com/nhl/trial/v7/en/games/2025/REG/schedule.json?api_key=${API_KEY}`;
    const response = await axios.get(url);
    let matches = response.data.games || [];

    // filter len odohrané a prebiehajúce zápasy
    matches = matches.filter(
      (m) =>
        m.status === "closed" ||
        m.status === "complete" ||
        m.status === "inprogress"
    );

    // načítaj boxscore pre každý zápas
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

    // zoskupiť podľa dátumu
    const grouped = {};
    matchesWithStats.forEach((m) => {
      const date = new Date(m.scheduled).toISOString().slice(0, 10);
      if (!grouped[date]) grouped[date] = [];
      grouped[date].push(m);
    });

    const days = Object.keys(grouped).sort((a, b) => new Date(b) - new Date(a));
    let roundCounter = days.length;
    const rounds = [];
    for (const day of days) {
      grouped[day].forEach((m) => {
        m.round = roundCounter;
        m.date = day;
      });
      rounds.push({ round: roundCounter, date: day, matches: grouped[day] });
      roundCounter--;
    }

    // --- Výpočty ratingov + Mantingal ---
    const ordered = sortByStartTimeAsc(matchesWithStats);
    const teamRatings = {};
    const playerRatingsById = {};
    const playerNamesById = {};
    const martingaleState = new Map();
    let totalStaked = 0;
    let totalReturn = 0;

    const getPlayersFromBoxscore = (m) => {
      const list = [];
      const teams =
        (m.statistics?.statistics?.teams && Array.isArray(m.statistics.statistics.teams)
          ? m.statistics.statistics.teams
          : []) ||
        [];
      teams.forEach((t) => {
        (t.players || []).forEach((p) => {
          if (p?.id) {
            playerNamesById[p.id] = p.full_name || p.name;
            list.push(p);
          }
        });
      });
      return list;
    };

    for (const match of ordered) {
      if (!["closed", "complete"].includes(match.status)) continue;

      const currentTop3 = Object.entries(playerRatingsById)
        .sort((a, b) => b[1] - a[1])
        .slice(0, 3)
        .map(([id]) => id);

      const players = getPlayersFromBoxscore(match);
      const playerIds = new Set(players.map((p) => p.id));

      // Mantingal – stávky pred zápasom
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

      // góly hráčov
      const goalsById = new Map();
      players.forEach((p) => {
        const g = p?.statistics?.goals ?? 0;
        if (g > 0) goalsById.set(p.id, g);
      });

      // vyhodnotenie stávok
      currentTop3.forEach((pid) => {
        if (!playerIds.has(pid)) return;
        const state = martingaleState.get(pid);
        const scored = goalsById.has(pid);
        if (scored) {
          totalReturn += state.stake * MANTINGALE_ODDS;
          martingaleState.set(pid, { stake: MANTINGALE_START_STAKE, lastOutcome: "win" });
        } else {
          martingaleState.set(pid, { stake: state.stake * 2, lastOutcome: "loss" });
        }
      });

      // ratingy tímov
      const home = match.home?.name || "Domáci";
      const away = match.away?.name || "Hostia";
      const homeScore = match.home_points ?? 0;
      const awayScore = match.away_points ?? 0;

      if (!teamRatings[home]) teamRatings[home] = START_RATING;
      if (!teamRatings[away]) teamRatings[away] = START_RATING;

      teamRatings[home] += homeScore * GOAL_POINTS - awayScore * GOAL_POINTS;
      teamRatings[away] += awayScore * GOAL_POINTS - homeScore * GOAL_POINTS;

      if (homeScore > awayScore) {
        teamRatings[home] += WIN_POINTS;
        teamRatings[away] += LOSS_POINTS;
      } else if (awayScore > homeScore) {
        teamRatings[away] += WIN_POINTS;
        teamRatings[home] += LOSS_POINTS;
      }

      // ratingy hráčov
      players.forEach((p) => {
        const pid = p.id;
        if (!pid) return;
        playerNamesById[pid] = p.full_name || p.name;
        if (playerRatingsById[pid] == null)
          playerRatingsById[pid] = START_RATING;
        const g = p?.statistics?.goals ?? 0;
        const a = p?.statistics?.assists ?? 0;
        playerRatingsById[pid] += g * PLAYER_GOAL_POINTS + a * PLAYER_ASSIST_POINTS;
      });
    }

    // premena id -> mena hráčov
    const playerRatingsByName = {};
    for (const [pid, rating] of Object.entries(playerRatingsById)) {
      playerRatingsByName[playerNamesById[pid] || pid] = rating;
    }

    const martingaleSummary = {
      totalStaked: Number(totalStaked.toFixed(2)),
      totalReturn: Number(totalReturn.toFixed(2)),
      profit: Number((totalReturn - totalStaked).toFixed(2)),
      odds: MANTINGALE_ODDS,
    };

    res.status(200).json({
      matches: matchesWithStats,
      rounds,
      teamRatings,
      playerRatings: playerRatingsByName,
      martingale: { summary: martingaleSummary },
    });
  } catch (err) {
    console.error("Chyba pri načítaní NHL zápasov:", err.message);
    res.status(500).json({ error: "Chyba pri načítaní NHL zápasov" });
  }
}
