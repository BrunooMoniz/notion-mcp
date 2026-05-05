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
    {
      name: "brain-indexer",
      script: "dist/index-indexer.js",
      env: {
        NODE_ENV: "production",
      },
      restart_delay: 10000,
      max_restarts: 5,
    },
    {
      name: "brain-classifier",
      script: "dist/index-classifier.js",
      env: {
        NODE_ENV: "production",
      },
      restart_delay: 10000,
      max_restarts: 5,
    },
  ],
};
