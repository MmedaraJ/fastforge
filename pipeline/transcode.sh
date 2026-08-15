#!/usr/bin/env bash
#
# transcode.sh: per-title ABR ladder generator (Phase 1, bash edition)
# Usage: ./transcode.sh <input.mp4> <output_dir>

set -euo pipefail

# ---------- 1. Arguments ----------
# If there are not exactly 2 arguments, echo an error message and exit
if [[ $# -ne 2 ]]; then
    echo "Usage: $0 <input.mp4> <output_dir>" >&2
    exit 1
fi

# First and second arguments should be store in INPUT and OUTPUT respectively
INPUT="$1"
OUT="$2"

# If input is not a real file, error message and exit
if [[ ! -f "$INPUT" ]]; then
    echo "error: input file not found: $INPUT" >&2
    exit 1
fi

mkdir -p "$OUT"

# ---------- 2. Probe ----------
PROBE=$(ffprobe -v quiet -print_format json -show_streams -select_streams v:0 "$INPUT")
HEIGHT=$(echo "$PROBE" | jq -r '.streams[0].height')
FPS_RAW=$(echo "$PROBE" | jq -r '.streams[0].r_frame_rate') # e.g. "30/1" or "30000/1001"

# r_frame_rate is a fraction. Evaluate it, then round to the nearest integer
FPS=$(awk "BEGIN { printf \"%.3f\", ${FPS_RAW} }") # "29.970"
FPS_INT=$(printf "%.0f" "$FPS") # 30

# GOP: 2-second keyframe cadence (Apple spec 1.13), segments = 6s = 3 GOPs
GOP=$(( FPS_INT * 2 ))

echo "── probe ─────────────────────────────"
echo "  source height : ${HEIGHT}p"
echo "  frame rate    : ${FPS_RAW} (≈ ${FPS} fps → using ${FPS_INT})"
echo "  GOP           : ${GOP} frames (2s), segment: 6s"
echo "──────────────────────────────────────"

# ---------- 3. Ladder engine ----------
# height:bitrate_k:maxrate_k:bufsize_k:audio_k
RUNGS=( "1080:5000:5350:7500:128" "720:2800:2996:4200:128" "480:1400:1498:2100:96" )

# --- 3a. Per-title filter: keep only rungs <= source height ---
SELECTED=()
for rung in "${RUNGS[@]}"; do
    IFS=':' read -r h _ _ _ _ <<< "$rung"
    if (( h <= HEIGHT )); then
        SELECTED+=( "$rung" )
    else
        echo "  skipping ${h}p run (source is only ${HEIGHT}p - never upscale)"
    fi
done

# Edge case: source smaller than the lowest rung -> encode at source height once
if (( ${#SELECTED[@]} == 0 )); then
    echo "  source below lowest rung; using single ${HEIGHT}p rung at 800k"
    SELECTED=( "${HEIGHT}:800:856:1200:96" )
fi

N=${#SELECTED[@]}
echo "  ladder: ${N} rung(s)"

# --- 3b. Assemble filter_complex ---
# Goal: "[0:v]split=3[v0][v1][v2];[v0]scale=2:1080[v0out];[v1]scale=2:720[v1out];[v2]scale=2:480[v2out];..."
SPLIT_LABELS=""
SCALE_CHAINS=""
for i in "${!SELECTED[@]}"; do
    IFS=':' read -r h _ _ _ _ <<< "${SELECTED[$i]}"
    SPLIT_LABELS+="[v${i}]"
    SCALE_CHAINS+=";[v${i}]scale=2:${h}[v${i}out]"
done
FILTER="[0:v]split=${N}${SPLIT_LABELS}${SCALE_CHAINS}"

# --- 3c. Assemble per-stream args + var_stream_map ---
ARGS=( -i "$INPUT" -filter_complex "$FILTER" )
VSM=""
for i in "${!SELECTED[@]}"; do
    IFS=':' read -r h br mr bs ab <<< "${SELECTED[$i]}"
    ARGS+=(
        -map "[v${i}out]"
        -c:v:"$i" libx264 -preset medium
        -b:v:"$i" "${br}k" -maxrate:v:"$i" "${mr}k" -bufsize:v:"$i" "${bs}k"
    )
    ARGS+=( -map a:0 -c:a:"$i" aac -b:a:"$i" "${ab}k" )
    VSM+="v:${i},a:${i} "
done
VSM="${VSM% }" # trim trailing space

# --- 3d. GLobal encode + HLS muxer flags ---
ARGS+=(
    -g "$GOP" -keyint_min "$GOP" -sc_threshold 0 -r "$FPS_INT"
    -f hls -hls_time 6 -hls_playlist_type vod
    -hls_segment_filename "${OUT}/stream_%v/seg_%03d.ts"
    -master_pl_name master.m3u8
    -var_stream_map "$VSM"
    "${OUT}/stream_%v/index.m3u8"
)

# --- 3e. Show, then run ---
echo "── command ───────────────────────────"
printf 'ffmpeg'; printf ' %q' "${ARGS[@]}"; printf '\n'
echo "──────────────────────────────────────"
ffmpeg "${ARGS[@]}"

# --- 3f. Summary ---
echo "── output ────────────────────────────"
du -sh "${OUT}"/stream_* 2>/dev/null || true
echo "master: ${OUT}/master.m3u8"

# ---------- 4. Poster + trick-play ----------
COLS=5
INTERVAL=10          # one thumbnail every 10s
THUMB_W=160

# duration (seconds, float) and aspect-correct thumb height (even, like -2)
DURATION=$(ffprobe -v quiet -print_format json -show_format "$INPUT" | jq -r '.format.duration')
SRC_W=$(echo "$PROBE" | jq -r '.streams[0].width')
THUMB_H=$(awk "BEGIN { h = ${THUMB_W} * ${HEIGHT} / ${SRC_W}; h = int((h+1)/2)*2; print h }")

NTHUMBS=$(awk "BEGIN { print int(${DURATION}/${INTERVAL}) + 1 }")
ROWS=$(( (NTHUMBS + COLS - 1) / COLS ))          # ceil division in bash

echo "  poster + sprite: ${NTHUMBS} thumbs → grid ${COLS}x${ROWS} (${THUMB_W}x${THUMB_H} each)"

# ---------- Poster selection: the sophistication ladder ----------
# Picking a poster frame is a real product problem; the industry solves it
# at four levels of effort. We're at level 2.
#
#   1. Fixed offset          — `-ss 10 -frames:v 1`. Blind grab at N seconds.
#      Cheap, ~90% fine; dodges black frame 0 / logos / fade-ins, but can
#      land on a blurry mid-motion or mid-blink frame.
#
#   2. Representative frame  — (CURRENT) seek to ~10% of duration (clamped
#      for short clips), then `thumbnail=300`: FFmpeg histograms a 300-frame
#      window (~10s) and emits the frame closest to the batch average —
#      systematically avoids scene cuts, flashes, and black frames.
#      Caveat: "statistically typical" != "beautiful"; a talky scene's
#      average frame is someone mid-gesture, not a hero shot.
#
#   3. Heuristic scoring     — decode candidates from several windows,
#      score each for sharpness, brightness/contrast, face presence;
#      pick the max. What mid-size platforms build in-house.
#
#   4. ML-scored selection   — e.g. Netflix AVA: models rank thousands of
#      candidates on aesthetics, faces, brand safety, because the poster
#      measurably drives click-through. Poster choice as an ML feature.
#
# Planned improvement (Phase 4): generate 2-3 candidates (windows at
# ~10% / 40% / 70%) and route them through the platform's human-review /
# AI-copilot flow — poster becomes a reviewable asset like AI-generated
# content, instead of a silent pipeline decision.
# ------------------------------------------------------------------

# poster: seek ~10% in (clamped), then let the thumbnail filter pick the most
# representative frame from the next ~300 frames (~10s at 30fps)
POSTER_TS=$(awk "BEGIN { t = ${DURATION} * 0.10; if (t < 3) t = 0; print int(t) }")

ffmpeg -y -v error -ss "$POSTER_TS" -i "$INPUT" \
  -vf "thumbnail=300,scale=-2:720" \
  -frames:v 1 "${OUT}/poster.jpg"

echo "  poster: picked from ~${POSTER_TS}s window"

# sprite sheet: one frame per INTERVAL, tiled into a single sheet
ffmpeg -y -v error -i "$INPUT" \
  -vf "fps=1/${INTERVAL},scale=${THUMB_W}:${THUMB_H},tile=${COLS}x${ROWS}" \
  -frames:v 1 "${OUT}/sprite.jpg"

# ---------- 4b. WebVTT thumbnail track ----------
# Sample output

# ------------------------------
# WEBVTT

# 00:00:00.000 --> 00:00:10.000
# sprite.jpg#xywh=0,0,160,90

# 00:00:10.000 --> 00:00:20.000
# sprite.jpg#xywh=160,0,160,90
# ...
# ------------------------------

fmt_time() {  # seconds -> HH:MM:SS.000
    local s=$1
    printf "%02d:%02d:%02d.000" $(( s/3600 )) $(( (s%3600)/60 )) $(( s%60 ))
}

VTT="${OUT}/thumbnails.vtt"
echo "WEBVTT" > "$VTT"
echo "" >> "$VTT"

for (( i=0; i<NTHUMBS; i++ )); do
    START=$(( i * INTERVAL ))
    END=$(( START + INTERVAL ))
    COL=$(( i % COLS ))
    ROW=$(( i / COLS ))
    X=$(( COL * THUMB_W ))
    Y=$(( ROW * THUMB_H ))
    {
      echo "$(fmt_time $START) --> $(fmt_time $END)"
      echo "sprite.jpg#xywh=${X},${Y},${THUMB_W},${THUMB_H}"
      echo ""
    } >> "$VTT"
done
echo "  wrote ${VTT} (${NTHUMBS} cues)"