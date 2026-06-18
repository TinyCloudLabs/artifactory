# Smithers Workflows

This repo uses a local Smithers workflow pack for durable development work,
triage, backpressure planning, and run monitoring.

Useful commands:

```sh
bun run smithers:doctor
bun run smithers:list
bun run smithers:dev-mode
```

`feed-dev-mode` probes the current local development setup:

- Feed served over Portless at `https://feed.localhost:1355`
- Local Artifactory agent at `https://agent.feed.localhost:1355`
- Local Gemini development env, sourced from `DEV_DISTILLERY_ENV` or
  `~/development.nosync/distillery/.env`

Start the two surfaces with:

```sh
cd ../feed && PORTLESS_PORT=1355 bun run dev
cd ../artifactory && AGENT_API_TOKEN=local-claude-dev PORTLESS_PORT=1355 bun run artifact:agent:dev:https
```

The generated Smithers pack intentionally keeps secrets out of git. Local API
keys are a development bridge only; the target home is TinyCloud Secret Manager.
