import { test, expect, openExperiment } from "./desktop";

test("the studio keeps video, timeline and save actions fixed while only proposal cards scroll",async({page})=>{
  await openExperiment(page,"many-proposals");
  await page.getByRole("tab",{name:"Rearing",exact:true}).click();
  await page.getByRole("button",{name:"Abrir estúdio de anotação"}).click();
  const studio=page.getByRole("dialog",{name:"Estúdio de rearing",exact:true});
  const list=studio.getByRole("region",{name:"Lista de sugestões",exact:true});
  await expect(studio.getByRole("tab",{name:"Detecção automática",exact:true})).toHaveAttribute("aria-selected","true");
  await studio.getByRole("textbox",{name:"Anotador",exact:true}).fill("layout-reviewer");
  await studio.getByRole("button",{name:"Confirmar proposta em 0.000 s",exact:true}).click();
  await expect(studio.getByRole("article",{name:"Sugestão em 0.000 s",exact:true})).toHaveAttribute("data-review","accept");
  for(const viewport of [{width:1440,height:900},{width:980,height:620},{width:768,height:600}]){
    await page.setViewportSize(viewport);
    await expect(studio.getByRole("slider",{name:"Posição no vídeo para anotação",exact:true})).toBeInViewport();
    await expect(studio.getByRole("button",{name:"Exportar para treinamento",exact:true})).toBeInViewport();
    const before=await studio.locator(".behavior-video-stage").boundingBox();
    const sidebar=await studio.locator(".behavior-studio-sidebar").boundingBox();
    expect(sidebar!.x).toBeGreaterThanOrEqual(before!.x+before!.width);
    expect(before!.height).toBeGreaterThan(viewport.height>=900?450:230);
    for(const container of [studio,studio.locator(".behavior-studio"),studio.locator(".behavior-studio-sidebar")]){
      expect(await container.evaluate(el=>el.scrollHeight-el.clientHeight)).toBeLessThanOrEqual(1);
      expect(await container.evaluate(el=>el.scrollWidth-el.clientWidth)).toBeLessThanOrEqual(1);
    }
    expect(await list.evaluate(el=>el.scrollHeight>el.clientHeight)).toBe(true);
    await list.hover();await page.mouse.wheel(0,600);
    await expect.poll(()=>list.evaluate(el=>el.scrollTop)).toBeGreaterThan(0);
    expect(await studio.locator(".behavior-video-stage").boundingBox()).toEqual(before);
    expect(await studio.evaluate(el=>el.scrollTop)).toBe(0);
    await test.info().attach(`estudio-fixo-${viewport.width}x${viewport.height}`,{body:await studio.screenshot(),contentType:"image/png"});
    await list.evaluate(el=>{el.scrollTop=0;});
  }
});

test("proposal cards save check/X decisions, allow optional tag changes and restore them after reload",async({page})=>{
  await page.setViewportSize({width:980,height:620});
  await openExperiment(page,"saved-proposals");
  async function openStudio(){
    await page.getByRole("tab",{name:"Rearing",exact:true}).click();
    await page.getByRole("button",{name:"Abrir estúdio de anotação"}).click();
    const studio=page.getByRole("dialog",{name:"Estúdio de rearing",exact:true});
    await studio.getByRole("tab",{name:"Detecção automática",exact:true}).click();
    return studio;
  }
  let studio=await openStudio();
  await studio.getByRole("textbox",{name:"Anotador",exact:true}).fill("proposal-reviewer");
  const first=studio.getByRole("article",{name:"Sugestão em 0.400 s",exact:true});
  const second=studio.getByRole("article",{name:"Sugestão em 1.200 s",exact:true});
  await first.getByRole("button",{name:"Revisar proposta em 0.400 s",exact:true}).click();
  await first.getByRole("button",{name:"Confirmar proposta em 0.400 s",exact:true}).click();
  await expect(first.getByText("Confirmado",{exact:true})).toBeVisible();
  let annotations=await page.evaluate(()=>window.__desktopTest.annotations);
  expect(annotations.find(a=>a.type==="PEAK")).toMatchObject({frameIndex:10,timestampSec:.4,label:"REARING_UNSPECIFIED",annotatorId:"proposal-reviewer"});
  expect(annotations.filter(a=>a.type==="INTERVAL")).toHaveLength(0);
  await first.getByRole("combobox").click();
  await page.getByRole("option",{name:"Com apoio",exact:true}).click();
  await expect(first.getByRole("combobox")).toHaveText("Com apoio");
  await second.getByRole("button",{name:"Rejeitar proposta em 1.200 s",exact:true}).click();
  await expect(second.getByText("Rejeitado",{exact:true})).toBeVisible();
  await test.info().attach("revisao-rapida-dos-cards",{body:await studio.screenshot(),contentType:"image/png"});
  annotations=await page.evaluate(()=>window.__desktopTest.annotations);
  expect(annotations.filter(a=>a.type==="PEAK")).toHaveLength(1);
  expect(annotations.find(a=>a.type==="LABEL_PEAK")).toMatchObject({label:"REARING_SUPPORTED",annotatorId:"proposal-reviewer"});
  expect(annotations.find(a=>a.type==="PROPOSAL_REVIEW"&&a.decision==="reject")).toMatchObject({frameIndex:30});
  await page.reload();
  await expect(page.locator("#startup-splash")).toHaveCount(0);
  await page.getByRole("heading",{name:"Campo aberto de teste",exact:true}).click();
  studio=await openStudio();
  await expect(studio.getByRole("textbox",{name:"Anotador",exact:true})).toHaveValue("proposal-reviewer");
  const restored=studio.getByRole("article",{name:"Sugestão em 0.400 s",exact:true});
  await expect(restored.getByText("Confirmado",{exact:true})).toBeVisible();
  await expect(restored.getByRole("combobox")).toHaveText("Com apoio");
  await expect(studio.getByRole("article",{name:"Sugestão em 1.200 s",exact:true}).getByText("Rejeitado",{exact:true})).toBeVisible();
  await restored.getByRole("button",{name:"Rejeitar proposta em 0.400 s",exact:true}).click();
  await expect(restored.getByText("Rejeitado",{exact:true})).toBeVisible();
  expect((await page.evaluate(()=>window.__desktopTest.annotations)).some(a=>a.type==="UNDO")).toBe(true);
  await restored.getByRole("button",{name:"Confirmar proposta em 0.400 s",exact:true}).click();
  await expect(restored.getByText("Confirmado",{exact:true})).toBeVisible();
});

