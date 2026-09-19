import { db, auth, el, esc, qs, fmtClock, fmtDate, friendlyError, toast } from "./firebase-config.js";
import {
  signInWithEmailAndPassword, signOut, onAuthStateChanged
} from "https://www.gstatic.com/firebasejs/10.12.2/firebase-auth.js";
import {
  doc, getDoc, setDoc, updateDoc, deleteDoc, collection, getDocs,
  query, where, orderBy, writeBatch, serverTimestamp, Timestamp
} from "https://www.gstatic.com/firebasejs/10.12.2/firebase-firestore.js";

let me = null;
let current = null;      // currently open quiz { id, ...data }
let questions = [];      // [{id, order, text, options, marks, explanation, correctIndex}]
let editingId = null;    // question id being edited, or "__new__"

/* =========================================================
   AUTH
   ========================================================= */
onAuthStateChanged(auth, async user => {
  if (!user) {
    me = null;
    el("viewLogin").classList.remove("hidden");
    el("viewAdmin").classList.add("hidden");
    el("whoPill").classList.add("hidden");
    el("signOutBtn").classList.add("hidden");
    return;
  }
  // Being signed in is not enough — the uid must exist in `admins`.
  let isAdmin = false;
  try {
    isAdmin = (await getDoc(doc(db, "admins", user.uid))).exists();
  } catch (_) { isAdmin = false; }

  if (!isAdmin) {
    await signOut(auth);
    el("loginErr").textContent = "That account isn't an admin. Add its UID to the admins collection first.";
    return;
  }

  me = user;
  el("viewLogin").classList.add("hidden");
  el("viewAdmin").classList.remove("hidden");
  el("whoPill").textContent = user.email;
  el("whoPill").classList.remove("hidden");
  el("signOutBtn").classList.remove("hidden");
  listQuizzes();

  const pre = qs("quiz");
  if (pre) openQuiz(pre);
});

el("loginBtn").addEventListener("click", async () => {
  el("loginErr").textContent = "";
  el("loginBtn").disabled = true;
  try {
    await signInWithEmailAndPassword(auth, el("email").value.trim(), el("pass").value);
  } catch (e) {
    el("loginErr").textContent = friendlyError(e);
  }
  el("loginBtn").disabled = false;
});
el("pass").addEventListener("keydown", e => { if (e.key === "Enter") el("loginBtn").click(); });
el("signOutBtn").addEventListener("click", () => signOut(auth));

/* =========================================================
   TABS
   ========================================================= */
document.querySelectorAll(".tabs button").forEach(b => {
  b.addEventListener("click", () => {
    document.querySelectorAll(".tabs button").forEach(x => x.classList.remove("on"));
    b.classList.add("on");
    ["quizzes", "editor", "people", "results"].forEach(t =>
      el("tab-" + t).classList.toggle("hidden", t !== b.dataset.tab));
    if (b.dataset.tab === "people") loadPeople();
    if (b.dataset.tab === "results") loadResults();
  });
});
function goTab(name) { document.querySelector(`.tabs button[data-tab="${name}"]`).click(); }

/* =========================================================
   QUIZ LIST + CREATE
   ========================================================= */
function toTs(v) { return v ? Timestamp.fromDate(new Date(v)) : null; }
function toLocalInput(ts) {
  if (!ts?.toDate) return "";
  const d = ts.toDate();
  const p = n => String(n).padStart(2, "0");
  return `${d.getFullYear()}-${p(d.getMonth() + 1)}-${p(d.getDate())}T${p(d.getHours())}:${p(d.getMinutes())}`;
}
function randomCode() {
  const c = "abcdefghjkmnpqrstuvwxyz23456789";
  return Array.from({ length: 8 }, () => c[Math.floor(Math.random() * c.length)]).join("");
}

