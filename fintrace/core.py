"""FinTrace core — ported from FinTrace_Colab_1.ipynb (sections 2-6).

The scoring, timeline and report logic below is copied from the notebook
with only these changes:
  * `community` (python-louvain) is imported lazily, so the web app does
    not require it unless community detection is actually used.
  * `prepare_frame()` is added. It applies the same normalization as
    `load_transactions()` (timestamp + txn_id) to a DataFrame that is
    already in memory. The notebook's section 7 read the CSV with plain
    `pd.read_csv`, skipping that step, which is what caused its
    `KeyError: "['txn_id', 'timestamp'] not in index"`.
"""
import logging
from dataclasses import dataclass, field
from datetime import datetime, timezone
from pathlib import Path
from typing import Optional

import networkx as nx
import numpy as np
import pandas as pd
from jinja2 import Template

# ---------------------------------------------------------------------------
# 2. Data Layer
# ---------------------------------------------------------------------------
logger = logging.getLogger("fintrace.data_layer")

REQUIRED_COLUMNS = [
    "step", "type", "amount", "nameOrig", "oldbalanceOrg", "newbalanceOrig",
    "nameDest", "oldbalanceDest", "newbalanceDest", "isFraud",
]


def prepare_frame(df: pd.DataFrame, row_ids: Optional[pd.Series] = None) -> pd.DataFrame:
    """Add `timestamp` and `txn_id` exactly as `load_transactions` does.

    `row_ids` lets a subset of the full log keep its original global row
    numbers, so TXN ids match the ones the notebook would assign."""
    df = df.copy()
    if "isFlaggedFraud" not in df.columns:
        df["isFlaggedFraud"] = 0
    df["step"] = df["step"].astype("int64")
    df["timestamp"] = pd.to_datetime(df["step"], unit="h", origin="2023-01-01")
    ids = row_ids if row_ids is not None else pd.Series(range(len(df)), index=df.index)
    df["txn_id"] = [f"TXN{int(i):08d}" for i in ids]
    return df.reset_index(drop=True)


def load_transactions(path: str, column_map: Optional[dict] = None,
                      nrows: Optional[int] = None) -> pd.DataFrame:
    """Load the raw PaySim CSV and validate/normalize its schema."""
    df = pd.read_csv(path, nrows=nrows)

    if column_map:
        df = df.rename(columns=column_map)

    missing = [c for c in REQUIRED_COLUMNS if c not in df.columns]
    if missing:
        raise ValueError(
            f"Input data is missing required columns: {missing}. "
            f"Pass a column_map= to rename your columns onto the PaySim schema."
        )

    df = prepare_frame(df.reset_index(drop=True))
    logger.info("Loaded %d transactions covering %d origin accounts.",
                len(df), df["nameOrig"].nunique())
    return df


@dataclass
class AccountRecord:
    """All known activity for a single account, from both sides of the ledger."""
    account_id: str
    outgoing: pd.DataFrame = field(repr=False)
    incoming: pd.DataFrame = field(repr=False)

    @property
    def all_activity(self) -> pd.DataFrame:
        """Outgoing + incoming transactions, sorted chronologically."""
        out = self.outgoing.copy()
        out["direction"] = "outgoing"
        out["counterparty"] = out["nameDest"]

        inc = self.incoming.copy()
        inc["direction"] = "incoming"
        inc["counterparty"] = inc["nameOrig"]

        cols = ["txn_id", "timestamp", "step", "type", "amount", "direction",
                "counterparty", "oldbalanceOrg", "newbalanceOrig",
                "oldbalanceDest", "newbalanceDest", "isFraud"]
        combined = pd.concat([out[cols], inc[cols]], ignore_index=True)
        # Tie-break on txn_id so equal-step ordering is deterministic (the
        # notebook's plain sort_values("timestamp") leaves ties unspecified).
        return combined.sort_values(["timestamp", "txn_id"], kind="stable").reset_index(drop=True)

    @property
    def counterparties(self):
        return sorted(set(self.outgoing["nameDest"]) | set(self.incoming["nameOrig"]))

    @property
    def total_sent(self) -> float:
        return float(self.outgoing["amount"].sum())

    @property
    def total_received(self) -> float:
        return float(self.incoming["amount"].sum())

    @property
    def flagged_transaction_count(self) -> int:
        return int(self.outgoing["isFraud"].sum() + self.incoming["isFraud"].sum())


class AccountIndex:
    """Fast lookup of an account's full transaction history, in both
    directions, built once over the full transaction log."""

    def __init__(self, df: pd.DataFrame):
        self._df = df
        self._by_orig = {k: v for k, v in df.groupby("nameOrig")}
        self._by_dest = {k: v for k, v in df.groupby("nameDest")}
        self._all_accounts = sorted(
            set(self._by_orig.keys()) | set(self._by_dest.keys())
        )

    def __len__(self):
        return len(self._all_accounts)

    def __contains__(self, account_id):
        return account_id in self._all_accounts

    @property
    def accounts(self):
        return self._all_accounts

    def get(self, account_id: str) -> AccountRecord:
        empty = self._df.iloc[0:0]
        outgoing = self._by_orig.get(account_id, empty)
        incoming = self._by_dest.get(account_id, empty)
        if outgoing.empty and incoming.empty:
            raise KeyError(f"Unknown account: {account_id}")
        return AccountRecord(account_id=account_id, outgoing=outgoing, incoming=incoming)

    def flagged_accounts(self):
        fraud_txns = self._df[self._df["isFraud"] == 1]
        return sorted(set(fraud_txns["nameOrig"]) | set(fraud_txns["nameDest"]))