test("failed quick review stays pending and can be saved with one retry",async({page})=>{
  await openExperiment(page,"proposal-review-error");
  await page.getByRole("tab",{name:"Rearing",exact:true}).click();
  await page.getByRole("button",{name:"Abrir estúdio de anotação"}).click();
  const studio=page.getByRole("dialog",{name:"Estúdio de rearing",exact:true});
  await studio.getByRole("tab",{name:"Detecção automática",exact:true}).click();
  const card=studio.getByRole("article",{name:"Sugestão em 0.400 s",exact:true});
  const accept=card.getByRole("button",{name:"Confirmar proposta em 0.400 s",exact:true});
  await accept.click();await expect(studio.getByRole("alert")).toContainText("Informe seu identificador");
  await studio.getByRole("textbox",{name:"Anotador",exact:true}).fill("reviewer");
  await card.getByRole("combobox").click();await page.getByRole("option",{name:"Sem apoio",exact:true}).click();
  await accept.click();await expect(studio.getByRole("alert")).toContainText("Falha de teste ao salvar a revisão");
  await expect(card.getByText("Pendente",{exact:true})).toBeVisible();
  expect(await page.evaluate(()=>window.__desktopTest.annotations)).toHaveLength(0);
  await accept.click();await expect(card.getByText("Confirmado",{exact:true})).toBeVisible();
  expect((await page.evaluate(()=>window.__desktopTest.annotations)).find(a=>a.type==="PEAK")).toMatchObject({label:"REARING_UNSUPPORTED"});
});

test("saved automatic proposals are available inside the studio without running detection again",async({page})=>{
  await openExperiment(page,"saved-proposals");
  await page.getByRole("tab",{name:"Rearing",exact:true}).click();
  await page.getByRole("button",{name:"Abrir estúdio de anotação"}).click();
  const studio=page.getByRole("dialog",{name:"Estúdio de rearing",exact:true});
  await studio.getByRole("tab",{name:"Detecção automática",exact:true}).click();
  for(const time of [1.2,.4,1.2]){
    await studio.getByRole("button",{name:`Revisar proposta em ${time.toFixed(3)} s`,exact:true}).click();
    await expect(studio.getByRole("slider",{name:"Posição no vídeo para anotação"})).toHaveValue(String(time));
    await expect.poll(()=>studio.locator("video").evaluate(v=>(v as HTMLVideoElement).currentTime)).toBeCloseTo(time,3);
  }
  expect(await page.evaluate(()=>window.__desktopTest.calls.filter(c=>c.command.startsWith("preview_local_rearing")))).toEqual([]);
  expect(await page.evaluate(()=>window.__desktopTest.annotations)).toEqual([]);
});

