// api/matches.js
import axios from "axios";

const API_KEY = "WaNt9YL5305o4hT2iGrsnoxUhegUG0St1ZYcs11g";

// KONŠTANTY
const START_RATING = 1500;
const GOAL_POINTS = 10;
const WIN_POINTS = 10;
const LOSS_POINTS = -10;

const PLAYER_GOAL_POINTS = 20;
const PLAYER_ASSIST_POINTS = 10;

const MANTINGALE_ODDS = 2.5;
const MANTINGALE_START_STAKE = 1;

// Pomocná funkcia – zoradenie podľa času
function sortByStartTimeAsc(matches) {
  return [...matches].sort((a, b) => {
    const ta = new Date(a.scheduled).getTime() || 0;
    const tb = new Date(b.scheduled).getTime() || 0;
    return ta - tb;
  });
}

// Pomocná funkcia – extrakcia hráčov z leaders v boxscore
function extractPlayersFromBoxscore(box) {
  const players = [];

  if (!box) return players;

  const teams = [box.home, box.away];
  for (const team of teams) {
    if (!team || !team.leaders) continue;

    const allCategories = ["points", "goals", "assists"];
    for (const cat of allCategories) {
      const list = team.leaders[cat];
      if (Array.isArray(list)) {
        list.forEach((p) => {
          const id =
            p.id ||
            p.sr_id ||
            p.reference ||
            p.full_name ||
            p.last_name ||
            p.first_name;
          const name = p.full_name || `${p.first_name} ${p.last_name}`;
          const goals = p.statistics?.total?.goals ?? 0;
          const assists = p.statistics?.total?.assists ?? 0;

          if (id && name) {
            players.push({ id, name, goals, assists });
          }
        });
      }
    }
  }

  // odstránenie duplikátov
  const unique = {};
  players.forEach((p) => {
    if (!unique[p.id]) unique[p.id] = p;
    else {
      unique[p.id].goals += p.goals;
      unique[p.id].assists += p.assists;
    }
  });

  return Object.values(unique);
}

// ======================== HLAVNÝ HANDLER ========================
export default async function handler(req, res) {
  try {
    console.log("🔄 Načítavam NHL zápasy a boxscore...");

    // 1️⃣ Schedule
    const scheduleUrl = `https://api.sportradar.com/nhl/trial/v7/en/games/2025/REG/schedule.json?api_key=${API_KEY}`;
    const response = await axios.get(scheduleUrl);
    let matches = response.data.games || [];

    // len odohrané
    matches = matches.filter(
      (m) =>
        m.status === "closed" ||
        m.status === "complete" ||
        m.status === "inprogress"
    );

    console.log(`✅ Zistených ${matches.length} odohraných zápasov.`);

    // 2️⃣ Načítanie boxscore pre každý zápas
    const matchesWithStats = await Promise.all(
      matches.map(async (m) => {
        try {
          const boxUrl = `https://api.sportradar.com/nhl/trial/v7/en/games/${m.id}/boxscore.json?api_key=${API_KEY}`;
          const det = await axios.get(boxUrl);
          m.statistics = det.data;
          return m;
        } catch (err) {
          console.warn(`⚠️ Boxscore zlyhal pre zápas ${m.id}`);
          return m;
        }
      })
    );

    // 3️⃣ Zoskupiť podľa dátumu
    const grouped = {};
    matchesWithStats.forEach((m) => {
      const date = new Date(m.scheduled).toISOString().slice(0, 10);
      if (!grouped[date]) grouped[date] = [];
      grouped[date].push(m);
    });
    const days = Object.keys(grouped).sort((a, b) => new Date(b) - new Date(a));

    const rounds = days.map((day) => ({
      date: day,
      matches: grouped[day],
    }));

    // 4️⃣ Výpočty ratingov a Mantingalu
    const ordered = sortByStartTimeAsc(matchesWithStats);
    const teamRatings = {};
    const playerRatingsById = {};
    const playerNamesById = {};

    const martingaleState = new Map();
    let totalStaked = 0;
    let totalReturn = 0;

    for (const match of ordered) {
      const status = match.status;
      if (!["closed", "complete"].includes(status)) continue;

      const homeName = match.home?.name || "Domáci";
      const awayName = match.away?.name || "Hostia";
      const homeScore = match.home_points ?? 0;
      const awayScore = match.away_points ?? 0;

      if (!teamRatings[homeName]) teamRatings[homeName] = START_RATING;
      if (!teamRatings[awayName]) teamRatings[awayName] = START_RATING;

      // výpočet ratingov tímov
      teamRatings[homeName] += homeScore * GOAL_POINTS - awayScore * GOAL_POINTS;
      teamRatings[awayName] += awayScore * GOAL_POINTS - homeScore * GOAL_POINTS;

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
        playerNamesById[p.id] = p.name;
        if (playerRatingsById[p.id] == null)
          playerRatingsById[p.id] = START_RATING;
        playerRatingsById[p.id] +=
          p.goals * PLAYER_GOAL_POINTS + p.assists * PLAYER_ASSIST_POINTS;
      });

      // Mantingal (rovnaká logika ako extraliga)
      const currentTop3 = Object.entries(playerRatingsById)
        .sort((a, b) => b[1] - a[1])
        .slice(0, 3)
        .map(([id]) => id);

      const ids = new Set(players.map((p) => p.id));
      currentTop3.forEach((pid) => {
        if (!ids.has(pid)) return;
        if (!martingaleState.has(pid)) {
          martingaleState.set(pid, {
            stake: MANTINGALE_START_STAKE,
            lastOutcome: null,
          });
        }
        const state = martingaleState.get(pid);
        totalStaked += state.stake;
      });

      const goalsById = new Map(players.map((p) => [p.id, p.goals]));
      currentTop3.forEach((pid) => {
        if (!ids.has(pid)) return;
        const state = martingaleState.get(pid);
        const scored = goalsById.get(pid) > 0;
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

    // 5️⃣ Premena ID → meno hráča
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

    console.log(
      `✅ Hotovo. ${Object.keys(playerRatingsByName).length} hráčov má rating.`
    );

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
