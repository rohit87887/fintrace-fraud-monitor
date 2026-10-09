"""FinTrace API + web UI.

    python -m uvicorn backend.app:app --port 8000

Serves the frontend from /frontend and a JSON API under /api. All data
comes from data/fintrace.duckdb, built from the real PaySim CSV by
scripts/build_data.py. Account and transaction scoring calls the
notebook's own `score_account` (ported in fintrace/core.py).
"""
import csv
import io
import json
import os
import sys
from pathlib import Path
from typing import Optional

import duckdb
from fastapi import FastAPI, HTTPException, Query
from fastapi.responses import HTMLResponse, StreamingResponse
from fastapi.staticfiles import StaticFiles
from pydantic import BaseModel, Field

ROOT = Path(__file__).resolve().parents[1]
sys.path.insert(0, str(ROOT))
from backend.model_slot import ModelSlot  # noqa: E402
from fintrace.core import (AccountIndex, build_graph, build_timeline,  # noqa: E402
                           flag_moments_of_interest, get_neighborhood,
                           prepare_frame, render_case_report, risk_band,
                           score_account)

DATA_DIR = Path(os.environ.get("FINTRACE_DATA_DIR", ROOT / "data"))
DB_PATH = DATA_DIR / "fintrace.duckdb"
STATS_PATH = DATA_DIR / "stats.json"

app = FastAPI(title="FinTrace Fraud Monitoring API", version="1.0")

_con = duckdb.connect(str(DB_PATH), read_only=True) if DB_PATH.exists() else None
_stats = json.loads(STATS_PATH.read_text(encoding="utf-8")) if STATS_PATH.exists() else None
model_slot = ModelSlot(ROOT / "models")

TX_COLS = ["row_id", "step", "type", "amount", "nameOrig", "oldbalanceOrg", "newbalanceOrig",
           "nameDest", "oldbalanceDest", "newbalanceDest", "isFraud", "isFlaggedFraud",
           "risk_orig", "risk_dest", "risk"]
SORTABLE = {"row_id", "step", "amount", "risk", "type"}
HIGH = 50
MEDIUM = 25


def db():
    if _con is None:
        raise HTTPException(503, "Data store not built. Run scripts/build_data.py first.")
    return _con.cursor()


def band3(score: float) -> str:
    """Website bands: Low < 25 <= Medium < 50 <= High (notebook's 'Critical'
    >= 75 is reported separately as a sub-band of High)."""
    return "High" if score >= HIGH else "Medium" if score >= MEDIUM else "Low"


# ---------------------------------------------------------------------------
# Health / stats
# ---------------------------------------------------------------------------
@app.get("/api/health")
def health():
    return {
        "status": "ok" if _con else "no-data",
        "data_store": DB_PATH.exists(),
        "stats_generated_at": _stats.get("generated_at") if _stats else None,
        "scoring_engine": "FinTrace rule-based score_account (notebook section 5)",
        "ml_model": model_slot.status(),
    }


@app.get("/api/stats")
def stats():
    if _stats is None:
        raise HTTPException(503, "stats.json missing. Run scripts/build_data.py first.")
    out = dict(_stats)
    if model_slot.metrics:
        out["evaluation"] = dict(out["evaluation"], ml_model=model_slot.metrics)
    return out


# ---------------------------------------------------------------------------
# Transactions
# ---------------------------------------------------------------------------
def _filters(type_, fraud, flagged, band, suspicious, min_amount, max_amount,
             min_step, max_step, account, txn):
    where, params = [], []
    if type_:
        types = [t for t in type_.split(",") if t]
        where.append(f"type IN ({','.join('?' * len(types))})")
        params += types
    if fraud in ("0", "1"):
        where.append("isFraud = ?"); params.append(int(fraud))
    if flagged in ("0", "1"):
        where.append("isFlaggedFraud = ?"); params.append(int(flagged))
    if band == "High":
        where.append(f"risk >= {HIGH}")
    elif band == "Medium":
        where.append(f"risk >= {MEDIUM} AND risk < {HIGH}")
    elif band == "Low":
        where.append(f"risk < {MEDIUM}")
    if suspicious:
        where.append(f"(risk >= {HIGH} OR isFlaggedFraud = 1)")
    if min_amount is not None:
        where.append("amount >= ?"); params.append(min_amount)
    if max_amount is not None:
        where.append("amount <= ?"); params.append(max_amount)
    if min_step is not None:
        where.append("step >= ?"); params.append(min_step)
    if max_step is not None:
        where.append("step <= ?"); params.append(max_step)
    if account:
        where.append("(nameOrig = ? OR nameDest = ?)"); params += [account.strip(), account.strip()]
    if txn:
        digits = "".join(ch for ch in txn if ch.isdigit())
        where.append("row_id = ?"); params.append(int(digits) if digits else -1)
    return (" WHERE " + " AND ".join(where)) if where else "", params


