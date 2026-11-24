"""RAM Color v2, port of the supplied CPU baseline. No anatomical pose.

HSV/Lab thresholds belong to the session. Ambiguous candidates remain reviewable
and never update the temporal reference. No predicted point becomes an observation.
"""
import math

VERSION = 'ram-color-geometry-2'
DEFAULTS = dict(valueMin=80, saturationMin=25, labBMin=135, minAreaPx=280,
                maxAreaPx=72000, minDensity=.12, maxSpeedFraction=.21,
                reacquireSec=.5, ambiguityMargin=.4)


class RamColorSegmenter:
    def __init__(self, config, spatial):
        self.spatial = spatial
        self.cv, self.np = spatial.cv, spatial.np
        self.scale, self.size = spatial.scale, spatial.size
        self.params = {**DEFAULTS, **config.get('ramColor', {})}
        self.last = None
        self.last_time = None
        self.foreground = None
        self.diagonal = math.hypot(config['width'], config['height'])

    def process(self, frame, timestamp, guide_box=None):
        cv, np, p = self.cv, self.np, self.params
        view = cv.resize(frame, self.size, interpolation=cv.INTER_AREA)
        hsv, lab = cv.cvtColor(view, cv.COLOR_BGR2HSV), cv.cvtColor(view, cv.COLOR_BGR2Lab)
        mask = ((hsv[:, :, 2] > p['valueMin']) & (hsv[:, :, 1] > p['saturationMin'])
                & (lab[:, :, 2] > p['labBMin']) & (self.spatial.roi > 0)).astype(np.uint8)*255
        mask = cv.morphologyEx(mask, cv.MORPH_OPEN, np.ones((3, 3), np.uint8))
        mask = cv.morphologyEx(mask, cv.MORPH_CLOSE, np.ones((5, 5), np.uint8))
        # Morphology may expand across the boundary; enforce the exact spatial mask again.
        self.foreground = cv.bitwise_and(mask, self.spatial.roi)
        contours, _ = cv.findContours(self.foreground, cv.RETR_EXTERNAL, cv.CHAIN_APPROX_SIMPLE)
        candidates = []
        fx, fy = frame.shape[1]/self.size[0], frame.shape[0]/self.size[1]
        for contour in contours:
            x, y, w, h = cv.boundingRect(contour)
            area = cv.contourArea(contour)*fx*fy
            density = area/max(w*h*fx*fy, 1)
            center = ((x+w/2)*fx, (y+h/2)*fy)
            if not (p['minAreaPx'] <= area <= p['maxAreaPx'] and w >= 7 and h >= 6 and density >= p['minDensity']): continue
            if cv.pointPolygonTest(self.spatial.enclosure, center, False) < 0: continue
            component = np.zeros(self.foreground.shape, np.uint8)
            cv.drawContours(component, [contour], -1, 255, -1)
            appearance = cv.mean(lab, mask=component)[:3]
            angle = math.radians(cv.minAreaRect(contour)[2])
            candidates.append(dict(center=center, area=area, density=density,
                appearance=appearance, angle=angle, score=math.log1p(area/(fx*fy))+1.5*density,
                bbox=dict(x=x*fx, y=y*fy, width=w*fx, height=h*fy),
                contour=[dict(x=float(q[0][0]*fx), y=float(q[0][1]*fy)) for q in cv.approxPolyDP(contour, 2, True)]))
        prior = self.last if self.last_time is not None and timestamp-self.last_time <= p['reacquireSec'] else None
        def rank(c):
            if prior is None: return c['score']
            distance = math.dist(c['center'], prior['center'])
            area_cost = abs(math.log(max(c['area']/prior['area'], .01)))
            color_cost = math.dist(c['appearance'], prior['appearance'])/40
            orientation_cost = abs(math.sin(c['angle']-prior['angle']))*.15
            return c['score']-.035*distance-area_cost-color_cost-orientation_cost
        candidates.sort(key=rank, reverse=True)
        base = dict(source='segmented', algorithmVersion=VERSION, fullAnimalBbox=None, pose=None,
                    prediction=None, uncertaintyMethod='heuristic_not_calibrated', candidateCount=len(candidates), referenceApproved=False)
        if not candidates:
            return {**base, 'xPx': None, 'yPx': None, 'bbox': None, 'bodyBbox': None,
                    'status': 'missing', 'observationState': 'missing', 'reason': 'no_color_candidate', 'uncertaintyPx': None}
        chosen = candidates[0]
        reason = 'observed'
        jump = math.dist(chosen['center'], prior['center']) if prior else None
        if len(candidates) > 1 and rank(chosen)-rank(candidates[1]) < p['ambiguityMargin']:
            reason = 'ambiguous_candidates'
        elif prior and jump > self.diagonal*p['maxSpeedFraction']*max(timestamp-self.last_time, 1/240):
            reason = 'temporal_discontinuity'
        elif prior and not .5 <= chosen['area']/prior['area'] <= 2:
            reason = 'area_changed_or_occluded'
        elif prior and math.dist(chosen['appearance'], prior['appearance']) > 45:
            reason = 'appearance_or_illumination_changed'
        elif self.last is not None and prior is None:
            reason = 'reacquired_requires_review'
        observed = reason == 'observed'
        # A reacquired candidate seeds the next comparison but remains uncertain itself.
        if observed or reason == 'reacquired_requires_review':
            self.last, self.last_time = chosen, timestamp
        return {**base, 'xPx': chosen['center'][0], 'yPx': chosen['center'][1],
                'bbox': chosen['bbox'], 'bodyBbox': chosen['bbox'], 'contour': chosen['contour'],
                'bodyCenter': dict(x=chosen['center'][0], y=chosen['center'][1]),
                'centerDefinition': 'segmented_body_bbox_center',
                'status': 'valid' if observed else 'low_confidence',
                'observationState': 'observed' if observed else 'uncertain', 'reason': reason,
                'uncertaintyPx': max(fx, fy) if observed else max(fx, fy, jump or 0),
                'candidateScore': rank(chosen), 'shapeDensity': chosen['density']}
