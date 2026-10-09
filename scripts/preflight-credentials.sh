#!/usr/bin/env bash
#
# Prove the release credentials can write before any expensive job runs.
#
# Principle 16 of the shared CI/CD best practices ("Prove You Can Publish
# Before You Build", issues #176 and #181). A non-empty secret proves nothing
# (an expired token is non-empty), and a login -- or a registry token
# endpoint -- proves authentication, not authorisation: auth.docker.io
# answers an anonymous pull,push request with 200 and silently narrows the
# grant to pull. The only form of the check that is not a guess is an
# attempted write: POST /v2/<repo>/blobs/uploads/ -> 202 opens an upload
# session, DELETE cancels it, nothing is stored and no tag moves.
#
# PREFLIGHT_MODE:
#   release -- push to main / manual instant release. A refused credential
#              fails the run here, before the matrix spends a minute.
#   report  -- pull requests, where a fork legitimately has no publishing
#              secrets. The same probes run and annotate, but never block.
#
# Rules each caller depends on (each is a defect if dropped):
#   1. Report every failure, not the first -- no probe aborts the script.
#   2. Report `unknown`, never a guess: a timeout or a 429 has not said the
#      credential is broken. Every configured target must verify in release
#      mode; an unknown answer blocks publication until a later probe passes.
#   3. Probe with a write, not a login.
#
# No set -e on purpose: rule 1 means one failed probe must not hide the rest.

set -u

MODE="${PREFLIGHT_MODE:-report}"
NPM_REGISTRY="${NPM_REGISTRY:-https://registry.npmjs.org}"
DOCKER_REGISTRY="${DOCKER_REGISTRY:-https://registry-1.docker.io}"
DOCKER_AUTH="${DOCKER_AUTH:-https://auth.docker.io}"
CURL_TIMEOUT="${PREFLIGHT_CURL_TIMEOUT:-15}"
NEWLINE=$'\n'

verified=0
n_fail=0
n_unknown=0
failures=''
unknowns=''

ok() {
  verified=$((verified + 1))
  printf '  PASS: %s\n' "$*"
}

bad() {
  n_fail=$((n_fail + 1))
  failures="${failures}${failures:+${NEWLINE}}$1"
  printf '  FAIL: %s\n' "$*"
}

unknown() {
  n_unknown=$((n_unknown + 1))
  unknowns="${unknowns}${unknowns:+${NEWLINE}}$1"
  printf '  UNKNOWN: %s\n' "$*"
}

# curl that separates the HTTP status from the body without temp files.
# Prints "body\nstatus"; a network failure yields an empty status, which the
# callers treat as unknown.
http() {
  local body
  body=$(curl -sS --max-time "$CURL_TIMEOUT" -o - -w "${NEWLINE}%{http_code}" "$@" 2>/dev/null)
  printf '%s\n%s' "${body%"${NEWLINE}"*}" "${body##*"$NEWLINE"}"
}

# Run package.json-relative JSON reads through node: the runtime is the one
# dependency a JS template guarantees, and no jq is needed.
node_read() {
  node -e "$1" 2>/dev/null
}

# Parse only a nonempty string field; never print response bodies to CI logs.
json_string() {
  node -e 'let d="";process.stdin.on("data",c=>d+=c);process.stdin.on("end",()=>{try{const v=JSON.parse(d)[process.argv[1]];if(typeof v!=="string"||!v.trim())process.exit(1);process.stdout.write(v)}catch{process.exit(1)}})' "$1" 2>/dev/null
}

