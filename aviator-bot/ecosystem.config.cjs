module.exports = {
  apps: [
    {
      name: 'aviator-bot',
      script: './bot.js',
      cwd: __dirname,
      instances: 1,
      autorestart: true,
      watch: false,
      max_memory_restart: '500M',
      env: {
        NODE_ENV: 'production',
        PORT: 3000,
        BOT_HEADLESS: 'true',
        CAPTURE_INTERVAL_MS: 5000,
        MAX_REGISTROS: 100
      }
    }
  ]
};
