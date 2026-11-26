"""Bounded image tracking, seeded by neural observations, never measurements.

The two passes use actual video images. Hidden/outside/discontinuous tracks
are rejected; absence of an anatomical seed is never replaced by a box centre.
"""
import math

import cv2
import numpy as np

from hybrid.pose_refinement import box_diagonal, point_usable
from hybrid.temporal_estimates import apply_estimates, POLICY
from hybrid.temporal_image_support import flow_support, POLICY as IMAGE_SUPPORT_POLICY

WINDOW = 64
OVERLAP = 16
REVERSE_BLOCK = 48
MIN_DISAGREEMENT_VOTES = 3


def frame_windows(frames, window=WINDOW, overlap=OVERLAP):
    if not 0 <= overlap < window:
        raise ValueError("Sobreposição temporal inválida")
    buffer, offset, new = [], 0, 0
    for frame in frames:
        buffer.append(frame)
        new += 1
        if len(buffer) == window:
            yield offset, buffer
            offset += window-overlap
            buffer = buffer[-overlap:] if overlap else []
            new = 0
    if new:
        yield offset, buffer


def image_frames(video, count, reverse, transform, capture_factory=None):
    capture = (capture_factory or cv2.VideoCapture)(str(video))
    try:
        if not capture.isOpened():
            raise RuntimeError("Não foi possível abrir o vídeo para estimativas temporais")
        if not reverse:
            for _ in range(count):
                ok, frame = capture.read()
                if not ok:
                    raise RuntimeError("Vídeo terminou antes das poses; alinhamento temporal inválido")
                yield transform(frame)
        else:
            for end in range(count, 0, -REVERSE_BLOCK):
                start = max(0, end-REVERSE_BLOCK)
                if not capture.set(cv2.CAP_PROP_POS_FRAMES, start) or abs(capture.get(cv2.CAP_PROP_POS_FRAMES)-start) > .5:
                    raise RuntimeError("Busca reversa não confirmou o quadro solicitado")
                block = []
                for _ in range(start, end):
                    ok, frame = capture.read()
                    if not ok:
                        raise RuntimeError("Vídeo terminou durante leitura temporal reversa")
                    # Transform before buffering: full-resolution video is never held in RAM.
                    block.append(transform(frame))
                yield from reversed(block)
    finally:
        capture.release()


