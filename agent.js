/**
 * The model tool-call loop — I4b (2 of 5). This is the change that makes Shotty agentic:
 * the MODEL decides which tool to call. `/tool` still exists for callers and tests, but the
 * phone task path goes through here.
 *
 * Shape of one task:
 *
 *   owner message
 *     -> retrieve notes, build prompt, hand the model the tool list
 *     -> model returns tool_calls
 *     -> read/compute tools run immediately; their result goes back as a `tool` message
 *     -> model sees the result and may call another tool ... (up to maxSteps)
 *     -> model returns text: that is the reply
 *
 * A write tool is different: it does NOT run. It opens an approval and the loop stops with
 * `pending_approval`; the owner approves once on the phone and the tool executes once.
 *
 * The plan's risk note is the reason `steps` is returned: one successful tool call proves
 * nothing. A chain is only claimed when several model turns each consume the previous
 * result, and the test exercises exactly that.
 */
import { makeRunId } from './log.js';
import { requiresApproval } from './guard.js';
import { buildPrompt } from './context.js';
import { toModelTools } from './mcp.js';

const TOOL_MESSAGE = (name, value) => ({
  role: 'tool',
  tool_name: name,
  content: typeof value === 'string' ? value : JSON.stringify(value),
});

export function createAgentHandler({
  chat,
  tools,
  approvals,
  kb = null,
  facts = [],
  maxSteps = 6,
  maxChunks = 3,
} = {}) {
  if (typeof chat !== 'function') throw new Error('createAgentHandler requires a chat function');
  if (!tools || typeof tools !== 'object') throw new Error('createAgentHandler requires tools');
  if (!approvals || typeof approvals.open !== 'function') {
    throw new Error('createAgentHandler requires an approval queue');
  }

  const modelTools = toModelTools(tools);
  const toolSummaries = modelTools.map((t) => ({
    name: t.function.name,
    description: t.function.description,
  }));

  return async function handle(message) {
    const task = typeof message === 'string' ? message : message?.text;
    if (typeof task !== 'string' || !task.trim()) {
      throw new Error('empty task: the message carries no text');
    }
    const history = Array.isArray(message?.history) ? message.history.slice(-6) : [];
    const runId = message?.runId ?? makeRunId();
    const hits = kb ? kb.search(task.trim(), maxChunks) : [];
    const prompt = buildPrompt(task.trim(), hits, { facts, history, tools: toolSummaries });

    const messages = [{ role: 'user', content: prompt }];
    const steps = [];

    for (let i = 0; i < maxSteps; i += 1) {
      const turn = await chat({ messages, tools: modelTools });
      const calls = Array.isArray(turn?.tool_calls) ? turn.tool_calls : [];

      if (!calls.length) {
        const reply = String(turn?.content ?? '').trim();
        return { reply: reply || 'The model returned an empty answer.', status: 'ok', steps, run_id: runId };
      }

      messages.push(
        turn.assistant ?? {
          role: 'assistant',
          content: String(turn?.content ?? ''),
          tool_calls: calls.map((c) => ({ id: c.id, type: 'function', function: { name: c.name, arguments: c.arguments } })),
        },
      );

      for (const call of calls) {
        const tool = tools[call.name];
        if (!tool) {
          steps.push({ tool: call.name, status: 'unknown_tool' });
          messages.push(TOOL_MESSAGE(call.name, { error: `unknown tool: ${call.name}` }));
          continue;
        }

        // I4b invoice upgrade: a deterministic precheck runs BEFORE the owner is asked, so
        // the phone never shows an approval the policy already rejects.
        if (typeof tool.precheck === 'function') {
          try {
            await tool.precheck(call.arguments);
          } catch (err) {
            const error = err instanceof Error ? err.message : String(err);
            steps.push({ tool: call.name, status: 'policy_rejected', error });
            messages.push(TOOL_MESSAGE(call.name, { error, rejected_by_policy: true }));
            continue;
          }
        }

        if (requiresApproval(tool.class)) {
          const rec = await approvals.open({ runId, tool: call.name, payload: call.arguments });
          steps.push({ tool: call.name, status: 'pending_approval', id: rec.id });
          return {
            reply:
              `I need your approval to run ${call.name}. Nothing has been written yet — ` +
              'approve or reject it below.',
            status: 'pending_approval',
            approval: {
              id: rec.id,
              tool: call.name,
              payload: call.arguments,
              class: tool.class,
              duplicate: Boolean(rec.duplicate),
            },
            steps,
            run_id: runId,
          };
        }

        try {
          const result = await tool.run(call.arguments);
          steps.push({ tool: call.name, status: 'ok', result });
          messages.push(TOOL_MESSAGE(call.name, result));
        } catch (err) {
          const error = err instanceof Error ? err.message : String(err);
          steps.push({ tool: call.name, status: 'error', error });
          messages.push(TOOL_MESSAGE(call.name, { error }));
        }
      }
    }

    return {
      reply: `I stopped after ${maxSteps} tool steps without a final answer. Nothing else ran.`,
      status: 'max_steps',
      steps,
      run_id: runId,
    };
  };
}
