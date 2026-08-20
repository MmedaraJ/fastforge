package main

import (
	"context"
	"log"
	"os"
	"os/signal"
	"syscall"

	"github.com/joho/godotenv"
	"github.com/riverqueue/river"
	"github.com/riverqueue/river/riverdriver/riverpgxv5"

	"github.com/MmedaraJ/fastforge/internal/store"
	"github.com/MmedaraJ/fastforge/internal/worker" // you'll create this package
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
		log.Fatalf("store: %v", err)
	}
	defer pool.Close()

	// --- where the worker diverges from the API ---

	// 1. The registry: maps Kind() strings → worker types.
	//    Your TranscodeArgs.Kind() returns "transcode"; this line is
	//    the other half of that handshake.
	workers := river.NewWorkers()
	river.AddWorker(workers, &worker.TranscodeWorker{Pool: pool})

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
