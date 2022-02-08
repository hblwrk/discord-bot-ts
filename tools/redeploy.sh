#!/bin/bash
export DOCKER_CONTENT_TRUST=1
/home/user/go/bin/cosign verify --key /home/user/cosign.pub ghcr.io/hblwrk/discord-bot-ts:main
if [ 0 == $? ]; then
  docker stack deploy --with-registry-auth --prune --compose-file docker-compose-staging.yml discord-bot-ts_staging
  backoff=0
  while [ 300 -gt ${backoff} ]
  do
    sleep 10
    let "backoff+=10"
    curl -s -o /dev/null http://127.0.0.1:11313/api/v1/health
    if [ 0 == $? ]; then
      docker stack deploy --with-registry-auth --prune --compose-file docker-compose-production.yml discord-bot-ts_production
      docker system prune -f
      exit 0
    fi
    echo "Staging not ready yet. Retry in 10 seconds."
    if [ 300 -lt ${backoff} ]; then
      echo "Deployment to staging failed, not deploying."
      exit 23
    fi
  done
else
  echo "Signature does not match, not deploying."
  exit 42
fi