el("createQuizBtn").addEventListener("click", async () => {
  const title = el("nqTitle").value.trim();
  if (!title) return toast("Give the quiz a title.", "bad");
  const mins = Number(el("nqMin").value);
  if (!(mins >= 1)) return toast("Duration must be at least 1 minute.", "bad");

  let code = el("nqCode").value.trim().toLowerCase().replace(/[^a-z0-9-]/g, "");
  if (!code) code = randomCode();

  try {
    if ((await getDoc(doc(db, "quizzes", code))).exists())
      return toast("That quiz code is already taken. Pick another.", "bad");

    await setDoc(doc(db, "quizzes", code), {
      title,
      description: el("nqDesc").value.trim(),
      durationMinutes: mins,
      status: "draft",
      startAt: toTs(el("nqStart").value),
      endAt: toTs(el("nqEnd").value),
      questionCount: 0,
      totalMarks: 0,
      winner: null,
      ownerUid: me.uid,
      createdAt: serverTimestamp()
    });
    el("nqTitle").value = el("nqDesc").value = el("nqCode").value = "";
    toast("Quiz created.", "good");
    await listQuizzes();
    openQuiz(code);
  } catch (e) { toast(friendlyError(e), "bad"); }
});

async function listQuizzes() {
  const box = el("quizList");
  try {
    const snap = await getDocs(query(collection(db, "quizzes"), orderBy("createdAt", "desc")));
    if (snap.empty) { box.innerHTML = `<p class="muted" style="margin:0">No quizzes yet. Create one above.</p>`; return; }
    box.innerHTML = snap.docs.map(d => {
      const q = d.data();
      const live = q.status === "active";
      return `<div class="qrow">
        <div class="spread">
          <div>
            <b>${esc(q.title)}</b>
            <div class="muted" style="font-size:.85rem">
              <code>${esc(d.id)}</code> · ${q.questionCount || 0} questions · ${q.durationMinutes} min
            </div>
          </div>
          <span class="pill ${live ? "pill--live" : "pill--off"}">${esc(q.status)}</span>
        </div>
        <div class="row" style="margin-top:10px">
          <button class="btn-sm" data-open="${esc(d.id)}">Open</button>
          <button class="btn-sm btn-ghost" data-lb="${esc(d.id)}">Leaderboard</button>
          <button class="btn-sm btn-danger" data-del="${esc(d.id)}">Delete</button>
        </div>
      </div>`;
    }).join("");

    box.querySelectorAll("[data-open]").forEach(b =>
      b.addEventListener("click", () => openQuiz(b.dataset.open)));
    box.querySelectorAll("[data-lb]").forEach(b =>
      b.addEventListener("click", () => window.open(`leaderboard.html?quiz=${b.dataset.lb}`, "_blank")));
    box.querySelectorAll("[data-del]").forEach(b =>
      b.addEventListener("click", () => deleteQuiz(b.dataset.del)));
  } catch (e) {
    box.innerHTML = `<p class="notice notice--bad">${esc(friendlyError(e))}</p>`;
  }
}

async function deleteQuiz(id) {
  if (!confirm(`Delete quiz "${id}" with all its questions? This cannot be undone.`)) return;
  try {
    const batch = writeBatch(db);
    for (const sub of ["questions", "answerKey", "drafts"]) {
      const s = await getDocs(collection(db, "quizzes", id, sub));
      s.forEach(d => batch.delete(d.ref));
    }
    batch.delete(doc(db, "quizzes", id));
    await batch.commit();
    if (current?.id === id) { current = null; el("editorBody").classList.add("hidden"); el("noQuizPicked").classList.remove("hidden"); }
    toast("Quiz deleted.", "good");
    listQuizzes();
  } catch (e) { toast(friendlyError(e), "bad"); }
}

/* =========================================================
   QUIZ EDITOR
   ========================================================= */
