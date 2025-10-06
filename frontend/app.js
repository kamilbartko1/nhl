// app.js
//toto je petov komentar
//toto je Kamilov komentar
let teamRatings = {};
let playerRatings = {};
let allMatches = [];

const BASE_STAKE = 1;
const ODDS = 2.5;

// načítanie zápasov
async function fetchMatches() {
    try {
        const response = await fetch("http://localhost:3000/matches");
        const data = await response.json();

        // uložíme všetky zápasy
        allMatches = data.matches || [];

        const matches = allMatches.map(match => ({
            home_id: match.sport_event.competitors[0].id,
            away_id: match.sport_event.competitors[1].id,
            home_team: match.sport_event.competitors[0].name,
            away_team: match.sport_event.competitors[1].name,
            home_score: match.sport_event_status.home_score,
            away_score: match.sport_event_status.away_score,
            status: match.sport_event_status.status,
            overtime: match.sport_event_status.overtime,
            ap: match.sport_event_status.ap
        }));

        displayMatches(matches);

        teamRatings = data.teamRatings || {};
        playerRatings = data.playerRatings || {};

        displayTeamRatings();
        displayPlayerRatings();
        displayMantingal(); // korektný prepočet z histórie + denník
    } catch (err) {
        console.error("Chyba pri načítaní zápasov:", err);
    }
}

// zobrazenie zápasov (klik na riadok otvorí detaily)
function displayMatches(matches) {
    const tableBody = document.querySelector("#matches tbody");
    tableBody.innerHTML = "";

    matches.forEach(match => {
        const homeScore = match.home_score ?? "-";
        const awayScore = match.away_score ?? "-";

        const row = document.createElement("tr");

        let statusText = "";
        if (match.status === "closed") {
            statusText = match.overtime || match.ap ? "✅ PP" : "✅";
        } else if (match.status === "ap") {
            statusText = "✅ PP";
        } else if (match.status === "not_started") {
            statusText = "⏳";
        }

        row.innerHTML = `
            <td>${match.home_team}</td>
            <td>${match.away_team}</td>
            <td>${homeScore} : ${awayScore}</td>
            <td>${statusText}</td>
        `;

        // klikateľnosť pre každý zápas
        row.style.cursor = "pointer";
        row.addEventListener("click", async () => {
            const existingDetails = row.nextElementSibling;
            if (existingDetails && existingDetails.classList.contains("details-row")) {
                existingDetails.remove(); // zroluj späť
                return;
            }

            try {
                const endpoint = `http://localhost:3000/match-details/${match.home_id}/${match.away_id}`;
                const response = await fetch(endpoint);
                const data = await response.json();

                // odstráň staré detaily
                document.querySelectorAll(".details-row").forEach(el => el.remove());

                const detailsRow = document.createElement("tr");
                detailsRow.classList.add("details-row");

                const detailsCell = document.createElement("td");
                detailsCell.colSpan = 4;

                // po tretinách
                const periods = `/${(data.sport_event_status.period_scores || [])
                    .map(p => `${p.home_score}:${p.away_score}`)
                    .join("; ")}/`;

                // rozdelenie hráčov
                const homeTeam = data.statistics?.totals?.competitors?.find?.(t => t.qualifier === "home") || { name: "Domáci", players: [] };
                const awayTeam = data.statistics?.totals?.competitors?.find?.(t => t.qualifier === "away") || { name: "Hostia", players: [] };

                const formatPlayers = team =>
                    (team.players || [])
                        .filter(p => (p.statistics?.goals || 0) > 0 || (p.statistics?.assists || 0) > 0)
                        .map(p => `
                            <div class="player-line">
                                <span class="player-name">${p.name}</span> –
                                ${(p.statistics?.goals || 0)} g + ${(p.statistics?.assists || 0)} a
                            </div>
                        `)
                        .join("") || "<div class='player-line'>Žiadne góly</div>";

                detailsCell.innerHTML = `
                    <div class="details-box">
                        <h4>Skóre: ${data.sport_event_status.home_score ?? "-"} : ${data.sport_event_status.away_score ?? "-"}</h4>
                        <p><b>Po tretinách:</b> ${periods}</p>
                        <div class="teams-stats">
                            <div class="team-column team-home">
                                <h5>${homeTeam.name}</h5>
                                ${formatPlayers(homeTeam)}
                            </div>
                            <div class="team-column team-away">
                                <h5>${awayTeam.name}</h5>
                                ${formatPlayers(awayTeam)}
                            </div>
                        </div>
                    </div>
                `;

                detailsRow.appendChild(detailsCell);
                row.insertAdjacentElement("afterend", detailsRow);
            } catch (err) {
                console.error("Chyba pri načítaní detailov zápasu:", err);
            }
        });

        tableBody.appendChild(row);
    });
}

