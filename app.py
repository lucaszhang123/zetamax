import os
import json
import random
import sqlite3
import secrets
from functools import wraps
from datetime import datetime, timedelta, timezone

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
        g.db = sqlite3.connect(DB_PATH, timeout=10)
        g.db.row_factory = sqlite3.Row
        g.db.execute("PRAGMA foreign_keys = ON")
        g.db.execute("PRAGMA busy_timeout = 10000")
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

    # Multiplayer race rooms are persisted in SQLite so they work across
    # browser tabs and across multiple Flask workers without in-memory state.
    db.execute("""
        CREATE TABLE IF NOT EXISTS race_rooms (
            id INTEGER PRIMARY KEY AUTOINCREMENT,
            code TEXT UNIQUE NOT NULL,
            host_user_id INTEGER NOT NULL,
            status TEXT NOT NULL DEFAULT 'waiting',
            ops TEXT NOT NULL,
            ranges TEXT NOT NULL,
            question_count INTEGER NOT NULL DEFAULT 50,
            questions TEXT NOT NULL,
            created_at TEXT NOT NULL,
            started_at TEXT,
            finished_at TEXT,
            FOREIGN KEY (host_user_id) REFERENCES users (id)
        )
    """)
    db.execute("""
        CREATE TABLE IF NOT EXISTS race_players (
            id INTEGER PRIMARY KEY AUTOINCREMENT,
            room_id INTEGER NOT NULL,
            user_id INTEGER NOT NULL,
            progress INTEGER NOT NULL DEFAULT 0,
            wrong_attempts INTEGER NOT NULL DEFAULT 0,
            joined_at TEXT NOT NULL,
            finished_at TEXT,
            elapsed_ms INTEGER,
            last_seen TEXT NOT NULL,
            UNIQUE (room_id, user_id),
            FOREIGN KEY (room_id) REFERENCES race_rooms (id) ON DELETE CASCADE,
            FOREIGN KEY (user_id) REFERENCES users (id)
        )
    """)
    db.execute("CREATE INDEX IF NOT EXISTS idx_race_players_room ON race_players (room_id)")
    db.execute("CREATE INDEX IF NOT EXISTS idx_race_rooms_code ON race_rooms (code)")
    db.execute("PRAGMA journal_mode = WAL")
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
# Multiplayer race helpers
# ---------------------------------------------------------------------------
RACE_QUESTION_COUNT = 50
RACE_MAX_PLAYERS = 8
RACE_CODE_ALPHABET = "ABCDEFGHJKLMNPQRSTUVWXYZ23456789"


def utc_now():
    return datetime.now(timezone.utc)


def iso_utc(value=None):
    value = value or utc_now()
    return value.astimezone(timezone.utc).isoformat().replace("+00:00", "Z")


def parse_utc(value):
    if not value:
        return None
    return datetime.fromisoformat(value.replace("Z", "+00:00"))


def clean_race_ops(raw):
    if not isinstance(raw, list):
        return OPS[:]
    cleaned = []
    for op in raw:
        if op in OPS and op not in cleaned:
            cleaned.append(op)
    return cleaned or OPS[:]


def make_race_code(db):
    for _ in range(50):
        code = "".join(secrets.choice(RACE_CODE_ALPHABET) for _ in range(6))
        exists = db.execute("SELECT 1 FROM race_rooms WHERE code = ?", (code,)).fetchone()
        if not exists:
            return code
    raise RuntimeError("Could not create a unique race code")


def race_room_for_user(db, code, user_id):
    return db.execute(
        """
        SELECT rr.*
        FROM race_rooms rr
        JOIN race_players rp ON rp.room_id = rr.id
        WHERE rr.code = ? AND rp.user_id = ?
        """,
        (code, user_id),
    ).fetchone()


