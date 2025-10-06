import axios from "axios";

const API_KEY = "WaNt9YL5305o4hT2iGrsnoxUhegUG0St1ZYcs11g";

export default async function handler(req, res) {
  try {
    const { homeId, awayId } = req.query; // teraz parametre idú cez query string
    const url = `https://api.sportradar.com/icehockey/trial/v2/en/competitors/${homeId}/versus/${awayId}/summaries.json?api_key=${API_KEY}`;
    const response = await axios.get(url);

    const lastMeeting = response.data.last_meetings?.[0];
    if (!lastMeeting) {
      return res.status(404).json({ error: "Žiadny zápas nenájdený" });
    }

    res.status(200).json(lastMeeting);
  } catch (err) {
    console.error(err.message);
    res.status(500).json({ error: "Chyba pri načítaní detailov zápasu" });
  }
}
