package main

import (
	"bytes"
	"cmp"
	"context"
	"encoding/json"
	"errors"
	"fmt"
	"io"
	"log"
	"log/slog"
	"net/http"
	"os"
	"os/signal"
	"path/filepath"
	"strings"
	"syscall"
	"time"

	"github.com/MmedaraJ/fastforge/internal/jobs"
	"github.com/MmedaraJ/fastforge/internal/langs"
	"github.com/MmedaraJ/fastforge/internal/storage"
	"github.com/MmedaraJ/fastforge/internal/store"
	"github.com/go-chi/chi/v5"
	"github.com/google/uuid"
	"github.com/jackc/pgx/v5"
	"github.com/jackc/pgx/v5/pgxpool"
	"github.com/joho/godotenv"
	"github.com/riverqueue/river"
	"github.com/riverqueue/river/riverdriver/riverpgxv5"
)

const (
	maxTitleBytes  = 256
	maxUploadBytes = 5 << 30 // 5 GiB, for http.MaxBytesReader
	// A two-hour film's subtitles are around 100 kB of WebVTT.
	maxSubtitleBytes = 2 << 20
)

var allowedExtensions = map[string]bool{
	".mp4": true, ".mov": true, ".mkv": true, ".webm": true,
}

type errorResponse struct {
	Error string `json:"error"`
}

type createAssetResponse struct {
	ID     string `json:"asset_id"`
	Status string `json:"status"`
}

type Asset struct {
	ID               string      `json:"asset_id"`
	Title            string      `json:"title"`
	Status           string      `json:"status"`
	VideoCodec       *string     `json:"video_codec"`
	Width            *int        `json:"width"`
	Height           *int        `json:"height"`
	DurationS        *float64    `json:"duration_s"`
	FPS              *float64    `json:"fps"`
	AudioCodec       *string     `json:"audio_codec"`
	AudioBitrateKbps *int        `json:"audio_bitrate_kbps"`
	Renditions       []Rendition `json:"renditions"`
	Tracks           []Track     `json:"tracks"`
	HLSURL           *string     `json:"hls_url"`
	DASHURL          *string     `json:"dash_url"`
	Error            *string     `json:"error"`
	CreatedAt        time.Time   `json:"created_at"`
	UpdatedAt        time.Time   `json:"updated_at"`
}

// Track is one audio or subtitle language the asset's manifests offer.
type Track struct {
	Kind      string `json:"kind"` // "audio" or "subtitles"
	Language  string `json:"language"`
	Label     string `json:"label"`
	IsDefault bool   `json:"default"`
}

type Rendition struct {
	Height        int      `json:"height"`
	Width         int      `json:"width"`
	VideoCodec    string   `json:"video_codec"`
	FPS           float64  `json:"fps"`
	BitrateKbps   int      `json:"bitrate_kbps"`
	FileSizeBytes int64    `json:"file_size_bytes"`
	VMAF          *float64 `json:"vmaf"`
}

type beacon struct {
	SessionID              string    `json:"sessionId"`
	AssetID                string    `json:"assetId"`
	StartedAt              time.Time `json:"startedAt"`
	StartupMs              *int      `json:"startupMs"`
	PlayingMs              int       `json:"playingMs"`
	RebufferCount          int       `json:"rebufferCount"`
	RebufferMs             int       `json:"rebufferMs"`
	SwitchUpCount          int       `json:"switchUpCount"`
	SwitchDownCount        int       `json:"switchDownCount"`
	AverageBitrateKbps     *int      `json:"averageBitrateKbps"`
	DroppedFrames          int       `json:"droppedFrames"`
	AbrAlgorithm           string    `json:"abrAlgorithm"`
	NetworkProfile         *string   `json:"networkProfile"`
	MeasuredThroughputKbps *int      `json:"measuredThroughputKbps"`
	Engine                 *string   `json:"engine"`
	Protocol               *string   `json:"protocol"`
	FatalError             *string   `json:"fatalError"`
}

