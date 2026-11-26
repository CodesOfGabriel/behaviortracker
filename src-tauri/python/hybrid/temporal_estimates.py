"""Validate image-tracker estimates without turning them into measurements.

The tracker must supply positions and its visibility mask for the actual images.
No interpolation, held coordinates, or box-centre substitution is performed.
"""
import numpy as np

from hybrid.pose_refinement import box_diagonal, point_usable

POLICY = {"version": "temporal-image-estimate-2", "requiresTrackerVisibility": True,
          "requiresObservedBox": True, "maxStepFractionOfBoxDiagonal": .35,
          "neuralDisagreementFractionOfBoxDiagonal": .12,
          "source": "recovered", "metricEligible": False,
          "likelihoodInterpretation": "anchor_likelihood_not_current_point_probability",
          "scientificallyValidated": False}


def apply_estimates(poses, accepted, detections, keypoints, tracks, visible,
                    tracked_keypoints, anchor_frames, anchor_points, width, height):
    poses = np.asarray(poses, dtype=float)
    accepted = np.asarray(accepted, dtype=bool)
    tracks = np.asarray(tracks, dtype=float)
    visible = np.asarray(visible, dtype=bool)
    anchors = np.asarray(anchor_frames, dtype=int)
    anchor_points = np.asarray(anchor_points, dtype=float)
    count, joints = len(detections), len(tracked_keypoints)
    if (poses.shape != (count, len(keypoints), 3) or accepted.shape != poses.shape[:2]
            or tracks.shape != (count, joints, 2) or visible.shape != (count, joints)
            or anchors.shape != (joints,) or anchor_points.shape != (joints, 3)
            or len(set(tracked_keypoints)) != joints or any(k not in keypoints for k in tracked_keypoints)
            or (anchors < 0).any() or (anchors >= count).any()):
        raise ValueError("Dados incompatíveis na estimativa temporal")
    selected = poses.copy()
    recovered = np.zeros(accepted.shape, dtype=bool)
    for tracked_joint, key in enumerate(tracked_keypoints):
        joint = keypoints.index(key)
        anchor = int(anchors[tracked_joint])
        seed = anchor_points[tracked_joint]
        if (not point_usable(seed, detections[anchor], width, height)
                or not np.isfinite(tracks[anchor, tracked_joint]).all()
                or np.linalg.norm(tracks[anchor, tracked_joint]-seed[:2]) > 1.):
            continue
        path_valid = True
        for frame in range(anchor, count):
            if not visible[frame, tracked_joint]:
                path_valid = False
                continue
            point = tracks[frame, tracked_joint]
            if not point_usable((*point, seed[2]), detections[frame], width, height):
                path_valid = False
                continue
            if (accepted[frame, joint]
                    and np.linalg.norm(poses[frame, joint, :2]-point)
                    <= POLICY["neuralDisagreementFractionOfBoxDiagonal"]*box_diagonal(detections[frame])):
                path_valid = True  # A fresh agreeing neural observation permits re-acquisition.
                continue
            if not path_valid:
                continue
            if frame > anchor:
                previous = tracks[frame-1, tracked_joint]
                if (not visible[frame-1, tracked_joint] or not np.isfinite(previous).all()
                        or np.linalg.norm(point-previous) > POLICY["maxStepFractionOfBoxDiagonal"]*box_diagonal(detections[frame])):
                    path_valid = False
                    continue
                # The exported predecessor can be a neural measurement rather
                # than the tracker's previous proposal. Bound the actual drawn
                # transition as well as the internal neural trajectory.
                drawn = selected[frame-1, joint]
                if ((accepted[frame-1, joint] or recovered[frame-1, joint])
                        and point_usable(drawn, detections[frame-1], width, height)
                        and np.linalg.norm(point-drawn[:2])
                        > POLICY["maxStepFractionOfBoxDiagonal"]*box_diagonal(detections[frame])):
                    path_valid = False
                    continue
            selected[frame, joint] = (*point, seed[2])
            recovered[frame, joint] = True
    return selected, recovered, {**POLICY, "estimatedPointCount": int(recovered.sum()),
                                 "replacedNeuralPointCount": int((recovered & accepted).sum()),
                                 "perKeypoint": {key: int(recovered[:, j].sum()) for j, key in enumerate(keypoints)}}
