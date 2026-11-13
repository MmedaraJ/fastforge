package main

import (
	"bytes"
	"context"
	"errors"
	"fmt"
	"log"
	"os"

	"os/exec"
	"os/signal"
	"syscall"

	"github.com/joho/godotenv"
	"github.com/riverqueue/river"
	"github.com/riverqueue/river/riverdriver/riverpgxv5"

	"github.com/MmedaraJ/fastforge/internal/contentkey"
	"github.com/MmedaraJ/fastforge/internal/packager"
	"github.com/MmedaraJ/fastforge/internal/storage"
	"github.com/MmedaraJ/fastforge/internal/store"
	"github.com/MmedaraJ/fastforge/internal/worker"
)

func main() {
	// Ctrl-C / SIGTERM cancels ctx.
	ctx, stop := signal.NotifyContext(context.Background(),
		os.Interrupt, syscall.SIGTERM)
	defer stop()

	_ = godotenv.Load()

	dbURL := os.Getenv("DATABASE_URL")
	if dbURL == "" {
		log.Fatal("DATABASE_URL is not set")
	}

	pool, err := store.NewPool(ctx, dbURL)
	if err != nil {
		log.Fatalf("database: %v", err)
	}
	defer pool.Close()

	if err := checkTooling(ctx); err != nil {
		log.Fatalf("worker cannot start: %v", err)
	}

	// Configuration decides which uploader exists; nothing downstream knows or
	// cares which one it got. Missing credentials is a valid configuration, not
	// an error — it means "serve from the local origin."
	var uploader storage.Uploader = storage.Local{}
	if acct := os.Getenv("R2_ACCOUNT_ID"); acct != "" {
		r2, err := storage.NewR2(ctx, acct,
			os.Getenv("R2_ACCESS_KEY_ID"),
			os.Getenv("R2_SECRET_ACCESS_KEY"),
			os.Getenv("R2_BUCKET"),
		)
		if err != nil {
			log.Fatalf("r2: %v", err)
		}
		uploader = r2
		log.Println("publishing to R2")
	} else {
		log.Println("publishing locally (no R2 configured)")
	}

	// DRM fails closed: a mode that needs a KEK refuses to start without a
	// valid one, rather than quietly packaging content in the clear.
	drmMode := os.Getenv("DRM_MODE")
	var keys *contentkey.Wrapper
	switch drmMode {
	case "":
		log.Println("packaging clear (DRM_MODE is empty)")
	case packager.ModeClearKey:
		keys, err = contentkey.NewWrapper(os.Getenv("CONTENT_KEK"))
		if err != nil {
			log.Fatalf("DRM_MODE=clearkey: %v", err)
		}
		log.Println("encrypting with your own content keys")
	case packager.ModeWidevineTest:
		log.Println("encrypting with Google's Widevine TEST key server: development only")
	default:
		log.Fatalf("DRM_MODE %q is not clearkey, widevine-test or empty", drmMode)
	}

	// --- where the worker diverges from the API ---

	// 1. The registry: maps Kind() strings → worker types.
	//    Your TranscodeArgs.Kind() returns "transcode"; this line is
	//    the other half of that handshake.
	workers := river.NewWorkers()
	river.AddWorker(workers, &worker.TranscodeWorker{
		Pool:     pool,
		Uploader: uploader,
		DRM:      drmMode,
		Keys:     keys,
	})

	// 2. A CONSUMING client. The API's client had no Queues and no
	//    Workers — that's all "insert-only" meant. This one has both,
	//    so it polls river_job and executes.
	client, err := river.NewClient(riverpgxv5.New(pool), &river.Config{
		Queues: map[string]river.QueueConfig{
			// MaxWorkers = your concurrency cap: at most 2 jobs run
			// at once. The channel worker-pool lesson as one line.
			river.QueueDefault: {MaxWorkers: 2},
		},
		Workers: workers,
	})
	if err != nil {
		log.Fatalf("river: %v", err)
	}

	// Start is non-blocking — it spins up River's goroutines and returns.
	if err := client.Start(ctx); err != nil {
		log.Fatalf("river start: %v", err)
	}
	log.Println("worker running")

	<-ctx.Done() // park here until Ctrl-C / SIGTERM
	log.Println("shutting down...")

	// Stop = drain: finish in-flight jobs, accept no new ones.
	// srv.Shutdown, queue edition.
	if err := client.Stop(context.Background()); err != nil {
		log.Printf("stop: %v", err)
	}
}

// checkTooling verifies the external binaries this worker shells out to,
// at startup rather than mid-job.
//
// Every pipeline stage execs something: ffprobe to inspect, ffmpeg to encode
// and score, packager to segment. When one is missing — or present but built
// without a feature we need — the failure surfaces deep inside a job, gets
// classified as bad media, and marks the asset permanently failed. You would
// then go looking at the video, while the real problem is this machine's PATH.
//
// Costs about 50ms once. Buys a startup crash with a sentence that names what
// to install.
func checkTooling(ctx context.Context) error {
	// LookPath answers "does this binary exist", which is all these two need.
	if _, err := exec.LookPath("ffprobe"); err != nil {
		return fmt.Errorf("ffprobe not found on PATH: %w", err)
	}
	if _, err := exec.LookPath("packager"); err != nil {
		return fmt.Errorf("shaka packager not found on PATH — brew install shaka-packager: %w", err)
	}

	// ffmpeg needs more than existence: it has to have been COMPILED with
	// libvmaf. The only way to know is to ask it what filters it has.
	out, err := exec.CommandContext(ctx, "ffmpeg", "-hide_banner", "-filters").Output()
	if err != nil {
		return fmt.Errorf("ffmpeg not usable: %w", err)
	}
	if !bytes.Contains(out, []byte("libvmaf")) {
		return errors.New("this ffmpeg has no libvmaf filter; quality measurement would fail every asset — brew reinstall ffmpeg")
	}
	return nil
}
