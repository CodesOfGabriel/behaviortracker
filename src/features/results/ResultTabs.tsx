import { EditorTabs } from "../../components/ui/EditorTabs";
import { useEffect, useRef, type ReactNode } from "react";

export const resultTabs = [
  { id: "summary", label: "Resumo" }, { id: "video", label: "Vídeo" },
  { id: "trajectory", label: "Trajetória" }, { id: "details", label: "Detalhes" },
  { id: "runs", label: "Análise" }, { id: "exports", label: "Arquivos" },
] as const;
export type ResultView = typeof resultTabs[number]["id"] | "behavior";
export type ResultPanels = Partial<Record<ResultView, ReactNode>>;

export function ResultTabs<T extends ResultView>({ id, label, value, onChange, behavior = false }: {
  id: string; label: string; value: T; onChange: (value: T) => void; behavior?: boolean;
}) {
  const items = behavior ? [...resultTabs.slice(0,2), {id:"behavior",label:"Rearing"}, ...resultTabs.slice(2)] : [...resultTabs];
  return <EditorTabs id={id} label={label} items={items} value={value} onChange={next=>onChange(next as T)} />;
}

export function ResultPanel({ id, view, active, children }: {
  id: string; view: ResultView; active: ResultView; children: ReactNode;
}) {
  const panel=useRef<HTMLDivElement>(null);
  useEffect(()=>{if(active!==view)panel.current?.querySelectorAll("video").forEach(video=>video.pause());},[active,view]);
  return <div ref={panel} role="tabpanel" id={`${id}-${view}-panel`} aria-labelledby={`${id}-${view}-tab`} hidden={active !== view}>{children}</div>;
}
