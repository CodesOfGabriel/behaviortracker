import { ArrowLeft, Download, Info, ShieldCheck } from "lucide-react";
import { Button } from "../../components/ui/Button";
import { useState } from "react";
import { downloadText } from "../../lib/csv";
import { newGeometryRevision } from "../../lib/radial-maze/geometry";
import { useAppStore } from "../../store/AppStore";
import type { RadialMazeExperiment } from "../../types";
import { RamColabPanel } from "./RamColabPanel";
import { RamLocalPanel } from "./RamLocalPanel";

export function RadialMazeResults({ experimentId }: { experimentId: string }) {
  const { getExperiment, assets, navigate, updateRadialMazeExperiment } = useAppStore();
  const [selectedRevisionIndex, setSelectedRevisionIndex] = useState(-1);
  const candidate = getExperiment(experimentId);
  const experiment = candidate?.testType === "radial_arm_maze" ? candidate as RadialMazeExperiment : null;
  if (!experiment) return <div className="page not-found"><h1>Experimento RAM não encontrado</h1><Button onClick={() => navigate({ name: "dashboard" })}>Voltar</Button></div>;
  const { geometry, video, visitPolicy } = experiment;
  const asset = assets[experimentId];
  const exportConfiguration = () => {
    const document = { schemaVersion: experiment.schemaVersion, analysisMethodVersion: experiment.analysisMethodVersion,
      testType: experiment.testType, experimentId: experiment.id, subjectId: experiment.subjectId,
      video, modelBundleId: experiment.modelBundleId, geometry, geometryHistory: experiment.geometryHistory ?? [], visitPolicy,
      analysisStatus: "configuration_only", trackingValidated: false, behaviorValidated: false,
      analysisRegionPolicy: { outsideWalkableArea: "excluded", cupRegion: "cup_intersection_walkable_area" } };
    downloadText(`${experiment.id}-ram-configuration.json`, JSON.stringify(document, null, 2), "application/json");
  };
  const restoreRevision = () => {
    const previous = experiment.geometryHistory?.[selectedRevisionIndex];
    if (!previous) return;
    updateRadialMazeExperiment(experimentId, current => newGeometryRevision(current, previous));
    setSelectedRevisionIndex(-1);
  };
  return <div className="page results-page ram-results">
    <button className="back-link" onClick={() => navigate({ name: "dashboard" })}><ArrowLeft size={16}/> Experimentos</button>
    <section className="page-heading results-heading"><div><div className="eyebrow">Labirinto Radial · Preparação</div><h1>{experiment.title}</h1>
      <p>{experiment.subjectId} · {video.filename} · geometria revisão {geometry.revision}</p></div>
      <div className="results-actions"><Button variant="secondary" onClick={() => navigate({ name: "validation", experimentId })}>Referência humana</Button><Button variant="secondary" onClick={() => navigate({ name: "edit-ram", experimentId })}>Revisar geometria</Button>
        <Button variant="secondary" icon={<Download size={16}/>} onClick={exportConfiguration}>Exportar configuração</Button></div></section>
    <div className="validation-box valid"><ShieldCheck size={17}/><span>{geometry.walkablePolygonPx
      ? "Área do labirinto, potes e recompensas salvos. O tracking no Colab está disponível em caráter experimental; visitas e recompensas exigem revisão e método validados."
      : "Geometria e política de visita salvas. Marque toda a área analisável antes de executar o tracking experimental no Colab."}</span></div>
    <RamColabPanel experiment={experiment}/>
    <RamLocalPanel experiment={experiment}/>
    <div className="ram-results-grid">
      <section className="panel"><h2>Mapa da sessão</h2><p>Coordenadas no vídeo original. Os potes com recompensa aparecem em verde. Áreas dos potes fora do labirinto ficam excluídas da análise.</p>
        <svg className="ram-geometry-editor ram-geometry-preview" viewBox={`0 0 ${video.width} ${video.height}`} role="img" aria-label="Geometria do labirinto radial">
          {(asset?.frameDataUrl || experiment.calibrationThumbnailDataUrl) && <image href={asset?.frameDataUrl || experiment.calibrationThumbnailDataUrl} width={video.width} height={video.height}/>}
          {geometry.walkablePolygonPx ? <polygon points={geometry.walkablePolygonPx.map(p => `${p.x},${p.y}`).join(" ")} className="ram-center-polygon"/>
            : <polygon points={geometry.centerPolygonPx.map(p => `${p.x},${p.y}`).join(" ")} className="ram-center-polygon"/>}
          {geometry.arms.map(arm => <g key={arm.id}>
            {!geometry.walkablePolygonPx && <polygon points={arm.polygonPx.map(p => `${p.x},${p.y}`).join(" ")} className="ram-arm-polygon"/>}
            <polygon points={arm.cupPolygonPx.map(p => `${p.x},${p.y}`).join(" ")} className={arm.baited ? "ram-cup-polygon baited" : "ram-cup-polygon"}/>
            {!geometry.walkablePolygonPx && <>
              <line x1={arm.entryGatePx[0].x} y1={arm.entryGatePx[0].y} x2={arm.entryGatePx[1].x} y2={arm.entryGatePx[1].y} className="ram-gate"/>
              <line x1={arm.distalGatePx[0].x} y1={arm.distalGatePx[0].y} x2={arm.distalGatePx[1].x} y2={arm.distalGatePx[1].y} className="ram-gate distal"/>
              <text x={arm.polygonPx[0].x} y={arm.polygonPx[0].y} className="ram-arm-label">B{arm.id}</text>
            </>}
            {geometry.walkablePolygonPx && <text x={arm.cupPolygonPx[0].x} y={arm.cupPolygonPx[0].y} className="ram-cup-label">P{arm.id}</text>}
          </g>)}
        </svg>
      </section>
      <section className="panel"><h2>Critério registrado</h2>
        <dl className="ram-policy-list"><div><dt>Escolha válida</dt><dd>{visitPolicy.choiceCriterion === "arm_entry" ? "Entrada no braço" : "Alcance distal"}</dd></div>
          <div><dt>Centro</dt><dd>{visitPolicy.minimumCenterDwellSec} s</dd></div><div><dt>Braço</dt><dd>{visitPolicy.minimumArmDwellSec} s</dd></div>
          <div><dt>Região distal</dt><dd>{visitPolicy.minimumDistalDwellSec} s</dd></div><div><dt>Lacuna tolerada</dt><dd>{visitPolicy.unknownGapToleranceSec} s</dd></div>
          <div><dt>Recompensa</dt><dd>{geometry.arms.filter(arm => arm.baited).map(arm => `${geometry.walkablePolygonPx ? "P" : "B"}${arm.id}`).join(", ")}</dd></div>
          <div><dt>Revisões anteriores</dt><dd>{experiment.geometryHistory?.length ?? 0}</dd></div></dl>
        {!!experiment.geometryHistory?.length && <div className="ram-revision-picker"><label>Restaurar geometria anterior
          <select value={selectedRevisionIndex} onChange={event => setSelectedRevisionIndex(Number(event.target.value))}>
            <option value={-1}>Selecione uma revisão</option>
            {experiment.geometryHistory.map((item, index) => <option key={index} value={index}>Revisão {item.revision} · {item.walkableMaskVersion.slice(0, 25)}</option>)}
          </select></label><Button variant="secondary" disabled={selectedRevisionIndex < 0} onClick={restoreRevision}>Restaurar como nova revisão</Button></div>}
        <div className="ram-analysis-note"><Info size={17}/><span>Os potes e recompensas ficam registrados na configuração. O tracking experimental observa somente a área do labirinto; erros de memória e consumo de recompensa dependem de revisão humana e validação do método.</span></div>
      </section>
    </div>
  </div>;
}
