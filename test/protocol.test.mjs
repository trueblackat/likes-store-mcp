// Протокол MCP: обе эпохи (initialize и 2026-07-28 без рукопожатия), ошибки
// JSON-RPC, список инструментов и режим только для чтения.

import { test, before, after } from 'node:test';
import assert from 'node:assert/strict';
import { startFakeApi, withServer } from './helpers.mjs';

let api;
before(async () => {
  api = await startFakeApi();
});
after(() => api.close());

const MODERN = { _meta: { 'io.modelcontextprotocol/protocolVersion': '2026-07-28', 'io.modelcontextprotocol/clientCapabilities': {} } };

// ── Старая эпоха: рукопожатие ───────────────────────────────────────────────────

test('initialize повторяет знакомую версию клиента и называет сервер', () =>
  withServer(api, {}, async (s) => {
    const { result } = await s.request('initialize', { protocolVersion: '2025-06-18', capabilities: {} });
    assert.equal(result.protocolVersion, '2025-06-18');
    assert.equal(result.serverInfo.name, 'likes-store');
    assert.equal(result.serverInfo.version, '0.1.0');
    assert.deepEqual(result.capabilities.tools, { listChanged: false });
    assert.match(result.instructions, /quote_order/);
  }));

test('initialize с незнакомой версией отвечает нашей последней из старых — 2025-11-25', () =>
  withServer(api, {}, async (s) => {
    assert.equal((await s.request('initialize', { protocolVersion: '2099-01-01' })).result.protocolVersion, '2025-11-25');
    // 2026-07-28 — версия без рукопожатия: кто зовёт initialize, тот живёт по старым правилам.
    assert.equal((await s.request('initialize', { protocolVersion: '2026-07-28' })).result.protocolVersion, '2025-11-25');
    assert.equal((await s.request('initialize', { protocolVersion: '2024-11-05' })).result.protocolVersion, '2024-11-05');
  }));

test('полный старый сеанс: initialize → initialized → tools/list → tools/call', () =>
  withServer(api, {}, async (s) => {
    await s.request('initialize', { protocolVersion: '2025-11-25', capabilities: {} });
    s.notify('notifications/initialized');
    const { result } = await s.request('tools/list');
    assert.equal(result.tools.length, 8);
    const balance = await s.call('get_balance');
    assert.deepEqual(balance, { balance: 1500, bonusBalance: 200 });
  }));

// ── Новая эпоха: 2026-07-28 без рукопожатия ─────────────────────────────────────

test('server/discover: версии обеих эпох, возможности, serverInfo в _meta, срок кеша', () =>
  withServer(api, {}, async (s) => {
    const { result } = await s.request('server/discover', MODERN);
    assert.equal(result.resultType, 'complete');
    assert.ok(result.supportedVersions.includes('2026-07-28'));
    assert.ok(result.supportedVersions.includes('2025-11-25'));
    assert.deepEqual(result.capabilities.tools, { listChanged: false });
    assert.equal(result._meta['io.modelcontextprotocol/serverInfo'].name, 'likes-store');
    assert.equal(typeof result.ttlMs, 'number');
    assert.equal(result.cacheScope, 'private');
    assert.match(result.instructions, /place_order/);
  }));

test('2026-07-28: tools/list и tools/call работают без initialize, в каждом ответе resultType', () =>
  withServer(api, {}, async (s) => {
    const list = await s.request('tools/list', MODERN);
    assert.equal(list.result.resultType, 'complete');
    assert.equal(list.result.tools.length, 8);
    assert.equal(typeof list.result.ttlMs, 'number');

    const call = await s.request('tools/call', { ...MODERN, name: 'get_balance', arguments: {} });
    assert.equal(call.result.resultType, 'complete');
    assert.deepEqual(JSON.parse(call.result.content[0].text), { balance: 1500, bonusBalance: 200 });

    // Отказ инструмента — тоже «complete»: запрос выполнен, результат — ошибка.
    const bad = await s.request('tools/call', { ...MODERN, name: 'get_order', arguments: {} });
    assert.equal(bad.result.resultType, 'complete');
    assert.equal(bad.result.isError, true);
  }));

test('незнакомая версия в _meta — UnsupportedProtocolVersionError (-32022) со списком наших', () =>
  withServer(api, {}, async (s) => {
    const before = api.state.requests.length;
    for (const method of ['server/discover', 'tools/list', 'tools/call']) {
      const res = await s.request(method, {
        _meta: { 'io.modelcontextprotocol/protocolVersion': '1900-01-01' },
        name: 'get_balance',
        arguments: {},
      });
      assert.equal(res.error.code, -32022, method);
      assert.equal(res.error.data.requested, '1900-01-01');
      assert.ok(res.error.data.supported.includes('2026-07-28'));
      assert.ok(res.error.data.supported.includes('2025-11-25'));
    }
    assert.equal(api.state.requests.length, before, 'до API отказ по версии не доходит');
  }));

