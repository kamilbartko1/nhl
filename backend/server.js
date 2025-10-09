import express from "express";
import axios from "axios";
import cors from "cors";
import path from "path";
import { fileURLToPath } from "url";

const app = express();
const PORT = 3000;

// __dirname pre ES modules
const __filename = fileURLToPath(import.meta.url);
const __dirname = path.dirname(__filename);

// ========================= KONFIGURÁCIA =========================
const API_KEY = "WaNt9YL5305o4hT2iGrsnoxUhegUG0St1ZYcs11g";

// RATING – parametre
const START_RATING = 1500;
const PLAYER_GOAL_POINTS = 20;
const PLAYER_ASSIST_POINTS = 10;
const TEAM_GOAL_POINTS = 10;
const WIN_POINTS = 10;
const LOSS_POINTS = -10;

// MANTINGAL
const MANTINGALE_ODDS = 2.5;
const MANTINGALE_START_STAKE = 1;

// Middleware
app.use(cors());
app.use(express.json());
app.use(express.static(path.join(__dirname, "../frontend")));

// ========================= POMOCNÉ FUNKCIE =========================

// zoradenie zápasov
const sortByStartTimeAsc = (matches) =>
  [...matches].sort(
    (a, b) => new Date(a.scheduled).getTime() - new Date(b.scheduled).getTime()
  );

// extrakcia hráčov z boxscore
function extractPlayersFromBoxscore(box) {
  const players = [];

  // home + away
  ["home", "away"].forEach((side) => {
    const team = box?.[side];
    if (!team) return;

    // leaders
    if (team.leaders) {
      Object.values(team.leaders).forEach((arr) => {
        if (Array.isArray(arr)) {
          arr.forEach((p) => {
            const id =
              p.id || p.reference || p.sr_id || `${p.first_name}_${p.last_name}`;
            const name =
              p.full_name ||
              `${p.first_name || ""} ${p.last_name || ""}`.trim() ||
              "Neznámy hráč";
            const g = p.statistics?.total?.goals ?? 0;
            const a = p.statistics?.total?.assists ?? 0;
            players.push({ id, name, goals: g, assists: a });
          });
        }
      });
    }

    // players
    if (Array.isArray(team.players)) {
      team.players.forEach((p) => {
        const id =
          p.id || p.reference || p.sr_id || `${p.first_name}_${p.last_name}`;
        const name =
          p.full_name ||
          `${p.first_name || ""} ${p.last_name || ""}`.trim() ||
          "Neznámy hráč";
        const g = p.statistics?.total?.goals ?? 0;
        const a = p.statistics?.total?.assists ?? 0;
        players.push({ id, name, goals: g, assists: a });
      });
    }
  });

  // zlúči duplicity
  const merged = {};
  for (const p of players) {
    if (!merged[p.id])
      merged[p.id] = { id: p.id, name: p.name, goals: 0, assists: 0 };
    merged[p.id].goals += p.goals;
    merged[p.id].assists += p.assists;
  }

  return Object.values(merged);
}

// ========================= ENDPOINTY =========================

