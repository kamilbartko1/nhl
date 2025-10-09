// api/matches.js
import axios from "axios";

const API_KEY = "WaNt9YL5305o4hT2iGrsnoxUhegUG0St1ZYcs11g";

// Rating
const START_RATING = 1500;
const PLAYER_GOAL_POINTS = 20;
const PLAYER_ASSIST_POINTS = 10;
const TEAM_GOAL_POINTS = 10;
const WIN_POINTS = 10;
const LOSS_POINTS = -10;

// Mantingal
const ODDS = 2.5;
const START_STAKE = 1;

// Pomocná funkcia – načítanie hráčov z boxscore (len players)
function extractPlayers(box) {
  const result = [];
  if (!box) return result;

  const teams = [box.home, box.away];
  for (const t of teams) {
    if (!Array.isArray(t?.players)) continue;
    for (const p of t.players) {
      const name =
        p.full_name ||
        `${p.first_name || ""} ${p.last_name || ""}`.trim();
      const goals = p.statistics?.total?.goals ?? 0;
      const assists = p.statistics?.total?.assists ?? 0;
      if (name) result.push({ name, goals, assists });
    }
  }

  // agregácia bez duplikátov
  const merged = {};
  for (const p of result) {
    if (!merged[p.name]) merged[p.name] = { goals: 0, assists: 0 };
    merged[p.name].goals += p.goals;
    merged[p.name].assists += p.assists;
  }
  return Object.entries(merged).map(([name, v]) => ({ name, ...v }));
}

export default async function handler(req, res) {
  try {
    const url = `https://api.sportradar.com/nhl/trial/v7/en/seasons/4a67cca6-b450-45f9-91c6-48e92ac19069/schedule.json?api_key=${API_KEY}`;
    const r = await axios.get(url);
    const allGames = r.data.games || [];

    const played = allGames.filter((g) =>
      ["closed", "complete", "final"].includes(g.status)
    );

    // === INIT ===
    const teamRatings = {};
    const playerRatings = {};
    const state = {}; // pre mantingal

    let totalStakes = 0;
    let totalWins = 0;

    // === SPRACOVANIE ZÁPASOV PO JEDNOM ===
    for (const g of played) {
      const boxUrl = `https://api.sportradar.com/nhl/trial/v7/en/games/${g.id}/boxscore.json?api_key=${API_KEY}`;
      let box;
      try {
        const br = await axios.get(boxUrl);
        box = br.data;
      } catch {
        continue;
      }

      const players = extractPlayers(box);

      // aktualizuj ratingy hráčov
      for (const p of players) {
        if (!playerRatings[p.name]) playerRatings[p.name] = START_RATING;
        playerRatings[p.name] +=
          p.goals * PLAYER_GOAL_POINTS + p.assists * PLAYER_ASSIST_POINTS;
      }

      // aktualizuj ratingy tímov
      const hName = box.home?.market + " " + box.home?.name || "Domáci";
      const aName = box.away?.market + " " + box.away?.name || "Hostia";
      const hScore = box.home?.points ?? 0;
      const aScore = box.away?.points ?? 0;

      if (!teamRatings[hName]) teamRatings[hName] = START_RATING;
      if (!teamRatings[aName]) teamRatings[aName] = START_RATING;

      teamRatings[hName] += hScore * TEAM_GOAL_POINTS - aScore * TEAM_GOAL_POINTS;
      teamRatings[aName] += aScore * TEAM_GOAL_POINTS - hScore * TEAM_GOAL_POINTS;
      if (hScore > aScore) {
        teamRatings[hName] += WIN_POINTS;
        teamRatings[aName] += LOSS_POINTS;
      } else if (aScore > hScore) {
        teamRatings[aName] += WIN_POINTS;
        teamRatings[hName] += LOSS_POINTS;
      }

      // === Mantingal ===
      const top3 = Object.entries(playerRatings)
        .sort((a, b) => b[1] - a[1])
        .slice(0, 3)
        .map(([name]) => name);

      for (const name of top3) {
        const p = players.find((pl) => pl.name === name);
        if (!state[name]) {
          state[name] = { stake: START_STAKE, totalStake: 0, totalWin: 0, last: "—" };
        }
        if (p) {
          const s = state[name];
          s.totalStake += s.stake;
          if (p.goals > 0) {
            s.totalWin += s.stake * ODDS;
            s.stake = START_STAKE;
            s.last = "✅ výhra";
          } else {
            s.stake *= 2;
            s.last = "❌ prehra";
          }
          totalStakes += s.totalStake;
          totalWins += s.totalWin;
        }
      }
    }

    const summary = {
      totalStaked: totalStakes.toFixed(2),
      totalReturn: totalWins.toFixed(2),
      profit: (totalWins - totalStakes).toFixed(2),
      odds: ODDS,
    };

    res.status(200).json({
      matches: played,
      teamRatings,
      playerRatings,
      martingale: { summary },
    });
  } catch (e) {
    console.error("❌ Chyba pri výpočte NHL:", e.message);
    res.status(500).json({ error: "NHL výpočet zlyhal" });
  }
}
