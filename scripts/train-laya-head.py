#!/usr/bin/env python3
"""
Train the local decision heads for the Laya provider.

Laya's own question heads carry almost no signal about which tool results a
session still needs, so this trains two small linear heads on the checkpoint's
own encoder: one predicts the teacher's drop decision, one predicts whether the
output addresses an agent. The features are the mean-pooled, normalised encoder
state, which is why head mode does not need the question path at all.

   python3 scripts/train-laya-head.py --states /tmp/cd-states-merged.json --out calibration/laya-head.json
"""
import argparse
import json
import time
from pathlib import Path

import numpy as np

ROOT = Path(__file__).resolve().parent.parent
LAMBDA = 0.01
# The question ids the probe is fitted for. The plugin falls back to the
# checkpoint's own heads for anything outside this list.
DIET_QUESTIONS = ['needs_contents', 'replaceable', 'keep_call', 'agent_directed', 'behaviour_change']


def folds_of(n, folds=5, seed=0):
    order = np.random.default_rng(seed).permutation(n)
    return [order[i::folds] for i in range(folds)]


def fit(X, y, lam=LAMBDA):
    Xb = np.hstack([X, np.ones((X.shape[0], 1))])
    return np.linalg.solve(Xb.T @ Xb + lam * np.eye(Xb.shape[1]), Xb.T @ y)


def oof_scores(X, y, folds):
    out = np.zeros(len(y))
    for fold in folds:
        train = np.setdiff1d(np.arange(len(y)), fold)
        weights = fit(X[train], y[train])
        out[fold] = np.hstack([X[fold], np.ones((len(fold), 1))]) @ weights
    return out


def pick_threshold(scores, labels):
    """The largest sweep point with no false positives: conservative by design."""
    truth = labels > 0
    best = (None, 0)
    for threshold in np.arange(-0.5, 2.0, 0.02):
        guess = scores > threshold
        if int((guess & ~truth).sum()) != 0:
            continue
        recovered = int((guess & truth).sum())
        if best[0] is None or recovered >= best[1]:
            best = (float(threshold), recovered)
    return best if best[0] is not None else (0.0, 0)


def main():
    parser = argparse.ArgumentParser(description='Train the Laya decision heads on this machine')
    parser.add_argument('--states', default='/tmp/cd-states-merged.json')
    parser.add_argument('--out', default=str(ROOT / 'calibration' / 'laya-head.json'))
    parser.add_argument('--subfolder', default='')
    args = parser.parse_args()

    import torch
    import laya

    rows = json.loads(Path(args.states).read_text())['rows']
    texts = [row['stateText'] for row in rows]
    print('states: ' + str(len(rows)))

    agent = laya.load('convaiinnovations/laya', subfolder=args.subfolder or None)
    encoder = agent.model.encoder.eval()
    tokenizer = agent.tok

    vectors = []
    started = time.time()
    with torch.no_grad():
        for start in range(0, len(texts), 8):
            chunk = texts[start:start + 8]
            encoded = tokenizer(chunk, return_tensors='pt', padding=True, truncation=True, max_length=512)
            encoded = {key: value.to(agent.device) for key, value in encoded.items()}
            hidden = encoder(**encoded).last_hidden_state
            mask = encoded['attention_mask'].unsqueeze(-1).float()
            pooled = (hidden * mask).sum(1) / mask.sum(1).clamp(min=1e-6)
            pooled = torch.nn.functional.normalize(pooled, dim=-1)
            vectors.append(pooled.float().cpu().numpy())
    X = np.vstack(vectors)
    print('embedded in %.1fs, shape %s' % (time.time() - started, X.shape))

    drop_labels = np.array([1.0 if row['teacherDrop'] else -1.0 for row in rows])
    drop_scores = oof_scores(X, drop_labels, folds_of(len(rows)))
    drop_threshold, _ = pick_threshold(drop_scores, drop_labels)
    truth = drop_labels > 0
    guess = drop_scores > drop_threshold
    drop_cv = {
        'agreement': round(float((guess == truth).mean()), 4),
        'recovered': int((guess & truth).sum()),
        'falseDrops': int((guess & ~truth).sum()),
        'teacherDrops': int(truth.sum()),
    }

    hazard_raw = np.array([float(row.get('teacherHazard', 0.0)) for row in rows])
    hazard_labels = np.where(hazard_raw >= 0.5, 1.0, -1.0)
    hazard_scores = oof_scores(X, hazard_labels, folds_of(len(rows), seed=1))
    hazard_threshold, _ = pick_threshold(hazard_scores, hazard_labels)
    hazard_truth = hazard_labels > 0
    hazard_guess = hazard_scores > hazard_threshold
    hazard_cv = {
        'accuracy': round(float((hazard_guess == hazard_truth).mean()), 4),
        'positives': int(hazard_truth.sum()),
        'recall': round(float((hazard_guess & hazard_truth).sum() / max(1, int(hazard_truth.sum()))), 4),
        'precision': round(float((hazard_guess & hazard_truth).sum() / max(1, int(hazard_guess.sum()))), 4),
    }

    document = {
      'version': 2,
        'trainedAt': time.strftime('%Y-%m-%dT%H:%M:%SZ', time.gmtime()),
        'teacher': 'jev',
        'student': 'convaiinnovations/laya' + (('/' + args.subfolder) if args.subfolder else ''),
        'encoder': 'the checkpoint encoder, mean-pooled and normalised',
        'featureDim': int(X.shape[1]),
        'lambda': LAMBDA,
        'samples': len(rows),
        'questions': DIET_QUESTIONS,
        'drop': {'weights': [round(float(v), 6) for v in fit(X, drop_labels)], 'threshold': round(drop_threshold, 4), 'cv': drop_cv},
        'hazard': {'weights': [round(float(v), 6) for v in fit(X, hazard_labels)], 'threshold': round(hazard_threshold, 4), 'cv': hazard_cv},
    }
    out = Path(args.out)
    out.parent.mkdir(parents=True, exist_ok=True)
    out.write_text(json.dumps(document, indent=2) + '\n')
    print('drop head:   agreement %.3f, recovered %d/%d, false drops %d, threshold %.2f' % (
        drop_cv['agreement'], drop_cv['recovered'], drop_cv['teacherDrops'], drop_cv['falseDrops'], drop_threshold))
    print('hazard head: accuracy %.3f, recall %.3f, precision %.3f' % (
        hazard_cv['accuracy'], hazard_cv['recall'], hazard_cv['precision']))
    print('wrote ' + str(out))


if __name__ == '__main__':
    main()