func writeJSONError(w http.ResponseWriter, status int, msg string) {
	w.Header().Set("Content-Type", "application/json")
	w.WriteHeader(status)
	_ = json.NewEncoder(w).Encode(errorResponse{Error: msg})
}

func writeJSON(w http.ResponseWriter, status int, v any) {
	w.Header().Set("Content-Type", "application/json")
	w.WriteHeader(status)
	_ = json.NewEncoder(w).Encode(v)
}

func makeCreateBeacon(pool *pgxpool.Pool) http.HandlerFunc {
	return func(w http.ResponseWriter, r *http.Request) {
		defer r.Body.Close()

		// sendBeacon declares text/plain to stay a simple request, so
		// Content-Type carries no information and isn't checked. The body IS
		// capped: this endpoint is unauthenticated and reachable from any
		// origin, and the one thing a telemetry sink must never do is trust
		// the size of its input.
		var b beacon
		if err := json.NewDecoder(io.LimitReader(r.Body, 8<<10)).Decode(&b); err != nil {
			http.Error(w, "bad beacon", http.StatusBadRequest)
			return
		}

		_, err := pool.Exec(r.Context(), `
			INSERT INTO playback_sessions
			  (id, asset_id, started_at, startup_ms, playing_ms, rebuffer_count, rebuffer_ms, switch_up_count, 
			  switch_down_count, average_bitrate_kbps, dropped_frames, abr_algorithm, network_profile, 
			  measured_throughput_kbps, fatal_error, user_agent, engine, protocol)
			VALUES ($1,$2,$3,$4,$5,$6,$7,$8,$9,$10,$11,$12,$13,$14,$15,$16,$17,$18)
			ON CONFLICT (id) DO NOTHING`,
			b.SessionID, b.AssetID, b.StartedAt, b.StartupMs, b.PlayingMs, b.RebufferCount, b.RebufferMs, b.SwitchUpCount,
			b.SwitchDownCount, b.AverageBitrateKbps, b.DroppedFrames, b.AbrAlgorithm, b.NetworkProfile,
			b.MeasuredThroughputKbps, b.FatalError, r.UserAgent(), b.Engine, b.Protocol,
		)
		if err != nil {
			// Logged, not returned. A telemetry failure must never become a
			// client-visible error — the measurement apparatus is not allowed
			// to degrade the thing it measures.
			log.Printf("beacon insert: %v", err)
		}

		// 204 and nothing else: the client is unloading. It cannot read a
		// response and must not be kept waiting for one.
		w.WriteHeader(http.StatusNoContent)
	}
}

