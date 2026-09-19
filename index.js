/**
 * QuizArena — server-side scoring.
 *
 * WHY THIS FUNCTION EXISTS
 * Firestore security rules can only allow or deny a read/write. They cannot
 * compare an answer against a hidden document and compute a score. So if the
 * browser did the scoring, the browser would need to read the correct answers
 * first — and anything the browser can read, a participant can read too
 * (DevTools, or a direct REST call with their own token).
 *
 * This function is the only code with permission to read `answerKey`, and the
 * only writer of `results` and `leaderboard`. The participant sends option
 * numbers, nothing else. They never see the key and can never write a score.
 */

const { onCall, HttpsError } = require("firebase-functions/v2/https");
const admin = require("firebase-admin");

admin.initializeApp();
const db = admin.firestore();

// A few seconds of slack for slow phones and clock drift.
const GRACE_MS = 10000;

exports.submitQuiz = onCall({ region: "us-central1" }, async (req) => {
  const uid = req.auth && req.auth.uid;
  if (!uid) throw new HttpsError("unauthenticated", "Start the quiz again from the link.");

  const quizId = String((req.data && req.data.quizId) || "");
  const answers = (req.data && req.data.answers) || {};
  const auto = !!(req.data && req.data.auto);

  if (!quizId) throw new HttpsError("invalid-argument", "Missing quiz code.");
  if (typeof answers !== "object" || Array.isArray(answers)) {
    throw new HttpsError("invalid-argument", "Answers must be an object.");
  }
  if (Object.keys(answers).length > 500) {
    throw new HttpsError("invalid-argument", "Too many answers.");
  }

  const pid = `${quizId}__${uid}`;

  const quizSnap = await db.doc(`quizzes/${quizId}`).get();
  if (!quizSnap.exists) throw new HttpsError("not-found", "That quiz no longer exists.");
  const quiz = quizSnap.data();

  const pSnap = await db.doc(`participants/${pid}`).get();
  if (!pSnap.exists) throw new HttpsError("failed-precondition", "You haven't joined this quiz.");
  const participant = pSnap.data();

  // One submission per participant, forever.
  const resultRef = db.doc(`results/${pid}`);
  if ((await resultRef.get()).exists) {
    throw new HttpsError("already-exists", "You have already submitted this quiz.");
  }

  // Server-side timing. The client clock is never trusted.
  const joinedMs = participant.joinedAt ? participant.joinedAt.toMillis() : Date.now();
  const nowMs = Date.now();
  const limitMs = (quiz.durationMinutes || 10) * 60000;
  const lateBy = nowMs - (joinedMs + limitMs);
  const wasLate = lateBy > GRACE_MS;

  // A late submission still counts, but the clock stops at the deadline so
  // nobody gains time by stalling.
  const timeTakenMs = Math.max(0, Math.min(nowMs - joinedMs, limitMs));

  // Score against the admin-only answer key.
  const [qSnap, kSnap] = await Promise.all([
    db.collection(`quizzes/${quizId}/questions`).get(),
    db.collection(`quizzes/${quizId}/answerKey`).get()
  ]);

  const key = {};
  kSnap.forEach(d => { key[d.id] = d.data(); });

  let score = 0;
  let correctCount = 0;
  const review = {};

  qSnap.forEach(d => {
    const k = key[d.id];
    if (!k) return;
    const marks = Number(k.marks || d.data().marks || 1);
    const given = answers[d.id];
    const ok = Number.isInteger(given) && given === Number(k.correctIndex);
    if (ok) { score += marks; correctCount += 1; }
    review[d.id] = { given: Number.isInteger(given) ? given : null, correct: Number(k.correctIndex), ok };
  });

  const totalMarks = Number(quiz.totalMarks || 0);
  const submittedAt = admin.firestore.FieldValue.serverTimestamp();

  const batch = db.batch();

  // Private result — only this participant and admins can read it.
  batch.set(resultRef, {
    quizId,
    quizTitle: quiz.title || "",
    uid,
    name: participant.name || "",
    email: participant.email || "",
    roll: participant.roll || "",
    score,
    totalMarks,
    correctCount,
    questionCount: qSnap.size,
    timeTakenMs,
    joinedAt: participant.joinedAt || null,
    submittedAt,
    autoSubmitted: auto || wasLate,
    lateSubmission: wasLate,
    review // kept for admin verification; participants cannot read this doc's siblings
  });

  // Public board entry — name, score and time only. No email, no roll.
  batch.set(db.doc(`leaderboard/${quizId}/entries/${uid}`), {
    name: participant.name || "",
    score,
    timeTakenMs,
    submittedAt
  });

  batch.update(db.doc(`participants/${pid}`), { submitted: true, submittedAt });

  // The draft is no longer needed.
  batch.delete(db.doc(`quizzes/${quizId}/drafts/${uid}`));

  await batch.commit();

  return { ok: true, score, totalMarks, correctCount, timeTakenMs };
});