def _filter_args(
    type: Optional[str] = None, fraud: Optional[str] = None, flagged: Optional[str] = None,
    band: Optional[str] = None, suspicious: bool = False,
    min_amount: Optional[float] = None, max_amount: Optional[float] = None,
    min_step: Optional[int] = None, max_step: Optional[int] = None,
    account: Optional[str] = None, txn: Optional[str] = None):
    return _filters(type, fraud, flagged, band, suspicious, min_amount, max_amount,
                    min_step, max_step, account, txn)


def _row(r):
    d = dict(zip(TX_COLS, r))
    d["txn_id"] = f"TXN{d['row_id']:08d}"
    d["band"] = band3(d["risk"])
    return d


@app.get("/api/transactions")
def transactions(type: Optional[str] = None, fraud: Optional[str] = None,
                 flagged: Optional[str] = None, band: Optional[str] = None,
                 suspicious: bool = False,
                 min_amount: Optional[float] = None, max_amount: Optional[float] = None,
                 min_step: Optional[int] = None, max_step: Optional[int] = None,
                 account: Optional[str] = None, txn: Optional[str] = None,
                 sort: str = "row_id", order: str = "asc",
                 page: int = Query(1, ge=1), page_size: int = Query(25, ge=1, le=200)):
    where, params = _filter_args(type, fraud, flagged, band, suspicious, min_amount,
                                 max_amount, min_step, max_step, account, txn)
    sort = sort if sort in SORTABLE else "row_id"
    order = "DESC" if order.lower() == "desc" else "ASC"
    cur = db()
    total = cur.execute(f"SELECT count(*) FROM tx{where}", params).fetchone()[0]
    rows = cur.execute(
        f"SELECT {','.join(TX_COLS)} FROM tx{where} ORDER BY {sort} {order}, row_id "
        f"LIMIT ? OFFSET ?", params + [page_size, (page - 1) * page_size]).fetchall()
    return {"total": total, "page": page, "page_size": page_size, "rows": [_row(r) for r in rows]}


@app.get("/api/transactions/export")
def export_transactions(type: Optional[str] = None, fraud: Optional[str] = None,
                        flagged: Optional[str] = None, band: Optional[str] = None,
                        suspicious: bool = False,
                        min_amount: Optional[float] = None, max_amount: Optional[float] = None,
                        min_step: Optional[int] = None, max_step: Optional[int] = None,
                        account: Optional[str] = None, txn: Optional[str] = None,
                        sort: str = "row_id", order: str = "asc",
                        limit: int = Query(50_000, ge=1, le=250_000),
                        filename: str = "fintrace_transactions.csv"):
    where, params = _filter_args(type, fraud, flagged, band, suspicious, min_amount,
                                 max_amount, min_step, max_step, account, txn)
    sort = sort if sort in SORTABLE else "row_id"
    order = "DESC" if order.lower() == "desc" else "ASC"
    rows = db().execute(f"SELECT {','.join(TX_COLS)} FROM tx{where} ORDER BY {sort} {order}, row_id LIMIT ?",
                        params + [limit]).fetchall()
    header = ["txn_id"] + TX_COLS[1:] + ["risk_band"]

    def gen():
        buf = io.StringIO()
        w = csv.writer(buf)
        w.writerow(header)
        for r in rows:
            d = _row(r)
            w.writerow([d["txn_id"]] + [d[c] for c in TX_COLS[1:]] + [d["band"]])
            if buf.tell() > 1 << 16:
                yield buf.getvalue(); buf.seek(0); buf.truncate()
        yield buf.getvalue()

    safe = "".join(c for c in filename if c.isalnum() or c in "._-") or "export.csv"
    return StreamingResponse(gen(), media_type="text/csv",
                             headers={"Content-Disposition": f'attachment; filename="{safe}"'})


