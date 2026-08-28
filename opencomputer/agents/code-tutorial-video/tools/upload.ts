import {
  bearer,
  defineConnection,
  defineTool,
  useSecret,
} from "@opencomputer/agent";
import { createReadStream } from "node:fs";
import { stat } from "node:fs/promises";
import { Readable } from "node:stream";
import { requireArtifactPath, responseError, safeSegment } from "./runtime.js";

const artifactGateway = defineConnection({
  id: "video-artifact-gateway",
  // Replace this literal after deploying artifact-gateway, or use a custom domain.
  // OpenComputer requires connection origins to be statically discoverable literals.
  origin: "https://opencomputer-code-tutorial-artifacts.ujn.workers.dev",
  methods: ["POST"],
  pathPrefix: "/v1/uploads",
  headers: {
    Authorization: bearer(useSecret("VIDEO_UPLOAD_TOKEN")),
  },
});

export const uploadVideo = defineTool({
  name: "upload_video",
  description:
    "Upload the final MP4 through the authenticated artifact gateway into R2 and return its durable sharing URL.",
  input: {
    type: "object",
    properties: {
      filePath: { type: "string", minLength: 1 },
      name: { type: "string", minLength: 1, maxLength: 100, default: "tutorial.mp4" },
    },
    required: ["filePath"],
    additionalProperties: false,
  },
  async run({ input, sessionId, signal, reportProgress }) {
    const filePath = requireArtifactPath(String(input.filePath));
    const metadata = await stat(filePath);
    if (!metadata.isFile() || metadata.size < 1) throw new Error("Video artifact is empty");
    if (metadata.size > 100 * 1024 * 1024) {
      throw new Error("Video exceeds the example gateway's 100 MiB single-upload limit");
    }
    const name = safeSegment(String(input.name ?? "tutorial.mp4"), "tutorial.mp4");
    const response = await artifactGateway.fetch("/v1/uploads", {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({
        sessionId: safeSegment(sessionId, "session"),
        name: name.endsWith(".mp4") ? name : `${name}.mp4`,
        bytes: metadata.size,
      }),
      signal,
    });
    if (!response.ok) throw await responseError(response);
    const ticket = (await response.json()) as {
      key?: unknown;
      url?: unknown;
      uploadUrl?: unknown;
    };
    if (
      typeof ticket.key !== "string" ||
      typeof ticket.url !== "string" ||
      typeof ticket.uploadUrl !== "string"
    ) {
      throw new Error("Artifact gateway returned an invalid upload ticket");
    }

    const uploadUrl = new URL(ticket.uploadUrl);
    if (
      uploadUrl.origin !== "https://opencomputer-code-tutorial-artifacts.ujn.workers.dev" ||
      !uploadUrl.pathname.startsWith("/v1/upload/videos/")
    ) {
      throw new Error("Artifact gateway returned an unexpected upload URL");
    }
    await reportProgress({ stage: "uploading_video", bytes: metadata.size });

    const file = createReadStream(filePath);
    try {
      const uploadResponse = await fetch(uploadUrl, {
        method: "PUT",
        headers: {
          "content-type": "video/mp4",
          "content-length": String(metadata.size),
        },
        body: Readable.toWeb(file) as BodyInit,
        duplex: "half",
        signal,
      } as RequestInit & { duplex: "half" });
      if (!uploadResponse.ok) throw await responseError(uploadResponse);
    } finally {
      file.destroy();
    }

    return {
      key: ticket.key,
      url: ticket.url,
      bytes: metadata.size,
    };
  },
});
