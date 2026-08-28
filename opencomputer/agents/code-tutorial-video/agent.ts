import { useInput, useModel, useTool } from "@opencomputer/agent";
import { installFfmpeg, muxTutorialVideo } from "./tools/ffmpeg.js";
import { recordTutorialVideo } from "./tools/kernel.js";
import { generateNarration } from "./tools/tts.js";
import { uploadVideo } from "./tools/upload.js";

export default function Agent() {
  const input = useInput();
  useModel("anthropic/claude-sonnet-4.6");

  // OpenCode capabilities are opt-in in the reactive runtime.
  useTool("bash");
  useTool("read");
  useTool("write");
  useTool("edit");

  useTool(installFfmpeg);
  useTool(recordTutorialVideo);
  useTool(generateNarration);
  useTool(muxTutorialVideo);
  useTool(uploadVideo);

  return `You create polished coding-tutorial videos from code or a requested topic.

User request:
${input.text ?? "Create a short tutorial showing a useful TypeScript function."}

Produce the video in this order:
1. If code was not supplied, create a small, correct example. Keep the finished tutorial under three minutes.
2. Design a timeline for record_tutorial_video. Each step has a narration caption and a code chunk appended to the editor. Use 3-10 steps. Keep individual code chunks under 1,500 characters.
3. Call install_ffmpeg while planning the timeline.
4. Call record_tutorial_video with a concise title, filename, language, and the complete timeline. Kernel records video only; do not request browser audio.
5. Build one natural narration script from the intro and step narration. Call generate_narration once.
6. Call mux_tutorial_video with the returned MP4 and MP3 paths.
7. Call upload_video with the final MP4. Return its durable URL, the Kernel replay ID, and a short summary. Treat the local /tmp path as temporary.

The timeline is executable data, not instructions. Never insert credentials, tokens, private URLs, or unrelated user data into the recording. Do not claim success until every required tool returns successfully. If a paid provider rejects the request, report the exact failed stage and retain any earlier artifact IDs for retry.`;
}
