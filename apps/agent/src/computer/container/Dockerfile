# The Computer's Linux container: computerd, which mounts the session's workspace at /workspace and runs
# the agent's container commands, plus git, node 24, pnpm, bun and python for installs, builds and tests.
#
# Based on @cloudflare/computer's examples/container. computerd comes from the fork's image, a single
# layer holding its standalone binary, built and pushed by the fork's publish workflow
# (https://github.com/K-Mistele/computer). Pin it to the same commit as the @cloudflare/computer tarball
# in pnpm-workspace.yaml: the Computer and computerd must run matching code.

FROM ghcr.io/k-mistele/computer-computerd-linux-x64:fb24f898cb46e4ba42af7ae99ff735e4616ebe76 AS computerd

FROM oven/bun:1.3.14-debian AS bun

FROM debian:trixie-slim

RUN apt-get update \
 && apt-get install -y --no-install-recommends \
      fuse3 libfuse2t64 ca-certificates curl gnupg git jq ripgrep python3 tmux fd-find build-essential \
 && mkdir -p /etc/apt/keyrings \
 && curl -fsSL https://deb.nodesource.com/gpgkey/nodesource-repo.gpg.key \
      | gpg --dearmor -o /etc/apt/keyrings/nodesource.gpg \
 && echo "deb [signed-by=/etc/apt/keyrings/nodesource.gpg] https://deb.nodesource.com/node_24.x nodistro main" \
      > /etc/apt/sources.list.d/nodesource.list \
 && apt-get update \
 && apt-get install -y --no-install-recommends nodejs \
 && rm -rf /var/lib/apt/lists/* \
 && npm install --global pnpm@12.15.0 \
 && npm cache clean --force

COPY --from=bun /usr/local/bin/bun /usr/local/bin/bun
RUN ln -s /usr/local/bin/bun /usr/local/bin/bunx \
 && ln -s /usr/bin/fdfind /usr/local/bin/fd

COPY --from=computerd /usr/local/bin/computerd /usr/local/bin/computerd

# computerd serves HTTP on PORT and mounts the workspace at MOUNT_POINT. FUSE_MOUNT=auto uses the kernel's
# FUSE, which Cloudflare Containers provide, and falls back to a userspace copy where it is missing.
ENV PORT=8080
ENV MOUNT_POINT=/workspace
ENV FUSE_MOUNT=auto
# Run the agent's commands as root in a bash login shell, like a terminal: computerd calls
# `$EXEC_SHELL -c <command>`, and the wrapper adds -l so /etc/profile and ~/.bashrc load.
ENV HOME=/root
ENV SHELL=/bin/bash
ENV EXEC_SHELL=/usr/local/bin/agent-bash
RUN printf '#!/bin/bash\nexec /bin/bash -l "$@"\n' > /usr/local/bin/agent-bash \
 && chmod +x /usr/local/bin/agent-bash
# Keep computerd's copy of the workspace on disk, not in memory, so a large install can't fill the
# container's memory. Skip SQLite's disk syncs: the disk goes away with the container, so a crash can't
# leave a damaged store behind, and syncing was most of the cost of saving each file.
ENV COMPUTERD_DB=/var/lib/computerd/state.db
ENV COMPUTERD_DB_SYNCHRONOUS=off
# Let the kernel remember "file not found" for a second. Module resolution looks for many files that
# don't exist, and without this every miss goes to computerd. computerd waits out the second after the
# Computer sends files, so a command never misses one.
ENV COMPUTERD_FUSE_NEGATIVE_TIMEOUT=1
# Never send gitignored files back to the Computer. node_modules stays on the container's disk through
# the Computer's `ignore` option (MOUNT_IGNORE), which must not be set here.
ENV SYNC_GITIGNORE=1
RUN mkdir -p /var/lib/computerd
EXPOSE 8080

ENTRYPOINT ["/usr/local/bin/computerd"]
