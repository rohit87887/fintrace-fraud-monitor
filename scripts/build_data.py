"""Build the FinTrace data store from the real PaySim CSV.

    python scripts/build_data.py "path/to/PS_20174392719_1491204439457_log.csv"

Outputs (in data/ or $FINTRACE_DATA_DIR):
  fintrace.duckdb  - tables `tx` (every transaction + FinTrace risk) and
                     `accounts` (notebook score for every account)
  stats.json       - pre-computed aggregates for the dashboard, analytics
                     and model-performance pages

Nothing here is simulated: every number is computed from the CSV. The
account scores are the notebook's `score_account` rules, evaluated in SQL
for all ~9M accounts at once, then cross-checked against the original
Python function on a random sample (see `verify_against_notebook`).
"""
import json
import os
import random
import sys
import time
from pathlib import Path

import duckdb
import pandas as pd

ROOT = Path(__file__).resolve().parents[1]
sys.path.insert(0, str(ROOT))
from fintrace.core import AccountIndex, prepare_frame, score_account  # noqa: E402

DATA_DIR = Path(os.environ.get("FINTRACE_DATA_DIR", ROOT / "data"))
DB_PATH = DATA_DIR / "fintrace.duckdb"
STATS_PATH = DATA_DIR / "stats.json"

HIGH_RISK = 50     # notebook: score >= 50 is "High" (>= 75 "Critical")
MEDIUM_RISK = 25


def log(msg):
    print(f"[{time.strftime('%H:%M:%S')}] {msg}", flush=True)


def load_transactions(con, csv_path):
    log(f"Reading {csv_path} ...")
    df = pd.read_csv(csv_path, dtype={"type": "category"})
    df.insert(0, "row_id", range(len(df)))  # == notebook's txn_id number
    log(f"Loaded {len(df):,} rows; writing to DuckDB ...")
    con.register("df_view", df)
    con.execute("""
        CREATE OR REPLACE TABLE tx_raw AS
        SELECT row_id::INTEGER AS row_id, step::SMALLINT AS step, type::VARCHAR AS type,
               amount::DOUBLE AS amount, nameOrig, oldbalanceOrg, newbalanceOrig,
               nameDest, oldbalanceDest, newbalanceDest,
               isFraud::TINYINT AS isFraud, isFlaggedFraud::TINYINT AS isFlaggedFraud
        FROM df_view
    """)
    con.unregister("df_view")
    del df


