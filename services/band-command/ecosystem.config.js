module.exports = {
  apps: [{
    name: 'band-command',
    script: 'server.js',
    cwd: '/opt/band-command',
    env: { BAND_COMMAND_PORT: 3079 }
  }]
};
