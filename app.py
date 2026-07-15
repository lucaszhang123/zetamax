import os
import json
import random
import sqlite3
import secrets
from functools import wraps
from datetime import datetime

import numpy as np
from sklearn.tree import DecisionTreeRegressor

from flask import (
    Flask, request, session, redirect, url_for,
    render_template, jsonify, g, flash
)
from werkzeug.security import generate_password_hash, check_password_hash

BASE_DIR = os.path.dirname(os.path.abspath(__file__))
DB_PATH = os.path.join(BASE_DIR, "app.db")

app = Flask(__name__)
# Persist the secret key across restarts so sessions don't get invalidated
SECRET_FILE = os.path.join(BASE_DIR, ".secret_key")
if os.path.exists(SECRET_FILE):
    app.secret_key = open(SECRET_FILE, "r").read().strip()
else:
    key = secrets.token_hex(32)
    with open(SECRET_FILE, "w") as f:
        f.write(key)
    app.secret_key = key


# ---------------------------------------------------------------------------
# Database helpers
# ---------------------------------------------------------------------------
def get_db():
    if "db" not in g:
        g.db = sqlite3.connect(DB_PATH)
        g.db.row_factory = sqlite3.Row
    return g.db


@app.teardown_appcontext
def close_db(exception=None):
    db = g.pop("db", None)
    if db is not None:
        db.close()


def init_db():
    db = sqlite3.connect(DB_PATH)
    db.execute("""
        CREATE TABLE IF NOT EXISTS users (
            id INTEGER PRIMARY KEY AUTOINCREMENT,
            username TEXT UNIQUE NOT NULL,
            password_hash TEXT NOT NULL,
            created_at TEXT NOT NULL
        )
    """)
    db.execute("""
        CREATE TABLE IF NOT EXISTS runs (
            id INTEGER PRIMARY KEY AUTOINCREMENT,
            user_id INTEGER NOT NULL,
            mode TEXT NOT NULL,
            duration INTEGER NOT NULL,
            score INTEGER NOT NULL,
            date TEXT NOT NULL,
            problems TEXT NOT NULL,
            FOREIGN KEY (user_id) REFERENCES users (id)
        )
    """)
    # Migration: older DBs won't have these columns yet. They record which
    # operations and operand ranges were active for the run, so the frontend
    # can group/compare only like-for-like runs (same duration, same config)
    # instead of averaging a 30s run in with a 120s run.
    existing_cols = {row[1] for row in db.execute("PRAGMA table_info(runs)").fetchall()}
    if "ops" not in existing_cols:
        db.execute("ALTER TABLE runs ADD COLUMN ops TEXT NOT NULL DEFAULT '[]'")
    if "ranges" not in existing_cols:
        db.execute("ALTER TABLE runs ADD COLUMN ranges TEXT NOT NULL DEFAULT '{}'")
    db.commit()
    db.close()


# ---------------------------------------------------------------------------
# Problem generation + the "which questions are you slow at" model
#
# Every solved problem is logged as a row: (x1, x2, op, timeMs). That's the
# dataset. In improvement mode we fit a small decision tree regressor on
# that dataset to predict solve time from (x1, x2, op), then generate a
# batch of candidate problems, score them with the tree, and sample toward
# the ones the tree predicts will be slow.
# ---------------------------------------------------------------------------
OPS = ["add", "sub", "mul", "div"]
MIN_RUNS_FOR_IMPROVEMENT = 10   # gate used by the frontend to unlock the mode
MIN_MODEL_SAMPLES = 15          # solved problems needed before we trust a tree
CANDIDATES_PER_PICK = 30        # candidate pool size per problem in improvement mode
EXPLORATION_EPSILON = 0.2       # fraction of the time we ignore the model and pick randomly

DEFAULT_RANGES = {"add": [2, 100, 2, 100], "mul": [2, 12, 2, 100]}


def rand_int(a, b):
    if b < a:
        a, b = b, a
    return random.randint(a, b)


def clean_ranges(raw):
    """Validate/clamp incoming range settings, falling back to defaults on
    anything malformed. Format: {"add": [min1, max1, min2, max2], "mul": [...]}."""
    ranges = {"add": list(DEFAULT_RANGES["add"]), "mul": list(DEFAULT_RANGES["mul"])}
    if not isinstance(raw, dict):
        return ranges
    for key in ("add", "mul"):
        vals = raw.get(key)
        if not isinstance(vals, list) or len(vals) != 4:
            continue
        try:
            min1, max1, min2, max2 = (int(v) for v in vals)
        except (TypeError, ValueError):
            continue
        min1, max1 = max(1, min1), max(1, max1)
        min2, max2 = max(1, min2), max(1, max2)
        if max1 < min1:
            max1 = min1
        if max2 < min2:
            max2 = min2
        ranges[key] = [min1, max1, min2, max2]
    return ranges


