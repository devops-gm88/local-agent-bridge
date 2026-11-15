/**
 * Invoice tools — the first real job wired into Shotty, ported from the n8n invoice demo.
 *
 * These sit inside the same tool loop the model already uses, so the agent can:
 *   check_invoice   read the approved-supplier policy and say whether an invoice is fileable
 *   file_invoice    file it — but only after the deterministic policy check passes AND the
 *                   owner approves; the tool itself refuses an ineligible invoice
 *   read_invoices   count what has been filed
 *
 * The policy check runs twice on purpose: `precheck()` before an approval is even opened
 * (so the owner is never asked to approve something the policy already rejects) and again
 * inside `run()` (so a queue replay or a direct caller cannot bypass it).
 *
 * `file_invoice` still appends JSONL, not a client's Sheets account. That is the connector
 * boundary: one `run()` body swaps in Sheets/GHL without touching the gate.
 */
import { appendFile, mkdir, readFile } from 'node:fs/promises';
import { dirname } from 'node:path';
import { CLASSES } from './guard.js';
import { inspectInvoice, normaliseInvoice } from './engine.js';

const INVOICE_SCHEMA = {
  type: 'object',
  properties: {
    invoice: {
      type: 'object',
      description: 'the invoice to check or file: {vendor, amount, currency, invoice_ref, notes}',
    },
  },
  required: ['invoice'],
  additionalProperties: false,
};

async function readPolicies(vendorsPath) {
  if (!vendorsPath) return [];
  let text;
  try {
    text = await readFile(vendorsPath, 'utf8');
  } catch (err) {
    if (err.code === 'ENOENT') return [];
    throw err;
  }
  const parsed = JSON.parse(text);
  const rows = Array.isArray(parsed) ? parsed : parsed?.vendors;
  return Array.isArray(rows) ? rows : [];
}

export function createInvoiceTools({ invoicesPath, vendorsPath } = {}) {
  if (!invoicesPath) throw new Error('createInvoiceTools requires invoicesPath');

  const inspect = async (invoice) => inspectInvoice({ invoice, policies: await readPolicies(vendorsPath) });

  const ensureEligible = async (invoice) => {
    const check = await inspect(invoice);
    if (!check.eligible) {
      const err = new Error(`invoice is not eligible to file: ${check.reasons.join('; ')}`);
      err.code = 'EPOLICY';
      err.details = check;
      throw err;
    }
    return check;
  };

  return {
    check_invoice: {
      class: CLASSES.READ,
      description: 'Check an invoice against the approved-supplier policy. Returns the matched vendor, approved limit, whether it is eligible to file, and the reasons. Use before proposing to file anything.',
      inputSchema: INVOICE_SCHEMA,
      async run({ invoice } = {}) {
        return inspect(invoice);
      },
    },

    file_invoice: {
      class: CLASSES.WRITE,
      description: 'File an approved invoice to the ledger. This is a write: it runs only after the deterministic policy check passes and the owner approves.',
      inputSchema: INVOICE_SCHEMA,
      /** Runs before an approval is opened. Fails closed on any policy problem. */
      async precheck({ invoice } = {}) {
        await ensureEligible(invoice);
      },
      async run({ invoice } = {}) {
        const check = await ensureEligible(invoice); // defence in depth: re-check on execution
        const record = {
          ...check.invoice,
          category: check.policy.category,
          approved_limit: check.policy.approved_limit,
          decision: 'filed',
          filed_at: new Date().toISOString(),
        };
        await mkdir(dirname(invoicesPath), { recursive: true });
        await appendFile(invoicesPath, JSON.stringify(record) + '\n', 'utf8');
        return { filed: record };
      },
    },

    file_invoice_override: {
      class: CLASSES.WRITE,
      description: 'File an invoice that the policy held as an exception, after the owner explicitly approves the override. This records policy_override:true and the failed policy reasons in the ledger. Use only when the owner has decided to override.',
      inputSchema: {
        type: 'object',
        properties: {
          invoice: { type: 'object', description: 'the exception invoice: {vendor, amount, currency, invoice_ref}' },
          reason: { type: 'string', description: 'the owner-visible reason for overriding the policy' },
        },
        required: ['invoice'],
        additionalProperties: false,
      },
      async precheck({ invoice } = {}) {
        const normalised = normaliseInvoice(invoice);
        if (normalised.problems.length) {
          const err = new Error(`invoice is not fileable even with an override: ${normalised.problems.join('; ')}`);
          err.code = 'EPOLICY';
          throw err;
        }
      },
      async run({ invoice, reason = '' } = {}) {
        const check = await inspect(invoice);
        if (check.invoice.problems.length) {
          throw new Error(`invoice is not fileable: ${check.invoice.problems.join('; ')}`);
        }
        const record = {
          ...check.invoice,
          category: check.policy.category,
          approved_limit: check.policy.approved_limit,
          decision: 'filed_override',
          policy_override: true,
          policy_reasons: check.reasons,
          override_reason: String(reason ?? ''),
          filed_at: new Date().toISOString(),
        };
        await mkdir(dirname(invoicesPath), { recursive: true });
        await appendFile(invoicesPath, JSON.stringify(record) + '\n', 'utf8');
        return { filed: record, policy_override: true };
      },
    },

    read_invoices: {
      class: CLASSES.READ,
      description: 'Count the invoices filed in the ledger so far.',
      inputSchema: { type: 'object', properties: {}, additionalProperties: false },
      async run() {
        try {
          const text = await readFile(invoicesPath, 'utf8');
          return { filed: text.trim() ? text.trim().split('\n').length : 0 };
        } catch (err) {
          if (err.code === 'ENOENT') return { filed: 0 };
          throw err;
        }
      },
    },
  };
}
