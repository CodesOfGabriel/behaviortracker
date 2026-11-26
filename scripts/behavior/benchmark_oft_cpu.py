"""Measure the actual second pass, without treating tracker acceptance as accuracy."""
import argparse
import json
from pathlib import Path
import platform
try:
    import resource
except ImportError:
    resource = None
import tempfile
import time
from common import write_json
from behavior.open_field import run


def benchmark(request_path, output):
    request=json.loads(Path(request_path).read_text())
    started=time.perf_counter()
    with tempfile.TemporaryDirectory(prefix='oft-behavior-benchmark-') as temporary:
        path=Path(temporary)/'request.json';write_json(path,request)
        result=run(path)
        if result['state']!='succeeded':raise ValueError(result.get('error',result['state']))
        report=json.loads((Path(temporary)/'result/run_manifest.json').read_text())
        timings=report['timings']
        rss=resource.getrusage(resource.RUSAGE_SELF).ru_maxrss if resource else None
        output_report=dict(**timings,tracking_time_sec=None,peak_memory_mb=rss/(1024*1024 if platform.system()=='Darwin' else 1024) if rss is not None else None,
            cpu_threads=request.get('cpuThreads',2),model_size_mb=sum(p.stat().st_size for p in Path(request['modelDirectory']).glob('*.onnx'))/1024**2,
            elapsedWallSec=time.perf_counter()-started,platform=platform.platform(),videoSha256=request['videoSha256'],trackingJobId=request['trackingJobId'],
            trackingTimingNote='Tracking is reused; measure its own run separately',scientificAccuracyMeasured=False)
        write_json(output,output_report)
        return output_report


if __name__=='__main__':
    p=argparse.ArgumentParser(description=__doc__);p.add_argument('request');p.add_argument('output');a=p.parse_args();benchmark(a.request,a.output)
