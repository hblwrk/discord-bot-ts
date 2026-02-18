#!/bin/bash
set -euo pipefail

export DOCKER_CONTENT_TRUST=1

image="ghcr.io/hblwrk/discord-bot-ts:main"
staging_service_name="discord-bot-ts_staging_bot"
verify_output_file="$(mktemp)"
trap 'rm -f "${verify_output_file}"' EXIT

is_staging_healthy() {
  local running_container_ids
  running_container_ids="$(docker ps -q --filter "label=com.docker.swarm.service.name=${staging_service_name}")"
  if [ -z "${running_container_ids}" ]; then
    return 1
  fi

  local healthy_container_ids
  healthy_container_ids="$(docker ps -q \
    --filter "label=com.docker.swarm.service.name=${staging_service_name}" \
    --filter "health=healthy")"

  [ -n "${healthy_container_ids}" ]
}

signature_valid=false
if /home/user/go/bin/cosign verify --key /home/user/cosign.pub "${image}" >"${verify_output_file}" 2>&1; then
  signature_valid=true
elif grep -q "signature not found in transparency log" "${verify_output_file}"; then
  echo "Signature has no transparency-log entry. Retrying verification without tlog requirement."
  if /home/user/go/bin/cosign verify --insecure-ignore-tlog=true --key /home/user/cosign.pub "${image}" >"${verify_output_file}" 2>&1; then
    signature_valid=true
  fi
fi

if [ true = "${signature_valid}" ]; then
  docker stack deploy --with-registry-auth --prune --compose-file docker-compose-staging.yml discord-bot-ts_staging

  timeout_seconds=300
  interval_seconds=10
  elapsed_seconds=0

  while [ "${elapsed_seconds}" -lt "${timeout_seconds}" ]; do
    sleep "${interval_seconds}"
    elapsed_seconds=$((elapsed_seconds + interval_seconds))

    if is_staging_healthy; then
      docker stack deploy --with-registry-auth --prune --compose-file docker-compose-production.yml discord-bot-ts_production
      docker system prune -f
      exit 0
    fi

    echo "Staging service not healthy yet. Retry in ${interval_seconds} seconds."
  done

  echo "Staging service did not become healthy after ${timeout_seconds} seconds, not deploying."
  exit 23
fi

cat "${verify_output_file}"
echo "Signature does not match, not deploying."
exit 42
