# Upstream report: Docker containerd filesystem changes resource use

## Observed incident and source evidence

The reporter of [disk-space-saviour issue 22](https://github.com/link-foundation/disk-space-saviour/issues/22)
observed 22 concurrent changes requests against one Docker 29.6.1 container
using the containerd image store on an 11.7 GB Ubuntu 24.04 host. The kernel
reported dockerd anonymous RSS of 7,302,520 kB before killing it. Restarting
dockerd then terminated all task containers. The related
[profile](https://github.com/link-foundation/disk-space-saviour/issues/21)
records 2,022 seconds in 24 diffs of large image/build trees.

These are the original reporter's observations, not an OOM reproduced in this
checkout. This checkout's Docker daemon uses fuse-overlayfs, so it does not
reproduce the reported containerd backend. We intentionally did not run the
unbounded original reproduction on the shared host.

[ImageService.Changes](https://github.com/moby/moby/blob/master/daemon/containerd/image_changes.go)
mounts both the parent image and the container root and calls
`archive.ChangesDirs(containerRoot, imageRoot)`. The call does not pass the
request context to the tree comparison. The endpoint returns the complete
change list; limiting the client's output therefore cannot bound the daemon's
tree-comparison allocation.

## Bounded diagnostic reproduction

Run on a disposable Linux VM with cgroup memory enforcement. Use a new DinD
daemon, without exposing the host Docker socket. Verify that `docker info`
inside it reports the containerd snapshotter. Cap the outer DinD container
at 1 GiB RAM, 1 GiB total memory/swap and 256 PIDs:

```sh
probe="dss-changes-probe-$$"
docker run -d --privileged --name "$probe" \
  --memory=1g --memory-swap=1g --pids-limit=256 \
  -e DOCKER_TLS_CERTDIR= docker:29-dind
trap 'docker rm -f "$probe" >/dev/null' EXIT
ready=false
for attempt in $(seq 1 90); do
  if docker exec "$probe" docker info >/dev/null 2>&1; then
    ready=true
    break
  fi
  sleep 1
done
"$ready" || exit 1
docker exec "$probe" docker info
docker exec "$probe" sh -c '
  set -eu
  mkdir -p /tmp/context
  cat > /tmp/context/Dockerfile <<\EOF
FROM busybox:1.37
RUN mkdir /lower && i=0 && while [ "$i" -lt 10000 ]; do \
    echo lower > /lower/f"$i"; i=$((i+1)); done
EOF
  docker build -t changes-probe /tmp/context
  docker run -d --name target changes-probe sleep 600
  docker exec target sh -c "echo upper > /lower/one-new-file"
  time docker diff target > /tmp/diff-single.txt
  wc -l /tmp/diff-single.txt
'
```

The escaped heredoc delimiter preserves the Dockerfile variables literally.
This proposed diagnostic has not run here: our host rejects memory-capped DinD
containers with `cannot enter cgroupv2 ... invalid state` before startup.
Repeat with finite 1,000 and 10,000
lower files, and at most two concurrent requests. Record elapsed time and
the daemon's `/proc/<pid>/status` before/after; the diagnostic does not promise
to reproduce OOM. The memory cap contains any failure to this test daemon.
Wait for readiness before building; remove its container in `finally`/the trap.

## Workarounds and suggested code changes

Clients should serialize requests, cache one snapshot per measurement run,
skip large candidates or low-memory hosts, and prefer direct upperdir usage.
Removing image-layer files creates whiteouts and does not recover image bytes;
remove unused containers/images after work finishes instead.

For the overlay snapshotter, derive changes from upperdir metadata and whiteouts
without walking unchanged lower contents. For other snapshotters, add request
cancellation to tree comparison, bound concurrent expensive comparisons per
daemon, and expose a bounded/streaming changes API or snapshot usage suitable
for individual paths. Document that the current changes endpoint can consume
memory proportional to the compared trees.
