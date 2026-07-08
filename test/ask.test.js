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

// Build a fake fetch that returns the given payload as Claude's text block.
// Objects are JSON-stringified; strings are returned verbatim.
function mockClaude(payload) {
  const text = typeof payload === 'string' ? payload : JSON.stringify(payload);
  return async () => ({
    ok: true,
    json: async () => ({ content: [{ type: 'text', text }] }),
  });
}

function fakeApp(overrides = {}) {
  const notes = [];
  return {
    debug: () => {},
    error: () => {},
    notes,
    resourcesApi: {
      setResource: (type, id, data) => {
        notes.push({ type, id, data });
        return Promise.resolve();
      },
    },
    ...overrides,
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
      { ask: {} },
      device,
      { error: () => {} },
    );
    assert.equal(device.sent.length, 1);
    assert.match(device.sent[0].text, /not configured/i);
    assert.equal(device.sent[0].destination, 'broadcast');
  });

  it('sends a short answer as a single unmarked message', async () => {
    global.fetch = mockClaude({ answer: 'Bangkok' });
    const device = fakeDevice();
    const app = fakeApp();
    await ask.handle(
      {
        data: 'ask capital of thailand', type: 'broadcast', channel: 1,
      },
      { ask: { anthropic_api_key: 'key', add_notes: true } },
      device,
      app,
    );
    assert.equal(device.sent.length, 1);
    assert.equal(device.sent[0].text, 'Bangkok');
    assert.equal(app.notes.length, 0);
  });

  it('falls back to raw text when the response is not JSON', async () => {
    global.fetch = mockClaude('Bangkok is the capital');
    const device = fakeDevice();
    await ask.handle(
      {
        data: 'ask capital of thailand', type: 'broadcast', channel: 1,
      },
      { ask: { anthropic_api_key: 'key', add_notes: true } },
      device,
      fakeApp(),
    );
    assert.equal(device.sent.length, 1);
    assert.equal(device.sent[0].text, 'Bangkok is the capital');
  });

  it('adds a Signal K note with name, answer text, and marker for a located answer', async () => {
    global.fetch = mockClaude({
      answer: 'Bangkok', name: 'Bangkok', latitude: 13.7563, longitude: 100.5018,
    });
    const device = fakeDevice();
    const app = fakeApp();
    await ask.handle(
      {
        data: 'ask capital of thailand', type: 'broadcast', channel: 1,
      },
      { ask: { anthropic_api_key: 'key', add_notes: true } },
      device,
      app,
    );
    assert.equal(device.sent.length, 1);
    assert.equal(device.sent[0].text, 'Bangkok - note added');
    assert.equal(app.notes.length, 1);
    const [note] = app.notes;
    assert.equal(note.type, 'notes');
    assert.equal(note.data.title, 'Bangkok');
    assert.equal(note.data.description, 'Bangkok');
    assert.deepEqual(note.data.position, { latitude: 13.7563, longitude: 100.5018 });
  });

  it('falls back to a default note title when name is missing', async () => {
    global.fetch = mockClaude({ answer: 'Bangkok', latitude: 13.7563, longitude: 100.5018 });
    const device = fakeDevice();
    const app = fakeApp();
    await ask.handle(
      {
        data: 'ask capital of thailand', type: 'broadcast', channel: 1,
      },
      { ask: { anthropic_api_key: 'key', add_notes: true } },
      device,
      app,
    );
    assert.equal(device.sent[0].text, 'Bangkok - note added');
    assert.equal(app.notes[0].data.title, 'Ask note');
  });

  it('ignores out-of-range coordinates and does not add a note', async () => {
    global.fetch = mockClaude({ answer: 'Somewhere', latitude: 999, longitude: 100 });
    const device = fakeDevice();
    const app = fakeApp();
    await ask.handle(
      {
        data: 'ask something', type: 'broadcast', channel: 1,
      },
      { ask: { anthropic_api_key: 'key', add_notes: true } },
      device,
      app,
    );
    assert.equal(device.sent[0].text, 'Somewhere');
    assert.equal(app.notes.length, 0);
  });

  it('does not prepend the marker when note storage fails', async () => {
    global.fetch = mockClaude({
      answer: 'Bangkok', name: 'Bangkok', latitude: 13.7563, longitude: 100.5018,
    });
    const device = fakeDevice();
    const app = fakeApp({
      resourcesApi: {
        setResource: () => Promise.reject(new Error('no provider')),
      },
    });
    await ask.handle(
      {
        data: 'ask capital of thailand', type: 'broadcast', channel: 1,
      },
      { ask: { anthropic_api_key: 'key', add_notes: true } },
      device,
      app,
    );
    assert.equal(device.sent[0].text, 'Bangkok');
  });

  it('skips note storage when add_notes is off (default)', async () => {
    global.fetch = mockClaude({
      answer: 'Bangkok', name: 'Bangkok', latitude: 13.7563, longitude: 100.5018,
    });
    const device = fakeDevice();
    const app = fakeApp();
    await ask.handle(
      {
        data: 'ask capital of thailand', type: 'broadcast', channel: 1,
      },
      { ask: { anthropic_api_key: 'key' } },
      device,
      app,
    );
    assert.equal(device.sent[0].text, 'Bangkok');
    assert.equal(app.notes.length, 0);
  });

  it('paginates an answer that is over 200 bytes', async () => {
    global.fetch = mockClaude({ answer: 'a'.repeat(500) });
    const device = fakeDevice();
    await ask.handle(
      {
        data: 'ask something', type: 'broadcast', channel: 1,
      },
      { ask: { anthropic_api_key: 'key', add_notes: true } },
      device,
      fakeApp(),
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
    global.fetch = mockClaude({ answer: 'a'.repeat(5000) });
    const device = fakeDevice();
    await ask.handle(
      {
        data: 'ask something', type: 'broadcast', channel: 1,
      },
      { ask: { anthropic_api_key: 'key', add_notes: true } },
      device,
      fakeApp(),
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
      { ask: { anthropic_api_key: 'key', add_notes: true } },
      device,
      fakeApp(),
    );
    assert.equal(device.sent.length, 1);
    assert.match(device.sent[0].text, /unable to reach claude/i);
    assert.equal(device.sent[0].destination, 'broadcast');
  });
});
