module.exports = {
  apps: [
    {
      name: 'gringo',
      script: 'dist/app.js',
      cwd: '/opt/gringo',
      instances: 1,
      autorestart: true,
      max_restarts: 10,
      restart_delay: 5000,
      watch: false,
      env: {
        NODE_ENV: 'production',
      },
      // Log files
      out_file: '/opt/gringo/logs/out.log',
      error_file: '/opt/gringo/logs/error.log',
      log_date_format: 'YYYY-MM-DD HH:mm:ss',
      merge_logs: true,
      // Graceful shutdown (matches our SIGINT handler)
      kill_timeout: 5000,
      listen_timeout: 10000,
    },
  ],
};
