import test from 'node:test';
import assert from 'node:assert/strict';

// config.js reads the env once at import, so each case imports a fresh copy.
test('OWNER_DISCORD_ID sets the owner, and anything that is not a Discord id falls back to the built-in one', async () => {
  const saved = process.env.OWNER_DISCORD_ID;
  try {
    process.env.OWNER_DISCORD_ID = '123456789012345678';
    assert.equal((await import('../src/config.js?valid')).config.ownerId, '123456789012345678');
    for (const [i, junk] of ['', 'oscar', '123', '1234567890123456789012'].entries()) {
      process.env.OWNER_DISCORD_ID = junk;
      assert.equal((await import(`../src/config.js?junk${i}`)).config.ownerId, '767525911695851550');
    }
  } finally {
    if (saved === undefined) delete process.env.OWNER_DISCORD_ID;
    else process.env.OWNER_DISCORD_ID = saved;
  }
});
