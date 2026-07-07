const MAX_RESPONSE_BYTES = 200;
const DEFAULT_MODEL = 'claude-haiku-4-5';
const API_URL = 'https://api.anthropic.com/v1/messages';

const regex = /^ask\s+(.+)/i;

function replyDestination(message) {
  if (message.type === 'direct') {
    return message.from;
  }
  return 'broadcast';
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

async function askClaude(question, apiKey, model) {
  const prompt = 'You are answering a question relayed over a low-bandwidth radio '
    + 'mesh network. Reply with the most succinct possible answer as plain text '
    + 'only: no markdown, no formatting, no newlines, and keep the whole answer '
    + `under ${MAX_RESPONSE_BYTES} bytes. Question: ${question}`;

  const response = await fetch(API_URL, {
    method: 'POST',
    headers: {
      'content-type': 'application/json',
      'x-api-key': apiKey,
      'anthropic-version': '2023-06-01',
    },
    body: JSON.stringify({
      model: model || DEFAULT_MODEL,
      max_tokens: 150,
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
    .trim();

  if (!text) {
    throw new Error('Claude returned an empty response');
  }

  return text;
}

module.exports = {
  example: 'Ask <question>',
  accept: (msg) => regex.test(msg.data.trim()),
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

    return device.sendText(
      truncateToBytes(answer, MAX_RESPONSE_BYTES),
      destination,
      true,
      msg.channel,
    );
  },
};
