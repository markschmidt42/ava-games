// Parses Claude Code workflow agent transcripts into _watch/data.json
// for the live progress dashboard. Read-only over the transcript dirs.
import { readdirSync, readFileSync, writeFileSync, existsSync } from 'node:fs';
import { join } from 'node:path';

const WF_BASE = '/Users/mschmidt/.claude/projects/-Users-mschmidt-source-ava-games/41c21d9b-c1d5-4fce-9abf-b96319c2a7ae/subagents/workflows';
const OUT = new URL('./data.json', import.meta.url).pathname;
const REPO = '/Users/mschmidt/source/ava-games/';

// Fixed build plan — matched to agents by prompt keywords.
const PLAN = [
  { wf: 'WF-A · Foundation', items: [
    { key: 'gate',      label: 'M0 Collider Gate — six stable poses', match: ['milestone M0', 'PROVE it has six'] },
    { key: 'odds',      label: 'odds.js — probability model + harness', match: ['create hog-wild/odds.js'] },
    { key: 'pig',       label: 'pig.js — 3D pig model & scene', match: ['create hog-wild/pig.js'] },
    { key: 'search',    label: 'physics.js — trajectory search & cache', match: ['Approach-B machinery'] },
    { key: 'ui',        label: 'index.html + game.js — UI shell', match: ['create hog-wild/index.html'] },
    { key: 'integrate', label: 'Integration — playable game', match: ['integrate the modules'] },
  ]},
  { wf: 'WF-B · Verification (M2)', items: [
    { key: 'realism', label: 'Realism pass — leg asym, jowler ≤45°, wall-less zoned board', match: ['leg asymmetry', 'realism pass'] },
    { key: 'harness', label: 'Odds harness 400k + browser QA', match: ['odds harness', 'browser QA sweep'] },
  ]},
  { wf: 'WF-C · Critic loops (M4 juice)', items: [
    { key: 'events', label: 'Contact events in recordings', match: ['contact-event recording'] },
    { key: 'faces',  label: 'Expressive faces + pink hooves', match: ['make the pigs CHARACTERS'] },
    { key: 'audio',  label: 'Audio engine — oinks, squeals, impacts', match: ['audio + haptics engine'] },
    { key: 'reveal', label: 'Reveal sequence integration', match: ['wire the full presentation model'] },
    { key: 'critic', label: 'Harsh critic ⇄ fixer rounds 1-3 (scores 4→5→5)', match: ['HARSH game-feel critic', 'apply the critic'] },
    { key: 'ledger', label: 'C2: clear the 14-item surviving ledger', match: ['clear the ENTIRE surviving critic ledger'] },
    { key: 'critic2', label: 'C2: verify-score-fix rounds (target 9+, anti-goalpost)', match: ['Continuation round', 'round-1 critic ledger', 'round-2 critic ledger', 'round-3 critic ledger'] },
  ]},
  { wf: 'WF-D · Final polish (M5)', items: [
    { key: 'polish', label: 'A11y, wake lock check, 2D removal checklist', match: ['M5', 'removal checklist'] },
  ]},
];

