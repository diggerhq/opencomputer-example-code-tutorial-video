# OpenComputer Code Tutorial Video Agent

This standalone example turns code or a coding topic into a narrated tutorial
video. An OpenComputer Serverless Agent plans the tutorial and drives the
workflow; Kernel supplies a recorded Chromium session; ElevenLabs supplies the
narration; and FFmpeg produces the final MP4.

```text
request -> tutorial timeline -> Kernel Chromium replay (MP4)
                            \-> ElevenLabs narration (MP3)
                                      |
                                      v
                              FFmpeg final MP4 -> upload gateway -> R2 URL
```

Kernel recording is deliberately video-only. Browser audio is unnecessary
because narration is generated separately and muxed afterward.

## What the example demonstrates

- explicit OpenCode `bash`, `read`, `write`, and `edit` capabilities with a
  checked-in `permission.* = allow` policy, so tool calls do not pause for
  interactive approval;
- typed OpenComputer tools for Kernel, ElevenLabs, FFmpeg, and R2 upload;
- a headful, GPU-enabled Kernel browser at 1920x1080;
- deterministic timeline playback rather than model-timed keystrokes;
- replay cleanup in `finally` blocks;
- pinned FFmpeg and FFprobe binaries verified with SHA-256;
- duration-aware audio/video padding during the final mux; and
- a bearer-authenticated Worker gateway that issues short-lived signed upload
  URLs and streams video into an R2 binding.

The pinned binaries are Shaka Project's static FFmpeg `n8.0.3-1` Linux builds.
They are downloaded only when the runtime image does not already contain both
`ffmpeg` and `ffprobe`.

## Prerequisites

- Node.js 22 or newer
- an OpenComputer project
- a Kernel API key with browser replay access
- an ElevenLabs API key and voice ID
- Kernel Start-Up or Enterprise access for GPU browsers

GPU browser rendering currently requires a headful Kernel browser in
`us-east`. This is independent of the AWS region where the OpenComputer
Serverless Agent MicroVM runs.

## Install and link

```bash
npm install
npx opencomputer link
```

## Configure development

Create a restricted ElevenLabs API key with only the **Text to Speech**
permission. Voice cloning, voice management, speech-to-text, account, and
administrative permissions are not required. A low per-key credit limit is a
useful guardrail while testing.

Store the Kernel and ElevenLabs credentials as OpenComputer managed secrets:

```bash
npx opencomputer secrets set KERNEL_API_KEY \
  --environment development --agent current

npx opencomputer secrets set ELEVENLABS_API_KEY \
  --environment development --agent current
```

Store the voice ID as an ordinary runtime variable. Choose a premade voice
available to your ElevenLabs plan; some shared or professional voices require
a paid plan even when the API key itself is valid. The final smoke test used
the premade Adam voice (`pNInz6obpgDQGcFmaJgB`) successfully.

```bash
printf '%s\n' 'pNInz6obpgDQGcFmaJgB' | \
  npx opencomputer env set ELEVENLABS_VOICE_ID \
  --environment development --agent current
```

## Configure durable video storage

The `artifact-gateway` Worker issues a 10-minute signed upload URL through an
OpenComputer managed connection, then streams the MP4 directly into an R2
binding. The Serverless Agent never receives an R2 access-key ID, secret access
key, or Cloudflare API token.

Install the gateway dependencies, create its bucket, set a strong shared
upload token interactively, and deploy it:

```bash
cd artifact-gateway
npm install
npx wrangler r2 bucket create opencomputer-code-tutorial-videos
npx wrangler secret put UPLOAD_TOKEN
npm run deploy
```

`wrangler login` is sufficient for deployment; S3-compatible R2 credentials
are unnecessary. For CI, use an account-scoped Cloudflare API token with
Workers Scripts write, Workers R2 Storage write, Account Settings read, and
User Memberships read access.

Replace the placeholder `origin` string in
`opencomputer/agents/code-tutorial-video/tools/upload.ts` with the resulting
Workers URL or a custom domain. Keep it as an inline string literal so the
OpenComputer compiler can discover and enforce the connection policy. Store
the same upload token in OpenComputer:

```bash
npx opencomputer secrets set VIDEO_UPLOAD_TOKEN \
  --environment development --agent current
```

The managed connection authenticates only the small upload-ticket request.
The resulting short-lived URL authorizes one randomly named MP4 path, and the
gateway validates its HMAC signature, expiry, and exact content length before
streaming the body to R2. Public video URLs are unguessable capability URLs and
support byte ranges. Add viewer authentication instead if the tutorials contain
sensitive code.

The gateway accepts videos up to 100 MiB. Increase that only after accounting
for the Cloudflare account's inbound request limit. Larger or resumable videos
should use an R2 multipart upload.

Start a development deployment watcher from the repository root:

```bash
npm run deploy -- --watch
```

Then create a session in another terminal:

```bash
npm run session -- \
  "Create a 60-second TypeScript tutorial explaining a debounce function."
```

You can also paste existing code into the prompt.

## Verify without provider credentials

The unit tests exercise timeline validation, safe Playwright serialization,
and FFmpeg argument construction without calling Kernel or ElevenLabs:

```bash
npm test
npm run typecheck
```

## Tool boundaries

`KERNEL_API_KEY` is injected only for requests under
`https://api.onkernel.com/browsers`. `ELEVENLABS_API_KEY` is injected only for
the ElevenLabs text-to-speech endpoint. `VIDEO_UPLOAD_TOKEN` is injected only
for upload-ticket requests to the configured gateway. None of these values is
returned to the model.
The wildcard OpenCode permission policy approves tool execution, but it does
not turn managed connection secrets into environment variables or expose them
to Bash.

Kernel browsers are deleted after every recording attempt. Generated media is
written beneath `/tmp/opencomputer-video-artifacts/<session-id>` and the final
MP4 is uploaded to R2 before the turn completes. Intermediate files remain
ephemeral; a production multi-turn workflow should upload them as checkpoints.

The FFmpeg installer follows immutable GitHub release URLs and verifies exact
SHA-256 digests before making either binary executable. Review the binaries'
GPL licensing before redistributing a derived image or the binaries themselves.

## Current limitations

- Narration is generated as one track. Captions and typing are paced from word
  count, then FFmpeg pads the shorter stream so the narration is never cut off.
- Provider calls happen in one agent turn. Durable multi-stage retries require
  persisting provider job and artifact IDs outside the MicroVM.
- The included gateway handles videos up to 100 MiB in one request; larger
  videos need multipart upload support.
- Kernel GPU capacity and recording are billed by Kernel separately.

These limitations keep the example small while leaving clear seams for a
durable workflow and artifact-storage integration.
