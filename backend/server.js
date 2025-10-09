// backend/server.js
import express from "express";
import axios from "axios";
import cors from "cors";
import path from "path";
import { fileURLToPath } from "url";

const app = express();
const PORT = 3000;

// pre __dirname (v ES modules)
const __filename = fileURLToPath(import.meta.url);
const __dirname = path.dirname(__filename);

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
const ODDS = 2.5;
const START_STAKE = 1;

app.use(cors());
app.use(express.json());

// sprístupní frontend
app.use(express.static(path.join(__dirname, "../frontend")));

// pomocná funkcia – načítanie hráčov z boxscore
function extractPlayersFromBoxscore(box) {
  const result = [];
  if (!box) return result;

  const teams = [box.home, box.away];
  for (const t of teams) {
    if (!Array.isArray(t?.players)) continue;
    for (const p of t.players) {
      const name =
        p.full_name ||
        `${p.first_name || ""} ${p.last_name || ""}`.trim();
      const goals = p?.statistics?.total?.goals ?? 0;
      const assists = p?.statistics?.total?.assists ?? 0;
      if (name) result.push({ name, goals, assists });
    }
  }

  // odstráni duplicity a spočíta góly/asistencie
  const unique = {};
  result.forEach((p) => {
    if (!unique[p.name]) unique[p.name] = { goals: 0, assists: 0 };
    unique[p.name].goals += p.goals;
    unique[p.name].assists += p.assists;
  });
  return Object.entries(unique).map(([name, v]) => ({ name, ...v }));
}

// zoradenie zápasov podľa času
function sortByStartTimeAsc(matches) {
  return [...matches].sort(
    (a, b) => new Date(a.scheduled) - new Date(b.scheduled)
  );
}

// ====================== ENDPOINTY ======================

// všetky zápasy + ratingy + Mantingal simulácia
app.get("/matches", async (req, res) => {
  try {
    const url = `https://api.sportradar.com/nhl/trial/v7/en/seasons/4a67cca6-b450-45f9-91c6-48e92ac19069/schedule.json?api_key=${API_KEY}`;
    const response = await axios.get(url);
    let matches = response.data.games || [];

    // len odohrané zápasy
    matches = matches.filter((m) =>
      ["closed", "complete", "final"].includes(m.status)
    );

    // načítanie boxscore pre každý zápas
    const matchesWithStats = await Promise.all(
      matches.map(async (m) => {
        try {
          const boxUrl = `https://api.sportradar.com/nhl/trial/v7/en/games/${m.id}/boxscore.json?api_key=${API_KEY}`;
          const box = await axios.get(boxUrl);
          m.statistics = box.data;
          return m;
        } catch {
          return m;
        }
      })
    );

    // === Inicializácia ===
    const teamRatings = {};
    const playerRatings = {};
    const mantingalState = {};
    let totalStaked = 0;
    let totalWin = 0;

    const ordered = sortByStartTimeAsc(matchesWithStats);

    // === Spracovanie zápasov po jednom ===
    for (const match of ordered) {
      const players = extractPlayersFromBoxscore(match.statistics);

      // --- RATING HRÁČOV ---
      for (const p of players) {
        if (!playerRatings[p.name]) playerRatings[p.name] = START_RATING;
        playerRatings[p.name] +=
          p.goals * PLAYER_GOAL_POINTS + p.assists * PLAYER_ASSIST_POINTS;
      }

      // --- RATING TÍMOV ---
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

      // --- Mantingal po každom zápase ---
      const top3 = Object.entries(playerRatings)
        .sort((a, b) => b[1] - a[1])
        .slice(0, 3)
        .map(([name]) => name);

      for (const name of top3) {
        const p = players.find((pl) => pl.name === name);
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
    console.error("❌ Chyba pri načítaní zápasov:", err.message);
    res.status(500).json({ error: "Chyba pri načítaní zápasov" });
  }
});

// detail zápasu
app.get("/match-details/:gameId", async (req, res) => {
  try {
    const { gameId } = req.params;
    const url = `https://api.sportradar.com/nhl/trial/v7/en/games/${gameId}/boxscore.json?api_key=${API_KEY}`;
    const r = await axios.get(url);
    res.json(r.data);
  } catch (err) {
    console.error(err.message);
    res.status(500).json({ error: "Chyba pri načítaní detailov zápasu" });
  }
});

app.listen(PORT, "0.0.0.0", () => {
  console.log(`✅ Server beží na http://localhost:${PORT}`);
});