def recover_sequence(poses, accepted, detections, keypoints, width, height,
                     frames_factory, infer_window, progress=None):
    """Framework-independent control flow, shared by CPU audits and the worker.

    infer_window receives bounded preprocessed frames and [t,x,y] image queries;
    it returns exactly one track/visibility row for every real input frame.
    Each carried seed retains the original observation's likelihood and lineage.
    """
    poses = np.asarray(poses, float)
    accepted = np.asarray(accepted, bool)
    count, joints = len(detections), len(keypoints)
    if poses.shape != (count, joints, 3) or accepted.shape != (count, joints):
        raise ValueError("Pose e detecções incompatíveis na recuperação temporal")
    selected = poses.copy()
    recovered = np.zeros((count, joints), bool)
    image_confirmed = np.zeros((count, joints), bool)
    image_support = np.full((count, joints), "", dtype="<U24")
    proposal_before = np.full((count, joints, 2), np.nan)
    proposal_after = np.full((count, joints, 2), np.nan)
    anchors = np.full((count, joints), -1, int)
    calls = 0
    rejected_tracks = 0
    for reverse in (False, True):
        order = np.arange(count)[::-1] if reverse else np.arange(count)
        # Carry only this pass's validated image trajectories through overlap.
        carry, carry_anchor = {}, {}
        seen = 0
        for offset, frames in frame_windows(frames_factory(reverse)):
            length = len(frames)
            if offset+length > count:
                raise RuntimeError("Vídeo possui mais quadros que as poses")
            indices = order[offset:offset+length]
            local_poses = poses[indices].copy()
            local_accepted = accepted[indices].copy()
            if reverse:
                # A neural point already contradicted by a validated forward
                # trajectory cannot seed a competing backwards trajectory.
                local_accepted &= ~recovered[indices]
            boxes = [detections[int(i)] for i in indices]
            keys, times, seeds, lineages = [], [], [], []
            for joint, key in enumerate(keypoints):
                carried = carry.get(joint)
                confirmed_times = [t for t in range(length) if reverse and local_accepted[t, joint]
                                   and image_confirmed[indices[t], joint]
                                   and point_usable(local_poses[t, joint], boxes[t], width, height)]
                if confirmed_times:
                    # A later label can flip to another anatomical feature.
                    # Prefer a seed already corroborated in forward images.
                    time = confirmed_times[0]
                    seed, lineage = local_poses[time, joint].copy(), int(indices[time])
                elif carried is not None and point_usable(carried, boxes[0], width, height):
                    time, seed, lineage = 0, carried, carry_anchor[joint]
                else:
                    valid = [t for t in range(length) if local_accepted[t, joint]
                             and point_usable(local_poses[t, joint], boxes[t], width, height)]
                    if not valid:
                        continue
                    time = valid[0]
                    seed, lineage = local_poses[time, joint].copy(), int(indices[time])
                keys.append(key)
                times.append(time)
                seeds.append(seed)
                lineages.append(lineage)
            carry, carry_anchor = {}, {}
            if keys:
                queries = np.column_stack([times, np.asarray(seeds)[:, :2]])
                prediction = infer_window(frames, queries)
                tracks, tracker_visible = np.asarray(prediction[0], float), np.asarray(prediction[1], bool)
                flow_visible = np.asarray(prediction[2], bool) if len(prediction) == 3 else np.zeros(tracker_visible.shape, bool)
                if flow_visible.shape != tracker_visible.shape:
                    raise ValueError("Apoio das imagens não corresponde à trajetória temporal")
                visible = tracker_visible | flow_visible
                calls += 1
                local, estimates, _ = apply_estimates(
                    local_poses, local_accepted, boxes, keypoints, tracks, visible,
                    keys, times, seeds, width, height)
                # Reprocess the forward overlap along the new validated image
                # trajectory, whose seed came from that same overlap. Keeping
                # the old overlap and appending the new tail can create a jump
                # even when both network trajectories are continuous.
                # Reverse estimates still cannot overwrite forward estimates.
                for q, key in enumerate(keys):
                    joint = keypoints.index(key)
                    commit_path_valid = True
                    seed_time, seed = times[q], seeds[q]
                    named_times = np.flatnonzero(local_accepted[:, joint] & visible[:, q]
                                                 & (np.arange(length) >= seed_time))
                    named_agreements = sum(np.isfinite(tracks[t, q]).all()
                        and np.linalg.norm(tracks[t, q]-poses[indices[t], joint, :2])
                        <= POLICY["neuralDisagreementFractionOfBoxDiagonal"]*box_diagonal(boxes[t])
                        for t in named_times)
                    disagreements = len(named_times)-named_agreements
                    if disagreements >= MIN_DISAGREEMENT_VOTES and disagreements > named_agreements:
                        # The point tracker follows image features, not anatomical
                        # labels. Do not let a smooth wrong-feature trajectory
                        # replace a sustained sequence of named pose observations.
                        rejected_tracks += 1
                        continue
                    # Agreement at the seed alone cannot establish anatomical
                    # identity throughout a trajectory. A reverse track can
                    # follow another feature smoothly and collide with an
                    # earlier, already corroborated measurement. Reject that
                    # hypothesis as a whole, rather than filling the gap up to
                    # a sudden jump at its other end.
                    confirmed_times = np.flatnonzero(image_confirmed[indices, joint] & visible[:, q]
                                                     & (np.arange(length) >= seed_time))
                    if any(not np.isfinite(tracks[t, q]).all()
                           or np.linalg.norm(tracks[t, q]-poses[indices[t], joint, :2])
                           > POLICY["neuralDisagreementFractionOfBoxDiagonal"]*box_diagonal(boxes[t])
                           for t in confirmed_times):
                        rejected_tracks += 1
                        continue
                    seed_valid = (point_usable(seed, boxes[seed_time], width, height)
                                  and np.isfinite(tracks[seed_time, q]).all()
                                  and np.linalg.norm(tracks[seed_time, q]-seed[:2]) <= 1.)
                    for t, index in enumerate(indices):
                        agrees = (seed_valid and t >= seed_time and local_accepted[t, joint] and visible[t, q]
                                  and point_usable((*tracks[t, q], seed[2]), boxes[t], width, height)
                                  and np.linalg.norm(local_poses[t, joint, :2]-tracks[t, q])
                                  <= POLICY["neuralDisagreementFractionOfBoxDiagonal"]*box_diagonal(boxes[t]))
                        if agrees:
                            commit_path_valid = True
                        if not reverse and agrees:
                            selected[index, joint] = local_poses[t, joint]
                            recovered[index, joint] = False
                            image_confirmed[index, joint] = True
                            image_support[index, joint] = "confirmed_neural"
                            anchors[index, joint] = -1
                            commit_path_valid = True
                        elif (estimates[t, joint] and not image_confirmed[index, joint]
                              and (not reverse or not recovered[index, joint])):
                            if not commit_path_valid:
                                continue
                            previous = int(index)+(1 if reverse else -1)
                            if (0 <= previous < count and (accepted[previous, joint] or recovered[previous, joint])
                                    and point_usable(selected[previous, joint], detections[previous], width, height)
                                    and np.linalg.norm(local[t, joint, :2]-selected[previous, joint, :2])
                                    > POLICY["maxStepFractionOfBoxDiagonal"]*box_diagonal(boxes[t])):
                                commit_path_valid = False
                                continue
                            selected[index, joint] = local[t, joint]
                            recovered[index, joint] = True
                            anchors[index, joint] = lineages[q]
                            prior = t+(1 if reverse else -1)
                            after = t+(-1 if reverse else 1)
                            if 0 <= prior < length:
                                proposal_before[index, joint] = tracks[prior, q]
                            if 0 <= after < length:
                                proposal_after[index, joint] = tracks[after, q]
                            image_support[index, joint] = ("tracker_visibility" if tracker_visible[t, q]
                                else "validated_anchor" if t == seed_time else "bidirectional_flow")
                    next_time = WINDOW-OVERLAP
                    if next_time < length:
                        t = next_time
                        if image_confirmed[indices[t], joint]:
                            carry[joint] = selected[indices[t], joint].copy()
                            carry_anchor[joint] = int(indices[t])
                            continue
                        # A neural observation is a carry seed only when the image
                        # track agrees; otherwise propagate the explicit estimate.
                        if (recovered[indices[t], joint] or local_accepted[t, joint]) and visible[t, q]:
                            point = (*tracks[t, q], seeds[q][2])
                            if (point_usable(point, boxes[t], width, height)
                                    and point_usable(selected[indices[t], joint], boxes[t], width, height)
                                    and np.linalg.norm(selected[indices[t], joint, :2]-tracks[t, q])
                                    <= POLICY["neuralDisagreementFractionOfBoxDiagonal"]*box_diagonal(boxes[t])):
                                carry[joint] = selected[indices[t], joint].copy()
                                carry_anchor[joint] = int(anchors[indices[t], joint]) if recovered[indices[t], joint] else int(indices[t])
            seen = offset+length
            if progress:
                progress("reverse" if reverse else "forward", seen, count)
        if seen != count:
            raise RuntimeError("Número de quadros temporais diverge das poses")
    # Audit the final, chronological composition, including the earlier end of
    # a reverse-filled gap. Internal model continuity cannot establish that a
    # hypothesis connects to the named measurements actually shown at its ends.
    rejected_disconnected = 0
    for joint in range(joints):
        edges = np.diff(np.r_[False, recovered[:, joint], False].astype(np.int8))
        for begin, end in zip(np.flatnonzero(edges == 1), np.flatnonzero(edges == -1)):
            disconnected = False
            for frame, neighbour, proposal in ((begin, begin-1, proposal_before[begin, joint]),
                                                (end-1, end, proposal_after[end-1, joint])):
                if (0 <= neighbour < count and accepted[neighbour, joint]
                        and point_usable(selected[neighbour, joint], detections[neighbour], width, height)):
                    scale = box_diagonal(detections[frame])
                    if (np.linalg.norm(selected[frame, joint, :2]-selected[neighbour, joint, :2])
                            > POLICY["maxStepFractionOfBoxDiagonal"]*scale
                            or np.isfinite(proposal).all() and np.linalg.norm(proposal-selected[neighbour, joint, :2])
                            > POLICY["neuralDisagreementFractionOfBoxDiagonal"]*scale):
                        disconnected = True
            for frame in range(begin+1, end):
                scale = box_diagonal(detections[frame])
                if (np.linalg.norm(selected[frame, joint, :2]-selected[frame-1, joint, :2])
                        > POLICY["maxStepFractionOfBoxDiagonal"]*scale
                        or np.isfinite(proposal_before[frame, joint]).all()
                        and np.linalg.norm(proposal_before[frame, joint]-selected[frame-1, joint, :2])
                        > POLICY["neuralDisagreementFractionOfBoxDiagonal"]*scale):
                    disconnected = True
            if disconnected:
                rejected_disconnected += int(end-begin)
                selected[begin:end, joint] = poses[begin:end, joint]
                recovered[begin:end, joint] = False
                anchors[begin:end, joint] = -1
                image_support[begin:end, joint] = "rejected_disconnected"
    return selected, recovered, {**POLICY, "version": "temporal-window-image-estimate-2",
        "windowFrames": WINDOW, "overlapFrames": OVERLAP, "directions": ["forward", "reverse"],
        "forwardOverlap": "validated_continuation_replaces_old_estimates",
        "reverseSeedPreference": "forward_image_confirmed_measurement",
        "rejectsTracksConflictingWithConfirmedMeasurements": True,
        "neuralConsistency": {"minimumDisagreementVotes": MIN_DISAGREEMENT_VOTES,
                              "rejectWhen": "disagreements_exceed_agreements"},
        "rejectedInconsistentTrackCount": rejected_tracks,
        "rejectedDisconnectedEstimateCount": rejected_disconnected,
        "forwardImageConfirmedNeuralPointCount": int(image_confirmed.sum()),
        "requiresTrackerVisibility": False,
        "requiresImageSupport": "tracker_visibility_or_validated_anchor_or_bidirectional_flow",
        "imageSupport": IMAGE_SUPPORT_POLICY,
        "flowSupportedEstimateCount": int(((image_support == "bidirectional_flow") & recovered).sum()),
        # Reader/window references plus the contiguous tensor sent to the model.
        "maxBufferedModelFrames": WINDOW*2+REVERSE_BLOCK,
        "modelFrameSize": [384, 512], "inferenceWindowCount": calls,
        "estimatedPointCount": int(recovered.sum()),
        "replacedNeuralPointCount": int((recovered & accepted).sum()),
        "perKeypoint": {key: int(recovered[:, j].sum()) for j, key in enumerate(keypoints)}}, anchors, image_support


