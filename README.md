# FinTrace Fraud Monitor

A fraud monitoring website built on the **real PaySim dataset**
(`PS_20174392719_1491204439457_log.csv`, 6,362,620 transactions) and the
**FinTrace notebook** ([`notebooks/FinTrace_Colab_1.ipynb`](notebooks/FinTrace_Colab_1.ipynb)).

The dataset (470 MB) is not included in this repository. Download it from Kaggle:
[Synthetic Financial Datasets For Fraud Detection](https://www.kaggle.com/datasets/ealaxi/paysim1).

```
PaySim CSV ──► scripts/build_data.py ──► data/fintrace.duckdb + data/stats.json
                     │ (notebook rules for all 9.07M accounts, in SQL)
                     ▼
fintrace/core.py  ◄── notebook sections 2–6, ported (score_account, timeline, case report)
                     ▼
backend/app.py (FastAPI)  /api/*  ──►  frontend/ (HTML + JS, no CDN; works offline)
backend/model_slot.py     optional ML model: models/model.joblib + models/metrics.json
```

## Run it

```bash
python -m venv .venv
.venv\Scripts\python -m pip install -r requirements.txt
.venv\Scripts\python scripts\build_data.py "path\to\PS_20174392719_1491204439457_log.csv"
.venv\Scripts\python -m uvicorn backend.app:app --port 8000
```

Open http://localhost:8000. The build takes about 2 minutes and writes a
~1.4 GB database to `data/`. That folder is inside OneDrive, so to keep it out
of sync set `FINTRACE_DATA_DIR` to a folder elsewhere, for both the build and
the server.

## What is real, what is rule-based, what is not available

| Page | Source of every number |
|---|---|
| Dashboard | Counts and amounts computed from the full CSV. "Suspicious" = FinTrace rule score ≥ 50 **or** PaySim's own `isFlaggedFraud`. |
| Transaction Explorer | Live SQL over all 6.36M rows (search, filter, sort, CSV export). |
| Detection Engine | Live call to the notebook's `score_account()` for sender and receiver. **Rule-based, not ML.** |
| Risk Analysis | Notebook score (0–100), signals, timeline (section 4), neighbourhood, case report (section 6 template). |
| Fraud Analytics | Descriptive statistics of the dataset. |
| Alerts & Reports | Alert queue from the rules above. CSV exports, notebook case reports, printable summary. |
| Model Performance | Precision/recall/F1/confusion matrix of the **rule-based** detectors against `isFraud`. ML card says *not available*. |

Notes that matter for a fair demo:

- **No ML model exists in the notebook.** Its design note says the scoring is
  rule-based on purpose ("explainability over accuracy"). The site never
  shows ML predictions or ML metrics it doesn't have.
- **Label leakage is avoided.** The notebook's 4th signal adds weight for
  transactions already labeled fraud. Classification and evaluation use the
  score *without* that signal ("behavioral"). The full notebook score is
  shown as the "investigative" score.
- **Results are reported honestly.** At threshold 50 the rules flag 1,138
  transactions and catch 5 of 8,213 frauds (precision 0.44%, recall 0.06%).
  The per-account rules don't separate PaySim fraud well, because most
  accounts appear only once or twice. The Model Performance page explains
  this and shows the full threshold trade-off.
- **The scorer is verified.** The SQL version of `score_account` used for
  9.07M accounts was checked against the notebook's Python function on 180
  random accounts with 0 mismatches. The build log prints this check every run.
- Bands: Low < 25 ≤ Medium < 50 ≤ High. The notebook's "Critical" (≥ 75) is
  folded into High.
- Time: one step is one simulated hour. "Day d · hh:00" matches the notebook's
  `2023-01-01 + step hours` timestamp.

## Connecting a real ML model later

The API already has a slot for one. Train in the notebook (after section 7),
then copy the two files into `models/` and restart the server:

```python
# --- in FinTrace_Colab_1.ipynb, after df is loaded ---
import json, joblib
from sklearn.compose import ColumnTransformer
from sklearn.preprocessing import OneHotEncoder
from sklearn.pipeline import Pipeline
from sklearn.ensemble import HistGradientBoostingClassifier
from sklearn.metrics import accuracy_score, precision_score, recall_score, f1_score, confusion_matrix

FEATURES = ["step", "type", "amount", "oldbalanceOrg", "newbalanceOrig",
            "oldbalanceDest", "newbalanceDest"]          # must match backend/model_slot.py
train, test = df[df.step <= 550], df[df.step > 550]       # time-based hold-out
pipe = Pipeline([
    ("prep", ColumnTransformer([("type", OneHotEncoder(handle_unknown="ignore", sparse_output=False), ["type"])],
                               remainder="passthrough")),
    ("clf", HistGradientBoostingClassifier(class_weight="balanced", random_state=0)),
])
pipe.fit(train[FEATURES], train.isFraud)
pred = pipe.predict(test[FEATURES])
metrics = {
    "name": "HistGradientBoosting (PaySim features)",
    "evaluated_on": f"time-based hold-out: steps > 550 ({len(test):,} transactions)",
    "accuracy": accuracy_score(test.isFraud, pred), "precision": precision_score(test.isFraud, pred),
    "recall": recall_score(test.isFraud, pred), "f1": f1_score(test.isFraud, pred),
    "confusion_matrix": confusion_matrix(test.isFraud, pred).tolist(),   # [[tn, fp], [fn, tp]]
}
joblib.dump(pipe, "model.joblib")
json.dump(metrics, open("metrics.json", "w"), indent=1)
```

Then run `pip install scikit-learn` in `.venv`, using the same scikit-learn
version as Colab. The Detection Engine shows the model's probability next to
the rule-based verdict, and Model Performance shows *your* held-out metrics,
labeled as coming from `metrics.json`. Only load model files you trained
yourself, because joblib/pickle files can execute code.

## A bug in the original notebook

Section 7e fails with `KeyError: "['txn_id', 'timestamp'] not in index"`.
The cause is that cell 7a loads the file with plain `pd.read_csv`, which
skips the `timestamp`/`txn_id` columns that `load_transactions()` adds. Fix:

```python
df = load_transactions(DATA_PATH)   # instead of pd.read_csv(DATA_PATH)
```

## API

| Endpoint | Purpose |
|---|---|
| `GET /api/health` | Status, data store, ML slot status |
| `GET /api/stats` | Pre-computed aggregates and evaluation |
| `GET /api/transactions` | Filter/sort/paginate (`type, fraud, flagged, band, suspicious, min/max_amount, min/max_step, account, txn, sort, order, page, page_size`) |
| `GET /api/transactions/export` | Same filters → CSV (≤ 250k rows) |
| `GET /api/transactions/random` | Random row (`fraud`, `band`, `type`) |
| `GET /api/transactions/{row_id}` | One transaction |
| `GET /api/accounts/{id}` | Notebook score (behavioral + investigative), signals, timeline, neighbours |
| `GET /api/accounts/{id}/report` | Notebook HTML case report (`?download=true`) |
| `GET /api/accounts/top` | Highest-scoring accounts |
| `POST /api/engine/score` | `{"row_id": n}` or `{"transaction": {...}}` → verdict, both parties' signals, ML slot |

Interactive docs: http://localhost:8000/docs
