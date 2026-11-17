# shellcheck shell=bash
# Sourced by the e2e scripts, from the repository root: the server image they run (the server
# itself, or only its ffmpeg and python) is $E2E_IMAGE, fone:e2e by default, never fone:dev or
# fone:latest (the tags a server of yours may run under). e2e_image builds it from server/ at the
# start of a suite (seconds when server/ hasn't changed since the last build); E2E_BUILD=0 runs
# the image as it is (E2E_IMAGE=fone:rc E2E_BUILD=0: a release candidate built beforehand).
E2E_IMAGE=${E2E_IMAGE:-fone:e2e}

e2e_image() {
  if [ "${E2E_BUILD:-1}" != 0 ]; then
    echo "== building $E2E_IMAGE from server/"
    docker build -q -t "$E2E_IMAGE" server >/dev/null
  elif ! docker image inspect "$E2E_IMAGE" >/dev/null 2>&1; then
    echo "e2e: no image $E2E_IMAGE to run (E2E_BUILD=0): build it, or leave E2E_BUILD unset" >&2
    return 1
  fi
}