class OnlineWindows:
    """Keep the predictor's online state bounded by resetting every window."""
    def __init__(self, tracker, device, crop):
        self.tracker, self.device, self.crop = tracker, device, crop

    def transform(self, frame):
        import torch
        x, y, w, h = self.crop
        if frame.shape[1] < x+w or frame.shape[0] < y+h:
            raise RuntimeError("Resolução do vídeo mudou durante estimativa temporal")
        rgb = cv2.cvtColor(frame[y:y+h, x:x+w], cv2.COLOR_BGR2RGB)
        value = torch.from_numpy(rgb).permute(2, 0, 1).float()[None]
        return torch.nn.functional.interpolate(value, (384, 512), mode="bilinear", align_corners=True)[0]

    def predict(self, frames, queries):
        import torch
        x, y, w, h = self.crop
        query = np.asarray(queries, float).copy()
        query[:, 1:] = (query[:, 1:]-[x, y])*[511/(w-1), 383/(h-1)]
        count, step = len(frames), self.tracker.step
        padded = max(step*2, math.ceil(count/step)*step)
        video = torch.stack(frames+[frames[-1]]*(padded-count))[None].to(self.device)
        query = torch.as_tensor(query, dtype=torch.float32, device=self.device)[None]
        with torch.inference_mode():
            self.tracker(video[:, :step*2], is_first_step=True, queries=query)
            for offset in range(0, padded-step, step):
                tracks, visible = self.tracker(video[:, offset:offset+step*2])
        tracks = tracks[0, :count].cpu().numpy()
        visible = visible[0, :count].cpu().numpy().astype(bool)
        if tracks.shape != (count, len(queries), 2) or visible.shape != (count, len(queries)):
            raise RuntimeError("Modelo temporal retornou quadros incompatíveis")
        return tracks*np.array([(w-1)/511, (h-1)/383])+[x, y], visible

    def __call__(self, frames, queries):
        tracks, visible = self.predict(frames, queries)
        x, y, w, h = self.crop
        scale = np.asarray([511/(w-1), 383/(h-1)])
        model_tracks = (tracks-[x, y])*scale
        model_queries = np.asarray(queries, float).copy()
        model_queries[:, 1:] = (model_queries[:, 1:]-[x, y])*scale
        images = [cv2.cvtColor(np.rint(frame.permute(1, 2, 0).numpy()).clip(0, 255).astype(np.uint8), cv2.COLOR_RGB2GRAY)
                  for frame in frames]
        return tracks, visible, flow_support(images, model_tracks, visible, model_queries)


