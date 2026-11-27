"""Offline head/tail hypotheses. Motion transports endpoints, never labels them.

Costs are engineering support scores, not calibrated anatomical probabilities.
Public states: 0 head at first endpoint; 1 head at last; 2 unknown.
The two uncertain hidden states retain the alternative endpoint identities.
"""
import numpy as np


def decode(paths, times, evidence, motions, *, return_direction=False):
    count = len(paths)
    if not count:
        result = (np.empty(0, int), np.empty(0))
        return (*result, np.empty(0, int)) if return_direction else result
    emissions = np.zeros((count, 4))
    for i, (path, item) in enumerate(zip(paths, evidence)):
        emissions[i, :2] = .03
        emissions[i, 2:] = .12
        if item is None:
            continue
        direction, weight = item
        sign = np.dot(path[-1] - path[0], direction)
        preferred = 1 if sign > 0 else 0
        emissions[i, preferred] = 0.
        emissions[i, 1-preferred] = weight
        emissions[i, 2:] = weight * .45 + .12
    transitions = np.zeros((count, 4, 4))
    for i in range(1, count):
        old, new = paths[i-1][[0, -1]], paths[i][[0, -1]]
        matrix = motions[i]
        if matrix is not None:
            old = old @ matrix[:, :2].T + matrix[:, 2]
        length = max(5., np.linalg.norm(new[1]-new[0]), np.linalg.norm(old[1]-old[0]))
        # Remove translation: walking backwards/laterally cannot imply a swap.
        old = old - old.mean(0)
        new = new - new.mean(0)
        for a in range(4):
            for b in range(4):
                previous = old if a % 2 == 0 else old[::-1]
                current = new if b % 2 == 0 else new[::-1]
                cost = np.mean(np.sum((previous-current)**2, axis=1)) / length**2
                # Uncertainty can suppress a label, but cannot be used as a
                # cheap A -> unknown -> B shortcut around image continuity.
                transitions[i, a, b] = min(8., cost * (12. if matrix is not None else 6.)) + (.2 if (a < 2) != (b < 2) else 0.)
                old_axis = previous[1]-previous[0]
                new_axis = current[1]-current[0]
                if matrix is not None and np.dot(old_axis, new_axis) < 0:
                    # A validated pixel transform follows the same body parts.
                    # Contrary tail proposals must become uncertain, rather
                    # than exchanging those parts during an uncertainty gap.
                    transitions[i, a, b] = np.inf
        # A discontinuous clock must not propagate anatomical identity.
        if not 0 < times[i]-times[i-1] <= .25:
            transitions[i] = 0.
    forward = emissions.copy()
    parents = np.zeros((count, 4), int)
    for i in range(1, count):
        costs = forward[i-1, :, None] + transitions[i]
        parents[i] = np.argmin(costs, axis=0)
        forward[i] += costs[parents[i], np.arange(4)]
        forward[i] -= forward[i].min()
    states = np.zeros(count, int)
    states[-1] = np.argmin(forward[-1])
    for i in range(count-1, 0, -1):
        states[i-1] = parents[i, states[i]]
    # Backward min-cost messages expose ties/weak evidence even if the single
    # best Viterbi path chose a direction arbitrarily.
    backward = np.zeros_like(forward)
    for i in range(count-2, -1, -1):
        backward[i] = np.min(transitions[i+1] + emissions[i+1] + backward[i+1], axis=1)
        backward[i] -= backward[i].min()
    costs = forward + backward
    margin = np.abs(np.min(costs[:, [0, 2]], axis=1)-np.min(costs[:, [1, 3]], axis=1))
    directions = states % 2
    states[(states >= 2) | (margin < .25)] = 2
    return (states, margin, directions) if return_direction else (states, margin)
