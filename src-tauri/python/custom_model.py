"""Modelo experimental de caixa + pontos. ML somente no runtime remoto.

Arquitetura TorchVision; os pesos humanos pré-treinados inicializam as features,
não constituem um detector de ratos pronto. Cabeças são ajustadas pelos rótulos humanos.
"""
import base64
import hashlib
import json
import math
from pathlib import Path
import random
import time

LANDMARKS = ["nose", "left_ear", "right_ear", "neck", "mid_back", "hip", "tail_base", "left_forepaw", "right_forepaw"]
VERSION = "behavetracker-keypoint-rcnn-v1"


def file_sha256(path):
    digest=hashlib.sha256()
    with open(path,"rb") as handle:
        for block in iter(lambda:handle.read(1024*1024),b""):
            digest.update(block)
    return digest.hexdigest()


def load_dataset(path, directory):
    """Valida snapshot sem executar código contido no pacote."""
    root = Path(directory)
    root.mkdir(parents=True, exist_ok=True)
    records, videos, animals = [], {}, {}
    with open(path, encoding="utf-8") as handle:
        header = json.loads(handle.readline())
        if header.get("schemaVersion") != 1 or header.get("landmarks") != LANDMARKS:
            raise ValueError("Esquema de dataset incompatível")
        total_bytes = 0
        seen = set()
        for line in handle:
            if len(line) > 30 * 1024 * 1024:
                raise ValueError("Imagem excede o limite")
            value = json.loads(line)
            annotation = value["annotation"]
            if annotation.get("reviewed") is not True:
                raise ValueError("Exemplo sem revisão humana")
            identity = (annotation["videoSha256"], annotation["frameIndex"])
            if identity in seen:
                raise ValueError("Mesmo frame incluído mais de uma vez")
            seen.add(identity)
            split = annotation["split"]
            if split not in ("train", "validation"):
                raise ValueError("Grupo inválido")
            for mapping, key in ((videos, annotation["videoSha256"]), (animals, annotation["subjectId"])):
                if key in mapping and mapping[key] != split:
                    raise ValueError("Vazamento entre treino e validação por vídeo/animal")
                mapping[key] = split
            width, height = annotation["width"], annotation["height"]
            box = annotation["bbox"]
            if not box or not all(math.isfinite(box[k]) for k in ("x", "y", "width", "height")) or not (
                    0 <= box["x"] < box["x"]+box["width"] <= width and 0 <= box["y"] < box["y"]+box["height"] <= height):
                raise ValueError("Caixa inválida")
            visible = 0
            for name in LANDMARKS:
                point = annotation["keypoints"][name]
                if point["state"] == "visible":
                    x, y = point["x"], point["y"]
                    if not all(isinstance(v, (int, float)) and math.isfinite(v) for v in (x, y)) or not (box["x"] <= x <= box["x"]+box["width"] and box["y"] <= y <= box["y"]+box["height"]):
                        raise ValueError("Ponto visível fora da caixa")
                    visible += 1
                elif point["state"] != "occluded" or point.get("x") is not None or point.get("y") is not None:
                    raise ValueError("Parte não revisada ou coordenada inventada")
            if not visible:
                raise ValueError("Exemplo sem pontos visíveis")
            image = base64.b64decode(value["imageBase64"], validate=True)
            total_bytes += len(image)
            if total_bytes > 200 * 1024 * 1024 or not image.startswith(b"\x89PNG\r\n\x1a\n") or hashlib.sha256(image).hexdigest() != annotation["imageSha256"]:
                raise ValueError("Integridade ou limite de imagens inválido")
            destination = root / f"{len(records):06d}.png"
            destination.write_bytes(image)
            records.append({**annotation, "imagePath": str(destination)})
            if len(records) > 500:
                raise ValueError("Dataset excede 500 frames")
    if len(records) != header.get("frameCount") or sum(r["split"] == "train" for r in records) < 2:
        raise ValueError("Quantidade de exemplos incompatível ou treino insuficiente")
    return header, records


def target_values(record):
    box = record["bbox"]
    points = [[p["x"], p["y"], 2] if p["state"] == "visible" else [0, 0, 0]
              for p in (record["keypoints"][name] for name in LANDMARKS)]
    return [[box["x"], box["y"], box["x"] + box["width"], box["y"] + box["height"]]], [points]


