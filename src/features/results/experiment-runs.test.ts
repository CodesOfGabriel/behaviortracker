import { describe, expect, it } from "vitest";
import type { Experiment } from "../../types";
import type { LocalJob } from "../local/api";
import type { ColabJob } from "../colab/analysis";
import { experimentRuns, runProcessingSeconds } from "./experiment-runs";
const experiment={id:"session",testType:"open_field"} as Experiment;
const local=(jobId:string,overrides:Partial<LocalJob>={}):LocalJob=>({jobId,experimentId:"session",state:"succeeded",error:null,
  createdAt:"2026-11-24T12:00:00Z",videoSha256:"a".repeat(64),uploadId:"upload",config:{protocol:"open_field"},report:{framesProcessed:300,elapsedSec:12.5},...overrides});
const colab=(jobId:string,overrides:Partial<ColabJob>={}):ColabJob=>({jobId,experimentId:"session",status:"succeeded",protocol:"open_field",stage:"complete",progress:100,message:"Ready",runtimeName:null,error:null,
  createdAt:"2026-11-24T10:00:00Z",updatedAt:"2026-11-24T10:03:00Z",events:[],...overrides});
describe("histórico de resultados do experimento",()=>{
  it("preserva todas as execuções locais e Colab concluídas, em ordem de data",()=>{
    const runs=experimentRuns(experiment,[local("new"),local("old",{createdAt:"2026-11-24T09:00:00Z"})],[colab("remote")]);
    expect(runs.map(run=>run.key)).toEqual(["opencv:new","colab:remote","opencv:old"]);
  });
  it("isola experimento e protocolo e exclui treino, diagnóstico e resultados ainda em execução",()=>{
    const runs=experimentRuns(experiment,[local("wrong-session",{experimentId:"other"}),local("fst",{config:{protocol:"forced_swim"}}),local("pending",{state:"running"})],
      [colab("training",{training:true}),colab("diagnostic",{diagnostic:{startSec:1,endSec:2}}),colab("ram",{protocol:"radial_arm_maze"}),colab("other",{experimentId:"other"}),colab("queued",{status:"queued"})]);
    expect(runs).toEqual([]);
  });
  it("conserva resultados Colab preservados após interrupção e protocolos legados de Campo Aberto",()=>{
    expect(experimentRuns(experiment,[local("legacy",{config:{}})],[colab("partial",{status:"failed",resultsReady:true,protocol:undefined})]).map(run=>run.jobId)).toEqual(["legacy","partial"]);
  });
  it("usa tempo registrado local e duração total Colab sem inventar tempo ausente",()=>{
    const [run]=experimentRuns(experiment,[local("cpu")],[]);expect(runProcessingSeconds(run)).toBe(12.5);
    const [remote]=experimentRuns(experiment,[],[colab("gpu")]);expect(runProcessingSeconds(remote)).toBe(180);
    const [missing]=experimentRuns(experiment,[local("missing",{report:{}})],[]);expect(runProcessingSeconds(missing)).toBeNull();
    const [invalid]=experimentRuns(experiment,[local("bad",{report:{elapsedSec:-5}})],[]);expect(runProcessingSeconds(invalid)).toBeNull();
  });
});
