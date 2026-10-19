# Native WPE WebKit of the same release as the engine (comparison for an engine on the server),
# from a fixed Debian snapshot. perf-ca.crt is the test CA of the replay server (setup.sh copies it).
ARG DEBIAN_IMAGE
FROM ${DEBIAN_IMAGE}
ARG SNAPSHOT
RUN echo "deb [check-valid-until=no] http://snapshot.debian.org/archive/debian/${SNAPSHOT} sid main" > /etc/apt/sources.list \
    && rm -f /etc/apt/sources.list.d/* \
    && apt-get update && apt-get install -y --no-install-recommends \
       libwpewebkit-2.0-1 cog wpewebkit-webdriver libjavascriptcoregtk-bin ca-certificates \
       fonts-noto-core fonts-dejavu-core nodejs libgles2 libegl1 libegl-mesa0 libgl1-mesa-dri \
    && rm -rf /var/lib/apt/lists/*
COPY perf-ca.crt /usr/local/share/ca-certificates/perf-ca.crt
RUN update-ca-certificates && dpkg-query -W libwpewebkit-2.0-1 cog libjavascriptcoregtk-bin > /versions.txt
