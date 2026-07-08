const { describe, it, afterEach } = require('node:test');
const assert = require('node:assert/strict');

const ask = require('../plugin/commands/ask');

function fakeDevice() {
  const sent = [];
  return {
    sent,
    sendText: (text, destination, wantAck, channel) => {
      sent.push({
        text, destination, wantAck, channel,
      });
      return Promise.resolve();
    },
  };
}

describe('ask command', () => {
  const originalFetch = global.fetch;
  afterEach(() => {
    global.fetch = originalFetch;
  });

  it('accepts messages starting with "ask "', () => {
    assert.equal(ask.accept({ data: 'ask what is the capital of thailand' }), true);
    assert.equal(ask.accept({ data: 'Ask why is the sky blue' }), true);
  });

  it('rejects unrelated messages', () => {
    assert.equal(ask.accept({ data: 'ping' }), false);
    assert.equal(ask.accept({ data: 'asking for a friend' }), false);
    assert.equal(ask.accept({ data: 'ask' }), false);
  });

  it('rejects direct messages so DMs cannot spend tokens', () => {
    assert.equal(ask.accept({ data: 'ask hello', type: 'direct' }), false);
    assert.equal(ask.accept({ data: 'ask hello', type: 'broadcast' }), true);
  });

  it('replies with a config error when no API key is set', async () => {
    const device = fakeDevice();
    await ask.handle(
      {
        data: 'ask hello', type: 'broadcast', channel: 1,
      },
      { communications: {} },
      device,
      { error: () => {} },
    );
    assert.equal(device.sent.length, 1);
    assert.match(device.sent[0].text, /not configured/i);
    assert.equal(device.sent[0].destination, 'broadcast');
  });

  it('sends a short answer as a single unmarked message', async () => {
    global.fetch = async () => ({
      ok: true,
      json: async () => ({ content: [{ type: 'text', text: 'Bangkok' }] }),
    });
    const device = fakeDevice();
    await ask.handle(
      {
        data: 'ask capital of thailand', type: 'broadcast', channel: 1,
      },
      { communications: { anthropic_api_key: 'key' } },
      device,
      { error: () => {} },
    );
    assert.equal(device.sent.length, 1);
    assert.equal(device.sent[0].text, 'Bangkok');
  });

  it('paginates an answer that is over 200 bytes', async () => {
    const longAnswer = 'a'.repeat(500);
    global.fetch = async () => ({
      ok: true,
      json: async () => ({ content: [{ type: 'text', text: longAnswer }] }),
    });
    const device = fakeDevice();
    await ask.handle(
      {
        data: 'ask something', type: 'broadcast', channel: 1,
      },
      { communications: { anthropic_api_key: 'key' } },
      device,
      { error: () => {} },
    );
    assert.ok(device.sent.length > 1, 'should send multiple pages');
    const total = device.sent.length;
    device.sent.forEach((message, index) => {
      assert.ok(
        Buffer.from(message.text, 'utf8').length <= 200,
        'each page must fit in 200 bytes',
      );
      assert.match(message.text, new RegExp(`\\(${index + 1}/${total}\\)$`));
      assert.equal(message.destination, 'broadcast');
    });
  });

  it('caps very long answers at 5 pages and marks truncation', async () => {
    const hugeAnswer = 'a'.repeat(5000);
    global.fetch = async () => ({
      ok: true,
      json: async () => ({ content: [{ type: 'text', text: hugeAnswer }] }),
    });
    const device = fakeDevice();
    await ask.handle(
      {
        data: 'ask something', type: 'broadcast', channel: 1,
      },
      { communications: { anthropic_api_key: 'key' } },
      device,
      { error: () => {} },
    );
    assert.equal(device.sent.length, 5);
    device.sent.forEach((message) => {
      assert.ok(Buffer.from(message.text, 'utf8').length <= 200);
    });
    assert.match(device.sent[4].text, /…/);
  });

  it('reports a friendly error when the API call fails', async () => {
    global.fetch = async () => ({ ok: false, status: 500 });
    const device = fakeDevice();
    await ask.handle(
      { data: 'ask something', type: 'broadcast', channel: 1 },
      { communications: { anthropic_api_key: 'key' } },
      device,
      { error: () => {} },
    );
    assert.equal(device.sent.length, 1);
    assert.match(device.sent[0].text, /unable to reach claude/i);
    assert.equal(device.sent[0].destination, 'broadcast');
  });
});
