// How long an alarm may stay active before we send a reminder notification
const reminderMs = 5 * 60 * 1000;

// Decides what (if anything) we should transmit for a given notification delta.
// Returns { kind: 'alert' | 'clear' | null, message }.
//
// Behaviour:
// - The first time a path goes into alarm we send an alert.
// - While it stays in alarm we suppress duplicate deltas (reminders are handled
//   separately by dueReminders on a timer).
// - When it returns to normal we send a single back-to-normal message and
//   forget the episode, so the very next alarm is sent immediately.
function evaluateNotification(path, value, episodes, settings, now) {
  const currentTime = now || new Date();

  const statesToSend = [
    'alarm',
    'emergency',
  ];
  const episode = episodes.get(path);
  const isAlert = !!(value && value.state && statesToSend.includes(value.state));

  if (!isAlert) {
    // Cleared or non-alert notification (a deleted notification arrives as a
    // null value, which we also treat as a clear)
    if (!episode) {
      return { kind: null };
    }
    const message = (value && value.message) || `Cleared: ${episode.message}`;
    // Forget the episode so the next alarm on this path is sent immediately
    episodes.delete(path);
    return { kind: 'clear', message };
  }

  if (episode) {
    // Already in alarm; suppress duplicate deltas. Reminders while the alarm
    // persists are emitted by dueReminders instead.
    episode.transitions += 1;
    return { kind: null };
  }

  // First alert of this kind
  episodes.set(path, {
    startTime: currentTime,
    lastAlertAt: currentTime,
    openState: value.state,
    message: value.message,
    method: value.method,
    transitions: 1,
  });
  return { kind: 'alert', message: value.message };
}

// Returns the reminders that are due for alarms that have stayed active longer
// than the reminder interval, updating each episode's last-alerted time.
function dueReminders(episodes, now) {
  const currentTime = now || new Date();
  const due = [];
  Array.from(episodes.keys()).forEach((path) => {
    const episode = episodes.get(path);
    if (!episode) {
      return;
    }
    if (currentTime - episode.lastAlertAt >= reminderMs) {
      episode.lastAlertAt = currentTime;
      episode.transitions += 1;
      due.push({ path, message: episode.message, method: episode.method });
    }
  });
  return due;
}

function shouldWeSendNotification(path, value, episodes, settings, now) {
  return evaluateNotification(path, value, episodes, settings, now).kind === 'alert';
}

function deliver(kind, message, method, settings, device, app) {
  let bell = '';
  if (kind === 'alert' && method && method.indexOf('sound') !== -1) {
    // Trigger audible bell on receiving Meshtastic devices
    bell = '\u0007 ';
  }
  // Prefix alerts with red sirens and back-to-normal messages with green lights
  const emoji = kind === 'clear' ? '🟢 ' : '🚨 ';
  const text = `${bell}${emoji}${message}${emoji}`;

  // Broadcast the alert on the configured channel (channel 0 is the public
  // primary channel)
  const channel = settings.communications
    && Number.isInteger(settings.communications.channel)
    ? settings.communications.channel
    : 1;

  return device.sendText(text, 'broadcast', true, channel)
    .catch((e) => app.error(`Failed to send alert: ${e.message}`));
}

function sendNotification(path, value, episodes, settings, device, app) {
  if (!device) {
    // Not connected to Meshtastic yet
    return false;
  }

  const action = evaluateNotification(path, value, episodes, settings);
  if (action.kind !== 'alert' && action.kind !== 'clear') {
    return Promise.resolve();
  }

  // Only alerts carry the audible bell; clears are informational
  const method = action.kind === 'alert' && value ? value.method : null;
  return deliver(action.kind, action.message, method, settings, device, app);
}

// Sends reminder notifications for alarms that have stayed active too long.
// Intended to be called periodically (e.g. from a timer).
function sendReminders(episodes, settings, device, app, now) {
  if (!device) {
    return Promise.resolve();
  }
  const due = dueReminders(episodes, now);
  return due.reduce(
    (prev, item) => prev.then(() => deliver('alert', item.message, item.method, settings, device, app)),
    Promise.resolve(),
  );
}

module.exports = {
  evaluateNotification,
  dueReminders,
  shouldWeSendNotification,
  sendNotification,
  sendReminders,
};
