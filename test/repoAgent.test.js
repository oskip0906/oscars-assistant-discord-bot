import { test } from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { runRepoAgent, createWorkspace } from '../src/agent/tools/repoAgent.js';

function scaffold(files) {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), 'panda-agent-'));
  for (const [rel, content] of Object.entries(files)) {
    const abs = path.join(root, rel);
    fs.mkdirSync(path.dirname(abs), { recursive: true });
    fs.writeFileSync(abs, content);
  }
  return root;
}

// A scripted model: each entry is one assistant turn.
function scriptedModel(turns) {
  const seen = [];
  let index = 0;
  const call = async (messages) => {
    seen.push(messages[messages.length - 1]);
    const turn = turns[index++] ?? { content: 'done' };
    if (turn.content) return { content: turn.content };
    return {
      content: '',
      tool_calls: turn.calls.map((c, i) => ({
        id: `call_${index}_${i}`,
        function: { name: c.name, arguments: JSON.stringify(c.args ?? {}) },
      })),
    };
  };
  call.seen = seen;
  return call;
}

const silent = () => {};

test('the model reads a file, rewrites it, and finishes', async () => {
  const root = scaffold({ 'src/menu.js': 'export const color = 0xb57edc;\n' });
  const callModel = scriptedModel([
    { calls: [{ name: 'read_file', args: { path: 'src/menu.js' } }] },
    { calls: [{ name: 'write_file', args: { path: 'src/menu.js', content: 'export const color = randomColor();\n' } }] },
    { calls: [{ name: 'finish', args: { summary: 'Randomise the colour', description: 'Swapped the constant for a call.' } }] },
  ]);

  const result = await runRepoAgent({ instruction: 'randomise the colour', root, tracked: ['src/menu.js'], callModel, log: silent });

  assert.deepEqual(result.changed, ['src/menu.js']);
  assert.equal(result.summary, 'Randomise the colour');
  assert.equal(result.completed, true);
  assert.equal(fs.readFileSync(path.join(root, 'src/menu.js'), 'utf8'), 'export const color = randomColor();\n');
});

test('a finish with nothing written is refused, and the model gets to correct it', async () => {
  const root = scaffold({ 'src/a.js': 'const a = 1;\n' });
  const callModel = scriptedModel([
    // The exact failure that killed run 30187527354: it described the change.
    { calls: [{ name: 'finish', args: { summary: 'Would change a.js', description: 'You should replace the constant.' } }] },
    { calls: [{ name: 'write_file', args: { path: 'src/a.js', content: 'const a = 2;\n' } }] },
    { calls: [{ name: 'finish', args: { summary: 'Changed a.js', description: 'Replaced the constant.' } }] },
  ]);

  const result = await runRepoAgent({ instruction: 'bump a', root, tracked: ['src/a.js'], callModel, log: silent });

  assert.deepEqual(result.changed, ['src/a.js']);
  assert.equal(fs.readFileSync(path.join(root, 'src/a.js'), 'utf8'), 'const a = 2;\n');
});

test('a run that writes nothing at all fails loudly', async () => {
  const root = scaffold({ 'src/a.js': 'const a = 1;\n' });
  const callModel = scriptedModel([{ calls: [{ name: 'read_file', args: { path: 'src/a.js' } }] }, { content: 'I would change it.' }, { content: 'Still just talking.' }, { content: 'And again.' }]);

  await assert.rejects(
    runRepoAgent({ instruction: 'bump a', root, tracked: ['src/a.js'], callModel, log: silent }),
    /never wrote a file/,
  );
});

test('secrets, .github, and paths outside the checkout are refused', async () => {
  const root = scaffold({ 'src/a.js': 'ok' });
  const workspace = createWorkspace(root, ['src/a.js']);

  for (const bad of ['.env', '.env.local', '.github/workflows/development-sandbox.yml', 'data/context/x.json', 'node_modules/p/index.js', '../escape.js', '/etc/passwd']) {
    assert.match(workspace.write(bad, 'pwned'), /Refused/, `${bad} must be refused`);
    assert.match(workspace.read(bad), /Refused/, `${bad} must be refused`);
  }
  assert.deepEqual(workspace.changed, []);
  assert.equal(fs.existsSync(path.join(root, '.env')), false);
});

