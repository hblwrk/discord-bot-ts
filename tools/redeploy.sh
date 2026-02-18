#!/bin/bash
set -euo pipefail

export DOCKER_CONTENT_TRUST=1

image="ghcr.io/hblwrk/discord-bot-ts:main"
staging_service_name="discord-bot-ts_staging_bot"
verify_output_file="$(mktemp)"
trap 'rm -f "${verify_output_file}"' EXIT

is_staging_healthy() {
  if ! docker service inspect "${staging_service_name}" >/dev/null 2>&1; then
    return 1
  fi

  local update_state
  update_state="$(
    docker service inspect \
      --format '{{if .UpdateStatus}}{{.UpdateStatus.State}}{{end}}' \
      "${staging_service_name}" \
      2>/dev/null
  )"
  if [ -n "${update_state}" ] && [ "completed" != "${update_state}" ]; then
    return 1
  fi

  local replicas
  replicas="$(
    docker service ls \
      --filter "name=${staging_service_name}" \
      --format '{{.Replicas}}' \
      | head -n 1
  )"
  case "${replicas}" in
    */*)
      ;;
    *)
      return 1
      ;;
  esac

  local current_replicas
  local desired_replicas
  current_replicas="${replicas%%/*}"
  desired_replicas="${replicas##*/}"
  case "${current_replicas}" in
    ""|*[!0-9]*)
      return 1
      ;;
  esac
  case "${desired_replicas}" in
    ""|*[!0-9]*)
      return 1
      ;;
  esac
  if [ "${desired_replicas}" -eq 0 ] || [ "${current_replicas}" -ne "${desired_replicas}" ]; then
    return 1
  fi

  local healthy_container_count
  healthy_container_count="$(
    docker ps -q \
      --filter "label=com.docker.swarm.service.name=${staging_service_name}" \
      --filter "health=healthy" \
      | wc -l | tr -d '[:space:]'
  )"

  [ "${healthy_container_count}" -eq "${desired_replicas}" ]
}

signature_valid=false
if /usr/bin/cosign verify --key /home/user/cosign.pub "${image}" >"${verify_output_file}" 2>&1; then
  signature_valid=true
elif grep -q "signature not found in transparency log" "${verify_output_file}"; then
  echo "Signature has no transparency-log entry. Retrying verification without tlog requirement."
  if /usr/bin/cosign verify --insecure-ignore-tlog=true --key /home/user/cosign.pub "${image}" >"${verify_output_file}" 2>&1; then
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
      docker stack rm discord-bot-ts_staging
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