test("reviewing a proposal preserves an unsaved human annotation until it is saved or discarded",async({page})=>{
  await openExperiment(page,"saved-proposals");
  await page.getByRole("tab",{name:"Rearing",exact:true}).click();
  await page.getByRole("button",{name:"Abrir estúdio de anotação"}).click();
  const studio=page.getByRole("dialog",{name:"Estúdio de rearing",exact:true});
  const mark=studio.getByRole("button",{name:"Marcar ápice agora (R)",exact:true});
  await expect(mark).toBeEnabled();await mark.click();
  await studio.getByRole("tab",{name:"Detecção automática",exact:true}).click();
  const card=studio.getByRole("button",{name:"Revisar proposta em 1.200 s",exact:true});
  await card.click();
  await expect(studio.getByRole("alert")).toContainText("Salve ou descarte a anotação em edição");
  await expect(card).toHaveAttribute("aria-pressed","false");
  await studio.getByRole("tab",{name:"Anotação",exact:true}).click();
  await expect(studio.getByText("Marcação ainda não salva",{exact:true})).toBeVisible();
  await studio.getByRole("button",{name:"Descartar marcação",exact:true}).click();
  await studio.getByRole("tab",{name:"Detecção automática",exact:true}).click();
  await card.click();
  await expect(studio.getByRole("slider",{name:"Posição no vídeo para anotação"})).toHaveValue("1.2");
  expect(await page.evaluate(()=>window.__desktopTest.annotations)).toEqual([]);
});

test("a failed detection reports the error inside the studio and permits retry",async({page})=>{
  await openExperiment(page,"detection-error");
  await page.getByRole("tab",{name:"Rearing",exact:true}).click();
  await page.getByRole("button",{name:"Abrir estúdio de anotação"}).click();
  const studio=page.getByRole("dialog",{name:"Estúdio de rearing",exact:true});
  await studio.getByRole("tab",{name:"Detecção automática",exact:true}).click();
  const detect=studio.getByRole("button",{name:"Procurar rearing pelo tracking",exact:true});
  await detect.click();await expect(studio.getByRole("alert")).toContainText("Falha de teste ao procurar rearing");
  await expect(detect).toBeEnabled();await detect.click();
  await expect(studio.getByRole("button",{name:"Revisar proposta em 0.800 s",exact:true})).toBeVisible();
  await expect(studio.getByRole("alert")).toHaveCount(0);
});

test("geometry proposals live beside the video and repeatedly seek the video and timeline", async ({page})=>{
  await page.setViewportSize({width:980,height:620});
  await openExperiment(page);
  await page.getByRole("tab",{name:"Rearing",exact:true}).click();
  await expect(page.getByRole("tab",{name:"2. Detecção automática",exact:true})).toHaveCount(0);
  await page.getByRole("button",{name:"Abrir estúdio de anotação"}).click();
  const studio=page.getByRole("dialog",{name:"Estúdio de rearing",exact:true});
  const sidebar=studio.getByRole("complementary",{name:"Painel de anotação e detecção"});
  await sidebar.getByRole("tab",{name:"Detecção automática",exact:true}).click();
  await sidebar.getByRole("button",{name:"Procurar rearing pelo tracking",exact:true}).click();
  const proposals=sidebar.getByRole("region",{name:"Propostas encontradas automaticamente",exact:true});
  await expect(proposals.getByText("0.800 s · Evidência limitada",{exact:true})).toBeVisible();
  await expect(proposals.getByText(/Eixo corporal encurtado · Corpo mais compacto/)).toBeVisible();
  const calls=await page.evaluate(()=>window.__desktopTest.calls);
  expect(calls.find(c=>c.command==="preview_local_rearing_geometry")?.args).toEqual({experimentId:"ui-open-field",trackingJobId:"tracking-01",videoSha256:"a".repeat(64)});
  expect(calls.some(c=>c.command==="setup_behavior_environment"||c.command==="download_behavior_model")).toBe(false);
  const card=proposals.getByRole("button",{name:"Revisar proposta em 0.800 s",exact:true});
  const slider=studio.getByRole("slider",{name:"Posição no vídeo para anotação"});
  for(let repeat=0;repeat<2;repeat++){
    await card.click();
    await expect(card).toHaveAttribute("aria-pressed","true");
    await expect.poll(()=>studio.locator("video").evaluate(v=>(v as HTMLVideoElement).currentTime)).toBeCloseTo(.8,3);
    await expect(slider).toHaveValue("0.8");
    await expect.poll(()=>studio.locator(".behavior-playhead").evaluate(e=>(e as HTMLElement).style.left)).toBe("40%");
    if(repeat===0){await slider.focus();await page.keyboard.press("Home");await expect(slider).toHaveValue("0");}
  }
  const bounds=await sidebar.boundingBox(), video=await studio.locator(".behavior-video-column").boundingBox();
  expect(bounds!.x).toBeGreaterThanOrEqual(video!.x+video!.width);
  await test.info().attach("propostas-ao-lado-do-video",{body:await studio.screenshot(),contentType:"image/png"});
  expect(await page.evaluate(()=>window.__desktopTest.annotations)).toEqual([]);
});

