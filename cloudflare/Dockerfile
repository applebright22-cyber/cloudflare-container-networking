FROM node:24-bookworm-slim

RUN apt-get update \
    && apt-get install -y --no-install-recommends ca-certificates curl iproute2 wireguard-tools python3 \
    && rm -rf /var/lib/apt/lists/*

WORKDIR /opt/mysterium

RUN curl -fsSL https://github.com/mysteriumnetwork/node/releases/latest/download/myst_linux_amd64.tar.gz -o /tmp/myst.tar.gz \
    && tar -xzf /tmp/myst.tar.gz -C /opt/mysterium --strip-components=1 \
    && test -x /opt/mysterium/myst \
    && rm -f /tmp/myst.tar.gz

COPY container/myst-entrypoint.sh /opt/mysterium/myst-entrypoint.sh
COPY container/health.py /opt/mysterium/health.py
RUN chmod +x /opt/mysterium/myst-entrypoint.sh

EXPOSE 4050 8080

ENTRYPOINT ["/opt/mysterium/myst-entrypoint.sh"]
