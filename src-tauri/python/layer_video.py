"""Video reader with an FFmpeg fallback for OpenCV builds without video codecs."""
import json
from pathlib import Path
import shutil
import subprocess
import cv2 as cv
import numpy as np


def capture(video, ffmpeg=None, ffprobe=None):
    reader=cv.VideoCapture(str(video))
    if reader.isOpened():
        return reader
    reader.release()
    return FFmpegCapture(video,ffmpeg,ffprobe)


class FFmpegCapture:
    def __init__(self,video,ffmpeg=None,ffprobe=None):
        self.video=str(video);self.ffmpeg=str(ffmpeg or shutil.which("ffmpeg") or "")
        sibling=Path(self.ffmpeg).with_name(Path(self.ffmpeg).name.replace("ffmpeg","ffprobe")) if self.ffmpeg else None
        probe=ffprobe or (str(sibling) if sibling and sibling.is_file() else shutil.which("ffprobe"))
        if not self.ffmpeg or not probe:raise ValueError("FFmpeg e FFprobe são necessários para ler este vídeo")
        result=subprocess.run([str(probe),"-v","error","-select_streams","v:0","-show_streams","-of","json",self.video],
                              capture_output=True,text=True,check=True)
        stream=json.loads(result.stdout)["streams"][0]
        self.width=int(stream["width"]);self.height=int(stream["height"])
        a,b=map(int,stream["avg_frame_rate"].split("/"));self.fps=a/b
        self.count=int(stream.get("nb_frames") or 0)
        self.process=None;self.position=0;self.seek=0

    def isOpened(self):return True

    def get(self,prop):
        return {cv.CAP_PROP_FRAME_WIDTH:self.width,cv.CAP_PROP_FRAME_HEIGHT:self.height,
                cv.CAP_PROP_FRAME_COUNT:self.count,cv.CAP_PROP_FPS:self.fps,cv.CAP_PROP_POS_FRAMES:self.position}.get(prop,0)

    def set(self,prop,index):
        if prop!=cv.CAP_PROP_POS_FRAMES or index<0:return False
        self.release();self.seek=int(index);self.position=int(index);return True

    def read(self):
        if self.process is None:
            command=[self.ffmpeg,"-v","error","-nostdin","-noautorotate"]
            if self.seek:command.extend(["-ss",str(self.seek/self.fps)])
            command.extend(["-i",self.video,"-map","0:v:0","-an","-sn","-dn","-fps_mode","passthrough",
                            "-f","rawvideo","-pix_fmt","bgr24","pipe:1"])
            self.process=subprocess.Popen(command,stdout=subprocess.PIPE,stderr=subprocess.PIPE)
        size=self.width*self.height*3;blocks=[];total=0
        while total<size:
            block=self.process.stdout.read(size-total)
            if not block:break
            blocks.append(block);total+=len(block)
        if not total:
            error=self.process.stderr.read()
            if self.process.wait()!=0:raise ValueError(error.decode(errors="replace")[-1000:])
            return False,None
        if total!=size:raise ValueError("Quadro truncado no decoder FFmpeg")
        self.position+=1
        return True,np.frombuffer(b"".join(blocks),np.uint8).reshape(self.height,self.width,3).copy()

    def release(self):
        if self.process is not None:
            if self.process.poll() is None:self.process.kill()
            self.process.wait();self.process.stdout.close();self.process.stderr.close();self.process=None