test("annotation studio saves human intervals, preserves undo history and releases navigation", async ({ page }) => {
  await openExperiment(page);
  await page.getByRole("tab", { name: "Rearing", exact: true }).click();
  await page.getByRole("button", { name: "Abrir estúdio de anotação" }).click();
  const studio = page.getByRole("dialog", { name: "Estúdio de rearing", exact: true });
  await expect(studio).toBeVisible();
  await studio.getByLabel("Anotador", { exact: true }).fill("annotator-01");
  await studio.getByRole("button", { name: "Anotar intervalo", exact: true }).click();
  await studio.getByLabel("Início (s)", { exact: true }).fill("0.2");
  await studio.getByLabel("Fim (s)", { exact: true }).fill("0.8");
  await studio.getByRole("button", { name: "Salvar intervalo" }).click();
  await expect(studio.getByText("Anotação salva neste computador.")).toBeVisible();
  const annotations = await page.evaluate(() => window.__desktopTest.annotations);
  expect(annotations).toHaveLength(1);
  expect(annotations[0]).toMatchObject({ type: "INTERVAL", source: "human", startSec: .2, endSec: .8,
    trackingJobId: "tracking-01", videoSha256: "a".repeat(64), annotatorId: "annotator-01" });
  await studio.getByRole("button", { name: "Desfazer último" }).click();
  await expect(studio.getByText("Marcação desfeita. O histórico foi preservado.")).toBeVisible();
  expect(await page.evaluate(() => window.__desktopTest.annotations.map(a => a.type))).toEqual(["INTERVAL", "UNDO"]);
  await studio.getByRole("button", { name: "Fechar estúdio" }).click();
  await expect(studio).not.toBeVisible();
  await page.getByRole("tab", { name: "Resumo", exact: true }).click();
  await expect(page.getByRole("tab", { name: "Resumo", exact: true })).toHaveAttribute("aria-selected", "true");
});

test("missing annotator produces an actionable error without saving or trapping the user", async ({ page }) => {
  await openExperiment(page);
  await page.getByRole("tab", { name: "Rearing", exact: true }).click();
  await page.getByRole("button", { name: "Abrir estúdio de anotação" }).click();
  const studio = page.getByRole("dialog", { name: "Estúdio de rearing", exact: true });
  await studio.getByRole("button", { name: "Anotar intervalo", exact: true }).click();
  await studio.getByLabel("Início (s)", { exact: true }).fill("0.2");
  await studio.getByLabel("Fim (s)", { exact: true }).fill("0.8");
  await studio.getByRole("button", { name: "Salvar intervalo" }).click();
  await expect(studio.getByRole("alert")).toContainText("Informe seu identificador de anotador");
  expect(await page.evaluate(() => window.__desktopTest.annotations)).toHaveLength(0);
  await page.keyboard.press("Escape");
  await expect(studio).not.toBeVisible();
  await page.getByRole("tab", { name: "Análise", exact: true }).click();
  await expect(page.getByRole("button", { name: "Analisar", exact: true })).toBeEnabled();
});

