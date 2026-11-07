// Teste visual local com Chrome isolado; não usa Tauri, contas Google ou vídeo real.
import assert from "node:assert/strict";
import { spawn } from "node:child_process";
import { mkdtemp, readFile, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";

const directory = await mkdtemp(join(tmpdir(), "behavetracker-arena-ui-"));
const browser = spawn(process.env.BEHAVETRACKER_BROWSER_BIN ?? "/Applications/Google Chrome.app/Contents/MacOS/Google Chrome", [
  "--headless=new", "--disable-gpu", "--no-first-run", "--no-default-browser-check",
  "--remote-debugging-port=0", `--user-data-dir=${join(directory, "profile")}`,
], { stdio: "ignore" });
let ws;
let nextId = 0;
const pending = new Map();
const errors = [];
const pause = (ms) => new Promise((resolve) => setTimeout(resolve, ms));

async function command(method, params = {}) {
  const id = ++nextId;
  return new Promise((resolve, reject) => {
    const timeout = setTimeout(() => { pending.delete(id); reject(new Error(`Timeout: ${method}`)); }, 15000);
    pending.set(id, { resolve: (value) => { clearTimeout(timeout); resolve(value); }, reject });
    ws.send(JSON.stringify({ id, method, params }));
  });
}

async function evaluate(expression) {
  const value = await command("Runtime.evaluate", { expression, returnByValue: true, awaitPromise: true });
  if (value.exceptionDetails) throw new Error(value.exceptionDetails.exception?.description ?? value.exceptionDetails.text);
  return value.result.value;
}

async function waitFor(expression) {
  for (let attempt = 0; attempt < 100; attempt++) {
    if (await evaluate(expression)) return;
    await pause(100);
  }
  throw new Error(`Timeout aguardando: ${expression}`);
}

const button = (label) => `Array.from(document.querySelectorAll('button')).find(b => b.getClientRects().length && b.textContent.trim() === ${JSON.stringify(label)})`;
async function click(label) {
  await waitFor(`${button(label)} && !${button(label)}.disabled`);
  await evaluate(`${button(label)}.click()`);
}

try {
  browser.on("error", (error) => errors.push(error.message));
  let port;
  for (let attempt = 0; attempt < 150; attempt++) {
    try { [port] = (await readFile(join(directory, "profile/DevToolsActivePort"), "utf8")).split("\n"); break; }
    catch { await pause(100); }
  }
  assert.ok(port, "Chrome não disponibilizou a porta de depuração");
  const target = await (await fetch(`http://127.0.0.1:${port}/json/new?about:blank`, { method: "PUT" })).json();
  ws = new WebSocket(target.webSocketDebuggerUrl);
  await new Promise((resolve) => ws.addEventListener("open", resolve, { once: true }));
  ws.addEventListener("message", ({ data }) => {
    const value = JSON.parse(data);
    if (value.id && pending.has(value.id)) {
      const callback = pending.get(value.id);
      pending.delete(value.id);
      if (value.error) callback.reject(new Error(JSON.stringify(value.error)));
      else callback.resolve(value.result);
    }
    if (value.method === "Runtime.exceptionThrown") errors.push(value.params.exceptionDetails.exception?.description ?? value.params.exceptionDetails.text);
  });
  await command("Page.enable");
  await command("Runtime.enable");
  await command("Emulation.setDeviceMetricsOverride", { width: 1440, height: 1080, deviceScaleFactor: 1, mobile: false });
  await command("Page.navigate", { url: process.env.BEHAVETRACKER_PREVIEW_URL ?? "http://127.0.0.1:1420" });
  await click("Novo experimento");
  await waitFor(`!!document.querySelector('input[placeholder="Ex.: RAT_001"]')`);
  await evaluate(`(() => { const input = document.querySelector('input[placeholder="Ex.: RAT_001"]'); Object.getOwnPropertyDescriptor(HTMLInputElement.prototype, 'value').set.call(input, 'ARENA_UI_TEST'); input.dispatchEvent(new Event('input', {bubbles:true})); })()`);
  await click("Continuar");
  await click("ou usar uma arena sintética");
  await click("Continuar");
  await waitFor(`!!document.querySelector('.arena-layer-selector')`);
  assert.equal(await evaluate(`document.querySelectorAll('.arena-layer-selector button').length`), 2);
  assert.ok(await evaluate(`${button("Continuar")}.disabled`));
  assert.ok(await evaluate(`document.querySelector('.arena-layer-selector button').getAttribute('aria-pressed') === 'true'`));
  const before = await evaluate(`document.querySelector('.arena-handle').getAttribute('transform')`);
  // Força letterboxing: o arraste precisa usar a transformação SVG, não a caixa CSS.
  const position = await evaluate(`(() => { const svg = document.querySelector('.arena-editor-frame svg'); svg.style.height = '550px'; const g = document.querySelector('.arena-handle'); g.scrollIntoView({block:'center'}); const m = g.getScreenCTM(); const t = g.transform.baseVal.consolidate().matrix; return {x:m.e,y:m.f,a:m.a,d:m.d,originalX:t.e,originalY:t.f}; })()`);
  await command("Input.dispatchMouseEvent", { type: "mousePressed", x: position.x, y: position.y, button: "left", clickCount: 1 });
  await command("Input.dispatchMouseEvent", { type: "mouseMoved", x: position.x + 12, y: position.y + 8, button: "left", buttons: 1 });
  await command("Input.dispatchMouseEvent", { type: "mouseReleased", x: position.x + 12, y: position.y + 8, button: "left" });
  await waitFor(`document.querySelector('.arena-handle').getAttribute('transform') !== ${JSON.stringify(before)}`);
  const moved = await evaluate(`(() => { const t = document.querySelector('.arena-handle').transform.baseVal.consolidate().matrix; return {x:t.e,y:t.f}; })()`);
  assert.ok(Math.abs(moved.x - position.originalX - 12 / position.a) < .01);
  assert.ok(Math.abs(moved.y - position.originalY - 8 / position.d) < .01);
  await evaluate(`document.querySelector('.arena-editor-frame svg').style.height = ''`);
  await click("Confirmar borda");
  await waitFor(`document.querySelectorAll('.arena-layer-selector button')[1].getAttribute('aria-pressed') === 'true'`);
  assert.ok(await evaluate(`${button("Continuar")}.disabled`));
  await click("Confirmar chão");
  await waitFor(`!${button("Continuar")}.disabled`);
  // Alterar um vértice invalida a confirmação daquela área, não da outra.
  await evaluate(`document.querySelector('.arena-handle').focus()`);
  await command("Input.dispatchKeyEvent", { type: "keyDown", key: "ArrowRight", code: "ArrowRight", windowsVirtualKeyCode: 39 });
  await command("Input.dispatchKeyEvent", { type: "keyUp", key: "ArrowRight", code: "ArrowRight", windowsVirtualKeyCode: 39 });
  await waitFor(`${button("Continuar")}.disabled`);
  assert.ok(await evaluate(`document.querySelectorAll('.arena-layer-selector button')[0].textContent.includes('Confirmado')`));
  await click("Confirmar chão");
  const desktop = await command("Page.captureScreenshot", { format: "png", captureBeyondViewport: true });
  await writeFile(join(directory, "desktop.png"), Buffer.from(desktop.data, "base64"));
  await command("Emulation.setDeviceMetricsOverride", { width: 390, height: 844, deviceScaleFactor: 1, mobile: false });
  await pause(150);
  assert.ok(await evaluate(`document.documentElement.scrollWidth <= innerWidth`), "Overflow horizontal no celular");
  const mobile = await command("Page.captureScreenshot", { format: "png", captureBeyondViewport: true });
  await writeFile(join(directory, "mobile.png"), Buffer.from(mobile.data, "base64"));
  await click("Continuar");
  await click("Criar e abrir editor");
  await waitFor(`!!document.querySelector('.tracking-overlay')`);
  const experiment = await evaluate(`JSON.parse(localStorage.getItem('behavetracker.experiments.v1'))[0]`);
  assert.equal(experiment.arena.cornersPx.length, 4);
  assert.equal(experiment.arena.rimCornersPx.length, 4);
  assert.notDeepEqual(experiment.arena.cornersPx, experiment.arena.rimCornersPx);
  assert.equal(experiment.subjectId, "ARENA_UI_TEST");
  assert.ok(await evaluate(`!!document.querySelector('.tracking-overlay polygon[stroke="#bb9aff"]')`));
  await click("Vídeo do DeepLabCut");
  await waitFor(`!!document.querySelector('.dlc-video-panel')`);
  assert.ok(await evaluate(`!document.querySelector('.tracking-overlay')`), "O vídeo bruto do DLC não pode mostrar correções do editor");
  assert.ok(await evaluate(`document.querySelector('.dlc-video-panel').textContent.includes('sem correções do editor')`));
  assert.ok(await evaluate(`!${button("Confirmar ponto após revisar")}`));
  await click("Editor");
  await waitFor(`!!document.querySelector('.tracking-overlay')`);
  assert.ok(await evaluate(`document.querySelector('.behavior-review').getClientRects().length===0`),'Comportamentos não devem poluir a aba de correção');
  await click('Comportamentos');
  await waitFor(`!!document.querySelector('.behavior-review')`);
  // Episódios precisos, erros de intervalo e undo auditável, sem contas externas.
  await click("Confirmar episódio");
  await waitFor(`!!document.querySelector('.behavior-review [role="alert"]')`);
  const setField = async (selector, value, kind = "input") => evaluate(`(() => {
    const input = document.querySelector(${JSON.stringify(selector)});
    Object.getOwnPropertyDescriptor(${kind === "select" ? "HTMLSelectElement" : "HTMLInputElement"}.prototype, 'value').set.call(input, ${JSON.stringify(String(value))});
    input.dispatchEvent(new Event(${JSON.stringify(kind === "select" ? "change" : "input")}, {bubbles:true}));
  })()`);
  await setField('[aria-label="Comportamento"]', "grooming", "select");
  await setField('[aria-label="Início do comportamento"]', .125);
  await setField('[aria-label="Fim do comportamento"]', 2.25);
  await click("Confirmar episódio");
  await waitFor(`document.querySelector('.behavior-summary').textContent.includes('Grooming · 1 episódio(s) · 2.13 s')`);
  await click("Desfazer");
  await waitFor(`document.querySelector('.behavior-summary').textContent.includes('Grooming · não anotado')`);
  for (const label of ["rearing", "grooming", "freezing"]) {
    await setField('[aria-label="Comportamento"]', label, "select");
    await click("Confirmar episódio");
    await waitFor(`JSON.parse(localStorage.getItem('behavetracker.experiments.v1'))[0].corrections.filter(e => e.type === 'ANNOTATE_BEHAVIOR' && e.label === ${JSON.stringify(label)}).length >= 1`);
  }
  await click("Bruto");
  assert.ok(await evaluate(`${button("Confirmar episódio")}.disabled`));
  await click("Revisado");
  await command("Emulation.setDeviceMetricsOverride", { width: 1440, height: 1080, deviceScaleFactor: 1, mobile: false });
  const reviewScreen = await command("Page.captureScreenshot", { format: "png", captureBeyondViewport: true });
  await writeFile(join(directory, "behavior-editor.png"), Buffer.from(reviewScreen.data, "base64"));
  await click("Ver resultados");
  await waitFor(`document.querySelectorAll('.behavior-result-grid article').length === 3`);
  assert.ok(await evaluate(`document.querySelectorAll('.behavior-result-grid article')[2].textContent.includes('1 episódio(s)')`));
  assert.ok(await evaluate(`document.querySelector('.behavior-results').textContent.includes('Revisão parcial')`));
  const resultsScreen = await command("Page.captureScreenshot", { format: "png", captureBeyondViewport: true });
  await writeFile(join(directory, "behavior-results.png"), Buffer.from(resultsScreen.data, "base64"));
  // MP4 real para testar o player; todas as chamadas nativas abaixo são falsas.
  const clipPath = join(directory, "playback-fixture.mp4");
  const encoder = spawn(process.env.BEHAVETRACKER_FFMPEG ?? "/usr/local/bin/ffmpeg", ["-v", "error", "-f", "lavfi", "-i", "testsrc2=size=160x120:rate=24", "-t", "1", "-c:v", "libx264", "-pix_fmt", "yuv420p", "-movflags", "+faststart", clipPath], { stdio: "ignore" });
  await new Promise((resolve, reject) => { encoder.once("error", reject); encoder.once("exit", (code) => code === 0 ? resolve() : reject(new Error(`FFmpeg fixture: ${code}`))); });
  const clipBase64 = (await readFile(clipPath)).toString("base64");
  const pngPath=join(directory,"annotation-fixture.png");
  const pngEncoder=spawn(process.env.BEHAVETRACKER_FFMPEG??"/usr/local/bin/ffmpeg",["-v","error","-i",clipPath,"-frames:v","1",pngPath],{stdio:"ignore"});
  await new Promise((resolve,reject)=>{pngEncoder.once("error",reject);pngEncoder.once("exit",code=>code===0?resolve():reject(new Error("PNG fixture failed")));});
  const pngBase64=(await readFile(pngPath)).toString("base64");
  await command("Page.addScriptToEvaluateOnNewDocument", { source: `(() => {
    const saved = JSON.parse(localStorage.getItem('behavetracker.experiments.v1'))[0];
    saved.video.timingSource = 'browser-estimate'; saved.video.durationSec = 1;
    if(!sessionStorage.getItem('mock-native-initialized')) {saved.corrections=[];delete saved.trackingSelection;delete saved.trackingReviews;delete saved.legacyReviewSource;sessionStorage.setItem('mock-native-initialized','yes');}
    saved.video.sizeBytes = ${Buffer.from(clipBase64,"base64").length};
    saved.video.preparation = {uploadId:'local-prepared-fixture',originalBytes:100,uploadBytes:100,status:'original',message:'Fixture',policyVersion:'lossless-upload-1',pixelVerified:false,frameCount:null};
    localStorage.setItem('behavetracker.experiments.v1', JSON.stringify([saved]));
    const url = URL.createObjectURL(new Blob([Uint8Array.from(atob(${JSON.stringify(clipBase64)}), c => c.charCodeAt(0))], {type:'video/mp4'}));
    const job = {jobId:'local-video-fixture',experimentId:saved.id,status:'succeeded',stage:'completed',progress:100,message:'Fixture',runtimeName:null,error:null,createdAt:new Date().toISOString(),updatedAt:new Date().toISOString(),events:[]};
    const diagnostic = {...job,jobId:'local-diagnostic-fixture',diagnostic:{startSec:0,endSec:1}};
    const localJob={jobId:'macro-fixture',experimentId:saved.id,state:'succeeded',createdAt:job.createdAt,config:{mode:'light'},report:{framesProcessed:24,totalFrames:24,observationCoveragePct:95}};
    const localSamples=Array.from({length:24},(_,i)=>({frameIndex:i,timestampSec:i/24,keypoint:'box_center',xPx:i===1?null:410+i,yPx:i===1?null:400,status:i===1?'missing':'valid',source:'segmented',likelihood:0,metricReference:'box_center',referenceApproved:false,spatialRegion:'floor',bbox:i===1?undefined:{x:380+i,y:380,width:60,height:40}}));
    const frames = Array.from({length:24},(_,i) => ({frameIndex:i,timestampSec:i/24,state:i===0?'detector_missing':i===1?'pose_missing':i===2?'center_missing':'points_available',bbox:i===0?null:{x:20,y:25,width:100,height:75,score:.9},availablePoints:i<2?0:i===2?1:3,strongPoints:i<2?0:i===2?1:3,totalPoints:3,canonicalCenterAvailable:i>=3}));
    const report = {schemaVersion:1,selection:{startSec:0,endSec:1},fps:24,durationSec:1,geometry:{videoWidth:160,videoHeight:120},frames,timings:{modelLoadSec:.3,decodeSec:.1,detectorSec:2,poseSec:1,exportSec:.1,totalSec:3.5},summary:{frameCount:24,states:{detector_missing:1,pose_missing:1,center_missing:1,points_available:21},detectorCoveragePct:100*23/24,centerCoveragePct:87.5,accuracyMeasured:false},warning:'Fixture'};
    const raw = 'frame_index,timestamp_sec,keypoint,x_px,y_px,likelihood,status\\n' + frames.flatMap((f) => ['nose','mid_back','hip'].map((name,n) => [f.frameIndex,f.timestampSec,name,f.frameIndex<2?'':80+n*10,f.frameIndex<2?'':50+n*10,f.frameIndex<2?0:.9,f.frameIndex<2?'missing':'valid'].join(','))).join('\\n');
    window.__MOCK_CALLS = [];
    window.__CACHE_AVAILABLE = true;
    window.__TRAINING={frames:[],intervals:[],runs:[],activeModelId:null};
    const landmarks=['nose','left_ear','right_ear','neck','mid_back','hip','tail_base','left_forepaw','right_forepaw'];
    const annotationImage='data:image/png;base64,'+${JSON.stringify(pngBase64)};
    let mockJobs = [diagnostic,job];
    window.__TAURI_EVENT_PLUGIN_INTERNALS__ = {unregisterListener: () => {}};
    window.__TAURI_INTERNALS__ = {
      transformCallback: () => 1, unregisterCallback: () => {}, convertFileSrc: () => url,
      invoke: async (name,args) => {
        window.__MOCK_CALLS.push({name,args});
        if (name.startsWith('plugin:event|')) return 1;
        if (name === 'get_google_oauth_config') return {connected:false,eligibleGpuCount:0,providerError:null};
        if (name === 'get_training_state') return JSON.parse(JSON.stringify(window.__TRAINING));
        if (name === 'save_training_intervals') {window.__TRAINING.intervals=args.intervals;return;}
        if (name === 'get_training_image') return annotationImage;
        if (name === 'extract_training_frame') {
          let frame=window.__TRAINING.frames.find(f=>f.frameIndex===args.frameIndex);
          if(!frame){frame={id:'annotation-'+args.frameIndex,experimentId:saved.id,subjectId:saved.subjectId,videoSha256:'fake-video-sha',imageSha256:'fake-image-sha',width:160,height:120,frameIndex:args.frameIndex,timestampSec:args.frameIndex/24,bbox:null,keypoints:Object.fromEntries(landmarks.map(n=>[n,{state:'unlabeled',x:null,y:null}])),context:'other',split:'train',reviewed:false,updatedAt:''};window.__TRAINING.frames.push(frame);}
          return {frame:JSON.parse(JSON.stringify(frame)),imageUrl:annotationImage};
        }
        if (name === 'save_training_frame') {window.__TRAINING.frames=window.__TRAINING.frames.map(f=>f.id===args.frame.id?args.frame:f);return;}
        if (name === 'list_colab_jobs') return mockJobs;
        if (name === 'list_local_tracking_jobs') return [localJob,{...localJob,jobId:'broken-local-fixture'}];
        if (name === 'get_local_tracking_environment') return {ready:true,version:'test'};
        if (name === 'get_local_tracking_updates') return args.offset ? {offset:24,samples:[]} : {offset:24,samples:localSamples};
        if (name === 'get_local_tracking_result') {if(args.jobId==='broken-local-fixture')throw new Error('Fixture unavailable');return localSamples;}
        if (name === 'check_video_staging') return window.__CACHE_AVAILABLE;
        if (name === 'get_colab_diagnostic_result') return {report,rawPoseCsv:raw,clipPath:'/fake/results/clip.mp4'};
        if (name === 'begin_video_staging') return {uploadId:'local-staged-fixture'};
        if (name === 'append_video_staging_chunk' || name === 'finish_video_staging') return {};
        if (name === 'start_colab_analysis') { const next = {...diagnostic,jobId:'new-diagnostic',status:'queued',stage:'queued',diagnostic:args.request.diagnostic}; mockJobs=[next,...mockJobs]; return next; }
        if (name === 'get_colab_job_video') return {jobId:job.jobId,videoPath:'/fake/results/dlc.mp4',videoError:null};
        if (name === 'get_colab_job_result') return 'frame_index,timestamp_sec,keypoint,x_px,y_px,likelihood,status\\n0,0,body_center,400,400,.9,valid\\n1,.041667,nose,700,500,.9,valid\\n2,.083333,body_center,420,400,.9,valid';
        throw new Error('Chamada nativa inesperada: ' + name);
      }
    };
  })();` });
  await command("Page.reload");
  await waitFor(`!!document.querySelector('.experiment-row')`);
  await evaluate(`document.querySelector('.experiment-row').click()`);
  await waitFor(`!!document.querySelector('.tracking-overlay')`);
  // Linha do centro omitida no frame 1: o usuário pode posicionar sem CSV nem treino.
  await evaluate(`document.querySelector('[title="Próximo frame"]').click()`);
  await waitFor(`document.querySelector('.stage-badges').textContent.includes('Frame 1')`);
  assert.equal(await evaluate(`document.querySelector('.tracking-point[data-keypoint="body_center"]')`),null);
  assert.ok(await evaluate(`document.querySelector('.review-feedback').textContent.includes('Não mensurável')`));
  const editorPoint=async(x,y)=>evaluate(`(()=>{const svg=document.querySelector('.tracking-overlay');svg.scrollIntoView({block:'center'});const p=new DOMPoint(${x},${y}).matrixTransform(svg.getScreenCTM());return {x:p.x,y:p.y};})()`);
  const moveMouse=async(from,to)=>{
    await command('Input.dispatchMouseEvent',{type:'mousePressed',...from,button:'left',clickCount:1});
    await command('Input.dispatchMouseEvent',{type:'mouseMoved',...to,button:'left',buttons:1});
    await command('Input.dispatchMouseEvent',{type:'mouseReleased',...to,button:'left'});
  };
  await moveMouse(await editorPoint(405,395),await editorPoint(410,400));
  await waitFor(`document.querySelector('.tracking-point[data-keypoint="body_center"]')?.getAttribute('aria-label').includes('manualmente')`);
  const firstMove=await evaluate(`JSON.parse(localStorage.getItem('behavetracker.experiments.v1'))[0].corrections.at(-1)`);
  assert.equal(firstMove.frameIndex,1);
  assert.equal(firstMove.before,null);
  assert.ok(Math.abs(firstMove.after.x-410)<.01);
  await waitFor(`!document.querySelector('.review-feedback').textContent.includes('Não mensurável')`);
  const repairedMetrics=await evaluate(`document.querySelector('.review-feedback').textContent`);
  assert.ok(repairedMetrics.includes('100.0%'),'Centro recolocado deve restaurar cobertura dos pares adjacentes');
  await moveMouse(await editorPoint(410,400),await editorPoint(410,440));
  await waitFor(`document.querySelector('.review-feedback').textContent!==${JSON.stringify(repairedMetrics)}`);
  const countBeforeClick=await evaluate(`JSON.parse(localStorage.getItem('behavetracker.experiments.v1'))[0].corrections.length`);
  await moveMouse(await editorPoint(410,440),await editorPoint(410,440));
  assert.equal(await evaluate(`JSON.parse(localStorage.getItem('behavetracker.experiments.v1'))[0].corrections.length`),countBeforeClick,'Clicar sem mover não pode confirmar um ponto acidentalmente');
  await click('Histórico');
  await waitFor(`document.querySelectorAll('.correction-history article').length===2`);
  await click('Desfazer correção');
  await waitFor(`document.querySelectorAll('.correction-history article').length===1`);
  await click('Correção');
  await click('Bruto');
  assert.equal(await evaluate(`document.querySelector('.tracking-point[data-keypoint="body_center"]')`),null,'Bruto não pode ganhar a parte criada manualmente');
  await click('Revisado');
  assert.ok(await evaluate(`!!document.querySelector('.tracking-point[data-keypoint="body_center"]')`));
  const cleanEditor=await command('Page.captureScreenshot',{format:'png',captureBeyondViewport:true});
  await writeFile(join(directory,'tabbed-manual-correction.png'),Buffer.from(cleanEditor.data,'base64'));
  await click('Ver resultados');
  await waitFor(`!!document.querySelector('.metric-card strong')`);
  const correctedDistance=await evaluate(`document.querySelector('.metric-card strong').textContent`);
  assert.notEqual(correctedDistance,'Não mensurável');
  await click('Dados brutos');
  assert.equal(await evaluate(`document.querySelector('.metric-card strong').textContent`),'Não mensurável');
  await click('Dados revisados');
  assert.equal(await evaluate(`document.querySelector('.metric-card strong').textContent`),correctedDistance);
  await click('Voltar ao editor');
  await waitFor(`!!document.querySelector('.tracking-overlay')`);
  await click("Vídeo do DeepLabCut");
  await waitFor(`document.querySelector('.dlc-video-panel video')?.readyState >= 2`);
  assert.equal(await evaluate(`document.querySelector('.dlc-video-panel video').videoWidth`), 160);
  await evaluate(`(() => { const video = document.querySelector('.dlc-video-panel video'); video.muted = true; return video.play(); })()`);
  await waitFor(`document.querySelector('.dlc-video-panel video').currentTime > .1`);
  await evaluate(`document.querySelector('.dlc-video-panel video').pause()`);
  assert.ok(await evaluate(`!document.querySelector('.tracking-overlay')`));
  const videoScreen = await command("Page.captureScreenshot", { format: "png", captureBeyondViewport: true });
  await writeFile(join(directory, "dlc-video-playback.png"), Buffer.from(videoScreen.data, "base64"));
  await click("Editor");
  await click("Testar rastreamento");
  await waitFor(`!!document.querySelector('.diagnostic-player video')`);
  await waitFor(`document.querySelector('.diagnostic-player video').readyState >= 2`);
  assert.equal(await evaluate(`document.querySelector('.diagnostic-stats').textContent.includes('87.5%')`), true);
  assert.equal(await evaluate(`document.querySelector('.diagnostic-player svg').getAttribute('viewBox')`), '0 0 160 120');
  assert.equal(await evaluate(`document.querySelector('.diagnostic-player svg rect')`), null);
  await evaluate(`document.querySelector('.diagnostic-player video').currentTime = 3/24`);
  await waitFor(`document.querySelectorAll('.diagnostic-player svg circle').length === 3`);
  assert.equal(await evaluate(`document.querySelector('.diagnostic-player svg rect').getAttribute('x')`), '20');
  assert.ok(await evaluate(`!document.querySelector('.tracking-overlay')`), 'Diagnóstico deve ocupar sua própria aba sem misturar ferramentas');
  assert.equal(await evaluate(`window.__MOCK_CALLS.filter(c => c.name === 'get_colab_job_result').some(c => c.args.jobId === 'local-diagnostic-fixture')`), false, 'Pontos brutos de diagnóstico não podem virar métricas do experimento');
  await setField('[aria-label="Fim do diagnóstico"]',61);
  assert.ok(await evaluate(`${button("Testar trecho no Colab")}.disabled`));
  await setField('[aria-label="Fim do diagnóstico"]',.5);
  assert.ok(await evaluate(`!${button("Testar trecho no Colab")}.disabled`));
  const diagnosticScreen = await command('Page.captureScreenshot',{format:'png',captureBeyondViewport:true});
  await writeFile(join(directory,'tracking-diagnostic.png'),Buffer.from(diagnosticScreen.data,'base64'));
  await command('Emulation.setDeviceMetricsOverride',{width:390,height:844,deviceScaleFactor:1,mobile:false});
  assert.ok(await evaluate(`document.querySelector('.diagnostic-panel').scrollWidth <= document.querySelector('.diagnostic-panel').clientWidth + 1`),'Overflow interno no painel diagnóstico');
  await command('Emulation.setDeviceMetricsOverride',{width:1440,height:1080,deviceScaleFactor:1,mobile:false});
  await evaluate(`window.__CACHE_AVAILABLE = false`);
  const preserved = await evaluate(`JSON.stringify(JSON.parse(localStorage.getItem('behavetracker.experiments.v1'))[0].corrections)`);
  await click('Testar trecho no Colab');
  await waitFor(`!!${button('Selecionar vídeo original')}`);
  assert.equal(await evaluate(`window.__MOCK_CALLS.filter(c=>c.name === 'start_colab_analysis').length`),0,'Cache ausente não pode criar job nem enviar vídeo');
  assert.equal(await evaluate(`JSON.stringify(JSON.parse(localStorage.getItem('behavetracker.experiments.v1'))[0].corrections)`),preserved);
  const dom = await command('DOM.getDocument');
  const fileInput = await command('DOM.querySelector',{nodeId:dom.root.nodeId,selector:'.tracking-page input[type=file]'});
  await command('DOM.setFileInputFiles',{nodeId:fileInput.nodeId,files:[clipPath]});
  await click('Testar trecho no Colab');
  await waitFor(`window.__MOCK_CALLS.some(c => c.name === 'start_colab_analysis')`);
  const startedRequest = await evaluate(`window.__MOCK_CALLS.find(c => c.name === 'start_colab_analysis').args.request`);
  assert.deepEqual(startedRequest.diagnostic,{startSec:0,endSec:.5});
  assert.equal(startedRequest.uploadId,'local-staged-fixture');
  assert.equal(await evaluate(`JSON.parse(localStorage.getItem('behavetracker.experiments.v1'))[0].video.preparation.uploadId`),'local-staged-fixture');
  assert.equal(startedRequest.workload.durationSec,1);
  await waitFor(`${button('Reprocessar no Colab')}.disabled`);
  assert.equal(await evaluate(`window.__MOCK_CALLS.filter(c => c.name === 'start_colab_analysis' && !c.args.request.diagnostic).length`),0);
  await click('Ensinar o modelo');
  await waitFor(`!document.querySelector('.training-panel').hidden`);
  assert.equal(await evaluate(`Array.from(document.querySelectorAll('.training-panel [role=tabpanel]')).filter(p=>p.getClientRects().length).length`),1,'Trechos, anotações e versões não podem aparecer empilhados');
  await click('Nas duas patas');
  assert.equal(await evaluate(`document.querySelector('[aria-label="Início do trecho de treino"]')`),null,'Não deve pedir digitação dos tempos');
  const timelinePoint=async(time,lane='.range-draft-track')=>{
    await evaluate(`new Promise(resolve=>requestAnimationFrame(()=>requestAnimationFrame(()=>resolve(true))))`);
    return evaluate(`(()=>{const track=document.querySelector(${JSON.stringify(lane)}),scroller=document.querySelector('.range-scroll'),left=scroller.scrollLeft;track.scrollIntoView({block:'center',inline:'nearest'});scroller.scrollLeft=left;const rect=track.getBoundingClientRect();return {x:rect.left+rect.width*${time},y:rect.top+rect.height/2};})()`);
  };
  const drag=async(from,to)=>{
    await command('Input.dispatchMouseEvent',{type:'mousePressed',...from,button:'left',clickCount:1});
    await command('Input.dispatchMouseEvent',{type:'mouseMoved',...to,button:'left',buttons:1});
    await command('Input.dispatchMouseEvent',{type:'mouseReleased',...to,button:'left'});
  };
  // Seleção invertida com mouse, sem campos de início/fim.
  await drag(await timelinePoint(.5),await timelinePoint(0));
  await waitFor(`Math.abs(Number(document.querySelector('[aria-label="Ajustar fim do trecho"]').getAttribute('aria-valuenow'))-.5)<.0001`);
  await click('Salvar trecho');
  await waitFor(`window.__TRAINING.intervals.length===1`);
  assert.equal(await evaluate(`window.__TRAINING.intervals[0].context`),'rearing');
  assert.ok(Math.abs(await evaluate(`window.__TRAINING.intervals[0].startSec`))<.0001);
  assert.ok(Math.abs(await evaluate(`window.__TRAINING.intervals[0].endSec`)-.5)<.0001);
  const savedIntervalId=await evaluate(`window.__TRAINING.intervals[0].id`);
  const handlePoint=async(edge)=>{await timelinePoint(0);return evaluate(`(()=>{const handle=document.querySelector('.range-handle-'+${JSON.stringify(edge)});const r=handle.getBoundingClientRect();return {x:r.left+r.width/2,y:r.top+r.height/2};})()`);};
  await drag(await handlePoint('end'),await timelinePoint(.75));
  await waitFor(`Math.abs(Number(document.querySelector('[aria-label="Ajustar fim do trecho"]').getAttribute('aria-valuenow'))-.75)<.0001`);
  await click('Salvar alterações do trecho');
  await waitFor(`Math.abs(window.__TRAINING.intervals[0].endSec-.75)<.0001`);
  assert.equal(await evaluate(`window.__TRAINING.intervals.length`),1,'Editar alça não pode duplicar trecho');
  assert.equal(await evaluate(`window.__TRAINING.intervals[0].id`),savedIntervalId);
  // Mover o miolo preserva a duração; a régua só muda o playhead.
  await drag(await timelinePoint(.375),await timelinePoint(.625));
  await click('Salvar alterações do trecho');
  await waitFor(`Math.abs(window.__TRAINING.intervals[0].startSec-.25)<.0001 && window.__TRAINING.intervals[0].endSec===1`);
  await drag(await timelinePoint(.5,'.range-ruler'),await timelinePoint(.5,'.range-ruler'));
  await waitFor(`document.querySelector('.range-clock').textContent.startsWith('00:00.500')`);
  assert.ok(Math.abs(await evaluate(`Number(document.querySelector('[aria-label="Ajustar início do trecho"]').getAttribute('aria-valuenow'))`)-.25)<.0001);
  await evaluate(`document.querySelector('.range-handle-start').focus()`);
  await command('Input.dispatchKeyEvent',{type:'keyDown',key:'ArrowRight',code:'ArrowRight',windowsVirtualKeyCode:39});
  await command('Input.dispatchKeyEvent',{type:'keyUp',key:'ArrowRight',code:'ArrowRight',windowsVirtualKeyCode:39});
  assert.ok(Math.abs(await evaluate(`Number(document.querySelector('.range-handle-start').getAttribute('aria-valuenow'))`)-7/24)<.0001);
  await click('Novo trecho');
  await evaluate(`document.querySelector('.range-clip').click()`);
  await waitFor(`Math.abs(Number(document.querySelector('.range-handle-start').getAttribute('aria-valuenow'))-.25)<.0001`);
  assert.ok(await evaluate(`document.querySelector('.range-clip').getAttribute('aria-pressed')==='true'`));
  // Zoom + scroll precisam usar as coordenadas do conteúdo, não da viewport.
  await evaluate(`document.querySelector('[aria-label="Aumentar zoom da timeline"]').click()`);
  await evaluate(`document.querySelector('[aria-label="Aumentar zoom da timeline"]').click()`);
  await evaluate(`new Promise(resolve=>requestAnimationFrame(()=>requestAnimationFrame(()=>resolve(true))))`);
  await click('Novo trecho');
  await evaluate(`document.querySelector('.range-scroll').scrollLeft=0`);
  await drag(await timelinePoint(.125),await timelinePoint(.20));
  assert.ok(Math.abs(await evaluate(`Number(document.querySelector('.range-handle-start').getAttribute('aria-valuenow'))`)-.125)<.0001);
  await evaluate(`document.querySelector('.range-scroll').scrollLeft=document.querySelector('.range-scroll').clientWidth*2`);
  await drag(await timelinePoint(.6),await timelinePoint(.7));
  assert.ok(Math.abs(await evaluate(`Number(document.querySelector('.range-handle-start').getAttribute('aria-valuenow'))`)-14/24)<.0001);
  await click('Novo trecho');
  await evaluate(`document.querySelector('.range-scroll').scrollLeft=0`);
  const panStart=await timelinePoint(.025);
  const panEdge=await evaluate(`(()=>{const s=document.querySelector('.range-scroll').getBoundingClientRect(),t=document.querySelector('.range-draft-track').getBoundingClientRect();return {x:s.right-8,y:t.top+t.height/2};})()`);
  await command('Input.dispatchMouseEvent',{type:'mousePressed',...panStart,button:'left',clickCount:1});
  await command('Input.dispatchMouseEvent',{type:'mouseMoved',...panEdge,button:'left',buttons:1});
  await waitFor(`document.querySelector('.range-scroll').scrollLeft>24`);
  await command('Input.dispatchMouseEvent',{type:'mouseReleased',...panEdge,button:'left'});
  await click('Ajustar');
  await evaluate(`new Promise(resolve=>requestAnimationFrame(()=>requestAnimationFrame(()=>resolve(true))))`);
  await click('Novo trecho');
  await evaluate(`document.querySelector('.range-clip').click()`);
  const cancelStart=await timelinePoint(.05),cancelEnd=await timelinePoint(.15);
  await command('Input.dispatchMouseEvent',{type:'mousePressed',...cancelStart,button:'left',clickCount:1});
  await command('Input.dispatchMouseEvent',{type:'mouseMoved',...cancelEnd,button:'left',buttons:1});
  await command('Input.dispatchKeyEvent',{type:'keyDown',key:'Escape',code:'Escape',windowsVirtualKeyCode:27});
  await command('Input.dispatchKeyEvent',{type:'keyUp',key:'Escape',code:'Escape',windowsVirtualKeyCode:27});
  await command('Input.dispatchMouseEvent',{type:'mouseReleased',...cancelEnd,button:'left'});
  await waitFor(`document.querySelector('.range-clip').getAttribute('aria-pressed')==='true'`);
  assert.ok(Math.abs(await evaluate(`Number(document.querySelector('.range-handle-start').getAttribute('aria-valuenow'))`)-.25)<.0001,'Cancelar arraste deve restaurar a seleção salva');
  assert.equal(await evaluate(`window.__MOCK_CALLS.filter(c=>c.name==='start_custom_training').length`),0,'Selecionar ou editar trechos nunca deve iniciar treino');
  await click('Anotar frame atual');
  await waitFor(`!!document.querySelector('.training-image svg')`);
  assert.equal(await evaluate(`document.querySelector('.training-image svg').getAttribute('viewBox')`),'0 0 160 120');
  await click('Confirmar exemplo revisado');
  await waitFor(`document.querySelector('.training-panel [role=alert]')?.textContent.includes('caixa')`);
  const canvasPoint=async(x,y)=>evaluate(`(()=>{const svg=document.querySelector('.training-image svg');svg.scrollIntoView({block:'center'});const p=new DOMPoint(${x},${y}).matrixTransform(svg.getScreenCTM());return {x:p.x,y:p.y};})()`);
  const boxStart=await canvasPoint(10,10),boxEnd=await canvasPoint(150,110);
  await command('Input.dispatchMouseEvent',{type:'mousePressed',...boxStart,button:'left',clickCount:1});
  await command('Input.dispatchMouseEvent',{type:'mouseMoved',...boxEnd,button:'left',buttons:1});
  await command('Input.dispatchMouseEvent',{type:'mouseReleased',...boxEnd,button:'left'});
  await click('Posicionar parte selecionada');
  const nose=await canvasPoint(40,40);
  await command('Input.dispatchMouseEvent',{type:'mousePressed',...nose,button:'left',clickCount:1});
  await command('Input.dispatchMouseEvent',{type:'mouseReleased',...nose,button:'left'});
  await waitFor(`document.querySelectorAll('.training-image circle').length===1`);
  for(let i=1;i<9;i++){
    await evaluate(`document.querySelectorAll('.training-parts>div')[${i}].querySelector('button:last-child').click()`);
    await waitFor(`document.querySelectorAll('.training-parts>div')[${i}].querySelector('button').textContent.includes('Não visível')`);
  }
  await click('Confirmar exemplo revisado');
  await waitFor(`window.__TRAINING.frames.some(f=>f.reviewed)`);
  const annotated=await evaluate(`window.__TRAINING.frames.find(f=>f.reviewed)`);
  assert.ok(Math.abs(annotated.keypoints.nose.x-40)<.01);
  assert.equal(annotated.keypoints.hip.x,null);
  assert.equal(annotated.keypoints.hip.state,'occluded');
  await click('3. Treinar e versões');
  assert.equal(await evaluate(`document.querySelector('.training-image').getClientRects().length`),0,'Anotação deve ficar preservada, mas oculta na aba de treino');
  assert.ok(await evaluate(`${button('Enviar exemplos e treinar no Colab')}.disabled`),'Treino não pode iniciar com um único frame e sem consentimento');
  assert.equal(await evaluate(`window.__MOCK_CALLS.filter(c=>c.name==='start_custom_training').length`),0);
  assert.equal(await evaluate(`JSON.stringify(JSON.parse(localStorage.getItem('behavetracker.experiments.v1'))[0].corrections)`),preserved,'Anotações de treino não podem alterar correções científicas');
  const trainingScreen=await command('Page.captureScreenshot',{format:'png',captureBeyondViewport:true});
  await writeFile(join(directory,'custom-training-labels.png'),Buffer.from(trainingScreen.data,'base64'));
  await command('Emulation.setDeviceMetricsOverride',{width:390,height:844,deviceScaleFactor:1,mobile:false});
  assert.ok(await evaluate(`document.querySelector('.training-panel').scrollWidth<=document.querySelector('.training-panel').clientWidth+1`),'Overflow interno na anotação mobile');
  await click('1. Selecionar trechos');
  await click('Novo trecho');
  await command('Emulation.setTouchEmulationEnabled',{enabled:true,maxTouchPoints:1});
  const touchStart=await timelinePoint(.2),touchEnd=await timelinePoint(.8);
  await command('Input.dispatchTouchEvent',{type:'touchStart',touchPoints:[{...touchStart,id:1}]});
  await command('Input.dispatchTouchEvent',{type:'touchMove',touchPoints:[{...touchEnd,id:1}]});
  await command('Input.dispatchTouchEvent',{type:'touchEnd',touchPoints:[]});
  await waitFor(`!!document.querySelector('.range-selection')`);
  assert.ok(Math.abs(await evaluate(`Number(document.querySelector('.range-handle-start').getAttribute('aria-valuenow'))`)-5/24)<.0001);
  assert.ok(Math.abs(await evaluate(`Number(document.querySelector('.range-handle-end').getAttribute('aria-valuenow'))`)-19/24)<.0001);
  const canceledTouch=await timelinePoint(.95);
  await command('Input.dispatchTouchEvent',{type:'touchStart',touchPoints:[{...canceledTouch,id:1}]});
  await command('Input.dispatchTouchEvent',{type:'touchCancel',touchPoints:[]});
  assert.ok(Math.abs(await evaluate(`Number(document.querySelector('.range-handle-start').getAttribute('aria-valuenow'))`)-5/24)<.0001,'Gesto cancelado deve preservar a seleção anterior');
  await command('Emulation.setTouchEmulationEnabled',{enabled:false});
  await click('Revisar vídeo');
  assert.ok(await evaluate(`document.querySelector('.training-panel').hidden`));
  // Uma caixa é um resultado próprio: troca de fonte, correção, undo e reload não destroem a revisão Colab.
  await command('Emulation.setDeviceMetricsOverride',{width:1440,height:1080,deviceScaleFactor:1,mobile:false});
  const colabCorrections=await evaluate(`JSON.parse(localStorage.getItem('behavetracker.experiments.v1'))[0].corrections`);
  await click('Análise local');
  await waitFor(`!!document.querySelector('.local-video-stage video')`);
  await click('Selecionar caixa inicial do animal');
  const localPoint=async(x,y)=>evaluate(`(()=>{const svg=document.querySelector('.local-video-stage svg');svg.scrollIntoView({block:'center'});const p=new DOMPoint(${x},${y}).matrixTransform(svg.getScreenCTM());return {x:p.x,y:p.y};})()`);
  await moveMouse(await localPoint(380,380),await localPoint(440,420));
  await waitFor(`Array.from(document.querySelectorAll('.local-video-stage [data-tracking-box="animal"]')).some(box=>box.textContent.includes('Caixa manual'))`);
  const calibrationScreen=await command('Page.captureScreenshot',{format:'png',captureBeyondViewport:true});
  await writeFile(join(directory,'local-box-calibration.png'),Buffer.from(calibrationScreen.data,'base64'));
  assert.deepEqual(await evaluate(`JSON.parse(localStorage.getItem('behavetracker.experiments.v1'))[0].corrections`),colabCorrections,'Calibração local não altera a revisão do Colab');
  await click('Revisar vídeo');
  await setField('[aria-label="Resultado em revisão"]','opencv:macro-fixture','select');
  await waitFor(`!!document.querySelector('.tracking-overlay [data-tracking-box="animal"]')`);
  assert.equal(await evaluate(`document.querySelectorAll('.tracking-point').length`),0,'Macro não deve exigir focinho/orelhas');
  assert.equal(await evaluate(`document.querySelectorAll('[data-keypoint-option]').length`),1);
  const localOriginal=await evaluate(`document.querySelector('.tracking-overlay [data-tracking-box="animal"] rect').getAttribute('x')`);
  await moveMouse(await editorPoint(410,400),await editorPoint(430,415));
  await waitFor(`JSON.parse(localStorage.getItem('behavetracker.experiments.v1'))[0].corrections.at(-1).type==='SET_BOX'`);
  let boxEvent=await evaluate(`JSON.parse(localStorage.getItem('behavetracker.experiments.v1'))[0].corrections.at(-1)`);
  assert.equal(boxEvent.reviewSource,'opencv:macro-fixture');
  assert.ok(Math.abs(boxEvent.afterBox.x-400)<.1);
  await click('Bruto');
  assert.equal(await evaluate(`document.querySelector('.tracking-overlay [data-tracking-box="animal"] rect').getAttribute('x')`),localOriginal);
  await click('Revisado');
  await click('Desfazer');
  assert.equal(await evaluate(`document.querySelector('.tracking-overlay [data-tracking-box="animal"] rect').getAttribute('x')`),localOriginal);
  await evaluate(`document.querySelector('[title="Próximo frame"]').click()`);
  await waitFor(`document.querySelector('.stage-badges').textContent.includes('Frame 1')`);
  assert.equal(await evaluate(`!!document.querySelector('.tracking-overlay [data-tracking-box="animal"]')`),false);
  await click('Desenhar caixa do animal');
  await moveMouse(await editorPoint(390,380),await editorPoint(450,420));
  await waitFor(`!!document.querySelector('.tracking-overlay [data-tracking-box="animal"]')`);
  boxEvent=await evaluate(`JSON.parse(localStorage.getItem('behavetracker.experiments.v1'))[0].corrections.at(-1)`);
  assert.equal(boxEvent.frameIndex,1);
  assert.ok(Math.abs(boxEvent.afterBox.width-60)<.1);
  await moveMouse(await editorPoint(450,420),await editorPoint(460,430));
  await waitFor(`JSON.parse(localStorage.getItem('behavetracker.experiments.v1'))[0].corrections.at(-1).afterBox.width>69`);
  // Dois quadros-chave no resultado local criam prévia no intervalo; outro quadro-chave a refina.
  for(let i=0;i<3;i++) await evaluate(`document.querySelector('[title="Próximo frame"]').click()`);
  await waitFor(`document.querySelector('.stage-badges').textContent.includes('Frame 4')`);
  await click('Marcar caixa neste frame');
  await moveMouse(await editorPoint(430,380),await editorPoint(500,430));
  await waitFor(`document.querySelectorAll('.keyframe-marker').length===2`);
  assert.equal(await evaluate(`document.querySelector('.keyframe-lane-heading').textContent.includes('2 frames previstos')`),true);
  await evaluate(`document.querySelector('[aria-label="Ir ao quadro-chave do frame 1"]').click()`);
  await waitFor(`document.querySelector('.stage-badges').textContent.includes('Frame 1')`);
  await evaluate(`document.querySelector('[title="Próximo frame"]').click()`);
  await waitFor(`document.querySelector('.stage-badges').textContent.includes('Frame 2')`);
  const predictedX=await evaluate(`Number(document.querySelector('.tracking-overlay [data-tracking-box="animal"] rect').getAttribute('x'))`);
  assert.ok(await evaluate(`document.querySelector('.tracking-overlay [data-tracking-box="animal"]').textContent.includes('Previsão')`));
  assert.ok(await evaluate(`!!document.querySelector('.tracking-overlay polyline[stroke="#bb9aff"]')`),'Trajeto estimado deve ser distinto');
  await click('Bruto');
  assert.equal(await evaluate(`Number(document.querySelector('.tracking-overlay [data-tracking-box="animal"] rect').getAttribute('x'))`),382);
  await click('Revisado');
  assert.notEqual(predictedX,382);
  await click('Marcar caixa neste frame');
  await moveMouse(await editorPoint(400,370),await editorPoint(465,425));
  await waitFor(`document.querySelectorAll('.keyframe-marker').length===3`);
  assert.ok(await evaluate(`document.querySelector('.stage-badges').textContent.includes('Caixa observada')`));
  assert.ok(await evaluate(`document.querySelector('.keyframe-lane-heading').textContent.includes('1 frames previstos')`));
  await setField('[aria-label="Resultado em revisão"]','opencv:broken-local-fixture','select');
  await waitFor(`document.querySelector('.editor-error')?.textContent.includes('resultado atual')`);
  assert.equal(await evaluate(`document.querySelector('[aria-label="Resultado em revisão"]').value`),'opencv:macro-fixture');
  assert.ok(await evaluate(`!!document.querySelector('.tracking-overlay [data-tracking-box="animal"]')`),'Erro de carga não pode limpar o resultado ativo');
  await setField('[aria-label="Resultado em revisão"]','colab:local-video-fixture','select');
  await waitFor(`!!document.querySelector('.tracking-point[data-keypoint="body_center"]')`);
  assert.equal(await evaluate(`!!document.querySelector('.keyframe-lane')`),false,'Quadros-chave locais não podem aparecer na revisão Colab');
  await evaluate(`document.querySelector('[title="Próximo frame"]').click()`);
  await waitFor(`document.querySelector('.stage-badges').textContent.includes('Frame 1')`);
  assert.ok(await evaluate(`document.querySelector('.tracking-point[data-keypoint="body_center"]')?.getAttribute('aria-label').includes('manualmente')`));
  const preservedEvents=await evaluate(`JSON.parse(localStorage.getItem('behavetracker.experiments.v1'))[0].corrections`);
  assert.deepEqual(preservedEvents.slice(0,colabCorrections.length),colabCorrections);
  const restoredPoint=await evaluate(`document.querySelector('.tracking-point[data-keypoint="body_center"]').getAttribute('transform')`);
  assert.ok(Math.abs(await evaluate(`document.querySelector('.tracking-point[data-keypoint="body_center"]').transform.baseVal.consolidate().matrix.e`)-firstMove.after.x)<.01);
  await setField('[aria-label="Resultado em revisão"]','opencv:macro-fixture','select');
  await waitFor(`!!document.querySelector('.tracking-overlay [data-tracking-box="animal"]')`);
  assert.equal(await evaluate(`document.querySelectorAll('.keyframe-marker').length`),3,'A troca de fonte deve restaurar os quadros-chave locais');
  const macroScreen=await command('Page.captureScreenshot',{format:'png',captureBeyondViewport:true});
  await writeFile(join(directory,'macro-box-and-source-isolation.png'),Buffer.from(macroScreen.data,'base64'));
  await command('Page.reload');
  await waitFor(`!!document.querySelector('.experiment-row')`);
  await evaluate(`document.querySelector('.experiment-row').click()`);
  await waitFor(`!!document.querySelector('.tracking-overlay [data-tracking-box="animal"]')`);
  assert.equal(await evaluate(`document.querySelector('[aria-label="Resultado em revisão"]').value`),'opencv:macro-fixture');
  assert.equal(await evaluate(`document.querySelectorAll('.keyframe-marker').length`),3,'A reabertura deve reconstruir os quadros-chave');
  assert.deepEqual(await evaluate(`JSON.parse(localStorage.getItem('behavetracker.experiments.v1'))[0].corrections`),preservedEvents);
  await setField('[aria-label="Resultado em revisão"]','colab:local-video-fixture','select');
  await waitFor(`!!document.querySelector('.tracking-point[data-keypoint="body_center"]')`);
  await evaluate(`document.querySelector('[title="Próximo frame"]').click()`);
  await waitFor(`document.querySelector('.stage-badges').textContent.includes('Frame 1')`);
  assert.equal(await evaluate(`document.querySelector('.tracking-point[data-keypoint="body_center"]').getAttribute('transform')`),restoredPoint);
  // Projetos que já estavam em OpenCV, com coordenadas antigas sem fonte, exigem associação explícita.
  await evaluate(`(()=>{const key='behavetracker.experiments.v1';const items=JSON.parse(localStorage.getItem(key));const exp=items[0];exp.trackingSelection={engine:'opencv',jobId:'macro-fixture'};exp.referencePoint='box_center';delete exp.legacyReviewSource;for(const event of exp.corrections){if(event.reviewSource==='colab:local-video-fixture')delete event.reviewSource;}localStorage.setItem(key,JSON.stringify(items));})()`);
  await command('Page.reload');
  await waitFor(`!!document.querySelector('.experiment-row')`);
  await evaluate(`document.querySelector('.experiment-row').click()`);
  await waitFor(`document.querySelector('.editor-error')?.textContent.includes('sem identificação')`);
  await setField('[aria-label="Resultado em revisão"]','colab:local-video-fixture','select');
  await waitFor(`!!${button('Associar correções antigas a este Colab')}`);
  await click('Associar correções antigas a este Colab');
  await evaluate(`document.querySelector('[title="Próximo frame"]').click()`);
  await waitFor(`document.querySelector('.stage-badges').textContent.includes('Frame 1')`);
  assert.equal(await evaluate(`document.querySelector('.tracking-point[data-keypoint="body_center"]').getAttribute('transform')`),restoredPoint,'Associação legada deve restaurar as coordenadas existentes, sem recalculá-las');
  await command('Emulation.setDeviceMetricsOverride',{width:390,height:844,deviceScaleFactor:1,mobile:false});
  const mobileReview=await command('Page.captureScreenshot',{format:'png',captureBeyondViewport:true});
  await writeFile(join(directory,'tabbed-review-mobile.png'),Buffer.from(mobileReview.data,'base64'));
  assert.ok(await evaluate(`document.documentElement.scrollWidth<=innerWidth`),'Abas não podem causar overflow na página');
  assert.deepEqual(errors, []);
  console.log(JSON.stringify({ dualSelection: "passed", confirmation: "passed", pointerAndKeyboard: "passed", persistence: "passed", desktopAndMobile: "passed", behaviorIntervalsUndoAndResults: "passed", tabbedWorkspaces: "passed", manualMissingPointDragMetricsAndUndo: "passed", separateDlcVideoView: "passed", realMp4PlaybackWithMockNativeBridge: "passed", diagnosticRawOverlayAndIsolation: "passed", missingCacheRecovery: "passed", trainingIntervalsAndManualParts: "passed", trainingTimelineDragTrimMoveZoomAndTouch: "passed",trainingConsentAndScientificIsolation: "passed",macroBoxDragDrawResizeAndUndo:"passed",manualBoxKeyframesAndPredictedTrajectory:"passed",sourceIsolationAndReload:"passed",failedSourceLoadPreservesReview:"passed",initialBoxCalibrationAndLegacyRecovery:"passed", directory }));
} catch (error) {
  if(ws?.readyState===WebSocket.OPEN){
    const failure=await command('Page.captureScreenshot',{format:'png',captureBeyondViewport:true}).catch(()=>null);
    if(failure)await writeFile(join(directory,'failure.png'),Buffer.from(failure.data,'base64'));
    console.error('UI failure',directory,await evaluate(`Array.from(document.querySelectorAll('.range-handle')).map(h=>({edge:h.dataset.rangeEdit,time:h.getAttribute('aria-valuenow')}))`).catch(()=>[]));
  }
  throw error;
} finally {
  if (ws?.readyState === WebSocket.OPEN) {
    await command("Browser.close").catch(() => {});
    ws.close();
  }
  if (browser.exitCode == null) browser.kill();
}
