"""Fixed session scale. A changing bbox never fills the CNN input by itself."""
import cv2 as cv
import numpy as np


class CropExtractor:
    def __init__(self, reference_length, input_size=128, reference_scale=1.6, margin=.30):
        if not np.isfinite(reference_length) or reference_length <= 0:
            raise ValueError("A positive session reference length is required")
        self.side = max(8., float(reference_length)*reference_scale*(1+margin))
        self.input_size = input_size
        self.last = None

    def extract(self, frame, sample, observation):
        time = sample["timestampSec"]
        box = sample.get("bbox")
        fallback = False
        if observation == "OBSERVED" and box:
            self.last = (dict(box), time)
        if observation != "OBSERVED" and self.last and 0 <= time-self.last[1] <= .2:
            box, fallback = self.last[0], True
        if not box:
            return None, {"recoveredCrop": False, "cropUsable": False}
        side = self.side*(1.25 if fallback else 1.)
        cx, cy = box["x"]+box["width"]/2, box["y"]+box["height"]/2
        x, y = cx-side/2, cy-side/2
        # Constant scale affine sampling also handles image-edge padding without distortion.
        transform = np.array([[side/self.input_size, 0, x], [0, side/self.input_size, y]], np.float32)
        crop = cv.warpAffine(frame, transform, (self.input_size, self.input_size),
                            flags=cv.INTER_LINEAR | cv.WARP_INVERSE_MAP, borderMode=cv.BORDER_CONSTANT)
        clipped = x < 0 or y < 0 or x+side > frame.shape[1] or y+side > frame.shape[0]
        contained = box["width"] <= side and box["height"] <= side
        body_inside_image = (box["x"] >= 1 and box["y"] >= 1
                             and box["x"]+box["width"] <= frame.shape[1]-1
                             and box["y"]+box["height"] <= frame.shape[0]-1)
        visible_width = max(0., min(x+side, frame.shape[1])-max(0., x))
        visible_height = max(0., min(y+side, frame.shape[0])-max(0., y))
        padding_fraction = 1-visible_width*visible_height/(side*side)
        return cv.cvtColor(crop, cv.COLOR_BGR2RGB), dict(classificationCrop={"x": x, "y": y, "width": side, "height": side},
                    recoveredCrop=fallback, cropPadded=clipped, paddingFraction=padding_fraction,
                    cropUsable=not fallback and body_inside_image and contained)
