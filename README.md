# Zetamax

A Zetamac-style mental math trainer with accounts. Python (Flask) backend,
plain HTML/CSS/JS frontend. Improvement mode is driven by a decision tree
regressor trained on your own solve-time history.

## Run it

```bash
pip install -r requirements.txt
python app.py
```

Then open http://127.0.0.1:5050 — you'll be redirected to the login page.
Click "Create one" to register an account (username + password, min 6 chars).

## How it's structured

- `app.py` — Flask app. Handles registration/login/logout with server-side
  sessions and hashed passwords (`werkzeug.security`), a JSON API for runs
  (`/api/runs`, GET/POST/DELETE, plus `/api/runs/<id>` to delete one run),
  and `/api/next_problems` which generates problems — either uniformly
  random (standard mode) or model-picked (improvement mode).
- `app.db` — SQLite database (created automatically on first run). Two
  tables: `users` and `runs`. Each run stores its list of solved problems
  as JSON, including `x1`, `x2`, `op`, and `timeMs` per problem.
- `templates/` — Jinja2 templates (`login.html`, `register.html`, `app.html`,
  `base.html` for the shared nav/flash messages).
- `static/style.css` — all styling.
- `static/app.js` — the game itself: timer, scoring, auto-submit input
  handling, run history/delete, and a small server-fed problem queue.
  Talks to the backend only via `fetch()` — no client-side storage.

## Gameplay changes from the original version

- **Auto-submit.** No Enter key. The input is checked after every
  keystroke: the instant what you've typed equals the answer, it submits
  and moves to the next problem. If what you've typed can no longer be the
  start of the correct answer (e.g. answer is 45, you've typed "9"), it
  flashes red and clears immediately — same as real Zetamac.
- **Run deletion.** Every run appears in a "Run history" panel on the home
  screen with a ✕ button that deletes just that run
  (`DELETE /api/runs/<id>`). "Clear data" still wipes everything.
- **Improvement mode is gated at 10 runs.** The button is disabled and
  shows a progress note ("you're at 6/10") until you've logged 10 runs.
  This is a UI-level gate — it's checking `runs.length`, not sample count.

## How the "slow at" model actually works

**The dataset.** Every problem you solve correctly is logged as one row:

```
x1, x2, op, timeMs
```

`x1`/`x2` are the two operands as shown to you (for division, `x1` is the
dividend and `x2` is the divisor, so the model sees the actual numbers on
screen, not the hidden quotient). `op` is one of add/sub/mul/div. `timeMs`
is how long it took you to type the correct answer, from when the problem
appeared to when your input matched. This accumulates across every run
you've ever done — it's just the `problems` JSON already stored in `runs`,
unpacked into rows.

**The model.** In `app.py`, `build_dataset()` pulls that table for the
logged-in user and turns it into `X = [x1, x2, is_add, is_sub, is_mul,
is_div]`, `y = timeMs` (operator is one-hot encoded). `train_tree()` fits a
`sklearn.tree.DecisionTreeRegressor` (depth 3–4 depending on how much data
you have) on that. This is a real regression tree: it learns splits like
"if is_mul and x2 > 60, average solve time is high" directly from your
history — not a hand-picked bucket.

**Picking the next problem.** For each problem slot in an improvement run,
the backend generates 30 random candidate problems across your enabled
operations, asks the tree to predict a solve time for each, then samples
one with probability weighted toward the higher predictions (a softmax
over z-scored predictions — so a problem the tree thinks will take 2
standard deviations longer than average is much more likely to be picked,
but it's not a hard argmax). 20% of the time it ignores the model and
picks a candidate uniformly at random, so it keeps exploring instead of
narrowing in on one slice of problem space and starving the model of new
data on everything else.

**Minimum data.** The tree needs at least 15 solved-problem samples before
it fits at all (`MIN_MODEL_SAMPLES`); below that, improvement mode falls
back to uniform random generation and the in-game tag says "gathering
data" instead of "model trained on N solves." In practice, 10 runs at
even a short duration comfortably clears this — the 10-run gate is really
about giving the model enough *breadth* across categories, not just count.

## Notes

- Passwords are hashed (never stored in plaintext).
- Data is scoped per user — one account can't see another's runs.
- The Flask secret key is generated once and saved to `.secret_key` so
  sessions survive restarts. Don't commit that file if you put this in git.
- This is set up for local/dev use (`debug=True`). For real deployment,
  turn off debug mode, set a proper `SECRET_KEY` via environment variable,
  and put it behind a real WSGI server (gunicorn, etc).