test('a bad tool call is reported to the model instead of ending the run', async () => {
  const root = scaffold({ 'src/a.js': 'const a = 1;\n' });
  let sawArgumentError = false;
  const callModel = async (messages) => {
    const last = messages[messages.length - 1];
    if (last.role === 'tool' && /not valid JSON/.test(last.content)) sawArgumentError = true;
    if (messages.length === 2) {
      return { content: '', tool_calls: [{ id: 'c1', function: { name: 'write_file', arguments: '{"path": "src/a.js", content:}' } }] };
    }
    if (!sawArgumentError) return { content: 'waiting' };
    if (!messages.some((m) => m.role === 'tool' && /^Wrote /.test(m.content || ''))) {
      return { content: '', tool_calls: [{ id: 'c2', function: { name: 'write_file', arguments: '{"path":"src/a.js","content":"const a = 2;\\n"}' } }] };
    }
    return { content: '', tool_calls: [{ id: 'c3', function: { name: 'finish', arguments: '{"summary":"ok","description":"done"}' } }] };
  };

  const result = await runRepoAgent({ instruction: 'bump a', root, tracked: ['src/a.js'], callModel, log: silent });

  assert.equal(sawArgumentError, true, 'the model must be told its JSON was malformed');
  assert.deepEqual(result.changed, ['src/a.js']);
});

test("a rewrite keeps the file's trailing newline", () => {
  const root = scaffold({ 'src/a.js': 'const a = 1;\n', 'src/none.js': 'no newline here' });
  const workspace = createWorkspace(root, ['src/a.js', 'src/none.js']);

  // Seen for real: the model rewrote a whole file and dropped the final
  // newline, putting "\\ No newline at end of file" in the diff of the edit.
  workspace.write('src/a.js', 'const a = 2;');
  assert.equal(fs.readFileSync(path.join(root, 'src/a.js'), 'utf8'), 'const a = 2;\n');

  // A file that never ended with one is left exactly as written.
  workspace.write('src/none.js', 'still none');
  assert.equal(fs.readFileSync(path.join(root, 'src/none.js'), 'utf8'), 'still none');

  workspace.write('src/new.js', 'brand new');
  assert.equal(fs.readFileSync(path.join(root, 'src/new.js'), 'utf8'), 'brand new');
});

test('list_files filters, and a created file becomes listable', async () => {
  const root = scaffold({ 'src/a.js': 'a', 'test/a.test.js': 'b' });
  const workspace = createWorkspace(root, ['src/a.js', 'test/a.test.js']);

  assert.equal(workspace.list('test/'), 'test/a.test.js');
  workspace.write('src/b.js', 'new');
  assert.match(workspace.list('src/'), /src\/b\.js/);
});

test('a deletion is applied and recorded', async () => {
  const root = scaffold({ 'src/old.js': 'gone soon' });
  const callModel = scriptedModel([
    { calls: [{ name: 'delete_file', args: { path: 'src/old.js' } }] },
    { calls: [{ name: 'finish', args: { summary: 'Removed old.js', description: 'Unused.' } }] },
  ]);

  const result = await runRepoAgent({ instruction: 'delete old.js', root, tracked: ['src/old.js'], callModel, log: silent });

  assert.deepEqual(result.changed, ['src/old.js']);
  assert.equal(fs.existsSync(path.join(root, 'src/old.js')), false);
});

test('hitting the step limit still ships the edits already written', async () => {
  const root = scaffold({ 'src/a.js': 'const a = 1;\n' });
  const callModel = scriptedModel([
    { calls: [{ name: 'write_file', args: { path: 'src/a.js', content: 'const a = 2;\n' } }] },
    { calls: [{ name: 'read_file', args: { path: 'src/a.js' } }] },
    { calls: [{ name: 'read_file', args: { path: 'src/a.js' } }] },
  ]);

  const result = await runRepoAgent({ instruction: 'bump a', root, tracked: ['src/a.js'], callModel, log: silent, maxSteps: 3 });

  assert.deepEqual(result.changed, ['src/a.js']);
  assert.equal(result.completed, false, 'the pull request must say it was cut short');
});
