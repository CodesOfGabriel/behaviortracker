import { useEffect, useRef, useState, type ReactNode } from "react";
import { Button } from "../../components/ui/Button";
import { Check, X, Settings2 } from "lucide-react";
import { SelectMenu } from "../../components/ui/SelectMenu";
import type { ProposalReviewInput, ProposalReviewState, RearingTag } from "../../lib/behavior/types";
import { installLocalRearingApexModel, previewLocalRearingGeometry, previewLocalRearingPeaks, type ApexPreview, type GeometryPreview } from "./api";

type Candidate = {frameIndex:number;timestampSec:number;startSec?:number;endSec?:number;
  verification?:"consistent"|"limited"|"insufficient";reasons?:string[];score?:number;scoreKind?:string;observation?:string;
  evidence?:{axisLengthRatio:number|null}};
type Preview = {kind:"geometry";value:GeometryPreview}|{kind:"model";value:ApexPreview};
const evidenceLabels:Record<string,string>={shortened_axis:"Eixo corporal encurtado",shortened_silhouette:"Silhueta encurtada",
  compact_silhouette:"Corpo mais compacto",image_supported_head_on_wall:"Cabeça projetada na parede com apoio na imagem",
  posture_transition:"Mudança de postura",low_displacement:"Pouco deslocamento",axis_unresolved:"Skeleton sem direção confiável"};