def score_all_accounts(con):
    """Notebook section 5 (`score_account`) as set-based SQL.

    activity = outgoing (counterparty = nameDest) + incoming (counterparty =
    nameOrig), ordered by step then row id (outgoing before incoming on a
    self-transfer, matching the pandas concat order)."""
    log("Building per-account activity (2 rows per transaction) ...")
    con.execute("""
        CREATE OR REPLACE TEMP TABLE act AS
        SELECT nameOrig AS acct, nameDest AS cp, row_id, step, amount, isFraud, 0 AS dir FROM tx_raw
        UNION ALL
        SELECT nameDest AS acct, nameOrig AS cp, row_id, step, amount, isFraud, 1 AS dir FROM tx_raw
    """)
    log("Per-account statistics (mean, population std, quartiles) ...")
    con.execute("""
        CREATE OR REPLACE TEMP TABLE acct_stats AS
        SELECT acct, count(*) AS n, avg(amount) AS mu, stddev_pop(amount) AS sd,
               quantile_cont(amount, 0.25) AS q1, quantile_cont(amount, 0.75) AS q3,
               sum(isFraud)::INTEGER AS fraud_n,
               sum(CASE WHEN dir = 0 THEN 1 ELSE 0 END)::INTEGER AS n_out,
               sum(CASE WHEN dir = 1 THEN 1 ELSE 0 END)::INTEGER AS n_in,
               sum(CASE WHEN dir = 0 THEN amount ELSE 0 END) AS total_sent,
               sum(CASE WHEN dir = 1 THEN amount ELSE 0 END) AS total_received
        FROM act GROUP BY acct
    """)
    log("Signals 1-2 (z-score and IQR outlier shares) ...")
    con.execute("""
        CREATE OR REPLACE TEMP TABLE acct_sig12 AS
        SELECT a.acct,
          avg(CASE WHEN s.sd > 0 AND abs(a.amount - s.mu) / s.sd >= 2.5 THEN 1.0 ELSE 0.0 END) AS extreme_frac,
          CASE WHEN s.n < 4 OR s.q3 - s.q1 = 0 THEN 0.0 ELSE
            avg(CASE WHEN a.amount < s.q1 - 1.5 * (s.q3 - s.q1)
                       OR a.amount > s.q3 + 1.5 * (s.q3 - s.q1) THEN 1.0 ELSE 0.0 END) END AS outlier_frac
        FROM act a JOIN acct_stats s USING (acct)
        GROUP BY a.acct, s.n, s.q1, s.q3
    """)
    log("Signal 3 (counterparty novelty in last 5 transactions) ...")
    con.execute("""
        CREATE OR REPLACE TEMP TABLE acct_sig3 AS
        WITH o AS (
          SELECT acct,
            row_number() OVER (PARTITION BY acct ORDER BY step, row_id, dir) AS rn,
            count(*) OVER (PARTITION BY acct) AS n,
            row_number() OVER (PARTITION BY acct, cp ORDER BY step, row_id, dir) AS cprn
          FROM act)
        SELECT acct,
          sum(CASE WHEN rn > n - 5 AND cprn = 1 THEN 1 ELSE 0 END)::INTEGER AS novel_recent,
          least(max(n), 5)::INTEGER AS recent_n
        FROM o GROUP BY acct
    """)
    log("Combining signals into scores ...")
    con.execute(f"""
        CREATE OR REPLACE TABLE accounts AS
        WITH w AS (
          SELECT s.acct AS account_id, s.n, s.n_out, s.n_in, s.total_sent, s.total_received, s.fraud_n,
            CASE WHEN g.extreme_frac > 0 THEN least(40.0, g.extreme_frac * 100) ELSE 0 END AS w_zscore,
            CASE WHEN g.outlier_frac > 0 THEN least(25.0, g.outlier_frac * 60) ELSE 0 END AS w_iqr,
            CASE WHEN n3.novel_recent / n3.recent_n >= 0.4
                 THEN least(20.0, n3.novel_recent / n3.recent_n * 30) ELSE 0 END AS w_novelty,
            CASE WHEN s.fraud_n > 0 THEN least(35.0, s.fraud_n * 15) ELSE 0 END AS w_labels
          FROM acct_stats s JOIN acct_sig12 g USING (acct) JOIN acct_sig3 n3 USING (acct))
        SELECT *,
          round(least(100.0, w_zscore + w_iqr + w_novelty), 1) AS behavioral_score,
          round(least(100.0, w_zscore + w_iqr + w_novelty + w_labels), 1) AS investigative_score
        FROM w
    """)
    for t in ("act", "acct_stats", "acct_sig12", "acct_sig3"):
        con.execute(f"DROP TABLE {t}")

    log("Attaching transaction risk = max(behavioral score of sender, receiver) ...")
    con.execute("""
        CREATE OR REPLACE TABLE tx AS
        SELECT t.*, o.behavioral_score AS risk_orig, d.behavioral_score AS risk_dest,
               greatest(o.behavioral_score, d.behavioral_score) AS risk
        FROM tx_raw t
        JOIN accounts o ON o.account_id = t.nameOrig
        JOIN accounts d ON d.account_id = t.nameDest
        ORDER BY t.row_id
    """)
    con.execute("DROP TABLE tx_raw")


