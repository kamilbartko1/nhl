import express from "express";
import axios from "axios";
import cors from "cors";
import path from "path";
import { fileURLToPath } from "url";

const app = express();
const PORT = 3000;

// ES Modules fix pre __dirname
const __filename = fileURLToPath(import.meta.url);
const __dirname = path.dirname(__filename);

// === KONŠTANTY ===
const API_KEY = "WaNt9YL5305o4hT2iGrsnoxUhegUG0St1ZYcs11g";
const START_RATING = 1500;
const GOAL_POINTS = 10;
const WIN_POINTS = 10;
const LOSS_POINTS = -10;
const PLAYER_GOAL_POINTS = 20;
const PLAYER_ASSIST_POINTS = 10;
const ODDS = 2.5;
const START_STAKE = 1;

app.use(cors());
app.use(express.json());
app.use(express.static(path.join(__dirname, "../frontend")));

// 🧩 Načítanie hráčov zo zápasu
function extractPlayersFromBoxscore(box) {
  const players = [];
  if (!box) return players;

  const teams = [box.home, box.away];
  for (const team of teams) {
    if (!Array.isArray(team?.players)) continue;

    for (const p of team.players) {
      const name =
        p.full_name ||
        `${p.first_name || ""} ${p.last_name || ""}`.trim();
      const goals = p?.statistics?.total?.goals ?? 0;
      const assists = p?.statistics?.total?.assists ?? 0;
      if (name) players.push({ name, goals, assists });
    }
  }

  // zlúči duplicity (ak sa niekto objaví dvakrát)
  const merged = {};
  for (const p of players) {
    if (!merged[p.name]) merged[p.name] = { goals: 0, assists: 0 };
    merged[p.name].goals += p.goals;
    merged[p.name].assists += p.assists;
  }
  return Object.entries(merged).map(([name, v]) => ({ name, ...v }));
}

// 🕒 zoradenie zápasov
function sortByStartTimeAsc(matches) {
  return [...matches].sort(
    (a, b) => new Date(a.scheduled) - new Date(b.scheduled)
  );
}

// ====================== ENDPOINTY ======================
app.get("/api/matches", async (req, res) => {
  try {
    const url = `https://api.sportradar.com/nhl/trial/v7/en/seasons/4a67cca6-b450-45f9-91c6-48e92ac19069/schedule.json?api_key=${API_KEY}`;
    const response = await axios.get(url);
    let matches = response.data.games || [];

    // len ukončené zápasy
    matches = matches.filter((m) =>
      ["closed", "complete", "final"].includes(m.status)
    );

    // načítaj detailné štatistiky
    const matchesWithStats = await Promise.all(
      matches.map(async (m) => {
        try {
          const boxUrl = `https://api.sportradar.com/nhl/trial/v7/en/games/${m.id}/boxscore.json?api_key=${API_KEY}`;
          const box = await axios.get(boxUrl);
          m.statistics = box.data;
          return m;
        } catch (err) {
          console.warn("⚠️ Boxscore chyba pre", m.id);
          return m;
        }
      })
    );

    const teamRatings = {};
    const playerRatings = {};
    const mantingalState = {};
    let totalStaked = 0;
    let totalWin = 0;

    const ordered = sortByStartTimeAsc(matchesWithStats);

    for (const match of ordered) {
      const players = extractPlayersFromBoxscore(match.statistics);

      // --- RATING HRÁČOV ---
      for (const p of players) {
        if (!playerRatings[p.name]) playerRatings[p.name] = START_RATING;
        playerRatings[p.name] +=
          p.goals * PLAYER_GOAL_POINTS + p.assists * PLAYER_ASSIST_POINTS;
      }

      // --- RATING TÍMOV ---
      const home = match.home?.name || "Domáci";
      const away = match.away?.name || "Hostia";
      const hs = match.home_points ?? 0;
      const as = match.away_points ?? 0;
      if (!teamRatings[home]) teamRatings[home] = START_RATING;
      if (!teamRatings[away]) teamRatings[away] = START_RATING;
      teamRatings[home] += hs * GOAL_POINTS - as * GOAL_POINTS;
      teamRatings[away] += as * GOAL_POINTS - hs * GOAL_POINTS;
      if (hs > as) {
        teamRatings[home] += WIN_POINTS;
        teamRatings[away] += LOSS_POINTS;
      } else if (as > hs) {
        teamRatings[away] += WIN_POINTS;
        teamRatings[home] += LOSS_POINTS;
      }

      // --- MANTINGAL ---
      const top3 = Object.entries(playerRatings)
        .sort((a, b) => b[1] - a[1])
        .slice(0, 3)
        .map(([n]) => n);

      for (const name of top3) {
        const p = players.find((x) => x.name === name);
        if (!mantingalState[name])
          mantingalState[name] = { stake: START_STAKE, totalStake: 0, totalWin: 0 };
        const s = mantingalState[name];
        if (p) {
          s.totalStake += s.stake;
          totalStaked += s.stake;
          if (p.goals > 0) {
            const win = s.stake * ODDS;
            s.totalWin += win;
            totalWin += win;
            s.stake = START_STAKE;
          } else {
            s.stake *= 2;
          }
        }
      }
    }

    const martingaleSummary = {
      totalStaked: Number(totalStaked.toFixed(2)),
      totalReturn: Number(totalWin.toFixed(2)),
      profit: Number((totalWin - totalStaked).toFixed(2)),
      odds: ODDS,
    };

    res.json({
      matches: matchesWithStats,
      teamRatings,
      playerRatings,
      martingale: { summary: martingaleSummary },
    });
  } catch (err) {
    console.error("❌ Chyba:", err.message);
    res.status(500).json({ error: "Chyba pri načítaní NHL dát" });
  }
});

// detail zápasu
app.get("/api/match-details", async (req, res) => {
  try {
    const { gameId } = req.query;
    const url = `https://api.sportradar.com/nhl/trial/v7/en/games/${gameId}/boxscore.json?api_key=${API_KEY}`;
    const r = await axios.get(url);
    res.json(r.data);
  } catch (err) {
    res.status(500).json({ error: "Chyba pri načítaní detailu zápasu" });
  }
});

app.listen(PORT, "0.0.0.0", () =>
  console.log(`✅ Server beží na http://localhost:${PORT}`)
);
