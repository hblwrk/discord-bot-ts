#!/bin/bash
set -euo pipefail

export DOCKER_CONTENT_TRUST=1

if /home/user/go/bin/cosign verify --key /home/user/cosign.pub ghcr.io/hblwrk/discord-bot-ts:main; then
  docker stack deploy --with-registry-auth --prune --compose-file docker-compose-staging.yml discord-bot-ts_staging

  timeout_seconds=300
  interval_seconds=10
  elapsed_seconds=0

  while [ "${elapsed_seconds}" -lt "${timeout_seconds}" ]; do
    sleep "${interval_seconds}"
    elapsed_seconds=$((elapsed_seconds + interval_seconds))

    if curl -fsS -o /dev/null http://127.0.0.1:11313/api/v1/health; then
      docker stack deploy --with-registry-auth --prune --compose-file docker-compose-production.yml discord-bot-ts_production
      docker system prune -f
      exit 0
    fi

    echo "Staging not ready yet. Retry in ${interval_seconds} seconds."
  done

  echo "Deployment to staging failed after ${timeout_seconds} seconds, not deploying."
  exit 23
fi

echo "Signature does not match, not deploying."
exit 42
