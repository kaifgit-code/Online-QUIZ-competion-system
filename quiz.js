import { db, auth, fns, qs, el, esc, fmtClock, friendlyError, toast } from "./firebase-config.js";
import { signInAnonymously, onAuthStateChanged } from "https://www.gstatic.com/firebasejs/10.12.2/firebase-auth.js";
import {
  doc, getDoc, setDoc, collection, getDocs, query, orderBy, serverTimestamp
} from "https://www.gstatic.com/firebasejs/10.12.2/firebase-firestore.js";
import { httpsCallable } from "https://www.gstatic.com/firebasejs/10.12.2/firebase-functions.js";

const quizId = qs("quiz");

let uid = null;          // anonymous auth uid = the participant's session identity
let pid = null;          // participants/{pid}  ->  `${quizId}__${uid}`
let quiz = null;
let questions = [];
let answers = {};        // { questionId: selectedIndex }
let index = 0;
let deadline = 0;        // epoch ms
let ticker = null;
let sending = false;
let saveTimer = null;

/* ---------------- view switching ---------------- */
const views = ["viewLoading", "viewBlocked", "viewJoin", "viewQuiz", "viewSending"];
function show(name) {
  views.forEach(v => el(v).classList.toggle("hidden", v !== name));
}
function block(title, msg) {
  el("blockTitle").textContent = title;
  el("blockMsg").textContent = msg;
  el("statusPill").textContent = "Closed";
  el("statusPill").className = "pill pill--off";
  show("viewBlocked");
}

/* ---------------- boot ---------------- */
(async function boot() {
  if (!quizId) {
    block("No quiz in this link", "The link is missing a quiz code. Scan the QR code again or ask the organiser for a fresh link.");
    return;
  }
  try {
    await signInAnonymously(auth);
  } catch (e) {
    block("Can't start a session", friendlyError(e) + " Anonymous sign-in must be enabled in Firebase Authentication.");
    return;
  }
  onAuthStateChanged(auth, async user => {
    if (!user) return;
    uid = user.uid;
    pid = `${quizId}__${uid}`;
    try {
      await loadQuiz();
    } catch (e) {
      console.error(e);
      block("Couldn't load the quiz", friendlyError(e));
    }
  });
})();

async function loadQuiz() {
  const snap = await getDoc(doc(db, "quizzes", quizId));
  if (!snap.exists()) {
    block("Quiz not found", "No quiz uses this code. Check the link or the code printed under the QR.");
    return;
  }
  quiz = { id: snap.id, ...snap.data() };

  const now = Date.now();
  const startMs = quiz.startAt?.toMillis?.() ?? null;
  const endMs = quiz.endAt?.toMillis?.() ?? null;

  if (quiz.status !== "active") {
    block("This quiz isn't open", "The organiser hasn't activated it yet, or the round is already over.");
    return;
  }
  if (startMs && now < startMs) {
    block("Not open yet", "This quiz opens at " + new Date(startMs).toLocaleString() + ".");
    return;
  }
  if (endMs && now > endMs) {
    block("This round is over", "The quiz closed at " + new Date(endMs).toLocaleString() + ".");
    return;
  }

  // Already finished on this device / in this session?
  const resSnap = await getDoc(doc(db, "results", pid));
  if (resSnap.exists()) {
    location.replace(`result.html?quiz=${encodeURIComponent(quizId)}`);
    return;
  }

  // Already joined but not submitted -> resume instead of starting over.
  const pSnap = await getDoc(doc(db, "participants", pid));
  if (pSnap.exists()) {
    await startRun(pSnap.data());
    return;
  }

  // Fresh join
  el("statusPill").textContent = "Open";
  el("statusPill").className = "pill pill--live";
  el("joinTitle").textContent = quiz.title || "Quiz";
  el("joinDesc").textContent = quiz.description || "";
  el("joinQCount").textContent = (quiz.questionCount ?? 0) + " questions";
  el("joinDuration").textContent = (quiz.durationMinutes ?? 0) + " min";
  el("joinMarks").textContent = (quiz.totalMarks ?? 0) + " marks";
  show("viewJoin");
}

/* ---------------- joining ---------------- */
el("startBtn").addEventListener("click", async () => {
  const name = el("pName").value.trim();
  const errBox = el("joinErr");
  errBox.textContent = "";

  if (name.length < 2) { errBox.textContent = "Enter your name (at least 2 characters)."; return; }
  const email = el("pEmail").value.trim();
  if (email && !/^[^@\s]+@[^@\s]+\.[^@\s]+$/.test(email)) {
    errBox.textContent = "That email address doesn't look right. Leave it blank if you're not sure.";
    return;
  }

  el("startBtn").disabled = true;
  try {
    await setDoc(doc(db, "participants", pid), {
      quizId,
      uid,
      name,
      email: email || "",
      roll: el("pRoll").value.trim(),
      joinedAt: serverTimestamp(),
      submitted: false
    });
    const fresh = await getDoc(doc(db, "participants", pid));
    await startRun(fresh.data());
  } catch (e) {
    console.error(e);
    el("startBtn").disabled = false;
    errBox.textContent = friendlyError(e);
  }
});

