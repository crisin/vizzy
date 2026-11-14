#!/bin/sh
# Downloads the models on first start (into the volume), then serves.
set -e
fetch() { # repo file
  if [ ! -f "/models/$2" ]; then
    echo "downloading $2 …"
    curl -fL --retry 3 -o "/models/$2.part" "https://huggingface.co/$1/resolve/main/$2"
    mv "/models/$2.part" "/models/$2"
  fi
}

MODEL="ggml-${WHISPER_MODEL:-large-v3-turbo}.bin"
fetch ggerganov/whisper.cpp "$MODEL"

# Optional Silero VAD (WHISPER_VAD=1): cuts the parts without a voice before
# Whisper sees them. Off by default — it is trained on speech and drops whole
# sung lines (measured on six songs at thresholds 0.1–0.5).
VAD_ARGS=""
if [ "${WHISPER_VAD:-0}" != "0" ]; then
  VAD="${WHISPER_VAD_MODEL:-ggml-silero-v5.1.2.bin}"
  fetch ggml-org/whisper-vad "$VAD"
  VAD_ARGS="--vad -vm /models/$VAD -vt ${WHISPER_VAD_THRESHOLD:-0.5}"
fi

exec whisper-server --host 0.0.0.0 --port 8080 -m "/models/$MODEL" \
  --flash-attn --threads "${WHISPER_THREADS:-8}" $VAD_ARGS ${WHISPER_ARGS}
