#!/usr/bin/env python3
"""Mede suavização e atraso sobre sinais sintéticos com referência conhecida."""

import argparse
import json
import math
from pathlib import Path
import random
from statistics import median
import sys

ROOT = Path(__file__).resolve().parents[1]
sys.path.insert(0, str(ROOT / "src-tauri" / "python"))

from hybrid.one_euro_filter import VERSION, filter_keypoint as one_euro_filter
from hybrid.temporal_filter import POLICY as FC_POLICY, filter_keypoint as fc_filter


FRAME_COUNT = 250
FRAME_RATE = 25
STEP_FRAME = 75
SEED = 20261118


def generated_cases():
    clock = [frame / FRAME_RATE for frame in range(FRAME_COUNT)]
    rng = random.Random(SEED)
    stationary = [(100.0, 50.0) for _ in clock]
    periodic = [(100 + 20 * math.sin(2 * math.pi * .5 * time),
                 50 + 10 * math.cos(2 * math.pi * .25 * time)) for time in clock]
    step = [(100.0 if frame < STEP_FRAME else 140.0, 50.0)
            for frame in range(FRAME_COUNT)]

    def noisy(reference, gap=False):
        return [(None, None, None) if gap and 100 <= frame < 105 else
                (x + rng.gauss(0, 2), y + rng.gauss(0, 2), .9)
                for frame, (x, y) in enumerate(reference)]

    return {
        "stationary_noisy_gap": (stationary, noisy(stationary, gap=True)),
        "periodic_noisy": (periodic, noisy(periodic)),
        "step_clean": (step, [(x, y, .9) for x, y in step]),
    }, clock


def metrics(values, reference, step=False):
    valid = [index for index, value in enumerate(values) if value is not None]
    errors = [math.hypot(values[index][0] - reference[index][0],
                         values[index][1] - reference[index][1]) for index in valid]
    second = [math.hypot(values[index-1][0] - 2*values[index][0] + values[index+1][0],
                         values[index-1][1] - 2*values[index][1] + values[index+1][1])
              for index in range(1, len(values)-1)
              if all(values[other] is not None for other in (index-1, index, index+1))]
    result = {
        "validFrames": len(valid),
        "meanErrorToSyntheticTruthPx": sum(errors) / len(errors) if errors else None,
        "medianSecondDifferencePx": median(second) if second else None,
    }
    if step:
        crossing = next((frame for frame in range(STEP_FRAME, len(values))
                         if values[frame] is not None and values[frame][0] >= 120), None)
        result["halfStepDelayFrames"] = crossing - STEP_FRAME if crossing is not None else None
        result["halfStepDelayMs"] = (crossing - STEP_FRAME) * 1000 / FRAME_RATE if crossing is not None else None
    return result


def benchmark():
    cases, timestamps = generated_cases()
    report = {}
    for name, (reference, samples) in cases.items():
        variants = {
            "raw": [sample if sample[0] is not None else None for sample in samples],
            "fcMedian": fc_filter(samples),
            "oneEuroBeta0001": one_euro_filter(samples, timestamps, beta=.001),
            "oneEuroBeta001": one_euro_filter(samples, timestamps, beta=.01),
        }
        report[name] = {variant: metrics(values, reference, step=name == "step_clean")
                        for variant, values in variants.items()}
    return {
        "status": "SYNTHETIC_ONLY_NOT_ANATOMICAL_VALIDATION",
        "generatorVersion": 1,
        "randomSeed": SEED,
        "frameRate": FRAME_RATE,
        "frameCountPerCase": FRAME_COUNT,
        "noiseSigmaPxPerAxis": 2,
        "gapFrameRangeInclusive": [100, 104],
        "stepFrame": STEP_FRAME,
        "stepSizePx": 40,
        "filterVersions": {"fcMedian": FC_POLICY["version"], "oneEuro": VERSION},
        "parameters": {"likelihoodThreshold": .6, "minCutoffHz": 1.0,
                       "betaValues": [.001, .01], "maxGapSec": .25},
        "interpretation": "Errors and delays use generated coordinates only. The centered F+C window uses future frames. These values cannot establish anatomical accuracy or timing on real videos.",
        "cases": report,
    }


def main():
    parser = argparse.ArgumentParser(description=__doc__)
    parser.add_argument("--output", type=Path)
    args = parser.parse_args()
    payload = json.dumps(benchmark(), ensure_ascii=False, indent=2, allow_nan=False) + "\n"
    if args.output:
        args.output.parent.mkdir(parents=True, exist_ok=True)
        args.output.write_text(payload, encoding="utf-8")
    else:
        print(payload, end="")


if __name__ == "__main__":
    main()
