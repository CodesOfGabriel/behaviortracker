import importlib
import importlib.metadata
import inspect
import json


def probe_environment():
    try:
        version = importlib.metadata.version("deeplabcut")
        if version.split(".")[0] != "3":
            raise RuntimeError("Esta análise requer DeepLabCut 3.x com SuperAnimal PyTorch")
        for module in ("numpy", "pandas", "cv2", "tables", "torchvision"):
            importlib.import_module(module)
        inference = importlib.import_module("deeplabcut.modelzoo.video_inference")
        function = inference.video_inference_superanimal
        required = {"videos", "superanimal_name", "model_name", "detector_name", "video_adapt", "cropping"}
        if not required.issubset(inspect.signature(function).parameters):
            raise RuntimeError("A API SuperAnimal instalada não é compatível com esta análise")
        torch = importlib.import_module("torch")
        if not torch.cuda.is_available():
            return {"ready": False, "installNeeded": False,
                    "reason": "O PyTorch não consegue acessar CUDA neste runtime. Selecione um runtime GPU compatível."}
        return {"ready": True, "installNeeded": False, "version": version,
                "torch": torch.__version__, "cuda": torch.version.cuda}
    except Exception as error:
        return {"ready": False, "installNeeded": True,
                "reason": f"{type(error).__name__}: {error}"[:400]}


if __name__ == "__main__":
    print("BEHAVETRACKER_ENVIRONMENT=" + json.dumps(probe_environment()))
