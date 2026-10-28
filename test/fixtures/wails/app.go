package main

import (
	"context"
	"fmt"
	"strings"
)

// App struct
type App struct {
	ctx context.Context
}

// NewApp creates a new App application struct
func NewApp() *App {
	return &App{}
}

func (a *App) startup(ctx context.Context) {
	a.ctx = ctx
}

// Greet returns a greeting for the given name
func (a *App) Greet(name string) string {
	return greeting(name)
}

func greeting(name string) string {
	return fmt.Sprintf("Hello %s, it's show time!", strings.TrimSpace(name))
}

// Version is bound too, but no component calls it.
func (a *App) Version() string {
	return "1.0.0"
}