test("apex capture pauses real playback, creates a timeline bar and persists subtype changes", async ({page})=>{
  await openExperiment(page);
  await page.getByRole("tab",{name:"Rearing",exact:true}).click();
  await page.getByRole("button",{name:"Abrir estúdio de anotação"}).click();
  const studio=page.getByRole("dialog",{name:"Estúdio de rearing",exact:true});
  const video=studio.locator("video");
  await expect(studio.getByRole("slider",{name:"Posição no vídeo para anotação"})).toBeInViewport();
  await expect(studio.getByRole("region",{name:"Propostas encontradas automaticamente",exact:true})).toBeVisible();
  await studio.getByLabel("Anotador",{exact:true}).fill("observer-01");
  await studio.getByRole("button",{name:"Reproduzir",exact:true}).click();
  await expect.poll(()=>video.evaluate(v=>(v as HTMLVideoElement).currentTime)).toBeGreaterThan(.2);
  // Use the real keyboard while video frames are being presented.
  await studio.getByRole("button",{name:"Pausar",exact:true}).press("r");
  await expect.poll(()=>video.evaluate(v=>(v as HTMLVideoElement).paused)).toBe(true);
  const marker=studio.getByRole("button",{name:/^Ápice em/});
  await expect(marker).toHaveCount(1);
  await expect(marker).toHaveAttribute("aria-pressed","true");
  await expect(studio.getByText("Marcação ainda não salva",{exact:true})).toBeVisible();
  await studio.getByRole("radio",{name:"Rearing com apoio",exact:true}).check();
  await studio.getByRole("button",{name:"Salvar marcação",exact:true}).click();
  await expect(studio.getByText("Marcação salva neste computador.",{exact:true})).toBeVisible();
  await expect(marker).toHaveCount(1);
  const original=await page.evaluate(()=>window.__desktopTest.annotations[0]);
  expect(original).toMatchObject({type:"PEAK",label:"REARING_SUPPORTED",annotatorId:"observer-01"});
  expect(original.startSec).toBeUndefined();expect(original.endSec).toBeUndefined();
  expect(original.timestampSec).toBeCloseTo(Number(original.frameIndex)/25,6);
  await expect.poll(()=>video.evaluate(v=>(v as HTMLVideoElement).currentTime)).toBeCloseTo(Number(original.timestampSec),3);
  await marker.click();
  await studio.getByRole("radio",{name:"Rearing sem apoio",exact:true}).check();
  await studio.getByRole("button",{name:"Salvar marcação",exact:true}).click();
  await expect.poll(()=>page.evaluate(()=>window.__desktopTest.annotations.length)).toBe(2);
  await studio.getByRole("button",{name:"Fechar estúdio"}).click();
  await page.getByRole("button",{name:"Abrir estúdio de anotação"}).click();
  await expect(marker).toHaveAccessibleName(/Rearing sem apoio/);
  await marker.click();
  await expect(studio.getByRole("radio",{name:"Rearing sem apoio",exact:true})).toBeChecked();
  await expect(studio.locator(".behavior-transport output")).toHaveText(`${Number(original.timestampSec).toFixed(3)} s · frame ${Number(original.frameIndex)+1}`);
  await test.info().attach("apice-selecionado",{body:await studio.screenshot(),contentType:"image/png"});
  await expect(studio.getByRole("button",{name:"Exportar para treinamento",exact:true})).toBeEnabled();
  await studio.getByText("Mais opções",{exact:true}).click();await studio.getByRole("button",{name:"Exportar ápices CSV"}).click();
  await expect(studio.getByText("Arquivo salvo: /results/peaks.csv",{exact:false})).toBeVisible();
  await studio.getByRole("button",{name:"Mostrar arquivo",exact:true}).click();
  expect(await page.evaluate(()=>window.__desktopTest.calls.filter(c=>c.command==="export_behavior_annotations").at(-1)?.args.kind)).toBe("peaks");
  expect(await page.evaluate(()=>window.__desktopTest.calls.filter(c=>c.command==="reveal_behavior_export").at(-1)?.args.path)).toBe("/results/peaks.csv");
  await studio.getByRole("button",{name:"Desfazer marcação selecionada"}).click();
  await expect(marker).toHaveCount(0);
  expect(await page.evaluate(()=>window.__desktopTest.annotations.map(a=>a.type))).toEqual(["PEAK","LABEL_PEAK","UNDO"]);
});

test("model apex proposals are reviewed inside the studio without creating human annotations",async({page})=>{
  await openExperiment(page);
  await page.getByRole("tab",{name:"Rearing",exact:true}).click();
  await page.getByRole("button",{name:"Abrir estúdio de anotação"}).click();
  const studio=page.getByRole("dialog",{name:"Estúdio de rearing",exact:true});
  await studio.getByRole("tab",{name:"Detecção automática",exact:true}).click();
  await studio.getByRole("button",{name:"Configurar detecção",exact:true}).click();
  await studio.getByText("Detector com modelo local",{exact:true}).click();
  await studio.getByRole("textbox",{name:"Pasta do modelo de ápices",exact:true}).fill("/models/apex");
  await studio.getByRole("button",{name:"Detectar ápices com modelo local",exact:true}).click();
  await expect(studio.getByText("Propostas encerradas em 1.80 s: entrada do pesquisador.",{exact:true})).toBeVisible();
  await expect(studio.getByText(/Este vídeo participou do treinamento/)).toBeVisible();
  await studio.getByRole("button",{name:"Voltar às sugestões",exact:true}).click();
  await studio.getByRole("button",{name:"Revisar proposta em 0.800 s",exact:true}).click();
  await expect.poll(()=>studio.locator("video").evaluate(v=>(v as HTMLVideoElement).currentTime)).toBeCloseTo(.8,3);
  await expect(studio.getByRole("slider",{name:"Posição no vídeo para anotação"})).toHaveValue("0.8");
  expect(await page.evaluate(()=>window.__desktopTest.annotations)).toEqual([]);
});


test("a failed apex save preserves the draft and allows retry without duplicating the marker",async({page})=>{
  await openExperiment(page,"annotation-error");
  await page.getByRole("tab",{name:"Rearing",exact:true}).click();
  await page.getByRole("button",{name:"Abrir estúdio de anotação"}).click();
  const studio=page.getByRole("dialog",{name:"Estúdio de rearing",exact:true});
  await studio.getByLabel("Anotador",{exact:true}).fill("observer-02");
  const capture=studio.getByRole("button",{name:"Marcar ápice agora (R)",exact:true});
  await expect.poll(()=>studio.locator("video").evaluate(v=>(v as HTMLVideoElement).readyState),"primeiro frame decodificado sem exigir reprodução").toBeGreaterThanOrEqual(2);
  await expect(capture).toBeEnabled();await capture.click();
  const marker=studio.getByRole("button",{name:/^Ápice em/});
  await expect(marker).toHaveCount(1);
  await studio.getByRole("button",{name:"Salvar marcação",exact:true}).click();
  await expect(studio.getByRole("alert")).toContainText("Falha de teste ao salvar");
  await expect(marker).toHaveCount(1);
  await expect(studio.getByText("Marcação ainda não salva",{exact:true})).toBeVisible();
  expect(await page.evaluate(()=>window.__desktopTest.annotations)).toHaveLength(0);
  await studio.getByRole("button",{name:"Salvar marcação",exact:true}).click();
  await expect(studio.getByText("Marcação salva neste computador.",{exact:true})).toBeVisible();
  await expect(marker).toHaveCount(1);
  expect(await page.evaluate(()=>window.__desktopTest.annotations)).toHaveLength(1);
});