function stripBlobs(s, max = 3500) {
  if (!s) return '';
  s = String(s).replace(/data:image\/[^"'\s]{100,}/g, '[img]')
               .replace(/[A-Za-z0-9+/=]{400,}/g, '[b64]');
  return s.length > max ? s.slice(0, max) + '\n… [truncated]' : s;
}

function parseAgentFile(path) {
  const events = [];
  const lines = readFileSync(path, 'utf8').split('\n');
  for (const line of lines) {
    if (!line.trim()) continue;
    let e; try { e = JSON.parse(line); } catch { continue; }
    events.push(e);
  }
  if (!events.length) return null;

  const a = {
    firstTs: null, lastTs: null, prompt: '', says: [], tools: [],
    files: new Map(), tests: new Map(), toolCount: 0, screenshots: 0,
  };
  let pendingTest = null; // { name, cmd }

  for (const e of events) {
    const ts = e.timestamp || null;
    if (ts) { a.firstTs ??= ts; a.lastTs = ts; }
    const content = e.message?.content;
    if (typeof content === 'string') {
      if (e.type === 'user' && !a.prompt) a.prompt = content;
      continue;
    }
    if (!Array.isArray(content)) continue;

    if (e.type === 'user') {
      for (const c of content) {
        if (typeof c === 'string') { if (!a.prompt) a.prompt = c; continue; }
        if (c.type === 'text' && !a.prompt) a.prompt = c.text || '';
        if (c.type === 'tool_result' && pendingTest) {
          let out = '';
          const cc = c.content;
          if (typeof cc === 'string') out = cc;
          else if (Array.isArray(cc)) out = cc.map(x => x.text || '').join('\n');
          a.tests.set(pendingTest.name, {
            cmd: pendingTest.cmd, ts,
            ok: !/FAIL|Error|error:|AssertionError|failed/i.test(out) || /PASS|✓|OK|all .*pass/i.test(out) && !/FAIL/i.test(out),
            out: stripBlobs(out),
          });
          pendingTest = null;
        }
      }
    } else if (e.type === 'assistant') {
      for (const c of content) {
        if (c.type === 'text' && c.text?.trim()) {
          a.says.push({ ts, text: c.text.slice(0, 400) });
        } else if (c.type === 'tool_use') {
          a.toolCount++;
          const inp = c.input || {};
          let detail = inp.file_path?.replace(REPO, '') || inp.description || inp.command?.slice(0, 110) || inp.url || '';
          if (c.name === 'Write' || c.name === 'Edit') {
            const f = (inp.file_path || '').replace(REPO, '');
            if (f) a.files.set(f, (a.files.get(f) || 0) + 1);
          }
          if (c.name === 'Bash' && /node .*(dev|test|diag|analysis|harness)[^ ]*\.mjs/.test(inp.command || '')) {
            const m = (inp.command || '').match(/([\w-]+\.mjs)/);
            pendingTest = { name: m ? m[1] : 'test', cmd: (inp.command || '').slice(0, 160) };
          }
          if (/screenshot/i.test(c.name) || /screenshot/i.test(JSON.stringify(inp).slice(0, 200))) a.screenshots++;
          a.tools.push({ ts, name: c.name, detail: String(detail).slice(0, 130) });
        }
      }
    }
  }
  a.says = a.says.slice(-6);
  a.tools = a.tools.slice(-10);
  return a;
}

const agents = [];
if (existsSync(WF_BASE)) {
  for (const wfDir of readdirSync(WF_BASE)) {
    const dir = join(WF_BASE, wfDir);
    let journal = [];
    try {
      journal = readFileSync(join(dir, 'journal.jsonl'), 'utf8').split('\n')
        .filter(Boolean).map(l => { try { return JSON.parse(l); } catch { return null; } }).filter(Boolean);
    } catch {}
    const completedIds = new Set(journal.filter(j => j.type === 'completed').map(j => j.agentId));
    let files = [];
    try { files = readdirSync(dir).filter(f => f.startsWith('agent-') && f.endsWith('.jsonl') && !f.includes('meta')); } catch {}
    for (const f of files) {
      const id = f.replace('agent-', '').replace('.jsonl', '');
      let model = '?';
      try { model = JSON.parse(readFileSync(join(dir, `agent-${id}.meta.json`), 'utf8')).model || '?'; } catch {}
      const parsed = parseAgentFile(join(dir, f));
      if (!parsed) continue;
      agents.push({ id, wf: wfDir, model, done: completedIds.has(id), ...parsed, files: [...parsed.files.entries()], tests: [...parsed.tests.entries()] });
    }
  }
}

// Attach agents to plan items by prompt keywords.
for (const wf of PLAN) for (const item of wf.items) {
  const found = agents.filter(a => item.match.some(m => a.prompt.toLowerCase().includes(m.toLowerCase())));
  item.status = !found.length ? 'pending' : found.every(a => a.done) ? 'done' : 'running';
  item.agentIds = found.map(a => a.id);
}

writeFileSync(OUT, JSON.stringify({
  generatedAt: new Date().toISOString(),
  plan: PLAN,
  agents: agents.sort((x, y) => (x.firstTs || '').localeCompare(y.firstTs || '')),
}, null, 1));
console.log(`ok ${agents.length} agents`);
