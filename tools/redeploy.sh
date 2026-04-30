#!/bin/bash
set -euo pipefail

export DOCKER_CONTENT_TRUST=1

if [ "$#" -ne 2 ]; then
  echo "Usage: $0 sha256:<digest> <commit-sha>"
  exit 64
fi

image_digest="$1"
commit_sha="$2"
digest_pattern='^sha256:[0-9a-f]{64}$'
commit_pattern='^[0-9a-f]{40}$'
if ! [[ "${image_digest}" =~ ${digest_pattern} ]]; then
  echo "Invalid image digest: ${image_digest}"
  exit 64
fi
if ! [[ "${commit_sha}" =~ ${commit_pattern} ]]; then
  echo "Invalid commit SHA: ${commit_sha}"
  exit 64
fi

image="ghcr.io/hblwrk/discord-bot-ts@${image_digest}"
repository="hblwrk/discord-bot-ts"
staging_service_name="discord-bot-ts_staging_bot"
production_service_name="discord-bot-ts_production_bot"
staging_compose_file="docker-compose-staging.yml"
production_compose_file="docker-compose-production.yml"
verify_output_file="$(mktemp)"
rendered_staging_compose_file="$(mktemp)"
rendered_production_compose_file="$(mktemp)"
trap 'rm -f "${verify_output_file}" "${rendered_staging_compose_file}" "${rendered_production_compose_file}"' EXIT

render_compose_file() {
  local source_file="$1"
  local target_file="$2"

  if ! grep -q '^[[:space:]]*image:[[:space:]]*${DISCORD_BOT_IMAGE}[[:space:]]*$' "${source_file}" \
    && ! grep -q '^[[:space:]]*image:[[:space:]]*ghcr.io/hblwrk/discord-bot-ts' "${source_file}"; then
    echo "Compose file ${source_file} does not declare a discord-bot-ts image."
    return 1
  fi

  sed \
    -e "s|^\([[:space:]]*image:[[:space:]]*\)\${DISCORD_BOT_IMAGE}[[:space:]]*$|\1${image}|" \
    -e "s|^\([[:space:]]*image:[[:space:]]*\)ghcr.io/hblwrk/discord-bot-ts[^[:space:]]*[[:space:]]*$|\1${image}|" \
    "${source_file}" >"${target_file}"

  validate_rendered_compose_file "${target_file}"
}

validate_rendered_compose_file() {
  local compose_file="$1"
  local image_line_count
  local expected_image_line_count

  image_line_count="$(
    grep -c '^[[:space:]]*image:[[:space:]]*' "${compose_file}" || true
  )"
  expected_image_line_count="$(
    grep -F -c "image: ${image}" "${compose_file}" || true
  )"

  if [ "${image_line_count}" -ne 1 ] || [ "${expected_image_line_count}" -ne 1 ]; then
    echo "Rendered compose file ${compose_file} does not contain exactly one expected image reference."
    return 1
  fi

  if grep -q '\${DISCORD_BOT_IMAGE}' "${compose_file}"; then
    echo "Rendered compose file ${compose_file} still contains DISCORD_BOT_IMAGE."
    return 1
  fi

  if grep -q 'ghcr.io/hblwrk/discord-bot-ts:main' "${compose_file}"; then
    echo "Rendered compose file ${compose_file} still contains mutable :main image reference."
    return 1
  fi
}