def build_model(pretrained):
    from torchvision.models.detection import keypointrcnn_resnet50_fpn, KeypointRCNN_ResNet50_FPN_Weights
    from torchvision.models.detection.faster_rcnn import FastRCNNPredictor
    from torchvision.models.detection.keypoint_rcnn import KeypointRCNNPredictor
    if pretrained:
        model = keypointrcnn_resnet50_fpn(weights=KeypointRCNN_ResNet50_FPN_Weights.DEFAULT,
                                         min_size=640, max_size=1024)
        model.roi_heads.box_predictor = FastRCNNPredictor(model.roi_heads.box_predictor.cls_score.in_features, 2)
        model.roi_heads.keypoint_predictor = KeypointRCNNPredictor(512, len(LANDMARKS))
    else:
        model = keypointrcnn_resnet50_fpn(weights=None, weights_backbone=None, num_classes=2,
                                         num_keypoints=len(LANDMARKS), min_size=640, max_size=1024)
    return model


def train(dataset_path, output_dir, epochs):
    import torch
    import torchvision
    from PIL import Image
    from torchvision.transforms.functional import pil_to_tensor
    if not torch.cuda.is_available():
        raise RuntimeError("Treinamento requer CUDA no Colab; nada será treinado no computador local")
    if not isinstance(epochs, int) or not 1 <= epochs <= 20:
        raise ValueError("Épocas fora do limite")
    output = Path(output_dir)
    output.mkdir(parents=True, exist_ok=True)
    header, records = load_dataset(dataset_path, output / "images")
    training = [r for r in records if r["split"] == "train"]
    validation = [r for r in records if r["split"] == "validation"]
    seed = 17
    random.seed(seed)
    torch.manual_seed(seed)
    torch.cuda.manual_seed_all(seed)
    device = torch.device("cuda:0")
    started = time.perf_counter()
    model = build_model(True).to(device)
    optimizer = torch.optim.SGD([p for p in model.parameters() if p.requires_grad], lr=.001, momentum=.9, weight_decay=.0005)

    def image_tensor(record):
        with Image.open(record["imagePath"]) as image:
            if image.size != (record["width"], record["height"]):
                raise ValueError("Resolução do exemplo difere do rótulo")
            return pil_to_tensor(image.convert("RGB")).float().div(255).to(device)

    history = []
    for epoch in range(epochs):
        model.train()
        random.shuffle(training)
        total = 0.
        for index, record in enumerate(training):
            boxes, points = target_values(record)
            target = {"boxes": torch.tensor(boxes, dtype=torch.float32, device=device),
                      "labels": torch.ones(1, dtype=torch.int64, device=device),
                      "keypoints": torch.tensor(points, dtype=torch.float32, device=device)}
            losses = model([image_tensor(record)], [target])
            loss = sum(losses.values())
            value = float(loss.detach())
            if not math.isfinite(value):
                raise RuntimeError("Loss não finita; modelo não publicado")
            optimizer.zero_grad(set_to_none=True)
            loss.backward()
            torch.nn.utils.clip_grad_norm_(model.parameters(), 10.)
            optimizer.step()
            total += value
            print(f"BEHAVETRACKER_TRAINING_PROGRESS=Época {epoch+1}/{epochs} · exemplo {index+1}/{len(training)} · loss {value:.4f}", flush=True)
        history.append({"epoch": epoch+1, "trainLoss": total/len(training)})
    model.eval()
    matched, predicted, keypoint_errors, visible_points = 0, 0, [], 0
    with torch.inference_mode():
        for record in validation:
            prediction = model([image_tensor(record)])[0]
            candidates = [i for i, score in enumerate(prediction["scores"]) if float(score) >= .5 and int(prediction["labels"][i]) == 1]
            predicted += len(candidates)
            boxes, points = target_values(record)
            visible_points += sum(p[2] > 0 for p in points[0])
            if not candidates:
                continue
            truth = torch.tensor(boxes, dtype=torch.float32, device=device)
            overlaps = torchvision.ops.box_iou(prediction["boxes"][candidates], truth)[:, 0]
            best_local = int(overlaps.argmax())
            if float(overlaps[best_local]) < .5:
                continue
            matched += 1
            best = candidates[best_local]
            diag = math.hypot(record["bbox"]["width"], record["bbox"]["height"])
            for estimate, point in zip(prediction["keypoints"][best], points[0]):
                if point[2] > 0:
                    keypoint_errors.append(math.hypot(float(estimate[0])-point[0], float(estimate[1])-point[1])/diag)
    weights = output / "model.pt"
    # Apenas tensores + metadados simples; inferência usa weights_only=True.
    torch.save({"state_dict": {key:value.detach().cpu() for key,value in model.state_dict().items()},
                "version": VERSION, "landmarks": LANDMARKS, "datasetSha256": file_sha256(dataset_path)}, weights)
    metrics = None if not validation else {"boxRecallAtIoU50": matched/len(validation),
        "boxPrecisionAtIoU50": matched/predicted if predicted else 0.,
        "poseMeanErrorOverBoxDiagonalOnMatchedDetections": sum(keypoint_errors)/len(keypoint_errors) if keypoint_errors else None,
        "evaluatedVisiblePoints": len(keypoint_errors), "totalVisiblePoints": visible_points,
        "posePointCoverage": len(keypoint_errors)/visible_points if visible_points else None,
        "confidenceThreshold": .5, "iouThreshold": .5}
    report = {"schemaVersion":1, "version":VERSION, "snapshotId":header["snapshotId"], "epochs":epochs,
              "trainingFrames":len(training), "validationFrames":len(validation), "seed":seed, "metrics":metrics,
              "history":history, "elapsedSec":time.perf_counter()-started, "torchVersion":torch.__version__,
              "torchvisionVersion":torchvision.__version__, "gpu":torch.cuda.get_device_name(0),
              "scientificallyValidated":False, "behaviorClassifierTrained":False,
              "limitations":["Modelo experimental; presença de caixa/pontos não prova acerto.",
                  "Sem validação independente não é possível medir generalização.",
                  "Erro de pose usa apenas detecções correspondidas; veja também cobertura e recall.",
                  "Este dataset contém apenas exemplos com animal; inclua avaliação de fundo/falsos positivos antes de uso científico.",
                  "Partes ocultas não recebem coordenadas de treinamento; comportamentos são apenas contexto."]}
    (output/"training_report.json").write_text(json.dumps(report,ensure_ascii=False,allow_nan=False),encoding="utf-8")
    digest = file_sha256(weights)
    (output/"model_artifact.json").write_text(json.dumps({"version":VERSION,"filename":"model.pt","sizeBytes":weights.stat().st_size,"sha256":digest}),encoding="utf-8")
    print("BEHAVETRACKER_TRAINING_DONE="+json.dumps({"trainingFrames":len(training),"validationFrames":len(validation)}),flush=True)


