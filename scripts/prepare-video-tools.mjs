import { appendFileSync, copyFileSync, existsSync, mkdirSync, chmodSync, writeFileSync } from "node:fs";
import { createRequire } from "node:module";
import { join, resolve, delimiter } from "node:path";
import { spawnSync } from "node:child_process";

const require = createRequire(import.meta.url);
const target = process.env.BEHAVETRACKER_TARGET || {
  "darwin:x64": "x86_64-apple-darwin", "darwin:arm64": "aarch64-apple-darwin",
  "win32:x64": "x86_64-pc-windows-msvc", "linux:x64": "x86_64-unknown-linux-gnu",
}[`${process.platform}:${process.arch}`];
if (!target) throw new Error("Plataforma sem FFmpeg empacotado.");
const suffix = process.platform === "win32" ? ".exe" : "";
const outputDir = resolve("src-tauri/binaries");
mkdirSync(outputDir, { recursive: true });

function systemBinary(name) {
  for (const directory of (process.env.PATH || "").split(delimiter)) {
    const candidate = join(directory, name + suffix);
    if (existsSync(candidate)) return candidate;
  }
  return null;
}

for (const name of ["ffmpeg", "ffprobe"]) {
  const output = join(outputDir, `behavetracker-${name}-${target}${suffix}`);
  if (!existsSync(output)) {
    let source;
    try {
      source = require(name === "ffmpeg" ? "ffmpeg-static" : "@derhuerst/ffprobe-static");
    } catch {
      if (process.env.BEHAVETRACKER_REQUIRE_STATIC === "1") throw new Error(`${name} estático ausente para ${target}.`);
      source = systemBinary(name);
    }
    if (!source || !existsSync(source)) throw new Error(`${name} indisponível para o instalador ${target}.`);
    copyFileSync(source, output);
    if (process.platform !== "win32") chmodSync(output, 0o755);
  }
  const result = spawnSync(output, ["-version"], { stdio: "ignore" });
  if (result.status !== 0) throw new Error(`${name} não executa na plataforma ${target}.`);
  if (name === "ffmpeg") {
    const encoders = spawnSync(output, ["-encoders"], { encoding: "utf8" });
    if (encoders.status !== 0 || !/\blibx264\b/.test(encoders.stdout)) throw new Error("O FFmpeg empacotado precisa incluir libx264.");
  }
}

const notice = join(outputDir, "VIDEO_TOOLS_LICENSE.txt");
const bundledLicense = resolve("node_modules/ffmpeg-static/LICENSE");
if (existsSync(bundledLicense)) copyFileSync(bundledLicense, notice);
else writeFileSync(notice, "FFmpeg and ffprobe are distributed under the licenses reported by their binary builds.\nSources and license information: https://ffmpeg.org/legal.html\nStatic binary distributors: https://github.com/eugeneware/ffmpeg-static\n");
if (existsSync(bundledLicense)) appendFileSync(notice, "\nBinary sources and build information: https://github.com/eugeneware/ffmpeg-static\nFFmpeg source and license information: https://ffmpeg.org/legal.html\n");