test("six consecutive peaks retain the annotator across tab changes after the second peak",async({page})=>{
  await openExperiment(page);
  await page.getByRole("tab",{name:"Rearing",exact:true}).click();
  await page.getByRole("button",{name:"Abrir estúdio de anotação"}).click();
  const studio=page.getByRole("dialog",{name:"Estúdio de rearing",exact:true});
  const operator=studio.getByRole("textbox",{name:"Anotador",exact:true});
  await operator.fill("session-observer");
  const timestamps=[.12,.36,.6,.84,1.08,1.32];
  for(const [index,timestamp] of timestamps.entries()){
    if(index===2||index===4){
      await studio.getByRole("button",{name:"Fechar estúdio"}).click();
      await page.getByRole("tab",{name:"Resumo",exact:true}).click();
      await page.getByRole("tab",{name:"Rearing",exact:true}).click();
      await page.getByRole("button",{name:"Abrir estúdio de anotação"}).click();
    }
    await expect(operator,`identificador preservado para o ápice ${index+1}`).toHaveValue("session-observer");
    await studio.locator("video").evaluate((node,time)=>{(node as HTMLVideoElement).currentTime=time;},timestamp);
    await expect(studio.locator(".behavior-transport output")).toHaveText(`${timestamp.toFixed(3)} s · frame ${Math.round(timestamp*25)+1}`);
    await studio.getByRole("button",{name:"Marcar ápice agora (R)",exact:true}).click();
    await studio.getByRole("button",{name:"Salvar marcação",exact:true}).click();
    await expect.poll(()=>page.evaluate(()=>window.__desktopTest.annotations.filter(e=>e.type==="PEAK").length)).toBe(index+1);
    await expect(studio.getByRole("button",{name:/^Ápice em/})).toHaveCount(index+1);
    await expect(studio.getByRole("alert")).toHaveCount(0);
  }
  const peaks=await page.evaluate(()=>window.__desktopTest.annotations.filter(e=>e.type==="PEAK"));
  expect(peaks.map(e=>e.timestampSec)).toEqual(timestamps);
  expect(peaks.every(e=>e.annotatorId==="session-observer")).toBe(true);
  expect(new Set(peaks.map(e=>e.id)).size).toBe(6);
  await studio.getByRole("button",{name:"Fechar estúdio"}).click();
});

for (const viewport of [{width:1180,height:760},{width:980,height:620},{width:768,height:600}]) {
test(`guided episode queue preserves authors and timestamps at ${viewport.width}x${viewport.height}`,async({page})=>{
 await page.setViewportSize(viewport);
 await openExperiment(page,"idle",undefined,[.8,1.4].map((time,i)=>({schemaVersion:1,id:`peak-${i}`,type:"PEAK",source:"human",experimentId:"ui-open-field",trackingJobId:"tracking-01",videoSha256:"a".repeat(64),createdAt:"2026-01-01",timestampSec:time,frameIndex:Math.round(time*25),label:"REARING_SUPPORTED",annotatorId:"original-author"})));
 await page.getByRole("tab",{name:"Rearing",exact:true}).click();await page.getByRole("button",{name:"Abrir estúdio de anotação"}).click();
 const studio=page.getByRole("dialog",{name:"Estúdio de rearing",exact:true});
 await studio.getByLabel("Anotador",{exact:true}).fill("interval-reviewer");
 await studio.getByRole("button",{name:/2. Completar episódios/}).click();
 const sidebar=studio.locator(".behavior-studio-sidebar");
 for(const button of await studio.locator(".behavior-learning-path .button").all()) expect((await button.boundingBox())!.height).toBeLessThanOrEqual(34);
 expect(await sidebar.evaluate(el=>el.scrollHeight-el.clientHeight)).toBeLessThanOrEqual(1);
 await studio.getByLabel("Início (s)",{exact:true}).fill("0.4");await studio.getByLabel("Fim (s)",{exact:true}).fill("1.0");
 await studio.getByRole("button",{name:"Salvar episódio e próximo",exact:true}).click();
 await expect(studio.getByText("Completar episódio · ápice 1.400 s",{exact:true})).toBeVisible();
 await studio.getByLabel("Início (s)",{exact:true}).fill("1.2");await studio.getByLabel("Fim (s)",{exact:true}).fill("1.6");
 await studio.getByRole("button",{name:"Salvar episódio e próximo",exact:true}).click();
 await expect(studio.getByRole("button",{name:/2. Completar episódios · 0 pendentes/})).toBeDisabled();
 const events=await page.evaluate(()=>window.__desktopTest.annotations);
 expect(events.filter(e=>e.type==="PEAK").every(e=>e.annotatorId==="original-author")).toBe(true);
 expect(events.filter(e=>e.type==="INTERVAL").map(e=>[e.peakId,e.startSec,e.endSec,e.annotatorId])).toEqual([["peak-0",.4,1,"interval-reviewer"],["peak-1",1.2,1.6,"interval-reviewer"]]);
 await test.info().attach("episodios-completos",{body:await studio.screenshot(),contentType:"image/png"});
});
}