# The presence of ACTIONS_ID_TOKEN_REQUEST_URL proves only that the job may
# mint a GitHub OIDC token, not that npm trusts it: a trusted publisher that
# names another repository (for example the owner before a transfer) refuses
# every publish with `404 Not Found - PUT`. npm's package-specific exchange
# endpoint is the one npm publish calls itself, so it answers the actual
# question; the short-lived token it returns is discarded unprinted.
check_npm_oidc() {
  local oidc_url="$1" request_token="${ACTIONS_ID_TOKEN_REQUEST_TOKEN:-}"
  local package response status payload jwt separator='?'
  if [ -z "$request_token" ]; then
    bad 'npm OIDC request token is missing (ACTIONS_ID_TOKEN_REQUEST_TOKEN is not set)'
    return 0
  fi
  package=$(node_read 'import("./scripts/js-paths.mjs").then(async (p) => { const i = await import("./scripts/package-info.mjs"); process.stdout.write(encodeURIComponent(i.readPackageInfo({ jsRoot: p.parseJsRootConfig() }).name)); }).catch(() => process.exit(1))')
  if [ -z "$package" ]; then
    bad 'npm OIDC package name could not be read from package.json'
    return 0
  fi
  [[ "$oidc_url" == *'?'* ]] && separator='&'
  response=$(http -H "Authorization: Bearer $request_token" "${oidc_url}${separator}audience=npm%3Aregistry.npmjs.org")
  status="${response##*"$NEWLINE"}"
  payload="${response%"${NEWLINE}"*}"
  if [ "$status" != '200' ]; then
    unknown "GitHub OIDC token request answered ${status:-no status}; npm publishing remains unverified"
    return 0
  fi
  jwt=$(printf '%s' "$payload" | json_string value)
  if [ -z "$jwt" ]; then
    bad 'GitHub OIDC token response is malformed'
    return 0
  fi
  response=$(http -X POST -H "Authorization: Bearer $jwt" \
    "$NPM_REGISTRY/-/npm/v1/oidc/token/exchange/package/$package")
  status="${response##*"$NEWLINE"}"
  payload="${response%"${NEWLINE}"*}"
  case "$status" in
    200 | 201)
      if printf '%s' "$payload" | json_string token >/dev/null; then
        ok 'npm OIDC package exchange verified (returned token discarded)'
      else
        bad 'npm OIDC package exchange response is malformed'
      fi
      ;;
    401 | 403 | 404)
      bad "npm refused the OIDC package exchange (${status}) -- the trusted publisher on npmjs.com does not match this repository and workflow (see dev/log/issues/29/pulls/30)"
      ;;
    *)
      unknown "npm OIDC package exchange answered ${status:-no status}; publishing remains unverified"
      ;;
  esac
  return 0
}

check_npm() {
  printf 'npm:\n'

  # npm publishes only through trusted publishing (OIDC); a stored npm token
  # is never used, so one that is present is reported for deletion.
  if [ -n "${NPM_TOKEN:-}" ]; then
    bad 'NPM_TOKEN is set, but npm publishes only through trusted publishing -- delete the secret'
  fi

  if [ -n "${ACTIONS_ID_TOKEN_REQUEST_URL:-}" ]; then
    check_npm_oidc "$ACTIONS_ID_TOKEN_REQUEST_URL"
  else
    bad 'npm has no publish path: ACTIONS_ID_TOKEN_REQUEST_URL is not set (the job needs id-token: write)'
  fi
  return 0
}