def build_account_index(df: pd.DataFrame) -> AccountIndex:
    return AccountIndex(df)


# ---------------------------------------------------------------------------
# 3. Graph Module
# ---------------------------------------------------------------------------
logger = logging.getLogger("fintrace.graph_module")


def build_graph(df: pd.DataFrame, min_amount: float = 0.0) -> nx.DiGraph:
    G = nx.DiGraph()
    txns = df[df["amount"] >= min_amount]
    for row in txns.itertuples(index=False):
        u, v = row.nameOrig, row.nameDest
        if G.has_edge(u, v):
            G[u][v]["weight"] += row.amount
            G[u][v]["count"] += 1
            G[u][v]["fraud_count"] += int(row.isFraud)
        else:
            G.add_edge(u, v, weight=row.amount, count=1, fraud_count=int(row.isFraud))
    return G


def detect_communities(G: nx.DiGraph) -> dict:
    import community as community_louvain  # python-louvain, optional
    return community_louvain.best_partition(G.to_undirected(), weight="weight")


def get_neighborhood(G: nx.DiGraph, account_id: str, depth: int = 1) -> nx.DiGraph:
    if account_id not in G:
        raise KeyError(f"Account {account_id} is not present in the graph.")
    nodes = {account_id}
    frontier = {account_id}
    undirected = G.to_undirected()
    for _ in range(depth):
        next_frontier = set()
        for node in frontier:
            next_frontier.update(undirected.neighbors(node))
        nodes.update(next_frontier)
        frontier = next_frontier
    return G.subgraph(nodes).copy()


# ---------------------------------------------------------------------------
# 4. Timeline Module
# ---------------------------------------------------------------------------
logger = logging.getLogger("fintrace.timeline_module")


@dataclass
class TimelineEvent:
    txn_id: str
    timestamp: pd.Timestamp
    step: int
    direction: str
    counterparty: str
    amount: float
    balance_after: float
    z_score: float
    is_flagged_moment: bool
    flag_reasons: list


def build_timeline(account_id: str, index: AccountIndex) -> pd.DataFrame:
    record = index.get(account_id)
    activity = record.all_activity.copy()
    if activity.empty:
        return activity

    def resolve_balance(row):
        return row["newbalanceOrig"] if row["direction"] == "outgoing" else row["newbalanceDest"]

    activity["balance_after"] = activity.apply(resolve_balance, axis=1)

    mean_amt = activity["amount"].mean()
    std_amt = activity["amount"].std(ddof=0)
    activity["z_score"] = 0.0 if (std_amt == 0 or np.isnan(std_amt)) \
        else (activity["amount"] - mean_amt) / std_amt

    activity["hours_since_prev"] = activity["step"].diff()
    return activity


def flag_moments_of_interest(timeline: pd.DataFrame, z_threshold: float = 2.5,
                             dormancy_hours: int = 168):
    events = []
    if timeline.empty:
        return events

    for row in timeline.itertuples(index=False):
        reasons = []
        if abs(row.z_score) >= z_threshold:
            reasons.append(f"Amount is {row.z_score:+.1f} standard deviations from "
                           f"this account's typical transaction size.")

        gap = getattr(row, "hours_since_prev", np.nan)
        if not np.isnan(gap) and gap >= dormancy_hours and abs(row.z_score) >= 1.0:
            reasons.append(f"Follows {gap:.0f} hours of inactivity — a "
                           f"dormant-then-active pattern.")

        if getattr(row, "isFraud", 0) == 1:
            reasons.append("Transaction is labeled fraudulent in the source data.")

        events.append(TimelineEvent(
            txn_id=row.txn_id, timestamp=row.timestamp, step=row.step,
            direction=row.direction, counterparty=row.counterparty,
            amount=row.amount, balance_after=row.balance_after,
            z_score=row.z_score, is_flagged_moment=len(reasons) > 0,
            flag_reasons=reasons,
        ))
    return events


# ---------------------------------------------------------------------------
# 5. Explainability
# ---------------------------------------------------------------------------
logger = logging.getLogger("fintrace.explainability")


@dataclass
class AnomalyExplanation:
    account_id: str
    risk_score: float
    risk_band: str
    signals: list = field(default_factory=list)

    def summary(self) -> str:
        if not self.signals:
            return "No significant anomaly signals detected for this account."
        top = sorted(self.signals, key=lambda s: -s["weight"])[0]
        return f"Primary driver: {top['detail']}"


