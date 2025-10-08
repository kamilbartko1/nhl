// api/matches.js
import axios from "axios";

const API_KEY = "WaNt9YL5305o4hT2iGrsnoxUhegUG0St1ZYcs11g";

// --- Konštanty pre výpočty ---
const START_RATING = 1500;
const GOAL_POINTS = 10;
const WIN_POINTS = 10;
const LOSS_POINTS = -10;

const PLAYER_GOAL_POINTS = 20;
const PLAYER_ASSIST_POINTS = 10;

const MANTINGALE_ODDS = 2.5;
const MANTINGALE_START_STAKE = 1;

// --- Pomocná funkcia: zoradenie podľa času ---
function sortByStartTimeAsc(matches) {
  return [...matches].sort((a, b) => {
    const ta = new Date(a.scheduled).getTime() || 0;
    const tb = new Date(b.scheduled).getTime() || 0;
    return ta - tb;
  });
}

// --- Pomocná funkcia: získa hráčov z boxscore ---
function extractPlayersFromBoxscore(box) {
  const result = [];
  if (!box) return result;

  const teams =
    box?.statistics?.teams ||
    box?.statistics?.team ||
    box?.team ||
    box?.teams ||
    [];

  if (Array.isArray(teams)) {
    teams.forEach((t) => {
      (t.players || []).forEach((p) => {
        if (p?.id || p?.player_id || p?.full_name) {
          result.push({
            id: p.id || p.player_id || p.reference || p.sr_id || p.full_name,
            name: p.full_name || p.name || "Neznámy hráč",
            goals: p.statistics?.goals ?? 0,
            assists: p.statistics?.assists ?? 0,
          });
        }
      });
    });
  }

  // fallback: home/away players
  ["home", "away"].forEach((side) => {
    if (box?.[side]?.players && Array.isArray(box[side].players)) {
      box[side].players.forEach((p) => {
        if (p?.id || p?.player_id || p?.full_name) {
          result.push({
            id: p.id || p.player_id || p.reference || p.sr_id || p.full_name,
            name: p.full_name || p.name || "Neznámy hráč",
            goals: p.statistics?.goals ?? 0,
            assists: p.statistics?.assists ?? 0,
          });
        }
      });
    }
  });

  return result;
}

// ======================== HANDLER ========================
export default async function handler(req, res) {
  try {
    console.log("🔄 Načítavam zápasy NHL...");

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

    console.log(`✅ Zistených ${matches.length} zápasov`);

    // načítaj boxscore pre každý zápas
    const matchesWithStats = await Promise.all(
      matches.map(async (m) => {
        try {
          const boxUrl = `https://api.sportradar.com/nhl/trial/v7/en/games/${m.id}/boxscore.json?api_key=${API_KEY}`;
          const det = await axios.get(boxUrl);
          m.statistics = det.data; // <- PRIDANÉ
          return m;
        } catch (err) {
          console.warn(`⚠️ Nepodarilo sa načítať boxscore pre zápas ${m.id}`);
          return m;
        }
      })
    );

    // zoskupiť podľa dátumu (NHL nemá kolá)
    const grouped = {};
    matchesWithStats.forEach((m) => {
      const date = new Date(m.scheduled).toISOString().slice(0, 10);
      if (!grouped[date]) grouped[date] = [];
      grouped[date].push(m);
    });

    const days = Object.keys(grouped).sort((a, b) => new Date(b) - new Date(a));

    // vytvorenie round-like objektov (len pre vizuálne zoskupenie)
    const rounds = days.map((day) => ({
      date: day,
      matches: grouped[day],
    }));

    // --- Výpočty ratingov + Mantingal ---
    const ordered = sortByStartTimeAsc(matchesWithStats);
    const teamRatings = {};
    const playerRatingsById = {};
    const playerNamesById = {};
    const martingaleState = new Map();

    let totalStaked = 0;
    let totalReturn = 0;

    for (const match of ordered) {
      if (!["closed", "complete"].includes(match.status)) continue;

      const homeName = match.home?.name || "Domáci";
      const awayName = match.away?.name || "Hostia";
      const homeScore = match.home_points ?? 0;
      const awayScore = match.away_points ?? 0;

      if (!teamRatings[homeName]) teamRatings[homeName] = START_RATING;
      if (!teamRatings[awayName]) teamRatings[awayName] = START_RATING;

      // góly tímov
      teamRatings[homeName] += homeScore * GOAL_POINTS - awayScore * GOAL_POINTS;
      teamRatings[awayName] += awayScore * GOAL_POINTS - homeScore * GOAL_POINTS;

      // výhra / prehra
      if (homeScore > awayScore) {
        teamRatings[homeName] += WIN_POINTS;
        teamRatings[awayName] += LOSS_POINTS;
      } else if (awayScore > homeScore) {
        teamRatings[awayName] += WIN_POINTS;
        teamRatings[homeName] += LOSS_POINTS;
      }

      // hráči
      const players = extractPlayersFromBoxscore(match.statistics);
      players.forEach((p) => {
        const pid = p.id;
        playerNamesById[pid] = p.name;
        if (playerRatingsById[pid] == null)
          playerRatingsById[pid] = START_RATING;
        playerRatingsById[pid] +=
          p.goals * PLAYER_GOAL_POINTS + p.assists * PLAYER_ASSIST_POINTS;
      });

      // Mantingal
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

      const goalsById = new Map();
      players.forEach((p) => {
        if (p.goals > 0) goalsById.set(p.id, p.goals);
      });

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
    }

    // premena ID -> mena hráčov
    const playerRatingsByName = {};
    Object.entries(playerRatingsById).forEach(([pid, rating]) => {
      const name = playerNamesById[pid] || pid;
      playerRatingsByName[name] = rating;
    });

    const martingaleSummary = {
      totalStaked: Number(totalStaked.toFixed(2)),
      totalReturn: Number(totalReturn.toFixed(2)),
      profit: Number((totalReturn - totalStaked).toFixed(2)),
      odds: MANTINGALE_ODDS,
    };

    console.log(`✅ Hotovo. Ratingy: ${Object.keys(playerRatingsById).length} hráčov.`);

    res.status(200).json({
      matches: matchesWithStats,
      rounds,
      teamRatings,
      playerRatings: playerRatingsByName,
      martingale: { summary: martingaleSummary },
    });
  } catch (err) {
    console.error("❌ Chyba pri načítaní NHL zápasov:", err.message);
    res.status(500).json({ error: "Chyba pri načítaní NHL zápasov" });
  }
}
