# ==============================================================================
# GitView Phase 5: Hardened Preview Builder Dockerfile
# ==============================================================================
# Hardened Debian Bookworm Slim pinned to verified multi-arch digest.
# Runtime execution is strictly locked to unprivileged user gitview (UID 10001).
# Root filesystem is read-only compatible. No host ports, no Docker socket.
# Enforces mandatory --ignore-scripts and immutable /etc/npmrc.
# ==============================================================================

FROM node:22-bookworm-slim@sha256:e9f565d32859f0cbfb52125eafe8be39390f24dac302dc3cdf566e8ba3ab21ee

LABEL maintainer="GitView Team" \
      description="GitView Isolated Dependency Builder Image" \
      security.unprivileged="UID 10001" \
      security.read_only="true"

# 1. Install networking utilities and clean package cache
RUN apt-get update \
    && apt-get install -y --no-install-recommends iproute2 \
    && rm -rf /var/lib/apt/lists/*

# 2. Create dedicated unprivileged group and user
RUN groupadd -g 10001 gitview \
    && useradd -u 10001 -g gitview -m -d /home/gitview -s /bin/sh gitview

# 2. Pre-create workspace and user cache directories with explicit ownership
RUN mkdir -p /workspace /home/gitview/.npm /home/gitview/.cache /tmp/npm-cache \
    && chown -R 10001:10001 /workspace /home/gitview /tmp/npm-cache

# 3. Install immutable, root-owned npm configuration
RUN echo "registry=https://registry.npmjs.org/\nignore-scripts=true\naudit=false\nfund=false\nstrict-ssl=true\n" > /etc/npmrc \
    && chmod 644 /etc/npmrc

# 4. Install build runner script
COPY scripts/gitview-build.js /usr/local/bin/gitview-build.js
RUN chmod 755 /usr/local/bin/gitview-build.js

# 5. Set hardened runtime environment
ENV NODE_ENV=development \
    HOME=/home/gitview \
    npm_config_cache=/tmp/npm-cache \
    NPM_CONFIG_GLOBALCONFIG=/etc/npmrc \
    NPM_CONFIG_USERCONFIG=/dev/null \
    npm_config_registry=https://registry.npmjs.org/ \
    NO_PROXY="" \
    no_proxy="" \
    PATH="/usr/local/bin:/usr/bin:/bin"

# 6. Switch to unprivileged non-root user
USER 10001:10001
WORKDIR /workspace

CMD ["node", "/usr/local/bin/gitview-build.js"]