is_service_healthy() {
  local service_name="$1"
  local update_state
  local service_image
  local desired_replicas
  local task_rows
  local task_count
  local task_image
  local task_state
  local task_error
  local healthy_container_ids
  local healthy_container_count
  local container_id
  local container_image

  if ! docker service inspect "${service_name}" >/dev/null 2>&1; then
    return 1
  fi

  service_image="$(
    docker service inspect \
      --format '{{.Spec.TaskTemplate.ContainerSpec.Image}}' \
      "${service_name}" \
      2>/dev/null
  )"
  if [ "${service_image}" != "${image}" ]; then
    echo "${service_name} is configured for ${service_image}, expected ${image}."
    return 1
  fi

  update_state="$(
    docker service inspect \
      --format '{{if .UpdateStatus}}{{.UpdateStatus.State}}{{end}}' \
      "${service_name}" \
      2>/dev/null
  )"
  if [ -n "${update_state}" ] && [ "completed" != "${update_state}" ]; then
    return 1
  fi

  desired_replicas="$(
    docker service inspect \
      --format '{{.Spec.Mode.Replicated.Replicas}}' \
      "${service_name}" \
      2>/dev/null
  )"
  case "${desired_replicas}" in
    ""|*[!0-9]*)
      return 1
      ;;
  esac
  if [ "${desired_replicas}" -eq 0 ]; then
    return 1
  fi

  task_rows="$(
    docker service ps \
      --no-trunc \
      --filter "desired-state=running" \
      --format '{{.Image}}|{{.CurrentState}}|{{.Error}}' \
      "${service_name}" \
      2>/dev/null
  )"

  task_count=0
  while IFS='|' read -r task_image task_state task_error; do
    if [ -z "${task_image}${task_state}${task_error}" ]; then
      continue
    fi

    task_count=$((task_count + 1))

    if [ "${task_image}" != "${image}" ]; then
      echo "${service_name} task uses ${task_image}, expected ${image}."
      return 1
    fi

    case "${task_state}" in
      Running*)
        ;;
      *)
        return 1
        ;;
    esac

    if [ -n "${task_error}" ]; then
      echo "${service_name} task reports error: ${task_error}"
      return 1
    fi
  done <<EOF
${task_rows}
EOF

  if [ "${task_count}" -ne "${desired_replicas}" ]; then
    return 1
  fi

  healthy_container_ids="$(
    docker ps -q \
      --filter "label=com.docker.swarm.service.name=${service_name}" \
      --filter "health=healthy"
  )"

  healthy_container_count=0
  for container_id in ${healthy_container_ids}; do
    container_image="$(
      docker inspect \
        --format '{{.Config.Image}}' \
        "${container_id}" \
        2>/dev/null
    )"
    if [ "${container_image}" != "${image}" ]; then
      echo "${service_name} container ${container_id} uses ${container_image}, expected ${image}."
      return 1
    fi

    healthy_container_count=$((healthy_container_count + 1))
  done

  [ "${healthy_container_count}" -eq "${desired_replicas}" ]
}

wait_for_service_healthy() {
  local service_name="$1"
  local service_label="$2"
  local timeout_seconds=300
  local interval_seconds=10
  local elapsed_seconds=0

  while [ "${elapsed_seconds}" -lt "${timeout_seconds}" ]; do
    sleep "${interval_seconds}"
    elapsed_seconds=$((elapsed_seconds + interval_seconds))

    if is_service_healthy "${service_name}"; then
      return 0
    fi

    echo "${service_label} service not healthy yet. Retry in ${interval_seconds} seconds."
  done

  echo "${service_label} service did not become healthy after ${timeout_seconds} seconds."
  return 1
}

signature_valid=false
if /usr/bin/cosign verify \
  --key /home/user/cosign.pub \
  -a "git_sha=${commit_sha}" \
  -a "repository=${repository}" \
  "${image}" >"${verify_output_file}" 2>&1; then
  signature_valid=true
elif grep -q "signature not found in transparency log" "${verify_output_file}"; then
  echo "Signature has no transparency-log entry. Retrying verification without tlog requirement."
  if /usr/bin/cosign verify \
    --insecure-ignore-tlog=true \
    --key /home/user/cosign.pub \
    -a "git_sha=${commit_sha}" \
    -a "repository=${repository}" \
    "${image}" >"${verify_output_file}" 2>&1; then
    signature_valid=true
  fi
fi

if [ true = "${signature_valid}" ]; then
  render_compose_file "${staging_compose_file}" "${rendered_staging_compose_file}"
  render_compose_file "${production_compose_file}" "${rendered_production_compose_file}"

  docker stack deploy --with-registry-auth --prune --compose-file "${rendered_staging_compose_file}" discord-bot-ts_staging

  if ! wait_for_service_healthy "${staging_service_name}" "Staging"; then
    echo "Staging did not validate, not deploying production."
    exit 23
  fi

  docker stack deploy --with-registry-auth --prune --compose-file "${rendered_production_compose_file}" discord-bot-ts_production

  if ! wait_for_service_healthy "${production_service_name}" "Production"; then
    echo "Production did not validate, leaving staging deployed."
    exit 24
  fi

  docker stack rm discord-bot-ts_staging
  docker system prune -f
  exit 0
fi

cat "${verify_output_file}"
echo "Signature does not match, not deploying."
exit 42
