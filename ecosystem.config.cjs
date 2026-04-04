module.exports = {
  apps: [
    {
      name: "notion-mcp",
      script: "dist/index.js",
      env: {
        NODE_ENV: "production",
        PORT: 3456,
      },
      restart_delay: 3000,
      max_restarts: 10,
    },
  ],
};