check_docker_hub() {
  local image="${DOCKERHUB_IMAGE:-}"
  local username="${DOCKERHUB_USERNAME:-}"
  local token="${DOCKERHUB_TOKEN:-}"

  printf 'Docker Hub:\n'

  if [ -z "$image" ]; then
    printf '  SKIP: DOCKERHUB_IMAGE is not set -- Docker publishing is disabled (scripts/check-docker-publish.mjs)\n'
    return 0
  fi

  if [ -z "$username" ] || [ -z "$token" ]; then
    bad "DOCKERHUB_IMAGE is set (${image}) but DOCKERHUB_USERNAME or DOCKERHUB_TOKEN is missing -- docker-publish would fail at login"
    return 0
  fi

  # The token request below is only a means to the write probe: as measured in
  # issue #181 the endpoint hands out 200 + a token for any scope without
  # proving the scope can be granted, so its answer proves nothing.
  local auth_body payload registry_token
  auth_body=$(http -u "$username:$token" \
    "$DOCKER_AUTH/token?service=registry.docker.io&scope=repository:${image}:pull,push")
  payload="${auth_body%"${NEWLINE}"*}"
  registry_token=$(printf '%s' "$payload" | node_read 'let d="";process.stdin.on("data",(c)=>{d+=c});process.stdin.on("end",()=>{try{process.stdout.write(String(JSON.parse(d).token||""))}catch{process.stdout.write("")}})')
  if [ -z "$registry_token" ]; then
    unknown 'Docker Hub auth endpoint did not return a usable token'
    return 0
  fi

  local headers status location
  headers=$(curl -sS --max-time "$CURL_TIMEOUT" -D - -o /dev/null \
    -X POST -H "Authorization: Bearer $registry_token" \
    "$DOCKER_REGISTRY/v2/${image}/blobs/uploads/" 2>/dev/null)
  if [ -z "$headers" ]; then
    unknown 'Docker Hub registry unreachable during the write probe'
    return 0
  fi
  status=$(printf '%s\n' "$headers" | awk 'NR==1{gsub(/\r/,"");print $2}')
  location=$(printf '%s\n' "$headers" | awk 'tolower($1)=="location:"{gsub(/\r/,"");print $2; exit}')

  case "$status" in
    202)
      # Cancel the opened upload session so nothing is stored.
      if [ -n "$location" ]; then
        curl -sS --max-time "$CURL_TIMEOUT" -o /dev/null -X DELETE \
          -H "Authorization: Bearer $registry_token" "$location" 2>/dev/null || true
      fi
      ok "Docker Hub accepted a blob-upload write for ${image} (202; upload session cancelled)"
      ;;
    401 | 403)
      bad "Docker Hub refused the write for ${image} (${status}) -- the token cannot push this repository"
      ;;
    404)
      bad "Docker Hub reports ${image} as unknown (404) -- check DOCKERHUB_IMAGE and DOCKERHUB_USERNAME"
      ;;
    429)
      unknown 'Docker Hub rate-limited the write probe (429)'
      ;;
    *)
      unknown "Docker Hub answered ${status:-no status} to the write probe (no verdict on the credential)"
      ;;
  esac

  return 0
}

emit_annotations() {
  local level="$1" list="$2"
  [ -n "$list" ] || return 0
  printf '%s\n' "$list" | while IFS= read -r line; do
    [ -n "$line" ] && printf '::%s::release-preflight: %s\n' "$level" "$line"
  done
}

append_summary() {
  [ -n "${GITHUB_STEP_SUMMARY:-}" ] || return 0
  {
    printf '### Release preflight (%s mode)\n\n' "$MODE"
    printf '| verdict | count |\n| --- | --- |\n'
    printf '| verified | %d |\n' "$verified"
    printf '| failed | %d |\n' "$n_fail"
    printf '| unknown | %d |\n' "$n_unknown"
    if [ -n "$failures" ]; then
      printf '\n**Failed**\n\n'
      printf '%s\n' "$failures" | while IFS= read -r line; do
        [ -n "$line" ] && printf -- '- %s\n' "$line"
      done
    fi
    if [ -n "$unknowns" ]; then
      printf '\n**Unknown** (no verdict -- a probe that did not answer has not said the credential is broken)\n\n'
      printf '%s\n' "$unknowns" | while IFS= read -r line; do
        [ -n "$line" ] && printf -- '- %s\n' "$line"
      done
    fi
  } >> "$GITHUB_STEP_SUMMARY"
}

check_npm
check_docker_hub

printf '\nRelease preflight: %d verified, %d failed, %d unknown\n' \
  "$verified" "$n_fail" "$n_unknown"

if [ "$n_fail" -gt 0 ]; then
  if [ "$MODE" = 'release' ]; then
    emit_annotations error "$failures"
    append_summary failed
    printf '::error::release-preflight: refusing to release with %d refused credential(s)\n' "$n_fail"
    exit 1
  fi
  emit_annotations warning "$failures"
  append_summary failed
  printf 'Report mode: the failures above are advisory -- pull requests may come from forks without publishing secrets.\n'
  exit 0
fi

if [ "$verified" -eq 0 ] || [ "$n_unknown" -gt 0 ]; then
  # Rule 2, second half: every configured target must verify. A Docker Hub
  # pass must not hide an npm probe that never answered -- a release would
  # run on pure hope for that registry.
  if [ "$MODE" = 'release' ]; then
    emit_annotations warning "$unknowns"
    append_summary unverified
    printf '::error::release-preflight: not all configured targets verified (%d verified, %d unknown) -- refusing to release on an unproven credential set\n' "$verified" "$n_unknown"
    exit 1
  fi
  emit_annotations warning "$unknowns"
  append_summary unverified
  printf 'Report mode: some credentials remain unverified -- advisory only.\n'
  exit 0
fi

append_summary passed
exit 0
