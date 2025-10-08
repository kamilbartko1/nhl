import axios from "axios";

const API_KEY = "WaNt9YL5305o4hT2iGrsnoxUhegUG0St1ZYcs11g";
const API_URL = `https://api.sportradar.com/nhl/trial/v7/en/games/2025/REG/schedule.json?api_key=${API_KEY}`;

// --- konfigurácie pre výpočty ---
const START_RATING = 1500;
const GOAL_POINTS = 10;
const WIN_POINTS = 10;
const LOSS_POINTS = -10;
const PLAYER_GOAL_POINTS = 20;
const PLAYER_ASSIST_POINTS = 10;
const MANTINGALE_ODDS = 2.5;
const MANTINGALE_START_STAKE = 1;

export default async function handler(req, res) {
  try {
    const { data } = await axios.get(API_URL);
    let matches = data.games || [];

    // iba odohrané zápasy
    matches = matches.filter(m =>
      ["closed", "complete"].includes(m.status)
    );

    // načítanie boxscore
    const matchesWithStats = await Promise.all(
      matches.map(async m => {
        try {
          const det = await axios.get(
            `https://api.sportradar.com/nhl/trial/v7/en/games/${m.id}/boxscore.json?api_key=${API_KEY}`
          );
          m.statistics = det.data;
          return m;
        } catch {
          return m;
        }
      })
    );

    // ratingy a mantingal
    const teamRatings = {};
    const playerRatings = {};
    const playerNames = {};
    const martingale = new Map();
    let totalStake = 0, totalReturn = 0;

    for (const match of matchesWithStats) {
      const home = match.home.name;
      const away = match.away.name;
      const homeScore = match.home_points ?? 0;
      const awayScore = match.away_points ?? 0;

      if (!teamRatings[home]) teamRatings[home] = START_RATING;
      if (!teamRatings[away]) teamRatings[away] = START_RATING;

      teamRatings[home] += homeScore * GOAL_POINTS - awayScore * GOAL_POINTS;
      teamRatings[away] += awayScore * GOAL_POINTS - homeScore * GOAL_POINTS;

      if (homeScore > awayScore) {
        teamRatings[home] += WIN_POINTS;
        teamRatings[away] += LOSS_POINTS;
      } else if (awayScore > homeScore) {
        teamRatings[away] += WIN_POINTS;
        teamRatings[home] += LOSS_POINTS;
      }
    }

    res.status(200).json({
      matches: matchesWithStats,
      teamRatings,
      playerRatings,
      martingale: {
        summary: {
          totalStaked: totalStake,
          totalReturn,
          profit: totalReturn - totalStake,
          odds: MANTINGALE_ODDS,
        },
      },
    });
  } catch (err) {
    console.error("❌ Chyba pri načítaní NHL zápasov:", err.message);
    res.status(500).json({ error: "Chyba pri načítaní zápasov NHL" });
  }
}