async function openQuiz(id) {
  const snap = await getDoc(doc(db, "quizzes", id));
  if (!snap.exists()) return toast("That quiz no longer exists.", "bad");
  current = { id: snap.id, ...snap.data() };

  el("noQuizPicked").classList.add("hidden");
  el("editorBody").classList.remove("hidden");
  el("edTitle").textContent = current.title;
  el("edCode").textContent = current.id;
  el("edTitleIn").value = current.title || "";
  el("edDesc").value = current.description || "";
  el("edMin").value = current.durationMinutes || 10;
  el("edStart").value = toLocalInput(current.startAt);
  el("edEnd").value = toLocalInput(current.endAt);
  paintStatus();
  el("qrPanel").classList.add("hidden");

  await loadQuestions();
  goTab("editor");
}

function paintStatus() {
  const live = current.status === "active";
  el("edStatus").textContent = current.status;
  el("edStatus").className = "pill " + (live ? "pill--live" : "pill--off");
  el("toggleLiveBtn").textContent = live ? "Deactivate" : "Activate";
}

el("saveQuizBtn").addEventListener("click", async () => {
  if (!current) return;
  const mins = Number(el("edMin").value);
  if (!(mins >= 1)) return toast("Duration must be at least 1 minute.", "bad");
  try {
    await updateDoc(doc(db, "quizzes", current.id), {
      title: el("edTitleIn").value.trim() || current.title,
      description: el("edDesc").value.trim(),
      durationMinutes: mins,
      startAt: toTs(el("edStart").value),
      endAt: toTs(el("edEnd").value)
    });
    toast("Settings saved.", "good");
    openQuiz(current.id);
    listQuizzes();
  } catch (e) { toast(friendlyError(e), "bad"); }
});

el("toggleLiveBtn").addEventListener("click", async () => {
  if (!current) return;
  const next = current.status === "active" ? "closed" : "active";
  if (next === "active" && !questions.length) return toast("Add at least one question before going live.", "bad");
  try {
    await updateDoc(doc(db, "quizzes", current.id), { status: next });
    current.status = next;
    paintStatus();
    listQuizzes();
    toast(next === "active" ? "Quiz is live." : "Quiz closed.", "good");
  } catch (e) { toast(friendlyError(e), "bad"); }
});

/* ---------- QR code + link ---------- */
let qrObj = null;
el("qrBtn").addEventListener("click", () => {
  if (!current) return;
  const panel = el("qrPanel");
  panel.classList.toggle("hidden");
  if (panel.classList.contains("hidden")) return;

  const url = new URL(`quiz.html?quiz=${encodeURIComponent(current.id)}`, location.href).href;
  el("shareUrl").value = url;
  el("qrbox").innerHTML = "";
  qrObj = new QRCode(el("qrbox"), { text: url, width: 220, height: 220, correctLevel: QRCode.CorrectLevel.M });
});

el("copyLinkBtn").addEventListener("click", async () => {
  try {
    await navigator.clipboard.writeText(el("shareUrl").value);
    toast("Link copied.", "good");
  } catch (_) {
    el("shareUrl").select();
    toast("Press Ctrl+C to copy the selected link.");
  }
});

el("downloadQrBtn").addEventListener("click", () => {
  const canvas = el("qrbox").querySelector("canvas");
  const img = el("qrbox").querySelector("img");
  const data = canvas ? canvas.toDataURL("image/png") : img?.src;
  if (!data) return toast("Open the QR panel first.", "bad");
  const a = document.createElement("a");
  a.href = data;
  a.download = `quiz-${current.id}-qr.png`;
  a.click();
});

/* ---------- questions ---------- */
async function loadQuestions() {
  const qSnap = await getDocs(query(collection(db, "quizzes", current.id, "questions"), orderBy("order")));
  const kSnap = await getDocs(collection(db, "quizzes", current.id, "answerKey"));
  const keys = {};
  kSnap.forEach(d => keys[d.id] = d.data());

  questions = qSnap.docs.map(d => ({
    id: d.id,
    ...d.data(),
    correctIndex: keys[d.id]?.correctIndex ?? 0
  }));
  renderQuestions();
}