@app.get("/api/transactions/random")
def random_transaction(fraud: Optional[str] = None, band: Optional[str] = None,
                       type: Optional[str] = None):
    where, params = _filter_args(type, fraud, None, band, False, None, None, None, None, None, None)
    cur = db()
    n = cur.execute(f"SELECT count(*) FROM tx{where}", params).fetchone()[0]
    if not n:
        raise HTTPException(404, "No transaction matches")
    import random
    r = cur.execute(f"SELECT {','.join(TX_COLS)} FROM tx{where} LIMIT 1 OFFSET ?",
                    params + [random.randrange(n)]).fetchone()
    return _row(r)


@app.get("/api/transactions/{row_id}")
def transaction(row_id: int):
    r = db().execute(f"SELECT {','.join(TX_COLS)} FROM tx WHERE row_id = ?", [row_id]).fetchone()
    if not r:
        raise HTTPException(404, "Transaction not found")
    return _row(r)


# ---------------------------------------------------------------------------
# Accounts (notebook scoring, timeline, neighbourhood, case report)
# ---------------------------------------------------------------------------
RAW_COLS = ["row_id", "step", "type", "amount", "nameOrig", "oldbalanceOrg", "newbalanceOrig",
            "nameDest", "oldbalanceDest", "newbalanceDest", "isFraud", "isFlaggedFraud"]


def _account_frame(account_id: str):
    """Every transaction touching the account — exactly the rows the
    notebook's AccountIndex would hand to score_account."""
    cols = ",".join(RAW_COLS)
    df = db().execute(
        f"SELECT {cols} FROM tx WHERE nameOrig = ? UNION ALL "
        f"SELECT {cols} FROM tx WHERE nameDest = ? AND nameOrig <> ?",
        [account_id, account_id, account_id]).df()
    return df


def _index_for(df):
    sub = prepare_frame(df.drop(columns="row_id"), df["row_id"])
    return sub, AccountIndex(sub)


def _explain(expl):
    return {"score": expl.risk_score, "band": band3(expl.risk_score),
            "notebook_band": expl.risk_band, "summary": expl.summary(),
            "signals": [dict(s, weight=round(s["weight"], 2)) for s in expl.signals]}


@app.get("/api/accounts/top")
def top_accounts(by: str = "behavioral", limit: int = Query(25, ge=1, le=200),
                 min_txns: int = Query(1, ge=1)):
    col = "investigative_score" if by == "investigative" else "behavioral_score"
    rows = db().execute(
        f"SELECT account_id, n, fraud_n, behavioral_score, investigative_score, "
        f"w_zscore, w_iqr, w_novelty, w_labels FROM accounts WHERE n >= ? "
        f"ORDER BY {col} DESC, n DESC LIMIT ?", [min_txns, limit]).df()
    return json.loads(rows.to_json(orient="records"))


@app.get("/api/accounts/{account_id}")
def account(account_id: str):
    account_id = account_id.strip()
    df = _account_frame(account_id)
    if df.empty:
        raise HTTPException(404, f"Unknown account: {account_id}")
    sub, idx = _index_for(df)
    rec = idx.get(account_id)
    behavioral = score_account(account_id, idx, use_labels=False)
    investigative = score_account(account_id, idx)
    timeline = flag_moments_of_interest(build_timeline(account_id, idx))
    G = build_graph(sub)
    try:
        neighbors = sorted(n for n in get_neighborhood(G, account_id).nodes() if n != account_id)
    except KeyError:
        neighbors = []
    return {
        "account_id": account_id,
        "kind": "Merchant" if account_id.startswith("M") else "Customer",
        "transactions": len(rec.all_activity),
        "sent_count": len(rec.outgoing), "received_count": len(rec.incoming),
        "total_sent": rec.total_sent, "total_received": rec.total_received,
        "counterparties": len(rec.counterparties),
        "fraud_labeled": rec.flagged_transaction_count,
        "behavioral": _explain(behavioral),
        "investigative": _explain(investigative),
        "neighbors": neighbors[:200],
        "timeline": [{
            "txn_id": e.txn_id, "step": int(e.step), "direction": e.direction,
            "counterparty": e.counterparty, "amount": float(e.amount),
            "balance_after": float(e.balance_after), "z_score": round(float(e.z_score), 3),
            "flagged": e.is_flagged_moment, "reasons": e.flag_reasons,
            "is_fraud": int(sub.loc[sub["txn_id"] == e.txn_id, "isFraud"].iloc[0]),
            "type": str(sub.loc[sub["txn_id"] == e.txn_id, "type"].iloc[0]),
        } for e in timeline],
    }


