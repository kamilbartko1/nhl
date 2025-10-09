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

app.use(cors());
app.use(express.json());

// sprístupni frontend
app.use(express.static(path.join(__dirname, "../frontend")));

// zoradenie zápasov podľa času
function sortByStartTimeAsc(matches) {
  return [...matches].sort((a, b) => {
    const ta = new Date(a.scheduled).getTime() || 0;
    const tb = new Date(b.scheduled).getTime() || 0;
    return ta - tb;
  });
}

// Pomocník: vyber hráčov z rôznych možných miest
function pickPlayers(node) {
  if (!node || typeof node !== "object") return [];
  if (Array.isArray(node.players)) return node.players;
  if (node.statistics && Array.isArray(node.statistics.players)) return node.statistics.players;
  if (node.team && Array.isArray(node.team.players)) return node.team.players;
  return [];
}

// ====================== ENDPOINTY ======================

// >>> zladené s frontendom: /api/matches
app.get("/api/matches", async (req, res) => {
  try {
    const url = `https://api.sportradar.com/nhl/trial/v7/en/games/2025/REG/schedule.json?api_key=${API_KEY}`;
    const response = await axios.get(url);
    let matches = response.data.games || [];

    // len ukončené zápasy (frontend zobrazí ✅)
    matches = matches.filter(m =>
      ["closed", "complete", "final"].includes(m.status)
    );

    // načítaj boxscore a NORMALIZUJ štruktúru
    const matchesWithStats = await Promise.all(
      matches.map(async (m) => {
        try {
          const boxUrl = `https://api.sportradar.com/nhl/trial/v7/en/games/${m.id}/boxscore.json?api_key=${API_KEY}`;
          const box = await axios.get(boxUrl);
          const boxData = box.data || {};

          // Zachovaj maximum z originálu + DOPLŇ players tam, kde ich frontend čaká
          const homeRaw = boxData.home || boxData.statistics?.home || {};
          const awayRaw = boxData.away || boxData.statistics?.away || {};

          const homePlayers = pickPlayers(homeRaw);
          const awayPlayers = pickPlayers(awayRaw);

          m.statistics = {
            home: { ...homeRaw, players: homePlayers },
            away: { ...awayRaw, players: awayPlayers },
          };
        } catch {
          // ak boxscore padne, nechaj aspoň prázdnu štruktúru
          m.statistics = { home: { players: [] }, away: { players: [] } };
        }
        return m;
      })
    );

    // --- výpočty ratingov + sumar mantingalu (server strana – voliteľné, frontend si tiež ráta svoje) ---
    const teamRatings = {};
    const playerRatings = {};
    const martingaleState = {};
    let totalStaked = 0;
    let totalReturn = 0;

    const ordered = sortByStartTimeAsc(matchesWithStats);

    for (const match of ordered) {
      const s = match.statistics || {};
      const allPlayers = [
        ...(s.home?.players || []),
        ...(s.away?.players || []),
      ];

      // --- hráči (20 za gól, 10 za asistenciu) ---
      for (const p of allPlayers) {
        const name = p.full_name || `${p.first_name || ""} ${p.last_name || ""}`.trim();
        const g = p?.statistics?.total?.goals ?? p?.statistics?.goals ?? 0;
        const a = p?.statistics?.total?.assists ?? p?.statistics?.assists ?? 0;
        if (!name) continue;
        if (!playerRatings[name]) playerRatings[name] = START_RATING;
        playerRatings[name] += g * PLAYER_GOAL_POINTS + a * PLAYER_ASSIST_POINTS;
      }

      // --- tímy ---
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

      // --- Mantingal server-side (top10 v danom momente) – len sumar, frontend robí detail ---
      const currentTop10 = Object.entries(playerRatings)
        .sort((a, b) => b[1] - a[1])
        .slice(0, 10)
        .map(([n]) => n);

      for (const name of currentTop10) {
        const p = allPlayers.find(x =>
          (x.full_name || `${x.first_name || ""} ${x.last_name || ""}`.trim()) === name
        );

        if (!martingaleState[name]) {
          martingaleState[name] = { stake: MANTINGALE_START_STAKE, totalStake: 0, totalWin: 0, active: true };
        }
        const sState = martingaleState[name];

        if (p) {
          sState.totalStake += sState.stake;
          totalStaked += sState.stake;

          const goals = p?.statistics?.total?.goals ?? p?.statistics?.goals ?? 0;
          if (goals > 0) {
            const win = sState.stake * MANTINGALE_ODDS;
            sState.totalWin += win;
            totalReturn += win;
            sState.stake = MANTINGALE_START_STAKE;
          } else {
            sState.stake *= 2;
          }
        }
      }

      // reset pre hráčov, čo z top10 vypadli (zastaví sa im séria)
      Object.keys(martingaleState).forEach(n => {
        if (!currentTop10.includes(n)) {
          martingaleState[n].stake = MANTINGALE_START_STAKE;
          martingaleState[n].active = false;
        }
      });
    }

    const martingaleSummary = {
      totalStaked: Number(totalStaked.toFixed(2)),
      totalReturn: Number(totalReturn.toFixed(2)),
      profit: Number((totalReturn - totalStaked).toFixed(2)),
      odds: MANTINGALE_ODDS,
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

// >>> zladené s frontendom: /api/match-details?gameId=...
app.get("/api/match-details", async (req, res) => {
  try {
    const { gameId } = req.query;
    const url = `https://api.sportradar.com/nhl/trial/v7/en/games/${gameId}/boxscore.json?api_key=${API_KEY}`;
    const r = await axios.get(url);
    const box = r.data || {};

    // pre istotu normalizácia aj tu
    const homeRaw = box.home || box.statistics?.home || {};
    const awayRaw = box.away || box.statistics?.away || {};
    const homePlayers = pickPlayers(homeRaw);
    const awayPlayers = pickPlayers(awayRaw);

    const normalized = {
      ...box,
      home: { ...homeRaw, players: homePlayers },
      away: { ...awayRaw, players: awayPlayers },
    };

    res.json(normalized);
  } catch (err) {
    console.error(err.message);
    res.status(500).json({ error: "Chyba pri načítaní detailov zápasu" });
  }
});

// ====================== SERVER START ======================
app.listen(PORT, "0.0.0.0", () => {
  console.log(`✅ Server beží na http://localhost:${PORT}`);
});
