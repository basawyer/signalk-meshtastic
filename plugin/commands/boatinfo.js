const KNOTS_PER_MS = 1.94384;

function readValue(app, path) {
  const data = app.getSelfPath(path);
  if (data === undefined || data === null) {
    return undefined;
  }
  if (typeof data === 'object' && 'value' in data) {
    return data.value;
  }
  return data;
}

function fmt(value, digits = 1) {
  if (!Number.isFinite(value)) {
    return null;
  }
  return value.toFixed(digits);
}

function radiansToDegrees(value) {
  if (!Number.isFinite(value)) {
    return null;
  }
  const degrees = value * (180 / Math.PI);
  return Math.round((((degrees % 360) + 360) % 360));
}

function replyDestination(message) {
  if (message.type === 'direct') {
    return message.from;
  }
  return 'broadcast';
}

function buildStatus(app, settings) {
  const batteryId = (settings.communications && settings.communications.boat_info_battery)
    || 'house';

  let header = 'Boat status';
  const name = readValue(app, 'name');
  if (typeof name === 'string' && name.length) {
    header = `${name} status`;
  }
  const lines = [header];

  const voltage = readValue(app, `electrical.batteries.${batteryId}.voltage`);
  const soc = readValue(app, `electrical.batteries.${batteryId}.capacity.stateOfCharge`);
  const current = readValue(app, `electrical.batteries.${batteryId}.current`);
  if ([voltage, soc, current].some(Number.isFinite)) {
    const parts = [`Bat: ${fmt(voltage, 1) || '?'}V`];
    if (Number.isFinite(soc)) {
      parts.push(`${fmt(soc * 100, 0)}%`);
    }
    if (Number.isFinite(current)) {
      parts.push(`${fmt(current, 1)}A`);
    }
    lines.push(parts.join(' '));
  }

  const depth = readValue(app, 'environment.depth.belowTransducer')
    || readValue(app, 'environment.depth.belowKeel')
    || readValue(app, 'environment.depth.belowSurface');
  if (Number.isFinite(depth)) {
    lines.push(`Depth: ${fmt(depth, 1)}m`);
  }

  const windSpeed = readValue(app, 'environment.wind.speedApparent');
  const windAngle = readValue(app, 'environment.wind.angleApparent');
  if (Number.isFinite(windSpeed) || Number.isFinite(windAngle)) {
    const speed = Number.isFinite(windSpeed) ? fmt(windSpeed * KNOTS_PER_MS, 0) : '?';
    const angle = radiansToDegrees(windAngle);
    lines.push(`Wind: ${speed}kn${angle !== null ? ` @${angle}` : ''}`);
  }

  const waterTemp = readValue(app, 'environment.water.temperature');
  if (Number.isFinite(waterTemp)) {
    lines.push(`Water: ${fmt(waterTemp - 273.15, 1)}C`);
  }

  const sog = readValue(app, 'navigation.speedOverGround');
  if (Number.isFinite(sog)) {
    lines.push(`SOG: ${fmt(sog * KNOTS_PER_MS, 1)}kn`);
  }

  if (lines.length === 1) {
    lines.push('No live data available');
  }

  return lines.join('\n');
}

module.exports = {
  crewOnly: false,
  allowChannel: true,
  example: 'Boat info',
  accept: (msg) => (msg.data.trim().toLowerCase() === 'boat info'),
  handle: (msg, settings, device, app) => {
    const status = buildStatus(app, settings);
    return device.sendText(status, replyDestination(msg), true, msg.channel);
  },
};
