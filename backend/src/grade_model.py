import hashlib
import json
from functools import lru_cache

import numpy as np
from sklearn.ensemble import GradientBoostingClassifier
from sklearn.model_selection import train_test_split

from .constants import ATTRIBUTES, MODEL_SEED, Grade

DEFAULT_PARAMETERS = {'n_estimators': 70, 'max_depth': 2, 'learning_rate': .09, 'random_state': MODEL_SEED}


def digest(snapshot):
    encoded = json.dumps(snapshot, sort_keys=True, separators=(',', ':'), ensure_ascii=False)
    return hashlib.sha256(encoded.encode()).hexdigest()


def training_records():
    rng = np.random.default_rng(MODEL_SEED)
    quality = rng.uniform(44, 97, 1050)
    attributes = np.clip(quality[:, None] + rng.normal(0, 7, (len(quality), 4)), 0, 100)
    defects = np.clip((80 - quality) * .26 + rng.normal(3, 2.5, len(quality)), 0, 20)
    dispersion = rng.gamma(2, 3, len(quality))
    sensory = attributes @ np.array([.34, .27, .23, .16]) - 1.6 * defects - .20 * dispersion
    witnessed = sensory + rng.normal(0, 5.5, len(quality))
    grade = np.select([witnessed >= 79, witnessed >= 62], [Grade.SELECTION.value, Grade.STANDARD.value],
                      default=Grade.SECONDARY.value)
    return np.column_stack((attributes, defects, dispersion)), grade


def _cache_key(parameters):
    return json.dumps(parameters, sort_keys=True)


@lru_cache(maxsize=16)
def _fitted(key):
    parameters = json.loads(key)
    x, labels = training_records()
    x_train, x_val, y_train, y_val = train_test_split(
        x, labels, test_size=.25, random_state=MODEL_SEED, stratify=labels)
    model = GradientBoostingClassifier(**parameters).fit(x_train, y_train)
    probabilities = model.predict_proba(x_val)
    confidence = probabilities.max(axis=1)
    correct = model.classes_[probabilities.argmax(axis=1)] == y_val
    metrics = {'training_rows': len(y_train), 'validation_rows': len(y_val),
               'accuracy': round(float(correct.mean()), 4),
               'training_digest': hashlib.sha256(x.tobytes() + '|'.join(labels).encode()).hexdigest()}
    candidates = (.50, .55, .60, .65, .70, .75, .80, .85, .90, .95)
    for threshold in candidates:
        accepted = confidence >= threshold
        if accepted.sum() >= 25 and correct[accepted].mean() >= .90:
            metrics.update({'accepted_accuracy': round(float(correct[accepted].mean()), 4),
                            'coverage': round(float(accepted.mean()), 4),
                            'calibrated': True, 'calibrated_floor': float(threshold)})
            return model, metrics
    metrics.update({'calibrated': False, 'calibrated_floor': 1.0})
    return model, metrics


def fit(parameters):
    """按给定训练参数在固定的校准划分上拟合模型，返回 (模型, 校准指标)。同参数结果一致。"""
    return _fitted(_cache_key(parameters))


def run(snapshot, model_row):
    rows = snapshot['ingredients']
    weights = np.asarray([float(row['percent']) / 100 for row in rows])
    scores = np.asarray([[row['scores'][field] for field in ATTRIBUTES] for row in rows], dtype=float)
    combined = weights @ scores
    aroma_spread = (weights @ ((scores[:, 0] - combined[0]) ** 2)) ** .5
    vector = np.r_[combined, aroma_spread]
    model, _ = fit(model_row.parameters)
    metrics = model_row.metrics
    probabilities = model.predict_proba([vector])[0]
    index = probabilities.argmax()
    floor = float(metrics['calibrated_floor'])
    threshold = max(floor, float(snapshot['policy_floor']))
    return {
        'model': model_row.label, 'model_id': model_row.id, 'seed': MODEL_SEED,
        'parameters': model_row.parameters,
        'input_digest': digest(snapshot), 'validation': metrics,
        'features': dict(zip((*ATTRIBUTES, 'aroma_spread'), vector.round(4).tolist())),
        'probabilities': {grade: round(float(p), 6) for grade, p in zip(model.classes_, probabilities)},
        'confidence': float(probabilities[index]), 'calibrated_floor': floor,
        'effective_threshold': threshold, 'candidate': str(model.classes_[index]),
        'needs_repanel': bool(probabilities[index] < threshold),
    }
