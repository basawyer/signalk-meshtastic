exports.ping = require('./ping');
exports.waypoint = require('./waypoint');
exports.boatinfo = require('./boatinfo');
exports.ask = require('./ask');

exports.help = {
  example: 'Help',
  accept: (msg) => (msg.data.toLowerCase() === 'help'),
  handle: (msg, settings, device) => {
    const commands = Object.keys(exports)
      .map((cmd) => exports[cmd].example);
    return device.sendText(`Commands: ${commands.join(', ')}`, msg.from, true, false);
  },
};
