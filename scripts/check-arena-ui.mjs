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

const button = (label) => `Array.from(document.querySelectorAll('button')).find(b => b.textContent.trim() === ${JSON.stringify(label)})`;
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
  assert.ok(await evaluate(`${button("Confirmar ponto após revisar")}.disabled`));
  await click("Editor");
  await waitFor(`!!document.querySelector('.tracking-overlay')`);
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
  await command("Page.addScriptToEvaluateOnNewDocument", { source: `(() => {
    const saved = JSON.parse(localStorage.getItem('behavetracker.experiments.v1'))[0];
    saved.video.timingSource = 'browser-estimate'; saved.video.durationSec = 1; saved.corrections = []; saved.video.sizeBytes = ${Buffer.from(clipBase64,"base64").length};
    saved.video.preparation = {uploadId:'local-prepared-fixture',originalBytes:100,uploadBytes:100,status:'original',message:'Fixture',policyVersion:'lossless-upload-1',pixelVerified:false,frameCount:null};
    localStorage.setItem('behavetracker.experiments.v1', JSON.stringify([saved]));
    const url = URL.createObjectURL(new Blob([Uint8Array.from(atob(${JSON.stringify(clipBase64)}), c => c.charCodeAt(0))], {type:'video/mp4'}));
    const job = {jobId:'local-video-fixture',experimentId:saved.id,status:'succeeded',stage:'completed',progress:100,message:'Fixture',runtimeName:null,error:null,createdAt:new Date().toISOString(),updatedAt:new Date().toISOString(),events:[]};
    const diagnostic = {...job,jobId:'local-diagnostic-fixture',diagnostic:{startSec:0,endSec:1}};
    const frames = Array.from({length:24},(_,i) => ({frameIndex:i,timestampSec:i/24,state:i===0?'detector_missing':i===1?'pose_missing':i===2?'center_missing':'points_available',bbox:i===0?null:{x:20,y:25,width:100,height:75,score:.9},availablePoints:i<2?0:i===2?1:3,strongPoints:i<2?0:i===2?1:3,totalPoints:3,canonicalCenterAvailable:i>=3}));
    const report = {schemaVersion:1,selection:{startSec:0,endSec:1},fps:24,durationSec:1,geometry:{videoWidth:160,videoHeight:120},frames,timings:{modelLoadSec:.3,decodeSec:.1,detectorSec:2,poseSec:1,exportSec:.1,totalSec:3.5},summary:{frameCount:24,states:{detector_missing:1,pose_missing:1,center_missing:1,points_available:21},detectorCoveragePct:100*23/24,centerCoveragePct:87.5,accuracyMeasured:false},warning:'Fixture'};
    const raw = 'frame_index,timestamp_sec,keypoint,x_px,y_px,likelihood,status\\n' + frames.flatMap((f) => ['nose','mid_back','hip'].map((name,n) => [f.frameIndex,f.timestampSec,name,f.frameIndex<2?'':80+n*10,f.frameIndex<2?'':50+n*10,f.frameIndex<2?0:.9,f.frameIndex<2?'missing':'valid'].join(','))).join('\\n');
    window.__MOCK_CALLS = [];
    window.__CACHE_AVAILABLE = true;
    let mockJobs = [diagnostic,job];
    window.__TAURI_EVENT_PLUGIN_INTERNALS__ = {unregisterListener: () => {}};
    window.__TAURI_INTERNALS__ = {
      transformCallback: () => 1, unregisterCallback: () => {}, convertFileSrc: () => url,
      invoke: async (name,args) => {
        window.__MOCK_CALLS.push({name,args});
        if (name.startsWith('plugin:event|')) return 1;
        if (name === 'get_google_oauth_config') return {connected:false,eligibleGpuCount:0,providerError:null};
        if (name === 'list_colab_jobs') return mockJobs;
        if (name === 'check_video_staging') return window.__CACHE_AVAILABLE;
        if (name === 'get_colab_diagnostic_result') return {report,rawPoseCsv:raw,clipPath:'/fake/results/clip.mp4'};
        if (name === 'begin_video_staging') return {uploadId:'local-staged-fixture'};
        if (name === 'append_video_staging_chunk' || name === 'finish_video_staging') return {};
        if (name === 'start_colab_analysis') { const next = {...diagnostic,jobId:'new-diagnostic',status:'queued',stage:'queued',diagnostic:args.request.diagnostic}; mockJobs=[next,...mockJobs]; return next; }
        if (name === 'get_colab_job_video') return {jobId:job.jobId,videoPath:'/fake/results/dlc.mp4',videoError:null};
        if (name === 'get_colab_job_result') return 'frame_index,timestamp_sec,keypoint,x_px,y_px,likelihood,status\\n0,0,body_center,400,400,.9,valid\\n1,.041667,body_center,401,400,.9,valid';
        throw new Error('Chamada nativa inesperada: ' + name);
      }
    };
  })();` });
  await command("Page.reload");
  await waitFor(`!!document.querySelector('.experiment-row')`);
  await evaluate(`document.querySelector('.experiment-row').click()`);
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
  assert.ok(await evaluate(`!!document.querySelector('.tracking-overlay')`), 'Diagnóstico não deve substituir o editor');
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
  assert.deepEqual(errors, []);
  console.log(JSON.stringify({ dualSelection: "passed", confirmation: "passed", pointerAndKeyboard: "passed", persistence: "passed", desktopAndMobile: "passed", behaviorIntervalsUndoAndResults: "passed", separateDlcVideoView: "passed", realMp4PlaybackWithMockNativeBridge: "passed", diagnosticRawOverlayAndIsolation: "passed", missingCacheRecovery: "passed", directory }));
} finally {
  if (ws?.readyState === WebSocket.OPEN) {
    await command("Browser.close").catch(() => {});
    ws.close();
  }
  if (browser.exitCode == null) browser.kill();
}
