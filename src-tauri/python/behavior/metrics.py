"""Coverage-aware automatic metrics, separate from human-reviewed estimates."""
from collections import Counter


def calculate(predictions, events, duration):
    coverage = sum(p["endSec"]-p["timestampSec"] for p in predictions if p.get("observation") == "OBSERVED" and p.get("classification") != "UNKNOWN")
    coverage = min(duration, coverage)
    durations = [e["durationSec"] for e in events]
    counts = Counter(e["behavior"] for e in events)
    first = events[0]["startSec"] if events else None
    prefix = 0.
    if first is not None:
        for p in predictions:
            if p["timestampSec"] >= first:
                break
            if p.get("classification") == "UNKNOWN" or p["timestampSec"] > prefix+1e-8:
                break
            prefix = p["endSec"]
    latency_exact = first is not None and prefix+1e-8 >= first
    bins = []
    for minute in range(int((duration+59.999999)//60)):
        start, end = minute*60, min(duration, (minute+1)*60)
        classified = sum(max(0., min(end, p["endSec"])-max(start, p["timestampSec"])) for p in predictions if p.get("observation") == "OBSERVED" and p.get("classification") != "UNKNOWN")
        bins.append(dict(startSec=start, endSec=end, classifiableDurationSec=classified,
                         count=sum(start <= e["startSec"] < end for e in events)))
    measurable = coverage > 0
    def observed_gap(start, end):
        cursor = start
        for prediction in predictions:
            if prediction["endSec"] <= start or prediction["timestampSec"] >= end:
                continue
            if prediction.get("classification") == "UNKNOWN" or prediction["timestampSec"] > cursor+1e-8:
                return False
            cursor = prediction["endSec"]
        return cursor+1e-8 >= end
    return dict(schemaVersion=1, validationStatus="experimental", metricSource="automatic",
        analysisDurationSec=duration, classifiableDurationSec=coverage, unknownDurationSec=max(0., duration-coverage),
        coveragePct=100*coverage/duration if duration > 0 else None,
        rearing=dict(totalCount=len(events) if measurable else None,
            supportedCount=counts["REARING_SUPPORTED"] if measurable else None,
            unsupportedCount=counts["REARING_UNSUPPORTED"] if measurable else None,
            unspecifiedCount=counts["REARING_UNSPECIFIED"] if measurable else None,
            totalDurationSec=sum(durations) if measurable else None,
            meanDurationSec=sum(durations)/len(durations) if durations else None,
            maxDurationSec=max(durations) if durations else None,
            perClassifiableMinute=len(events)*60/coverage if measurable else None,
            percentClassifiableTime=100*sum(durations)/coverage if measurable else None,
            latencySec=first if latency_exact else None, firstObservedRearingSec=first, latencyExact=latency_exact,
            interEpisodeIntervalsSec=[max(0., b["startSec"]-a["endSec"]) if observed_gap(a["endSec"],b["startSec"]) else None for a, b in zip(events, events[1:])],
            interObservedEpisodeGapsSec=[max(0., b["startSec"]-a["endSec"]) for a, b in zip(events, events[1:])]),
        perMinute=bins)
