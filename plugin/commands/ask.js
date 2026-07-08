const { randomUUID } = require('node:crypto');

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
// Name given to the Signal K waypoint created from a located answer.
const WAYPOINT_NAME = 'askWaypoint';

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
function paginate(app, text) {
  app.debug("000000000000000");
  if (byteLength(text) <= MAX_MESSAGE_BYTES) {
    return [text];
  }
  app.debug("aaaaaaaaaaaa");

  const contentBudget = MAX_MESSAGE_BYTES - MARKER_RESERVE_BYTES;
  app.debug(contentBudget);
  let chunks = splitIntoChunks(text, contentBudget);
  app.debug(chunks);

  if (chunks.length > MAX_PAGES) {
    chunks = chunks.slice(0, MAX_PAGES);
    const last = chunks[MAX_PAGES - 1];
    app.debug(last);
    chunks[MAX_PAGES - 1] = truncateToBytes(last, contentBudget - ELLIPSIS_BYTES) + ELLIPSIS;
  }

  const total = chunks.length;
  app.debug("bbbbbbbbbb");
  return chunks.map((chunk, index) => `${chunk} (${index + 1}/${total})`);
}

function buildPrompt(question) {
  return 'You are answering a question relayed over a low-bandwidth radio mesh '
    + 'network. Respond with a single minified JSON object and nothing else: no '
    + 'markdown, no code fences, and no text outside the JSON. The JSON must have '
    + 'an "answer" field containing a concise, plain-text answer to the question '
    + '(no formatting, get straight to the point). If the answer refers to a '
    + 'specific geographic location (a place, city, port, landmark, etc.), also '
    + 'include numeric "latitude" and "longitude" fields with that location\'s '
    + 'coordinates in decimal degrees (latitude between -90 and 90, longitude '
    + 'between -180 and 180). If there is no specific location, omit those two '
    + `fields. Question: ${question}`;
}

// Best-effort JSON extraction: parse the whole string, or fall back to the
// first {...} block if the model wrapped it in extra prose or code fences.
function extractJson(text) {
  try {
    return JSON.parse(text);
  } catch (e) {
    const start = text.indexOf('{');
    const end = text.lastIndexOf('}');
    if (start !== -1 && end > start) {
      try {
        return JSON.parse(text.slice(start, end + 1));
      } catch (e2) {
        return null;
      }
    }
    return null;
  }
}

function validCoordinate(latitude, longitude) {
  return Number.isFinite(latitude)
    && Number.isFinite(longitude)
    && latitude >= -90 && latitude <= 90
    && longitude >= -180 && longitude <= 180;
}

async function askClaudeWithLocationInMind(question, apiKey, model) {
  const prompt = buildPrompt(question);

  const response = await fetch(API_URL, {
    method: 'POST',
    headers: {
      'content-type': 'application/json',
      'x-api-key': apiKey,
      'anthropic-version': '2023-06-01',
    },
    body: JSON.stringify({
      model: model || DEFAULT_MODEL,
      max_tokens: 400,
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

  const parsed = extractJson(text);
  // Fall back to the raw text if the model didn't return usable JSON, so the
  // user still gets an answer rather than a generic error.
  if (!parsed || typeof parsed.answer !== 'string' || !parsed.answer.trim()) {
    return { answer: text.replace(/\s+/g, ' ').trim() };
  }

  const result = { answer: parsed.answer.replace(/\s+/g, ' ').trim() };
  const latitude = Number(parsed.latitude);
  const longitude = Number(parsed.longitude);
  if (validCoordinate(latitude, longitude)) {
    result.latitude = latitude;
    result.longitude = longitude;
  }
  return result;
}

// Create a Signal K waypoint from a located answer. Returns true if the
// waypoint was stored, false if it couldn't be (e.g. no resource provider).
async function addWaypoint(app, latitude, longitude) {
  if (!app || !app.resourcesApi || typeof app.resourcesApi.setResource !== 'function') {
    if (app && app.debug) {
      app.debug('Ask: no resources API available, skipping waypoint');
    }
    return false;
  }
  try {
    await app.resourcesApi.setResource('waypoints', randomUUID(), {
      name: WAYPOINT_NAME,
      feature: {
        type: 'Feature',
        geometry: {
          type: 'Point',
          coordinates: [longitude, latitude],
        },
        properties: {},
      },
    });
    return true;
  } catch (e) {
    if (app.error) {
      app.error(`Ask failed to add waypoint: ${e.message}`);
    }
    return false;
  }
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

    let response;
    try {
      response = await askClaudeWithLocationInMind(question, apiKey, model);
    } catch (err) {
      if (app && app.error) {
        app.error(`Ask command failed: ${err.message}`);
      }
      return device.sendText('Unable to reach Claude right now', destination, true, msg.channel);
    }

    let { answer } = response;
    if (validCoordinate(response.latitude, response.longitude)) {
      const added = await addWaypoint(app, response.latitude, response.longitude);
      if (added) {
        answer = `${answer} - waypoint added`;
      }
    }

    const pages = paginate(app, answer);
    if (app && app.debug) {
      app.debug(`adding waypoint ${response.latitude}, ${response.longitude}`);
    }
    // Send pages one at a time so they arrive in order on the mesh.
    let result;
    for (let i = 0; i < pages.length; i += 1) {
      // eslint-disable-next-line no-await-in-loop
      result = await device.sendText(pages[i], destination, true, msg.channel);
    }
    return result;
  },
};
