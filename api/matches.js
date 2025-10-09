// api/matches.js — NHL v7 -> mapovanie do „Extraliga v2“ tvaru (bez zmeny frontendu)
import axios from "axios";

const API_KEY = "WaNt9YL5305o4hT2iGrsnoxUhegUG0St1ZYcs11g";

// Konštanty na výpočty (rovnaké ako v Extralige)
const START_RATING = 1500;
const GOAL_POINTS = 10;
const WIN_POINTS = 10;
const LOSS_POINTS = -10;

const PLAYER_GOAL_POINTS = 20;
const PLAYER_ASSIST_POINTS = 10;

const MANTINGALE_ODDS = 2.5;
const MANTINGALE_START_STAKE = 1;

// Pomocné
const nhlStatusToExtraliga = (s) => {
  // NHL: "scheduled" | "inprogress" | "complete" | "closed"
  if (s === "closed" || s === "complete") return "closed";
  if (s === "inprogress") return "inprogress";
  return "scheduled";
};

const toISODate = (ts) => new Date(ts).toISOString().slice(0, 10);

export default async function handler(req, res) {
  try {
    // 1) NHl 2025 REG rozpis
    const schedUrl = `https://api.sportradar.com/nhl/trial/v7/en/games/2025/REG/schedule.json?api_key=${API_KEY}`;
    const { data: sched } = await axios.get(schedUrl);

    let games = Array.isArray(sched?.games) ? sched.games : [];

    // 2) Na ratingy/Mantingal berieme iba uzavreté
    const completedForStats = games.filter((g) =>
      ["closed", "complete"].includes(g.status)
    );

    // 3) Dotiahni boxscore len pre odohrané (šetrenie limitov + potrebné štatistiky hráčov)
    const boxById = new Map();
    await Promise.all(
      completedForStats.map(async (g) => {
        try {
          const url = `https://api.sportradar.com/nhl/trial/v7/en/games/${g.id}/boxscore.json?api_key=${API_KEY}`;
          const { data } = await axios.get(url);
          boxById.set(g.id, data);
        } catch {
          // necháme bez boxscore
        }
      })
    );

    // 4) Premapuj NHL zápasy do „extraliga summary“ tvaru
    //    - sport_event / sport_event_status / statistics.totals.competitors
    const mapped = games.map((g) => {
      const status = nhlStatusToExtraliga(g.status);
      const box = boxById.get(g.id);

      // vyrob "totals.competitors[].players[]" pre frontend (Extraliga tvar)
      const totals = { competitors: [] };

      // preferuj box.statistics.teams; fallback na home/away.players
      const teamBlocks =
        (box?.statistics?.teams && Array.isArray(box.statistics.teams)
          ? box.statistics.teams
          : null) || null;

      if (teamBlocks) {
        teamBlocks.forEach((t) => {
          const teamName =
            (t?.market ? `${t.market} ${t?.name ?? ""}`.trim() : t?.name) ||
            "Tím";
          const players = (t.players || []).map((p) => ({
            id:
              p.id ||
              p.player_id ||
              p.sr_id ||
              p.reference ||
              p.full_name ||
              p.name,
            name: p.full_name || p.name || "Neznámy hráč",
            statistics: {
              goals: p?.statistics?.goals ?? 0,
              assists: p?.statistics?.assists ?? 0,
            },
          }));
          totals.competitors.push({ name: teamName, players });
        });
      } else {
        // fallback: poskladaj z home/away.players
        const mkTeam = (sideObj, fallbackName) => {
          const teamName =
            (sideObj?.market
              ? `${sideObj.market} ${sideObj?.name ?? ""}`.trim()
              : sideObj?.name) || fallbackName;
          const players = (sideObj?.players || []).map((p) => ({
            id:
              p.id ||
              p.player_id ||
              p.sr_id ||
              p.reference ||
              p.full_name ||
              p.name,
            name: p.full_name || p.name || "Neznámy hráč",
            statistics: {
              goals: p?.statistics?.goals ?? 0,
              assists: p?.statistics?.assists ?? 0,
            },
          }));
          return { name: teamName, players };
        };

        if (box?.home || box?.away) {
          totals.competitors.push(mkTeam(box?.home, g?.home?.name || "Domáci"));
          totals.competitors.push(mkTeam(box?.away, g?.away?.name || "Hostia"));
        }
      }

      // overtime: skús odvodiť
      const overtime =
        Boolean(box?.scoring?.overtime) ||
        (Array.isArray(box?.scoring?.periods) &&
          box.scoring.periods.length > 3) ||
        false;

      return {
        sport_event: {
          id: g.id,
          start_time: g.scheduled,
          competitors: [
            { id: g.home?.id, name: g.home?.name },
            { id: g.away?.id, name: g.away?.name },
          ],
        },
        sport_event_status: {
          status, // "closed" | "inprogress" | "scheduled"
          home_score: g.home_points ?? null,
          away_score: g.away_points ?? null,
          overtime: overtime || undefined,
          ap: false,
        },
        statistics: { totals }, // presne kde to frontend očakáva
      };
    });

    // 5) Zoskupenie podľa dňa -> rounds (rovnaké ako v Extralige)
    const grouped = {};
    mapped.forEach((m) => {
      const d = toISODate(m.sport_event.start_time);
      (grouped[d] ||= []).push(m);
    });
    const daysDesc = Object.keys(grouped).sort(
      (a, b) => new Date(b) - new Date(a)
    );

    let roundCounter = daysDesc.length;
    const rounds = [];
    for (const d of daysDesc) {
      grouped[d].forEach((m) => {
        m.round = roundCounter;
        m.date = d;
      });
      rounds.push({ round: roundCounter, date: d, matches: grouped[d] });
      roundCounter--;
    }

    // 6) Výpočty ratingov + Mantingal (rovnaká logika)
    const ordered = [...mapped].sort(
      (a, b) =>
        new Date(a.sport_event.start_time) - new Date(b.sport_event.start_time)
    );

    const teamRatings = {};
    const playerRatingsById = {};
    const playerNamesById = {};
    const martingaleState = new Map();
    let totalStaked = 0;
    let totalReturn = 0;

    const getMatchPlayers = (m) => {
      const out = [];
      const comps = m?.statistics?.totals?.competitors || [];
      comps.forEach((t) => {
        (t.players || []).forEach((p) => {
          if (p?.id) {
            playerNamesById[p.id] = p.name;
            out.push(p);
          }
        });
      });
      return out;
    };

    for (const m of ordered) {
      const st = m?.sport_event_status?.status;
      if (st !== "closed" && st !== "ap") continue;

      // Top3 pred zápasom
      const currentTop3 = Object.entries(playerRatingsById)
        .sort((a, b) => b[1] - a[1])
        .slice(0, 3)
        .map(([id]) => id);

      const matchPlayers = getMatchPlayers(m);
      const playersInMatch = new Set(matchPlayers.map((p) => p.id));

      // predzápasové vsádzky
      currentTop3.forEach((pid) => {
        if (playersInMatch.has(pid)) {
          if (!martingaleState.has(pid)) {
            martingaleState.set(pid, {
              stake: MANTINGALE_START_STAKE,
              lastOutcome: null,
            });
          }
          const s = martingaleState.get(pid);
          totalStaked += s.stake;
        }
      });

      // góly
      const goalsById = new Map();
      matchPlayers.forEach((p) => {
        const g = p?.statistics?.goals ?? 0;
        if (g > 0) goalsById.set(p.id, g);
      });

      currentTop3.forEach((pid) => {
        if (!playersInMatch.has(pid)) return;
        const s = martingaleState.get(pid);
        const scored = goalsById.has(pid);
        if (scored) {
          totalReturn += s.stake * MANTINGALE_ODDS;
          martingaleState.set(pid, {
            stake: MANTINGALE_START_STAKE,
            lastOutcome: "win",
          });
        } else {
          martingaleState.set(pid, {
            stake: s.stake * 2,
            lastOutcome: "loss",
          });
        }
      });

      // tímové ratingy
      const homeName = m.sport_event.competitors?.[0]?.name || "Domáci";
      const awayName = m.sport_event.competitors?.[1]?.name || "Hostia";
      const homeScore = m.sport_event_status.home_score ?? 0;
      const awayScore = m.sport_event_status.away_score ?? 0;

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

      // hráči
      matchPlayers.forEach((p) => {
        const pid = p.id;
        const name = p.name;
        if (!pid) return;
        playerNamesById[pid] = name;
        if (playerRatingsById[pid] == null) playerRatingsById[pid] = START_RATING;
        const g = p?.statistics?.goals ?? 0;
        const a = p?.statistics?.assists ?? 0;
        playerRatingsById[pid] += g * PLAYER_GOAL_POINTS + a * PLAYER_ASSIST_POINTS;
      });
    }

    // pre frontend: playerRatings podľa mena
    const playerRatings = {};
    Object.entries(playerRatingsById).forEach(([pid, rating]) => {
      const name = playerNamesById[pid] || pid;
      playerRatings[name] = rating;
    });

    // Mantingal top3 + summary (ako doteraz)
    const nowTop3Ids = Object.entries(playerRatingsById)
      .sort((a, b) => b[1] - a[1])
      .slice(0, 3)
      .map(([id]) => id);

    const martingaleTop3 = nowTop3Ids.map((pid) => {
      const s =
        martingaleState.get(pid) || {
          stake: MANTINGALE_START_STAKE,
          lastOutcome: null,
        };
      return {
        id: pid,
        name: playerNamesById[pid] || pid,
        stake: s.stake,
        lastOutcome: s.lastOutcome,
        odds: MANTINGALE_ODDS,
      };
    });

    const martingaleSummary = {
      totalStaked: Number(totalStaked.toFixed(2)),
      totalReturn: Number(totalReturn.toFixed(2)),
      profit: Number((totalReturn - totalStaked).toFixed(2)),
      odds: MANTINGALE_ODDS,
    };

    // 7) Odpoveď v tvare, ktorý už frontend používa (nič netreba meniť)
    res.status(200).json({
      matches: mapped,
      rounds,
      teamRatings,
      playerRatings,
      martingale: { top3: martingaleTop3, summary: martingaleSummary },
    });
  } catch (err) {
    console.error("Chyba pri načítaní NHL zápasov:", err?.message || err);
    res.status(500).json({ error: "Chyba pri načítaní zápasov NHL" });
  }
}
