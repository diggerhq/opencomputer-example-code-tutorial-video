import {
  bearer,
  defineConnection,
  defineTool,
  useSecret,
} from "@opencomputer/agent";
import { writeFile } from "node:fs/promises";
import { responseError, sessionArtifactPath } from "./runtime.js";
import { normalizeTimeline, playwrightProgram } from "./tutorial.js";

const kernel = defineConnection({
  id: "kernel-browsers",
  origin: "https://api.onkernel.com",
  methods: ["GET", "POST", "DELETE"],
  pathPrefix: "/browsers",
  headers: {
    Authorization: bearer(useSecret("KERNEL_API_KEY")),
  },
});

function segment(value: string, name: string): string {
  if (!/^[A-Za-z0-9._-]+$/.test(value)) throw new Error(`Invalid ${name}`);
  return encodeURIComponent(value);
}

async function json<T>(path: string, init?: RequestInit): Promise<T> {
  const response = await kernel.fetch(path, init);
  if (!response.ok) throw await responseError(response);
  return (await response.json()) as T;
}

async function stopReplay(browserId: string, replayId: string): Promise<void> {
  const response = await kernel.fetch(
    `/browsers/${segment(browserId, "browser ID")}/replays/${segment(replayId, "replay ID")}/stop`,
    { method: "POST" },
  );
  if (!response.ok) throw await responseError(response);
}

async function deleteBrowser(browserId: string): Promise<void> {
  const response = await kernel.fetch(`/browsers/${segment(browserId, "browser ID")}`, {
    method: "DELETE",
  });
  if (!response.ok && response.status !== 404) throw await responseError(response);
}

export const recordTutorialVideo = defineTool({
  name: "record_tutorial_video",
  description:
    "Create a GPU-enabled Kernel Chromium session, render a deterministic coding timeline, record a video-only replay, download the MP4, and clean up the browser.",
  input: {
    type: "object",
    properties: {
      timeline: {
        type: "object",
        properties: {
          title: { type: "string", minLength: 1, maxLength: 120 },
          filename: { type: "string", minLength: 1, maxLength: 120 },
          language: { type: "string", minLength: 1, maxLength: 40 },
          intro: { type: "string", minLength: 1, maxLength: 1000 },
          steps: {
            type: "array",
            minItems: 1,
            maxItems: 12,
            items: {
              type: "object",
              properties: {
                narration: { type: "string", minLength: 1, maxLength: 1000 },
                code: { type: "string", minLength: 1, maxLength: 4000 },
                holdMs: { type: "integer", minimum: 250, maximum: 5000 },
              },
              required: ["narration", "code"],
              additionalProperties: false,
            },
          },
        },
        required: ["title", "filename", "language", "intro", "steps"],
        additionalProperties: false,
      },
      gpu: { type: "boolean", default: true },
    },
    required: ["timeline"],
    additionalProperties: false,
  },
  async run({ input, sessionId, signal, reportProgress }) {
    const timeline = normalizeTimeline(input.timeline);
    const gpu = input.gpu !== false;
    let browserId = "";
    let replayId = "";
    let replayStopped = false;
    try {
      await reportProgress({ stage: "creating_kernel_browser", gpu });
      const browser = await json<{
        session_id: string;
        browser_live_view_url?: string;
      }>("/browsers", {
        method: "POST",
        headers: { "content-type": "application/json" },
        body: JSON.stringify({
          gpu,
          headless: false,
          kiosk_mode: true,
          region: gpu ? "us-east" : "ap-southeast",
          timeout_seconds: Math.min(600, Math.ceil(timeline.estimatedDurationMs / 1000) + 120),
          viewport: { width: 1920, height: 1080, refresh_rate: gpu ? 60 : 25 },
          tags: { example: "opencomputer-code-tutorial-video", session: sessionId },
        }),
        signal,
      });
      browserId = browser.session_id;

      await reportProgress({ stage: "starting_replay", browserId });
      const replay = await json<{ replay_id: string; replay_view_url?: string }>(
        `/browsers/${segment(browserId, "browser ID")}/replays`,
        {
          method: "POST",
          headers: { "content-type": "application/json" },
          body: JSON.stringify({
            framerate: gpu ? 30 : 20,
            max_duration_in_seconds: Math.ceil(timeline.estimatedDurationMs / 1000) + 30,
            record_audio: false,
          }),
          signal,
        },
      );
      replayId = replay.replay_id;

      await reportProgress({ stage: "rendering_tutorial", browserId, replayId });
      const execution = await json<{ success: boolean; error?: string; stderr?: string }>(
        `/browsers/${segment(browserId, "browser ID")}/playwright/execute`,
        {
          method: "POST",
          headers: { "content-type": "application/json" },
          body: JSON.stringify({
            code: playwrightProgram(timeline),
            timeout_sec: Math.min(300, Math.ceil(timeline.estimatedDurationMs / 1000) + 20),
          }),
          signal,
        },
      );
      if (!execution.success) {
        throw new Error(`Kernel Playwright failed: ${execution.error ?? execution.stderr ?? "unknown error"}`);
      }

      await reportProgress({ stage: "processing_replay", browserId, replayId });
      await stopReplay(browserId, replayId);
      replayStopped = true;

      let replayViewUrl = replay.replay_view_url ?? "";
      for (let attempt = 0; attempt < 30; attempt += 1) {
        const replays = await json<Array<{
          replay_id: string;
          finished_at?: string | null;
          replay_view_url?: string;
        }>>(`/browsers/${segment(browserId, "browser ID")}/replays`, { signal });
        const current = replays.find((candidate) => candidate.replay_id === replayId);
        replayViewUrl = current?.replay_view_url ?? replayViewUrl;
        if (current?.finished_at) break;
        await new Promise((resolve) => setTimeout(resolve, 2_000));
      }

      const response = await kernel.fetch(
        `/browsers/${segment(browserId, "browser ID")}/replays/${segment(replayId, "replay ID")}`,
        { headers: { accept: "video/mp4" }, signal },
      );
      if (!response.ok) throw await responseError(response);
      const videoPath = await sessionArtifactPath(sessionId, "kernel-replay.mp4");
      await writeFile(videoPath, new Uint8Array(await response.arrayBuffer()));
      return {
        browserId,
        replayId,
        replayViewUrl,
        liveViewUrl: browser.browser_live_view_url ?? "",
        videoPath,
        estimatedDurationMs: timeline.estimatedDurationMs,
        browserAudio: false,
      };
    } finally {
      if (browserId && replayId && !replayStopped) {
        await stopReplay(browserId, replayId).catch(() => undefined);
      }
      if (browserId) await deleteBrowser(browserId).catch(() => undefined);
    }
  },
});