def verify_against_notebook(con, n_per_group=60, seed=7):
    """Re-score a random sample of accounts with the notebook's own Python
    `score_account` and compare with the SQL result."""
    log("Verifying SQL scores against the notebook's Python score_account ...")
    random.seed(seed)
    groups = {
        "single-txn": "n = 1",
        "multi-txn": "n BETWEEN 4 AND 60",
        "fraud-touching": "fraud_n > 0 AND n <= 60",
    }
    sample = []
    con.execute("SELECT setseed(0.42)")
    for _, cond in groups.items():
        sample += [r[0] for r in con.execute(
            f"SELECT account_id FROM accounts WHERE {cond} ORDER BY random() LIMIT {n_per_group}").fetchall()]

    mismatches = []
    for acc in sample:
        rows = con.execute("""
            SELECT row_id, step, type, amount, nameOrig, oldbalanceOrg, newbalanceOrig,
                   nameDest, oldbalanceDest, newbalanceDest, isFraud, isFlaggedFraud
            FROM tx WHERE nameOrig = ? OR nameDest = ?""", [acc, acc]).df()
        sub = prepare_frame(rows.drop(columns="row_id"), rows["row_id"])
        idx = AccountIndex(sub)
        py_b = score_account(acc, idx, use_labels=False).risk_score
        py_i = score_account(acc, idx).risk_score
        sql_b, sql_i = con.execute(
            "SELECT behavioral_score, investigative_score FROM accounts WHERE account_id = ?", [acc]).fetchone()
        if abs(py_b - sql_b) > 0.11 or abs(py_i - sql_i) > 0.11:
            mismatches.append((acc, py_b, sql_b, py_i, sql_i))
    log(f"Checked {len(sample)} accounts, {len(mismatches)} mismatches.")
    for m in mismatches[:10]:
        log(f"  MISMATCH {m}")
    return {"accounts_checked": len(sample), "mismatches": len(mismatches)}


def q(con, sql):
    df = con.execute(sql).df()
    return json.loads(df.to_json(orient="records"))


