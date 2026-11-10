"""Vídeo de inspeção gerado pelo DeepLabCut a partir do H5 bruto, não das correções."""
import hashlib
import json
from pathlib import Path
import shutil
import subprocess


def file_sha256(path):
    digest = hashlib.sha256()
    with path.open("rb") as handle:
        for chunk in iter(lambda: handle.read(1024 * 1024), b""):
            digest.update(chunk)
    return digest.hexdigest()


def render_labeled_video(video, h5, fps, geometry, output_dir, expected_frames):
    root = Path(output_dir)
    report = {"schemaVersion": 1, "available": False, "source": "deeplabcut_raw_h5",
              "filename": "dlc_labeled.mp4", "pcutoff": .5, "error": None}
    try:
        import cv2
        from deeplabcut.utils.make_labeled_video import create_video

        print("BEHAVETRACKER_VIDEO_PHASE=Gerando vídeo rotulado pelo DeepLabCut", flush=True)
        raw = root / "dlc_render_raw.mp4"
        bbox = tuple(geometry["cropping"] or [0, geometry["videoWidth"], 0, geometry["videoHeight"]])
        # display_cropped=False mantém a resolução original; o DLC aplica o offset do ROI.
        create_video(video, h5, pcutoff=.5, fps=fps, bbox=bbox, display_cropped=False,
                     plot_bboxes=True, output_path=str(raw))
        ffmpeg = shutil.which("ffmpeg")
        if not ffmpeg:
            raise RuntimeError("FFmpeg não disponível para gerar MP4 compatível com o player")
        target = root / report["filename"]
        print("BEHAVETRACKER_VIDEO_PHASE=Preparando MP4 para reprodução no aplicativo", flush=True)
        result = subprocess.run([ffmpeg, "-v", "error", "-nostdin", "-n", "-i", str(raw), "-map", "0:v:0", "-an",
            "-c:v", "libx264", "-crf", "18", "-preset", "fast", "-pix_fmt", "yuv420p", "-fps_mode", "passthrough",
            "-movflags", "+faststart", str(target)], capture_output=True, timeout=7200)
        if result.returncode:
            raise RuntimeError("Falha ao preparar MP4: " + result.stderr.decode("utf-8", errors="replace")[-1000:])
        capture = cv2.VideoCapture(str(target))
        try:
            frames = int(capture.get(cv2.CAP_PROP_FRAME_COUNT))
            width, height = int(capture.get(cv2.CAP_PROP_FRAME_WIDTH)), int(capture.get(cv2.CAP_PROP_FRAME_HEIGHT))
            if not capture.isOpened() or frames != expected_frames or width != geometry["videoWidth"] or height != geometry["videoHeight"]:
                raise RuntimeError("Vídeo rotulado com frames ou resolução diferentes das poses; prévia não publicada")
        finally:
            capture.release()
        report.update(available=True, sizeBytes=target.stat().st_size, sha256=file_sha256(target),
                      frameCount=frames, width=width, height=height, playbackEncoding="h264-crf18-yuv420p")
    except Exception as error:
        report["error"] = f"{type(error).__name__}: {error}"[:1500]
        print("BEHAVETRACKER_LABELED_VIDEO_UNAVAILABLE=" + report["error"], flush=True)
    (root / "video_artifact.json").write_text(json.dumps(report, ensure_ascii=False), encoding="utf-8")
    return report
