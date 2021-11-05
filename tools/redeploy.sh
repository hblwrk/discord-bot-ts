#!/bin/bash
export DOCKER_CONTENT_TRUST=1
/home/user/go/bin/cosign verify --key /home/user/cosign.pub ghcr.io/hblwrk/discord-bot-js:main
if [ 0 == $? ]; then
  docker stack deploy --with-registry-auth --prune --compose-file docker-compose-staging.yml discord-bot-js_staging
  sleep 60 && curl http://127.0.0.1:11313/api/v1/health
  if [ 0 == $? ]; then
    docker stack deploy --with-registry-auth --prune --compose-file docker-compose-production.yml discord-bot-js_production
    docker system prune -f
  else
    echo "Deployment to staging failed, not deploying."
    exit 23
  fi
else
  echo "Signature does not match, not deploying."
  exit 42
fi
