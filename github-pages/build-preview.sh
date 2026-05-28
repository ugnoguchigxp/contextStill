#!/usr/bin/env bash
set -euo pipefail

ROOT_DIR="$(cd "$(dirname "$0")" && pwd)"

docker run --rm \
  -v "$ROOT_DIR":/srv/jekyll \
  -w /srv/jekyll \
  jekyll/jekyll:latest \
  sh -lc "bundle config set path vendor/bundle && bundle install && bundle exec jekyll build --config _config.yml,_config.local.yml"