def load_model(path):
    import torch
    checkpoint = torch.load(path, map_location="cpu", weights_only=True)
    if checkpoint.get("version") != VERSION or checkpoint.get("landmarks") != LANDMARKS:
        raise ValueError("Checkpoint incompatível")
    model = build_model(False)
    model.load_state_dict(checkpoint["state_dict"], strict=True)
    return model.to("cuda:0").eval()


def infer(video_path, model_path, output_dir, canonical_path, arena, arena_api, selection=None):
    import csv
    import cv2
    import numpy as np
    import torch
    from torchvision.transforms.functional import to_tensor
    if not torch.cuda.is_available():
        raise RuntimeError("CUDA indisponível para o modelo personalizado")
    output=Path(output_dir)
    output.mkdir(parents=True,exist_ok=True)
    model=load_model(model_path)
    capture=cv2.VideoCapture(video_path)
    fps=float(capture.get(cv2.CAP_PROP_FPS))
    width,height=int(capture.get(cv2.CAP_PROP_FRAME_WIDTH)),int(capture.get(cv2.CAP_PROP_FRAME_HEIGHT))
    if not math.isfinite(fps) or fps<=0:
        raise ValueError("FPS inválido; timestamps não serão inventados")
    geometry=arena_api["prepare_geometry"](arena,width,height)
    # O dataset e as previsões usam a imagem inteira, não o crop SuperAnimal.
    geometry["cropping"]=None
    rows=[]
    frames=[]
    index=0
    started=time.perf_counter()
    preview=output/"custom_raw.mp4"
    writer=cv2.VideoWriter(str(preview),cv2.VideoWriter_fourcc(*"mp4v"),fps,(width,height))
    preview_ok=writer.isOpened()
    try:
        with torch.inference_mode():
            while True:
                ok,image=capture.read()
                if not ok:break
                prediction=model([to_tensor(cv2.cvtColor(image,cv2.COLOR_BGR2RGB)).to("cuda:0")])[0]
                candidates=[i for i,s in enumerate(prediction["scores"]) if float(s)>=.5 and int(prediction["labels"][i])==1]
                points={name:(None,None,0.,"missing") for name in LANDMARKS}
                box_data=None
                if candidates:
                    best=max(candidates,key=lambda i:float(prediction["scores"][i]))
                    box=prediction["boxes"][best].detach().cpu().numpy()
                    box_data={"x":float(box[0]),"y":float(box[1]),"width":float(box[2]-box[0]),"height":float(box[3]-box[1]),"score":float(prediction["scores"][best])}
                    keypoints=prediction["keypoints"][best].detach().cpu().numpy()
                    # KeypointRCNN keypoints_scores são logits, não probabilidades calibradas.
                    # Não converte scores do detector em confiança anatômica.
                    for name,(x,y,_) in zip(LANDMARKS,keypoints):
                        if math.isfinite(float(x)) and math.isfinite(float(y)) and 0<=x<width and 0<=y<height:
                            points[name]=(float(x),float(y),0.,"low_confidence")
                            cv2.circle(image,(round(float(x)),round(float(y))),4,(100,240,200),-1)
                    cv2.rectangle(image,(round(float(box[0])),round(float(box[1]))),(round(float(box[2])),round(float(box[3]))),(200,150,255),2)
                center=arena_api["torso_center"]([points[name] for name in ("neck","mid_back","hip")])
                frames.append({"frameIndex":index,"timestampSec":index/fps,"state":"partial" if box_data else "detector_missing","bbox":box_data,"availablePoints":sum(p[3]!="missing" for p in points.values()),"strongPoints":0,"totalPoints":len(LANDMARKS),"canonicalCenterAvailable":center[3]!="missing","canonicalCenterStatus":center[3]})
                for name,p in [("body_center",center),*points.items()]:
                    x,y,score,status=p
                    rows.append([index,index/fps,"animal_1",name,x,y,score,status,arena_api["spatial_region"](x,y,geometry),"detected"])
                if preview_ok:writer.write(image)
                index+=1
                if selection and index>math.ceil(60*fps)+1:raise RuntimeError("Trecho personalizado excedeu 60 segundos")
                if index%24==0:print(f"BEHAVETRACKER_CUSTOM_PROGRESS={index} frames",flush=True)
    finally:
        capture.release();writer.release()
    if not index:raise RuntimeError("Vídeo sem frames")
    with open(canonical_path,"w",newline="") as handle:
        table=csv.writer(handle);table.writerow(["frame_index","timestamp_sec","animal_id","keypoint","x_px","y_px","likelihood","status","spatial_region","source"]);table.writerows(rows)
    (output/"analysis_profile.json").write_text(json.dumps({"inferenceSec":time.perf_counter()-started,"recoverySec":0.,"exportSec":0.,"model":VERSION,"confidencePolicy":"uncalibrated_predictions_require_manual_review"}))
    (output/"custom_render.json").write_text(json.dumps({"preview":str(preview),"width":width,"height":height,"frames":index,"available":preview_ok}))
    if selection:
        report={"schemaVersion":1,"version":VERSION,"selection":selection,"fps":fps,"durationSec":index/fps,"geometry":geometry,"frames":frames,
                "summary":{"frameCount":index,"states":{"detector_missing":sum(f["bbox"] is None for f in frames),"partial":sum(f["bbox"] is not None for f in frames)},"detectorCoveragePct":100*sum(f["bbox"] is not None for f in frames)/index,"centerCoveragePct":100*sum(f["canonicalCenterAvailable"] for f in frames)/index,"accuracyMeasured":False},
                "timings":{"totalSec":time.perf_counter()-started},"model":{"version":VERSION,"checkpointSha256":file_sha256(model_path)},"confidencePolicy":"uncalibrated","warning":"Modelo personalizado experimental; confiança anatômica não calibrada. Cobertura não é acurácia. Timestamps por índice/FPS."}
        (output/"diagnostic_report.json").write_text(json.dumps(report,allow_nan=False))
    Path(canonical_path+".complete").write_text("ok")


