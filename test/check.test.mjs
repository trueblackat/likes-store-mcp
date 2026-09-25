// Режим --check и прочие флаги командной строки.

import { test, before, after } from 'node:test';
import assert from 'node:assert/strict';
import { startFakeApi, runCli, KEY } from './helpers.mjs';

let api;
before(async () => {
  api = await startFakeApi();
});
after(() => api.close());

test('--check с рабочим ключом: адрес, оба баланса, число услуг без своих комментариев; код 0', async () => {
  const r = await runCli(api, { LS_API_KEY: KEY });
  assert.equal(r.code, 0, r.stderr);
  assert.match(r.stdout, new RegExp(`^Адрес: ${api.url.replace(/\./g, '\\.')}$`, 'm'));
  assert.match(r.stdout, /^Ключ рабочий\.$/m);
  assert.match(r.stdout, /^Баланс: 1\s500 ₽, подарочный: 200 ₽$/m);
  assert.match(r.stdout, /^Услуг доступно: 4$/m);
  assert.doesNotMatch(r.stdout, /только чтение/);
  assert.ok(!(r.stdout + r.stderr).includes(KEY));
});

test('--check в режиме только чтения это и говорит', async () => {
  const r = await runCli(api, { LS_API_KEY: KEY, LS_READONLY: '1' });
  assert.equal(r.code, 0, r.stderr);
  assert.match(r.stdout, /Режим: только чтение/);
});

test('--check без ключа — подсказка, где его взять; код 1', async () => {
  const r = await runCli(api, {});
  assert.equal(r.code, 1);
  assert.match(r.stderr, /Нет ключа: задайте LS_API_KEY/);
  assert.match(r.stderr, /\/dashboard\/api/);
});

test('--check с отозванным ключом — код 1, ключ не печатается', async () => {
  const bad = 'ls_revoked-key-0000000000000000';
  const r = await runCli(api, { LS_API_KEY: bad });
  assert.equal(r.code, 1);
  assert.match(r.stderr, /Проверка не прошла: Ключ не найден или отозван \(код unauthorized\)/);
  assert.ok(!(r.stdout + r.stderr).includes(bad));
});

test('--check с ключом, в котором перевод строки, — понятный отказ без эха ключа', async () => {
  const r = await runCli(api, { LS_API_KEY: 'ls_abc\ndef-ghijklmnop' });
  assert.equal(r.code, 1);
  assert.match(r.stderr, /недопустимые символы/);
  assert.ok(!r.stderr.includes('ghijklmnop'));
});

test('--version, --help и незнакомый флаг', async () => {
  assert.deepEqual(await runCli(api, {}, ['--version']), { code: 0, stdout: '0.1.0\n', stderr: '' });
  const help = await runCli(api, {}, ['--help']);
  assert.equal(help.code, 0);
  assert.match(help.stdout, /--check/);
  const bad = await runCli(api, {}, ['--wat']);
  assert.equal(bad.code, 2);
  assert.match(bad.stderr, /--check/);
});
