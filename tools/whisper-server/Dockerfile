# whisper.cpp's server with CUDA — the project's own image (v1.9.5,
# CUDA 13.0, so Blackwell / RTX 50xx works), pinned by digest. We only add
# the entrypoint that fetches the model on first start.
#
# Building whisper.cpp ourselves in Docker Desktop is not worth it: the
# CUDA template instances ran the Docker VM out of memory and took other
# containers down with it, even at -j 6.
FROM ghcr.io/ggml-org/whisper.cpp:main-cuda@sha256:56e2ed6dc1a24ef3c65dffbe5b6bbadf49bf8d8db783aba160288b9cd88659f3
COPY entrypoint.sh /entrypoint.sh
RUN chmod +x /entrypoint.sh
EXPOSE 8080
ENTRYPOINT ["/entrypoint.sh"]
