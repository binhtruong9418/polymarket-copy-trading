module.exports = {
  apps: [
    {
      name: "polymarket-bot",
      script: "node_modules/.bin/tsx",
      args: "src/index.ts",
      cwd: __dirname,
      interpreter: "none",

      // restart policy
      autorestart: true,
      watch: false,
      max_restarts: 10,
      restart_delay: 5000,
      min_uptime: "10s",

      // env — override in .env file, these are just defaults
      env: {
        NODE_ENV: "production",
      },

      // logging
      out_file: "logs/out.log",
      error_file: "logs/error.log",
      merge_logs: true,
      log_date_format: "YYYY-MM-DD HH:mm:ss Z",
      max_size: "10M",
      retain: 7,
    },
  ],
};
