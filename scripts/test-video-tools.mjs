import { spawnSync } from "node:child_process";
import { resolve } from "node:path";

const target = process.env.BEHAVETRACKER_TARGET;
const expected = {
  "darwin:x64": "x86_64-apple-darwin", "darwin:arm64": "aarch64-apple-darwin",
  "win32:x64": "x86_64-pc-windows-msvc", "linux:x64": "x86_64-unknown-linux-gnu",
}[`${process.platform}:${process.arch}`];
if (!target || target !== expected) throw new Error(`Plataforma de teste inválida: ${target} em ${expected}.`);
const suffix = process.platform === "win32" ? ".exe" : "";
const binary = name => resolve(`src-tauri/binaries/behavetracker-${name}-${target}${suffix}`);
const result = spawnSync(process.env.CARGO || "cargo", ["test", "--manifest-path", "src-tauri/Cargo.toml",
  "--target", target, "adaptive_preparation", "--lib"], {
  stdio: "inherit",
  env: { ...process.env, BEHAVETRACKER_FFMPEG: binary("ffmpeg"),
    BEHAVETRACKER_FFPROBE: binary("ffprobe") },
});
if (result.error) throw result.error;
if (result.status !== 0) process.exit(result.status || 1);