func makeCreateAsset(pool *pgxpool.Pool, rc *river.Client[pgx.Tx]) http.HandlerFunc {
	return func(w http.ResponseWriter, r *http.Request) {
		mr, err := r.MultipartReader()
		if err != nil {
			writeJSONError(w, http.StatusBadRequest, "request must be multipart/form-data")
			return
		}

		var (
			title         string
			gotTitle      bool
			assetID       = uuid.New()
			dstPath       string
			written       int64
			gotFile       bool
			subtitleLangs = map[string]bool{} // Languages of the subtitle files received so far.
			created       bool
		)

		// Files are written as their parts arrive, so every way out of this
		// handler except success must remove them: a subtitle file rejected
		// after the video was saved would otherwise leave both behind.
		subtitlesDir := storage.SubtitlesDir(assetID.String())
		defer func() {
			if created {
				return
			}
			os.RemoveAll(subtitlesDir)
			if dstPath != "" {
				os.Remove(dstPath)
			}
		}()

		for {
			part, err := mr.NextPart()
			if err == io.EOF {
				break // no more parts — the stream's ENDLIST
			}
			if err != nil {
				writeJSONError(w, http.StatusBadRequest, "Error reading file part")
				return
			}

			switch part.FormName() {
			case "title":
				if gotTitle {
					part.Close()
					writeJSONError(w, http.StatusBadRequest, "multiple titles")
					return
				}

				// Read only the first 1024 bytes. Forget the rest.
				// Should be enough for titles
				b, err := io.ReadAll(io.LimitReader(part, maxTitleBytes+1))
				if err != nil {
					part.Close()
					writeJSONError(w, http.StatusBadRequest, "invalid title field")
					return
				}
				if int64(len(b)) > maxTitleBytes {
					part.Close()
					writeJSONError(w, http.StatusBadRequest,
						fmt.Sprintf("title exceeds %d bytes", maxTitleBytes))
					return
				}
				title = strings.TrimSpace(string(b))
				gotTitle = true
			case "file":
				if gotFile {
					part.Close()
					writeJSONError(w, http.StatusBadRequest, "multiple file parts")
					return
				}

				ext := strings.ToLower(filepath.Ext(part.FileName()))
				if !allowedExtensions[ext] {
					part.Close()
					writeJSONError(w, http.StatusBadRequest, fmt.Sprintf("unsupported file type %q", ext))
					return
				}

				dstPath = filepath.Join("storage", "sources", assetID.String()+ext)

				dst, err := os.Create(dstPath)
				if err != nil {
					part.Close()
					slog.Error("saving file", "err", err, "asset_id", assetID)
					writeJSONError(w, http.StatusInternalServerError, "saving file")
					return
				}

				var copyErr error
				written, copyErr = io.Copy(dst, part)
				if copyErr != nil {
					dst.Close()
					part.Close()
					os.Remove(dstPath)
					slog.Error("writing file", "err", copyErr, "asset_id", assetID)
					writeJSONError(w, http.StatusInternalServerError, "writing file")
					return
				}

				if err := dst.Close(); err != nil {
					slog.Warn("closing dst", "err", err)
				}

				gotFile = true
			case "subtitles":
				// One WebVTT file per language, named after it: en.vtt,
				// vi.vtt, pt-BR.vtt. Repeat the field for each language:
				//   curl -F subtitles=@en.vtt -F subtitles=@vi.vtt ...
				name := filepath.Base(part.FileName())
				lang, ok := strings.CutSuffix(name, ".vtt")
				if !ok || !langs.Valid(lang) {
					part.Close()
					writeJSONError(w, http.StatusBadRequest,
						fmt.Sprintf("subtitle file %q: name it after its language, such as en.vtt or pt-BR.vtt", name))
					return
				}
				lang = langs.Normalize(lang)
				if subtitleLangs[lang] {
					part.Close()
					writeJSONError(w, http.StatusBadRequest, fmt.Sprintf("two subtitle files for %q", lang))
					return
				}

				b, err := io.ReadAll(io.LimitReader(part, maxSubtitleBytes+1))
				if err != nil || len(b) > maxSubtitleBytes {
					part.Close()
					writeJSONError(w, http.StatusBadRequest,
						fmt.Sprintf("subtitle file %q is unreadable or over %d bytes", name, maxSubtitleBytes))
					return
				}
				// The packager would reject a file that isn't WebVTT, but
				// only minutes from now, after every rung is encoded.
				if !bytes.HasPrefix(bytes.TrimPrefix(b, []byte("\xEF\xBB\xBF")), []byte("WEBVTT")) {
					part.Close()
					writeJSONError(w, http.StatusBadRequest,
						fmt.Sprintf("subtitle file %q isn't WebVTT: the first line must be WEBVTT", name))
					return
				}

				if err := os.MkdirAll(subtitlesDir, 0o755); err != nil {
					part.Close()
					slog.Error("saving subtitles", "err", err, "asset_id", assetID)
					writeJSONError(w, http.StatusInternalServerError, "saving subtitles")
					return
				}
				if err := os.WriteFile(filepath.Join(subtitlesDir, lang+".vtt"), b, 0o644); err != nil {
					part.Close()
					slog.Error("saving subtitles", "err", err, "asset_id", assetID)
					writeJSONError(w, http.StatusInternalServerError, "saving subtitles")
					return
				}
				subtitleLangs[lang] = true
			}
			part.Close()
		}

		if !gotFile {
			writeJSONError(w, http.StatusBadRequest, "missing file part")
			return
		}

		if !gotTitle {
			writeJSONError(w, http.StatusBadRequest, "missing title")
			return
		}

		tx, err := pool.Begin(r.Context())
		if err != nil {
			slog.Error("Begin connection pool", "err", err, "asset_id", assetID)
			writeJSONError(w, http.StatusInternalServerError, "failed to save asset")
			return
		}
		defer tx.Rollback(r.Context())

		_, err = tx.Exec(r.Context(),
			`INSERT INTO assets (id, title, storage_path, source_size_bytes)
			VALUES ($1, $2, $3, $4)`,
			assetID, title, dstPath, written)

		if err != nil {
			slog.Error("Executing transaction", "err", err, "asset_id", assetID)
			writeJSONError(w, http.StatusInternalServerError, "failed to save asset")
			os.Remove(dstPath)
			return
		}

		_, err = rc.InsertTx(r.Context(), tx, jobs.TranscodeArgs{AssetID: assetID.String()}, nil)
		if err != nil {
			slog.Error("Failed to save asset", "err", err, "asset_id", assetID)
			writeJSONError(w, http.StatusInternalServerError, "failed to save asset")
			os.Remove(dstPath)
			return
		}

		err = tx.Commit(r.Context())
		if err != nil {
			slog.Error("Failed to save asset", "err", err, "asset_id", assetID)
			writeJSONError(w, http.StatusInternalServerError, "failed to save asset")
			os.Remove(dstPath)
			return
		}

		created = true

		writeJSON(w, http.StatusCreated, createAssetResponse{
			ID:     assetID.String(),
			Status: "queued",
		})
	}
}