// ── JSON-RPC ────────────────────────────────────────────────────────────────────

test('на уведомления сервер молчит, на ping отвечает пустым результатом', () =>
  withServer(api, {}, async (s) => {
    s.notify('notifications/initialized');
    s.notify('notifications/cancelled', { requestId: 99 });
    const res = await s.request('ping');
    assert.equal(res.id, 1);
    assert.deepEqual(res.result, { resultType: 'complete' });
    assert.deepEqual(s.unsolicited, []);
  }));

test('неизвестный метод — -32601, неизвестный инструмент — -32602, битая строка — -32700', () =>
  withServer(api, {}, async (s) => {
    assert.equal((await s.request('resources/list')).error.code, -32601);
    assert.equal((await s.request('tools/call', { name: 'nope', arguments: {} })).error.code, -32602);

    s.raw('{это не json');
    await s.request('ping'); // дождаться, пока сервер обработает строку перед ним
    assert.equal(s.unsolicited.length, 1);
    assert.equal(s.unsolicited[0].id, null);
    assert.equal(s.unsolicited[0].error.code, -32700);
  }));

// ── Список инструментов ─────────────────────────────────────────────────────────

const HINTS = ['readOnlyHint', 'destructiveHint', 'idempotentHint', 'openWorldHint'];

test('tools/list: восемь инструментов, у каждого title, описание, схема и все четыре annotations', () =>
  withServer(api, {}, async (s) => {
    const { tools } = (await s.request('tools/list')).result;
    assert.deepEqual(
      tools.map((t) => t.name).sort(),
      ['get_balance', 'get_order', 'list_orders', 'list_projects', 'list_services', 'place_order', 'quote_order', 'topup_link'],
    );

    for (const t of tools) {
      assert.equal(typeof t.title, 'string', t.name);
      assert.equal(t.annotations.title, t.title, t.name);
      assert.ok(t.description.length > 40, t.name);
      assert.equal(t.inputSchema.type, 'object', t.name);
      assert.equal(t.inputSchema.additionalProperties, false, t.name);
      for (const hint of HINTS) assert.equal(typeof t.annotations[hint], 'boolean', `${t.name}.${hint}`);
      if (t.annotations.readOnlyHint) assert.equal(t.annotations.destructiveHint, false, t.name);
      // Публичный текст: ни стоп-слова, ни кухни. Пакет ставят и клиенты белой
      // витрины (RAZ-561), а там этого слова нет нигде. Стоп-слово записано с
      // классом [к], чтобы его не было и в тексте самого файла.
      assert.doesNotMatch(t.description, /на[к]рутк|поставщик|закупк/i, t.name);
    }

    const byName = Object.fromEntries(tools.map((t) => [t.name, t]));
    const readOnly = tools.filter((t) => t.annotations.readOnlyHint).map((t) => t.name).sort();
    assert.deepEqual(readOnly, ['get_balance', 'get_order', 'list_orders', 'list_projects', 'list_services', 'quote_order', 'topup_link']);

    assert.deepEqual(
      Object.fromEntries(HINTS.map((h) => [h, byName.place_order.annotations[h]])),
      { readOnlyHint: false, destructiveHint: true, idempotentHint: true, openWorldHint: true },
    );
    assert.equal(byName.quote_order.annotations.idempotentHint, true);
    assert.equal(byName.topup_link.annotations.openWorldHint, false);
    for (const t of tools.filter((x) => x.name !== 'topup_link')) assert.equal(t.annotations.openWorldHint, true, t.name);

    // Заказ — только по примерке: единственный аргумент, и описание требует согласия человека.
    assert.deepEqual(Object.keys(byName.place_order.inputSchema.properties), ['quoteId']);
    assert.deepEqual(byName.place_order.inputSchema.required, ['quoteId']);
    assert.match(byName.place_order.description, /СПИСЫВАЕТ ДЕНЬГИ/);
    assert.match(byName.place_order.description, /явно согласился/);
    // Своих комментариев у примерки нет.
    assert.equal(byName.quote_order.inputSchema.properties.comments, undefined);
  }));

test('LS_READONLY=1: инструмента заказа нет вовсе — ни в списке, ни по вызову', () =>
  withServer(api, { LS_READONLY: '1' }, async (s) => {
    const { tools } = (await s.request('tools/list')).result;
    assert.equal(tools.length, 7);
    assert.ok(!tools.some((t) => t.name === 'place_order'));
    assert.match(tools.find((t) => t.name === 'quote_order').description, /только для чтения/);

    const res = await s.request('tools/call', { name: 'place_order', arguments: { quoteId: 'x' } });
    assert.equal(res.error.code, -32602);
    assert.equal(api.requestsTo('POST', '/api/v1/orders').length, 0);

    const init = await s.request('initialize', { protocolVersion: '2025-11-25' });
    assert.doesNotMatch(init.result.instructions, /place_order с quoteId/);
  }));
