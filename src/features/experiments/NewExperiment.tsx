import { useState } from "react";
import { ArrowLeft, ArrowRight, FlaskConical, Waves } from "lucide-react";
import { useAppStore } from "../../store/AppStore";
import { OpenFieldExperimentWizard } from "./OpenFieldExperimentWizard";
import { ForcedSwimExperimentWizard } from "./ForcedSwimExperimentWizard";

export function NewExperiment() {
  const { navigate } = useAppStore();
  const [protocol, setProtocol] = useState<"open_field" | "forced_swim" | null>(null);
  if (protocol === "open_field") return <OpenFieldExperimentWizard onBack={() => setProtocol(null)} />;
  if (protocol === "forced_swim") return <ForcedSwimExperimentWizard onBack={() => setProtocol(null)} />;
  return <div className="page wizard-page protocol-page">
    <button className="back-link" onClick={() => navigate({ name: "dashboard" })}><ArrowLeft size={16} /> Voltar aos experimentos</button>
    <section className="page-heading protocol-heading"><div><div className="eyebrow">Novo experimento</div><h1>Selecione o protocolo</h1><p>Escolha o tipo de experimento para configurar os dados e o vídeo da sessão.</p></div></section>
    <div className="protocol-options" aria-label="Tipos de experimento">
      <button type="button" className="protocol-option protocol-option-open-field" onClick={() => setProtocol("open_field")}>
        <span className="protocol-option-icon"><FlaskConical size={25} strokeWidth={1.7} /></span>
        <span className="protocol-option-body"><small>Disponível</small><strong>Campo Aberto</strong><span>Rastreamento do animal, trajetória e ocupação das zonas da arena.</span></span>
        <ArrowRight size={20} className="protocol-option-arrow" />
      </button>
      <button type="button" className="protocol-option protocol-option-forced-swim" onClick={() => setProtocol("forced_swim")}>
        <span className="protocol-option-icon"><Waves size={25} strokeWidth={1.7} /></span>
        <span className="protocol-option-body"><small>Disponível</small><strong>Nado Forçado</strong><span>Presença e movimento independentes por animal e cilindro.</span></span>
        <ArrowRight size={20} className="protocol-option-arrow" />
      </button>
    </div>
  </div>;
}
