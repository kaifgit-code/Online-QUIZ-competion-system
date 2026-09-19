# QuizArena

A live quiz-competition website for college events. Plain HTML, CSS and vanilla JavaScript on the front end; Firebase Auth, Firestore and one Cloud Function on the back end. No React, no Node server, no Express, no MongoDB.

---

## 1. Project structure

```
quizarena/
├── index.html              landing page + quiz-code entry
├── quiz.html               participant quiz screen
├── result.html             participant's own score
├── admin.html              admin panel (login required)
├── leaderboard.html        public board
├── css/
│   └── style.css
├── js/
│   ├── firebase-config.js  <-- PASTE YOUR FIREBASE CONFIG HERE
│   ├── quiz.js
│   ├── result.js
│   ├── admin.js
│   └── leaderboard.js
├── functions/
│   ├── index.js            submitQuiz — the only code that can score
│   └── package.json
├── firestore.rules
├── firestore.indexes.json
├── firebase.json
└── README.md
```

---

## 2. Firebase setup (do this first)

1. Go to <https://console.firebase.google.com> → **Add project**. Name it anything, Analytics optional.
2. **Build → Authentication → Get started**
   - Enable **Email/Password** (this is how admins sign in).
   - Enable **Anonymous** (this is how each participant gets a private identity — no signup screen for them).
3. **Build → Firestore Database → Create database** → *Production mode* → pick a region close to your campus.
4. **Project settings (gear) → Your apps → Web `</>`** → register the app → copy the `firebaseConfig` object.
5. Open `js/firebase-config.js` and paste it over the placeholder block at the top. That file is the **only** place you touch config.
6. Upgrade the project to the **Blaze** plan. Cloud Functions require it. For a college event the usage sits inside the free allowance, so the bill is normally ₹0 — but add a budget alert in Google Cloud Billing anyway.

> No Blaze plan? See section 10 for a no-function fallback and what you lose.

---

## 3. Firestore database structure

| Path | Who can read | What's in it |
|---|---|---|
| `admins/{uid}` | that uid only | empty doc; existing = you're an admin |
| `quizzes/{quizId}` | everyone | title, description, durationMinutes, status, startAt, endAt, questionCount, totalMarks, winner, ownerUid, createdAt |
| `quizzes/{quizId}/questions/{qId}` | everyone | order, text, options[4], marks — **no correct answer** |
| `quizzes/{quizId}/answerKey/{qId}` | admins only | correctIndex, explanation, marks |
| `quizzes/{quizId}/drafts/{uid}` | that participant + admins | answers in progress (survives refresh) |
| `participants/{quizId__uid}` | that participant + admins | name, email, roll, joinedAt, submitted |
| `results/{quizId__uid}` | that participant + admins | score, correctCount, timeTakenMs, submittedAt, review |
| `leaderboard/{quizId}/entries/{uid}` | everyone | name, score, timeTakenMs, submittedAt only |

Two things are deliberately split from the obvious design:

- **Questions and answers live in different collections.** The quiz screen needs the question text, so `questions` has to be publicly readable. If `correctIndex` sat on the same document, every participant could open DevTools and read it. Splitting it into `answerKey` means the public collection simply has nothing worth stealing.
- **The public board is a separate copy, not a view of `results`.** Firestore rules work per document, not per field — you cannot make a document public but hide its `email` field. So the function writes a second, stripped-down document containing only name, score and time.

Document ids are `quizId__uid` so a rule can check ownership from the id alone, without reading the document first.

---

## 4. Firestore security rules

Everything is in `firestore.rules`. Paste it into **Firestore → Rules → Publish**, or deploy with `firebase deploy --only firestore:rules`.

What it guarantees:

| A participant tries to… | Result |
|---|---|
| open `admin.html` | page loads but the panel never unlocks — their uid isn't in `admins` |
| read `quizzes/x/answerKey` | **denied** — admins only |
| edit a question | **denied** — writes to `questions` need admin |
| write `results/...` | **denied** — `allow create, update, delete: if false` for everyone |
| edit their own score | **denied** — same rule; only the Admin SDK can write there |
| read someone else's answers or result | **denied** — `ownsId()` checks the uid baked into the doc id |
| join a quiz that isn't active | **denied** — the create rule calls `get()` on the quiz and checks `status == 'active'` |
| submit twice | **denied** — the function refuses if a result already exists |
| fake their join time to get extra minutes | **denied** — `joinedAt == request.time` forces the server clock |

---

## 5. Why a Cloud Function is genuinely necessary

Security rules can only say *yes* or *no* to a read or a write. They cannot compare a submitted answer to a hidden document and produce a number. So there are only three ways to get a score:

1. **Score in the browser.** The browser would need the answer key, which means the answer key must be readable, which means the participant can read it. Broken.
2. **Let the browser write its own score.** Then a participant can send `{score: 100}` with a REST call. Broken.
3. **Score on the server.** The Cloud Function runs with the Admin SDK, reads `answerKey`, computes the score, and writes `results` and `leaderboard`. The browser only ever sends `{quizId, answers: {questionId: 0..3}}`.

Option 3 is the only one that isn't a shortcut, so that's what `functions/index.js` does. It also:

