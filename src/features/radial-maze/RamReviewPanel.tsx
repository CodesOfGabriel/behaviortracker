import { AnalysisDetailsLayout, DetailsVideoCard } from "../results/AnalysisDetailsLayout";
import { ResultMotionChart } from "../results/ResultMotionChart";
import { Card, CardHeader, CardTitle, CardContent } from "../../components/ui/card";
import { SelectMenu } from "../../components/ui/SelectMenu";
import { useEffect, useMemo, useRef, useState, type MouseEvent } from "react";
import { Button } from "../../components/ui/Button";
import { downloadText } from "../../lib/csv";
import { boxCenterTrajectory, boxTrajectoryStyle } from "../../lib/boxes";
import { LocalMotionOverlay } from "../local/LocalMotionOverlay";
import { LocalBodyOverlay } from "../local/LocalBodyOverlay";
import { correctedRamSamples, deriveRamResult } from "../../lib/radial-maze/review";
import type { BoundingBox, CorrectionEvent, PoseSample, RadialMazeExperiment } from "../../types";
import { appendRamReviewEvent, listRamReviewEvents, type LocalJob } from "../local/api";

export function RamReviewPanel({ experiment, job, raw, videoUrl }: {
  experiment: RadialMazeExperiment; job: LocalJob; raw: PoseSample[]; videoUrl?: string;
}) {
  const [events, setEvents] = useState<CorrectionEvent[]>([]);
  const [index, setIndex] = useState(0);
  const [editPosition, setEditPosition] = useState(false);
  const [box, setBox] = useState<BoundingBox>({ x: 0, y: 0, width: 1, height: 1 });
  const [error, setError] = useState(""); const [saving, setSaving] = useState(false); const [loaded, setLoaded] = useState(false);
  const videoRef = useRef<HTMLVideoElement>(null);
  useEffect(() => {
    let live = true; setLoaded(false); setEvents([]); setIndex(0);
    void listRamReviewEvents(job.jobId).then(value => { if (live) { setEvents(value); setLoaded(true); } }).catch(reason => { if (live) setError(String(reason)); });
    return () => { live = false; };
  }, [job.jobId]);
  const samples = useMemo(() => correctedRamSamples(raw, events), [raw, events]);
  const sample = samples[index];
  useEffect(() => {
    const element = videoRef.current;
    if (!element?.requestVideoFrameCallback) return;
    let callback = 0, live = true;
    const update: VideoFrameRequestCallback = (_now, metadata) => {
      if (!live) return;
      sync(metadata.mediaTime);
      callback = element.requestVideoFrameCallback(update);
    };
    callback = element.requestVideoFrameCallback(update);
    return () => { live = false; element.cancelVideoFrameCallback(callback); };
  }, [videoUrl, samples]);
  useEffect(() => { if (sample?.bbox) setBox(sample.bbox); }, [sample]);
  const result = useMemo(() => deriveRamResult(samples, experiment), [samples, experiment]);
  const issues = useMemo(() => samples.map((s, i) => ({ s, i })).filter(({s}) => s.status !== "valid" || s.source === "predicted"), [samples]);
  const width = experiment.video.width, height = experiment.video.height;
  const staleMask = job.config.walkableMaskVersion !== experiment.geometry.walkableMaskVersion;
  function seek(next: number) {
    const bounded = Math.max(0, Math.min(samples.length-1, next)); setIndex(bounded);
    if (videoRef.current && samples[bounded]) { videoRef.current.pause(); videoRef.current.currentTime = samples[bounded].timestampSec; }
  }
  function sync(time: number) {
    let lo = 0, hi = samples.length-1;
    while (lo < hi) { const mid = Math.ceil((lo+hi)/2); if (samples[mid].timestampSec <= time) lo = mid; else hi = mid-1; }
    setIndex(lo);
  }
  async function save(type: CorrectionEvent["type"], extra: Partial<CorrectionEvent> = {}) {
    if (!sample || !loaded || saving) return;
    videoRef.current?.pause();
    setSaving(true); setError("");
    const event: CorrectionEvent = { id: crypto.randomUUID(), type, createdAt: new Date().toISOString(), source: "manual",
      runId: job.jobId, sourceVideoSha256: job.videoSha256, algorithmVersion: sample.algorithmVersion ?? "opencv-legacy",
      frameIndex: sample.frameIndex, timestampSec: sample.timestampSec, keypoint: "box_center",
      before: sample.xPx == null || sample.yPx == null ? null : { x: sample.xPx, y: sample.yPx }, beforeBox: sample.bbox ?? null, ...extra };
    try { await appendRamReviewEvent(job.jobId, event); setEvents(current => [...current, event]); }
    catch (reason) { setError(String(reason)); } finally { setSaving(false); }
  }
  function move(event: MouseEvent<SVGSVGElement>) {
    if (!editPosition || !sample || !videoUrl) return;
    const matrix = event.currentTarget.getScreenCTM(); if (!matrix) return;
    const cursor = event.currentTarget.createSVGPoint(); cursor.x = event.clientX; cursor.y = event.clientY;
    const p = cursor.matrixTransform(matrix.inverse());
    void save("MOVE_POINT", { after: { x: p.x, y: p.y } }); setEditPosition(false);
  }
  function exportReview() {
    const payload = { schemaVersion: "ram-review-2", experimentId: experiment.id, runId: job.jobId,
      videoSha256: job.videoSha256, trackingConfig: job.config, report: job.report,
      geometry: experiment.geometry, visitPolicy: experiment.visitPolicy, spatialCalibration: experiment.spatialCalibration ?? null,
      reviewStatus: "pending", raw, corrected: samples, correctionHistory: events,
      derived: staleMask ? null : result, derivedUnavailableReason: staleMask ? "Máscara alterada após o tracking" : result.geometryError };
    downloadText(`${experiment.id}-${job.jobId}-ram-review.json`, JSON.stringify(payload), "application/json");
  }
  const trajectory = useMemo(() => boxCenterTrajectory(samples.slice(Math.max(0,index-150), index+1), width, height),
    [samples, index, width, height]);
  const duration = Math.max(.001, samples.at(-1)?.timestampSec ?? 1);
  const graphStride = Math.max(1, Math.ceil(result.displacement.length/1000));
  const graphMax = Math.max(1,...result.displacement.map(d=>d.distancePx ?? 0));
  const allowedBox = [box.x,box.y,box.width,box.height].every(Number.isFinite) && box.x >= 0 && box.y >= 0 && box.width > 0 && box.height > 0 && box.x+box.width <= width && box.y+box.height <= height;
  return <AnalysisDetailsLayout className="ram-review-panel" video={<DetailsVideoCard description="Caixa corporal, trajetória e revisão por quadro.">
    {!videoUrl&&<p className="details-chart-note">Abra o vídeo original para sincronizar a revisão visual.</p>}
    {sample && <>
      <div className="ram-review-video">
        {videoUrl ? <video ref={videoRef} src={videoUrl} preload="metadata" controls onTimeUpdate={e => sync(e.currentTarget.currentTime)} />
          : <div style={{ aspectRatio: `${width}/${height}` }} />}
        <svg viewBox={`0 0 ${width} ${height}`} onClick={move} style={{ pointerEvents: editPosition ? "auto" : "none" }} aria-label="Caixa corporal e trajetória no frame atual">
          {trajectory.segments.map((segment, i) => <polyline key={i} points={segment.points.map(p => `${p.x},${p.y}`).join(" ")}
            fill="none" stroke={boxTrajectoryStyle[segment.state].color} strokeDasharray={boxTrajectoryStyle[segment.state].dash}
            strokeWidth={3} strokeLinejoin="round" strokeLinecap="round" />)}
          {sample.bbox && <rect {...sample.bbox} fill="none" stroke={sample.status === "valid" ? "#51ddce" : "#ffb84c"} strokeWidth={4} />}
          {trajectory.centers.filter(s => s.frameIndex === sample.frameIndex).map(s => <circle key="box-center" cx={s.xPx!} cy={s.yPx!} r={6} fill="#51ddce" />)}
          {sample.source === "manual" && sample.xPx != null && sample.yPx != null && <circle cx={sample.xPx} cy={sample.yPx} r={9} fill="none" stroke="#ffb84c" strokeWidth={2} />}
          <LocalBodyOverlay sample={sample} samples={samples} width={width} height={height} />
          <LocalMotionOverlay samples={samples} width={width} height={height} time={sample.timestampSec} />
        </svg>
      </div>
      <label>Frame {sample.frameIndex} · {sample.timestampSec.toFixed(3)} s<input aria-label="Navegar por frame" type="range" min={0} max={samples.length-1} value={index} onChange={e=>seek(Number(e.target.value))}/></label>
      <p role="status">{sample.status} · {sample.reason ?? "Sem justificativa legada"} · incerteza: {sample.uncertaintyPx == null ? "indisponível" : `${sample.uncertaintyPx.toFixed(1)} px`}</p>
      <div className="results-actions"><Button variant="secondary" onClick={()=>seek(index-1)}>Frame anterior</Button><Button variant="secondary" onClick={()=>seek(index+1)}>Próximo frame</Button>
        <Button variant="secondary" onClick={()=>seek(issues.find(x=>x.i>index)?.i ?? issues[0]?.i ?? index)}>Próximo frame incerto ({issues.length})</Button></div>
      <SelectMenu label="Ir para um frame incerto" value="" onChange={value=>seek(Number(value))}
        options={issues.slice(0,300).map(({s,i})=>({value:String(i),label:`${s.frameIndex} · ${s.reason??"Incerto"}`}))}/>
      <details className="details-corrections"><summary>Corrigir posição ou caixa</summary>
      <fieldset disabled={!loaded || saving || !videoUrl}><legend>Correção do frame observado</legend>
        <div className="results-actions"><Button variant="secondary" onClick={()=>{ videoRef.current?.pause(); setEditPosition(v=>!v); }}>{editPosition ? "Cancelar ajuste" : "Marcar centro no vídeo"}</Button>
          <Button variant="secondary" disabled={sample.source === "predicted" || sample.xPx == null} onClick={()=>void save("CONFIRM_POINT")}>Confirmar posição e identidade</Button>
          <Button variant="secondary" onClick={()=>void save("MARK_MISSING")}>Marcar ausente / identidade incerta</Button></div>
        <div className="ram-box-fields">{(["x","y","width","height"] as const).map(key=><label key={key}>{({ x: "X (px)", y: "Y (px)", width: "Largura (px)", height: "Altura (px)" })[key]}<input type="number" min={0} onFocus={()=>videoRef.current?.pause()} value={box[key]} onChange={e=>setBox(current=>({...current,[key]:Number(e.target.value)}))}/></label>)}</div>
        <Button variant="secondary" disabled={!allowedBox} onClick={()=>void save("SET_BOX",{afterBox:box})}>Salvar caixa corporal</Button>
      </fieldset></details>
    </>}
    </DetailsVideoCard>}>
    <ResultMotionChart samples={samples} width={width} height={height} time={sample?.timestampSec??0} onSeek={time=>{sync(time);if(videoRef.current)videoRef.current.currentTime=time;}}/>
    <Card><CardHeader><CardTitle>Deslocamento por quadro</CardTitle></CardHeader><CardContent>
    <svg viewBox="0 0 1000 140" className="ram-displacement-chart" role="img" aria-label="Deslocamento observado com lacunas">
      {result.displacement.filter((_,i)=>i%graphStride===0).map(d=> d.distancePx == null
        ? <line key={d.frameIndex} x1={d.timestampSec/duration*1000} x2={d.timestampSec/duration*1000} y1={0} y2={140} stroke="#ffb84c" opacity=".35" />
        : <circle key={d.frameIndex} cx={d.timestampSec/duration*1000} cy={135-d.distancePx/graphMax*130} r={2} fill="#51ddce" />)}
    </svg>
    <p>Tempo: 0–{duration.toFixed(1)} s · deslocamento: 0–{graphMax.toFixed(1)} px por frame. Trechos em amarelo não entram nas métricas.</p>
    </CardContent></Card>
    <Card><CardHeader><CardTitle>Eventos e métricas experimentais</CardTitle></CardHeader><CardContent>
    {staleMask ? <p>A máscara mudou após esta execução. Execute novamente para calcular métricas.</p> : result.geometryError ? <p>{result.geometryError} Complete a geometria para calcular visitas.</p> : <>
      <p>{result.metrics?.confirmedChoices} escolhas confirmadas pelo critério · {result.metrics?.pendingChoices} pendentes · WME {result.metrics?.wme} · RME {result.metrics?.rme} · RWME {result.metrics?.rwme}.</p>
      <p>Cobertura temporal observada: {result.temporalQuality.observedCoveragePct.toFixed(1)}%. Distância: {result.distanceCm == null ? "requer calibração espacial" : `${result.distanceCm.toFixed(2)} cm (trechos observados)`}. Retirada de alimento: não confirmada.</p>
      <p>Velocidade média nos trechos observados: {result.meanSpeedCmS == null ? "requer calibração" : `${result.meanSpeedCmS.toFixed(2)} cm/s`}. Latência para primeira escolha: {result.metrics?.firstChoiceLatencySec == null ? "indisponível ou pendente" : `${result.metrics.firstChoiceLatencySec.toFixed(2)} s`}.</p>
      <details><summary>Entradas, saídas e transições ({result.transitions.length})</summary><table><thead><tr><th>Frame</th><th>Origem</th><th>Destino</th><th>Estado</th></tr></thead><tbody>{result.transitions.slice(0,500).map((t,i)=><tr key={i}><td><button onClick={()=>seek(samples.findIndex(s=>s.frameIndex===t.frameIndex))}>{t.frameIndex}</button></td><td>{t.from}</td><td>{t.to}</td><td>{t.status}</td></tr>)}</tbody></table>{result.transitions.length>500 && <p>Primeiras 500 transições; o arquivo exportado contém todas.</p>}</details>
      <table><thead><tr><th>Braço</th><th>Ocupação observada (s)</th></tr></thead><tbody>{experiment.geometry.arms.map(a=><tr key={a.id}><td>B{a.id} / P{a.id}</td><td>{((result.occupancySec[`ARM_${a.id}`]??0)+(result.occupancySec[`DISTAL_${a.id}`]??0)).toFixed(2)}</td></tr>)}</tbody></table>
      <table><thead><tr><th>Frame</th><th>Braço</th><th>Estado</th><th>Classificação</th></tr></thead><tbody>{result.choices.map((c,i)=><tr key={i}><td><button onClick={()=>seek(samples.findIndex(s=>s.frameIndex===c.frameIndex))}>{c.frameIndex}</button></td><td>B{c.armId}</td><td>{c.status} {c.reason}</td><td>{c.classification}</td></tr>)}</tbody></table>
    </>}
    <details><summary>Histórico de correções ({events.length})</summary>{events.map(e=><p key={e.id}>{e.createdAt} · frame {e.frameIndex} · {e.type} {e.type !== "REVERT_EVENT" && <button disabled={saving || !loaded} onClick={()=>{seek(samples.findIndex(s=>s.frameIndex===e.frameIndex)); void save("REVERT_EVENT",{frameIndex:e.frameIndex,timestampSec:e.timestampSec,targetEventId:e.id});}}>Reverter</button>}</p>)}</details>
    {error && <p role="alert">{error}</p>}
    <Button disabled={!loaded} onClick={exportReview}>Exportar brutos, corrigidos, eventos e histórico</Button>
    </CardContent></Card>
  </AnalysisDetailsLayout>;
}
