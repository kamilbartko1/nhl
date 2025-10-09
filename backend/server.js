import express from "express";
import axios from "axios";
import cors from "cors";
import path from "path";
import { fileURLToPath } from "url";

const app = express();
const PORT = 3000;

// --- pre __dirname (v ES modules) ---
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

// 👉 sprístupní frontend
app.use(express.static(path.join(__dirname, "../frontend")));

// pomocná funkcia: zoradenie zápasov
function sortByStartTimeAsc(matches) {
  return [...matches].sort((a, b) => {
    const ta = new Date(a.scheduled).getTime() || 0;
    const tb = new Date(b.scheduled).getTime() || 0;
    return ta - tb;
  });
}

// ====================== ENDPOINTY ======================

// všetky zápasy + ratingy + Mantingal simulácia
app.get("/matches", async (req, res) => {
  try {
    const url = `https://api.sportradar.com/nhl/trial/v7/en/games/2025/REG/schedule.json?api_key=${API_KEY}`;
    const response = await axios.get(url);
    let matches = response.data.games || [];

    // ⚡ filter: len odohrané zápasy
    matches = matches.filter(
      (m) => m.status === "closed" || m.status === "complete"
    );

    // 🟢 doplň detailné štatistiky (boxscore) pre každý zápas
    const matchesWithStats = await Promise.all(
      matches.map(async (m) => {
        try {
          const gameId = m.id;
          const detailsUrl = `https://api.sportradar.com/nhl/trial/v7/en/games/${gameId}/boxscore.json?api_key=${API_KEY}`;
          const det = await axios.get(detailsUrl);
          m.statistics = det.data;
          return m;
        } catch {
          return m;
        }
      })
    );

    // zoskupiť podľa dátumu (YYYY-MM-DD)
    const grouped = {};
    matchesWithStats.forEach((m) => {
      const date = new Date(m.scheduled).toISOString().slice(0, 10);
      if (!grouped[date]) grouped[date] = [];
      grouped[date].push(m);
    });

    // zoradené dni od najnovšieho po najstarší
    const days = Object.keys(grouped).sort((a, b) => new Date(b) - new Date(a));

    // pridať čísla kôl
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

    // --- výpočty ratingov a mantingalu ---
    const ordered = sortByStartTimeAsc(matchesWithStats);

    const teamRatings = {};
    const playerRatingsById = {};
    const playerNamesById = {};
    const martingaleState = new Map();

    let totalStaked = 0;
    let totalReturn = 0;

    // pomocná funkcia – získa hráčov z boxscore
    const getMatchPlayers = (match) => {
      const list = [];
      const comps = [
        match?.statistics?.home,
        match?.statistics?.away,
      ].filter(Boolean);

      comps.forEach((team) => {
        (team.players || []).forEach((p) => {
          if (p?.id) {
            playerNamesById[p.id] =
              p.full_name || p.name || `${p.first_name || ""} ${p.last_name || ""}`.trim();
            list.push(p);
          }
        });
      });
      return list;
    };

    for (const match of ordered) {
      const status = match?.status;
      if (status !== "closed" && status !== "complete") continue;

      // === Mantingal: aktuálna TOP10 podľa dovtedajších ratingov ===
      const currentTop10 = Object.entries(playerRatingsById)
        .sort((a, b) => b[1] - a[1])
        .slice(0, 10)
        .map(([id]) => id);

      const matchPlayers = getMatchPlayers(match);
      const playersInMatchIds = new Set(matchPlayers.map((p) => p.id));

      // --- STÁVKY: iba ak hráč z TOP10 hral tento zápas ---
      currentTop10.forEach((pid) => {
        if (playersInMatchIds.has(pid)) {
          if (!martingaleState.has(pid)) {
            martingaleState.set(pid, {
              stake: MANTINGALE_START_STAKE,
              lastOutcome: null,
              active: true,
            });
          } else {
            martingaleState.get(pid).active = true;
          }
          const state = martingaleState.get(pid);
          totalStaked += state.stake;
        }
      });

      // --- GÓLY ---
      const goalsById = new Map();
      matchPlayers.forEach((p) => {
        const g = p?.statistics?.total?.goals ?? p?.statistics?.goals ?? 0;
        if (g > 0) goalsById.set(p.id, g);
      });

      // --- VYHODNOTENIE STÁVOK ---
      currentTop10.forEach((pid) => {
        if (!playersInMatchIds.has(pid)) return;
        const state = martingaleState.get(pid);
        const scored = goalsById.has(pid);
        if (scored) {
          totalReturn += state.stake * MANTINGALE_ODDS;
          martingaleState.set(pid, {
            stake: MANTINGALE_START_STAKE,
            lastOutcome: "win",
            active: true,
          });
        } else {
          martingaleState.set(pid, {
            stake: state.stake * 2,
            lastOutcome: "loss",
            active: true,
          });
        }
      });

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

      // --- RATING HRÁČOV ---
      const comps = [match?.statistics?.home, match?.statistics?.away].filter(Boolean);
      comps.forEach((team) => {
        (team.players || []).forEach((player) => {
          const pid = player.id;
          const name = player.full_name || player.name;
          if (!pid) return;
          playerNamesById[pid] = name;
          if (playerRatingsById[pid] == null) playerRatingsById[pid] = START_RATING;
          const g = player?.statistics?.total?.goals ?? player?.statistics?.goals ?? 0;
          const a = player?.statistics?.total?.assists ?? player?.statistics?.assists ?? 0;
          playerRatingsById[pid] += g * PLAYER_GOAL_POINTS + a * PLAYER_ASSIST_POINTS;
        });
      });

      // hráči, ktorí už NIE sú v TOP10, ale boli, sa deaktivujú (pauza stávok)
      for (const [pid, st] of martingaleState.entries()) {
        if (!currentTop10.includes(pid)) {
          martingaleState.set(pid, {
            stake: MANTINGALE_START_STAKE,
            lastOutcome: st.lastOutcome,
            active: false,
          });
        }
      }
    }

    const playerRatingsByName = {};
    Object.entries(playerRatingsById).forEach(([pid, rating]) => {
      const name = playerNamesById[pid] || pid;
      playerRatingsByName[name] = rating;
    });

    const nowTop10Ids = Object.entries(playerRatingsById)
      .sort((a, b) => b[1] - a[1])
      .slice(0, 10)
      .map(([id]) => id);

    const martingaleTop10 = nowTop10Ids.map((pid) => {
      const state =
        martingaleState.get(pid) || {
          stake: MANTINGALE_START_STAKE,
          lastOutcome: null,
          active: true,
        };
      return {
        id: pid,
        name: playerNamesById[pid] || pid,
        stake: state.stake,
        lastOutcome: state.lastOutcome,
        active: state.active,
        odds: MANTINGALE_ODDS,
      };
    });

    const martingaleSummary = {
      totalStaked: Number(totalStaked.toFixed(2)),
      totalReturn: Number(totalReturn.toFixed(2)),
      profit: Number((totalReturn - totalStaked).toFixed(2)),
      odds: MANTINGALE_ODDS,
    };

    res.json({
      matches: matchesWithStats,
      rounds,
      teamRatings,
      playerRatings: playerRatingsByName,
      martingale: {
        top10: martingaleTop10,
        summary: martingaleSummary,
      },
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
    const response = await axios.get(url);
    res.json(response.data);
  } catch (err) {
    console.error(err.message);
    res.status(500).json({ error: "Chyba pri načítaní detailov zápasu" });
  }
});

// ====================== SERVER START ======================
app.listen(PORT, "0.0.0.0", () => {
  console.log(`✅ Server beží na http://localhost:${PORT}`);
});
