"""PTS-supported hysteresis; unknown gaps are never counted as rearing duration."""
from .contracts import validate_decoder
import math


def decode(predictions, config=None):
    c = validate_decoder(config or {})
    events, active, onset, offset = [], [], [], []
    last_end = None

    def finish():
        nonlocal active, onset, offset
        if active:
            duration = sum(p["endSec"]-p["timestampSec"] for p in active)
            if duration+1e-9 >= c["minimumDurationSec"]:
                supported = [p.get("pSupportedGivenRearing") for p in active if p.get("pSupportedGivenRearing") is not None]
                sub = sum(supported)/len(supported) if supported else None
                label = "REARING_SUPPORTED" if sub is not None and sub >= c["subtypeThreshold"] else "REARING_UNSUPPORTED" if sub is not None and sub <= 1-c["subtypeThreshold"] else "REARING_UNSPECIFIED"
                intervals = []
                for p in active:
                    if intervals and abs(intervals[-1][1]-p["timestampSec"]) < 1e-8:
                        intervals[-1][1] = p["endSec"]
                    else:
                        intervals.append([p["timestampSec"], p["endSec"]])
                events.append(dict(eventId=f"rear_{len(events)+1:04d}", startSec=active[0]["timestampSec"], endSec=active[-1]["endSec"],
                    durationSec=duration, behavior=label, score=sum(p["pRearing"] for p in active)/len(active),
                    reviewStatus="pending", observedIntervals=intervals,
                    censored=any(b[0]-a[1] > 1e-8 for a, b in zip(intervals, intervals[1:]))))
        active, onset, offset = [], [], []

    for p in predictions:
        if not all(isinstance(p.get(k), (int, float)) and math.isfinite(p[k]) for k in ("timestampSec", "endSec")) or p["timestampSec"] < 0 or p["endSec"] <= p["timestampSec"]:
            raise ValueError("Invalid prediction temporal support")
        for key in ("pRearing", "pSupportedGivenRearing"):
            if p.get(key) is not None and (not math.isfinite(p[key]) or not 0 <= p[key] <= 1):
                raise ValueError("Invalid model score")
        if last_end is not None and p["timestampSec"] < last_end-1e-8:
            raise ValueError("Prediction supports overlap or timestamps regress")
        if last_end is not None and p["timestampSec"]-last_end > c["maximumUnobservedGapSec"]:
            finish()
        last_end = p["endSec"]
        score = p.get("pRearing")
        if p.get("observation") != "OBSERVED" or score is None:
            onset, offset = [], []
            if active and p["endSec"]-active[-1]["endSec"] > c["maximumUnobservedGapSec"]:
                finish()
            continue
        if not active:
            if score >= c["onsetThreshold"]:
                onset.append(p)
                if sum(v["endSec"]-v["timestampSec"] for v in onset)+1e-9 >= c["minimumOnsetConfirmationSec"]:
                    active, onset = onset, []
            else:
                onset = []
        elif score < c["offsetThreshold"]:
            offset.append(p)
            if sum(v["endSec"]-v["timestampSec"] for v in offset)+1e-9 >= c["minimumOffsetConfirmationSec"]:
                # Confirmed quadrupedal evidence always separates episodes.
                finish()
        else:
            if offset and sum(v["endSec"]-v["timestampSec"] for v in offset) > c["maximumMergeGapSec"]:
                finish()
                onset = [p] if score >= c["onsetThreshold"] else []
                continue
            active.extend(offset)
            active.append(p)
            offset = []
    finish()
    return events
