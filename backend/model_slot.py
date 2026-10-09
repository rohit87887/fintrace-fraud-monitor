"""Optional ML model slot.

The FinTrace notebook does not contain a trained machine-learning model -
its scoring is deliberately rule-based (section 5). This module is the
connection point for one if you add it later:

  models/model.joblib   a scikit-learn Pipeline whose predict_proba accepts a
                        DataFrame with FEATURES columns (see README)
  models/metrics.json   held-out evaluation numbers produced by YOUR notebook
                        (accuracy, precision, recall, f1, confusion_matrix)

When neither file exists the API reports `available: false` and the UI
says so, instead of showing invented predictions or metrics.

Security note: joblib/pickle files execute code when loaded. Only place a
model file here that you trained yourself.
"""
import json
from pathlib import Path

FEATURES = ["step", "type", "amount", "oldbalanceOrg", "newbalanceOrig",
            "oldbalanceDest", "newbalanceDest"]


class ModelSlot:
    def __init__(self, models_dir: Path):
        self.dir = Path(models_dir)
        self.model = None
        self.error = None
        self.metrics = None
        model_path = self.dir / "model.joblib"
        if model_path.exists():
            try:
                import joblib
                self.model = joblib.load(model_path)
            except Exception as e:  # report, don't crash the API
                self.error = f"Could not load {model_path.name}: {e}"
        metrics_path = self.dir / "metrics.json"
        if metrics_path.exists():
            try:
                self.metrics = json.loads(metrics_path.read_text(encoding="utf-8"))
            except Exception as e:
                self.error = f"Could not read metrics.json: {e}"

    @property
    def available(self) -> bool:
        return self.model is not None

    def status(self) -> dict:
        return {
            "available": self.available,
            "name": (self.metrics or {}).get("name"),
            "features": FEATURES,
            "has_metrics": self.metrics is not None,
            "error": self.error,
        }

    def predict_proba(self, tx: dict):
        if not self.available:
            return None
        import pandas as pd
        X = pd.DataFrame([{k: tx[k] for k in FEATURES}])
        return float(self.model.predict_proba(X)[0, 1])