def compute_stats(con, verification):
    log("Computing aggregates ...")
    s = {}
    s["summary"] = q(con, f"""
        SELECT count(*) AS total_transactions,
               sum(isFraud)::BIGINT AS labeled_fraud,
               avg(isFraud) AS fraud_rate,
               sum(CASE WHEN isFraud = 1 THEN amount ELSE 0 END) AS labeled_fraud_amount,
               sum(amount) AS total_amount,
               sum(isFlaggedFraud)::BIGINT AS paysim_flagged,
               sum(CASE WHEN risk >= {HIGH_RISK} THEN 1 ELSE 0 END)::BIGINT AS fintrace_high_risk,
               sum(CASE WHEN risk >= {HIGH_RISK} OR isFlaggedFraud = 1 THEN 1 ELSE 0 END)::BIGINT AS suspicious,
               sum(CASE WHEN risk >= {HIGH_RISK} OR isFlaggedFraud = 1 THEN amount ELSE 0 END) AS suspicious_amount,
               min(step) AS first_step, max(step) AS last_step
        FROM tx""")[0]
    s["summary"].update(q(con, """
        SELECT count(*) AS total_accounts,
               sum(CASE WHEN n_out > 0 THEN 1 ELSE 0 END) AS sending_accounts,
               sum(CASE WHEN fraud_n > 0 THEN 1 ELSE 0 END) AS fraud_touching_accounts
        FROM accounts""")[0])

    s["by_type"] = q(con, """
        SELECT type, count(*) AS n, sum(isFraud)::BIGINT AS fraud, avg(isFraud) AS fraud_rate,
               sum(amount) AS amount, sum(CASE WHEN isFraud = 1 THEN amount ELSE 0 END) AS fraud_amount,
               median(amount) AS median_amount
        FROM tx GROUP BY type ORDER BY n DESC""")
    s["by_step"] = q(con, """
        SELECT step, count(*) AS n, sum(isFraud)::BIGINT AS fraud,
               sum(CASE WHEN isFraud = 1 THEN amount ELSE 0 END) AS fraud_amount
        FROM tx GROUP BY step ORDER BY step""")
    s["by_day"] = q(con, """
        SELECT step // 24 + 1 AS day, count(*) AS n, sum(isFraud)::BIGINT AS fraud,
               avg(isFraud) AS fraud_rate
        FROM tx GROUP BY day ORDER BY day""")
    s["by_hour"] = q(con, """
        SELECT step % 24 AS hour, count(*) AS n, sum(isFraud)::BIGINT AS fraud, avg(isFraud) AS fraud_rate
        FROM tx GROUP BY hour ORDER BY hour""")
    edges = [0, 100, 1_000, 10_000, 100_000, 250_000, 500_000, 1_000_000, 2_500_000, 10_000_000]
    case = " ".join(f"WHEN amount < {hi} THEN {i}" for i, hi in enumerate(edges[1:]))
    rows = q(con, f"""
        SELECT CASE {case} ELSE {len(edges) - 1} END AS bucket, count(*) AS n,
               sum(isFraud)::BIGINT AS fraud, avg(isFraud) AS fraud_rate
        FROM tx GROUP BY bucket ORDER BY bucket""")
    def fmt(v):
        return f"{v / 1e6:g}M" if v >= 1e6 else f"{v / 1e3:g}K" if v >= 1e3 else f"{v:g}"
    labels = [f"{fmt(lo)}–{fmt(hi)}" for lo, hi in zip(edges, edges[1:])] + [f"≥{fmt(edges[-1])}"]
    for r in rows:
        r["label"] = labels[r["bucket"]]
    s["by_amount"] = rows

    # Balance-behaviour features available in the dataset (descriptive).
    feats = {
        "orig_drained": ("Sender balance emptied", "oldbalanceOrg > 0 AND newbalanceOrig = 0"),
        "amount_eq_balance": ("Amount equals sender's full balance", "amount = oldbalanceOrg AND amount > 0"),
        "dest_zero_both": ("Receiver balance 0 before and after", "oldbalanceDest = 0 AND newbalanceDest = 0 AND nameDest LIKE 'C%'"),
        "orig_balance_mismatch": ("Sender ledger doesn't add up", "abs(oldbalanceOrg - amount - newbalanceOrig) > 0.01 AND oldbalanceOrg >= amount"),
    }
    s["features"] = []
    for key, (label, cond) in feats.items():
        r = q(con, f"""
            SELECT sum(CASE WHEN {cond} THEN 1 ELSE 0 END)::BIGINT AS n_true,
                   sum(CASE WHEN {cond} THEN isFraud ELSE 0 END)::BIGINT AS fraud_true,
                   sum(CASE WHEN NOT ({cond}) THEN 1 ELSE 0 END)::BIGINT AS n_false,
                   sum(CASE WHEN NOT ({cond}) THEN isFraud ELSE 0 END)::BIGINT AS fraud_false
            FROM tx WHERE type IN ('TRANSFER', 'CASH_OUT')""")[0]
        r.update(key=key, label=label, condition=cond, scope="TRANSFER + CASH_OUT only")
        s["features"].append(r)

    s["risk_distribution"] = {
        "transactions": q(con, """
            SELECT floor(risk / 5) * 5 AS bin, count(*) AS n, sum(isFraud)::BIGINT AS fraud
            FROM tx GROUP BY bin ORDER BY bin"""),
        "accounts_behavioral": q(con, """
            SELECT floor(behavioral_score / 5) * 5 AS bin, count(*) AS n FROM accounts GROUP BY bin ORDER BY bin"""),
        "accounts_investigative": q(con, """
            SELECT floor(investigative_score / 5) * 5 AS bin, count(*) AS n FROM accounts GROUP BY bin ORDER BY bin"""),
        "bands": q(con, f"""
            SELECT CASE WHEN risk >= {HIGH_RISK} THEN 'High' WHEN risk >= {MEDIUM_RISK} THEN 'Medium' ELSE 'Low' END AS band,
                   count(*) AS n, sum(isFraud)::BIGINT AS fraud
            FROM tx GROUP BY band"""),
    }
    s["top_accounts"] = q(con, """
        SELECT account_id, n, fraud_n, behavioral_score, investigative_score,
               w_zscore, w_iqr, w_novelty, w_labels, total_sent, total_received
        FROM accounts ORDER BY behavioral_score DESC, n DESC LIMIT 50""")

    # Evaluation of rule-based classifiers against the isFraud ground truth.
    log("Evaluating rule-based classifiers ...")
    pos, neg = q(con, "SELECT sum(isFraud)::BIGINT p, (count(*) - sum(isFraud))::BIGINT n FROM tx")[0].values()
    hist = q(con, """
        SELECT floor(risk) AS r, sum(isFraud)::BIGINT AS fraud, (count(*) - sum(isFraud))::BIGINT AS legit
        FROM tx GROUP BY r ORDER BY r DESC""")
    sweep, tp, fp = [], 0, 0
    by_r = {int(h["r"]): h for h in hist}
    for t in range(100, -1, -1):
        h = by_r.get(t)
        if h:
            tp += h["fraud"]; fp += h["legit"]
        sweep.append(_metrics(tp, fp, pos - tp, neg - fp, threshold=t))
    sweep.reverse()
    flagged = q(con, """
        SELECT sum(CASE WHEN isFlaggedFraud = 1 AND isFraud = 1 THEN 1 ELSE 0 END)::BIGINT tp,
               sum(CASE WHEN isFlaggedFraud = 1 AND isFraud = 0 THEN 1 ELSE 0 END)::BIGINT fp,
               sum(CASE WHEN isFlaggedFraud = 0 AND isFraud = 1 THEN 1 ELSE 0 END)::BIGINT fn,
               sum(CASE WHEN isFlaggedFraud = 0 AND isFraud = 0 THEN 1 ELSE 0 END)::BIGINT tn
        FROM tx""")[0]
    s["evaluation"] = {
        "positives": pos, "negatives": neg,
        "fintrace_behavioral_sweep": sweep,
        "default_threshold": HIGH_RISK,
        "paysim_isFlaggedFraud": _metrics(**flagged),
        "ml_model": None,
        "verification": verification,
    }
    s["generated_at"] = time.strftime("%Y-%m-%d %H:%M:%S")
    s["thresholds"] = {"medium": MEDIUM_RISK, "high": HIGH_RISK}
    return s