// URLParam → QueryRow → Scan into your Asset struct →
// errors.Is(err, pgx.ErrNoRows) → 404, else 200 JSON.
func makeGetAsset(pool *pgxpool.Pool, mediaBase string) http.HandlerFunc {
	return func(w http.ResponseWriter, r *http.Request) {
		idStr := chi.URLParam(r, "id")

		assetID, err := uuid.Parse(idStr)
		if err != nil {
			writeJSONError(w, http.StatusBadRequest, "invalid asset id")
			return
		}

		var a Asset
		var hlsPath, dashPath *string

		err = pool.QueryRow(r.Context(),
			`SELECT id, title, status, video_codec, width, height, duration_s, fps,
			        audio_codec, audio_bitrate_kbps, error, created_at, updated_at, hls_path, dash_path
			 FROM assets
			 WHERE id = $1`,
			assetID,
		).Scan(
			&a.ID, &a.Title, &a.Status, &a.VideoCodec, &a.Width, &a.Height,
			&a.DurationS, &a.FPS, &a.AudioCodec, &a.AudioBitrateKbps, &a.Error, &a.CreatedAt, &a.UpdatedAt,
			&hlsPath, &dashPath,
		)

		if errors.Is(err, pgx.ErrNoRows) {
			writeJSONError(w, http.StatusNotFound, "asset not found")
			return
		}

		if err != nil {
			slog.Error("querying asset", "err", err, "asset_id", idStr)
			writeJSONError(w, http.StatusInternalServerError, "failed to load asset")
			return
		}

		// The database stores a storage path; the API publishes a URL. Keeping
		// those separate means the disk layout can change without breaking the
		// contract — and when these files move to a CDN, only this bit changes.
		if hlsPath != nil {
			u := mediaBase + "/" + strings.TrimPrefix(*hlsPath, "storage/")
			a.HLSURL = &u
		}
		if dashPath != nil {
			u := mediaBase + "/" + strings.TrimPrefix(*dashPath, "storage/")
			a.DASHURL = &u
		}

		rows, err := pool.Query(r.Context(),
			`SELECT height, width, video_codec, fps, bitrate_kbps, file_size_bytes, vmaf
			FROM renditions
			WHERE asset_id = $1
			ORDER BY height DESC`, assetID)

		if err != nil {
			slog.Error("querying renditions", "err", err, "asset_id", idStr)
			writeJSONError(w, http.StatusInternalServerError, "failed to load asset")
			return
		}
		defer rows.Close()

		// Not nil: a nil slice marshals to null, an empty one to [].
		// "no renditions yet" and "this field is missing" are different things.
		a.Renditions = []Rendition{}

		for rows.Next() {
			var rd Rendition
			if err := rows.Scan(&rd.Height, &rd.Width, &rd.VideoCodec, &rd.FPS,
				&rd.BitrateKbps, &rd.FileSizeBytes, &rd.VMAF); err != nil {
				slog.Error("scanning rendition", "err", err, "asset_id", idStr)
				writeJSONError(w, http.StatusInternalServerError, "failed to load asset")
				return
			}
			a.Renditions = append(a.Renditions, rd)
		}

		// rows.Next() returning false does NOT mean success — the iteration
		// can fail partway. Skip this check and you silently serve a
		// truncated list. This is the classic pgx/database-sql trap.
		if err := rows.Err(); err != nil {
			slog.Error("iterating renditions", "err", err, "asset_id", idStr)
			writeJSONError(w, http.StatusInternalServerError, "failed to load asset")
			return
		}

		tracks, err := loadTracks(r.Context(), pool, assetID)
		if err != nil {
			slog.Error("loading tracks", "err", err, "asset_id", idStr)
			writeJSONError(w, http.StatusInternalServerError, "failed to load asset")
			return
		}
		a.Tracks = tracks

		writeJSON(w, http.StatusOK, a)
	}
}