function renderQuestions() {
  el("qCount").textContent = `(${questions.length})`;
  const list = el("qList");
  const keyLetters = ["A", "B", "C", "D"];

  list.innerHTML = questions.map((q, i) => {
    if (editingId === q.id) return formHtml(q, i);
    return `<div class="qrow">
      <div class="spread">
        <div>
          <span class="qno">Q${i + 1}</span>${esc(q.text)}
          <div class="muted" style="font-size:.85rem;margin-top:4px">
            ${q.options.map((o, oi) =>
              `${keyLetters[oi]}. ${esc(o)}${oi === q.correctIndex ? ' <span class="correct-tag">✓ correct</span>' : ""}`
            ).join(" &nbsp;·&nbsp; ")}
          </div>
          <div class="muted" style="font-size:.8rem;margin-top:4px">${q.marks || 1} mark(s)${q.explanation ? " · has explanation" : ""}</div>
        </div>
      </div>
      <div class="row" style="margin-top:10px">
        <button class="btn-sm btn-ghost" data-up="${i}" ${i === 0 ? "disabled" : ""}>Move up</button>
        <button class="btn-sm btn-ghost" data-down="${i}" ${i === questions.length - 1 ? "disabled" : ""}>Move down</button>
        <button class="btn-sm" data-edit="${esc(q.id)}">Edit</button>
        <button class="btn-sm btn-danger" data-delq="${esc(q.id)}">Delete</button>
      </div>
    </div>`;
  }).join("");

  if (editingId === "__new__") {
    list.insertAdjacentHTML("beforeend",
      formHtml({ text: "", options: ["", "", "", ""], marks: 1, explanation: "", correctIndex: 0 }, questions.length));
  }
  if (!questions.length && editingId !== "__new__") {
    list.innerHTML = `<p class="muted" style="margin:0">No questions yet. Tap "Add question".</p>`;
  }

  list.querySelectorAll("[data-edit]").forEach(b => b.addEventListener("click", () => { editingId = b.dataset.edit; renderQuestions(); }));
  list.querySelectorAll("[data-delq]").forEach(b => b.addEventListener("click", () => deleteQuestion(b.dataset.delq)));
  list.querySelectorAll("[data-up]").forEach(b => b.addEventListener("click", () => move(Number(b.dataset.up), -1)));
  list.querySelectorAll("[data-down]").forEach(b => b.addEventListener("click", () => move(Number(b.dataset.down), 1)));
  const cancel = list.querySelector("#qCancel");
  if (cancel) cancel.addEventListener("click", () => { editingId = null; renderQuestions(); });
  const save = list.querySelector("#qSave");
  if (save) save.addEventListener("click", saveQuestionForm);
}

function formHtml(q, i) {
  const keyLetters = ["A", "B", "C", "D"];
  return `<div class="qrow" style="border-color:var(--blue)">
    <div class="field">
      <label for="fText">Question ${i + 1}</label>
      <textarea id="fText">${esc(q.text)}</textarea>
    </div>
    ${[0, 1, 2, 3].map(n => `
      <div class="field">
        <label for="fOpt${n}">Option ${keyLetters[n]}</label>
        <input id="fOpt${n}" value="${esc(q.options[n] || "")}">
      </div>`).join("")}
    <div class="grid2">
      <div class="field">
        <label for="fCorrect">Correct answer</label>
        <select id="fCorrect">
          ${keyLetters.map((L, n) => `<option value="${n}" ${q.correctIndex === n ? "selected" : ""}>Option ${L}</option>`).join("")}
        </select>
      </div>
      <div class="field">
        <label for="fMarks">Marks</label>
        <input id="fMarks" type="number" min="1" max="100" value="${q.marks || 1}">
      </div>
    </div>
    <div class="field">
      <label for="fExp">Explanation (optional, admin-only)</label>
      <textarea id="fExp">${esc(q.explanation || "")}</textarea>
    </div>
    <div class="row">
      <button id="qSave">Save question</button>
      <button id="qCancel" class="btn-ghost">Cancel</button>
    </div>
  </div>`;
}

