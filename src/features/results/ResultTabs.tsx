import { EditorTabs } from "../../components/ui/EditorTabs";
import { useEffect, useRef, type ReactNode } from "react";

export const resultTabs = [
  { id: "summary", label: "Resumo" }, { id: "video", label: "Vídeo" },
  { id: "trajectory", label: "Trajetória" }, { id: "details", label: "Detalhes" },
  { id: "runs", label: "Análise" }, { id: "exports", label: "Arquivos" },
] as const;
export type ResultView = typeof resultTabs[number]["id"];
export type ResultPanels = Partial<Record<ResultView, ReactNode>>;

export function ResultTabs({ id, label, value, onChange }: {
  id: string; label: string; value: ResultView; onChange: (value: ResultView) => void;
}) {
  return <EditorTabs id={id} label={label} items={[...resultTabs]} value={value} onChange={onChange} />;
}

export function ResultPanel({ id, view, active, children }: {
  id: string; view: ResultView; active: ResultView; children: ReactNode;
}) {
  const panel=useRef<HTMLDivElement>(null);
  useEffect(()=>{if(active!==view)panel.current?.querySelectorAll("video").forEach(video=>video.pause());},[active,view]);
  return <div ref={panel} role="tabpanel" id={`${id}-${view}-panel`} aria-labelledby={`${id}-${view}-tab`} hidden={active !== view}>{children}</div>;
}
