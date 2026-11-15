# n8n demo workflows

These are the invoice-demo workflows the bridge's n8n port is verified against. The Code nodes
inside them are **generated** from `../engine.js` by `node ../scripts/build-n8n-code.js` — do not
edit them by hand. `node ../scripts/build-n8n-code.js --check` fails if they have drifted, and the
bridge test suite runs `tools/test_guard.js` to prove the generated text still executes the same
rules.

Install-time placeholders (`REPLACE_WITH_BRIDGE_TOKEN`, the Shotty URL, spreadsheet and credential
ids) are substituted by `../scripts/deploy-n8n.js`. Nothing here contains a live secret.