// rating tímov
function displayTeamRatings() {
    const tableBody = document.querySelector("#teamRatings tbody");
    tableBody.innerHTML = "";

    const sortedTeams = Object.entries(teamRatings).sort((a, b) => b[1] - a[1]);

    sortedTeams.forEach(([team, rating]) => {
        const row = document.createElement("tr");
        row.innerHTML = `<td>${team}</td><td>${rating}</td>`;
        tableBody.appendChild(row);
    });
}

// TOP 20 hráčov
function displayPlayerRatings() {
    const tableBody = document.querySelector("#playerRatings tbody");
    tableBody.innerHTML = "";

    const sortedPlayers = Object.entries(playerRatings)
        .sort((a, b) => b[1] - a[1])
        .slice(0, 20);

    sortedPlayers.forEach(([player, rating]) => {
        const row = document.createElement("tr");
        row.innerHTML = `<td>${player}</td><td>${rating}</td>`;
        tableBody.appendChild(row);
    });
}

/** =========================
 *  MANTINGAL – simulácia sezóny + DENNÍK
 *  =========================
 */
function displayMantingal() {
    const container = document.querySelector(".right");

    const oldTable = document.getElementById("mantingal");
    const oldSummary = document.getElementById("mantingal-summary");
    if (oldTable) oldTable.remove();
    if (oldSummary) oldSummary.remove();

    const completed = (allMatches || [])
        .filter(m => m.sport_event_status && (m.sport_event_status.status === "closed" || m.sport_event_status.status === "ap"))
        .filter(m => m.statistics && m.statistics.totals && Array.isArray(m.statistics.totals.competitors))
        .slice();

    completed.sort((a, b) =>
        new Date(a.sport_event.start_time) - new Date(b.sport_event.start_time)
    );

    const byDay = {};
    for (const m of completed) {
        const d = new Date(m.sport_event.start_time).toISOString().slice(0, 10);
        (byDay[d] ||= []).push(m);
    }
    const days = Object.keys(byDay).sort();

    const ratingSoFar = {};
    const initRating = (name) => {
        if (ratingSoFar[name] == null) ratingSoFar[name] = 1500;
    };

    const state = {};
    const ensureState = (name) => {
        if (!state[name]) {
            state[name] = { stake: BASE_STAKE, totalStakes: 0, totalWins: 0, lastResult: "—", log: [] };
        }
        return state[name];
    };

    for (const day of days) {
        const top3 = Object.entries(ratingSoFar)
            .sort((a, b) => b[1] - a[1])
            .slice(0, 3)
            .map(([name]) => name);

        if (top3.length) {
            for (const playerName of top3) {
                let played = false;
                let goalsThatDay = 0;

                for (const match of byDay[day]) {
                    for (const team of match.statistics.totals.competitors) {
                        const p = (team.players || []).find(pl => pl.name === playerName);
                        if (p) {
                            played = true;
                            goalsThatDay += (p.statistics.goals || 0);
                        }
                    }
                }

                if (played) {
                    const s = ensureState(playerName);
                    const stakeBefore = s.stake;

                    // započítaj len reálne vsadenú sumu
                    s.totalStakes += stakeBefore;

                    if (goalsThatDay > 0) {
                        const winAmount = stakeBefore * ODDS;
                        s.totalWins += winAmount;
                        s.stake = BASE_STAKE;
                        s.lastResult = "✅ výhra";
                        s.log.push({ date: day, stake_before: stakeBefore, goals: goalsThatDay, result: "výhra", win_amount: winAmount, new_stake: s.stake });
                    } else {
                        const newStake = stakeBefore * 2;
                        s.stake = newStake;
                        s.lastResult = "❌ prehra";
                        s.log.push({ date: day, stake_before: stakeBefore, goals: 0, result: "prehra", win_amount: 0, new_stake: newStake });
                    }
                }
            }
        }

        for (const match of byDay[day]) {
            for (const team of match.statistics.totals.competitors) {
                for (const p of (team.players || [])) {
                    initRating(p.name);
                    ratingSoFar[p.name] += (p.statistics.goals || 0) * 20 + (p.statistics.assists || 0) * 10;
                }
            }
        }
    }

    const currentTop3 = Object.entries(playerRatings)
        .sort((a, b) => b[1] - a[1])
        .slice(0, 3);

    const table = document.createElement("table");
    table.id = "mantingal";
    table.innerHTML = `
        <thead>
            <tr><th colspan="5">Mantingal – TOP 3 (kurz ${ODDS})</th></tr>
            <tr><th>Hráč</th><th>Kurz</th><th>Vklad</th><th>Posledný výsledok</th><th>Denník</th></tr>
        </thead>
        <tbody>
            ${currentTop3.map(([name]) => {
                const s = state[name] || { stake: BASE_STAKE, lastResult: "—", log: [] };
                const logHtml = (s.log.length
                    ? s.log.map(e => `
                        <div>
                            <b>${e.date}</b> – stake: ${e.stake_before} €,
                            góly: ${e.goals},
                            výsledok: ${e.result},
                            výhra: ${e.win_amount.toFixed ? e.win_amount.toFixed(2) : e.win_amount} €,
                            nový stake: ${e.new_stake} €
                        </div>
                    `).join("")
                    : "<div>Denník je prázdny</div>"
                );
                return `
                    <tr class="mant-row" data-player="${encodeURIComponent(name)}">
                        <td>${name}</td>
                        <td>${ODDS}</td>
                        <td>${s.stake} €</td>
                        <td>${s.lastResult}</td>
                        <td><button class="btn-log" data-player="${encodeURIComponent(name)}">📜</button></td>
                    </tr>
                    <tr class="diary-row" id="log-${encodeURIComponent(name)}" style="display:none;">
                        <td colspan="5" style="text-align:left;">
                            ${logHtml}
                        </td>
                    </tr>
                `;
            }).join("")}
        </tbody>
    `;

    const totals = Object.values(state).reduce(
        (acc, s) => {
            acc.stakes += s.totalStakes || 0;
            acc.wins += s.totalWins || 0;
            return acc;
        },
        { stakes: 0, wins: 0 }
    );
    const profit = totals.wins - totals.stakes;

    const summary = document.createElement("div");
    summary.id = "mantingal-summary";
    summary.innerHTML = `
        <p><b>Celkové stávky</b>: ${totals.stakes.toFixed(2)} €</p>
        <p><b>Výhry</b>: ${totals.wins.toFixed(2)} €</p>
        <p><b>Profit</b>: ${profit.toFixed(2)} €</p>
    `;

    container.appendChild(table);
    container.appendChild(summary);

    table.querySelectorAll(".btn-log").forEach(btn => {
        btn.addEventListener("click", () => {
            const name = btn.getAttribute("data-player");
            const row = document.getElementById(`log-${name}`);
            if (!row) return;
            row.style.display = row.style.display === "none" ? "" : "none";
        });
    });
}

window.addEventListener("DOMContentLoaded", fetchMatches);
