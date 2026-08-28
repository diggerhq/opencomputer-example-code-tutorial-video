export interface TutorialStep {
  narration: string;
  code: string;
  holdMs?: number;
}

export interface TutorialTimeline {
  title: string;
  filename: string;
  language: string;
  intro: string;
  steps: TutorialStep[];
}

const MAX_STEPS = 12;
const MAX_CODE_CHUNK = 4_000;
const MAX_TOTAL_CODE = 20_000;

function text(value: unknown, name: string, maximum: number): string {
  if (typeof value !== "string" || !value.trim()) {
    throw new Error(`${name} must be a non-empty string`);
  }
  if (value.length > maximum) throw new Error(`${name} is too long`);
  return value;
}

function estimatedNarrationMs(narration: string): number {
  const words = narration.trim().split(/\s+/).filter(Boolean).length;
  return Math.max(1_500, Math.ceil((words / 2.6) * 1_000));
}

export function normalizeTimeline(value: unknown): TutorialTimeline & {
  estimatedDurationMs: number;
} {
  if (!value || typeof value !== "object" || Array.isArray(value)) {
    throw new Error("timeline must be an object");
  }
  const record = value as Record<string, unknown>;
  if (!Array.isArray(record.steps) || record.steps.length < 1 || record.steps.length > MAX_STEPS) {
    throw new Error(`timeline.steps must contain 1-${MAX_STEPS} steps`);
  }
  let totalCode = 0;
  let estimatedDurationMs = 1_500;
  const steps = record.steps.map((candidate, index) => {
    if (!candidate || typeof candidate !== "object" || Array.isArray(candidate)) {
      throw new Error(`timeline.steps[${index}] must be an object`);
    }
    const step = candidate as Record<string, unknown>;
    const narration = text(step.narration, `steps[${index}].narration`, 1_000);
    const code = text(step.code, `steps[${index}].code`, MAX_CODE_CHUNK);
    totalCode += code.length;
    const requestedHold = typeof step.holdMs === "number" ? step.holdMs : 700;
    const holdMs = Math.max(250, Math.min(5_000, Math.round(requestedHold)));
    const typingMs = Math.max(600, Math.ceil(code.length / 28) * 1_000);
    estimatedDurationMs += Math.max(typingMs, estimatedNarrationMs(narration)) + holdMs;
    return { narration, code, holdMs };
  });
  if (totalCode > MAX_TOTAL_CODE) throw new Error("timeline contains too much code");
  if (estimatedDurationMs > 280_000) throw new Error("timeline exceeds the 280 second recording limit");
  return {
    title: text(record.title, "timeline.title", 120),
    filename: text(record.filename, "timeline.filename", 120),
    language: text(record.language, "timeline.language", 40),
    intro: text(record.intro, "timeline.intro", 1_000),
    steps,
    estimatedDurationMs,
  };
}

