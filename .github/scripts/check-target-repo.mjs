// Fails the sandbox before the model call when the token could never open the
// pull request: it cannot see TARGET_REPO, or can see it but not push. Reads go
// through GitHub's read-only MCP server, like every other GitHub read here.
import { McpClient } from '../../src/agent/mcp.js';

const { GH_PAT: token, TARGET_REPO: target } = process.env;
const fail = (message) => {
  console.log(`::error::${message}`);
  process.exit(1);
};

const client = new McpClient({
  url: 'https://api.githubcopilot.com/mcp/readonly',
  headers: { Authorization: `Bearer ${token}` },
  name: 'panda-bot-development-sandbox',
});

let found;
try {
  const result = await client.callToolResult('search_repositories', { query: `repo:${target}`, minimal_output: false, perPage: 1 });
  if (result?.isError) throw new Error(result.content?.[0]?.text || 'search_repositories failed');
  found = JSON.parse(result.content.find((part) => part.type === 'text').text).items?.find(
    (item) => item.full_name?.toLowerCase() === target.toLowerCase(),
  );
} catch (error) {
  // GitHub answers a missing or hidden repository with a search validation error.
  found = null;
  console.log(error.message.slice(0, 500));
}
if (!found) fail(`The sandbox token cannot read ${target}. Check that the repository exists and that GH_PAT grants it Contents and Pull requests access.`);
if (found.permissions?.push === false) fail(`The sandbox token has read-only access to ${target} and cannot push the development branch.`);
console.log(`::notice::${target} is readable and writable with GH_PAT.`);