export function RearingDetectionPanel({experimentId,trackingJobId,videoSha256,savedCandidates=[],disabled,onSeek,reviews,onReview,advancedContent}: {
  experimentId:string;trackingJobId:string;videoSha256:string;savedCandidates?:Candidate[];disabled:boolean;
  onSeek:(time:number)=>boolean;reviews:Record<number,ProposalReviewState>;
  onReview:(review:Omit<ProposalReviewInput,"annotatorId">)=>Promise<boolean>;advancedContent?:ReactNode;
}) {
  const [preview,setPreview]=useState<Preview|null>(null),[busy,setBusy]=useState(false),[error,setError]=useState<string|null>(null);
  const [modelPath,setModelPath]=useState(""),[installed,setInstalled]=useState(false);
  const [selected,setSelected]=useState<number|null>(null),[visible,setVisible]=useState(8);
  const [tags,setTags]=useState<Record<number,RearingTag>>({});
  const live=useRef(true);
  const settings=useRef<HTMLDialogElement>(null);
  useEffect(()=>{live.current=true;return()=>{live.current=false;};},[]);
  const candidates:Candidate[]=preview?.value.candidates??savedCandidates;
  async function operation(action:()=>Promise<void>) {
    setBusy(true);setError(null);
    try{await action();}catch(reason){if(live.current)setError(String(reason));}finally{if(live.current)setBusy(false);}
  }
  async function detect(kind:"geometry"|"model") {
    await operation(async()=>{
      const value:Preview=kind==="geometry"
        ? {kind,value:await previewLocalRearingGeometry(experimentId,trackingJobId,videoSha256)}
        : {kind,value:await previewLocalRearingPeaks(experimentId,trackingJobId,videoSha256,modelPath)};
      if(live.current){setPreview(value);setSelected(null);setVisible(8);}
    });
  }
  return <section className="behavior-detection" aria-label="Detector automático no estúdio">
    <div className="behavior-detection-toolbar">
      <Button size="sm" loading={busy} disabled={disabled} onClick={()=>void detect("geometry")}>Procurar rearing pelo tracking</Button>
      <Button size="sm" variant="secondary" aria-label="Configurar detecção" title="Configurar detecção" onClick={()=>settings.current?.showModal()}><Settings2 size={16} aria-hidden="true"/></Button>
    </div>
    {error&&<p role="alert" className="validation-box invalid">{error}</p>}
    <section className="behavior-automatic-results" aria-label="Propostas encontradas automaticamente">
      <div className="behavior-proposals-heading"><h4>Propostas encontradas automaticamente · {candidates.length}</h4>
        <p>Confira o vídeo e salve com ✓ ou ×.</p></div>
      <div className="behavior-evidence-proposals" role="region" aria-label="Lista de sugestões" tabIndex={0}>{candidates.slice(0,visible).map(candidate=>{
        const review=reviews[candidate.frameIndex],tag=review?.label??tags[candidate.frameIndex]??"REARING_UNSPECIFIED";
        const save=(decision:"accept"|"reject",label:RearingTag=tag)=>onReview({frameIndex:candidate.frameIndex,timestampSec:candidate.timestampSec,decision,...(decision==="accept"?{label}:{})});
        return <article key={candidate.frameIndex} className="behavior-proposal" data-review={review?.decision??"pending"} aria-label={`Sugestão em ${candidate.timestampSec.toFixed(3)} s`}>
        <Button type="button" variant="secondary"
        className="behavior-proposal-card" aria-label={`Revisar proposta em ${candidate.timestampSec.toFixed(3)} s`} aria-pressed={selected===candidate.frameIndex}
        disabled={disabled||busy} onClick={()=>{if(onSeek(candidate.timestampSec))setSelected(candidate.frameIndex);}}>
        <strong>{candidate.timestampSec.toFixed(3)} s · {candidate.verification==="consistent"?"Sinais concordantes":candidate.verification==="limited"?"Evidência limitada":candidate.observation==="UNCERTAIN"?"Tracking incerto":"Revisão necessária"}</strong>
        {!!candidate.reasons?.length&&<span>{candidate.reasons.map(reason=>evidenceLabels[reason]??reason).join(" · ")}</span>}
        {candidate.startSec!=null&&candidate.endSec!=null&&<span>Trecho sugerido: {candidate.startSec.toFixed(2)}–{candidate.endSec.toFixed(2)} s (limites estimados).</span>}
        {candidate.evidence?.axisLengthRatio!=null&&<span>Eixo corporal: {(candidate.evidence.axisLengthRatio*100).toFixed(0)}% da referência.</span>}
        {candidate.score!=null&&(preview?.kind==="model"||candidate.scoreKind==="model_score")&&<span>Score do modelo: {(candidate.score*100).toFixed(0)}% (não calibrado).</span>}
      </Button>
        <div className="behavior-proposal-review">
          <div className="behavior-proposal-actions">
            <span>{review?.decision==="accept"?"Confirmado":review?.decision==="reject"?"Rejeitado":"Pendente"}</span>
            <Button type="button" size="sm" variant="secondary" className="behavior-proposal-accept"
              aria-label={`Confirmar proposta em ${candidate.timestampSec.toFixed(3)} s`} title="Confirmar rearing" aria-pressed={review?.decision==="accept"}
              disabled={disabled||busy||review?.decision==="accept"} onClick={()=>void save("accept")}><Check size={18} aria-hidden="true"/></Button>
            <Button type="button" size="sm" variant="secondary" className="behavior-proposal-reject"
              aria-label={`Rejeitar proposta em ${candidate.timestampSec.toFixed(3)} s`} title="Não é rearing" aria-pressed={review?.decision==="reject"}
              disabled={disabled||busy||review?.decision==="reject"} onClick={()=>void save("reject")}><X size={18} aria-hidden="true"/></Button>
          </div>
          <SelectMenu label="Tag (opcional)" value={tag} disabled={disabled||busy}
            options={[{value:"REARING_UNSPECIFIED",label:"Sem tag"},{value:"REARING_SUPPORTED",label:"Com apoio"},{value:"REARING_UNSUPPORTED",label:"Sem apoio"}]}
            onChange={value=>{
              if(review?.decision==="accept")void save("accept",value as RearingTag);
              else setTags(old=>({...old,[candidate.frameIndex]:value as RearingTag}));
            }}/>
        </div>
      </article>;})}
      {!candidates.length&&<p>{preview?"Nenhuma proposta encontrada nesta busca.":"Execute a busca para localizar propostas neste tracking."}</p>}
      {visible<candidates.length&&<Button type="button" variant="secondary" size="sm" onClick={()=>setVisible(old=>old+8)}>Mostrar mais propostas</Button>}
      </div>
    </section>
    <dialog ref={settings} className="behavior-data-dialog" aria-label="Configuração da detecção"><header><h3>Configuração da detecção</h3><Button size="sm" variant="secondary" onClick={()=>settings.current?.close()}>Voltar às sugestões</Button></header>
    <p>Os candidatos são propostas para revisão humana, sem duração validada automaticamente.</p>
    {preview&&<p role="status">{preview.value.message}</p>}
    {preview?.kind==="geometry"&&preview.value.annotationComparison&&preview.value.annotationComparison.annotatedPeaks>0&&<p>
      Concordância com suas marcações: {preview.value.annotationComparison.truePositive} de {preview.value.annotationComparison.annotatedPeaks} ápices localizados (±0,5 s).
      {" "}{preview.value.annotationComparison.falsePositive} propostas sem ápice correspondente. Esta conferência no mesmo vídeo não é validação independente.
    </p>}
    {preview?.kind==="model"&&preview.value.sameTrainingVideo&&<p>Este vídeo participou do treinamento. As propostas abaixo não medem precisão em um vídeo independente.</p>}
    {preview?.value.trackingTermination&&<p>Propostas encerradas em {preview.value.trackingTermination.timestampSec.toFixed(2)} s: entrada do pesquisador.</p>}
    <details><summary>Detector com modelo local</summary>
      <p>Modelo experimental treinado com ápices humanos. As propostas exigem revisão.</p>
      <label>Pasta do modelo de ápices<input value={modelPath} disabled={disabled||busy} onChange={e=>{setModelPath(e.target.value);setInstalled(false);}} placeholder="Pasta com manifest.json e peak_model.json"/></label>
      <Button variant="secondary" loading={busy} disabled={disabled||!modelPath.trim()} onClick={()=>void detect("model")}>Detectar ápices com modelo local</Button>
      <Button variant="secondary" loading={busy} disabled={disabled||!modelPath.trim()} onClick={()=>void operation(async()=>{
        await installLocalRearingApexModel(modelPath);if(live.current)setInstalled(true);
      })}>Usar nas próximas análises locais e Colab</Button>
      {installed&&<p role="status">Modelo selecionado para novas análises de Campo Aberto. As propostas continuam pendentes de revisão.</p>}
    </details>
    {advancedContent}
    </dialog>
  </section>;
}