// loadTracks lists the asset's audio and subtitle languages: audio first, the
// default first within each kind.
func loadTracks(ctx context.Context, pool *pgxpool.Pool, assetID uuid.UUID) ([]Track, error) {
	rows, err := pool.Query(ctx,
		`SELECT kind, language, label, is_default FROM tracks
		 WHERE asset_id = $1
		 ORDER BY kind, is_default DESC, language`, assetID)
	if err != nil {
		return nil, err
	}
	defer rows.Close()

	tracks := []Track{} // [] rather than null, as with renditions
	for rows.Next() {
		var t Track
		if err := rows.Scan(&t.Kind, &t.Language, &t.Label, &t.IsDefault); err != nil {
			return nil, err
		}
		tracks = append(tracks, t)
	}
	return tracks, rows.Err()
}

// withMediaCORS lets a player on another origin (the hls.js demo page) fetch
// segments. The browser enforces CORS; the server only declares who is
// allowed. Expose-Headers matters because players issue byte-range requests
// and need to read Content-Range off the response.
func withMediaCORS(next http.Handler) http.Handler {
	return http.HandlerFunc(func(w http.ResponseWriter, r *http.Request) {
		w.Header().Set("Access-Control-Allow-Origin", "*")
		w.Header().Set("Access-Control-Allow-Methods", "GET, HEAD, OPTIONS")
		w.Header().Set("Access-Control-Allow-Headers", "Range")
		w.Header().Set("Access-Control-Expose-Headers", "Content-Length, Content-Range")
		if r.Method == http.MethodOptions {
			w.WriteHeader(http.StatusNoContent)
			return
		}
		next.ServeHTTP(w, r)
	})
}

