const { describe, it } = require('node:test');
const assert = require('node:assert/strict');

const {
  shouldWeSendNotification,
  evaluateNotification,
  dueReminders,
} = require('../plugin/notifications');

describe('notification sending', () => {
  const settingsSendAlerts = {
    communications: {
      channel: 1,
    },
  };
  it('should rank EMERGENCY as sendable', () => {
    const episodes = new Map();
    const result = shouldWeSendNotification(
      'notifications.communication.meshtastic.deviceStateNum',
      {
        state: 'emergency',
        message: 'Disconnected from Meshtastic node',
      },
      episodes,
      settingsSendAlerts,
    );
    assert.equal(result, true);
  });
  it('should rank NOMINAL as not sendable', () => {
    const episodes = new Map();
    const result = shouldWeSendNotification(
      'notifications.communication.meshtastic.deviceStateNum',
      {
        state: 'nominal',
        message: 'Meshtastic connected and configured',
      },
      episodes,
      settingsSendAlerts,
    );
    assert.equal(result, false);
  });
  it('suppresses duplicate alarm deltas while it stays in alarm', () => {
    const episodes = new Map();
    const path = 'notifications.communication.meshtastic.deviceStateNum';
    const result1 = shouldWeSendNotification(
      path,
      { state: 'alarm', message: 'Meshtastic disconnect' },
      episodes,
      settingsSendAlerts,
    );
    assert.equal(result1, true, 'first alarm should be sent');
    const result2 = shouldWeSendNotification(
      path,
      { state: 'alarm', message: 'Meshtastic disconnect' },
      episodes,
      settingsSendAlerts,
    );
    assert.equal(result2, false, 'repeated alarm while still active should be suppressed');
  });
  it('sends the next alarm immediately after returning to normal', () => {
    const episodes = new Map();
    const path = 'notifications.bilgePump';
    const result1 = shouldWeSendNotification(
      path,
      { state: 'alarm', message: 'Bilge Pump is ON' },
      episodes,
      settingsSendAlerts,
    );
    assert.equal(result1, true, 'first alarm should be sent');
    const result2 = shouldWeSendNotification(
      path,
      { state: 'normal', message: 'Bilge Pump is OFF' },
      episodes,
      settingsSendAlerts,
    );
    assert.equal(result2, false, 'clearing is not an alert');
    const result3 = shouldWeSendNotification(
      path,
      { state: 'alarm', message: 'Bilge Pump is ON' },
      episodes,
      settingsSendAlerts,
    );
    assert.equal(result3, true, 'alarm right after a clear should be sent immediately');
  });
  it('with alert re-issuing after previous expired, it should send', () => {
    const episodes = new Map();
    const startTime = new Date();
    const result1 = shouldWeSendNotification(
      'notifications.communication.meshtastic.deviceStateNum',
      {
        state: 'alarm',
        message: 'Meshtastic disconnect',
      },
      episodes,
      settingsSendAlerts,
      startTime,
    );
    assert.equal(result1, true, 'first alarm should be sent');
    const clearTime = new Date(startTime.getTime() + 10000);
    const result2 = shouldWeSendNotification(
      'notifications.communication.meshtastic.deviceStateNum',
      {
        state: 'nominal',
        message: 'Meshtastic connected and configured',
      },
      episodes,
      settingsSendAlerts,
      clearTime,
    );
    assert.equal(result2, false, 'clearing should not be sent');
    const restartTime = new Date(clearTime.getTime() + 400000);
    const result3 = shouldWeSendNotification(
      'notifications.communication.meshtastic.deviceStateNum',
      {
        state: 'alarm',
        message: 'Meshtastic disconnect',
      },
      episodes,
      settingsSendAlerts,
      restartTime,
    );
    assert.equal(result3, true, 'second alarm should be sent');
  });
  it('sends a back-to-normal message once when an alarm clears', () => {
    const episodes = new Map();
    const path = 'notifications.bilgePump';
    const alert = evaluateNotification(
      path,
      { state: 'alarm', message: 'Bilge Pump is ON' },
      episodes,
      settingsSendAlerts,
    );
    assert.equal(alert.kind, 'alert');
    const clear = evaluateNotification(
      path,
      { state: 'normal', message: 'Bilge Pump is OFF' },
      episodes,
      settingsSendAlerts,
    );
    assert.equal(clear.kind, 'clear', 'clearing should be sent');
    assert.equal(clear.message, 'Bilge Pump is OFF');
    const clearAgain = evaluateNotification(
      path,
      { state: 'normal', message: 'Bilge Pump is OFF' },
      episodes,
      settingsSendAlerts,
    );
    assert.equal(clearAgain.kind, null, 'clearing should only be sent once');
  });
  it('re-arms alarms after the notification is deleted (null value)', () => {
    const episodes = new Map();
    const path = 'notifications.bilgePump';
    const startTime = new Date();
    const alert1 = evaluateNotification(
      path,
      { state: 'alarm', message: 'Bilge Pump is ON' },
      episodes,
      settingsSendAlerts,
      startTime,
    );
    assert.equal(alert1.kind, 'alert', 'first alarm should be sent');
    // Notification deleted -> arrives as a null value
    const cleared = evaluateNotification(
      path,
      null,
      episodes,
      settingsSendAlerts,
      new Date(startTime.getTime() + 1000),
    );
    assert.equal(cleared.kind, 'clear', 'deletion should be treated as a clear');
    // A new alarm well after the debounce window should send again
    const alert2 = evaluateNotification(
      path,
      { state: 'alarm', message: 'Bilge Pump is ON' },
      episodes,
      settingsSendAlerts,
      new Date(startTime.getTime() + 400000),
    );
    assert.equal(alert2.kind, 'alert', 'later alarm should be sent again');
  });
  it('reminds about an alarm that stays active longer than the interval', () => {
    const episodes = new Map();
    const path = 'notifications.bilgePump';
    const startTime = new Date();
    evaluateNotification(
      path,
      { state: 'alarm', message: 'Bilge Pump is ON' },
      episodes,
      settingsSendAlerts,
      startTime,
    );
    // Not yet due after two minutes
    const notDue = dueReminders(episodes, new Date(startTime.getTime() + 120000));
    assert.equal(notDue.length, 0, 'no reminder before the interval elapses');
    // Due after six minutes
    const due = dueReminders(episodes, new Date(startTime.getTime() + 360000));
    assert.equal(due.length, 1, 'reminder should fire after the interval');
    assert.equal(due[0].message, 'Bilge Pump is ON');
    // Cleared alarms produce no reminders
    evaluateNotification(path, { state: 'normal' }, episodes, settingsSendAlerts);
    const afterClear = dueReminders(episodes, new Date(startTime.getTime() + 1000000));
    assert.equal(afterClear.length, 0, 'no reminders once the alarm has cleared');
  });
});
