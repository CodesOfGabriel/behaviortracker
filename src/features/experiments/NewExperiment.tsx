import { useEffect, useState } from "react";
import { ArrowLeft, ArrowRight, FlaskConical, Network, Waves } from "lucide-react";
import { useAppStore } from "../../store/AppStore";
import { OpenFieldExperimentWizard } from "./OpenFieldExperimentWizard";
import { ForcedSwimExperimentWizard } from "./ForcedSwimExperimentWizard";
import { RadialArmMazeExperimentWizard } from "./RadialArmMazeExperimentWizard";

export function NewExperiment({ onComplete = () => {} }: { onComplete?: () => void }) {
  const { route, navigate, draftPreparationActive } = useAppStore();
  const [protocol, setProtocol] = useState<"open_field" | "forced_swim" | "radial_arm_maze" | null>(null);
  const [visited, setVisited] = useState({ open_field: false, forced_swim: false, radial_arm_maze: false });
  const selectProtocol = (next: "open_field" | "forced_swim" | "radial_arm_maze") => {
    setVisited(current => ({ ...current, [next]: true }));
    setProtocol(next);
  };
  useEffect(() => {
    if (route.name !== "new-experiment" || !route.resumePreparation || !draftPreparationActive) return;
    setVisited(current => ({ ...current, open_field: true }));
    setProtocol("open_field");
  }, [route, draftPreparationActive]);
  return <>
  <div className="page wizard-page protocol-page" hidden={protocol !== null}>
    <button className="back-link" onClick={() => navigate({ name: "dashboard" })}><ArrowLeft size={16} /> Voltar aos experimentos</button>
    <section className="page-heading protocol-heading"><div><div className="eyebrow">Novo experimento</div><h1>Selecione o protocolo</h1><p>Escolha o tipo de experimento para configurar os dados e o vídeo da sessão.</p></div></section>
    {draftPreparationActive && <button type="button" className="button button-secondary" onClick={() => setProtocol("open_field")}>Retomar preparação do vídeo de Campo Aberto</button>}
    <div className="protocol-options" aria-label="Tipos de experimento">
      <button type="button" className="protocol-option protocol-option-open-field" onClick={() => selectProtocol("open_field")}>
        <span className="protocol-option-icon"><FlaskConical size={25} strokeWidth={1.7} /></span>
        <span className="protocol-option-body"><small>Disponível</small><strong>Campo Aberto</strong><span>Rastreamento do animal, trajetória e ocupação das zonas da arena.</span></span>
        <ArrowRight size={20} className="protocol-option-arrow" />
      </button>
      <button type="button" className="protocol-option protocol-option-forced-swim" onClick={() => selectProtocol("forced_swim")}>
        <span className="protocol-option-icon"><Waves size={25} strokeWidth={1.7} /></span>
        <span className="protocol-option-body"><small>Disponível</small><strong>Nado Forçado</strong><span>Presença e movimento independentes por animal e cilindro.</span></span>
        <ArrowRight size={20} className="protocol-option-arrow" />
      </button>
      <button type="button" className="protocol-option protocol-option-radial-maze" onClick={() => selectProtocol("radial_arm_maze")}>
        <span className="protocol-option-icon"><Network size={25} strokeWidth={1.7} /></span>
        <span className="protocol-option-body"><small>Preparação disponível</small><strong>Labirinto Radial</strong><span>Marque a área do labirinto, os potes e as recompensas antes da análise.</span></span>
        <ArrowRight size={20} className="protocol-option-arrow" />
      </button>
    </div>
  </div>
  {visited.open_field && <div className="retained-workspace" hidden={protocol !== "open_field"}>
    <OpenFieldExperimentWizard onBack={() => setProtocol(null)} onComplete={onComplete} resumePreparation={route.name === "new-experiment" && route.resumePreparation && draftPreparationActive} />
  </div>}
  {visited.forced_swim && <div className="retained-workspace" hidden={protocol !== "forced_swim"}>
    <ForcedSwimExperimentWizard onBack={() => setProtocol(null)} onComplete={onComplete} />
  </div>}
  {visited.radial_arm_maze && <div className="retained-workspace" hidden={protocol !== "radial_arm_maze"}>
    <RadialArmMazeExperimentWizard onBack={() => setProtocol(null)} onComplete={onComplete} />
  </div>}
  </>;
}
