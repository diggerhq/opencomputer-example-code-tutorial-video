import { defineTool } from "@opencomputer/agent";
import { createHash } from "node:crypto";
import { execFile } from "node:child_process";
import { chmod, mkdir, rename, stat, writeFile } from "node:fs/promises";
import { dirname, resolve } from "node:path";
import { promisify } from "node:util";
import { requireArtifactPath, sessionArtifactPath } from "./runtime.js";

const execFileAsync = promisify(execFile);
const FFMPEG_VERSION = "n8.0.3-1";
const INSTALL_ROOT = `/tmp/opencomputer-video-tools/ffmpeg/${FFMPEG_VERSION}`;

const ASSETS = {
  x64: {
    ffmpeg: "efe64fe78f16eab0e7923afce4d3db146175ea6aa2da255299d5f1a889b1e0ec",
    ffprobe: "f269fc50c1329007dbd0619212aa88112e9449c3c352d3fb0d51ebae60f7a094",
  },
  arm64: {
    ffmpeg: "18efc01375926c2302c47de0965728b8932a54bbc17896754cdc26a936f31c14",
    ffprobe: "7fe20689dcbeb565868e79513134cf7718c82148f4befc1d59c298efae75adb0",
  },
} as const;

export interface FfmpegPaths {
  ffmpegPath: string;
  ffprobePath: string;
  source: "system" | "downloaded";
  version: string;
}

async function executable(path: string): Promise<boolean> {
  try {
    const metadata = await stat(path);
    return metadata.isFile() && (metadata.mode & 0o111) !== 0;
  } catch {
    return false;
  }
}

async function systemBinary(name: string): Promise<string | undefined> {
  try {
    const { stdout } = await execFileAsync("sh", ["-lc", `command -v ${name}`]);
    return stdout.trim() || undefined;
  } catch {
    return undefined;
  }
}

async function downloadBinary(
  name: "ffmpeg" | "ffprobe",
  architecture: keyof typeof ASSETS,
): Promise<string> {
  const destination = resolve(INSTALL_ROOT, name);
  if (await executable(destination)) return destination;
  const temporary = `${destination}.${crypto.randomUUID()}.tmp`;
  const assetName = `${name}-linux-${architecture}`;
  const url = `https://github.com/shaka-project/static-ffmpeg-binaries/releases/download/${FFMPEG_VERSION}/${assetName}`;
  const response = await fetch(url, { redirect: "follow", signal: AbortSignal.timeout(120_000) });
  if (!response.ok) throw new Error(`FFmpeg download returned HTTP ${response.status}`);
  const bytes = new Uint8Array(await response.arrayBuffer());
  const digest = createHash("sha256").update(bytes).digest("hex");
  if (digest !== ASSETS[architecture][name]) {
    throw new Error(`${name} SHA-256 mismatch`);
  }
  await mkdir(dirname(destination), { recursive: true });
  await writeFile(temporary, bytes, { mode: 0o755 });
  await chmod(temporary, 0o755);
  await rename(temporary, destination);
  return destination;
}

export async function ensureFfmpeg(): Promise<FfmpegPaths> {
  const [systemFfmpeg, systemFfprobe] = await Promise.all([
    systemBinary("ffmpeg"),
    systemBinary("ffprobe"),
  ]);
  if (systemFfmpeg && systemFfprobe) {
    return {
      ffmpegPath: systemFfmpeg,
      ffprobePath: systemFfprobe,
      source: "system",
      version: "system",
    };
  }
  if (process.platform !== "linux" || !(process.arch in ASSETS)) {
    throw new Error(`No pinned FFmpeg build for ${process.platform}/${process.arch}`);
  }
  const architecture = process.arch as keyof typeof ASSETS;
  const [ffmpegPath, ffprobePath] = await Promise.all([
    downloadBinary("ffmpeg", architecture),
    downloadBinary("ffprobe", architecture),
  ]);
  return { ffmpegPath, ffprobePath, source: "downloaded", version: FFMPEG_VERSION };
}

