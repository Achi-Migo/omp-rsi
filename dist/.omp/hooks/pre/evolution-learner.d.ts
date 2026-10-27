import type { HookAPI } from '@oh-my-pi/pi-coding-agent/extensibility/hooks';
import { RsiStore } from '../../../src/journal/rsi-store.ts';
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
export declare function manage_skill(input: ManageSkillCreate, agentDir?: string): Promise<string>;
/** Promotes only artifacts linked to terminal tasks with a passing hard-gate candidate. */
export declare function promoteVerifiedArtifacts(store: RsiStore, options: PromotionOptions): Promise<PromotionResult>;
export declare function createEvolutionLearnerHook(options?: {
    agentDir?: string;
}): (pi: HookAPI) => void;
declare const _default: (pi: HookAPI) => void;
export default _default;
