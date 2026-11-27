import { test, expect, openExperiment, prepareDesktop } from "./desktop";

for (const scenario of ["tracking-slow","jobs-slow","model-slow"] as const) {
  test(`startup remains accessible when ${scenario} never responds`,async({page})=>{
    await prepareDesktop(page,scenario);
    await page.goto("/");
    await expect(page.locator("#startup-splash")).toHaveCount(0,{timeout:5000});
    await expect(page.locator("#root")).not.toHaveAttribute("inert", "");
    await page.getByRole("heading",{name:"Campo aberto de teste",exact:true}).click();
    await page.getByRole("tab",{name:"Análise",exact:true}).click();
    await expect(page.getByRole("button",{name:"Analisar",exact:true})).toBeVisible();
  });
}

test("a stalled splash image and video read cannot hold the application inert",async({page})=>{
  await prepareDesktop(page,"startup-slow");
  let releaseImage:(()=>Promise<void>)|undefined;
  await page.route("**/loading.gif",route=>{releaseImage=()=>route.abort();});
  await page.goto("/",{waitUntil:"domcontentloaded"});
  await expect(page.locator("#startup-splash")).toHaveCount(0,{timeout:5000});
  await expect(page.locator("#root")).not.toHaveAttribute("inert", "");
  await page.getByRole("heading",{name:"Campo aberto de teste",exact:true}).click();
  expect(await page.evaluate(()=>window.__desktopTest.contextLoaded)).not.toBe(true);
  await releaseImage?.();
});

test("a pending video read cannot block startup and completed reads are reused on navigation", async ({page}) => {
  await prepareDesktop(page,"startup-slow");
  await page.goto("/");
  await expect(page.locator("#startup-splash")).toHaveCount(0,{timeout:5000});
  await expect(page.locator("#root")).not.toHaveAttribute("inert", "");
  await expect.poll(()=>page.evaluate(()=>typeof window.__desktopTest.releaseContext)).toBe("function");
  expect(await page.evaluate(()=>window.__desktopTest.contextLoaded)).not.toBe(true);
  await page.getByRole("heading",{name:"Campo aberto de teste",exact:true}).click();
  await page.getByRole("tab",{name:"Rearing",exact:true}).click();
  await page.getByRole("button",{name:"Abrir estúdio de anotação"}).click();
  const loadingStudio=page.getByRole("dialog",{name:"Estúdio de rearing",exact:true});
  await expect(loadingStudio.getByRole("status")).toContainText("Carregando vídeo, tracking e anotações");
  await loadingStudio.getByRole("button",{name:"Fechar estúdio"}).click();
  await page.getByRole("tab",{name:"Análise",exact:true}).click();
  await expect(page.getByRole("button",{name:"Analisar",exact:true})).toBeVisible();
  await page.evaluate(()=>window.__desktopTest.releaseContext!());
  const timings:number[]=[];
  for(let visit=0;visit<3;visit++) {
    const start=Date.now();
    await page.getByRole("tab",{name:"Rearing",exact:true}).click();
    await page.getByRole("button",{name:"Abrir estúdio de anotação"}).click();
    const studio=page.getByRole("dialog",{name:"Estúdio de rearing",exact:true});
    await expect(studio.getByLabel("Anotador",{exact:true})).toBeVisible();
    timings.push(Date.now()-start);
    await studio.getByRole("button",{name:"Fechar estúdio"}).click();
    await page.getByRole("tab",{name:"Análise",exact:true}).click();
  }
  const calls=await page.evaluate(()=>window.__desktopTest.calls);
  for(const command of ["get_behavior_annotation_context","get_local_tracking_result","list_behavior_annotations","get_behavior_model_status"]) {
    expect(calls.filter(call=>call.command===command),`${command} must not repeat on navigation`).toHaveLength(1);
  }
  await test.info().attach("rearing-open-times-ms",{body:JSON.stringify(timings),contentType:"application/json"});
});

test("an unavailable source does not trap startup and its annotation error is visible", async ({page}) => {
  await openExperiment(page,"context-error");
  await page.getByRole("tab",{name:"Rearing",exact:true}).click();
  await page.getByRole("button",{name:"Abrir estúdio de anotação"}).click();
  const studio=page.getByRole("dialog",{name:"Estúdio de rearing",exact:true});
  await expect(studio.getByRole("alert")).toContainText("Vídeo original indisponível");
  await studio.getByRole("button",{name:"Fechar estúdio"}).click();
  await page.getByRole("tab",{name:"Análise",exact:true}).click();
  await expect(page.getByRole("button",{name:"Analisar",exact:true})).toBeVisible();
});

test("a fresh Google session opens the dashboard while a video read remains pending", async ({page}) => {
  await prepareDesktop(page,"fresh-login");
  await page.goto("/");
  await expect(page.getByRole("heading",{name:"Entre na sua conta",exact:true})).toBeVisible();
  await expect(page.locator("#startup-splash")).toHaveCount(0);
  await page.evaluate(()=>{
    window.__desktopTest.connected=true;
    window.dispatchEvent(new CustomEvent("behavetracker:colab-status",{detail:{connected:true,accountEmail:"researcher@example.test",eligibleGpuCount:0,runtimes:[],profiles:[]}}));
  });
  await expect(page.getByRole("heading",{name:"Campo aberto de teste",exact:true})).toBeVisible();
  await expect.poll(()=>page.evaluate(()=>typeof window.__desktopTest.releaseContext)).toBe("function");
  expect(await page.evaluate(()=>window.__desktopTest.contextLoaded)).not.toBe(true);
});
