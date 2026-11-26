import { test, expect, openExperiment } from "./desktop";

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
  await expect(studio.getByRole("button",{name:"Salvar marcação",exact:true})).toBeInViewport();
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
  await studio.getByRole("button",{name:"Exportar ápices CSV"}).click();
  await expect(studio.getByText("Arquivo salvo: /results/peaks.csv",{exact:false})).toBeVisible();
  await studio.getByRole("button",{name:"Mostrar arquivo",exact:true}).click();
  expect(await page.evaluate(()=>window.__desktopTest.calls.filter(c=>c.command==="export_behavior_annotations").at(-1)?.args.kind)).toBe("peaks");
  expect(await page.evaluate(()=>window.__desktopTest.calls.filter(c=>c.command==="reveal_behavior_export").at(-1)?.args.path)).toBe("/results/peaks.csv");
  await studio.getByRole("button",{name:"Desfazer marcação selecionada"}).click();
  await expect(marker).toHaveCount(0);
  expect(await page.evaluate(()=>window.__desktopTest.annotations.map(a=>a.type))).toEqual(["PEAK","LABEL_PEAK","UNDO"]);
});

test("local apex proposals preserve uncertainty and open review without creating human annotations",async({page})=>{
  await openExperiment(page);
  await page.getByRole("tab",{name:"Rearing",exact:true}).click();
  await page.getByRole("tab",{name:"2. Detecção automática",exact:true}).click();
  await page.getByRole("textbox",{name:"Pasta do modelo de ápices",exact:true}).fill("/models/apex");
  await page.getByRole("button",{name:"Detectar ápices com modelo local",exact:true}).click();
  await expect(page.getByText("Propostas encerradas em 1.80 s: entrada do pesquisador.",{exact:true})).toBeVisible();
  await expect(page.getByText(/Este vídeo participou do treinamento/)).toBeVisible();
  await page.getByText("Revisar propostas de ápices",{exact:true}).click();
  await page.getByRole("button",{name:"0.800 s · score 70% · tracking incerto",exact:true}).click();
  const studio=page.getByRole("dialog",{name:"Estúdio de rearing",exact:true});
  await expect(studio).toBeVisible();
  await expect.poll(()=>studio.locator("video").evaluate(v=>(v as HTMLVideoElement).currentTime)).toBeCloseTo(.8,3);
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