test("hard negatives record their category and unannotated time is never filled automatically",async({page})=>{
 await openExperiment(page);await page.getByRole("tab",{name:"Rearing",exact:true}).click();await page.getByRole("button",{name:"Abrir estúdio de anotação"}).click();
 const studio=page.getByRole("dialog",{name:"Estúdio de rearing",exact:true});
 await studio.getByLabel("Anotador",{exact:true}).fill("negative-reviewer");await studio.getByRole("button",{name:"Anotar intervalo",exact:true}).click();
 await studio.getByRole("radio",{name:"Não rearing",exact:true}).check();
 await studio.getByRole("combobox",{name:"Tipo de exemplo",exact:true}).click();await page.getByRole("option",{name:"Reflexo / sombra",exact:true}).click();
 await studio.getByLabel("Início (s)",{exact:true}).fill("0.4");await studio.getByLabel("Fim (s)",{exact:true}).fill("0.8");await studio.getByRole("button",{name:"Salvar intervalo",exact:true}).click();
 await expect(studio.getByText("Anotação salva neste computador.",{exact:true})).toBeVisible();
 expect(await page.evaluate(()=>window.__desktopTest.annotations)).toEqual([expect.objectContaining({type:"INTERVAL",startSec:.4,endSec:.8,label:"NON_REARING",exampleKind:"reflection"})]);
 await studio.getByRole("button",{name:"Exportar para treinamento",exact:true}).click();await studio.getByLabel("Arena",{exact:true}).fill("arena-01");
 await studio.getByRole("button",{name:"Preparar ZIP",exact:true}).click();
 await expect(studio.getByRole("link",{name:"Baixar pacote de treinamento",exact:true})).toBeVisible();
 const exported=await page.evaluate(()=>window.__desktopTest.calls.find(c=>c.command==="export_behavior_training_package"));
 expect(exported?.args).toMatchObject({trackingJobId:"tracking-01",includeVideo:false,metadata:{animalId:"subject-01",arenaId:"arena-01"}});
});

