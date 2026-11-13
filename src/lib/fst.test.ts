import { describe, expect, it } from "vitest";
import { displayableFstPose, FST_ENGINE, FST_VERSION, validateForcedSwim, validateTanks } from "./fst";
import { makeDemoExperiment } from "./demo-data";
import { migrateExperiment } from "../store/AppStore";
import type { ForcedSwimExperiment, TankConfig } from "../types";

const tanks: TankConfig[] = [
  { tankId:"tank_1",animalId:"animal_1",subjectId:"R1",roiPx:{x:10,y:10,width:180,height:220},revision:1 },
  { tankId:"tank_2",animalId:"animal_2",subjectId:"R2",roiPx:{x:210,y:10,width:180,height:220},revision:1 },
];
function fst(): ForcedSwimExperiment {
  return { id:"a",schemaVersion:"1.0",analysisMethodVersion:FST_VERSION,analysisEngine:FST_ENGINE,
    testType:"forced_swim",title:"Teste",subjectId:"R1",status:"draft",createdAt:"now",updatedAt:"now",
    video:{filename:"fst.mp4",sizeBytes:10,width:400,height:300,durationSec:20,fps:30,timingSource:"ffprobe"},
    subjects:[{animalId:"animal_1",subjectId:"R1"},{animalId:"animal_2",subjectId:"R2"}],
    tanks:structuredClone(tanks),annotations:[] };
}
describe("contrato FST isolado",()=>{
  it("aceita dois sujeitos em cilindros independentes sem arena",()=>{
    const experiment=fst();
    expect(validateForcedSwim(experiment)).toBeNull();
    expect("arena" in experiment).toBe(false);
    expect(experiment.analysisEngine).toBe("fst_superanimal_quadruped_v1");
  });
  it("rejeita interseção, ID duplicado, ROI pequena e limites do frame",()=>{
    expect(validateTanks([{...tanks[0],roiPx:{...tanks[0].roiPx,x:180}},tanks[1]],400,300)).toMatch(/sobrepor/);
    expect(validateTanks([tanks[0],{...tanks[1],subjectId:"R1"}],400,300)).toMatch(/distintos/);
    expect(validateTanks([{...tanks[0],roiPx:{...tanks[0].roiPx,height:100}}],400,300)).toMatch(/cilindro/);
    expect(validateTanks([{...tanks[0],roiPx:{...tanks[0].roiPx,x:390}}],400,300)).toMatch(/dentro/);
  });
  it("migra OFT legado sem mudar arena nem método FST",()=>{
    const oft=makeDemoExperiment();
    const legacy={...oft,analysisMethodVersion:undefined,corrections:undefined} as unknown as typeof oft;
    const loaded=migrateExperiment(legacy);
    expect(loaded.testType).toBe("open_field");
    if(loaded.testType==="open_field"){
      expect(loaded.analysisMethodVersion).toBe("oft-0.2");
      expect(loaded.arena).toEqual(oft.arena);
    }
    const current=migrateExperiment(fst());
    expect(current.analysisMethodVersion).toBe("fst-0.1");
    expect("arena" in current).toBe(false);
  });
  it("não mostra tracking sem presença confirmada, mesmo com pontos válidos",()=>{
    const point={xPx:50,yPx:50,likelihood:.98};
    expect(displayableFstPose(point,tanks[0],"IN_TANK")).toBe(true);
    expect(displayableFstPose(point,tanks[0],"NOT_IN_TANK")).toBe(false);
    expect(displayableFstPose(point,tanks[0],"UNCERTAIN")).toBe(false);
    expect(displayableFstPose({...point,xPx:205},tanks[0],"IN_TANK")).toBe(false);
  });
});