def gen_random_problem(op, ranges=None):
    """Generate one problem for a given operation. Subtraction reuses the
    addition range, division reuses the multiplication range — same
    convention Zetamac uses ("addition problems in reverse", etc)."""
    ranges = ranges or DEFAULT_RANGES
    add_min1, add_max1, add_min2, add_max2 = ranges["add"]
    mul_min1, mul_max1, mul_min2, mul_max2 = ranges["mul"]

    if op == "add":
        x1, x2 = rand_int(add_min1, add_max1), rand_int(add_min2, add_max2)
        return {"op": op, "x1": x1, "x2": x2, "question": f"{x1} + {x2}", "answer": x1 + x2}
    if op == "sub":
        a, b = rand_int(add_min1, add_max1), rand_int(add_min2, add_max2)
        if b > a:
            a, b = b, a
        return {"op": op, "x1": a, "x2": b, "question": f"{a} − {b}", "answer": a - b}
    if op == "mul":
        x1, x2 = rand_int(mul_min1, mul_max1), rand_int(mul_min2, mul_max2)
        return {"op": op, "x1": x1, "x2": x2, "question": f"{x1} × {x2}", "answer": x1 * x2}
    # division: inverse of multiplication so the answer is always a whole number
    divisor, quotient = rand_int(mul_min1, mul_max1), rand_int(mul_min2, mul_max2)
    dividend = divisor * quotient
    return {"op": op, "x1": dividend, "x2": divisor, "question": f"{dividend} ÷ {divisor}", "answer": quotient}


def op_one_hot(op):
    return [1.0 if op == o else 0.0 for o in OPS]


FACTORS = list(range(2, 13))  # 2..12 — the "times table" range used for mul's x1 and div's x2


def factor_one_hot(op, x1, x2):
    """One-hot over which specific 2-12 factor is in play for mul/div, so the
    model can learn a fact like '×9 is slow' directly instead of only having
    continuous x1/x2 to infer it from threshold splits."""
    vec = [0.0] * len(FACTORS)
    if op == "mul" and x1 in FACTORS:
        vec[FACTORS.index(x1)] = 1.0
    elif op == "div" and x2 in FACTORS:
        vec[FACTORS.index(x2)] = 1.0
    return vec


def featurize(op, x1, x2):
    """Feature vector for the model: [x1, x2, is_add, is_sub, is_mul, is_div,
    one-hot over which ×/÷ factor (2-12) this problem uses]."""
    return [float(x1), float(x2)] + op_one_hot(op) + factor_one_hot(op, x1, x2)


def build_dataset(user_id, db):
    """Pull every correctly-solved problem for this user into an (X, y) dataset."""
    rows = db.execute(
        "SELECT problems FROM runs WHERE user_id = ?", (user_id,)
    ).fetchall()
    X, y = [], []
    for row in rows:
        for p in json.loads(row["problems"]):
            if not p.get("correct"):
                continue
            if "x1" not in p or "x2" not in p or "op" not in p or "timeMs" not in p:
                continue
            X.append(featurize(p["op"], p["x1"], p["x2"]))
            y.append(p["timeMs"])
    return np.array(X, dtype=float), np.array(y, dtype=float)