async function saveQuestionForm() {
  const text = el("fText").value.trim();
  const options = [0, 1, 2, 3].map(n => el("fOpt" + n).value.trim());
  const correctIndex = Number(el("fCorrect").value);
  const marks = Math.max(1, Number(el("fMarks").value) || 1);
  const explanation = el("fExp").value.trim();

  if (!text) return toast("Write the question text.", "bad");
  if (options.some(o => !o)) return toast("Fill all four options.", "bad");

  const isNew = editingId === "__new__";
  const qid = isNew ? doc(collection(db, "quizzes", current.id, "questions")).id : editingId;
  const order = isNew ? questions.length : (questions.find(x => x.id === qid)?.order ?? questions.length);

  try {
    const batch = writeBatch(db);
    // public part — no correct answer here, ever
    batch.set(doc(db, "quizzes", current.id, "questions", qid), { order, text, options, marks });
    // private part — admin-only collection
    batch.set(doc(db, "quizzes", current.id, "answerKey", qid), { correctIndex, explanation, marks });
    await batch.commit();

    editingId = null;
    await loadQuestions();
    await refreshTotals();
    toast("Question saved.", "good");
  } catch (e) { toast(friendlyError(e), "bad"); }
}

async function deleteQuestion(qid) {
  if (!confirm("Delete this question?")) return;
  try {
    const batch = writeBatch(db);
    batch.delete(doc(db, "quizzes", current.id, "questions", qid));
    batch.delete(doc(db, "quizzes", current.id, "answerKey", qid));
    await batch.commit();
    questions = questions.filter(q => q.id !== qid);
    await reindex();
    await refreshTotals();
    toast("Question deleted.", "good");
  } catch (e) { toast(friendlyError(e), "bad"); }
}

async function move(i, dir) {
  const j = i + dir;
  if (j < 0 || j >= questions.length) return;
  [questions[i], questions[j]] = [questions[j], questions[i]];
  await reindex();
}

async function reindex() {
  const batch = writeBatch(db);
  questions.forEach((q, i) => {
    q.order = i;
    batch.update(doc(db, "quizzes", current.id, "questions", q.id), { order: i });
  });
  await batch.commit();
  renderQuestions();
}

async function refreshTotals() {
  const totalMarks = questions.reduce((s, q) => s + (q.marks || 1), 0);
  await updateDoc(doc(db, "quizzes", current.id), { questionCount: questions.length, totalMarks });
  current.questionCount = questions.length;
  current.totalMarks = totalMarks;
  listQuizzes();
}

el("addQBtn").addEventListener("click", () => { editingId = "__new__"; renderQuestions(); });

/* =========================================================
   PARTICIPANTS
   ========================================================= */
el("refreshPeople").addEventListener("click", loadPeople);

async function loadPeople() {
  if (!current) { el("peopleState").textContent = "Open a quiz first."; return; }
  el("peopleState").textContent = "Loading…";
  el("peopleTable").classList.add("hidden");
  try {
    const pSnap = await getDocs(query(collection(db, "participants"), where("quizId", "==", current.id)));
    const rSnap = await getDocs(query(collection(db, "results"), where("quizId", "==", current.id)));
    const results = {};
    rSnap.forEach(d => results[d.data().uid] = d.data());

    if (pSnap.empty) { el("peopleState").textContent = "Nobody has joined yet."; return; }

    el("peopleBody").innerHTML = pSnap.docs.map(d => {
      const p = d.data();
      const r = results[p.uid];
      return `<tr>
        <td>${esc(p.name)}</td>
        <td>${esc(p.roll || "—")}</td>
        <td>${esc(p.email || "—")}</td>
        <td>${fmtDate(p.joinedAt)}</td>
        <td>${r ? fmtDate(r.submittedAt) : "—"}</td>
        <td>${r ? r.score : "—"}</td>
        <td>${r ? `${r.correctCount}/${r.questionCount}` : "—"}</td>
        <td>${r ? fmtClock(r.timeTakenMs) : "—"}</td>
        <td><span class="pill ${r ? "pill--live" : ""}">${r ? (r.autoSubmitted ? "auto-submitted" : "submitted") : "in progress"}</span></td>
      </tr>`;
    }).join("");

    el("peopleState").textContent = `${pSnap.size} joined · ${rSnap.size} submitted`;
    el("peopleTable").classList.remove("hidden");
  } catch (e) { el("peopleState").textContent = friendlyError(e); }
}