test("interactive body points preserve source coordinates, occlusion, failed drafts and saved revisions",async({page})=>{
 await openExperiment(page,"annotation-error");await page.getByRole("tab",{name:"Rearing",exact:true}).click();await page.getByRole("button",{name:"Abrir estúdio de anotação"}).click();
 const studio=page.getByRole("dialog",{name:"Estúdio de rearing",exact:true});
 await studio.getByRole("button",{name:/4. Pontos corporais/}).click();await studio.getByLabel("Anotador",{exact:true}).fill("pose-reviewer");
 const video=studio.locator("video");await expect.poll(()=>video.evaluate(v=>(v as HTMLVideoElement).readyState)).toBeGreaterThanOrEqual(2);
 const start=studio.getByRole("button",{name:"Anotar este quadro",exact:true});await expect(start).toBeEnabled();await start.click();
 const canvas=studio.getByRole("application",{name:"Imagem para marcar pontos corporais",exact:true});
 const rect=(await canvas.boundingBox())!;const scale=Math.min(rect.width/640,rect.height/480);
 const clickAt=async(x:number,y:number)=>canvas.click({position:{x:(rect.width-640*scale)/2+x*scale,y:(rect.height-480*scale)/2+y*scale}});
 await clickAt(320,240);const initialNose={x:Number(await canvas.locator('[data-landmark="nose"]').getAttribute("cx")),y:Number(await canvas.locator('[data-landmark="nose"]').getAttribute("cy"))};await studio.getByRole("button",{name:"Ponto oculto",exact:true}).click();
 for(const [x,y] of [[340,220],[300,280],[280,310],[270,340]])await clickAt(x,y);
 await studio.getByRole("button",{name:/1. Nariz Posicionado/}).click();await canvas.focus();await page.keyboard.press("ArrowRight");
 await studio.getByRole("button",{name:"Salvar pontos corporais",exact:true}).click();
 await expect(studio.getByRole("alert")).toContainText("Falha de teste ao salvar");
 expect(await page.evaluate(()=>window.__desktopTest.annotations)).toHaveLength(0);
 await studio.getByRole("button",{name:"Salvar pontos corporais",exact:true}).click();
 await expect(studio.getByText(/Pontos salvos. Você pode revisar/)).toBeVisible();
 const [saved]=await page.evaluate(()=>window.__desktopTest.annotations);
 expect(saved).toMatchObject({type:"POSE_FRAME",annotatorId:"pose-reviewer",frameIndex:0,timestampSec:0,imageWidth:640,imageHeight:480,pose:{nose:{visibility:"visible"},left_ear:{x:null,y:null,visibility:"occluded"}}});
 const positions=saved.pose as Record<string,{x:number|null;y:number|null}>;expect(initialNose.x).toBeCloseTo(320,-1);expect(initialNose.y).toBeCloseTo(240,-1);expect(positions.nose.x).toBeCloseTo(initialNose.x+1,2);expect(positions.nose.y).toBeCloseTo(initialNose.y,2);
 await studio.getByRole("combobox",{name:"Ampliação da imagem",exact:true}).click();await page.getByRole("option",{name:"2×",exact:true}).click();
 await expect(canvas.locator('[data-landmark="nose"]')).toHaveAttribute("cx",String(positions.nose.x));
 await expect.poll(async()=>(await canvas.boundingBox())!.width).toBeGreaterThan(rect.width*1.9);
 await studio.evaluate(node=>{node.scrollTop=0;});
 await studio.locator(".behavior-annotation-form").evaluate(node=>{node.scrollTop=0;});
 const nose=canvas.locator('[data-landmark="nose"]');await expect.poll(()=>studio.locator(".behavior-pose-stage").evaluate(node=>node.scrollLeft)).toBeGreaterThan(100);await expect(nose).toBeInViewport();
 await expect.poll(()=>nose.evaluate(node=>{const r=node.getBoundingClientRect();return document.elementFromPoint(r.x+r.width/2,r.y+r.height/2)===node;})).toBe(true);
 const marker=(await nose.boundingBox())!;const expanded=(await canvas.boundingBox())!;const expandedScale=Math.min(expanded.width/640,expanded.height/480);
 await page.mouse.move(marker.x+marker.width/2,marker.y+marker.height/2);await page.mouse.down();await page.mouse.move(marker.x+marker.width/2+10*expandedScale,marker.y+marker.height/2+5*expandedScale);await page.mouse.up();
 await studio.getByRole("button",{name:"Salvar pontos corporais",exact:true}).click();
 await expect.poll(()=>page.evaluate(()=>window.__desktopTest.annotations.length)).toBe(2);
 const [first,revision]=await page.evaluate(()=>window.__desktopTest.annotations);
 expect(first).toEqual(saved);const adjusted=revision.pose as Record<string,{x:number;y:number}>;
 expect(Math.abs(adjusted.nose.x-positions.nose.x!-10)).toBeLessThan(2);expect(Math.abs(adjusted.nose.y-positions.nose.y!-5)).toBeLessThan(2);
 await studio.evaluate(node=>{node.scrollTop=0;});await studio.locator(".behavior-annotation-form").evaluate(node=>{node.scrollTop=0;});
 await test.info().attach("pontos-corporais-ampliados",{body:await studio.screenshot(),contentType:"image/png"});
 await studio.getByText("Mais opções",{exact:true}).click();await studio.getByRole("button",{name:"Exportar pontos CSV",exact:true}).click();await expect(studio.getByRole("button",{name:"Mostrar arquivo",exact:true})).toBeVisible();
 await studio.getByRole("button",{name:"Avançar um frame",exact:true}).click();await expect(studio.getByText("Volte ao quadro da anotação para posicionar os pontos.",{exact:true})).toBeVisible();
 await studio.getByRole("button",{name:"Voltar ao quadro da anotação",exact:true}).click();
 await expect(studio.getByText("Volte ao quadro da anotação para posicionar os pontos.",{exact:true})).toHaveCount(0);
 await test.info().attach("pontos-corporais",{body:await studio.screenshot(),contentType:"image/png"});
 await studio.getByRole("button",{name:"Fechar estúdio",exact:true}).click();await page.getByRole("tab",{name:"Resumo",exact:true}).click();
 await page.getByRole("tab",{name:"Rearing",exact:true}).click();await page.getByRole("button",{name:"Abrir estúdio de anotação"}).click();
 await studio.getByRole("button",{name:/4. Pontos corporais/}).click();await expect(studio.getByText(/1 quadro anotado/)).toBeVisible();
 expect(await page.evaluate(()=>window.__desktopTest.annotations)).toEqual([saved,revision]);
});