def train_tree(X, y):
    """Fit a small decision tree regressor: (x1, x2, op, ×/÷ factor) -> predicted solve time."""
    if len(X) < MIN_MODEL_SAMPLES:
        return None
    depth = 4 if len(X) < 60 else 5
    min_leaf = max(3, len(X) // 20)
    model = DecisionTreeRegressor(max_depth=depth, min_samples_leaf=min_leaf, random_state=0)
    model.fit(X, y)
    return model


def pick_weighted(candidates, preds):
    """Softmax-weighted sample favoring candidates the tree predicts are slow,
    with epsilon-greedy exploration so it doesn't fixate on one narrow slice."""
    if random.random() < EXPLORATION_EPSILON or np.std(preds) == 0:
        return candidates[random.randrange(len(candidates))]
    z = (preds - preds.mean()) / (preds.std() + 1e-9)
    weights = np.exp(z)
    weights = weights / weights.sum()
    idx = np.random.choice(len(candidates), p=weights)
    return candidates[idx]


def bucket_of(n):
    if n < 35:
        return "low"
    if n < 68:
        return "mid"
    return "high"


def problem_group_id(problem):
    """Return the same fact id used by the frontend Weak spots by fact table."""
    op = problem["op"]
    if op == "mul":
        return f"mul_{problem['x1']}"
    if op == "div":
        return f"div_{problem['x2']}"
    if op == "add":
        return f"add_{bucket_of(max(problem['x1'], problem['x2']))}"
    return f"sub_{bucket_of(problem['x1'])}"


def clean_fact_ids(raw, ops):
    """Validate manual improvement fact ids such as mul_8 or add_high."""
    if not isinstance(raw, list):
        return []
    allowed_ops = set(ops)
    cleaned = []
    seen = set()
    for value in raw:
        if not isinstance(value, str) or "_" not in value:
            continue
        op, rest = value.split("_", 1)
        if op not in allowed_ops:
            continue
        valid = False
        if op in ("mul", "div"):
            try:
                factor = int(rest)
                valid = 1 <= factor <= 9999
            except ValueError:
                valid = False
        else:
            valid = rest in ("low", "mid", "high")
        if valid and value not in seen:
            seen.add(value)
            cleaned.append(value)
    return cleaned


def gen_problem_for_fact(fact_id, ranges):
    """Generate one problem constrained to an exact frontend fact group.

    Multiplication/division facts pin the table factor. Addition/subtraction
    facts use the same low/mid/high magnitude buckets as the dashboard.
    Returns None when the current ranges cannot produce the requested fact.
    """
    op, rest = fact_id.split("_", 1)
    add_min1, add_max1, add_min2, add_max2 = ranges["add"]
    mul_min1, mul_max1, mul_min2, mul_max2 = ranges["mul"]

    if op == "mul":
        factor = int(rest)
        if not (mul_min1 <= factor <= mul_max1):
            return None
        x2 = rand_int(mul_min2, mul_max2)
        return {"op": op, "x1": factor, "x2": x2,
                "question": f"{factor} × {x2}", "answer": factor * x2}

    if op == "div":
        divisor = int(rest)
        if not (mul_min1 <= divisor <= mul_max1):
            return None
        quotient = rand_int(mul_min2, mul_max2)
        dividend = divisor * quotient
        return {"op": op, "x1": dividend, "x2": divisor,
                "question": f"{dividend} ÷ {divisor}", "answer": quotient}

    # Addition/subtraction buckets depend on the larger displayed operand.
    # Rejection sampling is simple and exact, and the loop is bounded so an
    # impossible custom range cannot stall a request.
    for _ in range(200):
        problem = gen_random_problem(op, ranges)
        if problem_group_id(problem) == fact_id:
            return problem
    return None


def fact_candidate_pool(fact_ids, ranges, size):
    pool = []
    attempts = 0
    max_attempts = max(size * 10, 50)
    while len(pool) < size and attempts < max_attempts:
        attempts += 1
        fact_id = random.choice(fact_ids)
        problem = gen_problem_for_fact(fact_id, ranges)
        if problem is not None:
            pool.append(problem)
    return pool


def generate_problems(user_id, db, mode, ops, count, ranges=None, fact_ids=None):
    ops = [o for o in ops if o in OPS] or OPS[:]
    ranges = ranges or DEFAULT_RANGES
    fact_ids = clean_fact_ids(fact_ids, ops)
    problems = []
    model_used = False
    sample_count = 0

    if mode == "improvement":
        X, y = build_dataset(user_id, db)
        sample_count = len(X)
        model = train_tree(X, y)
        model_used = model is not None
        for _ in range(count):
            if fact_ids:
                pool = fact_candidate_pool(fact_ids, ranges, CANDIDATES_PER_PICK)
            else:
                pool = [gen_random_problem(random.choice(ops), ranges)
                        for _ in range(CANDIDATES_PER_PICK)]

            # Custom ranges can make a selected fact impossible. Fall back to
            # the enabled operations instead of returning an empty queue.
            if not pool:
                pool = [gen_random_problem(random.choice(ops), ranges)]

            if model is None:
                problems.append(random.choice(pool))
                continue

            feats = np.array([featurize(p["op"], p["x1"], p["x2"]) for p in pool])
            preds = model.predict(feats)
            problems.append(pick_weighted(pool, preds))
    else:
        for _ in range(count):
            problems.append(gen_random_problem(random.choice(ops), ranges))

    return problems, model_used, sample_count


# ---------------------------------------------------------------------------
# Auth helpers
# ---------------------------------------------------------------------------
def login_required(view):
    @wraps(view)
    def wrapped(*args, **kwargs):
        if "user_id" not in session:
            return redirect(url_for("login", next=request.path))
        return view(*args, **kwargs)
    return wrapped


# ---------------------------------------------------------------------------
# Auth routes
# ---------------------------------------------------------------------------
@app.route("/register", methods=["GET", "POST"])
def register():
    if request.method == "POST":
        username = request.form.get("username", "").strip()
        password = request.form.get("password", "")
        confirm = request.form.get("confirm", "")

        if len(username) < 3:
            flash("Username must be at least 3 characters.")
        elif len(password) < 6:
            flash("Password must be at least 6 characters.")
        elif password != confirm:
            flash("Passwords don't match.")
        else:
            db = get_db()
            existing = db.execute(
                "SELECT id FROM users WHERE username = ?", (username,)
            ).fetchone()
            if existing:
                flash("That username is already taken.")
            else:
                db.execute(
                    "INSERT INTO users (username, password_hash, created_at) VALUES (?, ?, ?)",
                    (username, generate_password_hash(password), datetime.utcnow().isoformat()),
                )
                db.commit()
                user = db.execute(
                    "SELECT id FROM users WHERE username = ?", (username,)
                ).fetchone()
                session.clear()
                session["user_id"] = user["id"]
                session["username"] = username
                return redirect(url_for("index"))

    return render_template("register.html")


@app.route("/login", methods=["GET", "POST"])
def login():
    if request.method == "POST":
        username = request.form.get("username", "").strip()
        password = request.form.get("password", "")

        db = get_db()
        user = db.execute(
            "SELECT * FROM users WHERE username = ?", (username,)
        ).fetchone()

        if user is None or not check_password_hash(user["password_hash"], password):
            flash("Incorrect username or password.")
        else:
            session.clear()
            session["user_id"] = user["id"]
            session["username"] = user["username"]
            next_url = request.args.get("next") or url_for("index")
            return redirect(next_url)

    return render_template("login.html")


@app.route("/logout")
def logout():
    session.clear()
    return redirect(url_for("login"))


# ---------------------------------------------------------------------------
# App routes
# ---------------------------------------------------------------------------
@app.route("/")
@login_required
def index():
    return render_template("app.html", username=session["username"])


# ---------------------------------------------------------------------------
# JSON API — all scoped to the logged-in user
# ---------------------------------------------------------------------------
@app.route("/api/runs", methods=["GET"])
@login_required
def api_get_runs():
    db = get_db()
    rows = db.execute(
        "SELECT * FROM runs WHERE user_id = ? ORDER BY id ASC",
        (session["user_id"],),
    ).fetchall()
    runs = []
    for r in rows:
        runs.append({
            "id": r["id"],
            "mode": r["mode"],
            "duration": r["duration"],
            "score": r["score"],
            "date": r["date"],
            "problems": json.loads(r["problems"]),
            "ops": json.loads(r["ops"]) if r["ops"] else [],
            "ranges": json.loads(r["ranges"]) if r["ranges"] else {},
        })
    return jsonify(runs)


@app.route("/api/runs", methods=["POST"])
@login_required
def api_save_run():
    data = request.get_json(force=True)
    required = ("mode", "duration", "score", "date", "problems")
    if not all(k in data for k in required):
        return jsonify({"error": "missing fields"}), 400

    db = get_db()
    db.execute(
        "INSERT INTO runs (user_id, mode, duration, score, date, problems, ops, ranges) "
        "VALUES (?, ?, ?, ?, ?, ?, ?, ?)",
        (
            session["user_id"],
            data["mode"],
            int(data["duration"]),
            int(data["score"]),
            data["date"],
            json.dumps(data["problems"]),
            json.dumps(data.get("ops", [])),
            json.dumps(data.get("ranges", {})),
        ),
    )
    db.commit()
    return jsonify({"ok": True}), 201


@app.route("/api/runs", methods=["DELETE"])
@login_required
def api_clear_runs():
    db = get_db()
    db.execute("DELETE FROM runs WHERE user_id = ?", (session["user_id"],))
    db.commit()
    return jsonify({"ok": True})


@app.route("/api/runs/<int:run_id>", methods=["DELETE"])
@login_required
def api_delete_run(run_id):
    db = get_db()
    cur = db.execute(
        "DELETE FROM runs WHERE id = ? AND user_id = ?",
        (run_id, session["user_id"]),
    )
    db.commit()
    if cur.rowcount == 0:
        return jsonify({"error": "not found"}), 404
    return jsonify({"ok": True})


@app.route("/api/next_problems", methods=["POST"])
@login_required
def api_next_problems():
    data = request.get_json(force=True) or {}
    ops = data.get("ops", OPS)
    mode = data.get("mode", "standard")
    count = max(1, min(int(data.get("count", 15)), 50))
    ranges = clean_ranges(data.get("ranges"))
    fact_ids = data.get("fact_ids", [])

    db = get_db()
    problems, model_used, sample_count = generate_problems(
        session["user_id"], db, mode, ops, count, ranges, fact_ids
    )
    return jsonify({
        "problems": problems,
        "model_used": model_used,
        "training_samples": sample_count,
    })


if __name__ == "__main__":
    init_db()
    app.run(debug=True, port=5050)
else:
    init_db()