async function duration(ffprobePath: string, path: string): Promise<number> {
  const { stdout } = await execFileAsync(ffprobePath, [
    "-v", "error",
    "-show_entries", "format=duration",
    "-of", "default=noprint_wrappers=1:nokey=1",
    path,
  ]);
  const seconds = Number(stdout.trim());
  if (!Number.isFinite(seconds) || seconds <= 0) throw new Error(`Could not read duration for ${path}`);
  return seconds;
}

export function muxArguments(
  videoPath: string,
  audioPath: string,
  outputPath: string,
  videoDuration: number,
  audioDuration: number,
): string[] {
  const targetDuration = Math.max(videoDuration, audioDuration);
  const videoPad = Math.max(0, targetDuration - videoDuration + 0.1);
  const audioPad = Math.max(0, targetDuration - audioDuration + 0.1);
  return [
    "-y",
    "-i", videoPath,
    "-i", audioPath,
    "-filter_complex",
    `[0:v]tpad=stop_mode=clone:stop_duration=${videoPad.toFixed(3)}[v];[1:a]apad=pad_dur=${audioPad.toFixed(3)}[a]`,
    "-map", "[v]",
    "-map", "[a]",
    "-t", targetDuration.toFixed(3),
    "-c:v", "libx264",
    "-preset", "medium",
    "-crf", "18",
    "-pix_fmt", "yuv420p",
    "-c:a", "aac",
    "-b:a", "192k",
    "-movflags", "+faststart",
    outputPath,
  ];
}

export const installFfmpeg = defineTool({
  name: "install_ffmpeg",
  description:
    "Ensure pinned, SHA-256-verified FFmpeg and FFprobe binaries are available in the current OpenComputer MicroVM.",
  input: { type: "object", properties: {}, additionalProperties: false },
  async run({ reportProgress }) {
    await reportProgress({ stage: "installing_ffmpeg", version: FFMPEG_VERSION });
    const installed = await ensureFfmpeg();
    return {
      ffmpegPath: installed.ffmpegPath,
      ffprobePath: installed.ffprobePath,
      source: installed.source,
      version: installed.version,
    };
  },
});

export const muxTutorialVideo = defineTool({
  name: "mux_tutorial_video",
  description:
    "Combine a Kernel MP4 and ElevenLabs MP3 into a presentation-compatible MP4, padding whichever stream is shorter.",
  input: {
    type: "object",
    properties: {
      videoPath: { type: "string", minLength: 1 },
      audioPath: { type: "string", minLength: 1 },
      outputName: { type: "string", minLength: 1, maxLength: 100, default: "tutorial.mp4" },
    },
    required: ["videoPath", "audioPath"],
    additionalProperties: false,
  },
  async run({ input, sessionId, signal, reportProgress }) {
    const videoPath = requireArtifactPath(String(input.videoPath));
    const audioPath = requireArtifactPath(String(input.audioPath));
    const outputPath = await sessionArtifactPath(sessionId, String(input.outputName ?? "tutorial.mp4"));
    const ffmpeg = await ensureFfmpeg();
    const [videoDuration, audioDuration] = await Promise.all([
      duration(ffmpeg.ffprobePath, videoPath),
      duration(ffmpeg.ffprobePath, audioPath),
    ]);
    await reportProgress({ stage: "muxing", videoDuration, audioDuration });
    const args = muxArguments(videoPath, audioPath, outputPath, videoDuration, audioDuration);
    await execFileAsync(ffmpeg.ffmpegPath, args, { signal, maxBuffer: 4 * 1024 * 1024 });
    const metadata = await stat(outputPath);
    return {
      outputPath,
      bytes: metadata.size,
      durationSeconds: Math.max(videoDuration, audioDuration),
      ffmpegVersion: ffmpeg.version,
      ffmpegSource: ffmpeg.source,
    };
  },
});