export function playwrightProgram(timeline: TutorialTimeline): string {
  const serialized = JSON.stringify(timeline).replace(/</g, "\\u003c");
  return `
const tutorial = ${serialized};
await page.setViewportSize({ width: 1920, height: 1080 });
await page.setContent(\`<!doctype html>
<html><head><meta charset="utf-8"><style>
*{box-sizing:border-box}body{margin:0;background:#070b14;color:#e6edf7;font-family:Inter,ui-sans-serif,system-ui,sans-serif;overflow:hidden}
.shell{height:100vh;padding:48px 58px;background:radial-gradient(circle at 85% 5%,#17345a 0,transparent 35%),#070b14}
.header{display:flex;align-items:center;justify-content:space-between;margin-bottom:24px}.title{font-size:32px;font-weight:750;letter-spacing:-.02em}.badge{padding:9px 14px;border:1px solid #31445f;border-radius:999px;color:#8fb9ff;background:#101a2a;font:600 15px ui-monospace,monospace}
.window{height:820px;border:1px solid #263852;border-radius:18px;overflow:hidden;background:#0b1220;box-shadow:0 28px 80px #0008}.bar{height:52px;display:flex;align-items:center;padding:0 20px;background:#111b2b;border-bottom:1px solid #263852}.dots{display:flex;gap:9px}.dot{width:12px;height:12px;border-radius:50%}.file{margin-left:22px;color:#9db0c9;font:500 15px ui-monospace,monospace}
.content{display:grid;grid-template-columns:1fr 420px;height:768px}.editor{position:relative;overflow:hidden;padding:28px 28px 34px 74px;font:20px/1.55 ui-monospace,SFMono-Regular,Menlo,Consolas,monospace}.code{height:100%;margin:0;white-space:pre-wrap;overflow:hidden;color:#d7e3f4}.line-rail{position:absolute;left:0;top:28px;width:58px;text-align:right;color:#40516a;white-space:pre;font:20px/1.55 ui-monospace,monospace}.caret{display:inline-block;width:3px;height:24px;margin-left:2px;vertical-align:-4px;background:#69a7ff;animation:blink 1s steps(1) infinite}@keyframes blink{50%{opacity:0}}
.notes{display:flex;flex-direction:column;justify-content:flex-end;padding:34px;background:#0e1726;border-left:1px solid #263852}.notes h2{margin:0 0 14px;color:#6fa8ff;font-size:16px;text-transform:uppercase;letter-spacing:.12em}.caption{min-height:154px;font-size:25px;line-height:1.42;font-weight:600;letter-spacing:-.01em}.progress{height:5px;margin-top:24px;border-radius:9px;background:#25344b;overflow:hidden}.progress>div{height:100%;width:0;background:linear-gradient(90deg,#448cff,#8d72ff);transition:width .25s ease}.step{margin-top:12px;color:#71839d;font:14px ui-monospace,monospace}
</style></head><body><main class="shell"><header class="header"><div class="title"></div><div class="badge"></div></header><section class="window"><div class="bar"><div class="dots"><i class="dot" style="background:#ff5f57"></i><i class="dot" style="background:#febc2e"></i><i class="dot" style="background:#28c840"></i></div><div class="file"></div></div><div class="content"><div class="editor"><div class="line-rail"></div><pre class="code"></pre></div><aside class="notes"><h2>What we're building</h2><div class="caption"></div><div class="progress"><div></div></div><div class="step"></div></aside></div></section></main></body></html>\`);
await page.evaluate(async (data) => {
  const pick = (selector) => document.querySelector(selector);
  pick('.title').textContent = data.title;
  pick('.badge').textContent = data.language;
  pick('.file').textContent = data.filename;
  const codeNode = pick('.code');
  const rail = pick('.line-rail');
  const caption = pick('.caption');
  const progress = pick('.progress > div');
  const stepLabel = pick('.step');
  let source = '';
  const render = () => {
    const lines = source.split('\\n').length;
    codeNode.textContent = source;
    const caret = document.createElement('span');
    caret.className = 'caret';
    codeNode.appendChild(caret);
    rail.textContent = Array.from({ length: lines }, (_, index) => index + 1).join('\\n');
  };
  caption.textContent = data.intro;
  render();
  await new Promise((resolve) => setTimeout(resolve, 1500));
  for (let stepIndex = 0; stepIndex < data.steps.length; stepIndex += 1) {
    const item = data.steps[stepIndex];
    caption.textContent = item.narration;
    stepLabel.textContent = \`STEP \${stepIndex + 1} / \${data.steps.length}\`;
    progress.style.width = \`\${((stepIndex + 1) / data.steps.length) * 100}%\`;
    const narrationMs = Math.max(1500, Math.ceil(item.narration.trim().split(/\\s+/).length / 2.6 * 1000));
    const delay = Math.max(22, Math.floor(narrationMs / Math.max(1, item.code.length)));
    for (const character of item.code) {
      source += character;
      render();
      await new Promise((resolve) => setTimeout(resolve, delay));
    }
    await new Promise((resolve) => setTimeout(resolve, item.holdMs ?? 700));
  }
  caption.textContent = 'Tutorial complete';
  await new Promise((resolve) => setTimeout(resolve, 1000));
}, tutorial);
return { characters: tutorial.steps.reduce((sum, step) => sum + step.code.length, 0) };
`;
}