- rejects unauthenticated calls,
- rejects a second submission from the same participant,
- recomputes the elapsed time from the **server** `joinedAt`, clamped to the quiz duration, so stalling past the deadline gains nothing,
- marks late arrivals with `lateSubmission: true` so you can spot them during review.

---

## 6. Admin setup

1. **Authentication → Users → Add user.** Enter an email and password for the organiser. Copy the generated **User UID**.
2. **Firestore → Start collection** → collection id `admins` → document id = that **UID** → add one field, e.g. `email` (string). The document's *existence* is what grants access; the contents don't matter.
3. Open `admin.html`, sign in with that email and password.

To remove an admin, delete their `admins` document. To add one, repeat step 2. Because `admins` is write-locked in the rules, nobody can promote themselves from the browser.

---

## 7. Deployment

### Option A — Firebase Hosting (recommended, needed for the function anyway)

```bash
npm install -g firebase-tools
firebase login
cd quizarena
firebase init          # choose Hosting + Firestore + Functions
                       # public directory: .   |  single-page app: No
                       # Functions language: JavaScript, don't overwrite index.js
cd functions && npm install && cd ..
firebase deploy
```

Your site lands on `https://YOUR-PROJECT.web.app`. Deploy pieces separately with
`firebase deploy --only hosting` / `--only functions` / `--only firestore:rules`.

### Option B — GitHub Pages (front end only)

Push the folder to a repo, then **Settings → Pages → Branch: main / root**. The site works, but you still need `firebase deploy --only functions,firestore:rules` from your machine, and you must add your Pages domain under **Authentication → Settings → Authorized domains**.

---

## 8. QR code setup

Nothing to install. `admin.html` loads `qrcodejs` from a CDN and generates the code in the browser.

1. Open a quiz in the admin panel → **Link & QR code**.
2. The link is `https://your-site/quiz.html?quiz=<quizCode>`.
3. **Copy link** for WhatsApp, **Download QR** for a PNG you can project or print.

The QR points at a public URL — that's fine, because the quiz only lets people in while its status is `active`.

---

## 9. Testing checklist

**Admin**
- [ ] Non-admin account signs in and is bounced with a clear message.
- [ ] Create a quiz, add 3 questions, reorder them, edit one, delete one.
- [ ] `questionCount` and `totalMarks` update on the quiz card.
- [ ] Activate / deactivate flips the pill and blocks new joins when off.
- [ ] QR downloads and actually scans on a phone.

**Participant**
- [ ] Open `quiz.html` with no `?quiz=` → clear "no quiz in this link" screen.
- [ ] Open with a wrong code → "quiz not found".
- [ ] Try to join a draft quiz → "this quiz isn't open".
- [ ] Empty name → blocked; 1-character name → blocked; bad email → blocked.
- [ ] Question counter shows `3/20`, previous/next work, selection survives navigation.
- [ ] Refresh mid-quiz → answers restored, timer continues from the original start.
- [ ] Turn off mobile data for 20s, keep answering, turn it back on → submit still works.
- [ ] Let the timer hit 0 → auto-submits and lands on the result page.
- [ ] Press back and re-open the quiz link after submitting → redirected to the result, no second attempt.

**Security** (open DevTools as a participant)
- [ ] `getDoc(doc(db,'quizzes','CODE','answerKey','ANY_ID'))` → permission denied.
- [ ] `setDoc(doc(db,'results','CODE__myuid'), {score: 999})` → permission denied.
- [ ] Reading another participant's result doc → permission denied.
- [ ] Calling `submitQuiz` twice → `already-exists`.

**Results**
- [ ] Two participants with equal scores rank by shorter time.
- [ ] Equal score *and* time rank by earlier submission.
- [ ] Public leaderboard shows no email and no roll number.
- [ ] Declaring a winner shows the name on `leaderboard.html`; clearing removes it.

---

## 10. The whole flow in one paragraph

The admin signs in, creates a quiz, types the questions straight into the panel — the text and options go to `questions`, the correct option goes to the admin-only `answerKey` — sets a duration, activates the quiz and projects the QR code. A participant scans it, gets an anonymous Firebase identity, enters their name, and `participants/{quizId__uid}` is created with a **server** timestamp that starts their clock. They answer one question at a time while a draft autosaves. On submit (or at 0:00, automatically) the browser sends only the chosen option numbers to the `submitQuiz` Cloud Function. That function reads the answer key with admin privileges, computes the score and the true elapsed time, writes a private `results` document and a stripped public `leaderboard` entry, and marks the participant as submitted. The admin sees every entry ranked by score, then shortest time, then earliest submission, checks the top few, and declares the winner — which is the only moment a name is published as the champion.

---

## 11. Running without the Blaze plan (fallback)

If you truly cannot enable billing: delete the `submitQuiz` call and instead let participants write their answers to an admin-only `submissions` collection (`allow create: if signedIn() && !exists(...)`, `allow read: if isAdmin()`), then add a "Score all submissions" button in the admin panel that runs the same comparison in the admin's browser — the admin *is* allowed to read the answer key.

You lose instant results (participants see "submitted, results soon") and the scoring depends on the admin clicking a button. Everything else, including the fact that participants can never read the key or write a score, still holds. Use this only if Blaze is impossible.
