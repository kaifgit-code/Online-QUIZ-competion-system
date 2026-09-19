import { db, auth, qs, el, fmtClock, fmtDate, friendlyError } from "./firebase-config.js";
import { signInAnonymously, onAuthStateChanged } from "https://www.gstatic.com/firebasejs/10.12.2/firebase-auth.js";
import { doc, getDoc } from "https://www.gstatic.com/firebasejs/10.12.2/firebase-firestore.js";

const quizId = qs("quiz");

function fail(msg) {
  el("loading").classList.add("hidden");
  el("blocked").classList.remove("hidden");
  el("blockMsg").textContent = msg;
}

(async function () {
  if (!quizId) return fail("This link is missing a quiz code.");
  try {
    await signInAnonymously(auth);
  } catch (e) {
    return fail(friendlyError(e));
  }

  onAuthStateChanged(auth, async user => {
    if (!user) return;
    const pid = `${quizId}__${user.uid}`;
    try {
      const snap = await getDoc(doc(db, "results", pid));
      if (!snap.exists()) {
        return fail("No result is stored for this device. Results are tied to the browser session that took the quiz — if you cleared your data or switched phones, ask the organiser to look you up.");
      }
      const r = snap.data();

      el("who").textContent = r.name || "Your score";
      el("scoreNum").textContent = r.score;
      el("outOf").textContent = `out of ${r.totalMarks}`;
      el("sCorrect").textContent = r.correctCount;
      el("sWrong").textContent = r.questionCount - r.correctCount;
      el("sTime").textContent = fmtClock(r.timeTakenMs);
      el("sWhen").textContent = fmtDate(r.submittedAt);
      el("quizTitle").textContent = r.quizTitle || "Quiz";
      if (r.autoSubmitted) {
        el("reviewNote").textContent = "The timer ran out, so your answers were sent automatically. The organiser reviews all entries before the winner is declared.";
      }
      el("lbLink").href = `leaderboard.html?quiz=${encodeURIComponent(quizId)}`;

      el("loading").classList.add("hidden");
      el("done").classList.remove("hidden");
    } catch (e) {
      console.error(e);
      fail(friendlyError(e));
    }
  });
})();
