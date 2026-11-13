#!/usr/bin/env bash
set -Eeuo pipefail

# Runs on the VPS as the deploy user. The site is mounted from dist by Nginx.
app_dir=/srv/apps/behaviortracker
state_dir=/srv/apps/.behaviortracker-deploy
compose_file="$app_dir/docker-compose.live.yml"
service=behaviortracker-web

mkdir -p "$state_dir"
exec 9>"$state_dir/lock"
flock -n 9 || exit 0

cd "$app_dir"
if [[ -n "$(git status --porcelain --untracked-files=normal)" ]]; then
  echo "The VPS checkout has local changes; deployment stopped." >&2
  exit 1
fi

git fetch --quiet origin main
target_sha=$(git rev-parse FETCH_HEAD)
current_sha=$(git rev-parse HEAD)
deployed_sha=$(cat "$state_dir/deployed_sha" 2>/dev/null || true)

if [[ "$target_sha" == "$deployed_sha" && "$current_sha" == "$target_sha" && -s "$app_dir/dist/index.html" ]]; then
  exit 0
fi
if ! git merge-base --is-ancestor "$current_sha" "$target_sha"; then
  echo "The VPS main branch cannot fast-forward to origin/main; deployment stopped." >&2
  exit 1
fi

worktree=$(mktemp -d "$state_dir/worktree.XXXXXX")
rmdir "$worktree"
cleanup() {
  if [[ -d "$worktree" ]]; then
    git worktree remove --force "$worktree" || true
  fi
}
trap cleanup EXIT
git worktree add --quiet --detach "$worktree" "$target_sha"

docker run --rm --user "$(id -u):$(id -g)" -e HOME=/tmp \
  -v "$worktree:/workspace" -w /workspace node:22-alpine \
  sh -lc 'npm ci --no-audit --no-fund && npm test -- --run && npm run build'

for page in index.html privacy/index.html terms/index.html legal.css; do
  test -s "$worktree/dist/$page" || { echo "Missing build output: $page" >&2; exit 1; }
done

git merge --ff-only "$target_sha"
docker compose -f "$compose_file" config --quiet

previous="$state_dir/previous"
if [[ -e "$previous" ]]; then
  rm -rf -- "$previous"
fi
if [[ -e "$app_dir/dist" ]]; then
  mv "$app_dir/dist" "$previous"
fi
mv "$worktree/dist" "$app_dir/dist"

verify_site() {
  docker compose -f "$compose_file" up -d --force-recreate --no-deps "$service"
  for route in / /privacy/ /terms/; do
    docker exec "$service" wget -q -O /dev/null "http://127.0.0.1$route"
  done
}

if ! verify_site; then
  echo "Site verification failed; restoring the previous dist." >&2
  mv "$app_dir/dist" "$state_dir/failed-$target_sha"
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
