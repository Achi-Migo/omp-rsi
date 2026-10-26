import type { HookAPI } from '@oh-my-pi/pi-coding-agent/extensibility/hooks';
import * as fs from 'node:fs';
import * as os from 'node:os';
import * as path from 'node:path';
import { RsiStore } from '../../../src/journal/rsi-store.ts';
import type { RsiTaskRecord } from '../../../src/journal/rsi-store.ts';

export interface ManageSkillCreate {
  action: 'create';
  name: string;
  description: string;
  body: string;
}

export interface PromotionOptions {
  cwd: string;
  agentDir?: string;
  manageSkill?: (input: ManageSkillCreate) => Promise<unknown>;
}

export interface PromotionResult {
  verifiedTaskCount: number;
  promotedTools: string[];
  promotedSkills: string[];
}

/** Managed-skill compatible create operation; never touches user-authored skills. */
export async function manage_skill(input: ManageSkillCreate, agentDir?: string): Promise<string> {
  const name = input.name.trim().toLowerCase();
  if (!/^[a-z0-9][a-z0-9-]{0,63}$/.test(name)) throw new Error(`Invalid skill name "${input.name}"`);
  const description = input.description
    .replace(/[\r\n`<>\x00-\x1F]/g, ' ')
    .replace(/\s+/g, ' ')
    .trim();
  const body = input.body.trim();
  if (!description || !body) throw new Error('Managed skill description and body must be non-empty');
  const content = `---\nname: ${name}\ndescription: ${description}\n---\n\n${body}\n`;
  if (Buffer.byteLength(content, 'utf8') > 64_000) throw new Error(`Managed skill ${name} exceeds 64000 bytes`);

  const root = agentDir ?? process.env.PI_CODING_AGENT_DIR ?? path.join(os.homedir(), '.omp/agent');
  await fs.promises.mkdir(root, { recursive: true });
  const managedRoot = path.join(root, 'managed-skills');
  await fs.promises.mkdir(managedRoot, { recursive: true });
  const [realRoot, realManagedRoot] = await Promise.all([
    fs.promises.realpath(root),
    fs.promises.realpath(managedRoot),
  ]);
  if (realManagedRoot !== path.join(realRoot, 'managed-skills')) {
    throw new Error('Managed-skill root must not escape through a symlink');
  }
  const skillDirectory = path.join(realManagedRoot, name);
  await fs.promises.mkdir(skillDirectory, { recursive: false });
  const skillPath = path.join(skillDirectory, 'SKILL.md');
  try {
    await fs.promises.writeFile(skillPath, content, { encoding: 'utf8', flag: 'wx' });
    return skillPath;
  } catch (error) {
    await fs.promises.rm(skillDirectory, { recursive: true, force: true });
    throw error;
  }
}

/** Promotes only artifacts linked to terminal tasks with a passing hard-gate candidate. */
export async function promoteVerifiedArtifacts(
  store: RsiStore,
  options: PromotionOptions,
): Promise<PromotionResult> {
  const verifiedTasks = store.listVerifiedTasks();
  const promotedTools: string[] = [];
  const promotedSkills: string[] = [];
  for (const task of verifiedTasks) {
    if (!task.stagingToolPath || task.promotedToolPath) continue;
    const promotedPath = await promoteStagingTool(options.cwd, task.stagingToolPath);
    if (promotedPath && store.markToolPromoted(task.id, promotedPath)) promotedTools.push(promotedPath);
  }

  const skillNames = new Set(verifiedTasks.flatMap((task) => task.skillName ? [task.skillName] : []));
  for (const skillName of skillNames) {
    const evidence = store.claimSkillPromotion(skillName);
    if (!evidence) continue;
    const body = buildSkillBody(evidence);
    try {
      const create = options.manageSkill ?? ((input: ManageSkillCreate) => manage_skill(input, options.agentDir));
      await create({
        action: 'create',
        name: skillName,
        description: `Verified ${skillName} practice from ${evidence.length} independent passing tasks.`,
        body,
      });
      promotedSkills.push(skillName);
    } catch (error) {
      if ((error as NodeJS.ErrnoException).code !== 'EEXIST') {
        store.releaseSkillPromotion(skillName);
        throw error;
      }
    }
  }
  return { verifiedTaskCount: verifiedTasks.length, promotedTools, promotedSkills };
}

function buildSkillBody(evidence: RsiTaskRecord[]): string {
  const lessons = evidence.map((task, index) =>
    `${index + 1}. ${sanitizeEvidence(task.experience ?? task.objective)}`,
  );
  return [
    '## Evidence-backed procedure',
    'Apply the following lessons only when the repository context matches their evidence.',
    ...lessons,
    '',
    '## Verification invariant',
    `Every lesson comes from a distinct task with exitCode=0 and testPassRatio=1 (${evidence.length} tasks).`,
    'Do not promote an unverified variation; run the complete project gate again.',
  ].join('\n');
}

function sanitizeEvidence(raw: string): string {
  return raw
    .replace(/\/tmp\/[a-zA-Z0-9_-]+/g, '/tmp/<temp>')
    .replace(/pts-\d+/g, 'pts-<session>')
    .replace(/\b(127\.0\.0\.1|0\.0\.0\.0|localhost):\d+\b/g, '<local-endpoint>')
    .replace(/[\x00-\x08\x0B\x0C\x0E-\x1F]/g, '')
    .trim()
    .slice(0, 4000);
}

async function promoteStagingTool(cwd: string, stagedPath: string): Promise<string | undefined> {
  const stagingRoot = path.resolve(cwd, '.omp/staging-tools');
  const source = path.resolve(cwd, stagedPath);
  if (!isInside(stagingRoot, source) || !/\.(?:ts|js)$/.test(source)) return undefined;
  if (!fs.existsSync(stagingRoot) || !fs.existsSync(source)) return undefined;
  const [realStagingRoot, realSource] = await Promise.all([
    fs.promises.realpath(stagingRoot),
    fs.promises.realpath(source),
  ]);
  if (!isInside(realStagingRoot, realSource) || !(await fs.promises.lstat(realSource)).isFile()) return undefined;

  const toolsRoot = path.resolve(cwd, '.omp/tools');
  await fs.promises.mkdir(toolsRoot, { recursive: true });
  const destination = path.join(toolsRoot, path.basename(realSource));
  try {
    await fs.promises.copyFile(realSource, destination, fs.constants.COPYFILE_EXCL);
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code !== 'EEXIST') throw error;
    const [staged, existing] = await Promise.all([
      fs.promises.readFile(realSource),
      fs.promises.readFile(destination),
    ]);
    if (!staged.equals(existing)) return undefined;
  }
  return path.relative(cwd, destination);
}

function isInside(root: string, candidate: string): boolean {
  const relative = path.relative(root, candidate);
  return relative !== '' && relative !== '..' && !relative.startsWith(`..${path.sep}`) && !path.isAbsolute(relative);
}

export function createEvolutionLearnerHook(options: { agentDir?: string } = {}) {
  return function evolutionLearnerHook(pi: HookAPI): void {
    pi.on('agent_end', async (event, ctx) => {
      if (event.isTerminal === false) return;
      const dbPath = path.join(ctx.cwd, '.omp/rsi.db');
      if (!fs.existsSync(dbPath)) return;
      const store = RsiStore.open(dbPath);
      try {
        await promoteVerifiedArtifacts(store, { cwd: ctx.cwd, agentDir: options.agentDir });
      } finally {
        store.close();
      }
    });
  };
}

export default createEvolutionLearnerHook();
