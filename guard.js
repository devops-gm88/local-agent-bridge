/**
 * Tool classes and the approval rule. This is the security boundary of the agent:
 * anything that changes state or leaves the machine must be approved by the owner.
 */
import { stableStringify, payloadHash, approvalKey } from './engine.js';

export const CLASSES = Object.freeze({
  READ: 'read',
  COMPUTE: 'compute',
  WRITE: 'write',
  EXTERNAL: 'external-send',
});

const APPROVAL_CLASSES = new Set([CLASSES.WRITE, CLASSES.EXTERNAL]);

/** True for any tool whose effect is not reversible: a write or anything sent out. */
export function requiresApproval(toolClass) {
  return APPROVAL_CLASSES.has(toolClass);
}

// The hash helpers live in engine.js now: one definition is used by the guard, the approval
// queue and (later) the generated n8n node code.
export { stableStringify, payloadHash, approvalKey };
