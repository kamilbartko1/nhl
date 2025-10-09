import express from "express";
import axios from "axios";
import cors from "cors";
import path from "path";
import { fileURLToPath } from "url";

const app = express();
const PORT = 3000;

// fix __dirname v ESM
const __filename = fileURLToPath(import.meta.url);
const __dirname = path.dirname(__filename);

// ==================== KONFIG ====================
const API_KEY = "WaNt9YL5305o4hT2iGrsnoxUhegUG0St1ZYcs11g";
const SEASON_ID = "4a67cca6-b450-45f9-91c6-48e92ac19069"; // 2025–26 sezóna

// ratingy
const START_RATING = 1500;
const PLAYER_GOAL_POINTS = 20;
const PLAYER_ASSIST_POINTS = 10;
const TEAM_GOAL_POINTS = 10;
const WIN_POINTS = 10;
const LOSS_POINTS = -10;

// mantingal
const ODDS = 2.5;
const START_STAKE = 1;

app.use(cors());
app.use(express.json());
app.use(express.static(path.join(__dirname, "../frontend")));

// zoradenie zápasov
const sortByStartTimeAsc = (matches) =>
  [...matches].sort(
    (a, b) => new Date(a.scheduled) - new Date(b.scheduled)
  );

// načítanie hráčov z boxscore (home + away)
function extractPlayers(box) {
  const result = [];
  if (!box) return result;

  ["home", "away"].forEach((side) => {
    const t = box[side];
    if (!t) return;
    (t.players || []).forEach((p) => {
      const name =
        p.full_name || `${p.first_name || ""} ${p.last_name || ""}`.trim();
      const goals = p?.statistics?.total?.goals ?? 0;
      const assists = p?.statistics?.total?.assists ?? 0;
      if (name) result.push({ name, goals, assists });
    });
  });

  // spojiť duplikáty
  const merged = {};
  for (const p of result) {
    if (!merged[p.name]) merged[p.name] = { goals: 0, assists: 0 };
    merged[p.name].goals += p.goals;
    merged[p.name].assists += p.assists;
  }
  return Object.entries(merged).map(([name, v]) => ({ name, ...v }));
}

// ==================== ENDPOINT ====================
app.get("/api/matches", async (req, res) => {
  try {
    const scheduleUrl = `https://api.sportradar.com/nhl/trial/v7/en/seasons/${SEASON_ID}/schedule.json?api_key=${API_KEY}`;
    const r = await axios.get(scheduleUrl);
    let matches = r.data.games || [];

    matches = matches.filter((m) =>
      ["closed", "complete", "final"].includes(m.status)
    );

    if (!matches.length) {
      console.log("⚠️ Žiadne odohrané zápasy v Sportradar API.");
    }

    // načítaj boxscore
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

    // výpočty
    const teamRatings = {};
    const playerRatings = {};
    const martingale = {};
    let totalStaked = 0;
    let totalWin = 0;

    const ordered = sortByStartTimeAsc(matchesWithStats);

    for (const match of ordered) {
      const players = extractPlayers(match.statistics);

      // rating hráčov
      for (const p of players) {
        if (!playerRatings[p.name]) playerRatings[p.name] = START_RATING;
        playerRatings[p.name] +=
          p.goals * PLAYER_GOAL_POINTS + p.assists * PLAYER_ASSIST_POINTS;
      }

      // rating tímov
      const home = match.home?.name || "Domáci";
      const away = match.away?.name || "Hostia";
      const hs = match.home_points ?? 0;
      const as = match.away_points ?? 0;
      if (!teamRatings[home]) teamRatings[home] = START_RATING;
      if (!teamRatings[away]) teamRatings[away] = START_RATING;
      teamRatings[home] += hs * TEAM_GOAL_POINTS - as * TEAM_GOAL_POINTS;
      teamRatings[away] += as * TEAM_GOAL_POINTS - hs * TEAM_GOAL_POINTS;
      if (hs > as) {
        teamRatings[home] += WIN_POINTS;
        teamRatings[away] += LOSS_POINTS;
      } else if (as > hs) {
        teamRatings[away] += WIN_POINTS;
        teamRatings[home] += LOSS_POINTS;
      }

      // mantingal top10
      const top10 = Object.entries(playerRatings)
        .sort((a, b) => b[1] - a[1])
        .slice(0, 10)
        .map(([n]) => n);

      for (const name of top10) {
        const p = players.find((x) => x.name === name);
        if (!martingale[name])
          martingale[name] = {
            stake: START_STAKE,
            totalStake: 0,
            totalWin: 0,
            active: true,
          };

        const s = martingale[name];
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

      // reset hráčov mimo top10
      for (const name in martingale) {
        if (!top10.includes(name)) {
          martingale[name].stake = START_STAKE;
          martingale[name].active = false;
        }
      }
    }

    const martingaleSummary = {
      totalStaked: totalStaked.toFixed(2),
      totalReturn: totalWin.toFixed(2),
      profit: (totalWin - totalStaked).toFixed(2),
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
    res.status(500).json({ error: "Chyba pri načítaní zápasov" });
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

app.listen(PORT, "0.0.0.0", () => {
  console.log(`✅ Server beží na http://localhost:${PORT}`);
});
