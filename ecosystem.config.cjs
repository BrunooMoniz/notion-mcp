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
    // Full reindex (epoch) of all sources = scripts/reindex-all.mts ->
    // runDeltaSync({ fullReindex: true }). It's the edited-note safety net
    // (Granola created_after delta never re-fetches edits). The script is a
    // .mts (tsx) and scripts/ is not compiled to dist/, so run it through
    // node's tsx loader; PM2 fires it on cron and it exits.
    {
      name: "brain-reindex-nightly",
      script: "scripts/reindex-all.mts",
      interpreter: "node",
      interpreter_args: "--import tsx",
      cron_restart: "0 4 * * *", // 04:00 daily
      autorestart: false,
      instances: 1,
    },
  ],
};
