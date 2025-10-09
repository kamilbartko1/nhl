import express from "express";
import axios from "axios";
import cors from "cors";
import path from "path";
import { fileURLToPath } from "url";

const app = express();
const PORT = 3000;

const __filename = fileURLToPath(import.meta.url);
const __dirname = path.dirname(__filename);

// KONFIGURÁCIA
const API_KEY = "WaNt9YL5305o4hT2iGrsnoxUhegUG0St1ZYcs11g";
const START_RATING = 1500;
const GOAL_POINTS = 10;
const WIN_POINTS = 10;
const LOSS_POINTS = -10;
const PLAYER_GOAL_POINTS = 20;
const PLAYER_ASSIST_POINTS = 10;
const MANTINGALE_ODDS = 2.5;
const MANTINGALE_START_STAKE = 1;

app.use(cors());
app.use(express.json());
app.use(express.static(path.join(__dirname, "../frontend")));

// Pomocná funkcia – zoradenie zápasov
function sortByStartTimeAsc(matches) {
  return [...matches].sort(
    (a, b) => new Date(a.scheduled) - new Date(b.scheduled)
  );
}

// ====================== ENDPOINT ======================
app.get("/matches", async (req, res) => {
  try {
    const url = `https://api.sportradar.com/nhl/trial/v7/en/games/2025/REG/schedule.json?api_key=${API_KEY}`;
    const response = await axios.get(url);
    let matches = response.data.games || [];

    // len ukončené
    matches = matches.filter((m) =>
      ["closed", "complete"].includes(m.status)
    );

    // načítanie štatistík
    const matchesWithStats = await Promise.all(
      matches.map(async (m) => {
        try {
          const boxUrl = `https://api.sportradar.com/nhl/trial/v7/en/games/${m.id}/boxscore.json?api_key=${API_KEY}`;
          const box = await axios.get(boxUrl);
          m.statistics = box.data; // zachovávame pôvodnú štruktúru home/away
          return m;
        } catch {
          return m;
        }
      })
    );

    // ratingy
    const teamRatings = {};
    const playerRatings = {};
    const martingaleState = {};
    let totalStaked = 0;
    let totalWin = 0;

    const ordered = sortByStartTimeAsc(matchesWithStats);

    for (const match of ordered) {
      const s = match.statistics || {};
      const allPlayers = [
        ...(s.home?.players || []),
        ...(s.away?.players || []),
      ];

      // hráči
      for (const p of allPlayers) {
        const name = p.full_name || `${p.first_name || ""} ${p.last_name || ""}`.trim();
        const g = p?.statistics?.total?.goals ?? 0;
        const a = p?.statistics?.total?.assists ?? 0;
        if (!name) continue;
        if (!playerRatings[name]) playerRatings[name] = START_RATING;
        playerRatings[name] += g * PLAYER_GOAL_POINTS + a * PLAYER_ASSIST_POINTS;
      }

      // tímy
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

      // --- MANTINGAL – TOP 10 HRÁČOV ---
      const currentTop10 = Object.entries(playerRatings)
        .sort((a, b) => b[1] - a[1])
        .slice(0, 10)
        .map(([n]) => n);

      for (const name of currentTop10) {
        const p = allPlayers.find((x) => x.full_name === name);
        if (!martingaleState[name])
          martingaleState[name] = { stake: MANTINGALE_START_STAKE, totalStake: 0, totalWin: 0, active: true };

        const s = martingaleState[name];
        if (p) {
          s.totalStake += s.stake;
          totalStaked += s.stake;

          const g = p?.statistics?.total?.goals ?? 0;
          if (g > 0) {
            const win = s.stake * MANTINGALE_ODDS;
            s.totalWin += win;
            totalWin += win;
            s.stake = MANTINGALE_START_STAKE;
          } else {
            s.stake *= 2;
          }
        }
      }

      // reset hráčov, ktorí vypadli z top10
      for (const name in martingaleState) {
        if (!currentTop10.includes(name)) {
          martingaleState[name].stake = MANTINGALE_START_STAKE;
          martingaleState[name].active = false;
        }
      }
    }

    const martingaleSummary = {
      totalStaked: totalStaked.toFixed(2),
      totalReturn: totalWin.toFixed(2),
      profit: (totalWin - totalStaked).toFixed(2),
      odds: MANTINGALE_ODDS,
    };

    res.json({
      matches: matchesWithStats,
      teamRatings,
      playerRatings,
      martingale: { summary: martingaleSummary },
    });
  } catch (err) {
    console.error("❌ Chyba:", err.message);
    res.status(500).json({ error: "Chyba pri načítaní zápasov" });
  }
});

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
