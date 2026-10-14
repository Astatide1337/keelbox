package main

import (
	"context"
	"fmt"
	"os"
	"os/signal"
	"syscall"

	"github.com/Astatide1337/keelbox/internal/keelbox"
)

func main() {
	ctx, cancel := signal.NotifyContext(context.Background(), os.Interrupt, syscall.SIGTERM)
	defer cancel()
	if err := keelbox.Run(ctx, os.Args[1:]); err != nil {
		fmt.Fprintln(os.Stderr, "keelbox:", err)
		if ctx.Err() != nil {
			os.Exit(130)
		}
		os.Exit(1)
	}
}