def _iqr_outlier_fraction(values: pd.Series) -> float:
    if len(values) < 4:
        return 0.0
    q1, q3 = values.quantile([0.25, 0.75])
    iqr = q3 - q1
    if iqr == 0:
        return 0.0
    lower, upper = q1 - 1.5 * iqr, q3 + 1.5 * iqr
    outliers = values[(values < lower) | (values > upper)]
    return len(outliers) / len(values)


def risk_band(score: float) -> str:
    """The notebook's four bands."""
    return ("Critical" if score >= 75 else "High" if score >= 50
            else "Medium" if score >= 25 else "Low")


def score_account(account_id: str, index: AccountIndex,
                  new_counterparty_window: int = 5,
                  use_labels: bool = True) -> AnomalyExplanation:
    """Explainable anomaly score in [0, 100] (notebook section 5).

    `use_labels=False` drops signal 4 (direct fraud labels). The website
    uses that variant for *classification*, because a score built from
    the isFraud column cannot be fairly evaluated against isFraud."""
    record = index.get(account_id)
    activity = record.all_activity
    signals, score = [], 0.0

    if activity.empty:
        return AnomalyExplanation(account_id, 0.0, "Low", [])

    amounts = activity["amount"]
    mean_amt, std_amt = amounts.mean(), amounts.std(ddof=0)

    # Signal 1: extreme z-score transactions
    extreme_frac = float(((amounts - mean_amt) / std_amt).abs().ge(2.5).mean()) \
        if std_amt and not np.isnan(std_amt) else 0.0
    if extreme_frac > 0:
        weight = min(40.0, extreme_frac * 100)
        score += weight
        signals.append({"feature": "amount_zscore",
            "detail": f"{extreme_frac:.0%} of this account's transactions are more "
                      f"than 2.5 standard deviations from its typical amount.",
            "weight": weight})

    # Signal 2: IQR-based outlier share
    outlier_frac = _iqr_outlier_fraction(amounts)
    if outlier_frac > 0:
        weight = min(25.0, outlier_frac * 60)
        score += weight
        signals.append({"feature": "iqr_outliers",
            "detail": f"{outlier_frac:.0%} of transaction amounts fall outside the "
                      f"account's normal interquartile range.",
            "weight": weight})

    # Signal 3: counterparty novelty in recent activity
    ordered = activity  # already chronologically ordered by all_activity
    seen, novel_recent = set(), 0
    recent = ordered.tail(new_counterparty_window)
    recent_ids = set(recent["txn_id"])
    for _, row in ordered.iterrows():
        if row["counterparty"] not in seen and row["txn_id"] in recent_ids:
            novel_recent += 1
        seen.add(row["counterparty"])
    if len(recent) > 0:
        novelty_frac = novel_recent / len(recent)
        if novelty_frac >= 0.4:
            weight = min(20.0, novelty_frac * 30)
            score += weight
            signals.append({"feature": "counterparty_novelty",
                "detail": f"{novel_recent} of the last {len(recent)} transactions are "
                          f"with counterparties never seen before in this account's history.",
                "weight": weight})

    # Signal 4: direct fraud labels
    if use_labels:
        fraud_count = int(activity["isFraud"].sum())
        if fraud_count > 0:
            weight = min(35.0, fraud_count * 15)
            score += weight
            signals.append({"feature": "labeled_fraud",
                "detail": f"{fraud_count} transaction(s) on this account are directly "
                          f"labeled fraudulent in the source data.",
                "weight": weight})

    score = min(100.0, score)
    return AnomalyExplanation(account_id=account_id, risk_score=round(score, 1),
                              risk_band=risk_band(score), signals=signals)


# ---------------------------------------------------------------------------
# 6. Report Generator (template unchanged from the notebook)
# ---------------------------------------------------------------------------
CASE_REPORT_TEMPLATE = (Path(__file__).with_name("case_report.html.j2")).read_text(encoding="utf-8")


def render_case_report(account_id: str, index: AccountIndex, G: nx.DiGraph,
                       partition: dict = None) -> str:
    """Same as the notebook's generate_case_report, but returns the HTML
    instead of writing it to disk."""
    record = index.get(account_id)
    explanation = score_account(account_id, index)

    timeline_df = build_timeline(account_id, index)
    timeline_events = flag_moments_of_interest(timeline_df)

    try:
        neighborhood = get_neighborhood(G, account_id, depth=1)
        neighbors = sorted(n for n in neighborhood.nodes() if n != account_id)
    except KeyError:
        neighbors = []

    community_id = partition.get(account_id) if partition else None

    return Template(CASE_REPORT_TEMPLATE).render(
        account_id=account_id,
        generated_at=datetime.now(timezone.utc).strftime("%Y-%m-%d %H:%M UTC"),
        total_transactions=len(record.all_activity),
        risk_score=explanation.risk_score,
        risk_band=explanation.risk_band,
        signals=explanation.signals,
        total_sent=f"{record.total_sent:,.2f}",
        total_received=f"{record.total_received:,.2f}",
        counterparty_count=len(record.counterparties),
        fraud_count=record.flagged_transaction_count,
        neighbors=neighbors,
        community_id=community_id,
        timeline_events=timeline_events,
    )
