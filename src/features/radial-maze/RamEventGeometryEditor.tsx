import { SelectMenu } from "../../components/ui/SelectMenu";
import { useState, type MouseEvent } from "react";
import type { ArmId, Point, RadialMazeGeometry } from "../../types";
import { ARM_IDS, validateRamEventGeometry } from "../../lib/radial-maze/geometry";
import { Button } from "../../components/ui/Button";

type Target = "center" | `arm-${ArmId}` | `entry-${ArmId}` | `distal-${ArmId}`;
export function RamEventGeometryEditor({ geometry, width, height, image, onChange }: {
  geometry: RadialMazeGeometry; width: number; height: number; image?: string;
  onChange: (geometry: RadialMazeGeometry) => void;
}) {
  const [target, setTarget] = useState<Target>("center");
  const armId = Number(target.split("-")[1]);
  const arm = geometry.arms.find(a => a.id === armId);
  const field = target.startsWith("arm-") ? "polygonPx" : target.startsWith("entry-") ? "entryGatePx" : "distalGatePx";
  const selected = target === "center" ? geometry.centerPolygonPx : arm?.[field] ?? [];
  const isGate = target.startsWith("entry-") || target.startsWith("distal-");
  const change = (points: Point[]) => onChange({ ...geometry, eventGeometryConfirmed: false,
    ...(target === "center" ? { centerPolygonPx: points } : { arms: geometry.arms.map(a => a.id === armId ? { ...a, [field]: points } : a) }) });
  const click = (event: MouseEvent<SVGSVGElement>) => {
    const matrix = event.currentTarget.getScreenCTM(); if (!matrix) return;
    const cursor = event.currentTarget.createSVGPoint(); cursor.x = event.clientX; cursor.y = event.clientY;
    const p = cursor.matrixTransform(matrix.inverse());
    if (p.x < 0 || p.y < 0 || p.x > width || p.y > height) return;
    change([...(isGate && selected.length >= 2 ? [] : selected), { x: Math.round(p.x), y: Math.round(p.y) }]);
  };
  const error = validateRamEventGeometry(geometry, width, height, false);
  return <div>
    <p>Marque a plataforma central, cada braço e suas linhas. B1 corresponde ao pote P1 e à recompensa já registrada. As regiões podem compartilhar bordas, sem sobreposição de área.</p>
    <SelectMenu label="Referência a desenhar" value={target} onChange={value=>setTarget(value as Target)} options={[{value:"center",label:"Plataforma central"},...ARM_IDS.flatMap(id=>[{value:`arm-${id}`,label:`B${id}: polígono`},{value:`entry-${id}`,label:`B${id}: linha de entrada (2 pontos)`},{value:`distal-${id}`,label:`B${id}: limite distal (2 pontos)`}])]}/>
    <div className="results-actions"><Button variant="secondary" onClick={() => change(selected.slice(0, -1))}>Desfazer ponto</Button>
      <Button variant="secondary" onClick={() => change([])}>Refazer referência</Button></div>
    <svg className="ram-geometry-editor" viewBox={`0 0 ${width} ${height}`} onClick={click} role="img" aria-label="Editor das referências dos oito braços">
      {image && <image href={image} width={width} height={height} />}
      <g pointerEvents="none">
        {geometry.walkablePolygonPx && <polygon points={geometry.walkablePolygonPx.map(p => `${p.x},${p.y}`).join(" ")} fill="none" stroke="#999" />}
        <polygon points={geometry.centerPolygonPx.map(p => `${p.x},${p.y}`).join(" ")} className="ram-center-polygon" />
        {geometry.arms.map(a => <g key={a.id}>
          <polygon points={a.polygonPx.map(p => `${p.x},${p.y}`).join(" ")} className="ram-arm-polygon" />
          <polygon points={a.cupPolygonPx.map(p => `${p.x},${p.y}`).join(" ")} className={a.baited ? "ram-cup-polygon baited" : "ram-cup-polygon"} />
          {[a.entryGatePx, a.distalGatePx].map((gate, i) => gate.length === 2 && <line key={i} x1={gate[0].x} y1={gate[0].y} x2={gate[1].x} y2={gate[1].y} className={i ? "ram-gate distal" : "ram-gate"} />)}
          {a.cupPolygonPx[0] && <text x={a.cupPolygonPx[0].x} y={a.cupPolygonPx[0].y} className="ram-cup-label">B{a.id}/P{a.id}</text>}
        </g>)}
        <polyline points={selected.map(p => `${p.x},${p.y}`).join(" ")} className="ram-active-line" />
        {selected.map((p, i) => <circle key={i} cx={p.x} cy={p.y} r={Math.max(3, width/300)} className="ram-active-point" />)}
      </g>
    </svg>
    {error && <p role="status">{error}</p>}
    <label><input type="checkbox" checked={geometry.eventGeometryConfirmed === true} disabled={!!error}
      onChange={e => onChange({ ...geometry, eventGeometryConfirmed: e.target.checked })} /> Revisei a plataforma, os oito braços, linhas e associação com os potes.</label>
  </div>;
}
