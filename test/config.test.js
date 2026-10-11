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

test('YT_COOKIES_B64 is decoded into a private cookies file that wins over YT_COOKIES_FILE', async () => {
  const saved = { b64: process.env.YT_COOKIES_B64, file: process.env.YT_COOKIES_FILE };
  try {
    process.env.YT_COOKIES_B64 = Buffer.from('# Netscape HTTP Cookie File\n').toString('base64');
    process.env.YT_COOKIES_FILE = './cookies.txt';
    const { config } = await import('../src/config.js?cookies');
    assert.notEqual(config.ytCookiesFile, './cookies.txt');
    assert.equal((await import('node:fs')).readFileSync(config.ytCookiesFile, 'utf8'), '# Netscape HTTP Cookie File\n');
  } finally {
    for (const [key, value] of [['YT_COOKIES_B64', saved.b64], ['YT_COOKIES_FILE', saved.file]]) {
      if (value === undefined) delete process.env[key];
      else process.env[key] = value;
    }
  }
});
