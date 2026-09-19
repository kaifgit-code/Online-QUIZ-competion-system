import { db, qs, el, esc, fmtClock, friendlyError } from "./firebase-config.js";
import { doc, getDoc, collection, getDocs } from "https://www.gstatic.com/firebasejs/10.12.2/firebase-firestore.js";

const input = el("quizInput");
const body = el("lbBody");
const table = el("lbTable");
const state = el("lbState");

const fromUrl = qs("quiz");
if (fromUrl) { input.value = fromUrl; load(fromUrl); }

el("loadBtn").addEventListener("click", () => {
  const v = input.value.trim();
  if (v) { history.replaceState(null, "", `?quiz=${encodeURIComponent(v)}`); load(v); }
});
input.addEventListener("keydown", e => { if (e.key === "Enter") el("loadBtn").click(); });

async function load(quizId) {
  state.textContent = "Loading the board…";
  table.classList.add("hidden");
  el("winnerCard").classList.add("hidden");
  body.innerHTML = "";

  try {
    const qsnap = await getDoc(doc(db, "quizzes", quizId));
    if (!qsnap.exists()) { state.textContent = "No quiz uses that code."; return; }
    const quiz = qsnap.data();
    el("lbTitle").textContent = quiz.title || "Leaderboard";

    const snap = await getDocs(collection(db, "leaderboard", quizId, "entries"));
    const rows = snap.docs.map(d => d.data());

    // score desc -> time taken asc -> submitted earliest
    rows.sort((a, b) =>
      (b.score - a.score) ||
      (a.timeTakenMs - b.timeTakenMs) ||
      ((a.submittedAt?.toMillis?.() ?? 0) - (b.submittedAt?.toMillis?.() ?? 0))
    );

    if (!rows.length) { state.textContent = "Nobody has submitted yet."; return; }

    body.innerHTML = rows.map((r, i) => `
      <tr class="${i === 0 ? "top1" : ""}">
        <td class="rank">${i + 1}</td>
        <td>${esc(r.name)}</td>
        <td>${r.score}</td>
        <td>${fmtClock(r.timeTakenMs)}</td>
      </tr>`).join("");

    state.textContent = "";
    table.classList.remove("hidden");

    if (quiz.winner && quiz.winner.name) {
      el("winnerCard").classList.remove("hidden");
      el("winnerName").textContent = quiz.winner.name;
      el("winnerLine").textContent = `${quiz.winner.score} marks in ${fmtClock(quiz.winner.timeTakenMs || 0)}.`;
    }
  } catch (e) {
    console.error(e);
    state.textContent = friendlyError(e);
  }
}