def recover_video(video, poses, accepted, detections, keypoints, models, device, arena=None, progress=None):
    from hybrid.temporal_assets import create_tracker
    capture = cv2.VideoCapture(str(video))
    width, height = int(capture.get(cv2.CAP_PROP_FRAME_WIDTH)), int(capture.get(cv2.CAP_PROP_FRAME_HEIGHT))
    capture.release()
    if min(width, height) < 2:
        raise RuntimeError("Resolução inválida para estimativa temporal")
    crop = (0, 0, width, height)
    corners = (arena or {}).get("rimCornersPx") or (arena or {}).get("cornersPx")
    if corners:
        points = np.asarray([[p["x"], p["y"]] for p in corners], float)
        if not np.isfinite(points).all():
            raise ValueError("Arena temporal inválida")
        left, top = np.maximum(0, np.floor(points.min(axis=0))).astype(int)
        right, bottom = np.minimum([width, height], np.ceil(points.max(axis=0))+1).astype(int)
        if right-left < 2 or bottom-top < 2:
            raise ValueError("Arena temporal fora do vídeo")
        crop = (int(left), int(top), int(right-left), int(bottom-top))
    tracker, metadata = create_tracker(models, str(device))
    inference = OnlineWindows(tracker, device, crop)
    result, recovered, policy, anchors, evidence = recover_sequence(
        poses, accepted, detections, keypoints, width, height,
        lambda reverse: image_frames(video, len(detections), reverse, inference.transform), inference, progress)
    policy.update({"model": metadata, "cropPx": crop})
    policy["maxBufferedGrayFrames"] = WINDOW
    return result, recovered, policy, anchors, evidence