// 📊 HLAVNÝ ENDPOINT – /api/matches
app.get("/api/matches", async (req, res) => {
  try {
    const scheduleUrl = `https://api.sportradar.com/nhl/trial/v7/en/games/2025/REG/schedule.json?api_key=${API_KEY}`;
    const scheduleResp = await axios.get(scheduleUrl);
    let matches = scheduleResp.data.games || [];

    // len ukončené alebo prebiehajúce zápasy
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
          console.warn(`⚠️ Boxscore chyba: ${m.id}`);
          return m;
        }
      })
    );

    // zoskupiť podľa dátumu
    const grouped = {};
    matchesWithStats.forEach((m) => {
      const d = new Date(m.scheduled).toISOString().slice(0, 10);
      if (!grouped[d]) grouped[d] = [];
      grouped[d].push(m);
    });

    const days = Object.keys(grouped).sort((a, b) => new Date(b) - new Date(a));
    const rounds = days.map((day) => ({ date: day, matches: grouped[day] }));

    // výpočty ratingov a mantingalu
    const ordered = sortByStartTimeAsc(matchesWithStats);
    const teamRatings = {};
    const playerRatings = {};
    const playerNames = {};
    const martingale = new Map();

    let totalStaked = 0;
    let totalReturn = 0;

    for (const match of ordered) {
      if (match.status !== "closed" && match.status !== "complete") continue;

      // hráči
      const players = extractPlayersFromBoxscore(match.statistics);
      for (const p of players) {
        playerNames[p.id] = p.name;
        if (!playerRatings[p.id]) playerRatings[p.id] = START_RATING;
        playerRatings[p.id] +=
          p.goals * PLAYER_GOAL_POINTS + p.assists * PLAYER_ASSIST_POINTS;
      }

      // tímy
      const home = match.home?.name || "Domáci";
      const away = match.away?.name || "Hostia";
      const hScore = match.home_points ?? 0;
      const aScore = match.away_points ?? 0;

      if (!teamRatings[home]) teamRatings[home] = START_RATING;
      if (!teamRatings[away]) teamRatings[away] = START_RATING;

      teamRatings[home] += hScore * TEAM_GOAL_POINTS - aScore * TEAM_GOAL_POINTS;
      teamRatings[away] += aScore * TEAM_GOAL_POINTS - hScore * TEAM_GOAL_POINTS;

      if (hScore > aScore) {
        teamRatings[home] += WIN_POINTS;
        teamRatings[away] += LOSS_POINTS;
      } else if (aScore > hScore) {
        teamRatings[away] += WIN_POINTS;
        teamRatings[home] += LOSS_POINTS;
      }

      // Mantingal logika
      const top3 = Object.entries(playerRatings)
        .sort((a, b) => b[1] - a[1])
        .slice(0, 3)
        .map(([id]) => id);

      const playerIds = new Set(players.map((p) => p.id));

      // zvýšenie stávok
      top3.forEach((pid) => {
        if (playerIds.has(pid)) {
          if (!martingale.has(pid))
            martingale.set(pid, { stake: MANTINGALE_START_STAKE });
          totalStaked += martingale.get(pid).stake;
        }
      });

      // vyhodnotenie zápasu
      top3.forEach((pid) => {
        if (!playerIds.has(pid)) return;
        const p = players.find((x) => x.id === pid);
        const scored = p && p.goals > 0;
        const s = martingale.get(pid);
        if (scored) {
          totalReturn += s.stake * MANTINGALE_ODDS;
          martingale.set(pid, { stake: MANTINGALE_START_STAKE });
        } else {
          martingale.set(pid, { stake: s.stake * 2 });
        }
      });
    }

    // ID -> meno
    const playerRatingsByName = {};
    for (const [id, rating] of Object.entries(playerRatings)) {
      const name = playerNames[id] || id;
      playerRatingsByName[name] = rating;
    }

    // sumar mantingalu
    const martingaleSummary = {
      totalStaked: totalStaked.toFixed(2),
      totalReturn: totalReturn.toFixed(2),
      profit: (totalReturn - totalStaked).toFixed(2),
      odds: MANTINGALE_ODDS,
    };

    res.json({
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
});

// 📄 DETAIL ZÁPASU – /api/match-details
app.get("/api/match-details", async (req, res) => {
  try {
    const { gameId } = req.query;
    const url = `https://api.sportradar.com/nhl/trial/v7/en/games/${gameId}/boxscore.json?api_key=${API_KEY}`;
    const r = await axios.get(url);
    res.json(r.data);
  } catch (err) {
    console.error(err.message);
    res.status(500).json({ error: "Chyba pri načítaní detailov zápasu" });
  }
});

// ========================= ŠTART SERVERA =========================
app.listen(PORT, "0.0.0.0", () => {
  console.log(`✅ Server beží na http://localhost:${PORT}`);
});
