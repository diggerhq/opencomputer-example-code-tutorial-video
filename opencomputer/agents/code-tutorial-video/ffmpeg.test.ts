import assert from "node:assert/strict";
import test from "node:test";
import { muxArguments } from "./tools/ffmpeg.js";

test("mux pads video when narration is longer", () => {
  const args = muxArguments("video.mp4", "voice.mp3", "out.mp4", 10, 14.5);
  const filter = args[args.indexOf("-filter_complex") + 1];
  assert.match(filter ?? "", /stop_duration=4\.600/);
  assert.equal(args[args.indexOf("-t") + 1], "14.500");
});

test("mux pads audio when recording is longer", () => {
  const args = muxArguments("video.mp4", "voice.mp3", "out.mp4", 20, 12);
  const filter = args[args.indexOf("-filter_complex") + 1];
  assert.match(filter ?? "", /apad=pad_dur=8\.100/);
});
