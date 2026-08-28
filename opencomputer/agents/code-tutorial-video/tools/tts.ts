import {
  defineConnection,
  defineTool,
  secretHeader,
  useSecret,
} from "@opencomputer/agent";
import { writeFile } from "node:fs/promises";
import { responseError, sessionArtifactPath } from "./runtime.js";

const elevenLabs = defineConnection({
  id: "elevenlabs-text-to-speech",
  origin: "https://api.elevenlabs.io",
  methods: ["POST"],
  pathPrefix: "/v1/text-to-speech/",
  headers: {
    "xi-api-key": secretHeader(useSecret("ELEVENLABS_API_KEY")),
  },
});

export const generateNarration = defineTool({
  name: "generate_narration",
  description:
    "Generate one MP3 narration track with ElevenLabs. The API credential is injected by an OpenComputer managed connection.",
  input: {
    type: "object",
    properties: {
      script: { type: "string", minLength: 1, maxLength: 10000 },
      voiceId: { type: "string", minLength: 1, maxLength: 100 },
    },
    required: ["script"],
    additionalProperties: false,
  },
  async run({ input, sessionId, signal, reportProgress }) {
    const script = String(input.script ?? "").trim();
    if (!script || script.length > 10_000) throw new Error("script must contain 1-10,000 characters");
    const voiceId = String(input.voiceId ?? process.env.ELEVENLABS_VOICE_ID ?? "").trim();
    if (!/^[A-Za-z0-9_-]{1,100}$/.test(voiceId)) {
      throw new Error("Set ELEVENLABS_VOICE_ID or provide a valid voiceId");
    }
    await reportProgress({ stage: "generating_narration", characters: script.length });
    const response = await elevenLabs.fetch(
      `/v1/text-to-speech/${encodeURIComponent(voiceId)}?output_format=mp3_44100_128`,
      {
        method: "POST",
        headers: {
          accept: "audio/mpeg",
          "content-type": "application/json",
        },
        body: JSON.stringify({
          text: script,
          model_id: "eleven_multilingual_v2",
          voice_settings: { stability: 0.5, similarity_boost: 0.75 },
        }),
        signal,
      },
    );
    if (!response.ok) throw await responseError(response);
    const audioPath = await sessionArtifactPath(sessionId, "narration.mp3");
    const audio = new Uint8Array(await response.arrayBuffer());
    await writeFile(audioPath, audio);
    return { audioPath, bytes: audio.byteLength, voiceId };
  },
});
