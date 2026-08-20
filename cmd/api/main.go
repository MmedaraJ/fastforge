package main

import (
	"context"
	"encoding/json"
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

func writeJSONError(w http.ResponseWriter, status int, msg string) {
	w.Header().Set("Content-Type", "application/json")
	w.WriteHeader(status)
	_ = json.NewEncoder(w).Encode(errorResponse{Error: msg})
}

func makeCreateAsset(pool *pgxpool.Pool, rc *river.Client[pgx.Tx]) http.HandlerFunc {
	return func(w http.ResponseWriter, r *http.Request) {
		mr, err := r.MultipartReader()
		if err != nil {
			writeJSONError(w, http.StatusBadRequest, "request must be multipart/form-data")
			return
		}

		var (
			title    string
			gotTitle bool
			assetID  = uuid.New()
			dstPath  string
			written  int64
			gotFile  bool
		)

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

		w.Header().Set("Content-Type", "application/json")
		w.WriteHeader(http.StatusCreated)
		_ = json.NewEncoder(w).Encode(createAssetResponse{
			ID:     assetID.String(),
			Status: "queued",
		})
	}
}

// SHoudl retiurn somegthing
func makeGetAsset(pool *pgxpool.Pool) http.HandlerFunc {
	return func(w http.ResponseWriter, r *http.Request) {

	}
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
	r.Get("/assets/{id}", makeGetAsset(pool))

	srv := &http.Server{Addr: ":8080", Handler: r}

	// Serve in a goroutine so main can wait for the shutdown signal.
	go func() {
		log.Println("api listening on :8080")
		if err := srv.ListenAndServe(); err != nil && err != http.ErrServerClosed {
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
