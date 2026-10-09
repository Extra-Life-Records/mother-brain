import test from 'node:test';
import assert from 'node:assert/strict';
import { mkdtemp, writeFile } from 'node:fs/promises';
import { join } from 'node:path';
import { tmpdir } from 'node:os';
import { waitForOtpCode } from '../../src/tools/builtin/inbox-otp.ts';

test('waitForOtpCode reads OTP from env source', async () => {
  process.env['MB_TEST_OTP'] = 'Your login code is 824199';
  const result = await waitForOtpCode({
    source: 'env',
    envVar: 'MB_TEST_OTP',
    timeoutMs: 1_000,
    pollMs: 20,
  });
  assert.equal(result.code, '824199');
  delete process.env['MB_TEST_OTP'];
});

test('waitForOtpCode reads latest OTP from file source', async () => {
  const dir = await mkdtemp(join(tmpdir(), 'mb-otp-test-'));
  const inboxPath = join(dir, 'inbox.txt');
  await writeFile(inboxPath, 'Older code 111111\nLatest code 222222', 'utf-8');

  const result = await waitForOtpCode({
    source: 'file',
    filePath: inboxPath,
    timeoutMs: 1_000,
    pollMs: 20,
  });

  assert.equal(result.code, '222222');
});