def render_custom(output_dir):
    import cv2
    import shutil
    import subprocess
    output=Path(output_dir)
    manifest={"available":False,"error":"Vídeo de prévia indisponível"}
    try:
        request=json.loads((output/"custom_render.json").read_text())
        ffmpeg=shutil.which("ffmpeg")
        if not ffmpeg or not request["available"]:raise RuntimeError("FFmpeg/encoder não disponíveis")
        destination=output/"dlc_labeled.mp4"
        subprocess.run([ffmpeg,"-v","error","-nostdin","-y","-i",request["preview"],"-an","-c:v","libx264","-crf","18","-pix_fmt","yuv420p","-movflags","+faststart",str(destination)],check=True,capture_output=True)
        capture=cv2.VideoCapture(str(destination))
        dimensions=(int(capture.get(cv2.CAP_PROP_FRAME_WIDTH)),int(capture.get(cv2.CAP_PROP_FRAME_HEIGHT)))
        frames=int(capture.get(cv2.CAP_PROP_FRAME_COUNT));capture.release()
        if dimensions!=(request["width"],request["height"]) or frames!=request["frames"]:raise RuntimeError("Frames/resolução da prévia divergiram")
        manifest={"available":True,"filename":"dlc_labeled.mp4","source":VERSION,"sizeBytes":destination.stat().st_size,"sha256":file_sha256(destination)}
    except Exception as error:
        manifest["error"]=f"{type(error).__name__}: {error}"
    (output/"video_artifact.json").write_text(json.dumps(manifest))
