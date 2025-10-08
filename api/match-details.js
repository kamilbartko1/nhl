// dopisem si tu nieco, aby som poznacil svoj kod
// api/match-details.js
import axios from "axios";

const API_KEY = "WaNt9YL5305o4hT2iGrsnoxUhegUG0St1ZYcs11g";

export default async function handler(req, res) {
  try {
    const { gameId } = req.query;
    if (!gameId) {
      return res.status(400).json({ error: "Chýba gameId parameter" });
    }

    const url = `https://api.sportradar.com/nhl/trial/v7/en/games/${gameId}/boxscore.json?api_key=${API_KEY}`;
    const response = await axios.get(url);
    res.status(200).json(response.data);
  } catch (err) {
    console.error("Chyba pri načítaní detailov zápasu:", err.message);
    res.status(500).json({ error: "Chyba pri načítaní detailov zápasu" });
  }
}
