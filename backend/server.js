import express from "express";
import axios from "axios";
import cors from "cors";
import path from "path";
import { fileURLToPath } from "url";

const app = express();
const PORT = 3000;

// fix __dirname pre ES modules
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
app.use(express.static(path.join(__dirname, "../frontend")));

/**
 * Extrahuje hráčov z boxscore (iba home/away.players)
 */
function extractPlayers(box) {
  const list = [];
  if (!box) return list;
  [box.home, box.away].forEach((team) => {
    if (!Array.isArray(team?.players)) return;
    for (const p of team.players) {
      const name =
        p.full_name ||
        `${p.first_name || ""} ${p.last_name || ""}`.trim();
      const goals = p?.statistics?.total?.goals ?? 0;
      const assists = p?.statistics?.total?.assists ?? 0;
      if (name) list.push({ name, goals, assists });
    }
  });
  // zlúči duplicity (ak sa hráč opakuje)
  const merged = {};
  for (const p of list) {
    if (!merged[p.name]) merged[p.name] = { goals: 0, assists: 0 };
    merged[p.name].goals += p.goals;
    merged[p.name].assists += p.assists;
  }
  return Object.entries(merged).map(([name, v]) => ({ name, ...v }));
}

/** zoradenie zápasov podľa času */
const sortByTime = (arr) => [...arr].sort((a, b) => new Date(a.scheduled) - new Date(b.scheduled));

// ====================== ENDPOINTY ======================

// hlavný endpoint
app.get("/api/matches", async (req, res) => {
  try {
    // 🟩 Načítaj rozpis zápasov
    const scheduleUrl = `https://api.sportradar.com/nhl/trial/v7/en/seasons/4a67cca6-b450-45f9-91c6-48e92ac19069/schedule.json?api_key=${API_KEY}`;
    const r = await axios.get(scheduleUrl);
    let matches = r.data.games || [];

    // filtrujeme len ukončené zápasy
    matches = matches.filter((m) =>
      ["closed", "complete", "final"].includes(m.status)
    );

    // 🟩 Načítaj boxscore pre každý zápas
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

    const teamRatings = {};
    const playerRatings = {};
    const mantingal = {};
    let totalStaked = 0;
    let totalWon = 0;

    const ordered = sortByTime(matchesWithStats);

    // 🟩 Prejdi každý zápas
    for (const match of ordered) {
      const players = extractPlayers(match.statistics);

      // --- RATING HRÁČOV ---
      for (const p of players) {
        if (!playerRatings[p.name]) playerRatings[p.name] = START_RATING;
        playerRatings[p.name] += p.goals * PLAYER_GOAL_POINTS + p.assists * PLAYER_ASSIST_POINTS;
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
        const s = mantingal[name] || { stake: START_STAKE, totalStake: 0, totalWin: 0 };
        const p = players.find((x) => x.name === name);
        if (p) {
          s.totalStake += s.stake;
          totalStaked += s.stake;
          if (p.goals > 0) {
            const win = s.stake * ODDS;
            s.totalWin += win;
            totalWon += win;
            s.stake = START_STAKE;
          } else {
            s.stake *= 2;
          }
        }
        mantingal[name] = s;
      }
    }

    const martingaleSummary = {
      totalStaked: totalStaked.toFixed(2),
      totalReturn: totalWon.toFixed(2),
      profit: (totalWon - totalStaked).toFixed(2),
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
    res.status(500).json({ error: "Nepodarilo sa načítať zápasy" });
  }
});

// detail zápasu
app.get("/api/match-details", async (req, res) => {
  try {
    const { gameId } = req.query;
    const url = `https://api.sportradar.com/nhl/trial/v7/en/games/${gameId}/boxscore.json?api_key=${API_KEY}`;
    const r = await axios.get(url);
    res.json(r.data);
  } catch {
    res.status(500).json({ error: "Chyba pri načítaní detailu zápasu" });
  }
});

app.listen(PORT, "0.0.0.0", () =>
  console.log(`✅ Server beží na http://localhost:${PORT}`)
);
