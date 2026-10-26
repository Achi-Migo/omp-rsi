import test from 'node:test';
import assert from 'node:assert/strict';
import * as fs from 'node:fs';
import * as os from 'node:os';
import * as path from 'node:path';
import { ContextProfiler } from '../packages/dwfx-core/src/index.ts';
import contextProfilerHook from '../.omp/hooks/pre/context-profiler.ts';
import { createEvolutionLearnerHook } from '../.omp/hooks/pre/evolution-learner.ts';
import { RsiStore } from '../src/journal/rsi-store.ts';

test('ContextProfiler derives npm commands and before_agent_start plus /profiler share the same profile', async () => {
  const profile = new ContextProfiler().profile(process.cwd());
  assert.equal(profile.testCmd, 'npm test');
  assert.equal(profile.typecheckCmd, 'npm run typecheck');
  assert.equal(profile.hasTypescript, true);

  const events = {};
  const commands = {};
  const notifications = [];
  contextProfilerHook({
    on: (name, handler) => { events[name] = handler; },
    registerCommand: (name, command) => { commands[name] = command; },
  });
  const ctx = { cwd: process.cwd(), hasUI: false, ui: { notify: (text) => notifications.push(text) } };
  const injected = await events.before_agent_start({ prompt: '' }, ctx);
  assert.equal(injected.message.details.testCmd, 'npm test');
  assert.equal(injected.message.display, false);
  const commanded = await commands.profiler.handler('', ctx);
  assert.equal(commanded.typecheckCmd, 'npm run typecheck');
  assert.equal(notifications.length, 1);
});

test('agent_end promotes only verified tools and promotes a skill after three distinct tasks', async () => {
  const cwd = fs.mkdtempSync(path.join(os.tmpdir(), 'rsi-learning-'));
  const agentDir = path.join(cwd, 'agent');
  const stagingDirectory = path.join(cwd, '.omp/staging-tools');
  fs.mkdirSync(stagingDirectory, { recursive: true });
  const toolSource = 'export default function verifiedTool() { return { name: "verified_tool" }; }\n';
  fs.writeFileSync(path.join(stagingDirectory, 'verified-tool.ts'), toolSource);
  const store = RsiStore.open(path.join(cwd, '.omp/rsi.db'));
  try {
    for (let index = 0; index < 3; index += 1) {
      const taskId = `verified-${index}`;
      store.createTask({
        id: taskId,
        cwd,
        objective: `verified objective ${index}`,
        skillName: 'repeatable-verified-fix',
        skillReused: index === 2,
        stagingToolPath: index === 0 ? '.omp/staging-tools/verified-tool.ts' : undefined,
      });
      const candidateId = `${taskId}:candidate`;
      store.createCandidate(taskId, {
        id: candidateId,
        operator: 'draft',
        parentIds: [],
        diffPatch: 'diff --git a/a.txt b/a.txt\n',
      });
      store.recordEvaluation(candidateId, { exitCode: 0, durationMs: 2, testPassRatio: 1, status: 'passed' });
      store.settleTask(taskId, 'succeeded', {
        championId: candidateId,
        experience: `Use validated evidence step ${index}; ignore /tmp/run-${index} and localhost:${8000 + index}.`,
      });
    }
    store.createTask({ id: 'unverified', cwd, objective: 'not eligible', stagingToolPath: '.omp/staging-tools/verified-tool.ts' });
  } finally {
    store.close();
  }

  const events = {};
  createEvolutionLearnerHook({ agentDir })({ on: (name, handler) => { events[name] = handler; } });
  const ctx = { cwd, hasUI: false, ui: { notify: () => {} } };
  try {
    await events.agent_end({ isTerminal: false }, ctx);
    assert.equal(fs.existsSync(path.join(cwd, '.omp/tools/verified-tool.ts')), false);

    await events.agent_end({ isTerminal: true }, ctx);
    const promotedTool = path.join(cwd, '.omp/tools/verified-tool.ts');
    assert.equal(fs.readFileSync(promotedTool, 'utf8'), toolSource);
    const skillPath = path.join(agentDir, 'managed-skills/repeatable-verified-fix/SKILL.md');
    const skill = fs.readFileSync(skillPath, 'utf8');
    assert.match(skill, /Use validated evidence step 0/);
    assert.match(skill, /Use validated evidence step 2/);
    assert.doesNotMatch(skill, /localhost:8000/);
    assert.match(skill, /3 tasks/);

    const facts = RsiStore.open(path.join(cwd, '.omp/rsi.db'));
    try {
      assert.equal(facts.getTask('verified-0').promotedToolPath, '.omp/tools/verified-tool.ts');
      assert.equal(facts.getTask('verified-0').skillPromoted, true);
      assert.equal(facts.getTask('unverified').promotedToolPath, undefined);
      assert.equal(facts.metrics().toolGenerationSuccessRate, 0.5);
      assert.equal(facts.metrics().skillReuseRate, 0.25);
    } finally {
      facts.close();
    }

    await events.agent_end({ isTerminal: true }, ctx);
    assert.equal(fs.readFileSync(skillPath, 'utf8'), skill);
  } finally {
    fs.rmSync(cwd, { recursive: true, force: true });
  }
});