/* =========================================================
   RESULTS + WINNER
   ========================================================= */
el("refreshResults").addEventListener("click", loadResults);

let ranked = [];

async function loadResults() {
  if (!current) { el("resState").textContent = "Open a quiz first."; return; }
  el("resState").textContent = "Loading…";
  el("resTable").classList.add("hidden");
  try {
    const rSnap = await getDocs(query(collection(db, "results"), where("quizId", "==", current.id)));
    ranked = rSnap.docs.map(d => ({ id: d.id, ...d.data() }));
    ranked.sort((a, b) =>
      (b.score - a.score) ||
      (a.timeTakenMs - b.timeTakenMs) ||
      ((a.submittedAt?.toMillis?.() ?? 0) - (b.submittedAt?.toMillis?.() ?? 0))
    );

    if (!ranked.length) { el("resState").textContent = "No submissions yet."; return; }

    el("resBody").innerHTML = ranked.map((r, i) => `
      <tr class="${i === 0 ? "top1" : ""}">
        <td class="rank">${i + 1}</td>
        <td>${esc(r.name)}</td>
        <td>${esc(r.roll || "—")}</td>
        <td>${r.score}/${r.totalMarks}</td>
        <td>${r.correctCount}/${r.questionCount}</td>
        <td>${fmtClock(r.timeTakenMs)}</td>
        <td>${fmtDate(r.submittedAt)}</td>
        <td><button class="btn-sm btn-ghost" data-pick="${esc(r.uid)}">Pick as winner</button></td>
      </tr>`).join("");

    el("resBody").querySelectorAll("[data-pick]").forEach(b =>
      b.addEventListener("click", () => { el("winnerPick").value = b.dataset.pick; toast("Selected. Now tap Declare winner."); }));

    el("winnerPick").innerHTML = `<option value="">— choose a participant —</option>` +
      ranked.map(r => `<option value="${esc(r.uid)}">${esc(r.name)} — ${r.score} marks, ${fmtClock(r.timeTakenMs)}</option>`).join("");

    el("resState").textContent = "";
    el("resTable").classList.remove("hidden");
    el("winnerNow").textContent = current.winner?.name
      ? `Currently declared: ${current.winner.name}.`
      : "No winner declared yet.";
  } catch (e) { el("resState").textContent = friendlyError(e); }
}

el("declareBtn").addEventListener("click", async () => {
  const uid = el("winnerPick").value;
  if (!uid) return toast("Choose a participant first.", "bad");
  const r = ranked.find(x => x.uid === uid);
  if (!confirm(`Declare ${r.name} as the winner? This shows on the public leaderboard.`)) return;
  try {
    await updateDoc(doc(db, "quizzes", current.id), {
      winner: { uid: r.uid, name: r.name, score: r.score, timeTakenMs: r.timeTakenMs },
      winnerDeclaredAt: serverTimestamp()
    });
    current.winner = { uid: r.uid, name: r.name, score: r.score, timeTakenMs: r.timeTakenMs };
    el("winnerNow").textContent = `Currently declared: ${r.name}.`;
    toast("Winner declared.", "good");
  } catch (e) { toast(friendlyError(e), "bad"); }
});

el("undeclareBtn").addEventListener("click", async () => {
  if (!current) return;
  try {
    await updateDoc(doc(db, "quizzes", current.id), { winner: null });
    current.winner = null;
    el("winnerNow").textContent = "No winner declared yet.";
    toast("Declaration cleared.", "good");
  } catch (e) { toast(friendlyError(e), "bad"); }
});