// withAPICORS lets a browser-based player on another origin read asset
// metadata. Deliberately applied to the read route only: the upload endpoint
// stays same-origin, because a wildcard on a POST that writes files to disk is
// an entirely different risk from one on a JSON GET.
func withAPICORS(next http.Handler) http.Handler {
	return http.HandlerFunc(func(w http.ResponseWriter, r *http.Request) {
		w.Header().Set("Access-Control-Allow-Origin", "*")
		w.Header().Set("Access-Control-Allow-Methods", "GET, HEAD, OPTIONS")
		next.ServeHTTP(w, r)
	})
}

// withMediaHeaders gives locally-served files the same Content-Type and
// Cache-Control they will get from the object store, so development and
// production differ in hostname only.
func withMediaHeaders(next http.Handler) http.Handler {
	return http.HandlerFunc(func(w http.ResponseWriter, r *http.Request) {
		if ct := storage.ContentType(r.URL.Path); ct != "application/octet-stream" {
			w.Header().Set("Content-Type", ct)
		}
		w.Header().Set("Cache-Control", storage.CacheControl(r.URL.Path))
		next.ServeHTTP(w, r)
	})
}

func main() {
	// ctx is cancelled when the process receives Ctrl-C / SIGTERM.
	ctx, stop := signal.NotifyContext(context.Background(),
		os.Interrupt, syscall.SIGTERM)
	defer stop()

	// Loads .env into the process environment. Ignore the error deliberately:
	// in production there is no .env file (real env vars are set by the
	// platform), so "file not found" must not be fatal.
	_ = godotenv.Load()
	// Read after godotenv.Load, never at package level — see the init-order trap.
	mediaBase := cmp.Or(os.Getenv("MEDIA_BASE_URL"), "/media")

	// Get DATABASE_URL which is needed here
	dbURL := os.Getenv("DATABASE_URL")
	if dbURL == "" {
		log.Fatal("DATABASE_URL is not set")
	}

	// Create connection pool
	pool, err := store.NewPool(ctx, dbURL)
	if err != nil {
		log.Fatalf("store: %v", err)
	}
	defer pool.Close()

	// &river.Config{} - Insert-only River client: it can enqueue jobs but runs no workers —
	// that's the worker binary's job. Note it wraps the SAME pool
	riverClient, err := river.NewClient(riverpgxv5.New(pool), &river.Config{})
	if err != nil {
		log.Fatalf("river: %v", err)
	}

	os.MkdirAll("storage/sources", 0o755)

	// routing: build the dispatcher and register handlers
	r := chi.NewRouter()
	r.Post("/assets", makeCreateAsset(pool, riverClient))
	r.Get("/assets/{id}", makeGetAsset(pool, mediaBase))
	r.With(withAPICORS).Get("/assets/{id}", makeGetAsset(pool, mediaBase))
	r.With(withAPICORS).Post("/beacons", makeCreateBeacon(pool))
	// Dev only. In production these bytes come from a CDN, and this route
	// disappears. http.FileServer returns a Handler; StripPrefix wraps one
	// and returns another; withMediaCORS wraps that. Three decorators,
	// same shape as a Reader wrapping a Reader.
	media := http.FileServer(http.Dir("storage"))
	r.Handle("/media/*", withMediaCORS(withMediaHeaders(http.StripPrefix("/media/", media))))

	srv := &http.Server{Addr: ":8080", Handler: r}

	// Serve in a goroutine so main can wait for the shutdown signal.
	go func() {
		log.Println("api listening on :8080")
		if err := srv.ListenAndServe(); err != nil && !errors.Is(err, http.ErrServerClosed) {
			log.Fatalf("serve: %v", err)
		}
	}()

	<-ctx.Done() // block here until Ctrl-C / SIGTERM
	log.Println("shutting down...")

	// Give in-flight requests up to 10s to finish; new requests are refused.
	shutdownCtx, cancel := context.WithTimeout(context.Background(), 10*time.Second)
	defer cancel()
	if err := srv.Shutdown(shutdownCtx); err != nil {
		log.Printf("shutdown: %v", err)
	}
}
