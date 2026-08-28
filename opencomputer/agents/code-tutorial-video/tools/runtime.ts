import { mkdir } from "node:fs/promises";
import { resolve } from "node:path";

export const ARTIFACT_ROOT = "/tmp/opencomputer-video-artifacts";

export function safeSegment(value: string, fallback: string): string {
  const normalized = value
    .trim()
    .toLowerCase()
    .replace(/[^a-z0-9._-]+/g, "-")
    .replace(/^-+|-+$/g, "")
    .slice(0, 96);
  return normalized || fallback;
}

export async function sessionArtifactPath(
  sessionId: string,
  filename: string,
): Promise<string> {
  const directory = resolve(ARTIFACT_ROOT, safeSegment(sessionId, "session"));
  await mkdir(directory, { recursive: true });
  return resolve(directory, safeSegment(filename, "artifact"));
}

export function requireArtifactPath(path: string): string {
  const resolved = resolve(path);
  if (!resolved.startsWith(`${ARTIFACT_ROOT}/`)) {
    throw new Error(`Artifact path must be inside ${ARTIFACT_ROOT}`);
  }
  return resolved;
}

export async function responseError(response: Response): Promise<Error> {
  const message = (await response.text()).slice(0, 2_000);
  return new Error(`Provider returned HTTP ${response.status}: ${message}`);
}