def maybe_finish_race(db, room_id):
    counts = db.execute(
        """
        SELECT COUNT(*) AS total,
               SUM(CASE WHEN finished_at IS NOT NULL THEN 1 ELSE 0 END) AS finished
        FROM race_players
        WHERE room_id = ?
        """,
        (room_id,),
    ).fetchone()
    total = int(counts["total"] or 0)
    finished = int(counts["finished"] or 0)
    if total > 0 and total == finished:
        db.execute(
            "UPDATE race_rooms SET status = 'finished', finished_at = COALESCE(finished_at, ?) WHERE id = ?",
            (iso_utc(), room_id),
        )
        return True
    return False


def race_state(db, room, user_id):
    """Return only the logged-in player's current question. Answers stay on
    the server and are validated by the answer endpoint."""
    now = utc_now()
    questions = json.loads(room["questions"])
    players = db.execute(
        """
        SELECT rp.*, u.username
        FROM race_players rp
        JOIN users u ON u.id = rp.user_id
        WHERE rp.room_id = ?
        """,
        (room["id"],),
    ).fetchall()

    started = parse_utc(room["started_at"])
    elapsed_live_ms = 0
    if started and now >= started:
        elapsed_live_ms = max(1, int((now - started).total_seconds() * 1000))

    serialized = []
    for player in players:
        progress = int(player["progress"])
        elapsed_ms = player["elapsed_ms"]
        if elapsed_ms is not None:
            qpm = progress * 60000.0 / max(1, int(elapsed_ms))
        elif elapsed_live_ms:
            qpm = progress * 60000.0 / elapsed_live_ms
        else:
            qpm = 0.0
        serialized.append({
            "user_id": player["user_id"],
            "username": player["username"],
            "progress": progress,
            "wrong_attempts": int(player["wrong_attempts"]),
            "finished_at": player["finished_at"],
            "elapsed_ms": elapsed_ms,
            "qpm": round(qpm, 2),
            "is_me": player["user_id"] == user_id,
            "is_host": player["user_id"] == room["host_user_id"],
        })

    serialized.sort(key=lambda p: (
        0 if p["finished_at"] else 1,
        p["elapsed_ms"] if p["elapsed_ms"] is not None else -p["progress"],
        p["username"].lower(),
    ))
    for index, player in enumerate(serialized, start=1):
        player["position"] = index

    me = next((player for player in serialized if player["is_me"]), None)
    current_question = None
    current_answer = None
    if (
        me
        and room["status"] == "racing"
        and started
        and now >= started
        and me["progress"] < int(room["question_count"])
    ):
        current_problem = questions[me["progress"]]
        current_question = current_problem["question"]
        # Race input follows the same client-side auto-submit behavior as the
        # standard run: the browser waits until the typed value exactly equals
        # the answer, then sends the one correct submission to the server.
        current_answer = int(current_problem["answer"])

    countdown_ms = 0
    if room["status"] == "racing" and started and now < started:
        countdown_ms = max(0, int((started - now).total_seconds() * 1000))

    return {
        "code": room["code"],
        "status": room["status"],
        "host_user_id": room["host_user_id"],
        "is_host": room["host_user_id"] == user_id,
        "ops": json.loads(room["ops"]),
        "ranges": json.loads(room["ranges"]),
        "question_count": int(room["question_count"]),
        "created_at": room["created_at"],
        "started_at": room["started_at"],
        "finished_at": room["finished_at"],
        "server_now": iso_utc(now),
        "countdown_ms": countdown_ms,
        "current_question": current_question,
        "current_answer": current_answer,
        "players": serialized,
    }


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



