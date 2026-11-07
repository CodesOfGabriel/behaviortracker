export const LANDMARKS = {
  nose: "Focinho", left_ear: "Orelha esquerda", right_ear: "Orelha direita", neck: "Nuca",
  mid_back: "Meio do dorso", hip: "Quadril", tail_base: "Base da cauda",
  left_forepaw: "Pata anterior esquerda", right_forepaw: "Pata anterior direita",
} as const;
export type Landmark = keyof typeof LANDMARKS;
export const CONTEXTS = { walking: "Andando", rearing: "Nas duas patas", grooming: "Grooming", freezing: "Freezing", other: "Outro / incerto" } as const;
export type Context = keyof typeof CONTEXTS;
export type KeypointLabel = { state: "visible" | "occluded" | "unlabeled"; x: number | null; y: number | null };
export type Box = { x: number; y: number; width: number; height: number };
export type TrainingFrame = {
  id: string; experimentId: string; subjectId: string; videoSha256: string; frameIndex: number; timestampSec: number;
  width: number; height: number; imageSha256: string; bbox: Box | null;
  keypoints: Record<Landmark, KeypointLabel>; context: Context; split: "train" | "validation"; reviewed: boolean; updatedAt: string;
};
export type TrainingInterval = { id: string; startSec: number; endSec: number; context: Context };
export const emptyKeypoints = () => Object.fromEntries(Object.keys(LANDMARKS).map((name) => [name, {state:"unlabeled",x:null,y:null}])) as TrainingFrame["keypoints"];

export function annotationErrors(frame: Pick<TrainingFrame,"bbox"|"keypoints"|"width"|"height">) {
  const errors: string[] = [];
  const box = frame.bbox;
  if (!box || ![box.x,box.y,box.width,box.height].every(Number.isFinite) || box.x<0 || box.y<0 || box.width<2 || box.height<2
    || box.x+box.width>frame.width || box.y+box.height>frame.height) errors.push("Desenhe uma caixa válida em volta do animal visível.");
  for (const name of Object.keys(LANDMARKS) as Landmark[]) {
    const p = frame.keypoints[name];
    if (!p || p.state === "unlabeled") errors.push(`Revise ${LANDMARKS[name]}: posicione ou marque como não visível.`);
    else if (p.state === "visible" && (p.x==null || p.y==null || !Number.isFinite(p.x) || !Number.isFinite(p.y) || p.x<0 || p.y<0 || p.x>frame.width || p.y>frame.height
      || (box && (p.x<box.x || p.y<box.y || p.x>box.x+box.width || p.y>box.y+box.height)))) errors.push(`${LANDMARKS[name]} deve ficar dentro da caixa e da imagem.`);
    else if (p.state === "occluded" && (p.x!==null || p.y!==null)) errors.push(`${LANDMARKS[name]} não visível não pode conter coordenadas inventadas.`);
  }
  if (!Object.values(frame.keypoints).some((p) => p.state === "visible")) errors.push("Marque pelo menos uma parte realmente visível.");
  return errors;
}

export function sampleInterval(start: number,end: number,step: number,duration: number) {
  if (![start,end,step,duration].every(Number.isFinite) || start<0 || end<=start || end>duration || step<.25) throw new Error("Selecione um intervalo válido e espaçamento de pelo menos 0,25 s.");
  const count = Math.ceil((end-start)/step);
  if (count>100) throw new Error("Use no máximo 100 frames por trecho; aumente o espaçamento.");
  return Array.from({length:count},(_,i)=>start+i*step);
}
