import assert from "node:assert/strict";
import test from "node:test";
import { normalizeTimeline, playwrightProgram } from "./tools/tutorial.js";

test("normalizes a tutorial and estimates a bounded duration", () => {
  const timeline = normalizeTimeline({
    title: "Hello",
    filename: "hello.ts",
    language: "TypeScript",
    intro: "Build a greeting.",
    steps: [{ narration: "Create the function.", code: "export const hello = () => 'hi';\n" }],
  });
  assert.equal(timeline.steps[0]?.holdMs, 700);
  assert.ok(timeline.estimatedDurationMs > 2_000);
});

test("serializes untrusted code as data, not markup", () => {
  const timeline = normalizeTimeline({
    title: "Safe",
    filename: "safe.ts",
    language: "TypeScript",
    intro: "Keep source inert.",
    steps: [{ narration: "Show a string.", code: "const x = '</script><script>bad()</script>';\n" }],
  });
  const program = playwrightProgram(timeline);
  assert.equal(program.includes("</script><script>bad()"), false);
  assert.match(program, /\\u003c\/script>/);
});

test("rejects an empty timeline", () => {
  assert.throws(
    () => normalizeTimeline({ title: "x", filename: "x.ts", language: "ts", intro: "x", steps: [] }),
    /1-12 steps/,
  );
});
