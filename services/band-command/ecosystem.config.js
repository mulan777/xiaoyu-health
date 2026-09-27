module.exports = {
  apps: [{
    name: 'band-command',
    script: 'server.js',
    cwd: '/opt/band-command',
    env: {
      BAND_COMMAND_PORT: 3079,
      // /api/* 鉴权口令（2026-09-27 起所有 API 必填请求头 X-Auth-Token）；生产请改成强口令，
      // 并与平台侧（kindergarten-platform）进程的 BAND_COMMAND_TOKEN 保持一致
      BAND_COMMAND_TOKEN: '521ZiJi.',
    }
  }]
};