/* ---------------- running the quiz ---------------- */
async function startRun(pdata) {
  // questions never contain the correct answer, so this read is safe to be public
  const qSnap = await getDocs(query(collection(db, "quizzes", quizId, "questions"), orderBy("order")));
  questions = qSnap.docs.map(d => ({ id: d.id, ...d.data() }));

  if (!questions.length) {
    block("No questions yet", "The organiser hasn't added any questions to this quiz.");
    return;
  }

  // restore a draft after a refresh or a dropped connection
  try {
    const dSnap = await getDoc(doc(db, "quizzes", quizId, "drafts", uid));
    if (dSnap.exists()) answers = dSnap.data().answers || {};
  } catch (_) { /* a missing draft is fine */ }

  const joinedMs = pdata.joinedAt?.toMillis?.() ?? Date.now();
  deadline = joinedMs + (quiz.durationMinutes || 10) * 60000;

  if (Date.now() >= deadline) { show("viewQuiz"); return submitAll(true); }

  index = 0;
  render();
  show("viewQuiz");
  ticker = setInterval(tick, 500);
  tick();
}

function tick() {
  const left = deadline - Date.now();
  const t = el("timer");
  t.textContent = fmtClock(left);
  t.classList.toggle("warn", left <= 60000);
  if (left <= 0) {
    clearInterval(ticker);
    toast("Time is up. Sending your answers.", "bad");
    submitAll(true);
  }
}

function render() {
  const q = questions[index];
  el("counter").textContent = `${index + 1}/${questions.length}`;
  el("bar").style.width = ((index + 1) / questions.length * 100) + "%";
  el("qtext").textContent = q.text;
  el("marksHint").textContent = `Worth ${q.marks || 1} mark${(q.marks || 1) > 1 ? "s" : ""}.`;

  const keys = ["A", "B", "C", "D"];
  el("opts").innerHTML = q.options.map((o, i) => `
    <label class="opt ${answers[q.id] === i ? "sel" : ""}">
      <input type="radio" name="opt" value="${i}" ${answers[q.id] === i ? "checked" : ""}>
      <span class="opt-key">${keys[i]}</span>
      <span>${esc(o)}</span>
    </label>`).join("");

  el("opts").querySelectorAll("input").forEach(inp => {
    inp.addEventListener("change", () => {
      answers[q.id] = Number(inp.value);
      render();
      queueSave();
    });
  });

  el("prevBtn").disabled = index === 0;
  el("nextBtn").disabled = index === questions.length - 1;
}

el("prevBtn").addEventListener("click", () => { if (index > 0) { index--; render(); } });
el("nextBtn").addEventListener("click", () => { if (index < questions.length - 1) { index++; render(); } });

el("submitBtn").addEventListener("click", () => {
  const left = questions.length - Object.keys(answers).length;
  const msg = left > 0
    ? `${left} question${left > 1 ? "s are" : " is"} still unanswered. Submit anyway?`
    : "Submit your answers? You can't change them afterwards.";
  if (confirm(msg)) submitAll(false);
});

/* draft autosave: keeps answers safe across refresh / signal loss */
function queueSave() {
  el("saveState").textContent = "Saving…";
  clearTimeout(saveTimer);
  saveTimer = setTimeout(async () => {
    try {
      await setDoc(doc(db, "quizzes", quizId, "drafts", uid), {
        uid, answers, updatedAt: serverTimestamp()
      });
      el("saveState").textContent = "Answers saved.";
    } catch (e) {
      el("saveState").textContent = "Couldn't save just now — your answers stay on this device and are sent on submit.";
    }
  }, 500);
}

/* ---------------- submitting ---------------- */
async function submitAll(auto) {
  if (sending) return;
  sending = true;
  clearInterval(ticker);
  show("viewSending");

  const submitQuiz = httpsCallable(fns, "submitQuiz");
  try {
    await submitQuiz({ quizId, answers, auto: !!auto });
    location.replace(`result.html?quiz=${encodeURIComponent(quizId)}`);
  } catch (e) {
    console.error(e);
    if (e?.code === "functions/already-exists") {
      location.replace(`result.html?quiz=${encodeURIComponent(quizId)}`);
      return;
    }
    sending = false;
    show("viewQuiz");
    toast(friendlyError(e) || "Submission failed. Tap submit again.", "bad");
  }
}

/* nudge people who try to leave mid-quiz */
window.addEventListener("beforeunload", e => {
  if (el("viewQuiz").classList.contains("hidden") || sending) return;
  e.preventDefault();
  e.returnValue = "";
});