# ---------------------------------------------------------------------------
# Multiplayer race API
# ---------------------------------------------------------------------------
@app.route("/api/races", methods=["POST"])
@login_required
def api_create_race():
    data = request.get_json(force=True) or {}
    ops = clean_race_ops(data.get("ops"))
    ranges = clean_ranges(data.get("ranges"))
    db = get_db()

    # Remove abandoned waiting rooms created by this user more than a day ago.
    cutoff = iso_utc(utc_now() - timedelta(days=1))
    old_rooms = db.execute(
        "SELECT id FROM race_rooms WHERE host_user_id = ? AND status = 'waiting' AND created_at < ?",
        (session["user_id"], cutoff),
    ).fetchall()
    for old in old_rooms:
        db.execute("DELETE FROM race_rooms WHERE id = ?", (old["id"],))

    questions, _, _ = generate_problems(
        session["user_id"], db, "standard", ops, RACE_QUESTION_COUNT, ranges
    )
    code = make_race_code(db)
    now = iso_utc()
    cur = db.execute(
        """
        INSERT INTO race_rooms
            (code, host_user_id, status, ops, ranges, question_count, questions, created_at)
        VALUES (?, ?, 'waiting', ?, ?, ?, ?, ?)
        """,
        (
            code,
            session["user_id"],
            json.dumps(ops),
            json.dumps(ranges),
            RACE_QUESTION_COUNT,
            json.dumps(questions),
            now,
        ),
    )
    room_id = cur.lastrowid
    db.execute(
        """
        INSERT INTO race_players (room_id, user_id, joined_at, last_seen)
        VALUES (?, ?, ?, ?)
        """,
        (room_id, session["user_id"], now, now),
    )
    db.commit()
    room = db.execute("SELECT * FROM race_rooms WHERE id = ?", (room_id,)).fetchone()
    return jsonify(race_state(db, room, session["user_id"])), 201


@app.route("/api/races/join", methods=["POST"])
@login_required
def api_join_race():
    data = request.get_json(force=True) or {}
    code = str(data.get("code", "")).strip().upper()
    if len(code) != 6:
        return jsonify({"error": "Enter a valid 6-character race code."}), 400

    db = get_db()
    room = db.execute("SELECT * FROM race_rooms WHERE code = ?", (code,)).fetchone()
    if room is None:
        return jsonify({"error": "Race not found. Check the code and try again."}), 404

    existing = db.execute(
        "SELECT 1 FROM race_players WHERE room_id = ? AND user_id = ?",
        (room["id"], session["user_id"]),
    ).fetchone()
    if existing:
        return jsonify(race_state(db, room, session["user_id"]))
    if room["status"] != "waiting":
        return jsonify({"error": "That race has already started."}), 409

    count = db.execute(
        "SELECT COUNT(*) AS n FROM race_players WHERE room_id = ?", (room["id"],)
    ).fetchone()["n"]
    if int(count) >= RACE_MAX_PLAYERS:
        return jsonify({"error": f"That race is full ({RACE_MAX_PLAYERS} players)."}), 409

    now = iso_utc()
    db.execute(
        "INSERT INTO race_players (room_id, user_id, joined_at, last_seen) VALUES (?, ?, ?, ?)",
        (room["id"], session["user_id"], now, now),
    )
    db.commit()
    return jsonify(race_state(db, room, session["user_id"])), 201


@app.route("/api/races/<code>", methods=["GET"])
@login_required
def api_get_race(code):
    db = get_db()
    code = code.strip().upper()
    room = race_room_for_user(db, code, session["user_id"])
    if room is None:
        return jsonify({"error": "Race not found or you are not in it."}), 404
    db.execute(
        "UPDATE race_players SET last_seen = ? WHERE room_id = ? AND user_id = ?",
        (iso_utc(), room["id"], session["user_id"]),
    )
    db.commit()
    room = db.execute("SELECT * FROM race_rooms WHERE id = ?", (room["id"],)).fetchone()
    return jsonify(race_state(db, room, session["user_id"]))


@app.route("/api/races/<code>/start", methods=["POST"])
@login_required
def api_start_race(code):
    db = get_db()
    code = code.strip().upper()
    room = race_room_for_user(db, code, session["user_id"])
    if room is None:
        return jsonify({"error": "Race not found or you are not in it."}), 404
    if room["host_user_id"] != session["user_id"]:
        return jsonify({"error": "Only the host can start the race."}), 403
    if room["status"] != "waiting":
        return jsonify({"error": "This race has already started."}), 409

    started_at = iso_utc(utc_now() + timedelta(seconds=4))
    db.execute(
        "UPDATE race_rooms SET status = 'racing', started_at = ? WHERE id = ?",
        (started_at, room["id"]),
    )
    db.execute(
        """
        UPDATE race_players
        SET progress = 0, wrong_attempts = 0, finished_at = NULL, elapsed_ms = NULL
        WHERE room_id = ?
        """,
        (room["id"],),
    )
    db.commit()
    room = db.execute("SELECT * FROM race_rooms WHERE id = ?", (room["id"],)).fetchone()
    return jsonify(race_state(db, room, session["user_id"]))