@app.get("/api/accounts/{account_id}/report", response_class=HTMLResponse)
def account_report(account_id: str, download: bool = False):
    account_id = account_id.strip()
    df = _account_frame(account_id)
    if df.empty:
        raise HTTPException(404, f"Unknown account: {account_id}")
    sub, idx = _index_for(df)
    html = render_case_report(account_id, idx, build_graph(sub), partition=None)
    headers = {"Content-Disposition": f'attachment; filename="case_{account_id}.html"'} if download else {}
    return HTMLResponse(html, headers=headers)


# ---------------------------------------------------------------------------
# Detection engine
# ---------------------------------------------------------------------------
class CustomTxn(BaseModel):
    step: int = Field(1, ge=1, le=10_000)
    type: str = "TRANSFER"
    amount: float = Field(..., ge=0)
    nameOrig: str
    oldbalanceOrg: float = 0.0
    newbalanceOrig: float = 0.0
    nameDest: str
    oldbalanceDest: float = 0.0
    newbalanceDest: float = 0.0


class ScoreRequest(BaseModel):
    row_id: Optional[int] = None
    transaction: Optional[CustomTxn] = None


HYPOTHETICAL_ROW_ID = 99_999_999


def _score_party(account_id, extra_row=None):
    df = _account_frame(account_id)
    if extra_row is not None:
        import pandas as pd
        df = pd.concat([df, pd.DataFrame([extra_row])], ignore_index=True)
    if df.empty:
        return None
    _, idx = _index_for(df)
    expl = score_account(account_id, idx, use_labels=False)
    out = _explain(expl)
    out["history_transactions"] = len(df) - (1 if extra_row is not None else 0)
    return out


@app.post("/api/engine/score")
def engine_score(req: ScoreRequest):
    if req.row_id is not None:
        tx = transaction(req.row_id)
        extra = None
        hypothetical = False
    elif req.transaction is not None:
        t = req.transaction
        tx = t.model_dump()
        tx.update(row_id=HYPOTHETICAL_ROW_ID, isFraud=0, isFlaggedFraud=0,
                  txn_id="(hypothetical)")
        extra = {k: tx[k] for k in RAW_COLS}
        hypothetical = True
    else:
        raise HTTPException(422, "Provide row_id or transaction")

    sender = _score_party(tx["nameOrig"], extra)
    receiver = _score_party(tx["nameDest"], extra) if tx["nameDest"] != tx["nameOrig"] else sender
    score = max(sender["score"], receiver["score"])
    verdict = "Potentially fraudulent" if score >= HIGH else "Legitimate (no strong anomaly signals)"
    ml = model_slot.predict_proba(tx) if model_slot.available else None
    return {
        "transaction": tx,
        "hypothetical": hypothetical,
        "method": "rule-based",
        "rule_based": {
            "score": score, "band": band3(score), "notebook_band": risk_band(score),
            "verdict": verdict, "threshold": HIGH,
            "sender": sender, "receiver": receiver,
        },
        "ml_model": {"available": model_slot.available,
                     "probability": ml,
                     "status": model_slot.status()},
        "ground_truth": None if hypothetical else {
            "isFraud": tx["isFraud"], "isFlaggedFraud": tx["isFlaggedFraud"]},
    }


# ---------------------------------------------------------------------------
# Frontend
# ---------------------------------------------------------------------------
app.mount("/", StaticFiles(directory=ROOT / "frontend", html=True), name="frontend")
