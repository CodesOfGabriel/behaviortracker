"""Constant-velocity Kalman filter and Rauch--Tung--Striebel backward pass.

Seven display points share covariance but retain independent positions/speeds.
Original observations and timestamps are never rewritten.
"""
import numpy as np


def smooth(points, times, variances, body_length):
    values = np.asarray(points, float)
    count = len(values)
    if count < 2:
        return values.copy(), np.zeros(count)
    states = np.zeros((count, values.shape[1], 4))
    covariance = np.zeros((count, 4, 4))
    predictions = np.zeros_like(states)
    predicted_covariance = np.zeros_like(covariance)
    transitions = np.zeros_like(covariance)
    states[0, :, :2] = values[0]
    covariance[0] = np.diag([variances[0], variances[0], body_length**2, body_length**2])
    for i in range(1, count):
        dt = max(1e-4, times[i]-times[i-1])
        f = np.eye(4); f[0, 2] = f[1, 3] = dt
        g = np.array([[dt*dt/2, 0], [0, dt*dt/2], [dt, 0], [0, dt]])
        q = g @ g.T * (body_length * 6)**2
        predictions[i] = states[i-1] @ f.T
        p = f @ covariance[i-1] @ f.T + q
        predicted_covariance[i] = p
        transitions[i] = f
        innovation = values[i] - predictions[i, :, :2]
        r = max(.1, variances[i])
        # A pose jump inflates uncertainty instead of dragging the trajectory.
        residual = np.median(np.sum(innovation**2, axis=1))
        r = max(r, residual / 16)
        gain = np.linalg.solve(p[:2, :2] + np.eye(2)*r, p[:2]).T
        states[i] = predictions[i] + innovation @ gain.T
        # Joseph form keeps covariance positive under small/irregular PTS.
        a = np.eye(4); a[:, :2] -= gain
        covariance[i] = a @ p @ a.T + r * gain @ gain.T
    for i in range(count-2, -1, -1):
        gain = np.linalg.solve(predicted_covariance[i+1], transitions[i+1] @ covariance[i]).T
        states[i] += (states[i+1]-predictions[i+1]) @ gain.T
        covariance[i] += gain @ (covariance[i+1]-predicted_covariance[i+1]) @ gain.T
    uncertainty = np.sqrt(np.maximum(0, covariance[:, 0, 0]+covariance[:, 1, 1]))
    return states[:, :, :2], uncertainty
