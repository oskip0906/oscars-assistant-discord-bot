// Start/finish log lines for the two development surfaces, self_fix and
// /run_dev. Both begin as a Discord interaction and end minutes later inside a
// GitHub Actions sandbox, so stdout is the only place their whole lifecycle
// lands on one timeline. self_fix in particular ends by restarting the process:
// without a finish line there is no record of why the bot went away, or of a
// run that was approved and then died in the sandbox.

const MAX_VALUE = 300;

function render(value) {
  const text = String(value ?? '').replace(/\s+/g, ' ').trim().slice(0, MAX_VALUE);
  return !text || /[\s"]/.test(text) ? JSON.stringify(text) : text;
}

export function formatDevRunLine(kind, phase, fields = {}) {
  const pairs = Object.entries(fields)
    .filter(([, value]) => value !== undefined && value !== null && value !== '')
    .map(([key, value]) => `${key}=${render(value)}`);
  return [`[panda] ${kind} ${phase}`, ...pairs].join(' ');
}

// Logs the start line immediately and returns the matching finish logger, so a
// caller cannot log one half of the pair without the other being one call away.
// The returned function is idempotent: a finish already reported on the happy
// path must not be logged a second time by a `finally` block.
export function startDevRunLog(kind, fields = {}, { write = console.log, now = Date.now } = {}) {
  const startedAt = now();
  write(formatDevRunLine(kind, 'start', fields));

  let finished = false;
  return (outcome, extra = {}) => {
    if (finished) return;
    finished = true;
    write(
      formatDevRunLine(kind, 'finish', {
        outcome,
        seconds: ((now() - startedAt) / 1000).toFixed(1),
        ...fields,
        ...extra,
      }),
    );
  };
}
