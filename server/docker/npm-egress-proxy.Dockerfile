# ==============================================================================
# GitView Phase 5: Trusted npm Egress Proxy Dockerfile
# ==============================================================================
# Dedicated micro HTTP CONNECT proxy strictly allowlisting registry.npmjs.org:443
# Hardened Debian Bookworm Slim pinned to verified multi-arch digest.
# Runtime execution is strictly locked to unprivileged user gitview (UID 10001).
# Root filesystem is read-only compatible. No host ports, no Docker socket.
# ==============================================================================

FROM node:22-bookworm-slim@sha256:e9f565d32859f0cbfb52125eafe8be39390f24dac302dc3cdf566e8ba3ab21ee

LABEL maintainer="GitView Team" \
      description="GitView Trusted npm Egress Proxy" \
      security.unprivileged="UID 10001" \
      security.read_only="true"

# 1. Install networking utilities and clean package cache
RUN apt-get update \
    && apt-get install -y --no-install-recommends iproute2 \
    && rm -rf /var/lib/apt/lists/*

# 2. Create dedicated unprivileged group and user
RUN groupadd -g 10001 gitview \
    && useradd -u 10001 -g gitview -m -d /home/gitview -s /bin/sh gitview

# 2. Install proxy script
COPY scripts/gitview-egress-proxy.js /usr/local/bin/gitview-egress-proxy.js
RUN chmod 755 /usr/local/bin/gitview-egress-proxy.js

# 3. Hardened runtime environment
ENV NODE_ENV=production \
    PORT=3128 \
    HOME=/home/gitview \
    PATH="/usr/local/bin:/usr/bin:/bin"

# 4. Switch to unprivileged non-root user
USER 10001:10001
WORKDIR /home/gitview

EXPOSE 3128

CMD ["node", "/usr/local/bin/gitview-egress-proxy.js"]
