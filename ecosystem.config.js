module.exports = {
  apps: [
    {
      name: 'kindergarten-platform',
      script: 'server.js',
      cwd: '/opt/kindergarten-fitness-platform',
      env: {
        PORT: 3070,
        NODE_ENV: 'production'
      }
    }
  ]
};
