"""Lazy CPU-only sessions. No PyTorch dependency in the installed application."""
import json
from pathlib import Path
import numpy as np
from model_delivery import verified
from .contracts import FEATURES, vector, validate_decoder
from .model_registry import load_manifest
from .normalization import validate
from .temporal_windows import windows


class Inference:
    def __init__(self, directory, threads=2):
        import onnxruntime as ort
        self.directory = Path(directory)
        self.manifest = load_manifest(self.directory/"manifest.json")
        for name, spec in self.manifest["files"].items():
            if not verified(self.directory/name, spec["sizeBytes"], spec["sha256"]):
                raise ValueError(f"Modelo corrompido ou ausente: {name}")
        if ort.__version__ != self.manifest["runtimeVersion"]:
            raise ValueError("Runtime version differs from the model contract")
        self.normalization = validate(json.loads((self.directory/"normalization.json").read_text()))
        self.decoder = validate_decoder(json.loads((self.directory/"decoder_config.json").read_text()))
        schema = json.loads((self.directory/"feature_schema.json").read_text())
        if schema.get("features") != list(FEATURES):
            raise ValueError("Feature schema mismatch")
        options = ort.SessionOptions()
        options.intra_op_num_threads, options.inter_op_num_threads = threads, 1
        self.encoder = ort.InferenceSession(str(self.directory/"visual_encoder.onnx"), options, providers=["CPUExecutionProvider"]) if self.manifest["architecture"] != "random_forest" else None
        self.classifier = ort.InferenceSession(str(self.directory/"temporal_classifier.onnx"), options, providers=["CPUExecutionProvider"])

    def encode(self, crops):
        if self.encoder is None:
            return np.zeros((len(crops), 0), np.float32)
        array = np.asarray(crops, np.float32).transpose(0, 3, 1, 2)/255.
        array = (array-np.array([.485, .456, .406], np.float32)[None, :, None, None])/np.array([.229, .224, .225], np.float32)[None, :, None, None]
        output = self.encoder.run(None, {self.encoder.get_inputs()[0].name: array})[0]
        if output.shape != (len(crops), 128) or not np.isfinite(output).all():
            raise ValueError("Invalid visual embeddings")
        return output

    def classify(self, features, embeddings, observed, cancelled=lambda: False):
        geometry = np.asarray([vector(row["values"], self.normalization) for row in features], np.float32)
        architecture = self.manifest["architecture"]
        matrix = geometry if architecture == "random_forest" else np.concatenate((embeddings, geometry), 1) if architecture == "hybrid_tcn" else embeddings
        output = np.zeros((len(matrix), 2), np.float32)
        batches = ((i, matrix[i:i+32]) for i in range(0, len(matrix), 32)) if architecture in {"random_forest", "visual"} else windows(matrix, observed)
        for start, batch in batches:
            if cancelled():
                raise InterruptedError("Behavior inference cancelled")
            result = self.classifier.run(None, {self.classifier.get_inputs()[0].name: batch})[0]
            if result.shape != (len(batch), 2) or not np.isfinite(result).all() or np.any((result < -1e-5) | (result > 1+1e-5)):
                raise ValueError("Classifier must output [rearing, supported_given_rearing] scores")
            output[start:start+len(batch)] = np.clip(result, 0., 1.)
        return output
