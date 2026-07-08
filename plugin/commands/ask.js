// Maximum size of a single Meshtastic text message we send.
const MAX_MESSAGE_BYTES = 200;
// Bytes reserved on each page for the " (i/n)" pagination marker.
const MARKER_RESERVE_BYTES = 8;
// Bytes of the ellipsis appended when the answer is truncated past MAX_PAGES.
const ELLIPSIS = '…';
const ELLIPSIS_BYTES = Buffer.byteLength(ELLIPSIS, 'utf8');
// Cap on how many messages a single answer may span, to avoid flooding the mesh.
const MAX_PAGES = 5;
const DEFAULT_MODEL = 'claude-haiku-4-5';
const API_URL = 'https://api.anthropic.com/v1/messages';

const regex = /^ask\s+(.+)/i;

function replyDestination(message) {
  if (message.type === 'direct') {
    return message.from;
  }
  return 'broadcast';
}

function byteLength(str) {
  return Buffer.byteLength(str, 'utf8');
}

// Truncate a string to at most maxBytes UTF-8 bytes without leaving a
// partially-encoded multi-byte character at the end.
function truncateToBytes(str, maxBytes) {
  const buffer = Buffer.from(str, 'utf8');
  if (buffer.length <= maxBytes) {
    return str;
  }
  let end = maxBytes;
  // Back off if we landed in the middle of a multi-byte sequence.
  // UTF-8 continuation bytes fall in the range 0x80-0xBF.
  while (end > 0 && buffer[end] >= 0x80 && buffer[end] <= 0xbf) {
    end -= 1;
  }
  return buffer.toString('utf8', 0, end);
}

// Split text into chunks no larger than maxBytes UTF-8 bytes, preferring to
// break on word boundaries and only hard-splitting words that are themselves
// too long to fit in a single chunk.
function splitIntoChunks(text, maxBytes) {
  const words = text.split(/\s+/).filter(Boolean);
  const chunks = [];
  let current = '';

  const flush = () => {
    if (current) {
      chunks.push(current);
      current = '';
    }
  };

  words.forEach((word) => {
    const candidate = current ? `${current} ${word}` : word;
    if (byteLength(candidate) <= maxBytes) {
      current = candidate;
      return;
    }
    flush();
    if (byteLength(word) <= maxBytes) {
      current = word;
      return;
    }
    // A single word longer than a whole chunk: hard-split it by bytes.
    let rest = word;
    while (byteLength(rest) > maxBytes) {
      const head = truncateToBytes(rest, maxBytes);
      chunks.push(head);
      rest = rest.slice(head.length);
    }
    current = rest;
  });

  flush();
  return chunks;
}

// Turn an answer into an ordered list of message strings, each <= MAX_MESSAGE_BYTES.
// Answers that fit in one message are returned unmarked; longer answers are
// paginated with a " (i/n)" suffix and truncated with an ellipsis past MAX_PAGES.
function paginate(text) {
  if (byteLength(text) <= MAX_MESSAGE_BYTES) {
    return [text];
  }

  const contentBudget = MAX_MESSAGE_BYTES - MARKER_RESERVE_BYTES;
  let chunks = splitIntoChunks(text, contentBudget);

  if (chunks.length > MAX_PAGES) {
    chunks = chunks.slice(0, MAX_PAGES);
    const last = chunks[MAX_PAGES - 1];
    chunks[MAX_PAGES - 1] = truncateToBytes(last, contentBudget - ELLIPSIS_BYTES) + ELLIPSIS;
  }

  const total = chunks.length;
  return chunks.map((chunk, index) => `${chunk} (${index + 1}/${total})`);
}

async function askClaude(question, apiKey, model) {
  const prompt = 'You are answering a question relayed over a low-bandwidth radio '
    + 'mesh network. Reply with a concise, plain-text answer only: no markdown '
    + 'and no formatting. Get straight to the answer and keep it brief. '
    + `Question: ${question}`;

  const response = await fetch(API_URL, {
    method: 'POST',
    headers: {
      'content-type': 'application/json',
      'x-api-key': apiKey,
      'anthropic-version': '2023-06-01',
    },
    body: JSON.stringify({
      model: model || DEFAULT_MODEL,
      max_tokens: 300,
      messages: [{ role: 'user', content: prompt }],
    }),
  });

  if (!response.ok) {
    let detail = '';
    try {
      const errorBody = await response.json();
      detail = errorBody && errorBody.error && errorBody.error.message
        ? `: ${errorBody.error.message}`
        : `: ${JSON.stringify(errorBody)}`;
    } catch (e) {
      // Response body was not JSON; the status code alone will have to do.
    }
    throw new Error(`Claude API returned ${response.status}${detail}`);
  }

  const body = await response.json();
  const text = (body.content || [])
    .filter((block) => block.type === 'text')
    .map((block) => block.text)
    .join(' ')
    .replace(/\s+/g, ' ')
    .trim();

  if (!text) {
    throw new Error('Claude returned an empty response');
  }

  return text;
}

module.exports = {
  example: 'Ask <question>',
  // Only accept on the configured channel, never in direct messages, so that
  // strangers can't DM the boat node and burn Claude API tokens.
  accept: (msg) => msg.type !== 'direct' && regex.test(msg.data.trim()),
  handle: async (msg, settings, device, app) => {
    const match = msg.data.trim().match(regex);
    const question = match[1].trim();
    const destination = replyDestination(msg);
    const apiKey = settings.communications && settings.communications.anthropic_api_key;
    const model = settings.communications && settings.communications.ask_model;

    if (!apiKey) {
      return device.sendText('Ask is not configured (missing Claude API key)', destination, true, msg.channel);
    }

    let answer;
    try {
      answer = await askClaude(question, apiKey, model);
    } catch (err) {
      if (app && app.error) {
        app.error(`Ask command failed: ${err.message}`);
      }
      return device.sendText('Unable to reach Claude right now', destination, true, msg.channel);
    }

    const pages = paginate(answer);
    // Send pages one at a time so they arrive in order on the mesh.
    let result;
    for (let i = 0; i < pages.length; i += 1) {
      // eslint-disable-next-line no-await-in-loop
      result = await device.sendText(pages[i], destination, true, msg.channel);
    }
    return result;
  },
};
