#!/usr/bin/env bash
set -Eeuo pipefail

# Called by GitHub Actions after the tested dist has been uploaded to the VPS.
target_sha=${1:-}
if [[ ! "$target_sha" =~ ^[0-9a-f]{40}$ ]]; then
  echo "Expected a full Git commit SHA." >&2
  exit 1
fi

app_dir=/srv/apps/behaviortracker
state_dir=/srv/apps/.behaviortracker-deploy
incoming="$state_dir/incoming/$target_sha"
compose_file="$app_dir/docker-compose.live.yml"
service=behaviortracker-web

mkdir -p "$state_dir"
exec 9>"$state_dir/lock"
flock -w 120 9 || { echo "Another deploy is still running." >&2; exit 1; }

for page in index.html privacy/index.html terms/index.html legal.css; do
  test -s "$incoming/$page" || { echo "Missing uploaded file: $page" >&2; exit 1; }
done

cd "$app_dir"
if [[ -n "$(git status --porcelain --untracked-files=normal)" ]]; then
  echo "The VPS checkout has local changes; deployment stopped." >&2
  exit 1
fi

git fetch --quiet origin main
remote_sha=$(git rev-parse FETCH_HEAD)
if [[ "$remote_sha" != "$target_sha" ]]; then
  echo "A newer push replaced $target_sha; this run will not publish an older commit."
  exit 0
fi
current_sha=$(git rev-parse HEAD)
if ! git merge-base --is-ancestor "$current_sha" "$target_sha"; then
  echo "The VPS main branch cannot fast-forward to origin/main; deployment stopped." >&2
  exit 1
fi

git merge --ff-only "$target_sha"
docker compose -f "$compose_file" config --quiet

previous="$state_dir/previous"
if [[ -e "$previous" ]]; then
  rm -rf -- "$previous"
fi
if [[ -e "$app_dir/dist" ]]; then
  mv "$app_dir/dist" "$previous"
fi
mv "$incoming" "$app_dir/dist"

verify_site() {
  docker compose -f "$compose_file" up -d --force-recreate --no-deps "$service"
  for route in / /privacy/ /terms/; do
    docker exec "$service" wget -q -O /dev/null "http://127.0.0.1$route"
  done
}

if ! verify_site; then
  echo "Site verification failed; restoring the previous dist." >&2
  mv "$app_dir/dist" "$state_dir/failed-$target_sha-$(date +%s)"
  if [[ -e "$previous" ]]; then
    mv "$previous" "$app_dir/dist"
    docker compose -f "$compose_file" up -d --force-recreate --no-deps "$service" || true
  fi
  exit 1
fi

printf '%s\n' "$target_sha" > "$state_dir/deployed_sha"
if [[ -s "$app_dir/scripts/deploy-live.sh" ]] && ! cmp -s "$app_dir/scripts/deploy-live.sh" "$state_dir/deploy.sh"; then
  install -m 750 "$app_dir/scripts/deploy-live.sh" "$state_dir/deploy.sh"
fi
echo "Published Behavior Tracker $target_sha"
