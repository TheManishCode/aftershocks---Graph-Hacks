# API + MCP server. Non-root, no build tools in the final image.
FROM python:3.12-slim AS build
WORKDIR /src
RUN pip install --no-cache-dir --upgrade pip build
COPY pyproject.toml README.md ./
COPY aftershock ./aftershock
RUN python -m build --wheel --outdir /dist

FROM python:3.12-slim
RUN apt-get update && apt-get install -y --no-install-recommends git ca-certificates \
    && rm -rf /var/lib/apt/lists/* \
    && useradd --create-home --uid 10001 aftershock \
    && mkdir -p /data/clones /data/cache && chown -R aftershock /data
COPY --from=build /dist/*.whl /tmp/
RUN pip install --no-cache-dir "$(ls /tmp/*.whl)[agent]" && rm /tmp/*.whl
USER aftershock
WORKDIR /data
ENV AFTERSHOCK_CLONE_DIR=/data/clones AFTERSHOCK_CACHE_DIR=/data/cache PYTHONUNBUFFERED=1
EXPOSE 8100
HEALTHCHECK --interval=15s --timeout=3s --retries=5 \
    CMD python -c "import urllib.request,sys; sys.exit(0 if urllib.request.urlopen('http://127.0.0.1:8100/api/v1/health').status==200 else 1)"
CMD ["aftershock", "serve", "--host", "0.0.0.0", "--port", "8100"]