@app.route("/api/races/<code>/answer", methods=["POST"])
@login_required
def api_answer_race(code):
    data = request.get_json(force=True) or {}
    try:
        submitted = int(str(data.get("answer", "")).strip())
    except (TypeError, ValueError):
        return jsonify({"error": "Enter a whole-number answer."}), 400

    db = get_db()
    code = code.strip().upper()
    try:
        db.execute("BEGIN IMMEDIATE")
        room = race_room_for_user(db, code, session["user_id"])
        if room is None:
            db.rollback()
            return jsonify({"error": "Race not found or you are not in it."}), 404
        if room["status"] != "racing":
            db.rollback()
            return jsonify({"error": "This race is not currently running."}), 409

        started = parse_utc(room["started_at"])
        now = utc_now()
        if started is None or now < started:
            db.rollback()
            return jsonify({"error": "The countdown is still running."}), 409

        player = db.execute(
            "SELECT * FROM race_players WHERE room_id = ? AND user_id = ?",
            (room["id"], session["user_id"]),
        ).fetchone()
        progress = int(player["progress"])
        question_count = int(room["question_count"])
        if progress >= question_count or player["finished_at"]:
            db.commit()
            state = race_state(db, room, session["user_id"])
            state["answer_correct"] = True
            return jsonify(state)

        questions = json.loads(room["questions"])
        correct = submitted == int(questions[progress]["answer"])
        if not correct:
            db.execute(
                """
                UPDATE race_players
                SET wrong_attempts = wrong_attempts + 1, last_seen = ?
                WHERE room_id = ? AND user_id = ?
                """,
                (iso_utc(now), room["id"], session["user_id"]),
            )
            db.commit()
            room = db.execute("SELECT * FROM race_rooms WHERE id = ?", (room["id"],)).fetchone()
            state = race_state(db, room, session["user_id"])
            state["answer_correct"] = False
            return jsonify(state)

        new_progress = progress + 1
        finished_at = None
        elapsed_ms = None
        if new_progress >= question_count:
            finished_at = iso_utc(now)
            elapsed_ms = max(1, int((now - started).total_seconds() * 1000))

        db.execute(
            """
            UPDATE race_players
            SET progress = ?, finished_at = ?, elapsed_ms = ?, last_seen = ?
            WHERE room_id = ? AND user_id = ?
            """,
            (
                new_progress,
                finished_at,
                elapsed_ms,
                iso_utc(now),
                room["id"],
                session["user_id"],
            ),
        )
        maybe_finish_race(db, room["id"])
        db.commit()
    except Exception:
        db.rollback()
        raise

    room = db.execute("SELECT * FROM race_rooms WHERE id = ?", (room["id"],)).fetchone()
    state = race_state(db, room, session["user_id"])
    state["answer_correct"] = True
    return jsonify(state)


@app.route("/api/races/<code>/leave", methods=["POST"])
@login_required
def api_leave_race(code):
    db = get_db()
    code = code.strip().upper()
    room = race_room_for_user(db, code, session["user_id"])
    if room is None:
        return jsonify({"ok": True})

    if room["status"] == "waiting" and room["host_user_id"] == session["user_id"]:
        db.execute("DELETE FROM race_rooms WHERE id = ?", (room["id"],))
    else:
        db.execute(
            "DELETE FROM race_players WHERE room_id = ? AND user_id = ?",
            (room["id"], session["user_id"]),
        )
        if room["status"] == "racing":
            maybe_finish_race(db, room["id"])
    db.commit()
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