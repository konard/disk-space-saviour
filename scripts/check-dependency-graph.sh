#!/usr/bin/env bash
# Decide whether the dependency review can run for a pull request.
#
# actions/dependency-review-action reads the dependency graph compare API and
# fails with "Dependency review is not supported on this repository" when that
# API answers 403 because the repository has the dependency graph turned off.
# That is a repository setting, not a defect in the pull request, so this
# probe calls the same API first and writes available=true|false to
# $GITHUB_OUTPUT. On false the job skips the review with a warning; the
# npm-audit job still fails on high-severity advisories in every lock. Any
# other answer (network error, 404, 5xx, rate limit) fails the job.
#
# Environment:
#   GITHUB_TOKEN       token with contents: read
#   REPOSITORY         owner/name
#   BASE_SHA, HEAD_SHA the pull request's base and head commits
#   GITHUB_API_URL     defaults to https://api.github.com
#   GITHUB_SERVER_URL  defaults to https://github.com
#   GITHUB_OUTPUT      defaults to stdout
#   DEPENDENCY_GRAPH_VERBOSE=1 traces the request to stderr
set -euo pipefail

: "${GITHUB_TOKEN:?GITHUB_TOKEN is required}"
: "${REPOSITORY:?REPOSITORY is required (owner/name)}"
: "${BASE_SHA:?BASE_SHA is required}"
: "${HEAD_SHA:?HEAD_SHA is required}"

api_url="${GITHUB_API_URL:-https://api.github.com}"
server_url="${GITHUB_SERVER_URL:-https://github.com}"
output="${GITHUB_OUTPUT:-/dev/stdout}"
verbose="${DEPENDENCY_GRAPH_VERBOSE:-0}"
url="${api_url}/repos/${REPOSITORY}/dependency-graph/compare/${BASE_SHA}...${HEAD_SHA}"
settings_url="${server_url}/${REPOSITORY}/settings/security_analysis"

trace() { [ "${verbose}" = "1" ] && echo "[dependency-graph] $*" >&2 || true; }

trace "GET ${url}"
response="$(curl --silent --show-error --location --retry 3 \
  --header "Authorization: Bearer ${GITHUB_TOKEN}" \
  --header 'Accept: application/vnd.github+json' \
  --header 'X-GitHub-Api-Version: 2022-11-28' \
  --write-out '\n%{http_code}' \
  "${url}")" || response=$'\n000'
status="${response##*$'\n'}"
body="${response%$'\n'*}"
trace "HTTP ${status}: ${body:0:500}"

if [ "${status}" = 200 ]; then
  echo "Dependency graph is enabled for ${REPOSITORY}; running the dependency review."
  echo "available=true" >>"${output}"
  exit 0
fi

if [ "${status}" = 403 ] && ! grep -qi 'rate limit' <<<"${body}"; then
  echo "::warning title=Dependency review skipped::The dependency graph is disabled for ${REPOSITORY} (HTTP 403), so the dependency review cannot run. Enable it at ${settings_url}; the npm-audit job still fails on high-severity advisories in every lock."
  echo "available=false" >>"${output}"
  exit 0
fi

# Workflow commands end at the first newline, so flatten the JSON body.
summary="$(tr -s '\r\n\t ' ' ' <<<"${body:0:500}")"
echo "::error title=Dependency graph probe failed::${url} answered HTTP ${status}: ${summary}"
exit 1
