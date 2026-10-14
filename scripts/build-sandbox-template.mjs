// Builds the PMS sandbox template that /sandbox and the sandbox tool start from:
// Python 3 (numpy, pandas, matplotlib, requests), Node.js, git, curl and jq.
// Run it once by hand, and again only to change what is installed:
//
//   PMS_SANDBOX_TOKEN=pms_... node scripts/build-sandbox-template.mjs
//
// It takes a few minutes. The template is named PMS_SANDBOX_TEMPLATE (default panda-sandbox).
import { Template, defaultBuildLogger } from 'e2b';
import { config } from '../src/config.js';
import { connectionOpts } from '../src/agent/tools/sandbox.js';

if (!config.pmsSandboxToken) throw new Error('Set PMS_SANDBOX_TOKEN to a PMS project token (pms_...).');

const template = Template()
  .fromUbuntuImage('24.04')
  .aptInstall(['python3', 'python3-numpy', 'python3-pandas', 'python3-matplotlib', 'python3-requests', 'nodejs', 'npm', 'git', 'curl', 'jq']);

const built = await Template.build(template, config.sandboxTemplate, { ...connectionOpts(config.pmsSandboxToken), onBuildLogs: defaultBuildLogger() });
console.log(`Built template ${built.name} (${built.templateId}).`);