def _metrics(tp, fp, fn, tn, threshold=None):
    tp, fp, fn, tn = int(tp), int(fp), int(fn), int(tn)
    p = tp / (tp + fp) if tp + fp else 0.0
    r = tp / (tp + fn) if tp + fn else 0.0
    m = {"tp": tp, "fp": fp, "fn": fn, "tn": tn,
         "accuracy": (tp + tn) / (tp + fp + fn + tn),
         "precision": p, "recall": r, "f1": 2 * p * r / (p + r) if p + r else 0.0}
    if threshold is not None:
        m["threshold"] = threshold
    return m


def main():
    if len(sys.argv) < 2:
        sys.exit(__doc__)
    if sys.argv[1] == "--stats-only":  # recompute stats.json from an existing store
        con = duckdb.connect(str(DB_PATH))
        old = json.loads(STATS_PATH.read_text(encoding="utf-8")) if STATS_PATH.exists() else {}
        verification = old.get("evaluation", {}).get("verification") or verify_against_notebook(con)
        STATS_PATH.write_text(json.dumps(compute_stats(con, verification), indent=1), encoding="utf-8")
        con.close()
        log(f"Wrote {STATS_PATH}")
        return
    csv_path = sys.argv[1]
    DATA_DIR.mkdir(parents=True, exist_ok=True)
    tmp = DB_PATH.with_suffix(".building.duckdb")
    tmp.unlink(missing_ok=True)
    con = duckdb.connect(str(tmp))
    t0 = time.time()
    load_transactions(con, csv_path)
    score_all_accounts(con)
    log("Indexing account ids ...")
    con.execute("CREATE INDEX idx_orig ON tx (nameOrig)")
    con.execute("CREATE INDEX idx_dest ON tx (nameDest)")
    con.execute("CREATE INDEX idx_acct ON accounts (account_id)")
    verification = verify_against_notebook(con)
    stats = compute_stats(con, verification)
    con.close()
    DB_PATH.unlink(missing_ok=True)
    tmp.rename(DB_PATH)
    STATS_PATH.write_text(json.dumps(stats, indent=1), encoding="utf-8")
    log(f"Done in {time.time() - t0:.0f}s -> {DB_PATH} and {STATS_PATH}")


if __name__ == "__main__":
    main()
